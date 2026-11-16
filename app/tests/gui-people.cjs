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
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DwHwyBNAMDAwMAZOMH+eiV5JcAAAAASUVORK5CYII=';
  const paste = (name) => ui(`(() => { const PNG = '${PNG}'; const i = document.querySelector('#message-input'); i.focus(); const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0))], ${JSON.stringify(name)}, { type: 'image/png' })); i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await type('look at');
  await paste('ignored.png');
  // a file shows as a chip with its name; the text keeps only what was typed
  await until(async () => JSON.stringify(await ui(`[...document.querySelectorAll('#attach-row figure')].map((f) => f.title)`)) === JSON.stringify(clip.paths), 'copied Finder files show as chips');
  assert.equal(await ui(`document.querySelector('#attach-row .attach-file span').textContent`), 'notes with space.txt');
  assert.equal(await ui(`document.querySelector('#message-input').value`), 'look at');
  if (process.env.ATTACH_SHOT) fs.writeFileSync(process.env.ATTACH_SHOT, (await win.webContents.capturePage()).toPNG());
  await ui(`document.querySelector('#attach-row [data-attach-remove]').click()`);
  clip = { paths: [] };
  await type('');
  await paste('shot.png');
  // an image waits above the text as a thumbnail, not as a path in it; it alone is enough to send, × removes it
  await until(() => ui(`/pastes\\/paste-.*-shot\\.png$/.test(document.querySelector('#attach-row .attach-thumb')?.title || '')`), 'a pasted image is saved and shown as a thumbnail');
  assert.equal(await ui(`document.querySelector('#message-input').value`), '');
  assert.match(await ui(`document.querySelector('#attach-row img').src`), /\/api\/file\/raw\?path=/);
  assert.equal(await ui(`document.querySelector('#send-message').disabled`), false, 'an image alone can be sent');
  const saved = await ui(`document.querySelector('#attach-row .attach-thumb').title`);
  assert.equal(fs.readFileSync(saved).toString('base64'), PNG, 'the saved file holds the pasted bytes');
  await until(() => ui(`document.querySelector('#attach-row img').naturalWidth === 2`), 'the thumbnail shows the image');
  await ui(`document.querySelector('#attach-row [data-attach-remove]').click()`);
  await until(() => ui(`document.querySelector('#attach-row').hidden && document.querySelector('#send-message').disabled`), 'removing the thumbnail');
  await type('');
  await ui(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['hello'], 'drop me.md', { type: 'text/markdown' })); document.querySelector('#composer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
  await until(() => ui(`/drop-me\\.md$/.test(document.querySelector('#attach-row .attach-file')?.title || '')`), 'a dropped file is copied and shown as a chip');
  assert.equal(fs.readFileSync(await ui(`document.querySelector('#attach-row .attach-file').title`), 'utf8'), 'hello');
  await ui(`document.querySelector('#attach-row [data-attach-remove]').click()`);
  await type('');
  console.log('PASS paste and drop: files show as chips with their name, images as thumbnails, sent as paths');

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

  // People and the status sections fold from their headings, and stay folded
  await ui(`document.querySelector('[data-fold-toggle="people"]').click()`);
  await until(() => ui(`document.querySelector('.people-list').hidden && document.querySelector('[data-fold-toggle="people"]').getAttribute('aria-expanded') === 'false'`), 'People folds');
  assert.ok(await ui(`JSON.parse(localStorage.getItem('synapse-collapsed')).includes('people:closed')`));
  await ui(`document.querySelector('[data-fold-toggle="people"]').click()`);
  await until(() => ui(`!document.querySelector('.people-list').hidden`), 'People unfolds');
  await ui(`document.getElementById('group-by').click()`);
  await ui(`[...document.querySelectorAll('.pop-menu button')].find((b) => b.textContent.includes('Group by status')).click()`);
  await until(() => ui(`!!document.querySelector('[data-fold-toggle^="flat:"]')`), 'a status section');
  const section = await ui(`document.querySelector('[data-fold-toggle^="flat:"]').dataset.foldToggle.slice(5)`);
  await sleep(700); // the rows' arrival from switching to Group by status has finished
  const sel = (inner) => `document.querySelector('[data-flat="${section}"] ${inner}')`;
  await ui(`${sel('.fold-toggle')}.click()`);
  await until(() => ui(`${sel('.flat-list')}.hidden && /\\d/.test(${sel('.count')}.textContent)`), 'the section folds and keeps its count');
  assert.ok(await ui(`JSON.parse(localStorage.getItem('synapse-collapsed')).includes('flat:${section}:closed')`));
  await ui(`${sel('.fold-toggle')}.click()`);
  await until(() => ui(`!${sel('.flat-list')}.hidden`), 'the section unfolds');
  assert.ok(await ui(`[...document.querySelectorAll('[data-flat="${section}"] .session-node')].every((n) => n.getAnimations().every((an) => !an.effect.getKeyframes().some((k) => k.transform && k.transform !== 'none')))`), 'opening a section slides no row in from the top');
  console.log('PASS folding: People and the status sections fold from their headings and stay folded');

  // hovering a row offers ✓ (settle) and archive; each one toggles back
  await ui(`document.getElementById('group-by').click()`);
  await ui(`[...document.querySelectorAll('.pop-menu button')].find((b) => b.textContent.includes('Group by project')).click()`);
  const rowId = await ui(`[...document.querySelectorAll('.session-row')].find((r) => r.getAttribute('aria-current') !== 'page').dataset.agent`);
  const row = (inner = '') => `document.querySelector('.session-row[data-agent=${JSON.stringify(rowId)}]${inner}')`;
  assert.deepEqual(await ui(`[...${row()}.querySelectorAll('[data-row-act]')].map((b) => b.getAttribute('aria-label'))`), ['Settle', 'Archive']);
  await ui(`${row(' [data-row-act="settle"]')}.click()`);
  await until(() => ui(`!!document.querySelector('[data-shelf="settled"]')?.contains(${row()})`), 'settled into the Settled shelf');
  assert.ok(await ui(`location.hash.includes('agent=') ? !location.hash.includes(${JSON.stringify(encodeURIComponent(rowId))}) : true`), 'settling did not open it');
  await ui(`${row(' [data-row-act="settle"]')}.click()`);
  await until(() => ui(`!document.querySelector('[data-shelf="settled"]')?.contains(${row()})`), 'brought back');
  await ui(`${row(' [data-row-act="archive"]')}.click()`);
  await until(() => ui(`!!document.querySelector('[data-shelf="archived"]')?.contains(${row()})`), 'archived');
  await ui(`${row(' [data-row-act="archive"]')}.click()`);
  await until(() => ui(`!document.querySelector('[data-shelf="archived"]')?.contains(${row()})`), 'unarchived');
  console.log('PASS row actions: ✓ settles and archive archives from the row, each toggles back, without opening the agent');

  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|net::ERR/.test(e)), []);
})().catch(async (e) => {
  failed = true; console.error(e);
  if (win) fs.writeFileSync('/tmp/gui-people.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => { app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit(); });
