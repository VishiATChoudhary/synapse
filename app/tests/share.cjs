// Real Electron test for friends and share, at the top right under fork. Friends lists the trusted people (who
// trusts you back, what flows each way) with offers waiting on you on top; accepting one picks which of your agents
// receives it. Share offers the open agent to a friend who trusts you back, read only or read and ask.
// The open agent is a stand-in "codex" (an idle node script by that name, which Synapse spots); friends come from the fake
// requests feed (SYNAPSE_FAKE_REQUESTS).
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/share.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-share-ui-')));
const state = path.join(fixture, 'state'), feed = path.join(fixture, 'feed.json'), bin = path.join(fixture, 'bin');
fs.mkdirSync(state); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'codex'), '#!/usr/bin/env node\nsetInterval(() => {}, 1 << 30);\n'); // shows as "node …/bin/codex"
fs.chmodSync(path.join(bin, 'codex'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], profiles: { shell: { command: 'cat', label: 'Shell' }, codex: { command: `exec ${path.join(bin, 'codex')}`, label: 'Codex' } } }));
fs.writeFileSync(feed, JSON.stringify({
  account: { id: 'u1', name: 'Me', handle: 'me' }, outgoing: [], links: [], incomingTrust: [],
  people: [{ id: 'p1', handle: 'mara', name: 'Mara', trustsYou: true }, { id: 'p2', handle: 'jonas', name: 'Jonas', trustsYou: false }],
  incoming: [{ id: 'o1', kind: 'offer', mode: 'talk', status: 'pending', from: { handle: 'mara', name: 'Mara' }, agent: { id: 'r-web', name: 'web', kind: 'claude', project: 'shop' } }],
}));
const read = () => JSON.parse(fs.readFileSync(feed, 'utf8'));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_FAKE_REQUESTS: feed, SYNAPSE_REQUEST_POLL: '300', SYNAPSE_CLOUD: 'http://127.0.0.1:9', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const pop = () => js(`document.querySelector('#friends-pop').hidden ? '' : document.querySelector('#friends-pop').textContent`);
const friend = (name) => `[...document.querySelectorAll('#friends-pop .friend')].find((f) => f.querySelector('.friend-head b')?.textContent === ${JSON.stringify(name)})`;

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show();
  await until(() => js(`!!document.querySelector('#btn-friends') && !!document.querySelector('#btn-share')`), 'friends and share in the top bar');
  await until(() => js(`document.querySelector('#friends-count').textContent === '1'`), 'the waiting offer shows on friends');
  assert.equal(await js(`document.querySelector('#btn-share').classList.contains('off')`), true, 'nothing open: share is dimmed');

  // open the stand-in codex: share wakes up for it
  await until(() => js(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Codex')`), 'the Codex launcher is ready');
  await js(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Codex').click()`);
  await until(() => js(`!document.querySelector('#btn-share').classList.contains('off')`), 'the open codex is an agent share can offer', 20000);
  const agentName = await js(`document.querySelector('#btn-share').title.replace(/^share (.*) with a friend$/, '$1')`);
  assert.match(agentName, /^codex-/);

  // friends: the offer on top, then each person and what they can do
  await js(`document.querySelector('#btn-friends').click()`);
  await until(async () => /shared with you · 1/.test(await pop()) && /trusted people · 2/.test(await pop()), 'friends list');
  assert.match(await pop(), /Mara.*shares claude · web with you, read and ask/);
  assert.match(await js(`${friend('Jonas')}.textContent`), /has not added you back yet/);
  assert.equal(await js(`${friend('Jonas')}.querySelector('button').disabled`), true, 'no sharing with someone who has not added you back');
  assert.equal(await js(`${friend('Mara')}.querySelector('button').title`), `offer ${agentName} to Mara`);

  // accept Mara's offer into the open codex
  await until(() => js(`[...document.querySelectorAll('#friends-pop .offer-in select option')].some((o) => o.textContent.includes(${JSON.stringify(agentName)}))`), 'my agents to receive it');
  await until(() => js(`document.querySelector('#friends-pop .offer-in select').selectedOptions[0].textContent.includes(${JSON.stringify(agentName)})`), 'the open agent is picked to receive it');
  await js(`[...document.querySelectorAll('#friends-pop .offer-in button')].find((b) => b.textContent === 'Accept').click()`);
  await until(() => (read().accepted || []).some((x) => x.id === 'o1'), 'the offer was accepted');
  assert.match(read().accepted[0].receiver, /^codex-/, 'into the agent picked');
  await until(async () => new RegExp(`their web → your ${agentName} · read and ask`).test(await pop()), 'Mara now shares web with my codex');
  assert.doesNotMatch(await pop(), /shared with you/, 'nothing waiting any more');

  // share my codex with Mara, read only
  await js(`${friend('Mara')}.querySelector('button').click()`);
  await until(() => js(`!document.querySelector('#modal').hidden && document.querySelector('#modal-title').textContent === ${JSON.stringify(`share ${agentName}`)}`), 'the share sheet');
  assert.deepEqual(await js(`[...document.querySelectorAll('#modal .share-person b')].map((b) => b.textContent)`), ['Mara'], 'only people who trust you back');
  assert.equal(await js(`document.querySelector('#modal .share-person').classList.contains('on')`), true, 'Mara picked');
  assert.equal(await js(`document.querySelector('#modal .seg .on').textContent`), 'read and ask', 'read and ask by default');
  await js(`[...document.querySelectorAll('#modal .seg button')].find((b) => b.textContent === 'read only').click()`);
  assert.match(await js(`document.querySelector('#modal .share-explain').textContent`), /can read what this one is doing/);
  await js(`[...document.querySelectorAll('#modal .row button')].find((b) => b.textContent === 'share').click()`);
  await until(() => (read().outgoing || []).length === 1, 'the offer went out');
  const sent = read().outgoing[0];
  assert.equal(sent.kind, 'offer'); assert.equal(sent.mode, 'sync'); assert.equal(sent.to.handle, 'mara'); assert.match(sent.agent.id, /^codex-/);
  assert.equal(await js(`document.querySelector('#modal').hidden`), true, 'the sheet closes');

  // back in friends: the offer waits for Mara
  await js(`document.querySelector('#btn-friends').click()`);
  await until(async () => new RegExp(`offered ${agentName} · waiting for them to accept`).test(await pop()), 'the pending offer in friends');
  // the share button at the top opens the same sheet for the open agent
  await js(`document.querySelector('#btn-friends').click(); document.querySelector('#btn-share').click()`);
  await until(() => js(`!document.querySelector('#modal').hidden && /offered · waiting/.test(document.querySelector('#modal .share-person').textContent)`), 'share from the top bar, Mara marked as offered');

  // a cloud from before offers: share stays off (it would file the offer the wrong way round) and says why
  await js(`document.querySelector('#modal .row .btn').click()`);
  fs.writeFileSync(feed, JSON.stringify({ ...read(), canOffer: false, offersLater: 'sharing turns on once Synapse Cloud is updated' }));
  await until(() => js(`document.querySelector('#btn-share').classList.contains('off')`), 'share off on an old cloud');
  assert.equal(await js(`document.querySelector('#btn-share').title`), 'sharing turns on once Synapse Cloud is updated');
  await js(`document.querySelector('#btn-share').click()`);
  assert.equal(await js(`document.querySelector('#modal').hidden`), true, 'no share sheet');
  await js(`document.querySelector('#btn-friends').click()`);
  await until(() => js(`${friend('Mara')}?.querySelector('button').disabled === true`), 'per-person share off too');

  assert.deepEqual(errors, []);
  console.log('share: ok');
  app.quit();
})().catch((e) => { console.error(e); app.exit(1); });
