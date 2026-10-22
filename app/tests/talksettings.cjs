// Real Electron test for the settings "agent talk" section: the hourly limit and answer model are saved to
// app.json (clamped, allowlisted) and the answer counts come from the canvas server.
// Run: SYNAPSE_APP_PORT=<free port> node tests/talksettings.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-talkset-')));
const state = path.join(fixture, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], profiles: { shell: { command: 'cat', label: 'Shell' } } }));
fs.writeFileSync(path.join(state, 'talks.json'), JSON.stringify({ conversations: [
  { id: 'u1', role: 'owner', peer: 'm1', peerName: 'Bob', status: 'open', lastAt: Date.now(), turns: [{ seq: 1, q: 'q', a: 'a', answeredAt: Date.now() }, { seq: 2, q: 'q', a: 'a', answeredAt: Date.now() }] },
] }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_DEMO: '1', SYNAPSE_CLOUD: 'http://127.0.0.1:9', SHELL: '/bin/zsh' });
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
  await js(`document.querySelector('#settings').click()`);
  await until(() => js(`!!document.querySelector('#modal input[type=number]')`), 'agent talk section');
  assert.equal(await js(`document.querySelector('#modal input[type=number]').value`), '60', 'default limit');
  assert.equal(await js(`document.querySelector('#modal select').value`), 'agent', 'default model');
  await until(() => js(`/2 today/.test(document.querySelector('#modal').textContent)`), 'usage count');
  assert.match(await js(`document.querySelector('#modal').textContent`), /Bob 2/, 'per friend count');

  const set = (sel, v) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change')); })()`);
  await set('#modal input[type=number]', '9999');
  await until(() => saved().talkPerHour === 600, 'limit clamps to 600');
  assert.equal(await js(`document.querySelector('#modal input[type=number]').value`), '600');
  await set('#modal select', 'haiku');
  await until(() => saved().talkModel === 'haiku', 'model saved');

  assert.deepEqual(errors.filter((e) => !/Security Warning/.test(e)), [], 'no renderer errors: ' + errors.join(' | '));
  console.log('talk settings: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
