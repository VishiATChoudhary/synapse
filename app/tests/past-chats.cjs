// Real Electron test for importing chats from before Synapse. A fake ~/.claude and ~/.codex each hold one chat;
// the tour's import step links them into ~/.synapse/history, the past-chats list shows both, and picking one
// starts that CLI on it (stand-in `claude` and `codex` print how they were called and where).
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/past-chats.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-past-chats-')));
const state = path.join(fixture, 'state'), proj = path.join(fixture, 'proj');
// the Codex chat ran in a folder that is no workspace yet
const api = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-past-api-')));
for (const d of [state, proj, path.join(fixture, 'bin'), path.join(fixture, 'zdot')]) fs.mkdirSync(d);

// one Claude chat in proj, one Codex chat in api
const claudeId = '11111111-2222-4333-8444-555555555555', codexId = '019a0000-1111-7222-8333-444444444444';
const claudeDir = path.join(fixture, 'claude', 'projects', proj.replace(/[/.]/g, '-'));
fs.mkdirSync(claudeDir, { recursive: true });
fs.writeFileSync(path.join(claudeDir, `${claudeId}.jsonl`), [
  { type: 'user', cwd: proj, sessionId: claudeId, timestamp: '2026-10-20T10:00:00Z', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
  { type: 'user', cwd: proj, sessionId: claudeId, timestamp: '2026-10-20T10:01:00Z', message: { role: 'user', content: 'Fix the flaky login test' } },
  { type: 'assistant', cwd: proj, sessionId: claudeId, message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } },
].map((e) => JSON.stringify(e)).join('\n') + '\n');
const codexDir = path.join(fixture, 'codex', 'sessions', '2026', '10', '21');
fs.mkdirSync(codexDir, { recursive: true });
fs.writeFileSync(path.join(codexDir, `rollout-2026-10-21T09-00-00-${codexId}.jsonl`), [
  { type: 'session_meta', timestamp: '2026-10-21T09:00:00Z', payload: { id: codexId, cwd: api, timestamp: '2026-10-21T09:00:00Z' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for api' }] } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'Add rate limits to the API' } },
].map((e) => JSON.stringify(e)).join('\n') + '\n');

// stand-in CLIs, found first through the test's own zsh startup file
for (const cli of ['claude', 'codex']) fs.writeFileSync(path.join(fixture, 'bin', cli), `#!/bin/sh\necho "RESUMED ${cli} $* IN $(pwd)"\nexec sleep 600\n`, { mode: 0o755 });
fs.writeFileSync(path.join(fixture, 'zdot', '.zshenv'), `export PATH="${path.join(fixture, 'bin')}:$PATH"\n`);
fs.writeFileSync(path.join(fixture, 'zdot', '.zprofile'), `export PATH="${path.join(fixture, 'bin')}:$PATH"\n`);

fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [], skipLogin: true }));
Object.assign(process.env, {
  SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'terminal', SYNAPSE_ONBOARDING: '1', SHELL: '/bin/zsh',
  SYNAPSE_CLAUDE_HOME: path.join(fixture, 'claude'), CODEX_HOME: path.join(fixture, 'codex'), ZDOTDIR: path.join(fixture, 'zdot'),
});
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO' || key === 'SYNAPSE_FAKE_REQUESTS') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const screen = () => js(`[...document.querySelectorAll('.term.visible .xterm-rows > div')].map((r) => r.textContent).join('\\n')`);
const shot = async (name) => { if (process.env.PAST_SHOTS) fs.writeFileSync(path.join(process.env.PAST_SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
const clickText = (sel, text) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();

  // the tour's second step offers both CLIs, with what it found, and lists the rest as coming soon
  await until(() => js(`!document.querySelector('#onboard').hidden`), 'the tour');
  await clickText('#onboard .btn', 'next');
  await until(() => js(`document.querySelectorAll('#onboard .import').length >= 3`), 'the import rows');
  const rows = await js(`[...document.querySelectorAll('#onboard .import')].map((r) => r.textContent)`);
  assert.ok(rows.some((r) => /Claude Code.*1 chat/.test(r)), rows.join(' | '));
  assert.ok(rows.some((r) => /Codex.*1 chat/.test(r)), rows.join(' | '));
  assert.ok(rows.some((r) => /Gemini CLI.*coming soon/.test(r)), rows.join(' | '));
  await sleep(700); await shot('tour-import');

  // importing links the CLIs' own folders into ~/.synapse/history
  await js(`[...document.querySelectorAll('#onboard .import')].find((r) => r.textContent.includes('Claude Code')).querySelector('button').click()`);
  await until(() => fs.existsSync(path.join(state, 'history', 'claude')), 'the claude link');
  await until(() => js(`[...document.querySelectorAll('#onboard .import')].find((r) => r.textContent.includes('Codex'))?.querySelector('button.sig') != null`), 'codex row');
  await js(`[...document.querySelectorAll('#onboard .import')].find((r) => r.textContent.includes('Codex')).querySelector('button').click()`);
  await until(() => fs.existsSync(path.join(state, 'history', 'codex')), 'the codex link');
  assert.equal(fs.realpathSync(path.join(state, 'history', 'claude')), path.join(fixture, 'claude', 'projects'));
  assert.equal(fs.realpathSync(path.join(state, 'history', 'codex')), path.join(fixture, 'codex', 'sessions'));

  // the list shows both, named by what was asked (not the /clear or the AGENTS.md preamble)
  await until(() => js(`[...document.querySelectorAll('#onboard .imports > .btn')].some((b) => b.textContent === 'see my chats')`), 'see my chats');
  await clickText('#onboard .imports > .btn', 'see my chats');
  await until(() => js(`document.querySelectorAll('.past-list .opt').length === 2`), 'two past chats');
  const titles = await js(`[...document.querySelectorAll('.past-list .opt .k')].map((k) => k.textContent)`);
  assert.deepEqual(titles, ['Add rate limits to the API', 'Fix the flaky login test']);
  await sleep(700); await shot('past-chats');

  // picking the Claude chat resumes it in its folder (here inside the test's workspace), as a tab named after it
  await js(`[...document.querySelectorAll('.past-list .opt')].find((o) => o.textContent.includes('flaky')).click()`);
  await until(async () => (await screen()).replace(/\n/g, '').includes(`RESUMED claude --resume ${claudeId} IN ${proj}`), 'claude resumed in proj', 20000);
  await until(() => js(`[...document.querySelectorAll('#deck .card')].some((c) => c.textContent.includes('Fix the flaky login test'))`), 'the tab named after the chat');

  // ⇧⌘H opens the list again; searching and Enter resumes the Codex one
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'H', modifiers: [process.platform === 'darwin' ? 'meta' : 'control', 'shift'] });
  await until(() => js(`document.querySelectorAll('.past-list .opt').length === 2`), 'the list by shortcut');
  await js(`const i = document.querySelector('.modal input[type=search]'); i.value = 'rate'; i.dispatchEvent(new Event('input'))`);
  await until(() => js(`document.querySelectorAll('.past-list .opt').length === 1`), 'search narrows');
  await js(`document.querySelector('.modal input[type=search]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await until(async () => (await screen()).replace(/\n/g, '').includes(`RESUMED codex resume ${codexId} IN ${api}`), 'codex resumed in api', 20000);
  await until(() => js(`[...document.querySelectorAll('.wt-name')].some((n) => n.title.startsWith(${JSON.stringify(api)}))`), 'its folder added as a workspace');
  await shot('resumed');

  assert.deepEqual(errors, []);
  console.log('past chats: ok');
  app.exit(0);
})().catch(async (e) => { console.error(e, errors, await screen().catch(() => '')); await shot('failure').catch(() => {}); app.exit(1); });
