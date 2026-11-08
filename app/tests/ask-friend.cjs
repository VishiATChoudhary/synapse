// Real Electron test for ⌘N, ask a friend: the picker offers it; it lists the friends' agents in this workspace
// first (here Robert's "api", shared with the open codex), then asks to share or offers mine to trusted people.
// Picking a friend's agent opens the liaison tab, named after the friend.
// Run: npx electron tests/ask-friend.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-ask-friend-')));
const state = path.join(fixture, 'state'), feed = path.join(fixture, 'feed.json'), bin = path.join(fixture, 'bin');
fs.mkdirSync(state); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'codex'), '#!/usr/bin/env node\nsetInterval(() => {}, 1 << 30);\n');
fs.chmodSync(path.join(bin, 'codex'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], profiles: {
  claude: { command: 'cat', label: 'Claude' }, shell: { command: 'cat', label: 'Shell' }, codex: { command: `exec ${path.join(bin, 'codex')}`, label: 'Codex' } } }));
fs.writeFileSync(feed, JSON.stringify({ account: { id: 'u1', name: 'Me', handle: 'me' }, outgoing: [], links: [], incomingTrust: [], incoming: [],
  people: [{ id: 'p1', handle: 'mara', name: 'Mara', trustsYou: true }] }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_FAKE_REQUESTS: feed, SYNAPSE_REQUEST_POLL: '300', SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_CLAUDE_HOME: path.join(fixture, 'claude'), SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const modalText = () => js(`document.querySelector('#modal').hidden ? '' : document.querySelector('#modal-body').textContent`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.show();
  await until(() => js(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Codex')`), 'the Codex launcher');
  await js(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Codex').click()`);
  await until(() => js(`!document.querySelector('#btn-share').classList.contains('off')`), 'the open codex registered', 20000);
  const codex = await js(`document.querySelector('#btn-share').title.replace(/^share (.*) with a friend$/, '$1')`);
  // Robert shares his "api" (in a folder named like this workspace) with my codex, read and ask
  const mineId = (await import(pathToFileURL(path.join(root, 'lib.mjs')))).listAgents().find((a) => a.name === codex)?.id;
  assert.ok(mineId, 'my codex has an id');
  fs.writeFileSync(path.join(state, 'remote.json'), JSON.stringify({ relay: 'http://127.0.0.1:9', token: 't', peers: { m1: { name: 'Robert', pair: 'p', since: 1, via: 'request', handle: 'rob' } }, blocked: [] }));
  fs.mkdirSync(path.join(state, 'remote'), { recursive: true });
  fs.writeFileSync(path.join(state, 'remote', 'state.json'), JSON.stringify({ m1: { name: 'Robert', seen: Date.now(), shares: [], agents: [{ id: 'x', name: 'api', kind: 'claude', status: 'busy', project: path.basename(fixture), startedAt: 1 }] } }));
  fs.writeFileSync(path.join(state, 'edges.json'), JSON.stringify([{ id: 'mm', from: 'r-m1-x', to: mineId, mirrored: true, remote: 'm1', owner: 'Robert', mode: 'talk' }]));

  // ⌘N: ask a friend is in the picker
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['meta'] });
  await until(async () => /ask a friend/.test(await modalText()), 'the picker offers ask a friend');
  await js(`document.querySelector('#modal .friend-opt').click()`);
  await until(async () => /api@Robert/.test(await modalText()), "Robert's api in this workspace", 20000).catch(async (e) => { console.log('MODAL', await js("document.querySelector('#modal-title').textContent"), await modalText()); throw e; });
  const text = await modalText();
  assert.match(text, new RegExp(`their agents in ${path.basename(fixture)}`, 'i'));
  assert.match(text, /read and ask/);
  assert.match(text, /ask Mara/);
  assert.match(text, new RegExp(`share ${codex} with Mara`));
  if (process.env.SHOT) { await sleep(300); fs.writeFileSync(process.env.SHOT, (await win.webContents.capturePage()).toPNG()); }

  // pick it: the liaison tab opens, named after the friend
  await js(`[...document.querySelectorAll('#modal .opt')].find((o) => o.textContent.includes('api@Robert')).click()`);
  await until(() => js(`document.body.textContent.includes('ask Robert')`), 'the liaison tab', 15000);
  console.log('ask-friend: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
