// Real Electron test: an archived (or snoozed) agent that starts working again comes back to Working, and stays there
// after you switch to another agent (an archived agent only shows while it is open).
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-new-working.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-queue-')));
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
  win.setBounds({ width: 1400, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  const ids = () => ui(`[...document.querySelectorAll('#project-list .session-row')].map((r) => r.dataset.agent)`);
  const fresh = async (slot) => {
    const before = await ids(); await launch(slot); set(slot, 'idle');
    let id; await until(async () => (id = (await ids()).find((x) => !before.includes(x))) && !(await ui(`!!document.querySelector('#project-list .session-row[data-agent="${id}"][data-state="working"]')`)), `agent ${slot} is free`);
    return id;
  };
  const first = await fresh(0), second = await fresh(1);
  await ui(`document.querySelector('#project-list .session-row[data-agent="${second}"]').click()`);
  // archive the first from its row: it goes to Archived
  await ui(`document.querySelector('#project-list .session-row[data-agent="${first}"] [data-row-act="archive"]').click()`);
  await until(async () => (await place(first)) === 'shelf:archived', 'archived');
  // open it and it starts working; switching away keeps it in Working
  await until(async () => { await ui(`document.querySelector('#project-list .session-row[data-agent="${first}"]')?.click()`); await sleep(300); return ui(`location.hash === '#agent=${first}'`); }, 'the archived agent is open');
  set(0, 'busy');
  await until(async () => (await place(first)) === 'flat:working', 'working while open').catch(async (e) => { console.log(await place(first), await place(second), await ui('location.hash')); throw e; });
  await ui(`document.querySelector('#project-list .session-row[data-agent="${second}"]').click()`);
  await until(() => ui(`location.hash === '#agent=${second}'`), 'switched away');
  await sleep(1500);
  assert.equal(await place(first), 'flat:working', 'still in Working after switching away');
  set(0, 'idle');
  await until(async () => (await place(first)) === 'flat:done', 'Done once it finishes, not back in Archived');
  // archived before this rule existed, with work done since: it comes back when the app starts
  await sleep(800); // the app has saved its marks
  const saved = path.join(state, 'workspace-ui.json'), prefs = JSON.parse(fs.readFileSync(saved, 'utf8'));
  const marks = (k) => JSON.parse(prefs[k] || '{}');
  prefs['synapse-archived'] = JSON.stringify({ ...marks('synapse-archived'), [second]: Date.now() - 60_000 });
  prefs['synapse-done'] = JSON.stringify({ ...marks('synapse-done'), [second]: Date.now() - 1000 });
  fs.writeFileSync(saved, JSON.stringify(prefs));
  gui = null; win.webContents.reload();
  await until(() => ui(`!!document.querySelector('#project-list .session-row[data-agent="${first}"]')`), 'GUI back', 60000);
  await ui(`document.querySelector('#project-list .session-row[data-agent="${first}"]')?.click()`);
  await until(async () => ['flat:done', 'flat:working'].includes(await place(second)), 'worked after it was archived: out of Archived');
  console.log('PASS archived agent working again: back in Working, stays there after switching away, then Done');
  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|net::ERR/.test(e)), []);
})().catch(async (e) => {
  failed = true; console.error(e); console.error('page errors:', errors);
  if (win) fs.writeFileSync('/tmp/gui-new-working.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => { app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit(); });
