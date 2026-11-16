// Real Electron test for queued prompts. A stand-in "claude" takes its state from a control file and records what is
// typed into it. Prompts sent while it works (or waits on a question) wait in the GUI and go in one at a time, in
// order, once it is free; nothing reaches its terminal while it is busy. Edit, remove and Send now work on the queue.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-queue.cjs
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

const typed = () => { try { return fs.readFileSync(path.join(ctl, 'typed-0'), 'utf8'); } catch { return ''; } };
const send = (text) => ui(`(() => { const i = document.querySelector('#message-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); })()`);
const queue = () => ui(`[...document.querySelectorAll('#prompt-queue .queued-text')].map((e) => e.textContent)`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Claude').click()`);
  await until(() => fs.existsSync(path.join(ctl, 'slot-0')), 'agent started');
  await until(() => ui(`!!document.querySelector('.session-row[data-state="working"]')`), 'the agent works');
  await until(async () => { await ui(`document.querySelector('.session-row[data-state="working"]')?.click()`); return ui(`/claude/.test(document.querySelector('.crumb-title')?.textContent || '') && !document.getElementById('thread-view').hidden`); }, 'the session is open');

  await until(() => ui(`location.hash.startsWith('#agent=desktop-') && !document.getElementById('thread-view').hidden`), 'the open agent merged into the app session, still open');
  // busy: prompts line up in the GUI, nothing is typed into the terminal
  await send('first task'); await send('second task'); await send('third task');
  await until(async () => (await queue()).length === 3, 'three queued prompts');
  assert.deepEqual(await queue(), ['first task', 'second task', 'third task']);
  assert.equal(await ui(`document.querySelector('#message-input').value`), '');
  await sleep(1500);
  assert.ok(!typed().includes('task'), 'nothing reached the busy terminal');
  if (process.env.QUEUE_SHOT) fs.writeFileSync(process.env.QUEUE_SHOT, (await win.webContents.capturePage()).toPNG());

  // remove the third, edit the second back into the box
  await ui(`document.querySelectorAll('#prompt-queue [data-queue-remove]')[2].click()`);
  await ui(`document.querySelectorAll('#prompt-queue [data-queue-edit]')[1].click()`);
  await until(async () => JSON.stringify(await queue()) === '["first task"]', 'one left after remove and edit');
  assert.equal(await ui(`document.querySelector('#message-input').value`), 'second task');
  await send('second task, edited');
  console.log('PASS queue: prompts sent while the agent works wait in order, nothing is typed into its terminal; remove and edit work');

  // waiting on a question: still held
  set(0, 'waiting'); await sleep(1500);
  assert.ok(!typed().includes('task'), 'nothing typed while it waits on a question');
  // free: the first goes in, the next waits until the agent has worked and is free again
  set(0, 'idle');
  await until(() => typed().includes('first task'), 'the first queued prompt is sent once free');
  await until(async () => JSON.stringify(await queue()) === '["second task, edited"]', 'the rest stays queued');
  assert.ok(!typed().includes('second task'));
  set(0, 'busy'); await sleep(800); set(0, 'idle');
  await until(() => typed().includes('second task, edited'), 'the next one goes once the agent is free again');
  await until(async () => (await queue()).length === 0, 'the queue is empty');
  assert.ok(typed().indexOf('first task') < typed().indexOf('second task, edited'), 'in order');
  // Send now skips the wait
  set(0, 'busy'); await sleep(800);
  await send('urgent');
  await until(async () => (await queue()).length === 1, 'queued while busy');
  await ui(`document.querySelector('#prompt-queue [data-queue-now]').click()`);
  await until(() => typed().includes('urgent'), 'Send now types it right away');
  console.log('PASS queue: held while it waits on a question, sent one at a time in order once free; Send now skips the line');

  // Stop: shown while it works, sends Escape (how Claude Code and Codex interrupt a turn); gone once it is idle
  await until(() => ui(`!document.getElementById('stop-agent').hidden`), 'Stop while it works');
  const before = typed().length;
  await ui(`document.getElementById('stop-agent').click()`);
  await until(() => typed().slice(before).includes('\x1b'), 'Stop sends Escape to the agent');
  set(0, 'idle');
  await until(() => ui(`document.getElementById('stop-agent').hidden`), 'no Stop when idle');
  // sending says nothing: no pop-up
  await send('quiet one');
  await until(() => typed().includes('quiet one'), 'sent straight away while idle, even right after Stop', 3000);
  await sleep(500);
  assert.equal(await ui(`document.getElementById('toast').hidden`), true, 'no pop-up after sending');
  console.log('PASS stop and quiet send: Stop interrupts a working agent; sending shows no pop-up');
  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|net::ERR/.test(e)), []);
})().catch(async (e) => {
  failed = true; console.error(e); console.error('page errors:', errors);
  if (win) fs.writeFileSync('/tmp/gui-queue.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => { app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit(); });
