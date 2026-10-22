// Real pointer input in the GUI iframe; all projects, PTYs and activity data are isolated.
const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

if (typeof electron === 'string') {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-')));
  const state = path.join(fixture, 'state'); fs.mkdirSync(state);
  const repos = ['alpha', 'beta', 'gamma'].map((name) => path.join(fixture, name));
  for (const repo of repos) {
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=GUI Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  }
  const worktrees = ['feature-a', 'feature-b'].map((name) => path.join(fixture, name));
  for (const dir of worktrees) execFileSync('git', ['-C', repos[0], 'worktree', 'add', '-qb', path.basename(dir), dir]);
  fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [repos[0], ...worktrees, ...repos.slice(1)], autoSymlink: false, skipLogin: true, profiles: { shell: { command: 'cat', label: 'Shell' } } }));
  const session = (key, parent = null) => ({ key, kind: 'shell', title: key, parent });
  fs.writeFileSync(path.join(state, 'sessions.json'), JSON.stringify({ version: 1, slots: [
    { worktree: repos[0], top: 0, focused: true, sessions: [session('parent'), session('child-one', 0), session('grandchild', 1), session('child-two', 0)] },
    ...['second', 'third'].map((key) => ({ worktree: repos[0], top: 0, sessions: [session(key)] })),
    ...[...worktrees, ...repos.slice(1)].map((dir, i) => ({ worktree: dir, top: 0, sessions: [session(`checkout-${i}`)] })),
  ] }));
  fs.writeFileSync(path.join(state, 'workspace-ui.json'), JSON.stringify({ 'synapse-mode': 'signal', 'synapse-inspector': 'closed' }));
  let status = 0;
  for (const phase of ['save', 'restore']) {
    const result = spawnSync(electron, [__filename], { env: { ...process.env, SYNAPSE_GUI_FIXTURE: fixture, SYNAPSE_GUI_PHASE: phase }, stdio: 'inherit' });
    if (result.status !== 0) { status = result.status || 1; break; }
  }
  fs.rmSync(fixture, { recursive: true, force: true }); process.exit(status);
}

const { app, BrowserWindow } = electron;
const fixture = process.env.SYNAPSE_GUI_FIXTURE;
assert.ok(fixture);
const state = path.join(fixture, 'state'), repo = path.join(fixture, 'alpha');
for (const name of ['claude', 'codex', 'gh', 'user']) fs.mkdirSync(path.join(fixture, name), { recursive: true });
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_USER_DATA: path.join(fixture, 'electron'), SYNAPSE_USER_HOME: path.join(fixture, 'user'), SYNAPSE_DEMO: '1', SYNAPSE_DESKTOP_VIEW: 'gui', SYNAPSE_CLOUD: 'http://127.0.0.1:9', CLAUDE_CONFIG_DIR: path.join(fixture, 'claude'), CODEX_HOME: path.join(fixture, 'codex'), GH_CONFIG_DIR: path.join(fixture, 'gh'), SHELL: '/bin/sh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || ['SYNAPSE_DEBUG', 'GH_TOKEN', 'GITHUB_TOKEN'].includes(key)) delete process.env[key];
process.chdir(repo);
let win, gui, failed = false;
const errors = [], sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ui = (code) => gui.executeJavaScript(code, true).catch((e) => { throw new Error(`${code}: ${e.message}`); });
const native = (code) => win.webContents.executeJavaScript(code, true);
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(40); }
  throw new Error(`Timed out: ${label}`);
}
const rpc = (action, args = {}) => ui(`new Promise((resolve) => {
  const request = 'test-' + crypto.randomUUID();
  const receive = (e) => { if (e.source !== parent || e.data?.request !== request) return; removeEventListener('message', receive); resolve({ error: e.data.error, value: e.data.value }); };
  addEventListener('message', receive); parent.postMessage({ type: 'synapse:desktop-call', request, action: ${JSON.stringify(action)}, args: ${JSON.stringify(args)} }, '*');
})`).then((reply) => { if (reply.error) throw new Error(reply.error); return reply.value; });
const selector = (attribute, value) => `[${attribute}=${JSON.stringify(value)}]`;
const project = (key) => `.project-group${selector('data-project-key', key)}`;
const worktree = (dir) => `.worktree-group${selector('data-worktree-path', dir)}`;
const session = (key) => selector('data-agent', `desktop-${key}`);
const projectOrder = () => ui(`[...document.querySelectorAll('.project-group[data-sort-kind="project"]')].map((e) => e.dataset.projectKey)`);
const treeOrder = () => ui(`[...document.querySelector(${JSON.stringify(project(repo))}).querySelectorAll('.worktree-group')].map((e) => e.dataset.worktreePath)`);
const rootOrder = () => ui(`[...document.querySelector(${JSON.stringify(worktree(repo))}).querySelector('.worktree-sessions').children].map((e) => e.dataset.sortId)`);
const click = (s) => ui(`document.querySelector(${JSON.stringify(s)}).click()`);
const mouse = (type, x, y) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
async function rect(s) {
  const offset = await native(`(() => { const r = document.querySelector('#workspace-frame').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
  const r = await ui(`(() => { const r = document.querySelector(${JSON.stringify(s)}).getBoundingClientRect(); return { x: r.x, y: r.y, height: r.height, width: r.width, bottom: r.bottom }; })()`);
  return { ...r, x: r.x + offset.x, y: r.y + offset.y, bottom: r.bottom + offset.y };
}
async function drag(s, delta, hold) {
  await ui(`document.querySelector(${JSON.stringify(s)}).scrollIntoView({ block: 'nearest' })`);
  const r = await rect(s), x = r.x + r.width / 2, y = r.y + r.height / 2;
  await mouse('mousePressed', x, y);
  for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', x, y + delta * i / 12); await sleep(16); }
  assert.equal(await ui(`document.body.classList.contains('sidebar-sorting')`), true, `pointer input starts a drag: ${s}`);
  if (hold) await hold();
  await mouse('mouseReleased', x, y + delta);
  await until(() => ui(`!document.body.classList.contains('sidebar-sorting')`), 'drop completes');
}
async function reach(a, b) {
  return ui(`(() => { const a = document.querySelector(${JSON.stringify(a)}).getBoundingClientRect(), b = document.querySelector(${JSON.stringify(b)}).getBoundingClientRect(); return (b.top + b.bottom) / 2 - a.bottom + 8; })()`);
}

(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'window');
  win.setBounds({ width: 1400, height: 1000 }); win.show(); win.focus();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  win.webContents.debugger.attach('1.3');
  await until(() => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => ui(`!!document.querySelector(${JSON.stringify(session('grandchild'))})`), 'restored hierarchy');
  const expectedFile = path.join(fixture, 'expected.json');
  if (process.env.SYNAPSE_GUI_PHASE === 'restore') {
    const expected = JSON.parse(fs.readFileSync(expectedFile));
    assert.deepEqual(await projectOrder(), expected.projects);
    assert.deepEqual(await treeOrder(), expected.worktrees);
    assert.deepEqual(await rootOrder(), expected.sessions);
    await click(project(repo) + ' .project-button');
    if (await ui(`document.querySelector(${JSON.stringify(worktree(repo) + ' .worktree-button')}).getAttribute('aria-expanded') === 'false'`)) await click(worktree(repo) + ' .worktree-button');
    await click(session('parent'));
    assert.equal(await ui(`document.querySelector('#message-input').value`), 'Keep this draft while dragging');
    assert.equal(await ui(`document.querySelector(${JSON.stringify(session('grandchild'))}).closest('.session-node').dataset.depth`), '2');
    assert.deepEqual(await ui(`[...document.querySelector(${JSON.stringify(session('parent'))}).nextElementSibling.children].map((e) => e.dataset.sortId)`), ['desktop-child-two', 'desktop-child-one']);
    console.log('PASS GUI order, fork topology, selection and drafts survive a restart');
    return;
  }
  const indents = await ui(`${JSON.stringify([project(repo) + ' .project-name', worktree(repo) + ' .worktree-name', ...['parent', 'child-one', 'grandchild'].map((id) => session(id) + ' .session-name')])}.map((s) => document.querySelector(s).getBoundingClientRect().left)`);
  for (let i = 1; i < indents.length; i++) assert.ok(indents[i] > indents[i - 1], `level ${i} is indented: ${indents}`);
  assert.equal(await ui(`document.querySelector(${JSON.stringify(session('checkout-0'))}).closest('.worktree-group').dataset.worktreePath`), path.join(fixture, 'feature-a'));
  console.log('PASS project → worktree → session → fork hierarchy has visible indentation');

  await click(session('parent'));
  await ui(`document.querySelector('#message-input').value = 'Keep this draft while dragging'; document.querySelector('#message-input').dispatchEvent(new Event('input', { bubbles: true }));`);
  const parentNode = session('parent') + ':not([hidden])';
  const first = `${worktree(repo)} .worktree-sessions > .session-node`;
  await ui(`window.draggedRow = document.querySelector(${JSON.stringify(parentNode)})`);
  await drag(parentNode, await reach(first, `${first}:nth-child(2)`), async () => {
    await sleep(1300);
    assert.equal(await ui(`window.draggedRow === document.querySelector(${JSON.stringify(parentNode)})`), true, 'state refresh preserves the dragged element');
  });
  assert.deepEqual((await rootOrder()).slice(0, 3), ['desktop-second', 'desktop-parent', 'desktop-third']);
  assert.equal(await ui(`document.querySelector('#message-input').value`), 'Keep this draft while dragging');
  assert.equal(await ui(`document.querySelector(${JSON.stringify(session('parent'))}).getAttribute('aria-current')`), 'page');
  console.log('PASS real pointer dragging reorders a session with its fork subtree without losing its draft or selection');

  const childOne = `${session('child-one')} .session-name`, childTwo = `${session('child-two')} .session-name`;
  const up = await ui(`(() => { const a = document.querySelector(${JSON.stringify(childTwo)}).closest('.session-node').getBoundingClientRect(), b = document.querySelector(${JSON.stringify(childOne)}).closest('.session-node').getBoundingClientRect(); return (b.top + b.bottom) / 2 - a.top - 8; })()`);
  // A busy renderer may not paint between the last pointer move and release.
  await ui(`window.savedAnimationFrame = window.requestAnimationFrame; window.requestAnimationFrame = () => 0`);
  try { await drag(session('child-two'), up); }
  finally { await ui(`window.requestAnimationFrame = window.savedAnimationFrame; delete window.savedAnimationFrame`); }
  const childrenOrder = () => ui(`[...document.querySelector(${JSON.stringify(session('parent'))}).nextElementSibling.children].map((e) => e.dataset.sortId)`);
  assert.deepEqual(await childrenOrder(), ['desktop-child-two', 'desktop-child-one']);
  for (const key of ['ArrowDown', 'ArrowUp']) {
    await ui(`document.querySelector(${JSON.stringify(session('child-two'))}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, altKey: true, bubbles: true }))`);
    await until(async () => (await childrenOrder())[0] === (key === 'ArrowDown' ? 'desktop-child-one' : 'desktop-child-two'), 'keyboard reordering');
  }
  const savedForks = JSON.parse(fs.readFileSync(path.join(state, 'sessions.json'))).slots.find((s) => s.sessions[0].key === 'parent').sessions;
  assert.equal(savedForks.find((s) => s.key === 'grandchild').parent, savedForks.findIndex((s) => s.key === 'child-one'));
  console.log('PASS fork sibling dragging and keyboard reordering preserve descendant ancestry');

  await click(worktree(repo) + ' .worktree-button');
  await drag(worktree(repo) + ' .worktree-button', await reach(worktree(repo), worktree(path.join(fixture, 'feature-a'))));
  assert.deepEqual((await treeOrder()).slice(0, 2), [path.join(fixture, 'feature-a'), repo]);
  for (const key of await projectOrder()) if (await ui(`document.querySelector(${JSON.stringify(project(key) + ' .project-button')}).getAttribute('aria-expanded') === 'true'`)) await click(project(key) + ' .project-button');
  const before = await projectOrder();
  await drag(project(before[0]) + ' .project-button', await reach(project(before[0]), project(before[1])));
  assert.deepEqual(await projectOrder(), [before[1], before[0], before[2]]);
  await sleep(1300);
  assert.deepEqual(await projectOrder(), [before[1], before[0], before[2]], 'project order survives discovery updates');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'app.json'))).projectOrder, await projectOrder());
  const label = await ui(`(() => { const e = document.querySelector(${JSON.stringify(project(repo) + ' .project-name')}); return { text: e.textContent, width: e.getBoundingClientRect().width }; })()`);
  assert.equal(label.text, 'alpha'); assert.ok(label.width > 16, 'project names remain visible after reordering');
  console.log('PASS worktree and project drags use the same saved order as Terminal mode');
  const cancelOrder = await projectOrder(), head = project(cancelOrder[0]) + ' .project-button';
  const cancelRect = await rect(head), cx = cancelRect.x + cancelRect.width / 2, cy = cancelRect.y + cancelRect.height / 2;
  const expanded = await ui(`document.querySelector(${JSON.stringify(head)}).getAttribute('aria-expanded')`);
  await mouse('mousePressed', cx, cy); await mouse('mouseMoved', cx, cy + 10);
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(250); await mouse('mouseReleased', cx, cy + 10); await sleep(100);
  assert.deepEqual(await projectOrder(), cancelOrder);
  assert.equal(await ui(`document.querySelector(${JSON.stringify(head)}).getAttribute('aria-expanded')`), expanded, 'Escape cancels without turning release into a fold click');
  await ui(`document.querySelector('#project-list').scrollTop = 0`);
  const edgeRect = await rect('#project-list'), sourceRect = await rect(head), ex = sourceRect.x + sourceRect.width / 2, ey = sourceRect.y + sourceRect.height / 2;
  await mouse('mousePressed', ex, ey); await mouse('mouseMoved', ex, edgeRect.bottom - 4); await sleep(350);
  assert.ok(await ui(`document.querySelector('#project-list').scrollTop > 20`), 'dragging near the list edge scrolls the sidebar');
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await mouse('mouseReleased', ex, edgeRect.bottom - 4); await sleep(200);
  assert.deepEqual(await projectOrder(), cancelOrder, 'cancelling after auto-scroll leaves order intact');
  console.log('PASS dragging auto-scrolls and Escape cancels without an accidental fold or reorder');
  await assert.rejects(rpc('reorder', { kind: 'session', from: 'desktop-parent', to: 'desktop-checkout-0', side: 'after' }), /same worktree/);

  await click('#desktop-activity');
  await until(() => ui(`!!document.querySelector('#activity-view .act-page')`), 'GUI activity data');
  assert.equal(await native(`document.querySelector('#mode-gui').getAttribute('aria-pressed')`), 'true');
  assert.equal(await native(`document.querySelector('#activity').hidden`), true, 'Terminal activity remains hidden');
  assert.equal(await native(`document.querySelector('.main').inert`), true, 'Terminal UI is inert while GUI is active');
  await sleep(1300);
  assert.equal(await ui(`document.querySelector('#activity-view').hidden`), false, 'state refresh does not navigate away from activity');
  await ui(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  assert.equal(await ui(`document.querySelector('#thread-view').hidden`), false);
  assert.equal(await ui(`document.querySelector('#message-input').value`), 'Keep this draft while dragging');
  console.log('PASS Activity opens and closes inside GUI without exposing Terminal UI or losing the draft');

  await click('.canvas-link');
  let canvas;
  await until(() => { canvas = gui.frames.find((f) => f.url.endsWith('/canvas')); return canvas; }, 'GUI canvas');
  await until(() => canvas.executeJavaScript(`!!document.querySelector('#c')`, true), 'canvas loaded');
  assert.equal(await native(`document.querySelector('#mode-gui').getAttribute('aria-pressed')`), 'true');
  assert.equal(await native(`document.querySelector('#canvas').hidden`), true, 'Terminal canvas remains hidden');
  await canvas.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`, true);
  await until(() => ui(`!document.querySelector('#thread-view').hidden`), 'canvas returns to GUI conversation');
  await click('#session-menu'); await click('[data-session-action="fork-tree"]');
  await until(() => native(`!document.querySelector('#fan').hidden`), 'GUI fork tree');
  assert.equal(await native(`document.querySelector('#mode-gui').getAttribute('aria-pressed')`), 'true');
  assert.equal(await native(`document.querySelectorAll('#fan .fcard').length`), 4);
  assert.ok(await native(`document.querySelector('#fan').getBoundingClientRect().top >= 48`), 'fork tree stays below the mode toolbar');
  await native(`document.querySelector('#fan-esc').click()`);
  console.log('PASS Canvas and fork tree stay in GUI mode with no Terminal UI exposed');

  const beforeSplit = (await rpc('state')).sessions;
  await click('#session-menu'); await click('[data-session-action="split"]');
  await until(() => ui(`!document.querySelector('#split-view').hidden && document.querySelectorAll('#split-view iframe').length === 2`), 'two GUI conversation panes');
  await until(() => gui.frames.filter((f) => f.url.includes('&pane=')).length === 2, 'pane frames');
  const parentPane = gui.frames.find((f) => f.url.includes('pane=pane-parent'));
  const otherPane = gui.frames.find((f) => f.url.includes('&pane=') && f !== parentPane);
  await until(() => parentPane.executeJavaScript(`document.body?.classList.contains('pane-mode') && !document.querySelector('#thread-view').hidden`, true), 'parent conversation pane ready');
  await until(() => otherPane.executeJavaScript(`document.body?.classList.contains('pane-mode') && !document.querySelector('#thread-view').hidden`, true), 'new conversation pane ready');
  assert.equal(await native(`document.querySelector('#mode-gui').getAttribute('aria-pressed')`), 'true');
  assert.equal(await parentPane.executeJavaScript(`document.querySelector('#message-input').value`, true), 'Keep this draft while dragging');
  assert.equal(await otherPane.executeJavaScript(`typeof window.synapse`, true), 'undefined', 'split panes have no native IPC');
  await otherPane.executeJavaScript(`document.querySelector('#message-input').focus(); document.querySelector('#message-input').value = 'Independent pane draft'; document.querySelector('#message-input').dispatchEvent(new Event('input', { bubbles: true }));`, true);
  await until(() => {
    const saved = JSON.parse(fs.readFileSync(path.join(state, 'workspace-ui.json')));
    return Object.values(JSON.parse(saved['synapse-drafts'] || '{}')).includes('Independent pane draft');
  }, 'independent pane draft saved');
  assert.equal(await parentPane.executeJavaScript(`document.querySelector('#message-input').value`, true), 'Keep this draft while dragging');
  const added = (await rpc('state')).sessions.find((s) => !beforeSplit.some((old) => old.id === s.id));
  if (process.env.SYNAPSE_GUI_SPLIT_SCREENSHOT) {
    await sleep(300); fs.writeFileSync(process.env.SYNAPSE_GUI_SPLIT_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  }
  await otherPane.executeJavaScript(`document.querySelector('#composer').requestSubmit()`, true);
  await until(async () => (await rpc('output', { id: added.id })).terminal.includes('Independent pane draft'), 'split prompt reaches its own PTY');
  await until(() => otherPane.executeJavaScript(`document.querySelector('#message-input').value === ''`, true), 'only the split pane draft clears');
  assert.equal(await parentPane.executeJavaScript(`document.querySelector('#message-input').value`, true), 'Keep this draft while dragging');
  await otherPane.executeJavaScript(`document.querySelector('#session-menu').click(); document.querySelector('[data-session-action="split-down"]').click()`, true);
  await until(() => ui(`document.querySelectorAll('#split-view iframe').length === 3 && !!document.querySelector('#split-view [data-direction="down"]')`), 'nested GUI split');
  const splitSessions = (await rpc('state')).sessions.filter((s) => !beforeSplit.some((old) => old.id === s.id));
  for (const added of splitSessions.reverse()) await rpc('close', { id: added.id });
  await until(() => ui(`document.querySelector('#split-view').hidden && !document.querySelector('#thread-view').hidden`), 'closing split panes restores one GUI conversation');
  await click(session('parent'));
  assert.equal(await ui(`document.querySelector('#message-input').value`), 'Keep this draft while dragging');
  console.log('PASS GUI splits render independent conversations and drafts, target their own PTYs, nest, and close without switching mode');

  fs.writeFileSync(expectedFile, JSON.stringify({ projects: await projectOrder(), worktrees: await treeOrder(), sessions: await rootOrder() }));
  if (process.env.SYNAPSE_GUI_SCREENSHOT) {
    await click(project(repo) + ' .project-button'); await click(worktree(repo) + ' .worktree-button');
    await ui(`document.querySelector(${JSON.stringify(project(repo))}).scrollIntoView({ block: 'start' })`);
    await sleep(300); fs.writeFileSync(process.env.SYNAPSE_GUI_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    await click(worktree(repo) + ' .worktree-button'); await click(project(repo) + ' .project-button');
  }
  await sleep(500);
  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy/.test(e)), []);
})().catch(async (e) => {
  failed = true; console.error(e);
  if (process.env.SYNAPSE_GUI_SCREENSHOT && win) fs.writeFileSync(process.env.SYNAPSE_GUI_SCREENSHOT + '.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => { app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit(); });
