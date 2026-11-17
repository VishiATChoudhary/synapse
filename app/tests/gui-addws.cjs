// Real Electron test for adding a workspace from the GUI: its own dialog (not the terminal one) with tabs for your
// workspaces, Clone, Folder and New; a new one is made and the new session screen opens on it right away.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-addws.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-addws-')));
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

  // the sidebar's add button opens the GUI dialog, with its tabs
  await ui(`document.getElementById('add-project').click()`);
  await until(() => ui(`document.getElementById('action-dialog').open && !!document.querySelector('.ws-tabs')`), 'the GUI dialog');
  assert.equal(await native(`document.getElementById('modal').hidden`), true, 'not the terminal one');
  assert.deepEqual(await ui(`[...document.querySelectorAll('[data-ws-tab]')].map((b) => b.textContent)`), ['Your workspaces', 'Clone', 'Folder', 'New']);
  await ui(`document.querySelector('[data-ws-tab="new"]').click()`);
  await until(() => ui(`document.getElementById('dialog-submit').textContent === 'Create' && document.getElementById('ws-value').placeholder === 'my-project'`), 'the New tab');
  if (process.env.ADDWS_SHOT) { // through CDP: capturePage is blank while the window is covered
    await sleep(400); const d = win.webContents.debugger; d.attach('1.3');
    for (const [tab, file] of [['new', process.env.ADDWS_SHOT], ['library', process.env.ADDWS_SHOT.replace(/\.png$/, '-library.png')], ['clone', process.env.ADDWS_SHOT.replace(/\.png$/, '-clone.png')]]) {
      await ui(`document.querySelector('[data-ws-tab="${tab}"]').click()`); await sleep(250);
      fs.writeFileSync(file, Buffer.from((await d.sendCommand('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    }
    d.detach(); await ui(`document.querySelector('[data-ws-tab="new"]').click()`);
  }
  await ui(`document.getElementById('ws-value').value = 'moonbase'; document.getElementById('action-form').requestSubmit()`);
  // made, in the sidebar, and the new session screen is on it
  await until(() => ui(`!document.getElementById('action-dialog').open`), 'the dialog closes');
  await until(() => ui(`!document.getElementById('new-view').hidden && /moonbase/.test(document.getElementById('new-project').textContent)`), 'the new session screen opens on it');
  assert.ok(fs.existsSync(path.join(state, 'workspaces', 'moonbase', '.git')), 'a git repo');
  console.log('PASS new workspace: made from the GUI dialog, and the new session screen opens on it');
  // the library lists it as already in the sidebar; picking it goes there
  await ui(`document.getElementById('add-project').click()`);
  await until(() => ui(`document.querySelector('[data-ws-tab="library"]')?.getAttribute('aria-pressed') !== null`), 'dialog again');
  await ui(`document.querySelector('[data-ws-tab="library"]').click()`);
  await until(() => ui(`/moonbase/.test(document.getElementById('ws-list').textContent) && /In sidebar/.test(document.getElementById('ws-list').textContent)`), 'listed in your workspaces');
  await ui(`document.getElementById('action-dialog').close()`);
  console.log('PASS your workspaces: lists it, marked as in the sidebar');
  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|net::ERR/.test(e)), []);
})().catch(async (e) => {
  failed = true; console.error(e); console.error('page errors:', errors);
  if (win) fs.writeFileSync('/tmp/gui-addws.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => { app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit(); });
