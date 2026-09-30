#Requires -Version 5.1
<#
.SYNOPSIS
  Install, update or remove the glass plugin for DeepSeek Harness.

.DESCRIPTION
  Copies `plugin/` into the harness home and registers it in the desktop profile patch,
  so the settings row and the injected stylesheet load on the next launch (or immediately,
  because client plugin bundles hot-reload).

  Both steps are idempotent and both back up what they touch:
    * the profile patch is copied to `cordis.patch.yml.glass-backup` before the first edit;
    * re-running `-Action install` refreshes the plugin files in place.

.PARAMETER Action
  status  - report whether the plugin directory and the profile row are present.
  install - copy/refresh the plugin and ensure the profile row exists.
  remove  - delete the profile row and the plugin directory.

.PARAMETER DshHome
  Harness home. Defaults to $env:DSH_HOME, else "$env:USERPROFILE\.dsh".

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\install-plugin.ps1 -Action install
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('status', 'install', 'remove')][string]$Action,
  [string]$DshHome
)

$ErrorActionPreference = 'Stop'
$Source = Join-Path (Split-Path -Parent $PSScriptRoot) 'plugin'
$Marker = '# dsh-plugin-glass'
$PluginId = 'glass-plugin'
$PluginDirName = 'dsh-plugin-glass'

if (-not $DshHome) {
  $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
}
$DshHome = (Resolve-Path -LiteralPath (New-Item -ItemType Directory -Force -Path $DshHome)).Path
$PluginDir = Join-Path $DshHome "plugins\$PluginDirName"
$ProfileDir = Join-Path $DshHome 'profiles\desktop'
$ProfilePatch = Join-Path $ProfileDir 'cordis.patch.yml'
$EntryPoint = Join-Path $PluginDir 'lib\index.js'

function Get-PatchState {
  if (-not (Test-Path $ProfilePatch)) { return 'missing' }
  $text = [System.IO.File]::ReadAllText($ProfilePatch)
  if ($text -match [regex]::Escape($Marker)) { return 'installed' }
  return 'absent'
}

function Show-Status {
  Write-Host "harness home : $DshHome"
  Write-Host ("  plugin files      {0}" -f $(if (Test-Path (Join-Path $PluginDir 'package.json')) { "installed ($PluginDir)" } else { 'absent' }))
  Write-Host ("  profile patch     {0}" -f $(if (Test-Path $ProfilePatch) { Get-PatchState } else { "missing ($ProfilePatch)" }))
  if (Test-Path $EntryPoint) { Write-Host ("  entry point       {0}" -f $EntryPoint) }
}

function Remove-PatchRow {
  if (-not (Test-Path $ProfilePatch)) { return }
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
}

function Add-PatchRow {
  # The insert row names the plugin entry with a forward-slash absolute path; the loader
  # converts absolute paths inside `insert` rows to file URLs.
  $name = ($EntryPoint -replace '\\', '/')
  $row = @(
    '',
    "$Marker - frosted glass appearance for the desktop shell. Remove this block to uninstall.",
    '- insert:',
    "    - id: $PluginId",
    "      name: '$name'",
    '      config:',
    '        enabled: true',
    '        material: acrylic',
    '        scope: sidebar',
    '        sidebarAlpha: 65',
    '        contentAlpha: 35',
    '        opaqueContent: 100',
    '        blurPx: 18'
  ) -join "`r`n"
  [System.IO.File]::AppendAllText($ProfilePatch, "$row`r`n", (New-Object System.Text.UTF8Encoding($false)))
}

switch ($Action) {
  'status' { Show-Status; exit 0 }

  'install' {
    if (-not (Test-Path $Source)) { throw "Plugin sources not found at $Source" }
    if (-not (Test-Path $ProfileDir)) { throw "Desktop profile not found at $ProfileDir. Start DeepSeek Harness once, then retry." }
    if (-not (Test-Path "$ProfilePatch.glass-backup")) { Copy-Item $ProfilePatch "$ProfilePatch.glass-backup" -Force }
    New-Item -ItemType Directory -Force -Path (Join-Path $DshHome 'plugins') | Out-Null
    if (Test-Path $PluginDir) { Remove-Item $PluginDir -Recurse -Force }
    Copy-Item $Source $PluginDir -Recurse -Force
    Write-Host "plugin installed: $PluginDir"
    if ((Get-PatchState) -eq 'installed') {
      Write-Host 'profile row already present; left untouched.'
    } else {
      Add-PatchRow
      Write-Host 'profile row added (backup: cordis.patch.yml.glass-backup).'
    }
    Show-Status
    Write-Host ''
    Write-Host 'Next: tools\apply-glass.ps1 -Action apply   (if you have not patched the shell yet)'
  }

  'remove' {
    Remove-PatchRow
    Write-Host 'profile row removed.'
    if (Test-Path $PluginDir) {
      Remove-Item $PluginDir -Recurse -Force
      Write-Host "plugin directory removed: $PluginDir"
    }
    Show-Status
  }
}
