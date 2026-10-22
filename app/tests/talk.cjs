// Real Electron test for agent talk in the app, driven by a seeded talks.json: an open conversation shows as an
// external row under the agent it asks (`asked by @bob`), the status circle lists it on hover, settings list the
// last 30 days per person, a new conversation raises one notification, and clicking the row opens the canvas thread.
// Run: npx electron tests/talk.cjs
const { app, BrowserWindow, Notification } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-talk-app-')));
const state = path.join(fixture, 'state'), feed = path.join(fixture, 'feed.json'), talksFile = path.join(state, 'talks.json');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], profiles: { shell: { command: 'cat', label: 'Shell' } } }));
fs.writeFileSync(feed, JSON.stringify({ account: { id: 'u1', name: 'Me', handle: 'me' }, incoming: [], outgoing: [], links: [] }));
const now = Date.now();
const conv = (id, o) => ({ id, role: 'owner', peer: 'u-bob', peerName: 'Bob', peerHandle: 'bob', asker: 'r-scout', askerName: 'scout', target: 'demo-api-auth', targetName: 'api-auth', mode: 'native', status: 'open', turns: [], createdAt: now - 60_000, lastAt: now - 30_000, ...o });
const turn = (q, a) => ({ seq: 1, q, a, askedAt: now - 50_000, answeredAt: a == null ? undefined : now - 40_000 });
const talks = { conversations: [
  // a hostile name: must show as text, never as markup
  conv('c1', { peerName: 'Bob <img src=x onerror="window.pwned=1">', turns: [turn('how does refresh work?', 'It rotates the token family.')] }),
  conv('c0', { peer: 'u-dana', peerName: 'Dana', peerHandle: 'dana', status: 'ended', endReason: 'idle', turns: [turn('which cookie name?', 'acme_session')], createdAt: now - 2 * 86400_000, lastAt: now - 2 * 86400_000 }),
  conv('cold', { peer: 'u-old', peerName: 'Olga', peerHandle: 'olga', status: 'ended', endReason: 'owner', turns: [turn('old?', 'yes')], createdAt: now - 40 * 86400_000, lastAt: now - 40 * 86400_000 }),
] };
fs.writeFileSync(talksFile, JSON.stringify(talks));

// notifications are recorded, not shown
const shown = [];
Notification.prototype.show = function () { shown.push({ title: this.title, body: this.body }); };

let win;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(50); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// app.exit skips before-quit, so the canvas server this test started is stopped by its port
const stopServer = (port) => {
  let pids = [];
  try { pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean); } catch {}
  for (const pid of pids) try { process.kill(Number(pid), 'SIGKILL'); } catch {}
};

let port;
(async () => {
  // never the live app's port or home: a canvas server of our own on a free port, answers by the fake claude
  port = await freePort();
  assert.notEqual(port, 4757);
  Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_APP_PORT: String(port), SYNAPSE_DEMO: '1', SYNAPSE_FAKE_REQUESTS: feed, SYNAPSE_REQUEST_POLL: '300', SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_TALK_CLAUDE: path.join(root, 'test/fixtures/fake-claude.mjs'), SHELL: '/bin/zsh' });
  for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG') delete process.env[key];
  process.chdir(fixture);
  app.setPath('userData', path.join(fixture, 'electron'));
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show();
  await until(() => js(`!!document.querySelector('#btn-canvas')`), 'top bar');
  // not connected (no friends, not signed in): the canvas server waits until something needs it
  await sleep(1500);
  const listening = await new Promise((resolve) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
  assert.equal(listening, false, 'no canvas server before the canvas or settings open');

  // the sidebar: an external row under the agent it asks
  await until(() => js(`!!document.querySelector('#tree .ext')`), 'external row in the sidebar');
  const row = await js(`document.querySelector('#tree .ext').textContent`);
  assert.match(row, /asked by @bob/, 'the row carries the badge');
  // the row above it (past any other external rows) is the agent being asked
  assert.match(await js(`(() => { let n = document.querySelector('#tree .ext'); while (n && n.classList.contains('ext')) n = n.previousElementSibling; return n?.textContent || ''; })()`), /api-auth/, 'it hangs under the target agent');
  assert.equal(await js(`document.querySelectorAll('#tree .ext').length`), 1, 'only the open conversation has a row');
  assert.equal(await js(`!!document.querySelector('#tree img') || !!window.pwned`), false, 'friend names are text');

  // the circle shows for an open conversation and lists it on hover
  await until(() => js(`!document.querySelector('#syn-dot').hidden`), 'circle shows');
  await js(`document.querySelector('#syn-dot').dispatchEvent(new MouseEvent('mouseenter'))`);
  await until(() => js(`!document.querySelector('#syn-pop').hidden`), 'hover opens the list');
  const pop = await js(`document.querySelector('#syn-pop').textContent`);
  assert.match(pop, /talking · 1/, 'one open conversation');
  assert.match(pop, /@bob.*api-auth/s, 'who asks which agent');
  await js(`document.querySelector('#syn-dot').dispatchEvent(new MouseEvent('mouseleave'))`);
  await until(() => js(`document.querySelector('#syn-pop').hidden`), 'leaving closes it');

  // conversations that were open at start stay quiet; a new one raises exactly one notification
  await sleep(1300);
  assert.deepEqual(shown, [], 'no notification for what was there at start');
  talks.conversations.push(conv('c2', { peer: 'u-carol', peerName: 'Carol', peerHandle: 'carol', target: 'demo-docs', targetName: 'docs', turns: [turn('where are the docs built?', null)] }));
  fs.writeFileSync(talksFile, JSON.stringify(talks));
  await until(() => shown.length === 1, 'notification for the new conversation', 5000);
  assert.match(shown[0].body, /@carol/, 'names who asks');
  assert.match(shown[0].body, /docs/, 'and which agent');
  await until(() => js(`document.querySelectorAll('#tree .ext').length === 2`), 'second row');
  await sleep(1300);
  assert.equal(shown.length, 1, 'notified once');

  // settings: past conversations per person, last 30 days
  await js(`document.querySelector('#settings').click()`);
  await until(() => js(`!!document.querySelector('#modal .talk-hist .talk-row')`), 'conversations in settings', 15000);
  const hist = await js(`document.querySelector('#modal .talk-hist').textContent`);
  assert.match(hist, /Dana/, 'an ended conversation from this month');
  assert.match(hist, /@bob/, 'the open one');
  assert.doesNotMatch(hist, /Olga/, 'older than 30 days is left out');
  assert.equal(await js(`!!document.querySelector('#modal img') || !!window.pwned`), false, 'friend names are text in settings too');
  await js(`document.querySelector('#modal-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await until(() => js(`document.querySelector('#modal').hidden`), 'settings close');

  // clicking the row opens the canvas on that conversation's thread
  await js(`[...document.querySelectorAll('#tree .ext')].find((r) => /@bob/.test(r.textContent)).click()`);
  await until(() => js(`!document.querySelector('#canvas').hidden`), 'canvas opens');
  const frame = () => win.webContents.mainFrame.frames.find((f) => f.url.includes(`127.0.0.1:${port}`));
  await until(async () => { const f = frame(); return f && f.executeJavaScript(`document.querySelector('#panel.open')?.textContent.includes('how does refresh work?') || false`); }, 'thread panel shows the conversation', 15000);

  assert.deepEqual(errors.filter((e) => !/Security Warning/.test(e)), [], 'no renderer errors: ' + errors.join(' | '));
  console.log('agent talk app surfaces: ok');
  stopServer(port);
  app.exit(0);
})().catch((e) => { console.error(e); stopServer(port); app.exit(1); });
