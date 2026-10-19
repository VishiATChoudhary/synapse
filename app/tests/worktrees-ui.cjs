// Real Electron flow with disposable Git repositories and a deterministic gh executable.
const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
if (typeof electron === 'string') {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-worktree-ui-')));
  const result = spawnSync(electron, [__filename], { env: { ...process.env, SYNAPSE_WORKTREE_FIXTURE: fixture }, stdio: 'inherit' });
  fs.rmSync(fixture, { recursive: true, force: true }); process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fixture = process.env.SYNAPSE_WORKTREE_FIXTURE;
assert.ok(fixture);
const root = path.resolve(__dirname, '../..'), state = path.join(fixture, 'state');
const repo = path.join(fixture, 'repo'), retained = path.join(fixture, 'retained');
for (const dir of [state, repo, path.join(fixture, 'bin')]) fs.mkdirSync(dir);
const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { stdio: 'pipe' }).toString().trim();
git('init', '-q', '-b', 'main'); git('commit', '--allow-empty', '-m', 'Initial');
git('branch', 'local-feature'); git('branch', 'closed-feature');
git('worktree', 'add', '-b', 'merged-feature', retained);
git('remote', 'add', 'origin', 'https://github.com/acme/repo.git');
git('update-ref', 'refs/remotes/origin/remote-feature', 'HEAD');
const pulls = [['local-feature', 'open', null], ['closed-feature', 'closed', null], ['merged-feature', 'closed', '2026-10-16']].map(([ref, status, merged], i) => ({ head: { ref, repo: { full_name: 'acme/repo' } }, state: status, merged_at: merged, number: i + 1, html_url: `https://github.com/acme/repo/pull/${i + 1}` }));
fs.writeFileSync(path.join(fixture, 'bin', 'gh'), `#!/bin/sh\nprintf '%s' '${JSON.stringify([pulls])}'\n`, { mode: 0o755 });
Object.assign(process.env, { SYNAPSE_HOME: state, SUPERSET_HOME: path.join(fixture, 'superset'), SHELL: '/bin/sh', PATH: `${path.join(fixture, 'bin')}:${process.env.PATH}` });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG') delete process.env[key];
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ autoSymlink: true, workspaces: [repo], profiles: { shell: { command: 'cat', label: 'Shell' } } }));
process.chdir(repo); app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label) { const end = Date.now() + 10000; while (Date.now() < end) { if (await check()) return; await sleep(30); } throw new Error(`Timed out: ${label}`); }
const js = code => win.webContents.executeJavaScript(code, true);
const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const search = value => js(`document.querySelector('#modal-body input').value = ${JSON.stringify(value)}; document.querySelector('#modal-body input').dispatchEvent(new Event('input'))`);
const enter = () => js(`document.querySelector('#modal-body input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
const count = () => js(`document.querySelectorAll('.term').length`);
async function picker() {
  await click('.proj-add');
  await until(() => js(`document.querySelectorAll('.branch-option').length > 0`), 'picker loaded');
  await until(() => js(`document.querySelector('.branch-list .pr-status') !== null`), 'PR statuses loaded');
}
async function opened(branch) {
  await until(() => js(`document.querySelector('#modal').hidden && [...document.querySelectorAll('.wt-name')].some(e => e.title.split('\\n')[1] === ${JSON.stringify(branch)})`), `opened ${branch}`);
  return (await js('synapse.state()')).projects.flatMap(p => p.worktrees).find(w => w.branch === branch);
}
(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'window');
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => await count() === 1, 'initial shell');
  await picker();
  assert.equal(await js(`document.querySelectorAll('.branch-list .pr-status.open').length`), 1);
  assert.equal(await js(`document.querySelectorAll('.branch-list .pr-status.closed').length`), 1);
  assert.equal(await js(`document.querySelectorAll('.branch-list .pr-status.merged').length`), 1);
  assert.equal(await js(`[...document.querySelectorAll('.branch-open')].find(e => e.querySelector('.k').textContent === 'origin/remote-feature').querySelector('.pr-status') === null`), true);
  await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  if (process.env.SYNAPSE_WORKTREE_SCREENSHOT) fs.writeFileSync(process.env.SYNAPSE_WORKTREE_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  await search('merged-feature'); await enter(); await opened('merged-feature');
  assert.equal(await count(), 2);
  assert.equal((await js('synapse.state()')).projects.length, 1, 'worktrees stay in their repository group');
  await picker(); await search('merged-feature'); await enter(); await opened('merged-feature');
  assert.equal(await count(), 2, 'opening an existing checkout reuses its session');
  await picker(); await search('local-feature'); await enter(); await opened('local-feature');
  assert.equal(await count(), 3);
  await picker(); await search('origin/remote-feature'); await enter();
  const remote = await opened('remote-feature');
  assert.equal(execFileSync('git', ['-C', remote.path, 'rev-parse', '--abbrev-ref', '@{upstream}']).toString().trim(), 'origin/remote-feature');
  await picker(); await click('[data-mode="new"]'); await search('new//from ui?');
  // the name field drops what git would reject as it is typed: a space becomes -, the rest goes
  assert.equal(await js(`document.querySelector('#modal-body input').value`), 'new/from-ui');
  await enter();
  const fresh = await opened('new/from-ui');
  assert.ok(fs.existsSync(fresh.path));
  console.log('PASS picker search, keyboard selection, PR symbols, existing session reuse, local/remote/new branches');

  const remove = () => js(`[...document.querySelectorAll('.wt-head')].find(e => e.querySelector('.wt-name').title.startsWith(${JSON.stringify(retained + '\n')})).querySelector('.wt-delete').click()`);
  await remove(); await click('#modal-body .btn:not(.danger)');
  assert.ok(fs.existsSync(retained), 'cancel preserves checkout');
  fs.writeFileSync(path.join(retained, 'unsaved'), 'keep');
  await remove(); await click('#modal-body .btn.danger');
  await until(() => js(`document.querySelector('.toast')?.textContent.includes('untracked')`), 'dirty worktree error');
  assert.ok(fs.existsSync(retained)); assert.equal(await count(), 5, 'failed deletion keeps sessions');
  fs.unlinkSync(path.join(retained, 'unsaved'));
  await js(`synapse.worktree.rename(${JSON.stringify(retained)}, 'Finished checkout')`);
  await remove(); await click('#modal-body .btn.danger');
  await until(async () => !fs.existsSync(retained) && await count() === 4, 'worktree and session removed');
  assert.ok(git('branch', '--list', 'merged-feature'), 'branch retained');
  const config = JSON.parse(fs.readFileSync(path.join(state, 'app.json')));
  assert.ok(!config.workspaces.includes(retained)); assert.ok(!config.worktreeNames[retained]);
  assert.ok(!(await js('synapse.project.library()')).some(w => w.path === retained));
  assert.equal(await js(`[...document.querySelectorAll('.wt-head')].find(e => e.querySelector('.wt-name').title.startsWith(${JSON.stringify(repo + '\n')})).querySelector('.wt-delete') === null`), true, 'main checkout has no delete button');
  await picker(); await search('merged-feature');
  assert.equal(await js(`document.querySelector('.branch-open .c').textContent`), 'local');
  assert.equal(await js(`document.querySelector('.branch-open .pr-status').getAttribute('aria-label')`), 'PR #3 · merged');
  assert.deepEqual(errors, []);
  console.log('PASS GUI deletion, cancellation, dirty protection, session/config/library cleanup, retained branch and PR state');
})().catch(async e => { console.error(e); if (win) console.error(await js(`(async () => JSON.stringify({modal:document.querySelector('#modal').hidden, hint:document.querySelector('#modal-body .hint')?.textContent, tree:document.querySelector('#tree').textContent, terms:document.querySelectorAll('.term').length, state:await synapse.state()}))()`)); process.exitCode = 1; }).finally(() => {
  app.once('will-quit', () => app.exit(process.exitCode || 0)); app.quit();
});
