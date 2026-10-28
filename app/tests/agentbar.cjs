// Real Electron test for the active-agents bar in the GUI window toolbar (terminal mode lists them in the sidebar): every running agent across workspaces, the most
// recently started first, a click switches to it, and it collapses to its status squares (remembered).
// `cat` stands in for the agents. Run: SYNAPSE_APP_PORT=<free port> npx electron tests/agentbar.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-agentbar-')));
const state = path.join(fixture, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { shell: { command: 'cat', label: 'Shell' }, claude: { command: 'cat', label: 'Fixture agent' } } }));
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
const chips = () => js(`[...document.querySelectorAll('#agentbar .agent-chip')].map((c) => c.title.split(' · ')[0])`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show();
  await until(() => js(`!!document.querySelector('#launch .launch-item')`), 'launcher');
  assert.equal(await js(`document.querySelector('#agentbar').hidden`), true, 'no agents, no bar');

  for (const name of ['first', 'second']) {
    const before = await js(`document.querySelectorAll('.term').length`);
    await js(`document.querySelector('#launch .launch-item').click()`);
    await until(() => js(`document.querySelectorAll('.term').length === ${before + 1}`), `${name} agent`);
    await until(async () => (await chips()).length === (name === 'first' ? 1 : 2), `${name} chip`);
    await sleep(50); // two agents never start in the same millisecond
  }
  await until(() => js(`document.querySelectorAll('#agentbar .agent-chip')[0].classList.contains('on')`), 'newest agent focused and first');
  const [newest, older] = await js(`[...document.querySelectorAll('#agentbar .agent-chip')].map((c) => Number(c.dataset.session))`);
  assert.ok(newest > older, 'the agent started last is first');

  await js(`document.querySelectorAll('#agentbar .agent-chip')[1].click()`);
  await until(() => js(`document.querySelectorAll('#agentbar .agent-chip')[1].classList.contains('on')`), 'clicking a chip switches to that agent');
  assert.equal(await js(`Number(document.querySelectorAll('#agentbar .agent-chip')[0].dataset.session)`), newest, 'switching does not reorder the stack');

  await js(`document.querySelector('#agentbar .agentbar-toggle').click()`);
  assert.equal(await js(`document.querySelector('#agentbar').classList.contains('collapsed')`), true);
  assert.equal(await js(`document.querySelectorAll('#agentbar .agent-chip .label').length`), 0, 'collapsed: status squares only');
  assert.equal(await js(`document.querySelectorAll('#agentbar .agent-chip .dot').length`), 2);
  assert.match(await js(`document.querySelector('#agentbar .agentbar-toggle').textContent`), /active 2/);
  await sleep(1200); // a state refresh redraws the bar; it stays collapsed
  assert.equal(await js(`document.querySelector('#agentbar').classList.contains('collapsed')`), true, 'collapse survives redraws');
  await js(`document.querySelector('#agentbar .agentbar-toggle').click()`);
  assert.equal(await js(`document.querySelectorAll('#agentbar .agent-chip .label').length`), 2, 'expanded again');
  assert.equal(await js(`document.querySelector('#agentbar').parentElement.className`), 'desktop-toolbar', 'GUI mode: in the window toolbar');
  if (process.env.AGENTBAR_SHOT) fs.writeFileSync(`${process.env.AGENTBAR_SHOT}-gui.png`, (await win.webContents.capturePage()).toPNG());
  // terminal mode: no bar, the sidebar lists the same agents instead
  await js(`document.querySelector('#mode-terminal').click()`);
  await until(() => js(`document.querySelector('#agentbar').hidden && document.querySelectorAll('#tree .agent-row').length === 2`), 'terminal mode: the agents in the sidebar, not a bar');
  await js(`document.querySelectorAll('#tree .agent-row')[1].click()`);
  await until(() => js(`document.querySelectorAll('#tree .agent-row')[1].classList.contains('focused')`), 'terminal mode: click switches');
  if (process.env.AGENTBAR_SHOT) fs.writeFileSync(`${process.env.AGENTBAR_SHOT}-term.png`, (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, []);
  console.log('PASS active agents bar: newest first, click switches, collapses to status squares; sidebar list in terminal mode');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  app.once('will-quit', () => { fs.rmSync(fixture, { recursive: true, force: true }); app.exit(process.exitCode || 0); });
  app.quit();
});
