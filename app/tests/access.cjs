// Real Electron test for a trusted person's access in settings, the desktop side of the phone's sharing design:
// each person's card lists my agents they see (read only or read and ask, switchable, or stopped) and theirs I see
// (only the owner changes those). Driven by the fake requests feed; a share's friend-supplied names stay text.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/access.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-access-')));
const state = path.join(fixture, 'state'), feed = path.join(fixture, 'feed.json');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], profiles: { shell: { command: 'cat', label: 'Shell' } } }));
const link = (edgeId, direction, mine, theirs, mode, handle = 'mara') => ({ direction, owner: 'Mara', handle, mode, agent: { id: `r:${theirs}`, name: theirs }, local: { id: mine, name: mine }, edgeId });
fs.writeFileSync(feed, JSON.stringify({
  account: { id: 'u1', name: 'Me', handle: 'me' }, incoming: [], outgoing: [], incomingTrust: [],
  people: [{ id: 'p1', handle: 'mara', name: 'Mara', trustsYou: true }, { id: 'p2', handle: 'jonas', name: 'Jonas', trustsYou: true }],
  links: [link('e1', 'out', 'api-auth', 'web', 'sync'), link('e2', 'out', 'billing', 'web', 'talk'), link('e3', 'in', 'web', '<b>checkout</b>', 'sync')],
}));
const read = () => JSON.parse(fs.readFileSync(feed, 'utf8'));
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
const card = (name) => `[...document.querySelectorAll('#modal .person-card')].find((c) => c.querySelector('.person .k').textContent === ${JSON.stringify(name)})`;
const text = (name) => js(`${card(name)}?.textContent || ''`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show();
  await until(() => js(`!!document.querySelector('#btn-canvas')`), 'top bar');
  await sleep(1000);
  await js(`document.querySelector('#settings').click()`);
  await until(() => js(`!!${card('Mara')}`), 'Mara has a card');

  const mara = await text('Mara');
  assert.match(mara, /Mara sees 2 of your agents · can ask 1/, 'summary of what she reaches');
  assert.match(mara, /you see 1 of Mara's agents/);
  assert.match(mara, /their <b>checkout<\/b>/, 'a friend-supplied agent name shows as text');
  assert.equal(await js(`${card('Mara')}.querySelector('b')`), null, 'and never as markup');
  const modes = () => js(`[...(${card('Mara')}?.querySelectorAll('.share-mode') || [])].map((s) => s.querySelector('.on').textContent)`);
  assert.deepEqual(await modes(), ['read only', 'read and ask']);
  assert.match(await text('Jonas'), /nothing shared either way/);

  // switch api-auth to read and ask: the share changes and the card redraws
  await js(`[...${card('Mara')}.querySelectorAll('.share')][0].querySelectorAll('.share-mode button')[1].click()`);
  await until(() => read().links.find((l) => l.edgeId === 'e1').mode === 'talk', 'api-auth switched to talk');
  await until(async () => JSON.stringify(await modes()) === '["read and ask","read and ask"]', 'card shows the new mode');
  assert.match(await text('Mara'), /can ask 2/);

  // stop sharing billing
  await js(`[...${card('Mara')}.querySelectorAll('.share')][1].querySelector('.tab-close').click()`);
  await until(() => !read().links.some((l) => l.edgeId === 'e2'), 'billing share stopped');
  await until(async () => /Mara sees 1 of your agents/.test(await text('Mara')), 'card shows one share left');
  assert.equal(await js(`${card('Mara')}.querySelectorAll('.share-tag').length`), 1, 'her share to me has a label, not a switch');

  assert.deepEqual(errors, []);
  console.log('access: ok');
  app.quit();
})().catch((e) => { console.error(e); app.exit(1); });
