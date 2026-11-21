// Real Electron test: a message from another Claude session (Claude Code's <teammate-message>) shows as a note from
// that session in the conversation, not as raw tags you typed.
// (setup shared with gui-queue.cjs)
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
const sid = 'tm-' + process.pid, proj = path.join(${JSON.stringify(path.join(claudeHome, 'projects', 'x'))});
fs.mkdirSync(proj, { recursive: true });
const line = (type, content, i) => JSON.stringify({ type, uuid: 'u' + i, timestamp: new Date(Date.now() - 60000 + i * 1000).toISOString(), cwd: process.cwd(), sessionId: sid, message: { role: type, content } });
fs.writeFileSync(path.join(proj, sid + '.jsonl'), [
  line('user', 'Check the browser fallback', 0),
  line('assistant', [{ type: 'text', text: 'Asked the platform session to do it.' }], 1),
  line('user', 'Another Claude session sent a message:\\n<teammate-message teammate_id="platform-opensb" color="blue" summary="Start-failure fallback added; Agent37 live smoke passed">\\nBoth follow-ups are done and nothing is committed.\\n</teammate-message>', 2),
  line('assistant', [{ type: 'text', text: 'Noted, thanks.' }], 3),
].join('\\n') + '\\n');
const tick = () => {
  let want = 'idle'; try { want = fs.readFileSync(control, 'utf8').trim() || 'busy'; } catch {}
  if (want !== status) { status = want; fs.writeFileSync(file, JSON.stringify({ sessionId: sid, pid: process.pid, cwd: process.cwd(), status, startedAt: Date.now(), updatedAt: Date.now() })); }
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


(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Claude').click()`);
  await until(() => fs.existsSync(path.join(ctl, 'slot-0')), 'agent started');
  await until(async () => { await ui(`document.querySelector('.session-row')?.click()`); return ui(`!document.getElementById('thread-view').hidden && !!document.querySelector('.message.peer')`); }, 'the teammate note shows', 45000);
  const note = await ui(`(() => { const m = document.querySelector('.message.peer'); return { head: m.querySelector('.message-head')?.textContent, summary: m.querySelector('.message-summary')?.textContent, body: m.querySelector('.message-body')?.textContent }; })()`);
  assert.match(note.head, /platform-opensb/);
  assert.equal(note.summary, 'Start-failure fallback added; Agent37 live smoke passed');
  assert.match(note.body, /Both follow-ups are done/);
  assert.equal(await ui(`document.getElementById('thread-view').textContent.includes('teammate-message')`), false, 'no raw tags');
  assert.equal(await ui(`document.querySelectorAll('.message.user').length`), 1, 'only your own prompt is yours');
  if (process.env.TEAMMATE_SHOT) { await sleep(500); fs.writeFileSync(process.env.TEAMMATE_SHOT, (await win.webContents.capturePage()).toPNG()); }
  assert.deepEqual(errors.filter((e) => !/Autofill|favicon/i.test(e)), []);
  console.log('gui-teammate: ok');
})().catch((e) => { failed = true; console.error(e); }).finally(() => { fs.rmSync(fixture, { recursive: true, force: true }); app.exit(failed ? 1 : 0); });
