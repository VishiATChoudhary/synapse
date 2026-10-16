// Real Electron regression test for the fork stack in the deck. Runs the app in demo mode, which builds a
// ready-made tree of four shell forks on start-up, so no agent is needed.
// All app state and PTYs belong to a temporary fixture.
// Run: npm --prefix app run test:stack
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-library-'));
const state = path.join(fixture, 'state');
const lib = path.join(state, 'workspaces');
const dir = (...p) => { const d = path.join(fixture, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const alpha = dir('code', 'alpha'), beta = dir('code', 'beta'), beta2 = dir('other', 'beta'), gamma = dir('code', 'gamma'), epsilon = dir('code', 'epsilon');
fs.mkdirSync(state);
// a Superset-style layout: a repo in projects/ with a worktree in worktrees/<repo>/<branch>
const superset = dir('superset'), acme = dir('superset', 'projects', 'acme'), feature = path.join(superset, 'worktrees', 'acme', 'feature');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
git(acme, 'init', '-q'); git(acme, 'commit', '-q', '--allow-empty', '-m', 'init');
fs.mkdirSync(path.dirname(feature), { recursive: true }); git(acme, 'worktree', 'add', '-q', '-b', 'feature', feature);
process.env.SUPERSET_HOME = superset;
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [alpha], profiles: { shell: { command: 'cat', label: 'Shell' }, claude: { command: 'cat', label: 'Claude Code' } } }));
process.env.SYNAPSE_HOME = state;
process.env.SYNAPSE_DEMO = '1';
process.env.SHELL = '/bin/sh';
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
const js = (code) => win.webContents.executeJavaScript(code, true);
const linkOf = (name) => { try { return fs.readlinkSync(path.join(lib, name)); } catch { return null; } };
const config = () => JSON.parse(fs.readFileSync(path.join(state, 'app.json'), 'utf8'));

process.argv.push('--demo');

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  await until(() => js(`document.querySelectorAll('.term').length === 5`), 'demo tree of five sessions');
  await until(() => js(`!!document.querySelector('#deck .stack.deep')`), 'stack chip');

  // one chip: the session on top, with depth / size of the tree
  assert.equal(await js(`document.querySelectorAll('#deck .card').length`), 1, 'one chip, no row of cards');
  assert.equal(await js(`document.querySelector('#deck .card.top .label').textContent`), 'where is the refresh handler?');
  assert.equal(await js(`document.querySelector('#deck .depth').textContent`), '⑂ 3/5');

  // the tree beneath: root first, each generation indented, the path marked, the top highlighted
  const labels = () => js(`[...document.querySelectorAll('#deck .srow .label')].map((e) => e.textContent)`);
  assert.deepEqual(await labels(), ['alpha', 'why not just <= ?', 'how big is the clock skew in prod?', 'does refresh really skip validation?', 'where is the refresh handler?']);
  assert.deepEqual(await js(`[...document.querySelectorAll('#deck .srow')].map((e) => parseInt(e.style.paddingLeft))`), [14, 32, 32, 32, 50], 'indent by generation');
  assert.deepEqual(await js(`[...document.querySelectorAll('#deck .srow')].map((e) => e.classList.contains('on-path'))`), [true, false, false, true, true]);
  assert.equal(await js(`document.querySelector('#deck .srow.cur .label').textContent`), 'where is the refresh handler?');

  // hidden until the chip is hovered; a click on a row switches
  assert.equal(await js(`getComputedStyle(document.querySelector('#deck .stack-list')).maxHeight`), '0px', 'tree hidden until hover');
  const chip = await js(`(() => { const r = document.querySelector('#deck .card.top').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: chip.x, y: chip.y });
  await until(() => js(`getComputedStyle(document.querySelector('#deck .stack-list')).maxHeight !== '0px'`), 'hover unfolds the tree');
  await js(`[...document.querySelectorAll('#deck .srow')].find((e) => e.textContent.includes('clock skew')).click()`);
  await until(() => js(`document.querySelector('#deck .card.top .label').textContent === 'how big is the clock skew in prod?'`), 'row click brings that session on top');
  assert.equal(await js(`document.querySelector('#deck .depth').textContent`), '⑂ 2/5');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 700, y: 600 });

  // ⇧⌘F still forks from the one on top
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['meta', 'shift'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: ['meta', 'shift'] });
  await until(() => js(`!document.querySelector('#modal').hidden`), 'fork prompt');
  await js(`(() => { const i = document.querySelector('#modal input'); i.value = 'measure it'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until(() => js(`document.querySelectorAll('.term').length === 6`), 'sixth session');
  assert.equal(await js(`document.querySelector('#deck .depth').textContent`), '⑂ 3/6');

  // the fork's pty has the rows the view shows, like any other session (it used to start at the 120x36 default)
  const viewRows = await js(`document.querySelector('.term.visible .xterm-rows').children.length`);
  await sleep(800);
  await js(`document.querySelector('.term.visible .xterm-helper-textarea').focus()`);
  for (const ch of 'stty size; echo SIZE_DONE\r') win.webContents.sendInputEvent(ch === '\r' ? { type: 'keyDown', keyCode: 'Return' } : { type: 'char', keyCode: ch });
  await until(() => js(`[...document.querySelectorAll('.term.visible .xterm-rows > div')].some((d) => d.textContent.trim().startsWith('SIZE_DONE'))`), 'stty answered');
  const stty = await js(`(() => { const t = [...document.querySelectorAll('.term.visible .xterm-rows > div')].map((d) => d.textContent.trim()); const i = t.findIndex((l) => l.startsWith('SIZE_DONE')); return t.slice(0, i).reverse().find((l) => /^[0-9]+ [0-9]+$/.test(l)); })()`);
  const tail = await js(`[...document.querySelectorAll('.term.visible .xterm-rows > div')].map((d) => d.textContent.trim()).filter(Boolean).slice(-6)`);
  assert.equal(Number(stty?.split(' ')[0]), viewRows, `fork pty rows ${stty} vs view rows ${viewRows}; screen tail: ${JSON.stringify(tail)}`);
  assert.deepEqual(errors, []);
  console.log('PASS fork stack');
})().catch((error) => { console.error(error, JSON.stringify(errors)); process.exitCode = 1; }).finally(() => {
  app.once('will-quit', () => { fs.rmSync(fixture, { recursive: true, force: true }); app.exit(process.exitCode || 0); });
  app.quit();
});
