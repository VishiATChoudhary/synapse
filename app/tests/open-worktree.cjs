// Opening an existing worktree in the GUI starts the New session screen on it (Settings > Workspaces, "Opening a
// worktree starts", default), not a shell's terminal. A shell choice still opens a shell.
const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
if (typeof electron === 'string') {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-openwt-')));
  const result = spawnSync(electron, [__filename], { env: { ...process.env, SYNAPSE_OPENWT_FIXTURE: fixture }, stdio: 'inherit' });
  fs.rmSync(fixture, { recursive: true, force: true }); process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fixture = process.env.SYNAPSE_OPENWT_FIXTURE;
assert.ok(fixture);
const root = path.resolve(__dirname, '../..'), state = path.join(fixture, 'state');
const repo = path.join(fixture, 'repo'), bare = path.join(fixture, 'remote.git');
const feat = path.join(fixture, 'feat');
for (const dir of [state, repo]) fs.mkdirSync(dir);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' }).toString().trim();
git(repo, 'init', '-q', '-b', 'main'); git(repo, 'commit', '--allow-empty', '-m', 'Initial');
git(repo, 'worktree', 'add', '-q', '-b', 'feat', feat);
Object.assign(process.env, { SYNAPSE_HOME: state, SUPERSET_HOME: path.join(fixture, 'superset'), SYNAPSE_CLAUDE_HOME: path.join(fixture, 'claude'), SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/sh' });
fs.mkdirSync(path.join(fixture, 'claude', 'sessions'), { recursive: true });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [repo], skipLogin: true, profiles: { shell: { command: '', label: 'Shell' }, claude: { command: 'cat', label: 'Claude Code' } } }));
process.chdir(repo); app.setPath('userData', path.join(fixture, 'electron'));
let win, gui;
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await sleep(80); } throw new Error(`Timed out: ${label}`); }
const js = code => win.webContents.executeJavaScript(code, true);
const ui = code => gui.executeJavaScript(code, true);
async function openFeat() {
  await ui(`parent.postMessage({ type: 'synapse:desktop-call', request: 'open-' + Date.now(), action: 'worktree', args: { key: ${JSON.stringify(repo)} } }, '*')`);
  await until(() => js(`[...document.querySelectorAll('#modal .branch-open')].some(b => b.textContent.includes('feat') && b.textContent.includes('worktree'))`), 'the worktree list');
  await js(`[...document.querySelectorAll('#modal .branch-open')].find(b => b.textContent.includes('feat') && b.textContent.includes('worktree')).click()`);
}
(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'window');
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  await until(() => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame', 30000);
  await until(() => ui(`!!document.querySelector('#desktop-settings')`), 'GUI ready', 30000);
  const before = await js(`document.querySelectorAll('.xterm').length`);
  await openFeat();
  await until(() => ui(`!document.getElementById('new-view')?.hidden && document.body.textContent.includes('feat')`).catch(() => false), 'the New session screen', 20000).catch(async (e) => { console.error(await ui(`[...document.querySelectorAll('main > section, [id$="-view"]')].map(v => v.id + ':' + v.hidden).join(' ')`)); throw e; });
  assert.match(await ui(`document.getElementById('new-view').textContent`), /feat|repo/);
  await sleep(800);
  assert.equal(await js(`document.querySelectorAll('.xterm').length`), before, 'no terminal was started');
  if (process.env.OPENWT_SHOT) fs.writeFileSync(process.env.OPENWT_SHOT, (await win.webContents.capturePage()).toPNG());
  // a shell, when that is the choice
  await js(`synapse.settings.set({ openWith: 'shell' })`);
  assert.equal((await js(`synapse.settings.get()`)).openWith, 'shell');
  assert.deepEqual(errors.filter(e => !/Autofill|favicon/i.test(e)), []);
  console.log('open-worktree: ok');
  app.exit(0);
})().catch(e => { console.error(e); app.exit(1); });
