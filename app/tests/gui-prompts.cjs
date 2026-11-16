// Real Electron test for an agent's prompts in the GUI. A stand-in "claude" draws real Claude Code screens (captured
// into test/fixtures/prompts) and waits; the card above the composer shows the question, its title and command, and
// each option with its description, and answering sends the keys Claude Code takes: a number, the arrow keys for a
// menu without numbers, a number then your text then Enter for "Type something", → for a multi-select's Submit.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-prompts.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-prompts-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), claudeHome = path.join(fixture, 'claude'), ctl = path.join(fixture, 'ctl');
for (const d of [state, bin, ctl, path.join(claudeHome, 'sessions')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
let slot = 0; for (;; slot++) { try { fs.writeFileSync(path.join(${JSON.stringify(ctl)}, 'slot-' + slot), String(process.pid), { flag: 'wx' }); break; } catch {} }
const file = path.join(${JSON.stringify(path.join(claudeHome, 'sessions'))}, process.pid + '.json');
const control = path.join(${JSON.stringify(ctl)}, 'state-' + slot);
let status = '';
let drawn = '';
const tick = () => {
  let want = 'busy'; try { want = fs.readFileSync(control, 'utf8').trim() || 'busy'; } catch {}
  if (want !== status) { status = want; fs.writeFileSync(file, JSON.stringify({ sessionId: 'stand-in-' + process.pid, pid: process.pid, cwd: process.cwd(), status, startedAt: Date.now(), updatedAt: Date.now() })); }
  let shown = ''; try { shown = fs.readFileSync(path.join(${JSON.stringify(ctl)}, 'screen-' + slot), 'utf8'); } catch {}
  if (shown !== drawn) { drawn = shown; process.stdout.write('\\x1b[2J\\x1b[H' + shown.split('\\n').join('\\r\\n')); }
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
const screenOf = (name) => fs.readFileSync(path.join(root, 'test/fixtures/prompts', `${name}.txt`), 'utf8');
const show = (name) => fs.writeFileSync(path.join(ctl, 'screen-0'), screenOf(name));
const card = () => ui(`(() => { const c = document.getElementById('approval-card'); if (c.hidden) return null; return { context: c.querySelector('.ask-context')?.textContent || '', text: c.querySelector('.ask-question')?.firstChild?.textContent || '', command: c.querySelector('.ask-command')?.textContent || '', steps: c.querySelector('.ask-steps')?.textContent || '', options: [...c.querySelectorAll('.ask-option:not(.ask-own)')].map((o) => o.querySelector('.ask-label').textContent + (o.querySelector('.ask-desc') ? ' | ' + o.querySelector('.ask-desc').textContent : '')).concat(c.querySelector('.ask-own') ? ['INPUT'] : []), buttons: [...c.querySelectorAll('.ask-foot button')].map((b) => b.textContent.trim()) }; })()`);
const clearTyped = () => { try { fs.unlinkSync(path.join(ctl, 'typed-0')); } catch {} };

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  show('claude-question');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Claude').click()`);
  await until(() => fs.existsSync(path.join(ctl, 'slot-0')), 'agent started');
  set(0, 'waiting');
  await until(async () => { await ui(`document.querySelector('.session-row[data-state="needs"], .session-row')?.click()`); return ui(`location.hash.startsWith('#agent=') && !document.getElementById('thread-view').hidden`); }, 'the session is open');

  // a question: title, question, every option with its description, your own answer, Chat about this
  await until(async () => (await card())?.options.length === 4, 'the question card', 20000);
  let c = await card();
  assert.equal(c.text, 'Which color theme do you prefer?');
  assert.deepEqual(c.options, ['Light | Bright backgrounds with dark text. Clean and easy to read in daylight.', 'Dark | Dark backgrounds with light text. Easier on the eyes in low light.', 'High contrast | Maximum contrast between text and background. Best for readability and accessibility.', 'INPUT']);
  assert.ok(c.buttons.includes('Chat about it'));
  if (process.env.PROMPT_SHOT) { await sleep(500); fs.writeFileSync(process.env.PROMPT_SHOT, (await win.webContents.capturePage()).toPNG()); }
  clearTyped();
  await ui(`(() => { const i = document.getElementById('message-input'); i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true })); })()`);
  await until(() => typed() === '2', 'pressing 2 picks the second answer');
  assert.equal(await ui(`document.getElementById('message-input').value`), '', 'and is not typed into the box');
  // your own answer: the number of "Type something", the text, then Enter
  clearTyped(); show('claude-questions-tabs');
  await until(async () => (await card())?.steps === '1/2', 'two questions show as steps');
  await ui(`(() => { const f = document.querySelector('#approval-card [data-approval-input]'); f.querySelector('input').value = 'purple'; f.requestSubmit(); })()`);
  await until(() => typed() === '4purple\r', 'your own answer goes in as text');
  console.log('PASS question: title, question, options with descriptions and tabs; a pick sends its number, your own answer its text');

  // multi-select: ticks show, a tick sends its number, Submit moves on (→)
  clearTyped(); show('claude-multiselect');
  await until(() => ui(`document.querySelectorAll('#approval-card .ask-box').length === 3`), 'tick boxes');
  await ui(`document.querySelector('#approval-card [data-approval-key="1"]').click()`); await until(() => typed() === '1', 'tick 1'); clearTyped();
  if (process.env.PROMPT_SHOT) { await sleep(400); fs.writeFileSync(process.env.PROMPT_SHOT.replace(/\.png$/, '-multi.png'), (await win.webContents.capturePage()).toPNG()); }
  await ui(`document.querySelector('#approval-card [data-approval-key="3"]').click()`);
  await until(() => typed() === '3', 'a tick sends its number');
  await ui(`[...document.querySelectorAll('#approval-card .ask-foot button')].find((b) => /Submit/.test(b.textContent)).click()`);
  await until(() => typed() === '3\x1b[C', 'Submit moves to the review');
  show('claude-review');
  await until(async () => (await card())?.text === 'Ready to submit your answers?', 'the review');
  console.log('PASS multi-select: ticks, Submit, then the review');

  // a permission prompt: what it is, the command apart, the choices
  clearTyped(); show('claude-permission');
  await until(async () => (await card())?.command === 'touch synapse-perm-test.txt', 'the permission prompt');
  c = await card();
  assert.equal(c.text, 'Do you want to proceed?'); assert.equal(c.context, "Bash command: Create empty file synapse-perm-test.txt");
  assert.equal(c.options.length, 4);
  if (process.env.PROMPT_SHOT) { await sleep(400); fs.writeFileSync(process.env.PROMPT_SHOT.replace(/\.png$/, '-perm.png'), (await win.webContents.capturePage()).toPNG()); }
  // a menu without numbers: walked with the arrow keys
  clearTyped(); show('claude-trust');
  await until(async () => (await card())?.options.includes('Yes, I trust this folder'), 'the trust menu');
  await ui(`[...document.querySelectorAll('#approval-card .ask-option')].find((b) => /Yes, I trust/.test(b.textContent)).click()`);
  await until(() => typed() === '\x1b[B\r', 'down, then Enter');
  console.log('PASS permission prompt with its command apart; a menu without numbers is answered with the arrow keys');
  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|net::ERR/.test(e)), []);
})().catch(async (e) => {
  failed = true; console.error(e); console.error('page errors:', errors);
  if (win) fs.writeFileSync('/tmp/gui-prompts.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => { app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit(); });
