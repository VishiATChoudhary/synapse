// Real Electron test for waking agents with their messages. A stand-in `opencode` (a script that echoes every line it
// reads) runs in a tab; a message sent to it is typed into its prompt once it is idle, and taken from the inbox. A
// half-typed prompt holds the wake back until the user is done with it.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/wake-agents.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-wake-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), proj = path.join(fixture, 'proj');
for (const d of [state, bin, proj]) fs.mkdirSync(d);
const standIn = path.join(bin, 'opencode');
fs.writeFileSync(standIn, '#!/bin/sh\necho "ready"\nwhile IFS= read -r l; do echo "GOT: $l"; done\n', { mode: 0o755 });
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [proj], skipLogin: true, profiles: { opencode: { command: standIn, label: 'OpenCode' }, shell: { command: 'zsh -fi', label: 'Shell' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
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
const type = (text) => { for (const ch of text) win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); };

(async () => {
  const lib = await import(pathToFileURL(path.join(root, 'lib.mjs')));
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'app window');
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('#launch .launch-item')`), 'the launcher');
  await js(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'OpenCode').click()`);
  await until(async () => (await screen()).includes('ready'), 'the stand-in agent');
  let me;
  await until(() => (me = lib.listAgents().find((a) => a.kind === 'opencode' && a.cwd === proj)), 'the agent discovered');
  const from = { id: 'planner', name: 'planner' };

  // the user is halfway through a prompt: the message waits
  await js(`document.querySelector('.term.visible .xterm-helper-textarea').focus()`);
  type('half typed');
  await until(async () => (await screen()).includes('half typed'), 'the half-typed prompt');
  lib.postMessage(from, me, 'Can you take the docs task?');
  await sleep(5000);
  assert.ok(!(await screen()).includes('Synapse: messages'), 'nothing typed over the user');
  assert.equal(lib.readJSON(lib.FILES.messages, []).filter((m) => !m.delivered).length, 1);

  // they clear it; once they have stopped typing for a while, the message comes in as the agent's prompt
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'U', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'U', modifiers: ['control'] });
  await until(async () => (await screen()).includes('GOT: Synapse: messages from other agents'), 'the wake prompt', 30000);
  await until(async () => (await screen()).includes('GOT: Can you take the docs task?'), 'the message itself');
  await until(async () => /GOT: Answer them with synapse_send/.test(await screen()), 'the reply hint');
  assert.equal(lib.readJSON(lib.FILES.messages, []).filter((m) => !m.delivered).length, 0, 'taken from the inbox');

  console.log('wake agents: ok');
  app.exit(0);
})().catch(async (e) => { console.error(e, await screen().catch(() => '')); app.exit(1); });
