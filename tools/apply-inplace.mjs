// Apply the staged glass archive onto the installed app.asar IN PLACE.
//
//   node apply-inplace.mjs <patchedAsar> <targetAsar> [--write]
//
// Why: File.Replace needs DELETE access on the target, which the running shell
// denies. A plain write handle is often still allowed, and every byte outside the
// two patched files is identical, so only small ranges change. The shell loads
// lib/main.js and lib/preload-app.cjs once at startup, so an in-place update is
// picked up by the next launch without a file swap.
//
// Without --write the script only reports whether the target is writable.
import crypto from 'node:crypto';
import fs from 'node:fs';

const [, , patchedPath, targetPath, ...flags] = process.argv;
const doWrite = flags.includes('--write');
const CHUNK = 4 * 1024 * 1024;
// Ranges closer than this are coalesced into one write to keep the torn-read window tiny.
const MERGE_GAP = 256 * 1024;

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const targetSize = fs.statSync(targetPath).size;
const patchedSize = fs.statSync(patchedPath).size;
console.log(`target : ${targetPath} (${targetSize} bytes, sha256 ${sha256(targetPath)})`);
console.log(`patched: ${patchedPath} (${patchedSize} bytes, sha256 ${sha256(patchedPath)})`);
if (targetSize !== patchedSize) throw new Error('sizes differ; an in-place update is impossible');

// Collect the byte ranges that differ, streaming so the whole archive never sits in memory twice.
const ranges = [];
let open = null;
const targetFd = fs.openSync(targetPath, 'r');
const patchedFd = fs.openSync(patchedPath, 'r');
const a = Buffer.alloc(CHUNK);
const b = Buffer.alloc(CHUNK);
let changed = 0;
for (let pos = 0; pos < targetSize; pos += CHUNK) {
  const len = Math.min(CHUNK, targetSize - pos);
  fs.readSync(targetFd, a, 0, len, pos);
  fs.readSync(patchedFd, b, 0, len, pos);
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) {
      if (open !== null) { ranges.push([open, pos + i - open]); open = null; }
      continue;
    }
    changed++;
    if (open === null) open = pos + i;
  }
}
if (open !== null) ranges.push([open, targetSize - open]);
fs.closeSync(targetFd);
fs.closeSync(patchedFd);

// Coalesce neighbouring ranges.
const merged = [];
for (const [start, length] of ranges) {
  const last = merged[merged.length - 1];
  if (last !== undefined && start - (last[0] + last[1]) <= MERGE_GAP) last[1] = start + length - last[0];
  else merged.push([start, length]);
}
console.log(`differing bytes: ${changed} in ${ranges.length} ranges -> ${merged.length} write ranges (${merged.reduce((sum, r) => sum + r[1], 0)} bytes)`);

// Verify the in-memory picture matches the staged archive exactly.
const patchedBuf = fs.readFileSync(patchedPath);
{
  const targetBuf = fs.readFileSync(targetPath);
  const check = Buffer.from(targetBuf);
  for (const [start, length] of merged) patchedBuf.copy(check, start, start, start + length);
  if (crypto.createHash('sha256').update(check).digest('hex') !== crypto.createHash('sha256').update(patchedBuf).digest('hex')) {
    throw new Error('range computation is wrong: the patched copy does not reproduce the staged archive');
  }
  console.log('range computation verified: writing these ranges reproduces the staged archive exactly');
}

if (!doWrite) {
  try {
    const fd = fs.openSync(targetPath, 'r+');
    fs.closeSync(fd);
    console.log('RESULT: the installed archive is WRITABLE in place (run again with --write to apply)');
  } catch (error) {
    console.log(`RESULT: not writable in place (${error.code ?? ''} ${error.message})`);
    process.exitCode = 3;
  }
} else {
  const fd = fs.openSync(targetPath, 'r+');
  try {
    for (const [start, length] of merged) {
      let written = 0;
      while (written < length) {
        written += fs.writeSync(fd, patchedBuf, start + written, length - written, start + written);
      }
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const after = sha256(targetPath);
  const expected = sha256(patchedPath);
  console.log(`after write: sha256 ${after}`);
  console.log(after === expected ? 'RESULT: the installed archive now matches the staged patch ✓' : 'RESULT: MISMATCH ✗');
  process.exitCode = after === expected ? 0 : 1;
}
