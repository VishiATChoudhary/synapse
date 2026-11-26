// Real Electron test: the notification bell and toast stack. An agent you are not looking at finishing (or waiting for
// you) puts a toast on the stack; clicking it opens that agent and takes it off, x takes it off, the bell hides it.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-notifs.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-notifs-')));
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
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', (d) => fs.appendFileSync(path.join(${JSON.stringify(ctl)}, 'typed-' + slot), d.toString()));
tick(); setInterval(tick, 250);
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { claude: { command: `exec ${path.join(bin, 'claude')}`, label: 'Claude' } } }));
fs.writeFileSync(path.join(state, 'workspace-ui.json'), JSON.stringify({ 'synapse-group': 'status' }));
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
// the GUI frame is looked up on each call (a reload replaces it), and a call to a frame going away gives up
const ui = (code) => { const f = win.webContents.mainFrame.frames.find((x) => x.url.includes('?desktop=1')) || gui; return Promise.race([f.executeJavaScript(code, true), sleep(3000).then(() => { throw new Error('frame did not answer'); })]); };
const native = (code) => win.webContents.executeJavaScript(code, true);
const pidOf = (slot) => fs.readFileSync(path.join(ctl, `slot-${slot}`), 'utf8').trim();
const set = (slot, status) => fs.writeFileSync(path.join(ctl, `state-${slot}`), status);

const typed = () => { try { return fs.readFileSync(path.join(ctl, 'typed-0'), 'utf8'); } catch { return ''; } };
const send = (text) => ui(`(() => { const i = document.querySelector('#message-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); })()`);
const queue = () => ui(`[...document.querySelectorAll('#prompt-queue .queued-text')].map((e) => e.textContent)`);
const key = (k) => ui(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', metaKey: true, bubbles: true }))`);
const place = (id) => ui(`(() => { const r = document.querySelector('#project-list .session-row[data-agent="${id}"]'); if (!r) return null; const shelf = r.closest('[data-shelf]'); return shelf ? 'shelf:' + shelf.dataset.shelf : 'flat:' + r.closest('[data-flat]')?.dataset.flat; })()`);
const launch = async (slot) => {
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Claude').click()`);
  await until(() => fs.existsSync(path.join(ctl, `slot-${slot}`)), `agent ${slot} started`);
};
(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show(); win.focus();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  const ids = () => ui(`[...document.querySelectorAll('#project-list .session-row')].map((r) => r.dataset.agent)`);
  const fresh = async (slot) => {
    const before = await ids(); await launch(slot); set(slot, 'idle');
    let id; await until(async () => (id = (await ids()).find((x) => !before.includes(x))) && !(await ui(`!!document.querySelector('#project-list .session-row[data-agent="${id}"][data-state="working"]')`)), `agent ${slot} is free`);
    return id;
  };
  const toasts = () => ui(`[...document.querySelectorAll('#notif-stack .ntf-toast:not([data-leaving])')].map((t) => t.querySelector('.ntf-name').textContent + '|' + t.dataset.kind)`);
  const count = () => ui(`document.querySelector('#notif-count').textContent`);
  const first = await fresh(0), second = await fresh(1);
  await ui(`document.hasFocus = () => true`); // a test window may not get the OS focus; the app treats an unfocused window as not looking
  await ui(`document.querySelector('#project-list .session-row[data-agent="${second}"]').click()`);
  await until(() => ui(`location.hash === '#agent=${second}'`), 'looking at the second agent');
  const name = await ui(`document.querySelector('#project-list .session-row[data-agent="${first}"] .session-name')?.textContent.trim()`);
  assert.equal(await ui(`document.querySelector('#notif-stack').hidden`), true, 'no stack without notifications');
  // the first works and finishes while you look at the second: a toast
  set(0, 'busy'); await sleep(1500); set(0, 'idle');
  await until(async () => (await toasts()).length === 1, 'a done toast');
  assert.match((await toasts())[0], /\|done$/);
  assert.equal(await count(), '1');
  assert.equal(await ui(`document.querySelector('#notif-stack').hidden`), false);
  // the one you look at finishing: nothing
  set(1, 'busy'); await sleep(1500); set(1, 'idle'); await sleep(2000);
  assert.equal((await toasts()).length, 1, 'no toast for the agent on screen');
  // a new toast shows for a few seconds, then the stack goes away by itself
  await until(() => ui(`document.querySelector('#notif-stack').hidden`), 'stack hides by itself', 9000);
  assert.equal(await count(), '1', 'the count stays');
  // the bell shows the stack and hides it again
  await ui(`document.querySelector('#notif-bell').click()`);
  assert.equal(await ui(`document.querySelector('#notif-stack').hidden`), false, 'bell shows');
  await sleep(500);
  const place = await ui(`(() => { const s = document.querySelector('#notif-stack').getBoundingClientRect(), b = document.querySelector('#notif-bell'); return { right: innerWidth - s.right, top: s.top, inTopbar: !!b.closest('.topbar'), bellRight: innerWidth - b.getBoundingClientRect().right }; })()`);
  assert.ok(place.inTopbar && place.bellRight < 20, `bell at the top bar's right end: ${JSON.stringify(place)}`);
  assert.ok(place.right < 20 && place.top < 70, `stack top right: ${JSON.stringify(place)}`);
  fs.writeFileSync('/tmp/gui-notifs-top-right.png', (await win.webContents.capturePage()).toPNG());
  await sleep(7000);
  assert.equal(await ui(`document.querySelector('#notif-stack').hidden`), false, 'bell-opened stack stays');
  await ui(`document.querySelector('#notif-bell').click()`);
  await until(() => ui(`document.querySelector('#notif-stack').hidden`), 'bell hides');
  await ui(`document.querySelector('#notif-bell').click()`);
  // three more finishes from the first agent replace its toast (one per agent)
  set(0, 'busy'); await sleep(1500); set(0, 'idle');
  await sleep(1500);
  assert.equal((await toasts()).length, 1, 'one toast per agent');
  // hovering fans it out
  await ui(`document.querySelector('#notif-stack').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
  assert.equal(await ui(`document.querySelector('#notif-stack').hasAttribute('data-open')`), true, 'hover opens');
  await sleep(500);
  if (process.env.SYNAPSE_NOTIF_SHOT) fs.writeFileSync(process.env.SYNAPSE_NOTIF_SHOT, (await win.webContents.capturePage()).toPNG());
  // clicking the toast opens its agent and takes it off the stack
  await ui(`document.querySelector('#notif-stack .ntf-toast .ntf-text').click()`);
  await until(() => ui(`location.hash === '#agent=${first}'`), 'clicking opens the agent');
  await until(async () => (await toasts()).length === 0 && (await count()) === '', 'clicked toast is gone');
  await until(() => ui(`document.querySelector('#notif-stack').hidden`), 'empty stack hides');
  // x takes it off without opening anything
  set(1, 'busy'); await sleep(1500); set(1, 'idle');
  await until(async () => (await toasts()).length === 1, 'toast from the second agent');
  await ui(`document.querySelector('#notif-stack .ntf-toast .ntf-x').click()`);
  await until(async () => (await toasts()).length === 0, 'x removes it');
  assert.equal(await ui('location.hash'), `#agent=${first}`, 'x does not navigate');
  console.log(`PASS notification bell and stack (${name}): done toast, not for the agent on screen, auto-hides, bell shows/hides, one per agent, hover fans out, click opens + removes, x removes`);
  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|net::ERR/.test(e)), []);
})().catch(async (e) => {
  failed = true; console.error(e); console.error('page errors:', errors);
  if (win) fs.writeFileSync('/tmp/gui-notifs.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => { app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit(); });
