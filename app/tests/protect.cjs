// Real Electron test for protected folders: right-click a checkout > Protect marks it read only (kept in app.json),
// a worktree its repo gets afterwards (what an agent following the rule makes) opens in the sidebar by itself, and
// Unprotect takes it back.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/protect.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-protect-ui-')));
const state = path.join(fixture, 'state'), repo = path.join(fixture, 'staging');
for (const d of [state, repo]) fs.mkdirSync(d);
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
git('init', '-q', '-b', 'main'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one');
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [repo], skipLogin: true, profiles: { shell: { command: 'zsh -fi', label: 'Shell' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_CLAUDE_HOME: path.join(fixture, 'claude'), SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
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
const cfg = () => JSON.parse(fs.readFileSync(path.join(state, 'app.json'), 'utf8'));
const menu = async (label) => {
  await js(`(() => { const r = document.querySelector('#tree .wt-head').getBoundingClientRect(); document.querySelector('#tree .wt-head').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8 })); })()`);
  await until(() => js(`[...document.querySelectorAll('.menu-item')].some((m) => m.textContent.includes(${JSON.stringify(label)}))`), `menu: ${label}`);
  await js(`[...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes(${JSON.stringify(label)})).click()`);
};

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('#tree .wt-head')`), 'the checkout row');

  await menu('Protect (read only)');
  await until(() => cfg().protected?.includes(repo), 'kept in app.json');
  await until(() => js(`!!document.querySelector('#tree .wt-head .wt-lock')`), 'the read only badge');

  // an agent following the rule makes a worktree for its change: it opens in the sidebar by itself
  const wt = path.join(fixture, 'feat-login');
  git('worktree', 'add', '-q', '-b', 'feat-login', wt);
  await until(() => cfg().workspaces.includes(wt), 'the new worktree added', 20000);
  await until(() => js(`[...document.querySelectorAll('#tree .wt-name')].some((n) => n.textContent.includes('feat-login'))`), 'shown in the sidebar');
  assert.equal(await js(`document.querySelectorAll('#tree .wt-lock').length`), 1, 'the new worktree is not protected');

  await menu('Unprotect');
  await until(() => !cfg().protected?.includes(repo), 'unprotected');
  await until(() => js(`!document.querySelector('#tree .wt-lock')`), 'badge gone');

  assert.deepEqual(errors, []);
  console.log('protect: ok');
  app.exit(0);
})().catch((e) => { console.error(e, errors); app.exit(1); });
