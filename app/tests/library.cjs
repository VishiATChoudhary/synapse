// Real Electron regression test for the workspace library: folders added from elsewhere get a
// symlink in <SYNAPSE_HOME>/workspaces, the library tab lists them, and the setting turns it off.
// All app state and PTYs belong to a temporary fixture.
// Run: npm --prefix app run test:library
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-library-'));
const state = path.join(fixture, 'state');
const lib = path.join(state, 'workspaces');
const dir = (...p) => { const d = path.join(fixture, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const alpha = dir('code', 'alpha'), beta = dir('code', 'beta'), beta2 = dir('other', 'beta'), gamma = dir('code', 'gamma');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [alpha], profiles: { shell: { command: 'cat', label: 'Shell' } } }));
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
const linkOf = (name) => { try { return fs.readlinkSync(path.join(lib, name)); } catch { return null; } };
const config = () => JSON.parse(fs.readFileSync(path.join(state, 'app.json'), 'utf8'));

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('.term.visible .xterm-helper-textarea')`), 'first session');

  // a workspace that was already in app.json is linked on startup
  assert.equal(linkOf('alpha'), alpha, 'backfill links existing workspaces');
  assert.equal(config().autoSymlink, true, 'setting defaults to on');

  // adding a folder links it; a second folder with the same name gets a suffix; adding twice makes no second link
  await js(`synapse.project.add(${JSON.stringify(beta)})`);
  assert.equal(linkOf('beta'), beta);
  await js(`synapse.project.add(${JSON.stringify(beta2)})`);
  assert.equal(linkOf('beta-2'), beta2, 'name clash gets -2');
  await js(`synapse.project.add(${JSON.stringify(beta)})`);
  assert.equal(fs.readdirSync(lib).filter((n) => n.startsWith('beta')).length, 2, 'no duplicate link for the same target');

  // the library lists real folders and links alike, resolved, and knows which are already added
  fs.mkdirSync(path.join(lib, 'delta'));
  fs.symlinkSync(path.join(fixture, 'nowhere'), path.join(lib, 'dangling'));
  const listed = await js(`synapse.project.library()`);
  assert.deepEqual(listed.map((w) => [w.name, w.added, w.link]), [['alpha', true, true], ['beta', true, true], ['beta-2', true, true], ['delta', false, false]]);
  assert.equal(listed[2].path, fs.realpathSync(beta2), 'paths come back resolved');

  // turning the setting off stops new links and the backfill; existing links stay
  assert.deepEqual(await js(`synapse.settings.set({ autoSymlink: false })`), { autoSymlink: false });
  await js(`synapse.project.add(${JSON.stringify(gamma)})`);
  assert.equal(linkOf('gamma'), null, 'no link while the setting is off');
  assert.equal(linkOf('alpha'), alpha, 'old links stay');
  assert.equal((await js(`synapse.settings.get()`)).autoSymlink, false);
  console.log('PASS library links and setting');

  // the + workspace modal opens on the library tab when it has entries, and picking an entry adds it
  await js(`document.querySelector('#add-project').click()`);
  await until(() => js(`!document.querySelector('#modal').hidden && document.querySelector('.modal .seg button.on')?.textContent === 'library'`), 'library tab');
  await until(() => js(`document.querySelectorAll('.modal .lib .opt').length === 4`), 'four library rows');
  await js(`[...document.querySelectorAll('.modal .lib .opt')].find((o) => o.textContent.includes('delta')).click()`);
  await until(() => config().workspaces.includes(fs.realpathSync(path.join(lib, 'delta'))), 'delta added from the library');
  await until(() => js(`document.querySelector('#modal').hidden`), 'modal closed');

  // settings modal: ⌘, opens it with the checkbox reflecting the stored value
  await js(`dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))`);
  await until(() => js(`!document.querySelector('#modal').hidden && document.querySelector('#modal-title').textContent === 'settings'`), 'settings modal');
  assert.equal(await js(`document.querySelector('#modal input[type=checkbox]').checked`), false);
  assert.deepEqual(errors, []);
  console.log('PASS library tab and settings modal');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  app.once('will-quit', () => { fs.rmSync(fixture, { recursive: true, force: true }); app.exit(process.exitCode || 0); });
  app.quit();
});
