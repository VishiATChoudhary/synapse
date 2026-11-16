// Real Electron test: an agent started from Synapse in a folder it has not seen asks whether to trust it before it
// starts (Claude Code: "No, exit" is selected; Codex: "Yes, continue" is). Synapse answers Yes by itself, the agent
// starts, and a message sent to it goes in.
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
const codex = process.argv[2] === 'codex';
let sel = 0, trusted = false;
const yesAt = codex ? 0 : 1;
const draw = () => process.stdout.write('\\x1b[2J\\x1b[H' + (codex
  ? ['> You are in ' + process.cwd(), '', '  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk.', '', (sel === 0 ? '› ' : '  ') + '1. Yes, continue', (sel === 1 ? '› ' : '  ') + '2. No, quit', '', '  Press enter to continue']
  : [' Accessing workspace:', '', ' ' + process.cwd(), '', ' Quick safety check: Is this a project you created or one you trust?', '', ' Claude Code\\'ll be able to read, edit, and execute files here.', '', ' Security guide', '', (sel === 0 ? ' ❯ ' : '   ') + 'No, exit', (sel === 1 ? ' ❯ ' : '   ') + 'Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel']).join('\\r\\n'));
draw();
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', (d) => {
  const s = d.toString();
  fs.appendFileSync(path.join(${JSON.stringify(ctl)}, 'typed-' + slot), s);
  if (trusted) return;
  if (s.includes('\\x1b[B')) { sel = 1; draw(); }
  if (s.includes('\\x1b[A')) { sel = 0; draw(); }
  if (s.includes('\\r')) {
    if (sel !== yesAt) process.exit(1);
    trusted = true;
    process.stdout.write('\\x1b[2J\\x1b[H> ');
    fs.writeFileSync(file, JSON.stringify({ sessionId: (codex ? 'codex-' : 'stand-in-') + process.pid, pid: process.pid, cwd: process.cwd(), status: 'idle', startedAt: Date.now(), updatedAt: Date.now() }));
  }
});
setInterval(() => {}, 1000);
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { claude: { command: `exec ${path.join(bin, 'claude')} claude`, label: 'Claude' }, codex: { command: `exec ${path.join(bin, 'claude')} codex`, label: 'Codex' } } }));
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
const typed = (n = 0) => { try { return fs.readFileSync(path.join(ctl, `typed-${n}`), 'utf8'); } catch { return ''; } };
const pidOf = (n) => fs.readFileSync(path.join(ctl, `slot-${n}`), 'utf8').trim();
const alive = (n = 0) => { try { process.kill(Number(pidOf(n)), 0); return true; } catch { return false; } };

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Claude').click()`);
  await until(() => fs.existsSync(path.join(ctl, 'slot-0')), 'agent started');

  // Claude Code: Synapse moves to "Yes, I trust this folder" and confirms; nothing to do for you
  await until(() => fs.existsSync(path.join(claudeHome, 'sessions', `${pidOf(0)}.json`)), 'trusted and started by itself', 20000);
  assert.ok(alive(0), 'running');
  assert.ok(typed(0).includes('\x1b[B') && typed(0).includes('\r'), 'answered with the arrow and Enter');
  // a message goes straight in
  await until(() => ui(`(() => { const i = document.querySelector('#message-input'); i.value = 'hello there'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); return true; })()`), 'send the message', 10000);
  await until(() => typed(0).includes('hello there'), 'the message went in', 20000);

  // Codex: Yes is already selected, so just Enter
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Codex')?.click()`).catch(() => {});
  if (!fs.existsSync(path.join(ctl, 'slot-1'))) await ui(`document.getElementById('connect-agent')?.click()`).catch(() => {});
  await until(() => fs.existsSync(path.join(ctl, 'slot-1')) || native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Codex')?.click(), false`), 'codex started');
  await until(() => fs.existsSync(path.join(claudeHome, 'sessions', `${pidOf(1)}.json`)), 'codex trusted by itself', 20000);
  assert.ok(alive(1), 'codex running');
  assert.ok(!typed(1).includes('\x1b['), 'codex: no arrows, it was already on Yes');
  // hovering a row shows its actions without moving the name (it used to re-truncate): the hover look, applied by hand
  const width = () => ui(`document.querySelector('#project-list .session-row .session-name').getBoundingClientRect().width`);
  const before = await width();
  await ui(`(() => { const r = document.querySelector('#project-list .session-row'); r.querySelector('.row-actions').style.display = 'inline-flex'; r.querySelectorAll('.session-time, .state-pill').forEach((e) => { e.style.visibility = 'hidden'; }); })()`);
  assert.equal(await width(), before, 'the name keeps its width with the actions showing');
  assert.deepEqual(errors, []);
  console.log('gui-trust: ok');
})().catch((e) => { failed = true; console.error(e); }).finally(() => app.exit(failed ? 1 : 0));
