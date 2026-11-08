// Real Electron test for ⌘S: Archive and clear sends the agent's own clear command, leaves the digest waiting in its
// prompt, then archives the old transcript losslessly in place of the original (restorable byte for byte). The agent is a stand-in `codex`
// that writes a rollout (its transcript) for this folder and echoes what it is sent.
// Run: npx electron tests/save-session.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-save-session-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), proj = path.join(fixture, 'api'), codexHome = path.join(fixture, 'codex');
for (const d of [state, bin, proj, codexHome]) fs.mkdirSync(d);
const standIn = path.join(bin, 'codex');
fs.writeFileSync(standIn, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
const dir = path.join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
fs.mkdirSync(dir, { recursive: true });
const name = 'rollout-' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + '-' + p2(d.getMinutes()) + '-' + p2(d.getSeconds()) + '-x.jsonl';
const msg = (role, text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ text }] } });
const lines = [JSON.stringify({ type: 'session_meta', payload: { cwd: process.cwd() } })];
for (let i = 0; i < 30; i++) lines.push(msg('user', 'make the parser handle case ' + i), msg('assistant', 'Handled case ' + i + '. ' + 'More words. '.repeat(30)));
fs.writeFileSync(path.join(dir, name), lines.join('\\n') + '\\n');
console.log('ready');
process.stdin.setRawMode?.(true); process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { for (const l of c.split(/\\r|\\n/)) if (l.trim()) console.log('GOT: ' + l.replace(/\\x1b\\[20[01]~/g, '').slice(0, 60)); });
`, { mode: 0o755 });
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [proj], skipLogin: true, wakeAgents: false, profiles: { codex: { command: standIn, label: 'Codex' }, shell: { command: 'zsh -fi', label: 'Shell' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_CLAUDE_HOME: path.join(fixture, 'claude'), CODEX_HOME: codexHome, SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO' || key === 'SYNAPSE_FAKE_REQUESTS') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const screen = () => js(`[...document.querySelectorAll('.term.visible .xterm-rows > div')].map((r) => r.textContent).join('\\n')`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'app window');
  win.show(); win.focus();
  await until(() => js(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Codex')`), 'the Codex launcher');
  await js(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Codex').click()`);
  await until(async () => /ready/.test(await screen()), 'the stand-in codex runs');
  await sleep(4000); // discovery finds the agent and its rollout

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['meta'] });
  await until(() => js(`!document.querySelector('#modal').hidden && document.querySelector('#modal-title').textContent === 'save and clear'`), 'the saved sheet', 20000)
    .catch(async (e) => { console.log('TOASTS', await js(`document.body.innerText.slice(-400)`)); throw e; });
  const sheet = await js(`document.querySelector('#modal-body').textContent`);
  assert.match(sheet, /60 messages/);
  assert.match(sheet, /Started with: make the parser handle case 0/);
  const rollout = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? rollout(path.join(dir, e.name)) : e.name.startsWith('rollout-') ? [path.join(dir, e.name)] : []));
  const [src] = rollout(codexHome), original = fs.readFileSync(src);
  if (process.env.SHOT) fs.writeFileSync(process.env.SHOT, (await win.webContents.capturePage()).toPNG());

  await js(`[...document.querySelectorAll('#modal button')].find((b) => b.textContent.startsWith('Archive and clear')).click()`);
  await until(async () => /GOT: \/new/.test(await screen()), 'the clear command went in');
  await until(async () => /GOT: Context from before the clear/.test(await screen()), 'the digest waits in the prompt', 15000).catch(async (e) => { console.log('SCREEN', await screen()); throw e; });
  await until(() => !fs.existsSync(src), 'the original transcript is gone once archived', 30000);
  const index = JSON.parse(fs.readFileSync(path.join(state, 'saved', 'index.json'), 'utf8'));
  assert.equal(index.length, 1);
  assert.ok(index[0].size < original.length, 'smaller than the transcript');
  const saved = await import(pathToFileURL(path.join(root, 'saved.mjs')));
  await saved.restore(index[0].id);
  assert.ok(fs.readFileSync(src).equals(original), 'restored byte for byte');
  console.log('save-session: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
