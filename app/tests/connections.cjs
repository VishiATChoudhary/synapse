// Real Electron test for connections with friends, in both views. Terminal: friends lists what a friend asks of you
// and has an "ask" button next to "share". GUI (picked in Settings > view, the toolbar no longer has the switch):
// Add connection shares one of my agents with a friend or asks for one of theirs, and Connections lists what waits
// on you (accept picks which of your agents) and on them. The agent is a stand-in "codex"; friends come from the
// fake requests feed (SYNAPSE_FAKE_REQUESTS).
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/connections.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-conn-ui-')));
const state = path.join(fixture, 'state'), feed = path.join(fixture, 'feed.json'), bin = path.join(fixture, 'bin');
fs.mkdirSync(state); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'codex'), '#!/usr/bin/env node\nsetInterval(() => {}, 1 << 30);\n');
fs.chmodSync(path.join(bin, 'codex'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { shell: { command: 'cat', label: 'Shell' }, codex: { command: `exec ${path.join(bin, 'codex')}`, label: 'Codex' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
fs.writeFileSync(feed, JSON.stringify({
  account: { id: 'u1', name: 'Me', handle: 'me' }, outgoing: [], links: [], incomingTrust: [],
  people: [{ id: 'p1', handle: 'mara', name: 'Mara', trustsYou: true }, { id: 'p2', handle: 'jonas', name: 'Jonas', trustsYou: false }],
  incoming: [
    { id: 'q1', kind: 'ask', status: 'pending', from: { handle: 'mara', name: 'Mara' }, agent: { id: 'r-api', name: 'api', kind: 'claude', project: 'shop' }, target: 'the payments work' },
    { id: 'o1', kind: 'offer', mode: 'talk', status: 'pending', from: { handle: 'mara', name: 'Mara' }, agent: { id: 'r-web', name: 'web', kind: 'claude', project: 'shop' } },
  ],
}));
const read = () => JSON.parse(fs.readFileSync(feed, 'utf8'));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_FAKE_REQUESTS: feed, SYNAPSE_REQUEST_POLL: '300', SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win, gui;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const ui = (code) => gui.executeJavaScript(code, true);
const pop = () => js(`document.querySelector('#friends-pop').hidden ? '' : document.querySelector('#friends-pop').textContent`);
const friend = (name) => `[...document.querySelectorAll('#friends-pop .friend')].find((f) => f.querySelector('.friend-head b')?.textContent === ${JSON.stringify(name)})`;

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show();
  await until(() => js(`!!document.querySelector('#launch .launch-item')`), 'the launcher');
  assert.equal(await js(`document.querySelector('.desktop-modes').hidden`), true, 'no GUI/Terminal switch in the toolbar');
  await js(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Codex').click()`);
  await until(() => js(`!document.querySelector('#btn-share').classList.contains('off')`), 'the codex is an agent', 20000);
  const agentName = await js(`document.querySelector('#btn-share').title.replace(/^share (.*) with a friend$/, '$1')`);

  // Terminal: what Mara asks shows in friends, and "ask" sits next to "share"
  await until(() => js(`document.querySelector('#friends-count').textContent === '2'`), 'an ask and an offer wait');
  await js(`document.querySelector('#btn-friends').click()`);
  await until(async () => /wants yours · 1/.test(await pop()), 'the ask in friends');
  assert.match(await pop(), /wants your context for claude · api/);
  assert.equal(await js(`${friend('Jonas')}.querySelectorAll('button')[0].disabled`), true, 'no asking someone who has not added you back');
  await js(`${friend('Mara')}.querySelectorAll('button')[0].click()`);
  await until(() => js(`!document.querySelector('#modal').hidden && document.querySelector('#modal-title').textContent === 'ask Mara for an agent'`), 'the ask sheet');
  await until(() => js(`[...document.querySelectorAll('#modal .req-pick option')].some((o) => o.textContent.includes(${JSON.stringify(agentName)}))`), 'my agents to receive it');
  await js(`document.querySelector('#modal .ask-what').value = 'their api agent'; [...document.querySelectorAll('#modal .row .btn')].find((b) => b.textContent === 'ask').click()`);
  await until(() => (read().outgoing || []).some((r) => r.kind === 'ask'), 'the ask went out');
  const asked = read().outgoing.find((r) => r.kind === 'ask');
  assert.equal(asked.to.handle, 'mara'); assert.equal(asked.target, 'their api agent'); assert.match(asked.agent.id, /^codex-/);

  // Settings > view: GUI
  await js(`document.querySelector('#settings').click()`);
  await until(() => js(`!!document.querySelector('#modal .view-seg')`), 'view in settings');
  assert.equal(await js(`document.querySelector('#modal .view-seg .on').textContent`), 'Terminal');
  await js(`document.querySelector('#modal .view-seg [data-view="gui"]').click()`);
  await until(() => js(`!document.querySelector('#desktop-workspace').hidden`), 'the GUI is shown');
  await until(() => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => ui(`!!document.querySelector('[data-view="connections"]')`).catch(() => false), 'GUI ready', 20000);

  // GUI Connections: what waits on you and on them
  await ui(`document.querySelector('[data-view="connections"]').click()`);
  await until(() => ui(`document.querySelectorAll('#friends-list .friend-card').length >= 3`).catch(() => false), 'friends in Connections');
  const text = await ui(`document.querySelector('#friends-list').textContent`);
  assert.match(text, /Waiting for you/); assert.match(text, /Mara asks for one of your agents/); assert.match(text, /Mara wants to give you access to web/);
  assert.match(text, /Waiting for them/); assert.match(text, /You asked Mara for their api agent/);
  // accept Mara's ask with my codex
  await until(() => ui(`[...document.querySelectorAll('#friends-list [data-kind="ask"] .friend-pick option')].some((o) => o.textContent.includes(${JSON.stringify(agentName)}))`), 'my codex to share');
  await ui(`document.querySelector('#friends-list [data-friend-accept="q1"]').click()`);
  await until(() => (read().accepted || []).some((x) => x.id === 'q1'), 'the ask was accepted');
  await until(() => ui(`!document.querySelector('#friends-list [data-friend-accept="q1"]')`), 'answered asks leave the list');

  // Add connection: share with a friend, then ask a friend
  await ui(`document.querySelector('#new-connection').click()`);
  await until(() => ui(`!!document.querySelector('[data-conn-tab="share"]')`), 'the connection kinds');
  await ui(`document.querySelector('[data-conn-tab="share"]').click()`);
  await until(() => ui(`!!document.querySelector('#friend-who')`), 'the share form');
  assert.deepEqual(await ui(`[...document.querySelectorAll('#friend-who option')].map((o) => o.value)`), ['mara'], 'only friends who added you back');
  await ui(`document.querySelector('#friend-mode').value = 'sync'; document.querySelector('#dialog-submit').click()`);
  await until(() => (read().outgoing || []).some((r) => r.kind === 'offer'), 'the invite went out');
  const offered = read().outgoing.find((r) => r.kind === 'offer');
  assert.equal(offered.mode, 'sync'); assert.equal(offered.to.handle, 'mara'); assert.match(offered.agent.id, /^codex-/);
  await ui(`document.querySelector('#new-connection').click()`);
  await until(() => ui(`!!document.querySelector('[data-conn-tab="ask"]')`), 'the connection kinds again');
  await ui(`document.querySelector('[data-conn-tab="ask"]').click()`);
  await until(() => ui(`!!document.querySelector('#friend-what')`), 'the ask form');
  await ui(`document.querySelector('#friend-what').value = 'docs agent'; document.querySelector('#dialog-submit').click()`);
  await until(() => (read().outgoing || []).filter((r) => r.kind === 'ask').length === 2, 'the second ask went out');
  await until(() => ui(`!document.querySelector('#action-dialog').open`), 'the dialog closes once sent');
  await sleep(1500);
  assert.equal(await ui(`document.querySelector('#action-dialog').open`), false, 'and stays closed');

  // the composer: a slash command and an @friend are marked; tagging Mara offers to ask her for access
  await ui(`[...document.querySelectorAll('[data-agent]')].find((b) => /codex/.test(b.textContent)).click()`);
  await until(() => ui(`!!document.querySelector('#message-input') && !document.querySelector('#message-input').closest('[hidden]')`), 'the codex session');
  await ui(`(() => { const i = document.querySelector('#message-input'); i.focus(); i.value = '/ultrafast check the build with @ma'; i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input')); })()`);
  await until(() => ui(`!document.querySelector('#mention-pop').hidden`), 'friends to tag');
  assert.match(await ui(`document.querySelector('#mention-pop').textContent`), /Mara@mara/);
  assert.doesNotMatch(await ui(`document.querySelector('#mention-pop').textContent`), /Jonas/, 'only friends who added you back');
  await ui(`document.querySelector('#message-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  assert.equal(await ui(`document.querySelector('#message-input').value`), '/ultrafast check the build with @mara ', 'Enter picks the friend, it does not send');
  assert.equal(await ui(`document.querySelector('.composer-mirror mark.slash').textContent`), '/ultrafast');
  assert.equal(await ui(`document.querySelector('.composer-mirror mark.mention').textContent`), '@mara');
  assert.match(await ui(`document.querySelector('.composer-channel').textContent`), /\/ultrafastRuns as a Codex command/);
  await until(() => ui(`!!document.querySelector('[data-mention-ask="mara"]')`), 'request access for Mara');
  const asks = read().outgoing.filter((r) => r.kind === 'ask').length;
  await ui(`document.querySelector('[data-mention-ask="mara"]').click()`);
  await until(() => read().outgoing.filter((r) => r.kind === 'ask').length === asks + 1, 'the tag asked Mara');
  assert.match(read().outgoing.find((r) => r.kind === 'ask').target, /^an agent on /);
  await until(() => ui(`/Asked Mara for access/.test(document.querySelector('#mention-bar').textContent)`), 'the bar says it asked');

  assert.deepEqual(errors, []);
  console.log('connections: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
