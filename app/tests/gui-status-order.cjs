// Real Electron test for the Status view's order. Two stand-in "claude"s print output nonstop (their activity time
// changes all the time) and take their state from a control file. Rows must keep their order while nothing changes,
// and an agent whose state changes goes to the top of its new group, sliding there.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-status-order.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-status-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), claudeHome = path.join(fixture, 'claude'), ctl = path.join(fixture, 'ctl');
for (const d of [state, bin, ctl, path.join(claudeHome, 'sessions')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
let slot = 0; for (;; slot++) { try { fs.writeFileSync(path.join(${JSON.stringify(ctl)}, 'slot-' + slot), String(process.pid), { flag: 'wx' }); break; } catch {} }
const file = path.join(${JSON.stringify(path.join(claudeHome, 'sessions'))}, process.pid + '.json');
const control = path.join(${JSON.stringify(ctl)}, 'state-' + slot);
let status = '';
const tick = () => {
  let want = 'busy'; try { want = fs.readFileSync(control, 'utf8').trim() || 'busy'; } catch {}
  if (want !== status) { status = want; fs.writeFileSync(file, JSON.stringify({ sessionId: 'stand-in-' + process.pid, pid: process.pid, cwd: process.cwd(), status, startedAt: Date.now(), updatedAt: Date.now() })); }
  process.stdout.write('agent ' + slot + ' working ' + Date.now() + '\\r\\n');
};
tick(); setInterval(tick, 250);
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { claude: { command: `exec ${path.join(bin, 'claude')}`, label: 'Claude' } } }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLAUDE_HOME: claudeHome, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win, gui, failed = false;
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const ui = (code) => gui.executeJavaScript(code, true);
const native = (code) => win.webContents.executeJavaScript(code, true);
const pidOf = (slot) => fs.readFileSync(path.join(ctl, `slot-${slot}`), 'utf8').trim();
const set = (slot, status) => fs.writeFileSync(path.join(ctl, `state-${slot}`), status);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  for (let i = 0; i < 3; i++) {
    await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Claude').click()`);
    await until(() => fs.existsSync(path.join(ctl, `slot-${i}`)), `agent ${i} started`);
    await sleep(400);
  }
  // group by status (the Group menu's choice, stored like the menu stores it)
  await ui(`document.querySelector('#group-by').click(); true`);
  await ui(`[...document.querySelectorAll('.pop-menu button')].find((b) => b.textContent === 'Group by status').click(); true`);
  await until(() => ui(`document.querySelector('#project-list').dataset.group === 'status'`), 'status grouping');
  await until(() => ui(`document.querySelectorAll('.session-row[data-state="working"]').length === 3`), 'three working rows');
  const order = () => ui(`[...document.querySelectorAll('.session-row[data-state="working"]')].map((r) => r.dataset.agent)`);
  const pids = await ui(`[...document.querySelectorAll('.session-row[data-state="working"]')].length`);
  assert.equal(pids, 3);

  // wait for the sessions to finish registering (an id settles once Synapse has matched the terminal to its agent)
  let ids = '', since = Date.now();
  await until(async () => { const now = JSON.stringify((await order()).slice().sort()); if (now !== ids) { ids = now; since = Date.now(); } return Date.now() - since > 2500; }, 'ids settle', 40000);
  // nonstop output for 4 s: the order never changes
  const first = await order(), seen = new Set([JSON.stringify(first)]);
  for (let i = 0; i < 20; i++) { await sleep(200); seen.add(JSON.stringify(await order())); }
  assert.equal(seen.size, 1, `working rows reordered while nothing changed:\n${[...seen].join('\n')}`);
  console.log('PASS steady: 3 working agents printing output keep their order for 4 s');

  // the header's spinner for a working agent is drawn once and keeps turning, not restarted by each refresh
  await ui(`document.querySelector('.session-row[data-state="working"]').click()`);
  await until(() => ui(`!!document.querySelector('#session-status .status-dot.busy')`), 'the header spinner');
  await ui(`window.__spin = document.querySelector('#session-status .status-dot.busy'); true`);
  await new Promise((r) => setTimeout(r, 3500));
  assert.ok(await ui(`document.querySelector('#session-status .status-dot.busy') === window.__spin`), 'the header spinner was redrawn');
  console.log('PASS spinner: the working spinner in the header is not redrawn while its agent works');

  // the bottom working agent needs you: it gets its own group; then it goes back to work and lands on top, sliding up
  const bottom = first.at(-1);
  // find which slot the bottom row is: flip slots to waiting one by one until the bottom row changes state
  let slot = -1;
  for (let s = 0; s < 3 && slot < 0; s++) {
    set(s, 'waiting');
    await until(() => ui(`document.querySelectorAll('.session-row[data-state="needs"]').length === 1`), `slot ${s} needs you`);
    if (await ui(`document.querySelector('.session-row[data-state="needs"]').dataset.agent === ${JSON.stringify(bottom)}`)) slot = s;
    else { set(s, 'busy'); await until(() => ui(`document.querySelectorAll('.session-row[data-state="working"]').length === 3`), 'back to three working'); }
  }
  assert.ok(slot >= 0, 'found the bottom agent');
  const needsFirst = await ui(`[...document.querySelectorAll('#project-list .session-row')][0].dataset.state`);
  assert.equal(needsFirst, 'needs', 'Needs you is the top group');
  // it finishes (Done sits below Working), then starts again: it climbs past the other two to the top
  set(slot, 'idle');
  await until(() => ui(`document.querySelector('.session-row[data-agent=${JSON.stringify(bottom)}]')?.dataset.state === 'idle'`), 'it is idle');
  await sleep(600);
  await ui(`window.__moves = []; new MutationObserver((list) => { for (const m of list) if (m.target.classList?.contains('moving-up')) window.__moves.push(m.target.querySelector('.session-row')?.dataset.agent); }).observe(document.querySelector('#project-list'), { attributes: true, attributeFilter: ['class'], subtree: true }); true`);
  set(slot, 'busy');
  await until(async () => (await order())[0] === bottom, 'the re-triggered agent is on top of Working');
  await until(() => ui(`window.__moves.length > 0`), 'it slid up', 3000);
  const moved = await ui(`window.__moves`);
  assert.ok(moved.includes(bottom), `slid: ${moved}`);
  if (process.env.STATUS_SHOT) fs.writeFileSync(process.env.STATUS_SHOT, (await win.webContents.capturePage()).toPNG());
  console.log('PASS trigger: an agent that changes state goes to the top of its group, sliding up');

  // ⌘⇧S / ⌘⇧W: down and up the agent list as shown; the opened conversation eases in
  const rowsNow = () => ui(`[...document.querySelectorAll('#project-list .session-row')].filter((r) => r.offsetParent).map((r) => r.dataset.agent)`);
  const current = () => ui(`document.querySelector('#project-list .session-row[aria-current="page"]')?.dataset.agent || ''`);
  const press = (k) => ui(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))`);
  const list0 = await rowsNow();
  await ui(`document.querySelector('#project-list .session-row').click()`);
  await until(async () => (await current()) === list0[0], 'the first agent is open');
  await press('s');
  await until(async () => (await current()) === list0[1], '⌘⇧S opens the next agent');
  await press('s');
  await until(async () => (await current()) === list0[2], 'and the one after');
  await press('w');
  await until(async () => (await current()) === list0[1], '⌘⇧W goes back up');
  await until(() => ui(`document.getElementById('message-list').classList.contains('entering') || document.getElementById('message-list').dataset.shownFor !== ''`), 'the conversation is shown for the agent');
  console.log('PASS keys: ⌘⇧S and ⌘⇧W move down and up the agent list');
  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|net::ERR/.test(e)), []);
})().catch(async (e) => {
  failed = true; console.error(e);
  if (win) fs.writeFileSync('/tmp/gui-status.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => { app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit(); });
