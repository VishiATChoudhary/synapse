// Real Electron test for open at login, with the login item stubbed to a file (never this Mac's): the settings toggle
// calls it with true/false, and the one-time suggestion appears when a link first goes to talk, never turning it on alone.
// Run: SYNAPSE_APP_PORT=<free port> node tests/login.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-login-')));
const state = path.join(fixture, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], profiles: { shell: { command: 'cat', label: 'Shell' } } }));
const fake = path.join(fixture, 'login.json');
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
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show();
  await until(() => js(`!!document.querySelector('#btn-canvas')`), 'top bar');
  const calls = () => (fs.existsSync(fake) ? JSON.parse(fs.readFileSync(fake, 'utf8')).calls || [] : []);
  const box = () => js(`!!document.querySelector('#login-suggest')`);

  // settings toggle drives the stub
  await js(`document.querySelector('#settings').click()`);
  await until(() => js(`[...document.querySelectorAll('#modal .opt')].some((r) => /open at login/.test(r.textContent))`), 'login row');
  const row = `[...document.querySelectorAll('#modal .opt')].find((r) => /open at login/.test(r.textContent)).querySelector('input')`;
  assert.equal(await js(`${row}.checked`), false, 'default off');
  await js(`${row}.click()`);
  await until(() => calls().length === 1, 'enable call');
  assert.deepEqual(calls()[0], { openAtLogin: true, openAsHidden: true });
  await js(`${row}.click()`);
  await until(() => calls().length === 2, 'disable call');
  assert.deepEqual(calls()[1], { openAtLogin: false, openAsHidden: true });
  await js(`document.querySelector('#modal').hidden = true`);

  // a link goes to talk: one suggestion, nothing turned on by itself
  await sleep(1500);
  fs.writeFileSync(path.join(state, 'edges.json'), JSON.stringify([{ id: 'e1', mode: 'talk' }]));
  await until(box, 'suggestion');
  assert.match(await js(`document.querySelector('#login-suggest').textContent`), /Answer questions even when Synapse is closed\? Open at login/);
  assert.equal(calls().length, 2, 'suggesting does not enable');
  assert.equal(saved().loginSuggested, true);
  await js(`[...document.querySelectorAll('#login-suggest button')].find((b) => /Not now/.test(b.textContent)).click()`);
  assert.equal(await box(), false);
  fs.writeFileSync(path.join(state, 'edges.json'), JSON.stringify([{ id: 'e1', mode: 'talk' }, { id: 'e2', mode: 'talk' }]));
  await sleep(2500);
  assert.equal(await box(), false, 'only once');
  assert.equal(calls().length, 2, 'Not now changes nothing');

  // Turn on is the only thing that enables it
  await js(`window.__s = 1`); // renderer alive
  win.webContents.send('login:suggest');
  await until(box, 'suggestion again (renderer path)');
  await js(`[...document.querySelectorAll('#login-suggest button')].find((b) => /Turn on/.test(b.textContent)).click()`);
  await until(() => calls().length === 3, 'turn on call');
  assert.deepEqual(calls()[2], { openAtLogin: true, openAsHidden: true });

  assert.deepEqual(errors.filter((e) => !/Security Warning/.test(e)), [], 'no renderer errors: ' + errors.join(' | '));
  console.log('login: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
