// A real OpenCode-shaped process, V2 SQLite history, and the actual desktop GUI. No model requests.
const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

if (typeof electron === 'string') {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-opencode-ui-')));
  const result = spawnSync(electron, [__filename], { env: { ...process.env, SYNAPSE_OPENCODE_FIXTURE: fixture }, stdio: 'inherit' });
  fs.rmSync(fixture, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = electron;
const fixture = process.env.SYNAPSE_OPENCODE_FIXTURE;
assert.ok(fixture);
const state = path.join(fixture, 'state'), data = path.join(fixture, 'data'), cli = path.join(fixture, 'opencode');
fs.mkdirSync(state);
fs.writeFileSync(cli, '#!/bin/sh\nprintf \'OpenCode TUI chrome should stay out of the conversation\\n\'\nwhile IFS= read -r line; do printf \'%s\\n\' "$line"; done\n');
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], autoSymlink: false, skipLogin: true,
  profiles: { shell: { command: 'cat', label: 'Shell' }, opencode: { command: `/bin/sh ${cli}`, label: 'OpenCode' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, XDG_DATA_HOME: data, SYNAPSE_USER_DATA: path.join(fixture, 'electron'),
  SYNAPSE_USER_HOME: path.join(fixture, 'user'), SYNAPSE_CLAUDE_HOME: path.join(fixture, 'claude'), CODEX_HOME: path.join(fixture, 'codex'),
  GH_CONFIG_DIR: path.join(fixture, 'gh'), SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/sh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || ['SYNAPSE_DEBUG', 'SYNAPSE_DEMO', 'SYNAPSE_FAKE_REQUESTS'].includes(key)) delete process.env[key];
process.chdir(fixture);
let win, gui, failed = false;
const errors = [], sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const native = (code) => win.webContents.executeJavaScript(code, true);
const ui = (code) => gui.executeJavaScript(code, true);
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
async function shot(name) {
  if (!process.env.OPENCODE_SHOTS || !gui || !win) return;
  fs.mkdirSync(process.env.OPENCODE_SHOTS, { recursive: true });
  const bounds = await native(`(() => { const r = document.querySelector('#workspace-frame').getBoundingClientRect(); return { x: Math.ceil(r.x), y: Math.ceil(r.y), width: Math.floor(r.width), height: Math.floor(r.height) }; })()`);
  fs.writeFileSync(path.join(process.env.OPENCODE_SHOTS, `${name}.png`), (await win.webContents.capturePage(bounds)).toPNG());
}

(async () => {
  const { buildOpenCodeV2, OC_V2_SESSION } = await import('../../test/fixtures/make-sessions.mjs');
  const old = Date.now() - 3_600_000, file = buildOpenCodeV2(data, fixture, old);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  const row = db.prepare("SELECT data FROM session_message WHERE id = 'v2m3'").get();
  const message = JSON.parse(row.data);
  message.content.find((p) => p.type === 'text').text = '## Retries\n\nUse **backoff** in `fetch`.\n\n- Three attempts\n- Stop on success\n\n```js\nawait fetch(url);\n```';
  db.prepare("UPDATE session_message SET data = ? WHERE id = 'v2m3'").run(JSON.stringify(message));
  db.close();
  fs.writeFileSync(path.join(state, 'sessions.json'), JSON.stringify({ version: 1, slots: [
    { worktree: fixture, top: 0, focused: true, sessions: [{ key: 'opencode', kind: 'opencode', title: 'OpenCode', parent: null, resume: { transcript: `${file}#${OC_V2_SESSION}` } }] },
  ] }));
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'window');
  win.setBounds({ width: 1200, height: 900 });
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  await until(() => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => ui(`!!document.querySelector('[data-agent="desktop-opencode"]')`), 'OpenCode session');
  await ui(`document.querySelector('[data-agent="desktop-opencode"]').click()`);
  await until(() => ui(`document.querySelector('#message-list h3')?.textContent === 'Retries'`), 'OpenCode history as GUI message cards');
  assert.equal(await ui(`document.querySelector('#message-list .terminal-transcript')`), null);
  assert.equal(await ui(`document.querySelector('#message-list strong')?.textContent`), 'backoff');
  assert.equal(await ui(`document.querySelector('#message-list pre code')?.textContent.trim()`), 'await fetch(url);');
  assert.equal(await ui(`document.querySelector('#message-list .tool-message .tool-verb')?.textContent`), 'Edited');
  assert.equal(await ui(`document.querySelector('#message-list .tool-message .tool-what')?.textContent`), 'src/fetch.js');
  assert.doesNotMatch(await ui(`document.querySelector('#message-list').textContent`), /private|TUI chrome/);
  assert.ok(await ui(`document.querySelectorAll('#message-list time').length > 0`), 'OpenCode millisecond timestamps render as message times');
  const pid = await native(`synapse.state().then((s) => Object.values(s.agents).find((a) => a.kind === 'opencode')?.synapseId)`);
  assert.ok(pid, 'the GUI uses the existing OpenCode process');
  await native(`document.querySelector('#mode-terminal').click()`);
  await native(`document.querySelector('#mode-gui').click()`);
  await until(() => ui(`document.querySelector('#message-list h3')?.textContent === 'Retries'`), 'OpenCode history survives mode switching');
  assert.equal(await native(`synapse.state().then((s) => Object.values(s.agents).find((a) => a.kind === 'opencode')?.synapseId)`), pid);
  await shot('opencode-gui');
  assert.deepEqual(errors, []);
  console.log('PASS OpenCode V2 renders chat cards, Markdown, tools and timestamps in GUI mode; switching modes preserves its process');
})().catch(async (error) => {
  failed = true; console.error(error);
  try {
    console.error('OpenCode discovery:', await native(`synapse.state().then((s) => Object.values(s.agents).filter((a) => a.kind === 'opencode'))`));
    await shot('opencode-gui-failed');
  } catch {}
}).finally(() => {
  app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit();
});
