// Real Electron test: ⌘R and ⇧⌘R no longer reload the window (a reload threw away every terminal's screen and the
// app's hold on its sessions). The menu keeps everything else.
// Run: npx electron tests/no-reload.cjs
const { app, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-no-reload-')));
const state = path.join(fixture, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, wakeAgents: false, profiles: { shell: { command: 'cat', label: 'Shell' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_CLAUDE_HOME: path.join(fixture, 'claude'), SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO' || key === 'SYNAPSE_FAKE_REQUESTS') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100);
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  const all = (items) => items.flatMap((i) => [i, ...(i.submenu ? all(i.submenu.items) : [])]);
  const items = all(Menu.getApplicationMenu().items);
  assert.ok(!items.some((i) => /reload/i.test(String(i.role || ''))), 'no Reload in the menu');
  assert.ok(items.some((i) => String(i.role).toLowerCase() === 'copy') && items.some((i) => String(i.role).toLowerCase() === 'quit'), 'copy and quit are still there');
  await win.webContents.executeJavaScript('window.__alive = 1');
  let loads = 0;
  win.webContents.on('did-start-loading', () => loads++);
  win.show(); win.focus();
  for (const modifiers of [['meta'], ['meta', 'shift']]) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers });
  }
  await sleep(1500);
  assert.equal(loads, 0, 'the window did not reload');
  assert.equal(await win.webContents.executeJavaScript('window.__alive'), 1);
  console.log('no-reload: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
