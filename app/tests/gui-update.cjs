// Real Electron test for the update banner: a new version shows at the bottom left of the sidebar with its
// download progress, then Update to Synapse X with Restart, and stays until you update.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-update.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-update-')));
const project = path.join(fixture, 'rocket'), state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), typed = path.join(fixture, 'typed.txt');
for (const d of [project, state, bin]) fs.mkdirSync(d, { recursive: true });
// a GitHub remote, so the rows show the owner's picture (the test never needs it to load)
require('node:child_process').execFileSync('git', ['init', '-q', project]); require('node:child_process').execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/invertix-ai/rocket.git']);
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
process.stdout.write('stand-in claude ready\\r\\n> ');
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', (d) => { fs.appendFileSync(${JSON.stringify(typed)}, d.toString()); process.stdout.write(d.toString().replace(/\\r/g, '\\r\\n')); });
setInterval(() => {}, 1 << 30);
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [project], skipLogin: true, profiles: { claude: { command: `exec ${path.join(bin, 'claude')}`, label: 'Claude' }, shell: { command: '', label: 'Shell' } } }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win, gui, failed = false;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check().catch(() => false)) return; await sleep(120); }
  throw new Error(`Timed out: ${label}`);
}
const ui = (code) => gui.executeJavaScript(code, true);
const native = (code) => win.webContents.executeJavaScript(code, true);
const key = (k, extra = '') => ui(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', metaKey: true, bubbles: true, cancelable: true ${extra} }))`);
const type = async (text) => { for (const ch of text) { win.webContents.sendInputEvent({ type: 'char', keyCode: ch === '\r' ? '\u000d' : ch }); await sleep(15); } };
// where the docked terminals are, in the window, and the page's empty boxes they should cover
const docks = () => native(`[...document.querySelectorAll('#gui-docks .gui-dock')].map((d) => { const r = d.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, text: d.querySelector('.xterm-rows')?.textContent || '' }; })`);
const hostRect = async (id) => {
  const frame = await native(`(() => { const r = document.querySelector('#workspace-frame').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
  const r = await ui(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  return { x: frame.x + r.x, y: frame.y + r.y, w: r.w, h: r.h };
};
const near = (a, b) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2 && Math.abs(a.w - b.w) < 2 && Math.abs(a.h - b.h) < 2;

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show(); win.focus();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => ui(`!!document.body.classList.contains('desktop') && !!document.querySelector('#project-list .project-head, #project-list [data-project-key], #project-list section')`), 'GUI with the project');

  // a new version: a banner at the bottom left, with progress, then Restart; it stays until you update
  win.webContents.send('update', { state: 'downloading', version: '9.9.9', progress: 0.4 });
  await until(() => ui(`!document.getElementById('update-card').hidden && /Downloading 9\\.9\\.9/.test(document.getElementById('update-card').textContent) && /40%/.test(document.getElementById('update-card').textContent)`), 'the download shows in the GUI');
  let installed = 0;
  ipcMain.removeHandler('update:install'); ipcMain.handle('update:install', () => { installed++; return { ok: true, value: null }; });
  win.webContents.send('update', { state: 'ready', version: '9.9.9' });
  await until(() => ui(`/Synapse 9\\.9\\.9 is ready/.test(document.getElementById('update-card').textContent)`), 'ready to restart');
  if (process.env.UPDATE_SHOT) { await sleep(500); const d = win.webContents.debugger; d.attach('1.3'); fs.writeFileSync(process.env.UPDATE_SHOT, Buffer.from((await d.sendCommand('Page.captureScreenshot', { format: 'png' })).data, 'base64')); d.detach(); } // CDP: capturePage is blank while the window is covered
  const card = await ui(`(() => { const r = document.getElementById('update-card').getBoundingClientRect(); return { left: r.left, bottom: innerHeight - r.bottom }; })()`);
  assert.ok(card.left < 40 && card.bottom < 120, `bottom left: ${JSON.stringify(card)}`);
  await ui(`document.querySelector('[data-update-go]').click()`);
  await until(async () => installed === 1, 'Restart installs the update');
  win.webContents.send('update', { state: 'ready', version: '9.9.10' });
  await until(() => ui(`/Synapse 9\\.9\\.10 is ready/.test(document.getElementById('update-card').textContent)`), 'a newer version shows');
  console.log('PASS update banner: progress and Restart at the bottom left');
  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|net::ERR/.test(e)), []);
})().catch(async (e) => {
  failed = true; console.error(e); console.error('page errors:', errors);
  if (win) fs.writeFileSync('/tmp/gui-update.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => { app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit(); });
