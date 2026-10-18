// Real Electron regression test for modal keyboard focus: a digit in the agent picker launches that
// profile instead of reaching the terminal, and ⌘W on a live agent asks first while a shell just closes.
// All app state and PTYs belong to a temporary fixture.
// Run: npm --prefix app run test:modal
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-modal-'));
const state = path.join(fixture, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], profiles: { shell: { command: 'cat', label: 'Shell' }, claude: { command: 'cat', label: 'Fixture agent' } } }));
process.env.SYNAPSE_HOME = state;
process.env.SYNAPSE_DEMO = '1';
process.env.SHELL = '/bin/sh';
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(25); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);

// everything the renderer writes to any pty, so the test sees bytes instead of shell output
const written = [];
async function press(keyCode, modifiers = []) {
  written.length = 0;
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await sleep(150);
  return written.join('');
}
const terms = () => js(`document.querySelectorAll('.term').length`);
const modalShown = () => js(`!document.querySelector('#modal').hidden`);
const modalTitle = () => js(`document.querySelector('#modal-title').textContent`);
const modalText = () => js(`document.querySelector('#modal-body').textContent`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  ipcMain.removeHandler('pty:write');
  ipcMain.handle('pty:write', (_e, { data }) => { written.push(data); return { ok: true, value: null }; });
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('.term.visible .xterm-helper-textarea')`), 'first session');
  await until(() => js(`document.querySelector('.term.visible')?.contains(document.activeElement)`), 'terminal focus');
  assert.equal(await terms(), 1, 'one shell to start');

  // ⌘N opens the picker; "1" is the first agent profile and launches it. The digit never reaches the pty.
  await press('N', ['meta']);
  await until(modalShown, 'picker open');
  assert.equal(await modalTitle(), 'new session');
  assert.equal(await js(`document.querySelector('#modal-body').contains(document.activeElement)`), true, 'the picker holds keyboard focus');
  const digit = await press('1');
  assert.equal(digit, '', 'the digit is not typed into the terminal');
  await until(async () => !(await modalShown()) && (await terms()) === 2, 'digit launches the agent');
  await until(() => js(`document.querySelector('.term.visible:last-child')?.contains(document.activeElement)`), 'new agent session focused');

  // ⌘W on a live agent asks first, even when it is idle. Escape keeps it.
  await press('W', ['meta']);
  await until(modalShown, 'close asks');
  assert.equal(await modalTitle(), 'sure?');
  assert.match(await modalText(), /agent/i, 'the question mentions the agent');
  await press('Escape');
  await until(async () => !(await modalShown()), 'escape keeps the session');
  assert.equal(await terms(), 2, 'agent still open after Escape');

  // Enter in the question closes it, exactly once.
  await press('W', ['meta']);
  await until(modalShown, 'close asks again');
  await press('Enter');
  await until(async () => !(await modalShown()) && (await terms()) === 1, 'enter closes the agent');

  // A shell closes straight away, no question.
  await until(() => js(`document.querySelector('.term.visible')?.contains(document.activeElement)`), 'shell focused again');
  await press('W', ['meta']);
  await until(async () => (await terms()) === 0, 'shell closes without asking');
  assert.equal(await modalShown(), false, 'no question for a shell');

  assert.deepEqual(errors, []);
  console.log('PASS modal focus, picker digits, close confirmation');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  app.once('will-quit', () => { fs.rmSync(fixture, { recursive: true, force: true }); app.exit(process.exitCode || 0); });
  app.quit();
});
