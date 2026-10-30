// Real Electron test for names that outlive an agent's id. A Codex (or Gemini, OpenCode, ...) is known by its pid,
// so after a restart Synapse sees a new agent and the name given to its tab was lost: other agents could not find
// "bookingestCodex" any more. The tab gives its agent the name again. A stand-in `opencode` runs in the tab; wiping
// its saved name is what a new id looks like.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/tab-names.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-tab-names-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), proj = path.join(fixture, 'staging');
for (const d of [state, bin, proj]) fs.mkdirSync(d);
const standIn = path.join(bin, 'opencode');
fs.writeFileSync(standIn, '#!/bin/sh\necho "ready"\nwhile IFS= read -r l; do echo "GOT: $l"; done\n', { mode: 0o755 });
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [proj], skipLogin: true, wakeAgents: false, profiles: { opencode: { command: standIn, label: 'OpenCode' }, shell: { command: 'zsh -fi', label: 'Shell' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_CLAUDE_HOME: path.join(fixture, 'claude'), SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO' || key === 'SYNAPSE_FAKE_REQUESTS') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const screen = () => js(`[...document.querySelectorAll('.term.visible .xterm-rows > div')].map((r) => r.textContent).join('\\n')`);

(async () => {
  const lib = await import(pathToFileURL(path.join(root, 'lib.mjs')));
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'app window');
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('#launch .launch-item')`), 'the launcher');
  await js(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'OpenCode').click()`);
  await until(async () => (await screen()).includes('ready'), 'the stand-in agent');
  const me = () => lib.listAgents().find((a) => a.kind === 'opencode' && a.cwd === proj);
  await until(() => me()?.name === 'opencode-staging', 'the agent under its generated name');

  // rename the tab: the agent takes the name
  await js(`(() => { const l = document.querySelector('#deck .card .label'); l.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })); })()`);
  await until(() => js(`!!document.querySelector('#deck .card .label input')`), 'the name editor');
  await js(`(() => { const i = document.querySelector('#deck .card .label input'); i.value = 'bookingestCodex'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until(() => me()?.name === 'bookingestCodex', 'the agent renamed with its tab');

  // its id changes (a restart): Synapse forgets the name; the tab gives it back
  lib.writeJSON(lib.FILES.names, {});
  assert.equal(me().name, 'opencode-staging');
  await js(`synapse.state().then(() => 0)`);
  await until(() => me()?.name === 'bookingestCodex', 'the tab name given back', 15000);

  // other agents find it by the name, by the generated one, and by a part of either
  const all = lib.listAgents();
  for (const q of ['bookingestCodex', 'opencode-staging', 'bookingest', 'ookingest']) assert.equal(lib.findAgent(all, q)?.id, me().id, q);

  // renamed elsewhere (the canvas, `synapse rename`): the tab follows, it does not take its name back
  lib.renameAgent(me(), 'ingest-reviewer');
  await until(() => js(`document.querySelector('#deck .card .label').textContent === 'ingest-reviewer'`), 'the tab follows', 15000);
  await sleep(3000);
  assert.equal(me().name, 'ingest-reviewer');

  console.log('tab names: ok');
  app.exit(0);
})().catch(async (e) => { console.error(e, await screen().catch(() => '')); app.exit(1); });
