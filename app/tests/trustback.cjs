// Real Electron test for "trust back": someone added me as a trusted person and I do not trust them yet.
// Driven by the fake requests feed (SYNAPSE_FAKE_REQUESTS) with an `incomingTrust` list: the circle blinks,
// the popover shows "@x added you" with Trust back / Ignore, Trust back trusts them and the row goes,
// Ignore dismisses, and settings lists the incoming ones above the trusted people. Names are friend-supplied,
// so a name with markup must show as text.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/trustback.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-trustback-')));
const state = path.join(fixture, 'state'), feed = path.join(fixture, 'feed.json');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], profiles: { shell: { command: 'cat', label: 'Shell' } } }));
const truster = (id, handle, name) => ({ id, handle, name, avatar: null, since: Date.now() });
const write = (f) => fs.writeFileSync(feed, JSON.stringify({ account: { id: 'u1', name: 'Me', handle: 'me' }, incoming: [], outgoing: [], links: [], incomingTrust: [], people: [], ...f }));
const read = () => JSON.parse(fs.readFileSync(feed, 'utf8'));
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
const click = (scope, label) => js(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show();
  await until(() => js(`!!document.querySelector('#btn-canvas')`), 'top bar');
  await sleep(800);
  assert.equal(await dot(), 'hidden', 'nobody added me: no circle');

  // someone added me: the circle blinks like a pending request
  write({ incomingTrust: [truster('t1', 'sam', '<img src=x onerror=alert(1)>Sam')] });
  await until(async () => (await dot()) === 'blink', 'circle blinks for an incoming truster');
  await js(`document.querySelector('#syn-dot').click()`);
  await until(() => js(`!!document.querySelector('#syn-pop .trust-in')`), 'trust row in the popover');
  const row = await js(`document.querySelector('#syn-pop .trust-in').textContent`);
  assert.match(row, /@sam added you/, 'says who added me');
  assert.equal(await js(`document.querySelector('#syn-pop .trust-in img[src="x"]')`), null, 'a friend-supplied name is text, never markup');
  assert.match(row, /<img src=x/, 'the name shows as typed');

  await click('#syn-pop .trust-in', 'Trust back');
  await until(async () => (await dot()) === 'hidden', 'trust back: the row and circle go');
  assert.deepEqual(read().people.map((p) => p.handle), ['sam'], 'trust back trusted them');
  assert.deepEqual(read().incomingTrust, [], 'no longer incoming');

  // the next one, ignored
  write({ incomingTrust: [truster('t2', 'kim', 'Kim Lee')] });
  await until(async () => (await dot()) === 'blink', 'blinks for the next truster');
  await js(`document.querySelector('#syn-dot').click()`);
  await until(() => js(`!!document.querySelector('#syn-pop .trust-in')`), 'second trust row');
  await click('#syn-pop .trust-in', 'Ignore');
  await until(async () => (await dot()) === 'hidden', 'ignore: the circle goes');
  assert.deepEqual(read().dismissed, ['t2'], 'ignore dismissed them');
  assert.deepEqual(read().people, [], 'ignore trusts nobody');

  // settings lists incoming ones above the trusted people, with the same buttons
  write({ incomingTrust: [truster('t3', 'lee', 'Lee')], people: [{ id: 'p1', handle: 'ana', name: 'Ana', trustsYou: true }] });
  await until(async () => (await dot()) === 'blink', 'blinks for a third truster');
  await js(`document.querySelector('#settings').click()`);
  await until(() => js(`!!document.querySelector('#modal .people .trust-in')`), 'incoming truster in settings');
  assert.equal(await js(`(() => { const b = document.querySelector('#modal .people'); return [...b.children].findIndex((c) => c.classList.contains('trust-in')) < [...b.children].findIndex((c) => c.classList.contains('person')); })()`), true, 'incoming sits on top');
  assert.match(await js(`document.querySelector('#modal .people .trust-in').textContent`), /@lee added you/);
  await click('#modal .people .trust-in', 'Trust back');
  await until(() => js(`!document.querySelector('#modal .people .trust-in')`), 'settings row goes after trust back');
  assert.deepEqual(read().people.map((p) => p.handle), ['ana', 'lee']);
  await until(async () => (await dot()) === 'hidden', 'circle goes too');

  assert.deepEqual(errors.filter((e) => !/Security Warning/.test(e)), [], 'no renderer errors: ' + errors.join(' | '));
  console.log('trust back: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
