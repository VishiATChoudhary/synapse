// Real Electron test for the GUI's People, sharing status and / menu, on the live code paths: friends come from the
// fake requests feed (SYNAPSE_FAKE_REQUESTS), the open agent is a stand-in "codex" (an idle node script by that name),
// and the / menu reads commands and skills from a fixture home.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-people.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-people-')));
const state = path.join(fixture, 'state'), feed = path.join(fixture, 'feed.json'), bin = path.join(fixture, 'bin'), home = path.join(fixture, 'home');
for (const d of [state, bin, path.join(home, '.codex', 'skills', 'deploy-check')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, '.codex', 'skills', 'deploy-check', 'SKILL.md'), '---\nname: deploy-check\ndescription: Check a deploy before it ships\n---\n');
fs.writeFileSync(path.join(bin, 'codex'), '#!/usr/bin/env node\nsetInterval(() => {}, 1 << 30);\n');
fs.chmodSync(path.join(bin, 'codex'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { codex: { command: `exec ${path.join(bin, 'codex')}`, label: 'Codex' } } }));
const writeFeed = (extra = {}) => fs.writeFileSync(feed, JSON.stringify({
  account: { id: 'u1', name: 'Me', handle: 'me' }, outgoing: [], links: [], incomingTrust: [],
  people: [{ id: 'p1', handle: 'mara', name: 'Mara', trustsYou: true }, { id: 'p2', handle: 'jonas', name: 'Jonas', trustsYou: false }],
  incoming: [{ id: 'o1', kind: 'offer', mode: 'talk', status: 'pending', from: { handle: 'mara', name: 'Mara' }, agent: { id: 'r-web', name: 'web', kind: 'claude', project: 'shop' } }],
  ...extra,
}));
writeFeed();
Object.assign(process.env, { HOME: home, SYNAPSE_HOME: state, SYNAPSE_FAKE_REQUESTS: feed, SYNAPSE_REQUEST_POLL: '300', SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win, gui, failed = false;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check().catch(() => false)) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const ui = (code) => gui.executeJavaScript(code, true);
const native = (code) => win.webContents.executeJavaScript(code, true);
const menuText = () => ui(`[...document.querySelectorAll('.pop-menu button')].map((b) => b.textContent)`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => ui(`!!document.querySelector('#project-list')`), 'GUI ready');

  // a Codex session in the fixture project
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Codex')`), 'Codex launcher');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Codex').click()`);
  await until(() => ui(`[...document.querySelectorAll('.session-row')].some((r) => r.querySelector('.session-kind')?.dataset.kind === 'codex')`), 'the codex session in the sidebar', 30000);
  await ui(`[...document.querySelectorAll('.session-row')].find((r) => r.querySelector('.session-kind').dataset.kind === 'codex').click()`);

  // friends see the codex once Synapse has registered it
  await until(() => native(`synapse.requests.agents().then((a) => a.length > 0)`), 'the codex is registered for friends', 30000);
  // People: Mara trusts you and offers an agent; Jonas has not added you back
  await until(() => ui(`!!document.querySelector('.people-group') && document.querySelector('.people-group').textContent.includes('Mara')`), 'People lists your friends');
  const people = await ui(`[...document.querySelectorAll('.person-row')].map((r) => r.textContent)`);
  assert.ok(people.some((t) => t.includes('Mara') && t.includes('1 request for you')), `Mara has a request: ${people}`);
  assert.ok(people.some((t) => t.includes('Jonas') && t.includes('Has not added you back')), `Jonas waits: ${people}`);
  await ui(`[...document.querySelectorAll('.person-row')].find((r) => r.textContent.includes('Mara')).click()`);
  await until(async () => (await menuText()).some((t) => t.startsWith('Ask Mara for an agent')), 'Mara: ask for an agent');
  assert.ok((await menuText()).some((t) => t.startsWith('Share "') && t.endsWith('with Mara…')), 'Mara: share the open agent');
  await ui(`[...document.querySelectorAll('.pop-menu button')].find((b) => b.textContent.startsWith('Ask Mara')).click()`);
  await until(() => ui(`document.querySelector('#action-dialog').open && document.querySelector('#friend-who')?.value === 'mara'`), 'ask dialog opens with Mara chosen');
  await ui(`document.querySelector('#cancel-dialog').click()`);
  console.log('PASS People: friends with their state, and asking or sharing starts with that person');

  // sharing status of the open agent: link it to Mara in the feed, the details panel says so
  const mine = await native(`(async () => (await synapse.requests.agents()).map((a) => ({ id: a.id, name: a.name })))()`);
  writeFeed({ links: [{ direction: 'out', owner: 'Mara', mode: 'talk', agent: { name: 'web', kind: 'claude' }, local: { id: mine[0].id, name: mine[0].name } }] });
  await ui(`document.querySelector('#context-toggle').getAttribute('aria-expanded') === 'true' || document.querySelector('#context-toggle').click()`);
  await until(() => ui(`(document.querySelector('.sharing')?.textContent || '').includes('Shared with Mara')`), 'details panel shows the share', 30000);
  assert.ok(await ui(`document.querySelector('.sharing .share-state.on')?.textContent === 'Connected'`));
  await until(() => ui(`!!document.querySelector('.session-row[aria-current="page"] .shared-mark')`), 'the row shows it is shared');
  console.log('PASS sharing status: the open agent shows who it is shared with, in the panel and on its row');

  // the / menu: Codex built-ins, and $ for its skills
  const type = (text) => ui(`(() => { const i = document.querySelector('#message-input'); i.focus(); i.value = ${JSON.stringify(text)}; i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await type('/');
  await until(() => ui(`!document.querySelector('#slash-pop').hidden && [...document.querySelectorAll('#slash-pop .slash-name')].some((n) => n.textContent === '/approvals')`), '/ lists Codex commands');
  await type('/appr');
  await until(() => ui(`document.querySelector('#slash-pop .slash-option[aria-selected="true"] .slash-name').textContent === '/approvals'`), 'typing filters');
  await ui(`document.querySelector('#message-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  assert.equal(await ui(`document.querySelector('#message-input').value`), '/approvals ', 'Enter inserts the command, it does not send');
  await type('please run /appr');
  await until(() => ui(`!document.querySelector('#slash-pop').hidden && document.querySelector('#slash-pop .slash-option[aria-selected="true"] .slash-name').textContent === '/approvals'`), '/ works in the middle of a message');
  await ui(`document.querySelector('#message-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))`);
  assert.equal(await ui(`document.querySelector('#message-input').value`), 'please run /approvals ');
  await type('see /Users/me/x');
  assert.equal(await ui(`document.querySelector('#slash-pop').hidden`), true, 'a path is not a command');
  await type('$dep');
  await until(() => ui(`!document.querySelector('#slash-pop').hidden && document.querySelector('#slash-pop').textContent.includes('Check a deploy before it ships')`), '$ lists skills with what they do');
  await type('');
  console.log('PASS / menu: commands and skills with descriptions, filtered, inserted with Enter');

  // paste and drop: the page cannot see file paths, so files arrive as paths the app provides. The real clipboard is
  // left alone: its reader is stood in for, first with copied Finder files, then empty (an image pasted from a page)
  let clip = { paths: [path.join(fixture, 'notes with space.txt')] };
  fs.writeFileSync(clip.paths[0], 'x');
  ipcMain.removeHandler('clipboard:files'); ipcMain.handle('clipboard:files', () => ({ ok: true, value: clip }));
  const paste = (name) => ui(`(() => { const i = document.querySelector('#message-input'); i.focus(); const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], ${JSON.stringify(name)}, { type: 'image/png' })); i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await type('look at');
  await paste('ignored.png');
  await until(async () => (await ui(`document.querySelector('#message-input').value`)) === `look at "${clip.paths[0]}" `, 'copied Finder files paste as their paths');
  clip = { paths: [] };
  await type('');
  await paste('shot.png');
  await until(() => ui(`/pastes\\/paste-.*-shot\\.png $/.test(document.querySelector('#message-input').value)`), 'a pasted image is saved and pasted as its path');
  const saved = (await ui(`document.querySelector('#message-input').value`)).trim();
  assert.deepEqual([...fs.readFileSync(saved)], [137, 80, 78, 71, 1, 2, 3], 'the saved file holds the pasted bytes');
  await type('');
  await ui(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['hello'], 'drop me.md', { type: 'text/markdown' })); document.querySelector('#composer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
  await until(() => ui(`/drop-me\\.md $/.test(document.querySelector('#message-input').value)`), 'a dropped file is copied and added as a path');
  assert.equal(fs.readFileSync((await ui(`document.querySelector('#message-input').value`)).trim(), 'utf8'), 'hello');
  await type('');
  console.log('PASS paste and drop: Finder files paste as paths, images and dropped files are saved and added as paths');

  // right-click: the /synapse actions. A second codex, then link the two from the menu
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Codex').click()`);
  await until(() => native(`synapse.requests.agents().then((a) => a.length > 1)`), 'a second codex registered', 30000);
  await until(() => ui(`[...document.querySelectorAll('.session-row')].filter((r) => r.querySelector('.session-kind')?.dataset.kind === 'codex').length === 2`), 'both codexes listed');
  await until(() => ui(`(() => { const row = [...document.querySelectorAll('.session-row')].find((r) => r.querySelector('.session-kind').dataset.kind === 'codex'); row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 160 })); return [...document.querySelectorAll('.pop-menu button')].some((b) => b.textContent === 'Link to another agent…'); })()`), 'menu offers Link once both are known to Synapse');
  const menu = await ui(`[...document.querySelectorAll('.pop-menu > *')].map((e) => e.textContent)`);
  for (const item of ['Synapse', 'Send a message…', 'Start a plan with…', 'Read its context', 'Copy its handle', 'Archive']) assert.ok(menu.includes(item), `${item} in ${menu}`);
  if (process.env.PEOPLE_SHOT) fs.writeFileSync(process.env.PEOPLE_SHOT, (await win.webContents.capturePage()).toPNG());
  await ui(`[...document.querySelectorAll('.pop-menu button')].find((b) => b.textContent === 'Link to another agent…').click()`);
  await until(() => ui(`document.querySelector('#action-dialog').open && !!document.querySelector('#link-other')`), 'link dialog');
  const edgesBefore = await ui(`fetch('/api/state').then((r) => r.json()).then((s) => s.edges.length)`);
  await ui(`document.querySelector('#action-form').requestSubmit()`);
  await until(async () => (await ui(`fetch('/api/state').then((r) => r.json()).then((s) => s.edges.length)`)) === edgesBefore + 2, 'linked both ways');
  console.log('PASS right-click: link, message, plan, read and copy, the /synapse actions; Link connects two agents both ways');

  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|net::ERR/.test(e)), []);
})().catch(async (e) => {
  failed = true; console.error(e);
  if (win) fs.writeFileSync('/tmp/gui-people.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => { app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit(); });
