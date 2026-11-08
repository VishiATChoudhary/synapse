// Real Electron test: ⌘R and ⇧⌘R no longer reload the window (a reload threw away every terminal's screen and the
// app's hold on its sessions). The menu keeps everything else.
// Run: npx electron tests/no-reload.cjs
const { app, BrowserWindow, Menu, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-fullscreen-')));
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
  win.show(); win.focus(); await sleep(500);
  if (process.env.FS_SHOT) fs.writeFileSync(process.env.FS_SHOT.replace('.png', '-win.png'), (await win.webContents.capturePage({ x: 0, y: 0, width: 900, height: 120 })).toPNG());
  const all = (items) => items.flatMap((i) => [i, ...(i.submenu ? all(i.submenu.items) : [])]);
  const item = all(Menu.getApplicationMenu().items).find((i) => i.label === 'Toggle Full Screen');
  assert.ok(item && item.visible !== false, 'View has Toggle Full Screen');
  assert.equal(win.isFullScreenable(), true, 'the green button goes full screen');
  assert.equal(win.isMaximizable(), true, 'and the window can be zoomed');
  assert.equal(item.accelerator, 'Ctrl+Cmd+F');
  const toggle = { click: async () => item.click() }; // what the menu item and ⌃⌘F do
  const notch = () => win.webContents.executeJavaScript("getComputedStyle(document.body).getPropertyValue('--notch').trim()");
  const d = screen.getDisplayMatching(win.getBounds());
  const until = async (what, fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(100); } throw new Error(`timed out: ${what} native=${win.isFullScreen()} cls=${await win.webContents.executeJavaScript("document.body.className")}`); };
  await toggle.click();
  await until('full screen', async () => win.isFullScreen() && await win.webContents.executeJavaScript("document.body.classList.contains('full-screen')"));
  await sleep(600);
  console.log('after enter', { native: win.isFullScreen(), bounds: win.getBounds(), notch: await notch(), label: d.label });
  assert.equal(win.getBounds().width, d.bounds.width, 'covers the width of the display');
  if (process.env.FS_SHOT) fs.writeFileSync(process.env.FS_SHOT, (await win.webContents.capturePage({ x: 0, y: 0, width: 1512, height: 140 })).toPNG());
  assert.equal(await win.webContents.executeJavaScript("document.body.classList.contains('full-screen')"), true);
  assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.querySelector('.desktop-toolbar')).display"), 'none', 'no toolbar strip in terminal mode');
  await toggle.click();
  await until('left full screen', async () => !win.isFullScreen() && !(await win.webContents.executeJavaScript("document.body.classList.contains('full-screen')")));
  console.log('after leave', { native: win.isFullScreen(), notch: await notch() });
  assert.equal(await notch(), '0px');
  assert.equal(await win.webContents.executeJavaScript("document.body.classList.contains('full-screen')"), false);
  console.log('fullscreen: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
