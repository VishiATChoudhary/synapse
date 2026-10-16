// Real Electron/iframe regression test. All app state and PTYs belong to a temporary fixture.
// Run: npm --prefix app run test:navigation
const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// Remove the fixture only after Electron and its cache writers have exited.
if (typeof electron === 'string') {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-navigation-'));
  const result = spawnSync(electron, [__filename], { env: { ...process.env, SYNAPSE_NAV_FIXTURE: fixture }, stdio: 'inherit' });
  fs.rmSync(fixture, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const root = path.resolve(__dirname, '../..');
const fixture = process.env.SYNAPSE_NAV_FIXTURE;
assert.ok(fixture, 'run this test through npm run test:navigation');
const state = path.join(fixture, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], profiles: { shell: { command: 'cat', label: 'Shell' } } }));
process.env.SYNAPSE_HOME = state;
process.env.SYNAPSE_DEMO = '1';
process.env.SHELL = '/bin/sh';
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let server, standalone, win;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(25); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const canvas = () => win.webContents.mainFrame.frames.find((f) => f.url.startsWith('http://127.0.0.1:'));
const graph = (code) => canvas().executeJavaScript(code, true);
const hidden = async () => {
  await until(() => js(`document.querySelector('#canvas').hidden && history.state?.synapseView === 'terminal'`), 'terminal view');
  assert.equal(await js(`document.querySelector('#btn-canvas').classList.contains('on')`), false);
};
const focused = () => until(() => js(`document.querySelector('.term.visible')?.contains(document.activeElement)`), 'terminal focus');
async function open() {
  await click('#btn-canvas');
  await until(() => js(`!document.querySelector('#canvas').hidden && !document.querySelector('#canvas').classList.contains('loading')`), 'canvas view');
}
async function escape() {
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}
function shortcut(keyCode, modifier) {
  for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode, modifiers: [modifier] });
}
async function mouseButton(button, inFrame = false) {
  const point = await js(`(() => { const r = document.querySelector('${inFrame ? '#canvas-frame' : '#btn-canvas'}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button, ...point, clickCount: 1 });
}

(async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const url = `http://127.0.0.1:${port}/`;
  server = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), NO_OPEN: '1' }, stdio: 'ignore',
  });
  await until(async () => { try { return (await fetch(url)).ok; } catch { return false; } }, 'fixture server');
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  let startup = () => Promise.resolve({ ok: false, error: 'fixture startup failure' });
  ipcMain.removeHandler('canvas');
  ipcMain.handle('canvas', () => startup());
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  win.webContents.debugger.attach('1.3');
  await until(() => js(`!!document.querySelector('.term.visible .xterm-helper-textarea')`), 'first session');

  await click('#btn-canvas');
  await until(() => js(`document.querySelector('#toast').textContent === 'fixture startup failure'`), 'startup failure');
  await hidden(); await focused();

  let resolveStartup, requests = 0;
  startup = () => { requests++; return new Promise((resolve) => { resolveStartup = resolve; }); };
  await click('#btn-canvas');
  await until(() => resolveStartup, 'delayed startup');
  await click('#deck .card');
  await hidden(); await focused();
  // Reopening during a pending history.back must serialize; startup is still shared.
  await js(`document.querySelector('#btn-canvas').click(); document.querySelector('#btn-canvas').click(); document.querySelector('#btn-canvas').click()`);
  await until(() => js(`!document.querySelector('#canvas').hidden`), 'rapid reopen');
  await click('#deck .card'); await hidden();
  resolveStartup({ ok: true, value: url });
  await until(() => canvas()?.url === url, 'iframe loaded');
  await until(() => graph(`typeof agents !== 'undefined' && agents.size > 0`), 'graph state');
  assert.equal(requests, 1, 'deduplicate startup');
  await hidden(); await focused();
  console.log('PASS startup failure, delayed close, rapid reopen, shared startup');

  const historyLength = await js('history.length');
  for (let i = 0; i < 3; i++) { await open(); await click('#deck .card'); await hidden(); await focused(); }
  assert.equal(await js('history.length'), historyLength, 'no duplicate history entries');
  await open(); await click('#btn-canvas'); await hidden(); await focused();
  await open(); await click('#tree .slot'); await hidden(); await focused();
  await open(); await click('#tree .wt-head'); await hidden(); await focused();
  await click('#launch .launch-item');
  await until(() => js(`document.querySelectorAll('.term').length === 2`), 'second session');
  await open(); await click('#tree .slot'); await hidden(); await focused();
  assert.equal(await js(`document.querySelectorAll('.term')[0].classList.contains('visible')`), true);
  await open();
  await graph(`dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true }))`);
  await hidden(); await focused();
  assert.equal(await js(`document.querySelectorAll('.term')[1].classList.contains('visible')`), true);
  console.log('PASS same/different session selection, worktree selection, shortcut, toggle');

  await open(); await graph(`document.querySelector('#q').focus()`); await escape(); await hidden(); await focused();
  await open(); await graph(`document.activeElement.blur()`); await escape(); await hidden(); await focused();
  await open();
  await graph(`(async () => { selected = { type: 'node', id: [...agents.keys()][0] }; await renderPanel(true); startRename(); document.querySelector('input.rename').value = 'must not save'; })()`);
  await escape(); await hidden(); await focused();
  assert.equal(await graph(`!!document.querySelector('input.rename')`), false);
  assert.equal(await graph(`[...agents.values()].some(n => n.a.name === 'must not save')`), false);
  await open();
  await graph(`startProjectRename(groupRects()[0].key); document.querySelector('.frame-rename').value = 'must not save';`);
  await escape(); await hidden();
  assert.equal(await graph(`!!document.querySelector('.frame-rename')`), false);
  // Escape in the terminal remains terminal input.
  await focused(); await escape(); await hidden();
  console.log('PASS Escape in graph/search/rename and terminal');

  await open();
  win.webContents.navigationHistory.goBack(); await hidden(); await focused();
  win.webContents.navigationHistory.goForward();
  await until(() => js(`!document.querySelector('#canvas').hidden`), 'Forward');
  win.emit('app-command', {}, 'browser-backward');
  win.emit('app-command', {}, 'browser-backward');
  await hidden(); await focused();
  win.emit('app-command', {}, 'browser-forward');
  await until(() => js(`!document.querySelector('#canvas').hidden`), 'native Forward');
  await mouseButton('back', true);
  await hidden(); await focused();
  await mouseButton('forward');
  await until(() => js(`!document.querySelector('#canvas').hidden`), 'mouse Forward');
  await mouseButton('back');
  await hidden();
  console.log('PASS browser history, native Back/Forward, mouse buttons');

  shortcut('G', 'meta');
  await until(() => js(`!document.querySelector('#canvas').hidden`), 'Command-G open');
  shortcut('G', 'meta'); await hidden();
  shortcut('Tab', 'control');
  await until(() => js(`!document.querySelector('#canvas').hidden`), 'Control-Tab open');
  shortcut('Tab', 'control'); await hidden();
  await open(); await click('#add-project');
  await until(() => js(`!document.querySelector('#modal').hidden`), 'modal');
  await escape();
  assert.equal(await js(`document.querySelector('#modal').hidden`), true);
  assert.equal(await js(`document.querySelector('#canvas').hidden`), false, 'modal gets first Escape');
  await escape(); await hidden();
  console.log('PASS existing toggles and modal Escape priority');

  await open();
  await js(`dispatchEvent(new MessageEvent('message', { data: { type: 'synapse:close' }, origin: 'https://wrong.example', source: document.querySelector('#canvas-frame').contentWindow }))`);
  assert.equal(await js(`document.querySelector('#canvas').hidden`), false, 'reject wrong origin');
  await click('#deck .card'); await hidden();
  // Closing a selected session while the canvas is open must leave a valid return target.
  await open();
  await js(`dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true }))`);
  await until(() => js(`document.querySelectorAll('.term').length === 1`), 'selected session closed');
  await escape(); await hidden(); await focused();
  // Close the remaining fixture session, then verify Escape with no terminal to focus.
  await js(`dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true }))`);
  await until(() => js(`document.querySelectorAll('.term').length === 0`), 'sessions closed');
  await open(); await escape(); await hidden();
  assert.equal(await js(`document.querySelector('#empty').hidden`), false);

  standalone = new BrowserWindow({ show: false });
  await standalone.loadURL(url);
  await standalone.webContents.executeJavaScript(`document.querySelector('#q').value = 'claude'; document.querySelector('#q').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
  assert.equal(await standalone.webContents.executeJavaScript(`document.querySelector('#q').value`), '');
  // Exercise the standalone canvas with an explicit fork tree, without changing server state.
  const graphCheck = (code) => standalone.webContents.executeJavaScript(code, true).catch((error) => { throw new Error(`${code}: ${error.message}`); });
  await until(() => graphCheck('agents.size > 0'), 'standalone graph state');
  await graphCheck(`es.close(); (() => {
    const base = [...agents.values()][0].a;
    agents.clear();
    applyState({ agents: [
      { ...base, id: 'parent', name: 'Parent', forkOf: null },
      { ...base, id: 'child-a', name: 'Child A', forkOf: 'parent' },
      { ...base, id: 'child-b', name: 'Child B', forkOf: 'parent' },
      { ...base, id: 'grandchild', name: 'Grandchild', forkOf: 'child-a' }
    ], edges: [{ id: 'link', from: 'parent', to: 'grandchild' }], layout: {} });
    let i = 0; for (const n of agents.values()) { n.x = i++ * 400; n.y = 0; }
  })()`);
  const visibility = () => graphCheck(`[...agents].filter(([, n]) => !n.hidden).map(([id]) => id)`);
  const graphMenu = async (label) => {
    await graphCheck(`(() => { const n = agents.get('parent'); cv.dispatchEvent(new MouseEvent('contextmenu', { clientX: n.x * cam.k + cam.x, clientY: n.y * cam.k + cam.y, bubbles: true })); })()`);
    await graphCheck(`(() => { const item = [...document.querySelectorAll('.cmenu > div')].find(e => e.textContent === ${JSON.stringify(label)}); if (!item) throw new Error('missing canvas action'); item.click(); })()`);
  };
  await graphMenu('Collapse child: Child A');
  assert.deepEqual(await visibility(), ['parent', 'child-b']);
  assert.equal(await graphCheck(`edgeGeom(edges[0]) === null`), true, 'hidden node links do not render');
  assert.equal(await graphCheck(`hitTest(agents.get('grandchild').x, agents.get('grandchild').y)?.id === 'grandchild'`), false, 'hidden nodes cannot capture clicks');
  assert.equal(await graphCheck(`[...projectGroups().values()].reduce((n, g) => n + g.nodes.length, 0)`), 2);
  await graphMenu('Expand child: Child A');
  assert.equal((await visibility()).length, 4);
  await graphMenu('Collapse all children');
  assert.deepEqual(await visibility(), ['parent']);
  assert.equal(await graphCheck('agents.size'), 4, 'collapsing preserves agents');
  await graphMenu('Expand all children');
  assert.equal((await visibility()).length, 4);
  await graphCheck(`doAction({ action: 'session-visibility', hidden: ['child-a', 'grandchild'] })`);
  assert.deepEqual(await visibility(), ['parent', 'child-b'], 'app collapse updates canvas visibility');
  await graphCheck(`doAction({ action: 'session-visibility', hidden: [] })`);
  assert.equal((await visibility()).length, 4);
  await graphCheck(`hover = { type: 'node', id: 'parent' }; doAction({ action: 'session-visibility', hidden: [] })`);
  assert.equal(await graphCheck('hover?.id'), 'parent', 'visibility refresh preserves hover on visible nodes');
  console.log('PASS node canvas child/all collapse, expand, hidden links/hit testing and app visibility sync');
  assert.deepEqual(errors, []);
  console.log('PASS origin validation, empty state, standalone canvas; navigation suite passed');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  standalone?.destroy();
  server?.kill();
  // Main's normal quit handler terminates only this fixture's PTYs.
  app.once('will-quit', () => app.exit(process.exitCode || 0));
  app.quit();
});
