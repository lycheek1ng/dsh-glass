// Minimal asar reader: list / cat / header, no dependencies.
import fs from 'node:fs';

const [, , mode, asarPath, arg, outPath] = process.argv;

const fd = fs.openSync(asarPath, 'r');
const sizeBuf = Buffer.alloc(8);
fs.readSync(fd, sizeBuf, 0, 8, 0);
const headerSize = sizeBuf.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 8);
const jsonStart = headerBuf.indexOf(0x7b); // first '{'
const headerJson = headerBuf.toString('utf8', jsonStart);
const base = 8 + headerSize;

if (mode === 'header') {
  fs.writeFileSync(outPath, headerJson);
  console.log(`wrote ${outPath} (${headerJson.length} chars)`);
} else {
  const root = JSON.parse(headerJson);
  if (mode === 'find') {
    const re = new RegExp(arg, 'i');
    const walk = (n, p) => {
      for (const [name, v] of Object.entries(n.files || {})) {
        const full = p ? `${p}/${name}` : name;
        if (v.files) walk(v, full);
        else if (re.test(full)) console.log(`${full}\t${v.size}`);
      }
    };
    walk(root, '');
    fs.closeSync(fd);
    process.exit(0);
  }
  const segs = (arg || '').split('/').filter(Boolean);
  let node = root;
  for (const s of segs) {
    node = node.files?.[s];
    if (!node) throw new Error(`not found: ${arg}`);
  }
  if (mode === 'list') {
    const rows = Object.entries(node.files || {}).map(([name, v]) => ({
      kind: v.files ? 'dir' : 'file',
      name,
      size: v.size ?? '',
      offset: v.offset ?? '',
    }));
    rows.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));
    for (const r of rows) console.log(`${r.kind}\t${r.name}\t${r.size}`);
  } else if (mode === 'cat') {
    if (node.files) throw new Error(`is a directory: ${arg}`);
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
    if (outPath) {
      fs.writeFileSync(outPath, buf);
      console.log(`wrote ${outPath} (${node.size} bytes)`);
    } else {
      process.stdout.write(buf);
    }
  } else if (mode === 'find') {
    // find <regex against archive paths>
    const re = new RegExp(arg, 'i');
    const walk = (n, p) => {
      for (const [name, v] of Object.entries(n.files || {})) {
        const full = p ? `${p}/${name}` : name;
        if (v.files) walk(v, full);
        else if (re.test(full)) console.log(`${full}\t${v.size}`);
      }
    };
    walk(root, '');
  }
}
fs.closeSync(fd);
