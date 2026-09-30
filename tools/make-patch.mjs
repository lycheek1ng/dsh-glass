// Generate patched Electron shell sources from pristine copies.
//
//   node make-patch.mjs [--in <dir>] [--out <dir>] [--shadow-port]
//
// `--in` defaults to this script's directory and must contain `main.js` and
// `preload-app.cjs`; `--out` defaults to `<in>/patched`.
//
// Invariants enforced here:
//   * every anchor occurs exactly once (a missing or duplicated anchor aborts);
//   * the result is never LONGER than the original file, so the asar repacker can
//     keep every other file offset untouched and pad the tail with whitespace.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const here = path.resolve(option('--in', path.dirname(fileURLToPath(import.meta.url))));
const out = path.resolve(option('--out', path.join(here, 'patched')));
fs.mkdirSync(path.join(out, 'lib'), { recursive: true });

function replaceOnce(text, anchor, replacement, label) {
  const first = text.indexOf(anchor);
  if (first < 0) throw new Error(`[${label}] anchor not found`);
  if (text.indexOf(anchor, first + 1) >= 0) throw new Error(`[${label}] anchor is not unique`);
  return { text: text.slice(0, first) + replacement + text.slice(first + anchor.length), delta: replacement.length - anchor.length };
}

/** Delete a whole JSDoc block located by its unique opening lines. */
function dropComment(text, openingLines, label) {
  const start = text.indexOf(openingLines);
  if (start < 0) throw new Error(`[${label}] comment anchor not found`);
  if (text.indexOf(openingLines, start + 1) >= 0) throw new Error(`[${label}] comment anchor is not unique`);
  if (text.slice(start, start + 3) !== '/**') throw new Error(`[${label}] anchor does not start a block comment`);
  const close = text.indexOf('*/', start);
  if (close < 0) throw new Error(`[${label}] unterminated block comment`);
  let end = close + 2;
  if (text[end] === '\n') end += 1;
  const removed = end - start;
  return { text: text.slice(0, start) + text.slice(end), delta: -removed };
}

const edits = [];

// ---------------------------------------------------------------- lib/main.js
let main = fs.readFileSync(path.join(here, 'main.js'), 'utf8');
const mainBytes = fs.readFileSync(path.join(here, 'main.js')).length;
let mainDelta = 0;
const apply = (r) => { main = r.text; mainDelta += r.delta; };

apply(replaceOnce(
  main,
  '\twindowsAppearance: "dsh-desktop:windows-appearance",\n\twindowsMenu: "dsh-desktop:windows-menu"\n};',
  '\twindowsAppearance: "dsh-desktop:windows-appearance",\n\twindowMaterial: "dsh-desktop:window-material",\n\twindowsMenu: "dsh-desktop:windows-menu"\n};',
  'main: ipc channel',
));

apply(replaceOnce(
  main,
  `\t\t...process.platform === "win32" && primary ? {
\t\t\ttitleBarStyle: "hidden",
\t\t\ttitleBarOverlay: {
\t\t\t\theight: 40,
\t\t\t\tcolor: chromeFallbackFill(),
\t\t\t\tsymbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115"
\t\t\t}
\t\t} : {},`,
  `\t\t...process.platform === "win32" && primary ? {
\t\t\ttitleBarStyle: "hidden",
\t\t\ttitleBarOverlay: {
\t\t\t\theight: 40,
\t\t\t\tcolor: chromeFallbackFill(),
\t\t\t\tsymbolColor: nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115"
\t\t\t},
\t\t\tbackgroundColor: "#00000000",
\t\t\tbackgroundMaterial: "acrylic"
\t\t} : {},`,
  'main: acrylic window options',
));

apply(replaceOnce(
  main,
  `\t\t\tif (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({
\t\t\t\tcolor,
\t\t\t\tsymbolColor
\t\t\t});
\t\t});`,
  `\t\t\tif (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({
\t\t\t\tcolor,
\t\t\t\tsymbolColor
\t\t\t});
\t\t});
\t\tipcMain.on("dsh-desktop:window-material", (event, material) => {
\t\t\tif (mainWindow === void 0 || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return;
\t\t\tif (!event.senderFrame.url.startsWith(\`dsh-app://app/\`)) return;
\t\t\tif (![
\t\t\t\t"auto",
\t\t\t\t"none",
\t\t\t\t"mica",
\t\t\t\t"acrylic",
\t\t\t\t"tabbed"
\t\t\t].includes(material)) return;
\t\t\tmainWindow.setBackgroundMaterial(material);
\t\t\tif (material === "none") mainWindow.setBackgroundColor(chromeFallbackFill());
\t\t\telse mainWindow.setBackgroundColor("#00000000");
\t\t});`,
  'main: material ipc handler',
));

// Free space: the atomic-write module doc, verified as a leading JSDoc block.
apply(dropComment(
  main,
  '/**\n* Replace `filename` with `content` in one atomic step, creating parent\n',
  'main: drop atomic-write doc',
));

fs.writeFileSync(path.join(out, 'lib', 'main.js'), main);
const mainOutBytes = fs.readFileSync(path.join(out, 'lib', 'main.js')).length;
edits.push({ file: 'lib/main.js', originalBytes: mainBytes, patchedBytes: mainOutBytes, delta: mainDelta });
if (mainOutBytes > mainBytes) throw new Error(`lib/main.js grew by ${mainOutBytes - mainBytes} bytes; the layout-preserving patch is impossible`);

// ------------------------------------------------------- lib/preload-app.cjs
let preload = fs.readFileSync(path.join(here, 'preload-app.cjs'), 'utf8');
const preloadBytes = fs.readFileSync(path.join(here, 'preload-app.cjs')).length;
let preloadDelta = 0;
const applyPreload = (r) => { preload = r.text; preloadDelta += r.delta; };

applyPreload(replaceOnce(
  preload,
  '\twindowsAppearance: "dsh-desktop:windows-appearance",\n\twindowsMenu: "dsh-desktop:windows-menu"\n};',
  '\twindowsAppearance: "dsh-desktop:windows-appearance",\n\twindowMaterial: "dsh-desktop:window-material",\n\twindowsMenu: "dsh-desktop:windows-menu"\n};',
  'preload: ipc channel',
));

applyPreload(replaceOnce(
  preload,
  '\treturn {\n\t\tprotocolVersion: 1,\n\t\tbrowser: createDesktopBrowserBridge(),',
  '\treturn {\n\t\tprotocolVersion: 1,\n\t\twindowMaterial: (material) => electron.ipcRenderer.send("dsh-desktop:window-material", material),\n\t\tbrowser: createDesktopBrowserBridge(),',
  'preload: product api',
));

applyPreload(dropComment(
  preload,
  '/**\n* Watches `html[data-ds-theme-source]` and forwards each value to the main\n',
  'preload: drop native-theme doc',
));

fs.writeFileSync(path.join(out, 'lib', 'preload-app.cjs'), preload);
const preloadOutBytes = fs.readFileSync(path.join(out, 'lib', 'preload-app.cjs')).length;
edits.push({ file: 'lib/preload-app.cjs', originalBytes: preloadBytes, patchedBytes: preloadOutBytes, delta: preloadDelta });
if (preloadOutBytes > preloadBytes) throw new Error(`lib/preload-app.cjs grew by ${preloadOutBytes - preloadBytes} bytes`);

// ------------------------------- shadow-only: desktop host web port (optional)
let hostOut;
if (process.argv.includes('--shadow-port')) {
  const hostSrc = fs.readFileSync(path.join(here, 'desktop-host-index.js'));
  let host = hostSrc.toString('utf8');
  const r = replaceOnce(
    host,
    '\t\targs: [\n\t\t\t"--no-open",\n\t\t\t"--port",\n\t\t\t"19387"\n\t\t],',
    '\t\targs: [\n\t\t\t"--no-open",\n\t\t\t"--port",\n\t\t\t"19388"\n\t\t],',
    'host: shadow port',
  );
  host = r.text;
  fs.mkdirSync(path.join(out, 'dsh-host'), { recursive: true });
  fs.writeFileSync(path.join(out, 'dsh-host', 'index.js'), host);
  hostOut = { file: 'dsh-host/lib/index.js (shadow only)', originalBytes: hostSrc.length, patchedBytes: fs.readFileSync(path.join(out, 'dsh-host', 'index.js')).length, delta: r.delta };
}

for (const e of [...edits, ...(hostOut ? [hostOut] : [])]) {
  const margin = e.originalBytes - e.patchedBytes;
  console.log(`${e.file}: ${e.originalBytes} -> ${e.patchedBytes} bytes (delta ${e.delta >= 0 ? '+' : ''}${e.delta}, padding needed ${margin})`);
}
console.log('layout-preserving: OK');
