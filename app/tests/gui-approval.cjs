// Real Electron test for answering an agent from the GUI. A stand-in "claude" prints Claude Code's permission menu in
// its terminal and marks itself waiting the way Claude Code does (~/.claude/sessions/<id>.json); the GUI reads the
// question and choices off the screen, shows them as buttons, and a click sends that key to the terminal.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-approval.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-approval-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), claudeHome = path.join(fixture, 'claude'), answer = path.join(fixture, 'answer.txt');
for (const d of [state, bin, path.join(claudeHome, 'sessions')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const file = path.join(${JSON.stringify(path.join(claudeHome, 'sessions'))}, process.pid + '.json');
const mark = (status) => fs.writeFileSync(file, JSON.stringify({ sessionId: 'stand-in-' + process.pid, pid: process.pid, cwd: process.cwd(), status, startedAt: Date.now(), updatedAt: Date.now() }));
process.stdout.write('\\x1b[2J\\x1b[H╭──────────────────────────────────────────╮\\r\\n│ Bash command                             │\\r\\n│   rm -rf build                           │\\r\\n│ Do you want to proceed?                  │\\r\\n│ ❯ 1. Yes                                 │\\r\\n│   2. Yes, and don\\'t ask again            │\\r\\n│   3. No, and tell Claude what to do (esc) │\\r\\n╰──────────────────────────────────────────╯\\r\\n');
mark('waiting');
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', (d) => { fs.writeFileSync(${JSON.stringify(answer)}, JSON.stringify(d.toString())); process.stdout.write('\\r\\nChose ' + JSON.stringify(d.toString()) + '\\r\\n'); mark('idle'); });
setInterval(() => {}, 1 << 30);
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { claude: { command: `exec ${path.join(bin, 'claude')}`, label: 'Claude' } } }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLAUDE_HOME: claudeHome, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win, gui, failed = false;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check().catch(() => false)) return; await sleep(150); }
  throw new Error(`Timed out: ${label}`);
}
const ui = (code) => gui.executeJavaScript(code, true);
const native = (code) => win.webContents.executeJavaScript(code, true);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Claude').click()`);
  await until(() => ui(`[...document.querySelectorAll('.session-row')].some((r) => r.querySelector('.session-kind')?.dataset.kind === 'claude')`), 'the claude session in the sidebar');
  await ui(`[...document.querySelectorAll('.session-row')].find((r) => r.querySelector('.session-kind').dataset.kind === 'claude').click()`);

  // waiting: the row says so, and the card shows the question and the three choices
  await until(() => ui(`!!document.querySelector('.session-row[data-state="needs"] .state-pill.needs')`), 'the row shows Needs you');
  await until(() => ui(`!document.querySelector('#approval-card').hidden && document.querySelectorAll('#approval-card [data-approval-key]').length >= 4`), 'approval card with choices');
  const card = await ui(`document.querySelector('#approval-card').innerText`);
  assert.match(card, /rm -rf build/); assert.match(card, /Do you want to proceed\?/);
  const choices = await ui(`[...document.querySelectorAll('#approval-card [data-approval-key]')].map((b) => b.dataset.approvalKey + ':' + b.textContent.trim())`);
  assert.deepEqual(choices.slice(0, 3).map((c) => c.split(':')[0]), ['1', '2', '3'], choices.join(' | '));
  assert.ok(choices[0].includes('Yes'));
  if (process.env.APPROVAL_SHOT) fs.writeFileSync(process.env.APPROVAL_SHOT, (await win.webContents.capturePage()).toPNG());

  // a click answers in the terminal; the agent resumes and the card goes away
  await ui(`document.querySelector('#approval-card [data-approval-key="1"]').click()`);
  await until(async () => fs.existsSync(answer) && JSON.parse(fs.readFileSync(answer, 'utf8')) === '1', 'the key reached the agent');
  await until(() => ui(`document.querySelector('#approval-card').hidden`), 'the card closes once the agent moves on');
  console.log('PASS approvals: a waiting agent shows its question and choices in the GUI, and a click answers it in the terminal');
  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|net::ERR/.test(e)), []);
})().catch(async (e) => {
  failed = true; console.error(e);
  if (win) fs.writeFileSync('/tmp/gui-approval.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => { app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit(); });
