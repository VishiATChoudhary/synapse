// Real Electron test for dropping files and folders on a terminal. The drop goes through Chromium's own drag
// handling (DevTools Input.dispatchDragEvent with real paths, as from Finder); the paths land at the prompt quoted
// the way Terminal.app types them.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/drop-paths.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-drop-')));
const state = path.join(fixture, 'state'), folder = path.join(fixture, 'my folder'), file = path.join(fixture, 'notes.md');
fs.mkdirSync(state); fs.mkdirSync(folder); fs.writeFileSync(file, '# hi\n');
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
const screen = () => js(`[...document.querySelectorAll('.term.visible .xterm-rows > div')].map((r) => r.textContent).join('')`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'app window');
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('#launch .launch-item')`), 'the launcher');
  await js(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Shell').click()`);
  await until(async () => (await screen()).includes('ready>'), 'the shell prompt');

  const at = await js(`(() => { const r = document.querySelector('.term.visible').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const data = { items: [], files: [folder, file], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await dbg.sendCommand('Input.dispatchDragEvent', { type, ...at, data });
  dbg.detach();

  const want = `'${folder}' ${file}`;
  await until(async () => (await screen()).includes(want), `the paths at the prompt: ${want}`);
  console.log('drop paths: ok');
  app.exit(0);
})().catch(async (e) => { console.error(e, await screen().catch(() => '')); app.exit(1); });
