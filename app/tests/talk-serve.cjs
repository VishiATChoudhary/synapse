// Real Electron test: a connected machine (it has a friend) runs the canvas server from launch, so a friend's
// question is answered without the canvas ever being opened. The answer comes from the fake claude; the relay is a
// closed port. Once opened, the canvas page itself can still write through the hardened API.
// Run: npx electron tests/talk-serve.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-talk-serve-')));
const state = path.join(fixture, 'state'), feed = path.join(fixture, 'feed.json'), talksFile = path.join(state, 'talks.json');
fs.mkdirSync(state);
const write = (f, v) => fs.writeFileSync(path.join(state, f), JSON.stringify(v));
write('app.json', { workspaces: [fixture], profiles: { shell: { command: 'cat', label: 'Shell' } } });
fs.writeFileSync(feed, JSON.stringify({ account: { id: 'u1', name: 'Me', handle: 'me' }, incoming: [], outgoing: [], links: [] }));
// Bob paired through a request and my api-auth is shared with his scout as talk
write('remote.json', { relay: 'http://127.0.0.1:9', machineId: 'me', token: 't', name: 'Me', blocked: [],
  peers: { 'u-bob': { name: 'Bob', pair: 'p', via: 'request', handle: 'bob', since: 1 } } });
write('edges.json', [{ id: 'te', from: 'demo-api-auth', to: 'r-u-bob-scout', fromName: 'api-auth', toName: 'scout', mode: 'talk', createdAt: 1 }]);
const conv = '00000000-0000-4000-8000-000000000001';
const now = Date.now();
write('talks.json', { conversations: [{ id: conv, role: 'owner', peer: 'u-bob', peerName: 'Bob', peerHandle: 'bob', asker: 'scout', askerName: 'scout',
  target: 'demo-api-auth', targetName: 'api-auth', mode: 'native', forkSession: null, status: 'open',
  turns: [{ seq: 1, q: 'why rotate refresh tokens?', a: null, askedAt: now }], createdAt: now, lastAt: now }],
queue: [{ conv, seq: 1 }], running: [], rate: {}, outgoing: [] });

let win;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const answer = () => { try { return JSON.parse(fs.readFileSync(talksFile, 'utf8')).conversations[0].turns[0].a; } catch { return null; } };

// app.exit skips before-quit, so the canvas server this test started is stopped by its port
const stopServer = (port) => {
  let pids = [];
  try { pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean); } catch {}
  for (const pid of pids) try { process.kill(Number(pid), 'SIGKILL'); } catch {}
};

let port;
(async () => {
  // never the live app's port or home
  port = await freePort();
  assert.notEqual(port, 4757);
  Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_APP_PORT: String(port), SYNAPSE_DEMO: '1', SYNAPSE_FAKE_REQUESTS: feed, SYNAPSE_REQUEST_POLL: '300', SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_TALK_CLAUDE: path.join(root, 'test/fixtures/fake-claude.mjs'), SYNAPSE_SYNC_MS: '500', SHELL: '/bin/zsh' });
  for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG') delete process.env[key];
  process.chdir(fixture);
  app.setPath('userData', path.join(fixture, 'electron'));
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.show();
  await until(() => js(`!!document.querySelector('#btn-canvas')`), 'top bar');

  // the question is answered with the canvas still closed
  await until(() => answer() != null, 'the queued question gets answered without opening the canvas', 20000);
  assert.equal(JSON.parse(answer()).external, '1', 'by the tool-less answerer');
  assert.equal(await js(`document.querySelector('#canvas').hidden`), true, 'the canvas was never opened');

  // the hardened API: a foreign Host is refused, the canvas page's own writes still go through
  const status = (headers) => new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/state', headers }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', reject);
  });
  assert.equal(await status({ host: `evil.example:${port}` }), 403, 'rebinding host');
  assert.equal(await status({}), 200, 'own host');
  await js(`document.querySelector('#btn-canvas').click()`);
  await until(() => js(`!document.querySelector('#canvas').hidden`), 'canvas opens');
  const frame = () => win.webContents.mainFrame.frames.find((f) => f.url.includes(`127.0.0.1:${port}`));
  await until(async () => { const f = frame(); return f && f.executeJavaScript(`document.readyState === 'complete'`); }, 'canvas page loads');
  const code = await frame().executeJavaScript(`fetch('/api/layout', { method: 'POST', body: JSON.stringify({ 'demo-docs': { x: 10, y: 20 } }) }).then((r) => r.status)`);
  assert.equal(code, 200, 'the canvas page writes its layout');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'layout.json'), 'utf8'))['demo-docs'], { x: 10, y: 20 });

  console.log('connected machine answers from launch: ok');
  stopServer(port);
  app.exit(0);
})().catch((e) => { console.error(e); stopServer(port); app.exit(1); });
