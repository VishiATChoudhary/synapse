// Real Electron test: what a new worktree opens with is a setting (Settings > Workspaces). Set to Claude, the first
// launch and a new worktree start Claude instead of a shell; set back to a shell, they open a shell again.
// Run: npx electron tests/open-with.cjs
const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
if (typeof electron === 'string') {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-open-with-')));
  const result = spawnSync(electron, [__filename], { env: { ...process.env, SYNAPSE_OPEN_WITH_FIXTURE: fixture }, stdio: 'inherit' });
  fs.rmSync(fixture, { recursive: true, force: true }); process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fixture = process.env.SYNAPSE_OPEN_WITH_FIXTURE;
assert.ok(fixture);
const root = path.resolve(__dirname, '../..'), state = path.join(fixture, 'state'), repo = path.join(fixture, 'repo'), bin = path.join(fixture, 'bin');
for (const dir of [state, repo, bin]) fs.mkdirSync(dir);
const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' }).toString().trim();
git('init', '-q', '-b', 'main'); git('commit', '--allow-empty', '-m', 'Initial');
fs.writeFileSync(path.join(bin, 'gh'), "#!/bin/sh\nprintf '[]'\n", { mode: 0o755 });
// a stand-in Claude: notes the folder it started in, then waits like an agent at its prompt
const started = path.join(fixture, 'claude-started');
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\npwd -P >> ${JSON.stringify(started)}\nexec cat\n`, { mode: 0o755 });
Object.assign(process.env, { SYNAPSE_HOME: state, SUPERSET_HOME: path.join(fixture, 'superset'), SHELL: '/bin/sh', PATH: `${bin}:${process.env.PATH}` });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG') delete process.env[key];
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ safeWorktreeDelete: false, openWith: 'claude', workspaces: [repo], profiles: { shell: { command: 'cat', label: 'Shell' }, claude: { command: path.join(bin, 'claude'), label: 'Claude' } } }));
process.chdir(repo); app.setPath('userData', path.join(fixture, 'electron'));
let win, failed = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await sleep(50); } throw new Error(`Timed out: ${label}`); }
const js = (code) => win.webContents.executeJavaScript(code, true);
const startedIn = () => { try { return fs.readFileSync(started, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const count = () => js(`document.querySelectorAll('.term').length`);
async function newWorktree(name) {
  await js(`document.querySelector('.proj-add').click()`);
  await until(() => js(`!!document.querySelector('[data-mode="new"]')`), 'worktree picker');
  await js(`document.querySelector('[data-mode="new"]').click()`);
  await js(`(() => { const i = document.querySelector('#modal-body input'); i.value = ${JSON.stringify(name)}; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until(async () => (await js('synapse.state()')).projects.flatMap((p) => p.worktrees).some((w) => w.branch === name), `worktree ${name}`);
  return (await js('synapse.state()')).projects.flatMap((p) => p.worktrees).find((w) => w.branch === name).path;
}
(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'window');
  await until(async () => await count() === 1, 'the first session');
  await until(() => startedIn().includes(repo), 'the first launch started Claude, not a shell').catch(async (e) => { console.error('debug', JSON.stringify(await js(`[...document.querySelectorAll('.slot-title')].map((e) => e.textContent)`)), JSON.stringify(startedIn()), repo, JSON.stringify((await js('synapse.state()')).openWith)); throw e; });
  const a = await newWorktree('feature-a');
  await until(async () => await count() === 2, 'a session in the new worktree');
  await until(() => startedIn().includes(a), 'the new worktree started Claude');
  console.log('PASS open with Claude: the first launch and a new worktree start Claude');
  // an unknown kind falls back to a shell; set to a shell, a new worktree opens a shell
  assert.equal((await js(`synapse.settings.set({ openWith: 'nope' })`)).openWith, 'shell');
  assert.equal((await js(`synapse.settings.set({ openWith: 'shell' })`)).openWith, 'shell');
  // the renderer reads it from state on its next refresh
  await js(`synapse.state()`);
  await sleep(1500);
  const before = startedIn().length;
  const b = await newWorktree('feature-b');
  await until(async () => await count() === 3, 'a session in the second worktree');
  await sleep(800);
  assert.equal(startedIn().length, before, 'no Claude for the second worktree');
  assert.ok(!startedIn().includes(b));
  console.log('PASS open with a shell: a new worktree opens a shell');
})().catch((e) => { failed = true; console.error(e); }).finally(() => { app.exit(failed ? 1 : 0); });
