// Real Electron regression test for the workspace library: folders added from elsewhere get a
// symlink in <SYNAPSE_HOME>/workspaces, the library tab lists them, and the setting turns it off.
// All app state and PTYs belong to a temporary fixture.
// Run: npm --prefix app run test:library
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-library-')));
const state = path.join(fixture, 'state');
const lib = path.join(state, 'workspaces');
const dir = (...p) => { const d = path.join(fixture, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const alpha = dir('code', 'alpha'), beta = dir('code', 'beta'), beta2 = dir('other', 'beta'), gamma = dir('code', 'gamma'), epsilon = dir('code', 'epsilon');
fs.mkdirSync(state);
// a `claude` that only the user's .zshrc puts on PATH: an app started from the Dock has launchd's bare PATH,
// and a plain login shell never reads .zshrc
const fakeBin = dir('bin'), zdot = dir('zdot');
fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\necho FAKE_CLAUDE_RAN\nexec cat\n', { mode: 0o755 });
fs.writeFileSync(path.join(zdot, '.zshrc'), `export PATH="${fakeBin}:$PATH"\n`);
process.env.ZDOTDIR = zdot;
// a Superset-style layout: a repo in projects/ with a worktree in worktrees/<repo>/<branch>
const superset = dir('superset'), acme = dir('superset', 'projects', 'acme'), feature = path.join(superset, 'worktrees', 'acme', 'feature');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
git(acme, 'init', '-q'); git(acme, 'commit', '-q', '--allow-empty', '-m', 'init');
fs.mkdirSync(path.dirname(feature), { recursive: true }); git(acme, 'worktree', 'add', '-q', '-b', 'feature', feature);
process.env.SUPERSET_HOME = superset;
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [alpha], profiles: { shell: { command: 'cat', label: 'Shell' }, claude: { command: 'claude', label: 'Claude Code' } } }));
process.env.SYNAPSE_HOME = state;
process.env.SYNAPSE_DEMO = '1';
process.env.SHELL = '/bin/zsh';
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(25); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true).catch(e => { throw new Error(`${code}: ${e.message}`); });
const linkOf = (name) => { try { return fs.readlinkSync(path.join(lib, name)); } catch { return null; } };
const config = () => JSON.parse(fs.readFileSync(path.join(state, 'app.json'), 'utf8'));

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('.term.visible .xterm-helper-textarea')`), 'first session');

  // the whole theme button is clickable: nothing lies over its top half
  const hits = await js(`(() => { const r = document.querySelector('#theme').getBoundingClientRect(); const x = r.left + r.width / 2; return [r.top + 6, r.bottom - 6].map((y) => document.elementFromPoint(x, y).id || document.elementFromPoint(x, y).className); })()`);
  assert.deepEqual(hits, ['theme', 'theme'], 'top and bottom of the theme button both hit the button');

  // sidebar: the folder name appears once, the session row says what runs there
  const [wtName, slotTitle] = await js(`[document.querySelector('.wt-name').textContent, document.querySelector('.slot-title').textContent]`);
  assert.equal(wtName, 'alpha');
  assert.match(slotTitle, /shell/i, 'session row names what runs, not the folder again');

  // folding a project with running sessions sticks: the one-second state push must not reopen it
  await js(`document.querySelector('#tree .proj-head').click()`);
  assert.equal(await js(`document.querySelector('#tree .proj').classList.contains('closed')`), true, 'project folds on click');
  await sleep(2300);
  assert.equal(await js(`document.querySelector('#tree .proj').classList.contains('closed')`), true, 'still folded after state pushes');
  await js(`document.querySelector('#tree .proj-head').click()`);
  assert.equal(await js(`document.querySelector('#tree .proj').classList.contains('closed')`), false, 'unfolds again');

  // the deck is one chip; after a fork it shows depth and the tree drops down on hover
  assert.equal(await js(`document.querySelectorAll('#deck .stack').length`), 1, 'one chip');
  assert.equal(await js(`!!document.querySelector('#deck .stack-list')`), false, 'no tree with a single session');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['meta', 'shift'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: ['meta', 'shift'] });
  await until(() => js(`!document.querySelector('#modal').hidden && document.querySelector('#modal-title').textContent.includes('fork')`), 'fork prompt');
  await js(`(() => { const i = document.querySelector('#modal input'); i.value = 'dig into the slow build'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until(() => js(`document.querySelector('#deck .stack.deep')`), 'fork created');
  assert.match(await js(`document.querySelector('#deck .depth').textContent`), /⑂ 2\/2/, 'depth badge');
  assert.deepEqual(await js(`[...document.querySelectorAll('#deck .srow .label')].map((e) => e.textContent)`), ['alpha', 'dig into the slow build'], 'root first, then the fork');
  assert.equal(await js(`document.querySelector('#deck .srow.cur .label').textContent`), 'dig into the slow build');
  assert.equal(await js(`getComputedStyle(document.querySelector('#deck .stack-list')).maxHeight`), '0px', 'tree hidden until hover');
  const chip = await js(`(() => { const r = document.querySelector('#deck .card.top').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: chip.x, y: chip.y });
  await until(() => js(`getComputedStyle(document.querySelector('#deck .stack-list')).maxHeight !== '0px'`), 'hover unfolds the tree');
  await js(`document.querySelector('#deck .srow').click()`);
  await until(() => js(`document.querySelector('#deck .srow.cur .label').textContent === 'alpha'`), 'clicking the root brings it on top');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 600 });

  // ⌃1 starts the first agent profile (claude) in the focused worktree; the shell is not on a digit
  const slotsBefore = await js(`document.querySelectorAll('#tree .slot').length`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '1', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '1', modifiers: ['control'] });
  await until(() => js(`document.querySelectorAll('#tree .slot').length`).then((n) => n === slotsBefore + 1), '⌃1 opened a session');
  assert.equal(await js(`[...document.querySelectorAll('#tree .slot-title')].at(-1).textContent`), 'claude', '⌃1 is claude');
  await until(() => js(`[...document.querySelectorAll('.term .xterm-rows > div')].some((d) => d.textContent.includes('FAKE_CLAUDE_RAN'))`), 'claude found through the PATH that .zshrc sets');

  // a second after start, everything known gets linked: app.json entries, Superset repos and worktrees
  await until(() => linkOf('alpha') === alpha, 'startup scan links app.json workspaces');
  assert.equal(linkOf('acme'), fs.realpathSync(acme), 'Superset repo linked under its name');
  assert.equal(linkOf('acme@feature'), fs.realpathSync(feature), 'worktree linked as repo@folder');
  assert.equal(config().autoSymlink, true, 'setting defaults to on');

  // adding a folder links it; a second folder with the same name gets a suffix; adding twice makes no second link
  await js(`synapse.project.add(${JSON.stringify(beta)})`);
  assert.equal(linkOf('beta'), beta);
  await js(`synapse.project.add(${JSON.stringify(beta2)})`);
  assert.equal(linkOf('beta-2'), beta2, 'name clash gets -2');
  await js(`synapse.project.add(${JSON.stringify(beta)})`);
  assert.equal(fs.readdirSync(lib).filter((n) => n.startsWith('beta')).length, 2, 'no duplicate link for the same target');

  // an older link to the same place is renamed rather than doubled
  fs.symlinkSync(epsilon, path.join(lib, 'eps-old'));
  await js(`synapse.project.add(${JSON.stringify(epsilon)})`);
  assert.equal(linkOf('epsilon'), epsilon, 'link renamed to the folder name');
  assert.equal(linkOf('eps-old'), null, 'old link gone');

  // the library lists real folders and links alike, resolved, and knows which are already added
  fs.mkdirSync(path.join(lib, 'delta'));
  fs.symlinkSync(path.join(fixture, 'nowhere'), path.join(lib, 'dangling'));
  const listed = await js(`synapse.project.library()`);
  assert.deepEqual(listed.map((w) => [w.name, w.added, w.link]), [
    ['acme', false, true], ['acme@feature', false, true], ['alpha', true, true], ['beta', true, true], ['beta-2', true, true], ['delta', false, false], ['epsilon', true, true],
  ]);
  assert.equal(listed[4].path, fs.realpathSync(beta2), 'paths come back resolved');

  // turning the setting off stops new links and the backfill; existing links stay
  assert.deepEqual(await js(`synapse.settings.set({ autoSymlink: false })`), { autoSymlink: false });
  await js(`synapse.project.add(${JSON.stringify(gamma)})`);
  assert.equal(linkOf('gamma'), null, 'no link while the setting is off');
  assert.equal(linkOf('alpha'), alpha, 'old links stay');
  assert.equal((await js(`synapse.settings.get()`)).autoSymlink, false);
  console.log('PASS library links and setting');

  // the + workspace modal opens on the library tab when it has entries, and picking an entry adds it
  await js(`document.querySelector('#add-project').click()`);
  await until(() => js(`!document.querySelector('#modal').hidden && document.querySelector('.modal .seg button.on')?.textContent === 'library'`), 'library tab');
  await until(() => js(`document.querySelectorAll('.modal .lib .opt').length === 7`), 'seven library rows');
  assert.deepEqual(await js(`[...document.querySelectorAll('.modal .seg button')].map(b => b.textContent)`), ['clone', 'open folder', 'new', 'library'], 'library is the last tab');
  assert.equal(await js(`document.activeElement === document.querySelector('.modal input[type=search]')`), true, 'search is focused');
  const search = (query) => js(`(() => { const i = document.querySelector('.modal input'); i.value = ${JSON.stringify(query)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const key = (key, shiftKey = false) => js(`document.querySelector('.modal input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, shiftKey: ${shiftKey}, bubbles: true }))`);
  const names = () => js(`[...document.querySelectorAll('.modal .lib .opt .k')].map(e => e.textContent)`);
  await search('  BeTA ');
  assert.deepEqual(await names(), ['beta', 'beta-2'], 'search ignores case and surrounding spaces');
  await key('ArrowUp');
  assert.equal(await js(`document.querySelector('.modal .lib .sel .k').textContent`), 'beta-2', 'arrows navigate filtered results');
  await search('other/beta');
  assert.deepEqual(await names(), ['beta-2'], 'search matches paths');
  await search('no-such-workspace');
  assert.deepEqual(await names(), []);
  assert.equal(await js(`document.querySelector('.modal .lib').textContent`), 'No matching workspaces.');
  await key('Enter');
  assert.equal(await js(`document.querySelector('#modal').hidden`), false, 'Enter with no results does nothing');
  await search('');
  assert.equal((await names()).length, 7, 'clearing search restores all entries');
  await key('Tab');
  assert.equal(await js(`document.querySelector('.modal .seg button.on').textContent`), 'clone', 'last tab wraps to first');
  assert.equal(await js(`document.querySelector('.modal input').type`), 'text');
  await key('Tab', true);
  assert.equal(await js(`document.querySelector('.modal .seg button.on').textContent`), 'library');
  await search('delta');
  await key('Enter');
  await until(() => config().workspaces.includes(fs.realpathSync(path.join(lib, 'delta'))), 'delta added from the library');
  await until(() => js(`document.querySelector('#modal').hidden`), 'modal closed');

  // settings modal: ⌘, opens it with the checkbox reflecting the stored value
  await js(`dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))`);
  await until(() => js(`!document.querySelector('#modal').hidden && document.querySelector('#modal-title').textContent === 'settings'`), 'settings modal');
  assert.equal(await js(`document.querySelector('#modal input[type=checkbox]').checked`), false);
  assert.ok((await js(`document.querySelector('#modal-body').textContent`)).includes('⌘T'), 'shortcuts are listed in settings');
  assert.deepEqual(errors, []);
  console.log('PASS library tab and settings modal');
  await js(`document.querySelector('#modal').hidden = true`);

  // right-click menus in the sidebar
  const rightClick = (sel) => js(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); const r = t.getBoundingClientRect(); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 })); })()`);
  const menuLabels = () => js(`[...document.querySelector('.menu:not(.menu-sub)').querySelectorAll(':scope > .menu-item > .menu-label')].map((e) => e.textContent)`);
  const clickItem = (label) => js(`[...document.querySelectorAll('.menu .menu-item')].find((e) => e.firstChild.textContent === ${JSON.stringify(label)}).click()`);
  await rightClick('.side-foot');
  assert.deepEqual(await menuLabels(), ['New workspace'], 'empty pane: new workspace');
  await clickItem('New workspace');
  await until(() => js(`!document.querySelector('#modal').hidden && document.querySelector('#modal-title').textContent === 'add workspace'`), 'workspace modal from the menu');
  await js(`document.querySelector('#modal').hidden = true`);
  await rightClick('#tree .wt-head');
  assert.deepEqual(await menuLabels(), ['New agent', 'New worktree', 'Remove from sidebar'], 'the repo folder itself cannot be removed as a worktree');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await until(() => js(`!document.querySelector('.menu')`), 'escape closes the menu');
  await rightClick('#tree .slot');
  assert.deepEqual(await menuLabels(), ['Fork', 'Close session']);
  await clickItem('Close session');
  await until(() => js(`!document.querySelector('#modal').hidden && document.querySelector('#modal-title').textContent === 'sure?'`), 'closing asks first');
  assert.equal(await js(`document.querySelector('#modal .btn.danger').textContent`), 'Close', 'clean folder: plain confirm');
  await js(`document.querySelector('#modal').hidden = true`);

  // a dirty worktree: the question names the uncommitted changes and the button says "anyway"; confirming deletes it
  await js(`synapse.project.add(${JSON.stringify(feature)})`);
  fs.writeFileSync(path.join(feature, 'wip.txt'), 'not committed');
  await until(() => js(`[...document.querySelectorAll('.proj.closed .proj-head')].forEach(e => e.click()); [...document.querySelectorAll('#tree .wt')].some((w) => w.dataset.path === ${JSON.stringify(fs.realpathSync(feature))})`), 'feature worktree in the sidebar');
  await js(`(() => { const w = [...document.querySelectorAll('#tree .wt')].find((w) => w.dataset.path === ${JSON.stringify(fs.realpathSync(feature))}); const t = w.querySelector('.wt-head'); const r = t.getBoundingClientRect(); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 })); })()`);
  assert.deepEqual(await menuLabels(), ['New agent', 'New worktree', 'Remove worktree', 'Remove from sidebar']);
  await clickItem('Remove worktree');
  await until(() => js(`!document.querySelector('#modal').hidden && document.querySelector('#modal .hint').textContent.includes('1 uncommitted change')`), 'dirty warning');
  assert.equal(await js(`document.querySelector('#modal .btn.danger').textContent`), 'Delete anyway');
  await js(`document.querySelector('#modal .btn.danger').click()`);
  await until(() => !fs.existsSync(feature), 'worktree folder removed');
  assert.ok(!config().workspaces.includes(feature), 'removed from configuration');
  assert.deepEqual(errors, []);
  console.log('PASS right-click menus, dirty check, worktree removal');
  await js(`document.querySelector('#modal').hidden = true`);

})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  app.once('will-quit', () => { fs.rmSync(fixture, { recursive: true, force: true }); app.exit(process.exitCode || 0); });
  app.quit();
});
