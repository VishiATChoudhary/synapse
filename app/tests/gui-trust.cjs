// Real Electron test: a new project's agent stops at Claude Code's "trust this folder?" before it starts. The GUI
// shows that question as the options card, a message sent meanwhile waits instead of answering it (Enter would pick
// "No, exit"), and once you trust the folder the agent starts and gets the message.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-trust.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-trust-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), claudeHome = path.join(fixture, 'claude'), ctl = path.join(fixture, 'ctl');
for (const d of [state, bin, ctl, path.join(claudeHome, 'sessions')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
// Claude Code on a folder it does not trust yet: the trust question first (No, exit is selected), no session file
// until you trust it; then it registers and waits for prompts.
const fs = require('fs'), path = require('path');
let slot = 0; for (;; slot++) { try { fs.writeFileSync(path.join(${JSON.stringify(ctl)}, 'slot-' + slot), String(process.pid), { flag: 'wx' }); break; } catch {} }
const file = path.join(${JSON.stringify(path.join(claudeHome, 'sessions'))}, process.pid + '.json');
let sel = 0, trusted = false;
const draw = () => process.stdout.write('\\x1b[2J\\x1b[H' + [' Accessing workspace:', '', ' ' + process.cwd(), '', ' Quick safety check: Is this a project you created or one you trust?', '', ' Claude Code\\'ll be able to read, edit, and execute files here.', '', ' Security guide', '', (sel === 0 ? ' ❯ ' : '   ') + 'No, exit', (sel === 1 ? ' ❯ ' : '   ') + 'Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'].join('\\r\\n'));
draw();
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', (d) => {
  const s = d.toString();
  fs.appendFileSync(path.join(${JSON.stringify(ctl)}, 'typed-' + slot), s);
  if (trusted) return;
  if (s.includes('\\x1b[B')) { sel = 1; draw(); }
  if (s.includes('\\x1b[A')) { sel = 0; draw(); }
  if (s.includes('\\r')) {
    if (sel === 0) process.exit(1);
    trusted = true;
    process.stdout.write('\\x1b[2J\\x1b[H> ');
    fs.writeFileSync(file, JSON.stringify({ sessionId: 'stand-in-' + process.pid, pid: process.pid, cwd: process.cwd(), status: 'idle', startedAt: Date.now(), updatedAt: Date.now() }));
  }
});
setInterval(() => {}, 1000);
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
const ui = (code) => { const f = win.webContents.mainFrame.frames.find((x) => x.url.includes('?desktop=1')) || gui; return Promise.race([f.executeJavaScript(code, true), sleep(3000).then(() => { throw new Error('frame did not answer'); })]); };
const native = (code) => win.webContents.executeJavaScript(code, true);
const typed = () => { try { return fs.readFileSync(path.join(ctl, 'typed-0'), 'utf8'); } catch { return ''; } };
const alive = () => { try { process.kill(Number(fs.readFileSync(path.join(ctl, 'slot-0'), 'utf8')), 0); return true; } catch { return false; } };

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Claude').click()`);
  await until(() => fs.existsSync(path.join(ctl, 'slot-0')), 'agent started');

  // the trust question shows as the card
  await until(() => ui(`!document.getElementById('approval-card').hidden && /trust this folder/.test(document.getElementById('approval-card').textContent)`), 'trust question in the card');
  if (process.env.SHOT_DIR) { await sleep(500); fs.writeFileSync(path.join(process.env.SHOT_DIR, 'trust.png'), (await win.webContents.capturePage()).toPNG()); }

  // a message now waits: it does not press Enter on "No, exit"
  await until(() => ui(`(() => { const i = document.querySelector('#message-input'); i.value = 'hello there'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); return true; })()`), 'send the message', 10000);
  await until(() => ui(`[...document.querySelectorAll('#prompt-queue .queued-text')].some((e) => e.textContent.includes('hello there'))`), 'message waits in the queue');
  await sleep(1000);
  assert.ok(alive(), 'the agent did not exit');
  assert.ok(!typed().includes('\r'), 'nothing answered the question');

  // trust it: the agent starts, and gets the message
  await ui(`[...document.querySelectorAll('#approval-card .ask-option')].find((b) => /Yes, I trust/.test(b.textContent)).click()`);
  await until(() => typed().includes('hello there'), 'the waiting message went in once it started', 40000);
  assert.ok(alive(), 'running');
  assert.deepEqual(errors, []);
  console.log('gui-trust: ok');
})().catch((e) => { failed = true; console.error(e); }).finally(() => app.exit(failed ? 1 : 0));
