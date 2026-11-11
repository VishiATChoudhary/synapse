// Real Electron test: right-click a workspace, Browser, pick a Chrome profile. It is kept for the workspace, shows
// as the menu's label, and a terminal started there gets the profile for Codex's Chrome plugin. Chrome is a stand-in
// folder (SYNAPSE_CHROME_DIR) with two profiles.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-browser-ui-')));
const state = path.join(fixture, 'state'), repo = path.join(fixture, 'acme'), chrome = path.join(fixture, 'chrome'), dump = path.join(fixture, 'env.txt');
for (const d of [state, repo, chrome]) fs.mkdirSync(d);
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
git('init', '-q', '-b', 'main'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one');
fs.writeFileSync(path.join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 13': { name: 'acme.dev', user_name: 'me@acme.dev' }, Default: { name: 'Me', user_name: 'me@gmail.com' } } } }));
fs.mkdirSync(path.join(chrome, 'Profile 13', 'Extensions', 'fcoeoabgfenejglbffodgkkbkcdhcgfn'), { recursive: true });
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [repo], skipLogin: true, profiles: { shell: { command: 'zsh -fi', label: 'Shell' }, envdump: { command: `env > ${dump}; sleep 600`, label: 'Envdump' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CHROME_DIR: chrome, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_CLAUDE_HOME: path.join(fixture, 'claude'), SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO' || key === 'SYNAPSE_FAKE_REQUESTS') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const chosen = () => { try { return JSON.parse(fs.readFileSync(path.join(state, 'browsers.json'), 'utf8')); } catch { return {}; } };
const open = async () => {
  await js(`document.body.click()`);
  await js(`(() => { const r = document.querySelector('#tree .wt-head').getBoundingClientRect(); document.querySelector('#tree .wt-head').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8 })); })()`);
  await until(() => js(`[...document.querySelectorAll('.menu-item.has-sub')].some((m) => m.firstChild.textContent.startsWith('Browser'))`), 'the Browser item');
};
const browserItem = `[...document.querySelectorAll('.menu-item.has-sub')].find((m) => m.firstChild.textContent.startsWith('Browser'))`;
const subLabels = () => js(`[...${browserItem}.querySelectorAll('.menu-sub .menu-item')].map((m) => m.textContent)`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('#tree .wt-head')`), 'the checkout row');

  await open();
  assert.equal(await js(`${browserItem}.firstChild.textContent`), 'Browser');
  const labels = await subLabels();
  assert.equal(labels[0], '✓ Agents choose');
  assert.ok(labels.some((l) => l === 'acme.dev  (me@acme.dev · no Codex extension)'), labels.join(' | '));
  assert.ok(labels.some((l) => l.startsWith('Me  (me@gmail.com · no Claude extension')), labels.join(' | '));
  await js(`[...${browserItem}.querySelectorAll('.menu-sub .menu-item')].find((m) => m.textContent.startsWith('acme.dev')).click()`);
  await until(() => Object.values(chosen()).includes('Profile 13'), 'kept for the workspace');

  await open();
  assert.equal(await js(`${browserItem}.firstChild.textContent`), 'Browser: acme.dev');
  assert.ok((await subLabels()).some((l) => l.startsWith('✓ acme.dev')));
  assert.ok((await subLabels()).includes('Open acme.dev in Chrome'));
  await js(`document.body.click()`);

  // a terminal started in the workspace carries the profile for Codex
  await open();
  await js(`[...document.querySelectorAll('.menu-item.has-sub')].find((m) => m.firstChild.textContent === 'New agent').querySelector('.menu-sub .menu-item:nth-child(2)') && [...[...document.querySelectorAll('.menu-item.has-sub')].find((m) => m.firstChild.textContent === 'New agent').querySelectorAll('.menu-sub .menu-item')].find((m) => m.textContent === 'Envdump').click()`);
  await until(() => fs.existsSync(dump) && fs.readFileSync(dump, 'utf8').includes('CODEX_CHROMIUM_PREFERENCES_PATH'), 'the terminal env', 20000);
  assert.match(fs.readFileSync(dump, 'utf8'), new RegExp(`CODEX_CHROMIUM_PREFERENCES_PATH=${path.join(chrome, 'Profile 13', 'Preferences').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  // back to the agents choosing
  await open();
  await js(`[...${browserItem}.querySelectorAll('.menu-sub .menu-item')].find((m) => m.textContent === 'Agents choose').click()`);
  await until(() => !Object.keys(chosen()).length, 'choice removed');

  assert.deepEqual(errors, []);
  console.log('browser-menu: ok');
  app.exit(0);
})().catch((e) => { console.error(e, errors); app.exit(1); });
