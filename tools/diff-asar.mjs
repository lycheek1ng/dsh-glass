// Prove that a repacked asar differs from the original ONLY inside the intended regions:
// the byte range of each replaced file plus that file's integrity hash strings in the header.
//
//   node diff-asar.mjs <original> <repacked>
import fs from 'node:fs';
import crypto from 'node:crypto';

const [, , origPath, newPath] = process.argv;
const orig = fs.readFileSync(origPath);
const next = fs.readFileSync(newPath);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

console.log(`original: ${orig.length} bytes  sha256=${sha(orig)}`);
console.log(`repacked: ${next.length} bytes  sha256=${sha(next)}`);
if (orig.length !== next.length) throw new Error('length changed: the layout is not preserved');

function parseHeader(buf) {
  const headerSize = buf.readUInt32LE(4);
  const headerBuf = buf.subarray(8, 8 + headerSize);
  const jsonStart = 8 + headerBuf.indexOf(0x7b);
  const jsonBuf = buf.subarray(jsonStart, 8 + headerSize);
  return { headerSize, base: 8 + headerSize, json: jsonBuf.toString('utf8'), jsonBuf, jsonStart, header: JSON.parse(jsonBuf.toString('utf8')) };
}
const a = parseHeader(orig);
const b = parseHeader(next);
if (a.base !== b.base) throw new Error('data base moved');

function walk(node, prefix, out) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (v.files) walk(v, full, out);
    else out.push({ path: full, node: v });
  }
  return out;
}
const fa = new Map(walk(a.header, '', []).map((f) => [f.path, f.node]));
const fb = new Map(walk(b.header, '', []).map((f) => [f.path, f.node]));

let changedEntries = [];
for (const [p, na] of fa) {
  if (JSON.stringify(na) !== JSON.stringify(fb.get(p))) changedEntries.push(p);
}

// --- expected differing regions -------------------------------------------------
const regions = [];
let layoutProblems = 0;
let contentProblems = 0;
for (const p of changedEntries) {
  const na = fa.get(p);
  const nb = fb.get(p);
  if (na.offset !== nb.offset || na.size !== nb.size || na.integrity?.blocks?.length !== nb.integrity?.blocks?.length) {
    console.log(`  LAYOUT PROBLEM: ${p} offset ${na.offset}->${nb.offset} size ${na.size}->${nb.size}`);
    layoutProblems++;
    continue;
  }
  const start = a.base + Number(na.offset);
  regions.push({ what: `${p} content`, start, end: start + Number(na.size) });
  for (const oldHash of new Set([na.integrity.hash, ...na.integrity.blocks])) {
    // The same hex string appears in both "hash" and "blocks"; every byte occurrence must be covered.
    const needle = Buffer.from(oldHash, 'utf8');
    let from = 0;
    let found = 0;
    for (;;) {
      const at = a.jsonBuf.indexOf(needle, from);
      if (at < 0) break;
      regions.push({ what: `${p} integrity hash`, start: a.jsonStart + at, end: a.jsonStart + at + needle.length });
      from = at + needle.length;
      found++;
    }
    if (found === 0) { console.log(`  hash string not found for ${p}`); layoutProblems++; }
  }
}

const inside = (i) => regions.find((r) => i >= r.start && i < r.end);
const outside = new Map();
let differing = 0;
for (let i = 0; i < orig.length; i++) {
  if (orig[i] === next[i]) continue;
  differing++;
  const r = inside(i);
  if (!r) outside.set(i, true);
}
console.log(`differing bytes: ${differing} (inside ${regions.length} expected regions)`);
if (outside.size > 0) {
  const list = [...outside.keys()];
  console.log(`  UNEXPECTED differing bytes: ${list.length}, first at ${list[0]}, last at ${list[list.length - 1]}`);
  contentProblems++;
}

// --- every untouched stored file must still be byte-identical -------------------
let checked = 0;
for (const [p, na] of fa) {
  if (na.unpacked === true || changedEntries.includes(p)) continue;
  const nb = fb.get(p);
  const off = Number(na.offset);
  const size = Number(na.size);
  if (off !== Number(nb.offset) || size !== Number(nb.size)) { console.log(`  LAYOUT MOVED: ${p}`); layoutProblems++; continue; }
  if (!orig.subarray(a.base + off, a.base + off + size).equals(next.subarray(b.base + off, b.base + off + size))) {
    console.log(`  CONTENT CHANGED UNEXPECTEDLY: ${p}`);
    contentProblems++;
  }
  checked++;
}

// --- integrity metadata must describe the stored bytes -------------------------
for (const p of changedEntries) {
  const nb = fb.get(p);
  const off = Number(nb.offset);
  const bytes = next.subarray(b.base + off, b.base + off + Number(nb.size));
  const blockSize = nb.integrity.blockSize;
  const blocks = [];
  for (let i = 0; i < bytes.length; i += blockSize) blocks.push(sha(bytes.subarray(i, Math.min(i + blockSize, bytes.length))));
  const ok = blocks[0] === nb.integrity.hash && JSON.stringify(blocks) === JSON.stringify(nb.integrity.blocks);
  console.log(`  integrity ${p}: ${ok ? 'describes the stored bytes ✓' : 'MISMATCH ✗'}`);
  if (!ok) contentProblems++;
}

console.log(`changed header entries: ${changedEntries.length} (${changedEntries.join(', ')})`);
console.log(`untouched files verified byte-identical: ${checked}`);
const pass = layoutProblems === 0 && contentProblems === 0 && outside.size === 0;
console.log(pass ? 'RESULT: surgical patch ✓' : `RESULT: problems found (layout ${layoutProblems}, content ${contentProblems}) ✗`);
process.exitCode = pass ? 0 : 1;
