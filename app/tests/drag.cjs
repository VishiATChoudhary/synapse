// Run with npm --prefix app run test:drag. Real Electron UI: drag workspaces and agent rows in the sidebar.
const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

if (typeof electron === 'string') {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-drag-')));
  const result = spawnSync(electron, [__filename, '--demo'], { env: { ...process.env, SYNAPSE_DRAG_FIXTURE: fixture }, stdio: 'inherit' });
  fs.rmSync(fixture, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fixture = process.env.SYNAPSE_DRAG_FIXTURE;
assert.ok(fixture);
const root = path.resolve(__dirname, '../..'), state = path.join(fixture, 'state');
const repos = ['alpha', 'beta', 'gamma'].map((name) => path.join(fixture, name));
fs.mkdirSync(state); fs.mkdirSync(path.join(state, 'workspaces'));
for (const repo of repos) {
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' });
  git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'fixture');
  fs.symlinkSync(repo, path.join(state, 'workspaces', path.basename(repo)));
}
// alpha also has two worktrees, to sort among themselves
const trees = ['one', 'two'].map((name) => path.join(fixture, `alpha-${name}`));
for (const [i, dir] of trees.entries()) execFileSync('git', ['-C', repos[0], 'worktree', 'add', '-q', '-b', `b${i}`, dir], { stdio: 'pipe' });
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({
  autoSymlink: false, workspaces: [repos[0], ...trees, ...repos.slice(1)],
  profiles: { shell: { command: 'cat', label: 'Shell' }, claude: { command: 'cat', label: 'Claude' }, codex: { command: 'cat', label: 'Codex' } },
}));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_DEMO: '1', SHELL: '/bin/sh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG') delete process.env[key];
process.chdir(repos[0]);
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
const mouse = (type, x, y) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const center = (selector) => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const projects = () => js(`[...document.querySelectorAll('#tree .proj')].map(e => e.querySelector('.proj-name').textContent)`);
const slots = () => js(`[...document.querySelectorAll('#tree .slot')].map(e => e.dataset.slot)`);
const shot = async (name) => {
  if (!process.env.SYNAPSE_DRAG_SHOTS) return;
  fs.writeFileSync(path.join(process.env.SYNAPSE_DRAG_SHOTS, name), (await win.webContents.capturePage()).toPNG());
};
// press, travel in small steps (so it reads as a drag), and optionally hold before letting go
async function dragBy(selector, dy, { hold } = {}) {
  const p = await center(selector);
  await mouse('mousePressed', p.x, p.y);
  for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', p.x, p.y + (dy * i) / 12); await sleep(16); }
  await sleep(250);
  if (hold) await hold();
  await mouse('mouseReleased', p.x, p.y + dy);
  await sleep(300);
}

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  win.webContents.debugger.attach('1.3');
  await until(async () => (await projects()).length === 3, 'three workspaces');
  for (const name of ['Shell', 'Shell']) {
    const before = (await slots()).length;
    await js(`[...document.querySelectorAll('.launch-item')].find(b => b.textContent === ${JSON.stringify(name)}).click()`);
    await until(async () => (await slots()).length === before + 1, 'another agent row');
  }
  const order = await projects(), rows = await slots();
  assert.ok(rows.length >= 3, 'three agent rows to sort');

  // agent rows: lift the first, carry it past the second, neighbours make room with no drop rule drawn
  const h = await js(`document.querySelector('#tree .slot').getBoundingClientRect().height`);
  const focused = await js(`document.querySelector('#tree .slot.focused')?.dataset.slot`);
  await dragBy(`#tree .slot[data-slot="${rows[0]}"]`, h * 1.2, {
    hold: async () => {
      assert.equal(await js(`document.querySelectorAll('.drop-before, .drop-after').length`), 0, 'no drop rules');
      assert.equal(await js(`document.querySelector('#tree .slot.lifted')?.dataset.slot`), rows[0], 'the picked row is lifted');
      assert.match(await js(`document.querySelector('#tree .slot[data-slot="${rows[1]}"]').style.transform`), /translateY\(-/, 'its neighbour slides up');
      assert.equal(await js(`document.querySelector('#tree .slot[data-slot="${rows[2]}"]').style.transform`), '', 'rows further down stay put');
      await shot('slot-mid.png');
    },
  });
  assert.deepEqual((await slots()).slice(0, 3), [rows[1], rows[0], rows[2]], 'row lands where it was carried');
  assert.equal(await js(`document.querySelector('#tree .slot.focused')?.dataset.slot`), focused, 'letting go is not a click');
  assert.equal(await js(`document.querySelectorAll('.lifted, .yielding').length`), 0, 'nothing left lifted');

  // workspaces: carry the first box below the second
  const open = await js(`[...document.querySelectorAll('#tree .proj')].map(e => !e.classList.contains('closed'))`);
  // just far enough for the first box's bottom edge to pass the middle of the second
  const reach = await js(`(() => { const [a, b] = [...document.querySelectorAll('#tree .proj')].map(e => e.getBoundingClientRect()); return (b.top + b.bottom) / 2 - a.bottom + 8; })()`);
  await dragBy(`#tree .proj:first-child > .proj-head`, reach, {
    hold: async () => {
      assert.equal(await js(`document.querySelectorAll('.drop-before, .drop-after').length`), 0, 'no drop rules');
      assert.match(await js(`document.querySelectorAll('#tree .proj')[1].style.transform`), /translateY\(-/, 'the next workspace slides up');
      await shot('proj-mid.png');
    },
  });
  assert.deepEqual(await projects(), [order[1], order[0], order[2]], 'workspace lands where it was carried');
  assert.deepEqual(await js(`[...document.querySelectorAll('#tree .proj')].map(e => !e.classList.contains('closed'))`), [open[1], open[0], open[2]], 'letting go does not fold it');

  // worktrees: carry the first below the second; the order sticks in app.json
  const wts = () => js(`[...document.querySelectorAll('#tree .wt')].map(e => e.dataset.path)`);
  const before = await wts();
  assert.equal(before.length, 3, 'alpha shows its three checkouts');
  const reachWt = await js(`(() => { const [a, b] = [...document.querySelectorAll('#tree .wt')].map(e => e.getBoundingClientRect()); return (b.top + b.bottom) / 2 - a.bottom + 6; })()`);
  await dragBy(`#tree .wt > .wt-head`, reachWt, {
    hold: async () => {
      assert.match(await js(`document.querySelectorAll('#tree .wt')[1].style.transform`), /translateY\(-/, 'the next worktree slides up');
      await shot('wt-mid.png');
    },
  });
  assert.deepEqual(await wts(), [before[1], before[0], before[2]], 'worktree lands where it was carried');
  const saved = JSON.parse(fs.readFileSync(path.join(state, 'app.json'), 'utf8')).workspaces;
  assert.deepEqual(saved.filter((w) => before.includes(w)), [before[1], before[0], before[2]], 'order saved');
  await sleep(1200);
  assert.deepEqual(await wts(), [before[1], before[0], before[2]], 'order survives a state refresh');

  // folding slides the box shut, then it is folded
  const alpha = `#tree .proj[data-key="${await js(`document.querySelector('#tree .proj:not(.closed)').dataset.key`)}"]`;
  const tall = await js(`document.querySelector('${alpha}').getBoundingClientRect().height`);
  await js(`document.querySelector('${alpha} .proj-count').click()`);
  await sleep(90);
  const mid = await js(`document.querySelector('${alpha}').getBoundingClientRect().height`);
  assert.ok(mid > 1 && mid < tall, `mid-fold height ${mid} between 1 and ${tall}`);
  await sleep(300);
  assert.equal(await js(`document.querySelector('${alpha}').classList.contains('closed')`), true, 'folded');
  await js(`document.querySelector('${alpha} .proj-count').click()`);
  await sleep(90);
  const half = await js(`document.querySelector('${alpha}').getBoundingClientRect().height`);
  assert.ok(half > 1 && half < tall, `mid-unfold height ${half}`);
  await sleep(300);
  assert.equal(Math.round(await js(`document.querySelector('${alpha}').getBoundingClientRect().height`)), Math.round(tall), 'unfolded to full height');

  // escape mid-drag puts it back
  const now = await projects();
  const p = await center('#tree .proj:first-child > .proj-head');
  await mouse('mousePressed', p.x, p.y);
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', p.x, p.y + i * 20); await sleep(16); }
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  await mouse('mouseReleased', p.x, p.y + 160);
  await sleep(300);
  assert.deepEqual(await projects(), now, 'escape cancels');
  await shot('after.png');

  assert.deepEqual(errors, []);
  console.log('PASS sidebar drag: rows, worktrees and workspaces slide aside, folding animates, land where carried, no click on release, escape cancels');
  app.exit(0);
})().catch((error) => { console.error(error); app.exit(1); });
