// Real Electron test for the agents list at the top of the sidebar: every running agent in one list across
// workspaces (shells left out), clicking one opens it, settling moves it into a folded "settled" group and back,
// settled survives a reload, the list folds, and the workspace boxes below stay as they were.
// `cat` stands in for the agents.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/agents-list.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-agents-list-')));
const state = path.join(fixture, 'state'), one = path.join(fixture, 'alpha'), two = path.join(fixture, 'beta');
for (const d of [state, one, two]) fs.mkdirSync(d);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({
  workspaces: [one, two], skipLogin: true,
  profiles: { claude: { command: 'cat', label: 'Claude Code' }, codex: { command: 'cat', label: 'Codex' }, shell: { command: "env PS1='ready> ' zsh -fi", label: 'Shell' } },
}));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
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
const shot = async (name) => { if (process.env.AGENTS_SHOTS) fs.writeFileSync(path.join(process.env.AGENTS_SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
const rows = () => js(`[...document.querySelectorAll('#tree .agents .agent-row')].map((r) => r.querySelector('.slot-kind').textContent + ':' + r.querySelector('.logo')?.className)`);
const names = () => js(`[...document.querySelectorAll('#tree .agents .agent-row .slot-kind')].map((k) => k.textContent)`);
const launch = (label) => js(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
const projects = () => js(`[...document.querySelectorAll('#tree .proj')].map((p) => p.querySelector('.proj-name').textContent + '=' + p.querySelectorAll('.slot').length)`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('#launch .launch-item')`), 'the launcher');
  assert.equal(await js(`document.querySelector('#tree .agents')`), null, 'no list without agents');

  // a Claude and a shell in alpha, a Codex in beta: open the workspace (its first tab, or the new-session picker
  // when it has none) and start the agent there
  const startIn = async (proj, label) => {
    const before = (await names()).length;
    const box = `[...document.querySelectorAll('#tree .proj')].find((p) => p.querySelector('.proj-name').textContent === ${JSON.stringify(proj)})`;
    if (await js(`${box}.classList.contains('closed')`)) { await js(`${box}.querySelector('.proj-head').click()`); await until(() => js(`!${box}.classList.contains('closed')`), `${proj} open`); }
    await js(`${box}.querySelector('.wt-head').click()`);
    await sleep(400);
    if (await js(`!document.querySelector('#modal').hidden`)) await js(`[...document.querySelectorAll('#modal .opt')].find((o) => o.textContent.includes(${JSON.stringify(label)})).click()`);
    else await launch(label);
    if (label !== 'Shell') await until(async () => (await names()).length === before + 1, `${label} listed`);
    else await sleep(800);
  };
  await startIn('alpha', 'Claude');
  await startIn('alpha', 'Shell');
  await startIn('beta', 'Codex');
  const slots = await projects();

  // across workspaces, newest first, shells left out; the workspace boxes are untouched
  assert.deepEqual(await names(), ['beta', 'alpha']);
  assert.equal(await js(`document.querySelector('#tree .agents-head .proj-count').textContent`), '2');
  await sleep(500); await shot('list');

  // clicking the alpha agent opens it
  await js(`[...document.querySelectorAll('#tree .agent-row')].find((r) => r.textContent.includes('alpha')).click()`);
  await until(() => js(`document.querySelector('#tree .agent-row.focused .slot-kind')?.textContent === 'alpha'`), 'alpha focused');
  await until(() => js(`document.querySelector('#tree .slot.focused')?.closest('.proj').querySelector('.proj-name').textContent === 'alpha'`), 'its tab focused');

  // settle the beta agent: it leaves the list into a folded settled group
  await js(`[...document.querySelectorAll('#tree .agent-row')].find((r) => r.textContent.includes('beta')).querySelector('.agent-settle').click()`);
  await until(async () => JSON.stringify(await names()) === '["alpha"]', 'beta settled');
  assert.equal(await js(`document.querySelector('#tree .agents-settled').textContent`), '▸ settled 1');
  assert.equal(await js(`document.querySelector('#tree .agents-head .proj-count').textContent`), '1');
  assert.deepEqual(await projects(), slots, 'settling keeps the workspace boxes');

  // unfold settled, it shows there; survives a reload of the window
  await js(`document.querySelector('#tree .agents-settled').click()`);
  await until(async () => (await names()).length === 2, 'settled shown');
  await sleep(500); await shot('settled');
  win.webContents.reload();
  await until(() => js(`!!document.querySelector('#tree .agents-settled')`), 'list after reload', 20000);
  await until(() => js(`document.querySelector('#tree .agents-settled').textContent === '▾ settled 1'`), 'still settled after reload');

  // bring it back
  await js(`[...document.querySelectorAll('#tree .agent-row')].find((r) => r.textContent.includes('beta')).querySelector('.agent-settle').click()`);
  await until(() => js(`!document.querySelector('#tree .agents-settled') && document.querySelectorAll('#tree .agent-row').length === 2`), 'beta back');

  // the list folds to its tab
  await js(`document.querySelector('#tree .agents-head').click()`);
  await until(() => js(`document.querySelector('#tree .agents.closed') && !document.querySelector('#tree .agent-row')`), 'folded');
  await js(`document.querySelector('#tree .agents-head').click()`);
  await until(() => js(`document.querySelectorAll('#tree .agent-row').length === 2`), 'unfolded');

  assert.deepEqual(errors, []);
  console.log('agents list: ok');
  app.exit(0);
})().catch(async (e) => { console.error(e, errors); await shot('failure').catch(() => {}); app.exit(1); });
