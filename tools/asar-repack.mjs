// asar reader/repacker: verify byte-identity, or repack with replaced file contents.
//
// usage:
//   node asar-repack.mjs probe  <src>
//   node asar-repack.mjs verify <src>
//   node asar-repack.mjs repack <src> <dst> <spec.json>
//
// spec.json:
//   { "replace": [ { "path": "lib/main.js", "file": "patched/main.js", "pad": true } ] }
//   "pad": true keeps the byte length identical by appending trailing whitespace.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [, , mode, src, dst, specPath] = process.argv;

function readArchive(file) {
  const fd = fs.openSync(file, 'r');
  const sizeBuf = Buffer.alloc(8);
  fs.readSync(fd, sizeBuf, 0, 8, 0);
  const headerSize = sizeBuf.readUInt32LE(4);
  const headerBuf = Buffer.alloc(headerSize);
  fs.readSync(fd, headerBuf, 0, headerSize, 8);
  const jsonStart = headerBuf.indexOf(0x7b);
  const headerJson = headerBuf.toString('utf8', jsonStart);
  const base = 8 + headerSize;
  return { fd, sizeBuf, headerSize, headerBuf, jsonStart, headerJson, base, header: JSON.parse(headerJson) };
}

function walk(node, prefix, out) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (v.files) walk(v, full, out);
    else out.push({ path: full, node: v });
  }
  return out;
}

function integrityOf(buf, algorithm = 'SHA256', blockSize = 4194304) {
  const algo = algorithm.toLowerCase().replace('-', '');
  const blocks = [];
  for (let i = 0; i < buf.length; i += blockSize) {
    blocks.push(crypto.createHash(algo).update(buf.subarray(i, Math.min(i + blockSize, buf.length))).digest('hex'));
  }
  return { algorithm, hash: blocks[0], blockSize, blocks };
}

function encodeHeader(json) {
  const jsonBuf = Buffer.from(json, 'utf8');
  const padded = Math.ceil(jsonBuf.length / 4) * 4;
  const payloadSize = 4 + padded;
  const headerBuf = Buffer.alloc(8 + padded);
  headerBuf.writeUInt32LE(payloadSize, 0);
  headerBuf.writeUInt32LE(jsonBuf.length, 4);
  jsonBuf.copy(headerBuf, 8);
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeUInt32LE(4, 0);
  sizeBuf.writeUInt32LE(headerBuf.length, 4);
  return { sizeBuf, headerBuf };
}

const a = readArchive(src);

if (mode === 'probe') {
  console.log('file            ', src);
  console.log('file size       ', fs.statSync(src).size);
  console.log('headerSize(@4)  ', a.headerSize);
  console.log('base            ', a.base);
  console.log('jsonStartInHdr  ', a.jsonStart);
  console.log('jsonBytes       ', Buffer.byteLength(a.headerJson));
  console.log('hdr[0..15]      ', a.headerBuf.subarray(0, 16).toString('hex'));
  console.log('expected hdr len', 8 + Math.ceil(Buffer.byteLength(a.headerJson) / 4) * 4);
  const files = walk(a.header, '', []);
  const unpacked = files.filter((f) => f.node.unpacked === true);
  const empty = files.filter((f) => f.node.unpacked !== true && Number(f.node.size) === 0);
  const stored = files.filter((f) => f.node.unpacked !== true && Number(f.node.size) > 0);
  console.log('files           ', files.length, `(stored ${stored.length}, unpacked ${unpacked.length}, empty ${empty.length})`);
  console.log('sample unpacked ', unpacked.slice(0, 2).map((f) => JSON.stringify({ path: f.path, node: f.node })).join('\n                  '));
  console.log('last stored end ', Math.max(...stored.map((f) => Number(f.node.offset) + Number(f.node.size))));
  fs.closeSync(a.fd);
} else if (mode === 'verify') {
  const files = walk(a.header, '', [])
    .filter((f) => f.node.unpacked !== true && Number(f.node.offset) >= 0 && Number.isFinite(Number(f.node.offset)))
    .sort((x, y) => Number(x.node.offset) - Number(y.node.offset));
  const { sizeBuf, headerBuf } = encodeHeader(a.headerJson);
  const identicalHeader = sizeBuf.equals(a.sizeBuf) && headerBuf.equals(a.headerBuf);
  console.log('re-encoded header identical to original:', identicalHeader);
  if (!identicalHeader) {
    console.log('  original hdr[0..23]:', a.headerBuf.subarray(0, 24).toString('hex'));
    console.log('  re-encoded hdr[0..23]:', headerBuf.subarray(0, 24).toString('hex'));
  }
  const outHash = crypto.createHash('sha256');
  outHash.update(sizeBuf);
  outHash.update(headerBuf);
  let cursor = 0;
  let mismatch = 0;
  const chunk = Buffer.alloc(4 * 1024 * 1024);
  for (const f of files) {
    const off = Number(f.node.offset);
    const size = Number(f.node.size);
    if (off !== cursor) {
      console.log(`  gap/overlap before ${f.path}: expected ${cursor}, header says ${off}`);
      mismatch++;
    }
    let read = 0;
    while (read < size) {
      const n = fs.readSync(a.fd, chunk, 0, Math.min(chunk.length, size - read), a.base + off + read);
      if (n <= 0) throw new Error(`short read in ${f.path}`);
      outHash.update(chunk.subarray(0, n));
      read += n;
    }
    cursor = off + size;
  }
  const total = fs.statSync(src).size;
  console.log('data bytes        ', cursor, 'file size - base =', total - a.base, cursor === total - a.base ? '(consistent)' : '(MISMATCH)');
  console.log('layout mismatches ', mismatch);
  const rebuilt = outHash.digest('hex');
  const original = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
  console.log('rebuilt sha256    ', rebuilt);
  console.log('original sha256   ', original);
  console.log(rebuilt === original ? 'RESULT: byte-identical rebuild ✓' : 'RESULT: rebuild differs ✗');
  fs.closeSync(a.fd);
} else if (mode === 'repack') {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const replacements = new Map();
  for (const entry of spec.replace) {
    const buf = fs.readFileSync(entry.file);
    replacements.set(entry.path, { buf, pad: entry.pad === true });
  }
  const files = walk(a.header, '', [])
    .filter((f) => f.node.unpacked !== true)
    .sort((x, y) => Number(x.node.offset ?? 0) - Number(y.node.offset ?? 0));
  const fdOut = fs.openSync(dst, 'w');
  const { sizeBuf } = encodeHeader(a.headerJson); // header length is stable under padding
  fs.writeSync(fdOut, sizeBuf);
  fs.writeSync(fdOut, encodeHeader(a.headerJson).headerBuf);
  let cursor = 0;
  const chunk = Buffer.alloc(4 * 1024 * 1024);
  const report = [];
  for (const f of files) {
    const off = Number(f.node.offset);
    const size = Number(f.node.size);
    const rep = replacements.get(f.path);
    if (rep) {
      let buf = rep.buf;
      if (buf.length > size) throw new Error(`${f.path}: replacement is ${buf.length} bytes, larger than the original ${size}`);
      if (rep.pad && buf.length < size) {
        const padLen = size - buf.length;
        buf = Buffer.concat([buf, Buffer.from('\n' + ' '.repeat(padLen - 1), 'utf8')]);
      }
      if (buf.length !== size) throw new Error(`${f.path}: replacement length ${buf.length} != original ${size} (set "pad": true)`);
      fs.writeSync(fdOut, buf);
      f.node.integrity = integrityOf(buf, f.node.integrity?.algorithm ?? 'SHA256', f.node.integrity?.blockSize ?? 4194304);
      report.push({ path: f.path, size: buf.length, newHash: f.node.integrity.hash, blocks: f.node.integrity.blocks.length });
    } else {
      let read = 0;
      while (read < size) {
        const n = fs.readSync(a.fd, chunk, 0, Math.min(chunk.length, size - read), a.base + off + read);
        if (n <= 0) throw new Error(`short read in ${f.path}`);
        fs.writeSync(fdOut, chunk.subarray(0, n));
        read += n;
      }
    }
    cursor += size;
  }
  fs.closeSync(fdOut);
  // Data is written in the original order with the original sizes, so offsets are unchanged.
  const { headerBuf } = encodeHeader(JSON.stringify(a.header));
  const fd2 = fs.openSync(dst, 'r+');
  if (headerBuf.length !== a.headerSize) throw new Error(`header length changed: ${headerBuf.length} != ${a.headerSize}`);
  fs.writeSync(fd2, headerBuf, 0, headerBuf.length, 8);
  fs.closeSync(fd2);
  console.log(`repacked ${src} -> ${dst}`);
  console.log(`header length unchanged: ${a.headerSize}`);
  for (const r of report) console.log(`  replaced ${r.path}: ${r.size} bytes, sha256=${r.newHash}, blocks=${r.blocks}`);
  fs.closeSync(a.fd);
} else {
  console.error('unknown mode');
  process.exit(2);
}
