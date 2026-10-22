// Real Electron test for the hidden-start path (older macOS wasOpenedAsHidden / --hidden, stubbed here by the login file's startHidden):
// no window shows at launch but the renderer loads, and it can be shown afterwards.
// Run: SYNAPSE_APP_PORT=<free port> node tests/loginhidden.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-loginhid-')));
const state = path.join(fixture, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], profiles: { shell: { command: 'cat', label: 'Shell' } } }));
const fake = path.join(fixture, 'login.json');
fs.writeFileSync(fake, JSON.stringify({ openAtLogin: true, startHidden: true }));
fs.writeFileSync(path.join(state, 'edges.json'), '[]');
fs.writeFileSync(path.join(state, 'talks.json'), JSON.stringify({ conversations: [
  { id: 'u1', role: 'owner', peer: 'm1', peerName: 'Bob', status: 'open', lastAt: Date.now(), turns: [{ seq: 1, q: 'q', a: 'a', answeredAt: Date.now() }, { seq: 2, q: 'q', a: 'a', answeredAt: Date.now() }] },
] }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_DEMO: '1', SYNAPSE_FAKE_LOGIN_ITEMS: fake, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(50); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const saved = () => JSON.parse(fs.readFileSync(path.join(state, 'app.json'), 'utf8'));

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  await until(() => js(`!!document.querySelector('#btn-canvas')`), 'renderer loaded');
  await sleep(1200);
  assert.equal(win.isVisible(), false, 'hidden start shows no window');
  win.show();
  assert.equal(win.isVisible(), true, 'activate can still show it');
  console.log('login hidden: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
