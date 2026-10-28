// Real Electron test for shortcuts on keyboard layouts other than US. The key events carry what such a layout
// reports: on Italian ⌘1 is pressed as ⌘& (key "&", physical Digit1) and ⌃1 as ⌃&; on a Cyrillic layout ⌘T comes
// as key "е" on the T key. Each still does what the shortcut does, and AZERTY ⌘Z (on the physical W key) stays undo.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/layout-keys.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-layout-keys-')));
const state = path.join(fixture, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { claude: { command: 'cat', label: 'Claude Code' }, shell: { command: 'zsh -fi', label: 'Shell' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO' || key === 'SYNAPSE_FAKE_REQUESTS') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const press = (init) => js(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, cancelable: true, ...init })}))`);
const slots = () => js(`document.querySelectorAll('#tree .slot').length`);
const kinds = () => js(`[...document.querySelectorAll('#tree .slot .slot-title')].map((t) => t.textContent)`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'app window');
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('#launch .launch-item')`), 'the launcher');
  const start = await slots();

  // ⌘T as a Cyrillic layout reports it: a new shell tab
  await press({ key: 'е', code: 'KeyT', metaKey: true });
  await until(async () => (await slots()) === start + 1, 'Cyrillic ⌘T opens a shell');
  // ⌘T on Italian (and US): a new shell tab
  await press({ key: 't', code: 'KeyT', metaKey: true });
  await until(async () => (await slots()) === start + 2, 'Italian ⌘T opens a shell');
  // Italian ⌃1 is ⌃&: the first agent starts
  await press({ key: '&', code: 'Digit1', ctrlKey: true });
  await until(async () => (await kinds()).includes('Claude Code') || (await kinds()).includes('claude'), 'Italian ⌃& starts the first agent');
  const n = await slots();
  // Italian ⌘1 is ⌘&: it goes to the first tab, it is not typed into the terminal
  await press({ key: '&', code: 'Digit1', metaKey: true });
  await until(() => js(`document.querySelector('#tree .slot.focused') === document.querySelectorAll('#tree .slot')[0]`), 'Italian ⌘& focuses the first tab');
  // AZERTY ⌘Z sits on the physical W key: it stays the layout's Z (undo), and closes nothing
  await press({ key: 'z', code: 'KeyW', metaKey: true });
  await sleep(800);
  assert.equal(await slots(), n, 'AZERTY ⌘Z closes no tab');

  console.log('layout keys: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
