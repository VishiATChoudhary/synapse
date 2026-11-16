// Real Electron test for Watching: an agent that says what it waits on outside (synapse_waiting) shows as Watching,
// in its own group of the status view, with the note on its row and in its details panel, and goes back to normal
// when the wait is cleared.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-watching.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-watching-')));
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
const rows = () => ui(`[...document.querySelectorAll('#todo-list .todo-row')].map((r) => ({ id: r.dataset.todo, text: r.querySelector('.todo-text').textContent, done: r.classList.contains('done'), agent: r.querySelector('.todo-chip:not(.empty) > span:last-child')?.textContent || null, linear: r.querySelector('.todo-linear')?.textContent || null }))`);
const todosFile = () => { try { return JSON.parse(fs.readFileSync(path.join(state, 'todos.json'), 'utf8')); } catch { return []; } };


(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Claude').click()`);
  await until(() => fs.existsSync(path.join(ctl, 'slot-0')), 'agent started');
  set(0, 'idle');
  const { listAgents } = await import(pathToFileURL(path.join(root, 'lib.mjs')));
  let agentKey;
  await until(() => { agentKey = listAgents().find((x) => String(x.pid) === pidOf(0))?.id; return agentKey; }, 'agent id');
  await until(() => ui(`document.body.dataset.browserAgent`).then((k) => k === agentKey), 'session matched to its agent', 60000);
  const row = `document.querySelector('#project-list .session-row[aria-current="page"]')`;

  // the agent says what it waits on
  const waiting = await import(pathToFileURL(path.join(root, 'waiting.mjs')));
  waiting.set(agentKey, { what: 'checks on PR #12 to pass', url: 'https://github.com/x/y/pull/12' });
  await until(() => ui(`${row}?.dataset.state === 'watching'`), 'row shows Watching');
  assert.match(await ui(`${row}.querySelector('.state-pill').textContent`), /Watching/);
  assert.match(await ui(`${row}.querySelector('.session-sub').textContent`), /Waiting: checks on PR #12 to pass/);
  assert.ok(await ui(`!!document.querySelector('#project-list .flat-group[data-flat="watching"] .session-row[aria-current="page"]')`), 'in the Watching group');
  await ui(`(() => { const b = document.getElementById('context-toggle'); if (b.getAttribute('aria-expanded') !== 'true') b.click(); })()`);
  await until(() => ui(`!!document.querySelector('[data-inspector-tab="details"]')`), 'panel');
  await ui(`document.querySelector('[data-inspector-tab="details"]').click()`);
  await until(() => ui(`!!document.querySelector('.watch-section')`), 'Watching on the details panel');
  assert.match(await ui(`document.querySelector('.watch-section').textContent`), /checks on PR #12 to pass/);
  assert.equal(await ui(`document.querySelector('.watch-section a').href`), 'https://github.com/x/y/pull/12');
  if (process.env.SHOT_DIR) { await sleep(600); fs.writeFileSync(path.join(process.env.SHOT_DIR, 'watching.png'), (await win.webContents.capturePage()).toPNG()); }

  // cleared: back to how it was
  waiting.clear(agentKey);
  await until(() => ui(`${row}?.dataset.state !== 'watching'`), 'no longer watching');
  await until(() => ui(`!document.querySelector('.watch-section')`), 'panel section gone');

  // working wins over watching
  waiting.set(agentKey, { what: 'the deploy' });
  await until(() => ui(`${row}?.dataset.state === 'watching'`), 'watching again');
  set(0, 'busy');
  await until(() => ui(`${row}?.dataset.state === 'working'`), 'working shows while it works');

  assert.deepEqual(errors, []);
  console.log('gui-watching: ok');
})().catch((e) => { failed = true; console.error(e); }).finally(() => app.exit(failed ? 1 : 0));
