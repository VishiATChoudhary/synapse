// Real Electron test for an agent's working light and the "done" notice. The agent is a stand-in "codex" (a node
// script by that name) that writes a Codex rollout: a turn starts, runs a while without using any CPU (like
// waiting on the model), then completes. Its dot has to blink while the turn runs and go green after; with the
// settings open (so you are not looking at it) the finish shows as a toast that opens the session.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/done.cjs
const { app, BrowserWindow, Notification } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-done-ui-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), codexHome = path.join(fixture, 'codex'), go = path.join(fixture, 'go');
fs.mkdirSync(state); fs.mkdirSync(bin);
// waits for the test to write "go", then runs one turn: started, quiet for 7 s, complete
fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const pad = (n) => String(n).padStart(2, '0'), d = new Date();
const dir = path.join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
const file = path.join(dir, \`rollout-\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}T\${pad(d.getHours())}-\${pad(d.getMinutes())}-\${pad(d.getSeconds())}-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl\`);
const line = (o) => fs.appendFileSync(file, JSON.stringify(o) + '\\n');
const ev = (type) => line({ type: 'event_msg', payload: { type } });
fs.mkdirSync(dir, { recursive: true });
line({ type: 'session_meta', payload: { cwd: process.cwd() } });
const wait = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(go)})) return;
  clearInterval(wait);
  line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] } });
  ev('task_started');
  setTimeout(() => { line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed the login bug.' }] } }); ev('task_complete'); }, 7000);
}, 200);
setInterval(() => {}, 1 << 30);
`);
fs.chmodSync(path.join(bin, 'codex'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], profiles: { shell: { command: 'cat', label: 'Shell' }, codex: { command: `exec ${path.join(bin, 'codex')}`, label: 'Codex' } } }));
Object.assign(process.env, { SYNAPSE_HOME: state, CODEX_HOME: codexHome, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO' || key === 'SYNAPSE_FAKE_REQUESTS') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
// notifications are kept here, never shown on this Mac
const shown = [];
Notification.prototype.show = function () { shown.push({ title: this.title, body: this.body }); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const dot = () => js(`[...document.querySelectorAll('.dot')].map((d) => d.className).find((c) => /working|done|idle|waiting/.test(c)) || ''`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('#launch .launch-item')`), 'the launcher');
  await js(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Codex').click()`);
  await until(async () => /\bidle\b/.test(await dot()), 'the codex is found, idle before its first turn', 20000);

  fs.writeFileSync(go, '');
  await until(async () => /\bworking\b/.test(await dot()), 'working while the turn runs, though it uses no CPU', 8000);
  assert.equal(await js(`getComputedStyle([...document.querySelectorAll('.dot.working')][0]).animationName`), 'tick', 'the light blinks');
  await sleep(2500);
  assert.match(await dot(), /\bworking\b/, 'still working mid-turn');

  // look elsewhere: the settings cover the session
  await js(`document.querySelector('#settings').click()`);
  await until(() => js(`!document.querySelector('#modal').hidden`), 'settings open');
  assert.match(await js(`document.querySelector('#modal').textContent`), /notify when done/);
  await until(async () => /\bdone\b/.test(await dot()), 'green once the turn completes', 12000);
  // Synapse in front: a toast; behind another app (the test window can lose focus): a notification
  await until(async () => shown.length || js(`!document.querySelector('#toast').hidden && document.querySelector('#toast').classList.contains('act')`), 'it says it is done', 6000);
  if (shown.length) {
    assert.match(shown[0].title, /^codex-.* is done$/);
    assert.equal(shown[0].body, 'Fixed the login bug.', 'with the start of its last reply');
  } else {
    assert.match(await js(`document.querySelector('#toast').textContent`), /^✓ .* is done · open$/);
    await js(`document.querySelector('#toast').click()`);
    assert.equal(await js(`document.querySelector('#toast').hidden`), true);
  }
  assert.deepEqual(errors, []);
  console.log('done.cjs: working light and done notice pass');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
