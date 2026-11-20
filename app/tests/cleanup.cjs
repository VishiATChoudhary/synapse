// Settings > Cleanup in a real Electron run: an unused worktree is saved, pushed and removed; a fresh one stays;
// the agent tidy settings reach the GUI's preferences. Disposable repos, a local bare remote.
const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
if (typeof electron === 'string') {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-cleanup-')));
  const result = spawnSync(electron, [__filename], { env: { ...process.env, SYNAPSE_CLEANUP_FIXTURE: fixture }, stdio: 'inherit' });
  fs.rmSync(fixture, { recursive: true, force: true }); process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fixture = process.env.SYNAPSE_CLEANUP_FIXTURE;
assert.ok(fixture);
const root = path.resolve(__dirname, '../..'), state = path.join(fixture, 'state');
const repo = path.join(fixture, 'repo'), bare = path.join(fixture, 'remote.git');
const old = path.join(fixture, 'old'), fresh = path.join(fixture, 'fresh');
for (const dir of [state, repo]) fs.mkdirSync(dir);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' }).toString().trim();
git(repo, 'init', '-q', '-b', 'main'); git(repo, 'commit', '--allow-empty', '-m', 'Initial');
execFileSync('git', ['init', '-q', '--bare', bare]);
git(repo, 'remote', 'add', 'origin', bare); git(repo, 'push', '-q', 'origin', 'main');
git(repo, 'worktree', 'add', '-q', '-b', 'old-feature', old);
git(repo, 'worktree', 'add', '-q', '-b', 'fresh-feature', fresh);
fs.writeFileSync(path.join(old, 'unsaved.txt'), 'work nobody committed');
// last used 20 days ago: the folder (and so its birth time on APFS) and its HEAD
const past = new Date(Date.now() - 20 * 86_400_000);
for (const f of [old, path.join(repo, '.git/worktrees/old/HEAD'), path.join(repo, '.git/worktrees/old/logs/HEAD')]) fs.utimesSync(f, past, past);
Object.assign(process.env, { SYNAPSE_HOME: state, SUPERSET_HOME: path.join(fixture, 'superset'), SYNAPSE_CLAUDE_HOME: path.join(fixture, 'claude'), SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/sh' });
fs.mkdirSync(path.join(fixture, 'claude', 'sessions'), { recursive: true });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
const DAY = 86_400_000;
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [repo, old, fresh], worktreeGc: { after: 7 * DAY, action: 'push', every: 0 }, skipLogin: true, profiles: { shell: { command: 'cat', label: 'Shell' } } }));
process.chdir(repo); app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await sleep(50); } throw new Error(`Timed out: ${label}`); }
const js = code => win.webContents.executeJavaScript(code, true);
(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'window');
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  await until(() => win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')), 'GUI frame', 30000);
  await until(() => js(`!!document.querySelector('#desktop-settings')`), 'settings button', 30000);
  await js(`document.querySelector('#desktop-settings').click()`);
  await until(() => js(`!!document.querySelector('[data-settings-pane="cleanup"]')`), 'settings open');
  await js(`document.querySelector('[data-settings-pane="cleanup"]').click()`);
  await until(() => js(`document.querySelectorAll('.gc-row').length === 2`), 'both worktrees listed');
  assert.deepEqual(await js(`[...document.querySelectorAll('.gc-row')].map(r => [r.querySelector('.gc-name').textContent, r.classList.contains('due')])`), [['old', true], ['fresh', false]]);
  assert.match(await js(`[...document.querySelectorAll('.set-row')].find(r => r.textContent.includes('Run it now')).textContent`), /1 due now/);
  if (process.env.SETTINGS_SHOT) { // pictures of Settings, for looking at them
    win.setBounds({ width: 1300, height: 900 }); await sleep(500);
    for (const p of ['cleanup', 'general', 'agents', 'browser']) { await js(`document.querySelector('[data-settings-pane="${p}"]').click()`); await sleep(400); require('fs').writeFileSync(`${process.env.SETTINGS_SHOT}-${p}.png`, (await win.webContents.capturePage()).toPNG()); }
    await js(`document.querySelector('[data-settings-pane="cleanup"]').click()`); await sleep(300);
  }

  await js(`[...document.querySelectorAll('.set-btn')].find(b => b.textContent === 'Clean up now').click()`);
  await until(() => js(`document.querySelectorAll('.gc-row').length === 1`), 'old worktree cleaned up');
  assert.equal(fs.existsSync(old), false, 'the unused folder is gone');
  assert.equal(fs.existsSync(fresh), true, 'the fresh one stays');
  assert.match(git(bare, 'show', 'old-feature:unsaved.txt'), /work nobody committed/, 'uncommitted work was committed and pushed');
  assert.equal(git(bare, 'rev-parse', 'main'), git(repo, 'rev-parse', 'main'), 'main untouched');
  const cfg = JSON.parse(fs.readFileSync(path.join(state, 'app.json'), 'utf8'));
  assert.deepEqual(cfg.workspaces.sort(), [repo, fresh].sort());
  const log = JSON.parse(fs.readFileSync(path.join(state, 'worktree-gc.json'), 'utf8')).last;
  assert.deepEqual(log.results.map(r => [r.label, r.pushed?.branch]), [['old', 'old-feature']]);

  // agents: a change here lands in the GUI's preferences
  await js(`(() => { const s = document.querySelector('select[aria-label="End after"]'); s.value = String(${30 * DAY}); s.dispatchEvent(new Event('change')); })()`);
  await until(() => { try { return JSON.parse(JSON.parse(fs.readFileSync(path.join(state, 'workspace-ui.json'), 'utf8'))['synapse-tidy']).close === 30 * DAY; } catch { return false; } }, 'tidy saved');
  const gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1'));
  await until(async () => JSON.parse(await gui.executeJavaScript(`localStorage.getItem('synapse-tidy')`) || '{}').close === 30 * DAY, 'the GUI took the new tidy settings');
  // worktrees: turning it off
  await js(`(() => { const s = document.querySelector('select[aria-label="Clean up worktrees unused for"]'); s.value = '0'; s.dispatchEvent(new Event('change')); })()`);
  await until(() => JSON.parse(fs.readFileSync(path.join(state, 'app.json'), 'utf8')).worktreeGc?.after === 0, 'turned off');
  assert.equal((await js(`synapse.settings.set({ worktreeGc: { action: 'nuke' } })`)).worktreeGc.action, 'push');
  assert.deepEqual(errors.filter(e => !/Autofill|favicon/i.test(e)), []);
  console.log('cleanup: ok');
  app.exit(0);
})().catch(e => { console.error(e); app.exit(1); });
