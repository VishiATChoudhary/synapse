// Real Electron test for ⇧Enter in a shell tab. At the shell's own prompt it is Enter (the command runs); once a
// program like claude is in front of the shell it is the enhanced-keyboard newline agents read as "new line".
// `cat -v` stands in for the agent: it prints the bytes it gets, so the sequence shows on screen as ^[[13;2u.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/shift-enter.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-shift-enter-')));
const state = path.join(fixture, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { shell: { command: "env PS1='ready> ' zsh -fi", label: 'Shell' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO' || key === 'SYNAPSE_FAKE_REQUESTS') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const screen = () => js(`[...document.querySelectorAll('.term.visible .xterm-rows > div')].map((r) => r.textContent).join('\\n')`);
const type = (text) => { for (const ch of text) win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); };
const shiftEnter = () => {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['shift'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['shift'] });
};

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'app window');
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('#launch .launch-item')`), 'the launcher');
  await js(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Shell').click()`);
  await until(async () => /^ready>/m.test(await screen()), 'the shell prompt');

  // at the prompt ⇧Enter runs the command
  type('cat -v');
  shiftEnter();
  await sleep(1200);
  if ((await screen()).includes('13;2u')) throw new Error('the shell got the agent newline');
  // with cat in front, ⇧Enter is the agent newline
  shiftEnter();
  await until(async () => (await screen()).includes('^[[13;2u'), 'cat got the agent newline');

  console.log('shift enter: ok');
  app.exit(0);
})().catch(async (e) => { console.error(e, await screen().catch(() => '')); app.exit(1); });
