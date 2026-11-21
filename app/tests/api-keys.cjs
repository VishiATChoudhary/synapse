// Settings > API keys in a real Electron run: a pasted key is saved encrypted (a stand-in for the Keychain), shows
// as its last four, reaches a new Claude session as ANTHROPIC_API_KEY, and stops when Claude is turned off for it.
const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
if (typeof electron === 'string') {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-keys-')));
  const result = spawnSync(electron, [__filename], { env: { ...process.env, SYNAPSE_KEYS_FIXTURE: fixture }, stdio: 'inherit' });
  fs.rmSync(fixture, { recursive: true, force: true }); process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fixture = process.env.SYNAPSE_KEYS_FIXTURE;
assert.ok(fixture);
const root = path.resolve(__dirname, '../..'), state = path.join(fixture, 'state'), work = path.join(fixture, 'work');
for (const dir of [state, work]) fs.mkdirSync(dir);
Object.assign(process.env, { SYNAPSE_HOME: state, SUPERSET_HOME: path.join(fixture, 'superset'), SYNAPSE_CLAUDE_HOME: path.join(fixture, 'claude'), SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/sh', SYNAPSE_LOGINS_TEST_CRYPTO: '1', SYNAPSE_KEYS_OFFLINE: '1' });
delete process.env.ANTHROPIC_API_KEY;
fs.mkdirSync(path.join(fixture, 'claude', 'sessions'), { recursive: true });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
const probe = `sh -c 'echo "KEY=[$ANTHROPIC_API_KEY]"; sleep 30'`;
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [work], skipLogin: true, profiles: { shell: { command: '', label: 'Shell' }, claude: { command: probe, label: 'Claude Code' } } }));
process.chdir(work); app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await sleep(50); } throw new Error(`Timed out: ${label}`); }
const js = code => win.webContents.executeJavaScript(code, true);
const KEY = 'sk-ant-test-key-9876';
// a Claude session's first line: what ANTHROPIC_API_KEY it got
const keyOfNewSession = () => Promise.race([sleep(20000).then(() => { throw new Error('no KEY line from the session'); }), js(`new Promise(async (done) => {
  let out = ''; const off = synapse.pty.onData(({ id, data }) => { if (id === r.id) { out += data; const m = /KEY=\\[(.*?)\\]/.exec(out); if (m) { done(m[1]); synapse.pty.kill(r.id); } } });
  const r = await synapse.pty.spawn({ cwd: ${JSON.stringify(work)}, kind: 'claude', command: ${JSON.stringify(probe)}, cols: 80, rows: 24 });
})`)]);
(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'window');
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  await until(() => win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')), 'GUI frame', 30000);
  await until(() => js(`!!document.querySelector('#desktop-settings')`), 'settings button', 30000);
  console.log('gui up'); assert.equal(await keyOfNewSession(), '', 'no key before one is saved'); console.log('probe 1 ok');
  await js(`document.querySelector('#desktop-settings').click()`);
  await until(() => js(`!!document.querySelector('[data-settings-pane="keys"]')`), 'settings open');
  await js(`document.querySelector('[data-settings-pane="keys"]').click()`);
  await until(() => js(`!!document.querySelector('[data-key="anthropic"] input')`), 'providers listed');
  await js(`(() => { const r = document.querySelector('[data-key="anthropic"]'); [...r.querySelectorAll('.set-btn')].find(b => b.textContent === 'Add key').click(); r.querySelector('input').value = ${JSON.stringify(`ANTHROPIC_API_KEY=${KEY}`)}; r.querySelector('form').requestSubmit(); })()`);
  await until(() => js(`!!document.querySelector('[data-key="anthropic"].saved')`), 'key saved');
  assert.match(await js(`document.querySelector('[data-key="anthropic"] .key-sub').textContent`), /9876/);
  assert.doesNotMatch(fs.readFileSync(path.join(state, 'api-keys.json'), 'utf8'), new RegExp(`"${KEY}"`));
  if (process.env.KEYS_SHOT) { win.setBounds({ width: 1300, height: 900 }); await sleep(500); fs.writeFileSync(`${process.env.KEYS_SHOT}.png`, (await win.webContents.capturePage()).toPNG()); }
  assert.equal(await keyOfNewSession(), KEY, 'a new Claude session gets the key');
  // Claude off: back to its own sign-in
  await js(`[...document.querySelectorAll('[data-key="anthropic"] .key-chip')].find(c => c.textContent === 'Claude Code').click()`);
  await until(() => js(`[...document.querySelectorAll('[data-key="anthropic"] .key-chip')].find(c => c.textContent === 'Claude Code')?.getAttribute('aria-pressed') === 'false'`), 'claude off');
  assert.equal(await keyOfNewSession(), '', 'turned off for Claude');
  await js(`[...document.querySelectorAll('[data-key="anthropic"] .set-btn')].find(b => b.textContent === 'Remove').click()`);
  await until(() => js(`!document.querySelector('[data-key="anthropic"].saved')`), 'removed');
  assert.deepEqual(errors.filter(e => !/Autofill|favicon/i.test(e)), []);
  console.log('api-keys: ok');
  app.exit(0);
})().catch(e => { console.error(e); app.exit(1); });
