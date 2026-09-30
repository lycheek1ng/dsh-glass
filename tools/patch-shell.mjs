// Build the Windows Acrylic shell patch for an installed DeepSeek Harness.
//
//   node tools/patch-shell.mjs [--install "<path>"] [--dry-run]
//
// What it does, in order:
//   1. locate the installation (or use --install) and read resources/app.asar;
//   2. extract the two shell files it needs to change (lib/main.js, lib/preload-app.cjs);
//   3. apply the documented edits, asserting every anchor matches exactly once;
//   4. repack the archive keeping its byte layout, so all other 11k+ entries stay identical;
//   5. verify the result differs from the original only inside the intended regions;
//   6. stage it as resources/app.asar.glass and record the SHA256 pair.
//
// Nothing is modified in place here: `tools/apply-glass.ps1 -Action apply` performs the swap
// (or an in-place byte write when the app is running and the file is locked).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const dryRun = argv.includes('--dry-run') || argv.includes('--archive');
const cache = path.join(here, '.cache', 'shell-patch');
const node = process.execPath;

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (label, args) => {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(node, args, { stdio: 'inherit', cwd: here });
  if (result.status !== 0) throw new Error(`${label} failed (exit ${String(result.status)})`);
};

/** Find the installation by looking for resources/app.asar in the usual places. */
function findInstall(explicit) {
  const candidates = [];
  if (explicit !== undefined) candidates.push(explicit);
  const local = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  if (local !== undefined) candidates.push(path.join(local, 'Programs', 'DeepSeek Harness'));
  if (pf !== undefined) candidates.push(path.join(pf, 'DeepSeek Harness'));
  if (pf86 !== undefined) candidates.push(path.join(pf86, 'DeepSeek Harness'));
  candidates.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness'));
  for (const candidate of candidates) {
    const resources = path.join(candidate, 'resources');
    if (fs.existsSync(path.join(resources, 'app.asar'))) return { install: candidate, resources };
  }
  throw new Error(`could not find DeepSeek Harness. Pass --install "<folder containing DeepSeek Harness.exe>".\nTried:\n  ${candidates.join('\n  ')}`);
}

/**
 * Resolve the archive to patch. `--archive` targets any app.asar directly (handy for testing
 * against a backup); otherwise the installation is located, or `--install` names it.
 */
function locate() {
  const explicitArchive = option('--archive', undefined);
  if (explicitArchive !== undefined) {
    const archive = path.resolve(explicitArchive);
    if (!fs.existsSync(archive)) throw new Error(`no such archive: ${archive}`);
    return { install: path.dirname(path.dirname(archive)), resources: path.dirname(archive), asar: archive };
  }
  const found = findInstall(option('--install', undefined));
  return { ...found, asar: path.join(found.resources, 'app.asar') };
}

const { install, resources, asar } = locate();
const staged = path.join(resources, 'app.asar.glass');
console.log(`installation : ${install}`);
console.log(`archive      : ${asar}`);
console.log(`archive sha  : ${sha256(asar)}`);

fs.rmSync(cache, { recursive: true, force: true });
fs.mkdirSync(cache, { recursive: true });

// 1. pristine shell sources, straight out of the installed archive.
run('extract lib/main.js', [path.join(here, 'asar.mjs'), 'cat', asar, 'lib/main.js', path.join(cache, 'main.js')]);
run('extract lib/preload-app.cjs', [path.join(here, 'asar.mjs'), 'cat', asar, 'lib/preload-app.cjs', path.join(cache, 'preload-app.cjs')]);

// 2. patched sources (aborts loudly if the app changed its window setup).
run('apply shell edits', [path.join(here, 'make-patch.mjs'), '--in', cache, '--out', path.join(cache, 'patched')]);

// 3. repack with a generated spec: padding keeps every other offset intact.
const spec = path.join(cache, 'spec.json');
fs.writeFileSync(spec, `${JSON.stringify({
  replace: [
    { path: 'lib/main.js', file: path.join(cache, 'patched', 'lib', 'main.js'), pad: true },
    { path: 'lib/preload-app.cjs', file: path.join(cache, 'patched', 'lib', 'preload-app.cjs'), pad: true },
  ],
}, null, 2)}\n`);
const built = path.join(cache, 'app.asar.glass');
run('repack archive', [path.join(here, 'asar-repack.mjs'), 'repack', asar, built, spec]);

// 4. prove the change is surgical.
run('verify surgical patch', [path.join(here, 'diff-asar.mjs'), asar, built]);

// 5. stage next to the installation so the apply script can validate it.
const record = {
  builtAt: new Date().toISOString(),
  install,
  archive: asar,
  originalHash: sha256(asar),
  expectedHash: sha256(built),
};
if (dryRun) {
  console.log(`\nnothing was written next to the installation; the patched archive is at\n  ${built}`);
} else {
  fs.copyFileSync(built, staged);
  console.log(`\nstaged : ${staged}`);
}
fs.writeFileSync(path.join(here, '.cache', 'patch-record.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log(`patched: ${record.expectedHash}`);
console.log('\nnext   : tools/apply-glass.ps1 -Action apply      (and -Action rollback to undo)');
