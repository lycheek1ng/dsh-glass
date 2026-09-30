#Requires -Version 5.1
<#
.SYNOPSIS
  Apply or roll back the DeepSeek Harness Windows Acrylic shell patch.

.DESCRIPTION
  `tools/patch-shell.mjs` builds the patch and stages it as `resources/app.asar.glass`;
  this script swaps it in (or restores the pristine archive).

  The swap prefers a whole-file copy, which needs the application closed. When the
  archive is locked by a running app it falls back to an in-place byte write: only the
  ranges that actually differ (about 400 KB in two runs) are rewritten, and the shell
  reads those files once at startup, so the running instance is unaffected and the patch
  takes effect on the next launch.

.PARAMETER Action
  status   - report what is currently installed (default target hashes come from the build).
  apply    - stage the patched archive onto the installation (makes a backup first).
  rollback - restore the pristine archive and remove the plugin row from the profile.

.PARAMETER Install
  Folder containing "DeepSeek Harness.exe". Auto-detected when omitted.

.PARAMETER Node
  Node-compatible executable used for the in-place writer. Auto-detected when omitted
  (the harness runtime ships one; the application executable also runs in Node mode).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\apply-glass.ps1 -Action apply
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('status', 'apply', 'rollback')][string]$Action,
  [string]$Install,
  [string]$Node,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$Tools = $PSScriptRoot
$Record = Join-Path $Tools '.cache\patch-record.json'
$InPlace = Join-Path $Tools 'apply-inplace.mjs'

function Get-Hash([string]$Path) { (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Resolve-Install {
  param([string]$Explicit)
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($Explicit) { $candidates.Add($Explicit) }
  if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness')) }
  if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'DeepSeek Harness')) }
  if (${env:ProgramFiles(x86)}) { $candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness')) }
  foreach ($candidate in $candidates) {
    if (Test-Path (Join-Path $candidate 'resources\app.asar')) { return (Resolve-Path $candidate).Path }
  }
  throw "DeepSeek Harness not found. Pass -Install `"<folder containing DeepSeek Harness.exe>`". Tried:`n  $($candidates -join "`n  ")"
}

function Resolve-Node {
  param([string]$Explicit, [string]$InstallRoot)
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($Explicit) { $candidates.Add($Explicit) }
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  $candidates.Add((Join-Path $dshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'))
  $candidates.Add((Join-Path $InstallRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'))
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { $candidates.Add($onPath.Source) }
  foreach ($candidate in $candidates) { if ($candidate -and (Test-Path $candidate)) { return $candidate } }
  return $null
}

$InstallRoot = Resolve-Install -Explicit $Install
$Resources = Join-Path $InstallRoot 'resources'
$Target = Join-Path $Resources 'app.asar'
$Staged = Join-Path $Resources 'app.asar.glass'
$Backup = Join-Path $Resources 'app.asar.original'
$NodeExe = Resolve-Node -Explicit $Node -InstallRoot $InstallRoot
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfilePatch = Join-Path $DshHome 'profiles\desktop\cordis.patch.yml'
$Marker = '# dsh-plugin-glass'

# Expected hashes come from the build record; fall back to the values of the reference build.
$ExpectedHash = 'c940a4df795f0623748aa6c40fc97a47149ddabf9739f27daa5a09cede2a4b62'
$OriginalHash = $null
if (Test-Path $Record) {
  $json = [System.IO.File]::ReadAllText($Record, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($json.expectedHash) { $ExpectedHash = $json.expectedHash }
  if ($json.originalHash) { $OriginalHash = $json.originalHash }
}

function Test-Writable([string]$Path) {
  try { $fs = [System.IO.File]::Open($Path, 'Open', 'Write', 'None'); $fs.Close(); return $true } catch { return $false }
}

function Show-Status {
  Write-Host "installation : $InstallRoot"
  $targetHash = if (Test-Path $Target) { Get-Hash $Target } else { '' }
  $tag = if ($targetHash -eq $ExpectedHash) { 'patched (active after the next launch)' }
         elseif ($OriginalHash -and $targetHash -eq $OriginalHash) { 'pristine' }
         else { 'unknown (rebuild the patch if the app updated)' }
  Write-Host ("  app.asar           {0}  {1}" -f $targetHash.Substring(0, [Math]::Min(12, $targetHash.Length)), $tag)
  foreach ($item in @(
      @{ Name = 'app.asar.original'; Path = $Backup },
      @{ Name = 'app.asar.glass   '; Path = $Staged })) {
    $state = if (Test-Path $item.Path) { (Get-Hash $item.Path).Substring(0, 12) } else { 'absent' }
    Write-Host ("  {0}    {1}" -f $item.Name, $state)
  }
  $row = (Test-Path $ProfilePatch) -and ([System.IO.File]::ReadAllText($ProfilePatch) -match [regex]::Escape($Marker))
  Write-Host ("  profile plugin row {0}" -f $(if ($row) { 'installed' } else { 'absent' }))
  Write-Host ("  archive writable   {0}" -f $(if (Test-Path $Target) { if (Test-Writable $Target) { 'yes (app closed)' } else { 'no (app running: in-place write will be used)' } } else { 'n/a' }))
  Write-Host ("  node for writing   {0}" -f $(if ($NodeExe) { $NodeExe } else { 'not found' }))
}

function Invoke-ArchiveWrite {
  param([string]$Source, [string]$ExpectedResult, [string]$Label)
  if (Test-Writable $Target) {
    Copy-Item $Source $Target -Force
    if ((Get-Hash $Target) -ne $ExpectedResult) { throw "$Label failed: hash mismatch after copy" }
    return 'whole-file copy'
  }
  if (-not $NodeExe) { throw 'The archive is locked and no node executable was found for the in-place writer. Close DeepSeek Harness and retry.' }
  Write-Host '  archive is locked by the running app; writing only the differing ranges'
  & $NodeExe $InPlace $Source $Target --write | ForEach-Object { Write-Host "    $_" }
  if ((Get-Hash $Target) -ne $ExpectedResult) { throw "$Label failed: hash mismatch after in-place write" }
  return 'in-place byte write'
}

switch ($Action) {
  'status' { Show-Status; exit 0 }

  'apply' {
    if ((Get-Hash $Target) -eq $ExpectedHash) {
      Write-Host 'Nothing to do: app.asar already carries the patch (active after the next launch).'
      Show-Status
      exit 0
    }
    if ($OriginalHash -and (Get-Hash $Target) -ne $OriginalHash) {
      throw 'The installed archive matches neither the pristine build nor this patch. The app was probably updated: run tools/patch-shell.mjs again first.'
    }
    if (-not (Test-Path $Staged)) {
      throw "Missing $Staged - run tools/patch-shell.mjs first."
    }
    if ((Get-Hash $Staged) -ne $ExpectedHash) { throw 'The staged archive does not match the build record; rebuild it with tools/patch-shell.mjs.' }
    if (-not (Test-Path $Backup)) {
      Copy-Item $Target $Backup -Force
      Write-Host "backup created: $Backup ($((Get-Hash $Backup).Substring(0, 12)))"
    }
    $how = Invoke-ArchiveWrite -Source $Staged -ExpectedResult $ExpectedHash -Label 'apply'
    Write-Host "patched ($how). Restart DeepSeek Harness to see the acrylic window."
    Show-Status
  }

  'rollback' {
    if (-not (Test-Path $Backup)) {
      Write-Host 'No app.asar.original backup found; reinstall DeepSeek Harness to restore the pristine archive.' -ForegroundColor Yellow
    } elseif ((Get-Hash $Target) -eq (Get-Hash $Backup)) {
      Write-Host 'Nothing to do: app.asar is already pristine.'
    } else {
      $how = Invoke-ArchiveWrite -Source $Backup -ExpectedResult (Get-Hash $Backup) -Label 'rollback'
      Write-Host "restored the pristine archive ($how)."
    }
    if (Test-Path $ProfilePatch) {
      $lines = [System.IO.File]::ReadAllLines($ProfilePatch)
      $kept = New-Object System.Collections.Generic.List[string]
      $skip = $false
      foreach ($line in $lines) {
        if (-not $skip -and $line.TrimStart().StartsWith($Marker)) { $skip = $true; continue }
        if ($skip) {
          if ($line -match '^\s' -or $line -match '^-\s*insert:\s*$') { continue }
          $skip = $false
        }
        $kept.Add($line)
      }
      [System.IO.File]::WriteAllLines($ProfilePatch, $kept, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host 'removed the plugin row from the profile patch.'
    }
    Show-Status
  }
}

if ($Action -eq 'apply' -and -not $NoLaunch) {
  $running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    Write-Host 'DeepSeek Harness is running: the patch is on disk and becomes active on the next launch.'
  } else {
    $answer = Read-Host 'Start DeepSeek Harness now? (Y/n)'
    if ($answer -notmatch '^[Nn]') { Start-Process (Join-Path $InstallRoot 'DeepSeek Harness.exe') }
  }
}
