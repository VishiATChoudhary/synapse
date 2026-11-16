// Real Electron test: a real image on the system clipboard, a real paste into the GUI composer. The clipboard is
// saved first and put back after. Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-paste-image.cjs
const { app, BrowserWindow, clipboard, nativeImage } = require('electron');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-paste-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin');
for (const d of [state, bin]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bin, 'codex'), '#!/usr/bin/env node\nsetInterval(() => {}, 1 << 30);\n');
fs.chmodSync(path.join(bin, 'codex'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { codex: { command: `exec ${path.join(bin, 'codex')}`, label: 'Codex' } } }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win, gui, failed = false, saved;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check().catch(() => false)) return; await sleep(150); }
  throw new Error(`Timed out: ${label}`);
}
const ui = (code) => gui.executeJavaScript(code, true);
const native = (code) => win.webContents.executeJavaScript(code, true);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show(); win.focus();
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Codex')`), 'Codex launcher');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Codex').click()`);
  await until(() => ui(`[...document.querySelectorAll('.session-row')].some((r) => r.querySelector('.session-kind')?.dataset.kind === 'codex')`), 'codex row');
  await ui(`[...document.querySelectorAll('.session-row')].find((r) => r.querySelector('.session-kind').dataset.kind === 'codex').click()`);
  await until(() => ui(`!document.querySelector('#message-input').disabled`), 'composer ready');

  // a real 40x30 PNG on the system clipboard (what was there is put back after)
  saved = await clipboard.readText();
  const png = path.join(fixture, 'shot.png');
  const px = Buffer.alloc(40 * 30 * 4); for (let i = 0; i < px.length; i += 4) { px[i + 2] = 255; px[i + 3] = 255; }
  fs.writeFileSync(png, nativeImage.createFromBitmap(px, { width: 40, height: 30 }).toPNG());
  execFileSync('osascript', ['-e', `set the clipboard to (read (POSIX file "${png}") as «class PNGf»)`]);
  const pasteInto = async () => { await ui(`(() => { const i = document.querySelector('#message-input'); i.value = ''; i.focus(); return true; })()`); win.webContents.paste(); };
  await pasteInto();
  await until(() => ui(`(document.querySelector('#attach-row .attach-thumb')?.title || '').includes('paste-')`), 'image thumbnail in the composer', 8000);
  const value = await ui(`document.querySelector('#attach-row .attach-thumb').title`);
  const file = value.match(/'?(\/[^' ]+\.png)'?/)?.[1];
  assert.ok(file && fs.existsSync(file), `pasted image file missing: ${value}`);
  assert.deepEqual(nativeImage.createFromPath(file).getSize(), { width: 40, height: 30 });
  console.log('PASS image paste:', value.trim());

  // a file copied in Finder pastes as its own path, no copy made
  execFileSync('osascript', ['-e', `tell application "Finder" to set the clipboard to (POSIX file "${png}")`]);
  await pasteInto();
  await until(() => ui(`[...document.querySelectorAll('#attach-row figure')].some((f) => f.title.endsWith('shot.png'))`), 'the file in the composer', 8000);
  console.log('PASS file paste:', await ui(`[...document.querySelectorAll('#attach-row figure')].map((f) => f.title).join(' ')`));
})().catch(async (e) => {
  failed = true; console.error(e);
  if (win) fs.writeFileSync('/tmp/gui-paste.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => {
  if (saved !== undefined) clipboard.writeText(saved);
  app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit();
});
