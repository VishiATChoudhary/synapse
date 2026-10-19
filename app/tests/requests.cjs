// Real Electron test for the synapse-request circle next to "synapse" at the top right, driven by a fake
// requests feed (SYNAPSE_FAKE_REQUESTS): hidden with nothing going on, blinking while a request waits,
// gone after Deny, green after Accept, and hovering lists the synapsed external agents.
// Run: npx electron tests/requests.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-requests-')));
const state = path.join(fixture, 'state'), feed = path.join(fixture, 'feed.json');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], profiles: { shell: { command: 'cat', label: 'Shell' } } }));
const request = (id) => ({ id, status: 'pending', from: { handle: 'sam', name: 'Sam Rivera' }, to: { handle: 'me', name: 'Me' }, agent: { id: 'a1', name: 'api-auth', kind: 'claude', project: 'acme' }, target: 'auth agent', createdAt: Date.now() });
const write = (f) => fs.writeFileSync(feed, JSON.stringify({ account: { id: 'u1', name: 'Me', handle: 'me' }, incoming: [], outgoing: [], links: [], ...f }));
write({});
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_DEMO: '1', SYNAPSE_FAKE_REQUESTS: feed, SYNAPSE_REQUEST_POLL: '300', SYNAPSE_CLOUD: 'http://127.0.0.1:9', SHELL: '/bin/zsh' });
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
const dot = () => js(`(() => { const d = document.querySelector('#syn-dot'); return d.hidden ? 'hidden' : d.className; })()`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show();
  await until(() => js(`!!document.querySelector('#btn-canvas')`), 'top bar');
  await sleep(800);

  assert.equal(await dot(), 'hidden', 'no requests, no links: no circle');
  assert.equal(await js(`document.querySelector('#btn-canvas .glyph').hidden`), false, 'the ◇ shows instead');
  assert.equal(await js(`document.querySelector('#login').hidden`), true, 'demo runs never show the sign-in screen');

  write({ incoming: [request('r1')] });
  await until(async () => (await dot()) === 'blink', 'circle blinks for a pending request');
  assert.equal(await js(`document.querySelector('#btn-canvas .glyph').hidden`), true, 'the circle replaces the ◇');

  // clicking the circle opens the popover and does not open the canvas
  await js(`document.querySelector('#syn-dot').click()`);
  await until(() => js(`!document.querySelector('#syn-pop').hidden`), 'popover opens');
  assert.equal(await js(`document.querySelector('#canvas').hidden`), true, 'the canvas stays closed');
  assert.match(await js(`document.querySelector('#syn-pop').textContent`), /Sam Rivera.*api-auth/s, 'the request shows who and which agent');

  await js(`[...document.querySelectorAll('#syn-pop button')].find((b) => b.textContent === 'Deny').click()`);
  await until(async () => (await dot()) === 'hidden', 'deny: the circle disappears');
  assert.equal(JSON.parse(fs.readFileSync(feed, 'utf8')).incoming.length, 0, 'the request is gone');

  // a new request, accepted: green, and hovering lists the external agent
  write({ incoming: [request('r2')] });
  await until(async () => (await dot()) === 'blink', 'blinks again for the next request');
  await js(`document.querySelector('#syn-dot').click()`);
  await until(() => js(`!!document.querySelector('#syn-pop .req')`), 'request in popover');
  // no live agents in the fixture, so Accept waits for one; give the select an agent like the main process would
  await js(`(() => { const s = document.querySelector('#syn-pop .req-pick'); s.disabled = false; s.innerHTML = '<option value="x1">shell</option>'; s.value = 'x1'; const b = [...document.querySelectorAll('#syn-pop button')].find((b) => b.textContent === 'Accept'); b.disabled = false; b.click(); })()`);
  await until(async () => (await dot()) === 'live', 'accept: the circle turns green');
  assert.deepEqual(JSON.parse(fs.readFileSync(feed, 'utf8')).accepted.map((a) => [a.id, a.talk]), [['r2', true]], 'accepted with "let their agent ask" ticked by default');
  await js(`document.querySelector('#stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await until(() => js(`document.querySelector('#syn-pop').hidden`), 'outside click closes the popover');
  await js(`document.querySelector('#syn-dot').dispatchEvent(new MouseEvent('mouseenter'))`);
  await until(() => js(`!document.querySelector('#syn-pop').hidden`), 'hover opens the list');
  const list = await js(`document.querySelector('#syn-pop').textContent`);
  assert.match(list, /synapsed · 1/, 'one synapsed agent');
  assert.match(list, /Sam Rivera.*api-auth/s, 'grouped under its owner');
  await js(`document.querySelector('#syn-dot').dispatchEvent(new MouseEvent('mouseleave'))`);
  await until(() => js(`document.querySelector('#syn-pop').hidden`), 'leaving closes a hover popover');

  // unticked: the accept is read only
  const f3 = JSON.parse(fs.readFileSync(feed, 'utf8'));
  f3.incoming = [request('r3')];
  fs.writeFileSync(feed, JSON.stringify(f3));
  await until(async () => (await dot()) === 'blink', 'blinks for the third request');
  await js(`document.querySelector('#syn-dot').click()`);
  await until(() => js(`!!document.querySelector('#syn-pop .req-talk input')`), 'the talk checkbox');
  assert.match(await js(`document.querySelector('#syn-pop .req-talk').textContent`), /^Let their agent ask questions too$/);
  assert.equal(await js(`document.querySelector('#syn-pop .req-talk input').checked`), true);
  await js(`(() => { const t = document.querySelector('#syn-pop .req-talk input'); t.click(); const s = document.querySelector('#syn-pop .req-pick'); s.disabled = false; s.innerHTML = '<option value="x1">shell</option>'; s.value = 'x1'; const b = [...document.querySelectorAll('#syn-pop button')].find((b) => b.textContent === 'Accept'); b.disabled = false; b.click(); })()`);
  await until(() => JSON.parse(fs.readFileSync(feed, 'utf8')).accepted.length === 2, 'third accept');
  assert.deepEqual(JSON.parse(fs.readFileSync(feed, 'utf8')).accepted[1], { id: 'r3', agents: ['x1'], talk: false }, 'unticked: read only');
  await js(`document.querySelector('#stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);

  // a friend's agent asked over a read-only share: one Allow / Not now row; Allow switches that share to talk
  const R = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(path.join(state, 'remote.json'), JSON.stringify({ relay: 'http://127.0.0.1:9', token: 't', peers: { m1: { name: 'Sam Rivera', pair: 'p', via: 'request', handle: 'sam', since: 1 } }, blocked: [] }));
  fs.writeFileSync(path.join(state, 'edges.json'), JSON.stringify([
    { id: 'e-share', from: 'demo-api-auth', to: 'r-m1-a1', fromName: 'api-auth', toName: 'api-auth' },
    { id: 'e-other', from: 'demo-docs', to: 'r-m1-a1', fromName: 'docs', toName: 'api-auth' },
  ]));
  fs.writeFileSync(path.join(state, 'talks.json'), JSON.stringify({ conversations: [], talkRequests: [
    { id: R, peer: 'm1', peerName: 'Sam Rivera', peerHandle: 'sam', target: 'demo-api-auth', targetName: 'api-auth', asker: 'a1', askerName: '<img src=x onerror=window.pwned=1>', at: Date.now(), status: 'pending' },
  ] }));
  await until(async () => (await dot()) === 'blink', 'the circle blinks for a talk request');
  await js(`document.querySelector('#syn-dot').click()`);
  await until(() => js(`!!document.querySelector('#syn-pop .talk-req')`), 'talk request row');
  const ask = await js(`document.querySelector('#syn-pop .talk-req').textContent`);
  assert.match(ask, /@sam's agent wants to ask\s*api-auth/);
  assert.match(ask, /<img src=x/, 'the asker name shows as text');
  assert.equal(await js(`!!document.querySelector('#syn-pop img[src="x"]') || !!window.pwned`), false, 'and never as markup');
  assert.equal(await js(`document.querySelectorAll('#syn-pop .talk-req').length`), 1);
  await js(`[...document.querySelectorAll('#syn-pop .talk-req button')].find((b) => b.textContent === 'Allow').click()`);
  await until(() => JSON.parse(fs.readFileSync(path.join(state, 'edges.json'), 'utf8')).find((e) => e.id === 'e-share').mode === 'talk', 'allow: the share talks');
  const edgesAfter = JSON.parse(fs.readFileSync(path.join(state, 'edges.json'), 'utf8'));
  assert.equal(edgesAfter.find((e) => e.id === 'e-other').mode, undefined, 'only that share');
  const t = JSON.parse(fs.readFileSync(path.join(state, 'talks.json'), 'utf8'));
  assert.equal(t.talkRequests[0].status, 'allowed');
  assert.deepEqual(t.outgoing, [{ to: 'm1', item: { type: 'talk-status', requestId: R, state: 'allowed' } }]);
  await until(() => js(`!document.querySelector('#syn-pop .talk-req')`), 'the row goes');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'app.json'), 'utf8')).talkRequestsNotified, [R], 'announced once');

  assert.deepEqual(errors.filter((e) => !/Security Warning/.test(e)), [], 'no renderer errors: ' + errors.join(' | '));
  console.log('requests circle: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
