// Real Electron regression test for terminal keys: what reaches the pty for Enter, Backspace and
// their ⌘ variants. All app state and PTYs belong to a temporary fixture.
// Run: npm --prefix app run test:keys
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-keys-'));
const state = path.join(fixture, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], profiles: { shell: { command: 'cat', label: 'Shell' }, claude: { command: 'cat', label: 'Claude Code' } } }));
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

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  ipcMain.removeHandler('pty:write');
  ipcMain.handle('pty:write', (_e, { data }) => { written.push(data); return { ok: true, value: null }; });
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('.term.visible .xterm-helper-textarea')`), 'first session');
  await until(() => js(`document.querySelector('.term.visible')?.contains(document.activeElement)`), 'terminal focus');

  const got = {
    enter: await press('Enter'),
    backspace: await press('Backspace'),
    metaEnter: await press('Enter', ['meta']),
    metaBackspace: await press('Backspace', ['meta']),
    metaLeft: await press('Left', ['meta']),
    metaRight: await press('Right', ['meta']),
    shiftMetaBackspace: await press('Backspace', ['meta', 'shift']),
    shellShiftEnter: await press('Enter', ['shift']),
  };
  // ⇧Enter in an agent tab is the CSI u form Claude Code and Codex read as a newline; a shell gets plain Enter
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '1', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '1', modifiers: ['control'] });
  await until(() => js(`document.querySelectorAll('.term').length === 2 && document.querySelector('.term.visible:last-child')?.contains(document.activeElement)`), 'agent session focused');
  await sleep(200);
  got.agentShiftEnter = await press('Enter', ['shift']);
  got.agentEnter = await press('Enter');
  console.log('bytes', JSON.stringify(got));
  assert.equal(got.enter, '\r', 'Enter sends CR');
  assert.equal(got.backspace, '\x7f', 'Backspace sends DEL');
  assert.equal(got.metaEnter, '\r', '⌘Enter submits like Enter');
  assert.equal(got.metaBackspace, '\x15', '⌘⌫ clears the line (^U)');
  assert.equal(got.metaLeft, '\x01', '⌘← goes to the start of the line (^A)');
  assert.equal(got.metaRight, '\x05', '⌘→ goes to the end of the line (^E)');
  assert.equal(got.shiftMetaBackspace, '', '⇧⌘⌫ is the app\'s pop shortcut, nothing reaches the pty');
  assert.equal(got.shellShiftEnter, '\r', '⇧Enter in a shell is a plain Enter');
  assert.equal(got.agentShiftEnter, '\x1b[13;2u', '⇧Enter in an agent tab is a newline (CSI u)');
  assert.equal(got.agentEnter, '\r', 'Enter in an agent tab still submits');
  assert.equal(await js(`document.querySelector('#toast').textContent`), 'nothing to pop', '⇧⌘⌫ pops');
  assert.deepEqual(errors, []);
  console.log('PASS terminal keys');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  app.once('will-quit', () => { fs.rmSync(fixture, { recursive: true, force: true }); app.exit(process.exitCode || 0); });
  app.quit();
});
