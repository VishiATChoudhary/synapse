// Run with npm --prefix app run test:tabs. Real Electron UI, isolated repos and cat-backed sessions.
const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

if (typeof electron === 'string') {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-tabs-')));
  const result = spawnSync(electron, [__filename, '--demo'], { env: { ...process.env, SYNAPSE_TABS_FIXTURE: fixture }, stdio: 'inherit' });
  fs.rmSync(fixture, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const fixture = process.env.SYNAPSE_TABS_FIXTURE;
assert.ok(fixture);
const root = path.resolve(__dirname, '../..'), state = path.join(fixture, 'state');
const repo = path.join(fixture, 'alpha'), feature = path.join(fixture, 'feature');
fs.mkdirSync(repo); fs.mkdirSync(state);
const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' }).toString().trim();
git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'fixture');
git('worktree', 'add', '-q', '-b', 'feature', feature);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({
  autoSymlink: false, workspaces: [repo, feature],
  profiles: { shell: { command: 'cat', label: 'Shell' }, claude: { command: 'cat', label: 'Claude' }, codex: { command: 'cat', label: 'Codex' } },
}));
fs.mkdirSync(path.join(state, 'workspaces'));
fs.symlinkSync(repo, path.join(state, 'workspaces', 'alpha'));
fs.symlinkSync(feature, path.join(state, 'workspaces', 'alpha@feature'));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_DEMO: '1', SHELL: '/bin/sh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG') delete process.env[key];
process.chdir(repo);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(25); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true).catch((error) => { throw new Error(`${code}: ${error.message}`); });
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function doubleClick(selector, expression = false, clicks = [1, 2]) {
  const target = expression ? selector : `document.querySelector(${JSON.stringify(selector)})`;
  const point = await js(`(() => { const r = (${target}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const clickCount of clicks) {
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', ...point, clickCount });
    await sleep(50);
  }
}
const count = () => js(`document.querySelectorAll('.term').length`);
const title = () => js(`document.querySelector('#deck .card.top .label')?.textContent`);
async function saveName(name) {
  await until(() => js(`!!document.querySelector('.name-input')`), 'inline name editor');
  assert.equal(await js(`document.querySelector('#modal').hidden`), true, 'rename never opens a modal');
  await js(`document.querySelector('.name-input').value = ${JSON.stringify(name)}; document.querySelector('.name-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await until(() => js(`!document.querySelector('.name-input')`), 'rename saved');
}
async function launch(name) {
  await js(`[...document.querySelectorAll('.launch-item')].find(b => b.textContent === ${JSON.stringify(name)}).click()`);
  await until(async () => (await title()) === name.toLowerCase(), `launch ${name}`);
}

(async () => {
  const forkRequests = [];
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => handle(channel, channel === 'fork:spawn' ? (event, args) => { forkRequests.push(args); return fn(event, args); } : fn);
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  ipcMain.handle = handle;
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  win.webContents.debugger.attach('1.3');
  await until(async () => (await count()) === 5, 'demo fork tree');
  assert.deepEqual(await js(`[...document.querySelectorAll('#deck .label')].map(e => e.textContent)`), ['shell', 'why not just <= ?', 'how big is the clock skew in prod?', 'does refresh really skip validation?', 'where is the refresh handler?']);
  const menu = async (selector, label) => {
    await js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 350, clientY: 100 }))`);
    await js(`(() => { const row = [...document.querySelectorAll('.menu-item')].find(e => e.querySelector('.menu-label').textContent === ${JSON.stringify(label)}); if (!row) throw new Error('Missing action: ' + ${JSON.stringify(label)}); row.click(); })()`);
  };
  const cards = () => js(`document.querySelectorAll('#deck .card').length`);
  const rootId = await js(`document.querySelector('#deck .card').dataset.session`);
  const parent = `#deck .card[data-session="${rootId}"]`;
  const hoverPoint = await js(`(() => { const r = document.querySelector('#deck .card').getBoundingClientRect(); return { x: r.x + 50, y: r.y + 20 }; })()`);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPoint });
  await sleep(1200);
  assert.equal(await cards(), 5, 'hover and state refresh leave every tab visible');
  assert.equal(await js(`document.querySelector('.stack-list') === null && document.querySelector('#fan').hidden`), true, 'no hover overlay');
  await menu(parent, 'Collapse all children');
  assert.equal(await cards(), 1);
  assert.equal(await count(), 5, 'collapse does not close terminals');
  assert.equal(await js(`document.querySelector('#deck .card.top').dataset.session`), rootId, 'hidden active child returns to parent');
  await click(`${parent} .expand-children`);
  assert.equal(await cards(), 5);
  assert.equal(await js(`document.querySelector('.term.visible').contains(document.activeElement)`), true, 'expanding children returns keyboard focus to the terminal');
  await menu(parent, 'Collapse child: why not just <= ?');
  assert.equal(await cards(), 4);
  await sleep(1200);
  assert.equal(await cards(), 4, 'refresh preserves collapsed branches');
  await menu(parent, 'Expand child: why not just <= ?');
  assert.equal(await cards(), 5);
  await menu('#deck .card[title="does refresh really skip validation?"]', 'Collapse this child');
  assert.equal(await cards(), 3, 'collapsing one branch hides its descendants');
  await menu(parent, 'Expand all children');
  assert.equal(await cards(), 5);

  for (const question of ['first sibling', 'second sibling']) {
    await menu(parent, 'Fork child');
    // the question box is multiline: ⇧Enter keeps it open, Enter forks
    await js(`document.querySelector('#modal-body textarea').value = ${JSON.stringify(question)}; document.querySelector('#modal-body textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))`);
    assert.equal(await js(`document.querySelector('#modal').hidden`), false, 'shift+enter does not submit the fork');
    await js(`document.querySelector('#modal-body textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await until(() => js(`document.querySelector('#deck .card.top')?.title === ${JSON.stringify(question)}`), 'new sibling');
  }
  assert.equal(await count(), 7);
  if (process.env.SYNAPSE_BRANCH_SCREENSHOT) {
    await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    fs.writeFileSync(process.env.SYNAPSE_BRANCH_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  }
  assert.equal(forkRequests.at(-1).parentPty, forkRequests.at(-2).parentPty, 'repeated parent action creates siblings, not grandchildren');
  await click('#deck .card.top .tab-close');
  await click('#deck .card[title="first sibling"] .tab-close');
  assert.equal(await count(), 5);
  await js(`dispatchEvent(new KeyboardEvent('keydown', { key: 'e', metaKey: true }))`);
  assert.equal(await js(`document.querySelectorAll('.fcard').length`), 5);
  await menu(`#fan .fcard[data-session="${rootId}"]`, 'Collapse all children');
  assert.equal(await js(`document.querySelectorAll('.fcard').length`), 1);
  assert.equal(await cards(), 1, 'canvas collapse also updates tabs');
  await menu(`#fan .fcard[data-session="${rootId}"]`, 'Expand all children');
  assert.equal(await js(`document.querySelectorAll('.fcard').length`), 5);
  await click('#fan-esc');
  await click('#deck .card[title="where is the refresh handler?"]');
  console.log('PASS stable tabs, parent-targeted sibling forks, individual/all collapse and expand in tabs and fork canvas');
  await click('#deck .card.top .tab-close');
  await until(async () => (await count()) === 4, 'leaf closed with mouse');
  await click('#deck .card:first-child .tab-close');
  assert.equal(await js(`document.querySelector('#modal-title').textContent`), 'sure?');
  await click('#modal-body .btn:not(.danger)');
  assert.equal(await count(), 4, 'cancel preserves forks');
  await click('#deck .card:first-child .tab-close');
  await click('#modal-body .btn.danger');
  await until(async () => (await count()) === 0, 'root and fork branch closed');
  assert.equal(await js(`document.querySelector('#empty').hidden`), false);
  console.log('PASS close buttons, fork confirmation, last tab empty state');

  await launch('Claude'); await launch('Codex');
  assert.deepEqual(await js(`[...document.querySelectorAll('.slot-title')].map(e => e.textContent)`), ['claude', 'codex']);
  assert.equal(await js(`document.querySelectorAll('.rename-button').length`), 0, 'no pencil buttons');
  await doubleClick('#deck .card.top .label');
  if (process.env.SYNAPSE_INLINE_SCREENSHOT) {
    await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    fs.writeFileSync(process.env.SYNAPSE_INLINE_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  }
  await saveName('Backend review');
  assert.equal(await title(), 'Backend review');
  assert.equal(await js(`document.querySelector('.slot.focused .slot-title').textContent`), 'Backend review');
  await sleep(1100);
  assert.equal(await title(), 'Backend review', 'state refresh preserves custom tab name');
  await doubleClick('#tree .slot.focused .slot-title');
  await js(`document.querySelector('.name-input').value = 'discard'; document.querySelector('.name-input').setSelectionRange(2, 5)`);
  await sleep(1200);
  assert.deepEqual(await js(`(() => { const i = document.querySelector('.name-input'); return [i.value, i.selectionStart, i.selectionEnd, document.activeElement === i, document.querySelector('#modal').hidden]; })()`), ['discard', 2, 5, true, true], 'refresh preserves draft, selection and focus');
  await js(`document.querySelector('.name-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  assert.equal(await js(`document.querySelector('.name-input') === null`), true);
  assert.equal(await title(), 'Backend review', 'Cancel discards rename');
  await doubleClick('#deck .card.top .label'); await saveName('');
  assert.equal(await title(), 'codex', 'empty restores profile name');
  await doubleClick('#deck .card.top .label'); await saveName('<b>review</b>');
  assert.equal(await title(), '<b>review</b>');
  assert.equal(await js(`document.querySelector('#deck .label b') === null`), true, 'names remain plain text');
  await doubleClick('#deck .card.top .label'); await saveName('Backend review');
  await doubleClick('#deck .card.top .label');
  await js(`document.querySelector('.name-input').value = 'Saved on blur'`);
  await doubleClick('#tree .slot:not(.focused) .slot-title', false, [1]);
  await until(async () => (await title()) === 'claude', 'outside click still selects its tab');
  await until(() => js(`[...document.querySelectorAll('.slot-title')].some(e => e.textContent === 'Saved on blur')`), 'blur saves tab name');
  await doubleClick('#tree .slot:not(.focused) .slot-title', false, [1]);
  await doubleClick('#deck .card.top .label'); await saveName('Backend review');
  console.log('PASS agent names and inline rename, refresh, Enter, Escape, blur and reset');

  await js(`[...document.querySelectorAll('.proj.closed .proj-head')].forEach(e => e.click())`);
  await doubleClick(`[...document.querySelectorAll('.wt-name')].find(e => e.title.includes(${JSON.stringify(feature)}))`, true);
  await saveName('API checkout');
  await doubleClick(`[...document.querySelectorAll('.wt-head')].find(e => e.querySelector('.wt-name').title.startsWith(${JSON.stringify(repo + '\n')})).closest('.proj').querySelector('.proj-name')`, true);
  await saveName('Payments');
  const st = await js('synapse.state()'), project = st.projects.find(p => p.worktrees.some(w => w.path === repo));
  const worktree = st.projects.flatMap(p => p.worktrees).find(w => w.path === feature);
  assert.equal(project.label, 'Payments');
  assert.equal(worktree.name, 'API checkout');
  assert.equal(worktree.branch, 'feature');
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'projects.json')))[project.key], 'Payments');
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'app.json'))).worktreeNames[feature], 'API checkout');
  assert.ok(fs.existsSync(feature));
  assert.ok(git('worktree', 'list', '--porcelain').includes(feature));
  const library = await js('synapse.project.library()');
  assert.equal(library.find(w => w.path === repo).label, 'Payments');
  assert.equal(library.find(w => w.path === feature).label, 'API checkout');
  await js(`synapse.worktree.rename(${JSON.stringify(feature)}, '')`);
  assert.equal((await js('synapse.state()')).projects.flatMap(p => p.worktrees).find(w => w.path === feature).name, 'feature');
  await js(`synapse.worktree.rename(${JSON.stringify(feature)}, 'API checkout')`);
  assert.match(await js(`synapse.worktree.rename('/not-an-open-worktree', 'Bad').catch(e => e.message)`), /no longer open/);
  assert.match(await js(`synapse.project.rename('unknown', 'Bad').catch(e => e.message)`), /no longer open/);
  console.log('PASS persistent workspace/worktree aliases, library labels, unchanged Git paths');

  // Closing a background tab must not select it or close the foreground terminal.
  await js(`[...document.querySelectorAll('#tree .slot')].find(e => e.querySelector('.slot-title').textContent === 'claude').querySelector('.tab-close').click()`);
  assert.equal(await count(), 1);
  assert.equal(await title(), 'Backend review');
  await until(() => js(`document.querySelector('.term.visible')?.contains(document.activeElement)`), 'focus after background close');
  if (process.env.SYNAPSE_TABS_SCREENSHOT) fs.writeFileSync(process.env.SYNAPSE_TABS_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  await click('#deck .card.top .tab-close');
  assert.equal(await count(), 0);
  await launch('Claude');
  const press = async (keyCode, modifiers = ['meta']) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(150);
  };
  const panes = () => js(`[...document.querySelectorAll('.term.visible')].map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })`);
  const stageWidth = await js(`document.querySelector('#stage').clientWidth`);
  await press('b');
  assert.equal(await js(`document.querySelector('#toggle-sidebar').getAttribute('aria-expanded')`), 'false');
  assert.equal(await js(`localStorage.getItem('synapse-sidebar-collapsed')`), 'true');
  assert.ok(await js(`document.querySelector('#stage').clientWidth > ${stageWidth}`));
  assert.equal(await js(`getComputedStyle(document.querySelector('.main > .top')).paddingLeft`), '86px');
  await click('#toggle-sidebar');
  assert.equal(await js(`document.querySelector('#stage').clientWidth`), stageWidth);
  assert.equal(await js(`getComputedStyle(document.querySelector('#deck')).webkitAppRegion`), 'drag');
  assert.equal(await js(`getComputedStyle(document.querySelector('#deck .card')).webkitAppRegion`), 'no-drag');

  await press('d');
  await until(async () => (await panes()).length === 2, 'side-by-side split');
  let rects = await panes();
  assert.equal(rects[0].y, rects[1].y);
  assert.equal(rects[0].height, rects[1].height);
  assert.ok(Math.abs(rects[0].x + rects[0].width - rects[1].x) < 1);
  assert.equal(await title(), 'shell', 'splitting an agent opens a shell');
  // The configured shell profile is cat: split must bypass it and run the real shell.
  await win.webContents.insertText("printf 'split-%s\\n' shell-ok");
  await press('Enter', []);
  await until(() => js(`document.querySelector('.term.active').textContent.includes('split-shell-ok')`), 'plain shell executes commands');
  await press('d', ['meta', 'shift']);
  await until(async () => (await panes()).length === 3, 'nested top-and-bottom split');
  rects = await panes();
  assert.equal(rects[1].x, rects[2].x);
  assert.ok(Math.abs(rects[1].y + rects[1].height - rects[2].y) < 1);
  assert.ok(rects[0].height > rects[1].height);
  await doubleClick('.term.visible .xterm-screen', false, [1]);
  assert.equal(await title(), 'claude', 'clicking another pane focuses it');
  assert.equal((await panes()).length, 3, 'pane focus preserves the split');
  await press('t');
  await until(async () => (await count()) === 4 && (await panes()).length === 1, 'standalone shell');
  await press('w');
  await until(async () => (await panes()).length === 3, 'split restored after standalone close');
  await js(`[...document.querySelectorAll('.term.visible')].at(-1).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await press('w');
  await until(async () => (await panes()).length === 2, 'closing nested pane collapses its split');
  rects = await panes();
  assert.equal(rects[0].height, rects[1].height);
  win.setSize(1200, 800);
  await sleep(200);
  rects = await panes();
  assert.ok(Math.abs(rects[0].width - rects[1].width) < 1, 'window resize preserves split proportions');
  if (process.env.SYNAPSE_LAYOUT_SCREENSHOT) fs.writeFileSync(process.env.SYNAPSE_LAYOUT_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  ipcMain.removeHandler('pty:spawn');
  ipcMain.handle('pty:spawn', () => ({ ok: false, error: 'fixture spawn failure' }));
  const beforeFailure = await title();
  await press('d');
  await until(() => js(`document.querySelector('#toast').textContent === 'fixture spawn failure'`), 'failed split reported');
  assert.equal(await count(), 2, 'failed split leaves no terminal behind');
  assert.equal((await panes()).length, 2);
  assert.equal(await title(), beforeFailure, 'failed split restores focus');
  console.log('PASS sidebar, drag regions, shell split shortcuts, nested layouts, focus, close, resize and spawn failure');
  assert.deepEqual(errors, []);
  console.log('PASS background close and focus; tabs suite passed');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  app.once('will-quit', () => app.exit(process.exitCode || 0));
  app.quit();
});
