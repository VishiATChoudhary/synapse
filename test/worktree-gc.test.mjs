import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanPolicy, planCleanup, parkWorktree, DAY, HOUR } from '../app/worktree-gc.mjs';

const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const real = (p) => fs.realpathSync(p);

function setup({ remote = true } = {}) {
  const root = real(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gc-')));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t'); sh(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'init');
  let bare = null;
  if (remote) {
    bare = path.join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    sh(repo, 'remote', 'add', 'origin', bare);
    sh(repo, 'push', '-q', 'origin', 'main');
  }
  const wt = path.join(root, 'feature');
  sh(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
  return { root, repo, wt, bare };
}

test('cleanPolicy keeps known actions and bounds the times', () => {
  assert.deepEqual(cleanPolicy({}), { after: 0, action: 'push', every: 6 * HOUR });
  assert.deepEqual(cleanPolicy({ after: 7 * DAY, action: 'remove', every: 0 }), { after: 7 * DAY, action: 'remove', every: 0 });
  assert.equal(cleanPolicy({ action: 'nuke' }).action, 'push');
  assert.equal(cleanPolicy({ after: 5 }).after, HOUR);
  assert.equal(cleanPolicy({ every: -1 }).every, 6 * HOUR);
});

test('planCleanup lists linked worktrees in the workspace list, never the main checkout', () => {
  const { repo, wt } = setup({ remote: false });
  const now = Date.now() + 30 * DAY;
  const items = planCleanup({ workspaces: [repo, wt], policy: cleanPolicy({ after: 7 * DAY }), now });
  assert.deepEqual(items.map((i) => i.dir), [wt]);
  assert.equal(items[0].due, true);
  assert.equal(items[0].branch, 'feature');
  // not added to Synapse: left alone
  assert.deepEqual(planCleanup({ workspaces: [repo], policy: cleanPolicy({ after: 7 * DAY }), now }), []);
  // recent use (an agent there, or typing in a terminal there) keeps it
  assert.equal(planCleanup({ workspaces: [wt], policy: cleanPolicy({ after: 7 * DAY }), now, agents: [{ cwd: path.join(wt, 'src'), lastActivity: now - DAY }] })[0].due, false);
  assert.equal(planCleanup({ workspaces: [wt], policy: cleanPolicy({ after: 7 * DAY }), now, used: { [wt]: now - HOUR } })[0].due, false);
  // never: nothing is due
  assert.equal(planCleanup({ workspaces: [wt], policy: cleanPolicy({ after: 0 }), now })[0].due, false);
  assert.equal(planCleanup({ workspaces: [wt], policy: cleanPolicy({ after: 7 * DAY }), now, blocked: () => 'busy' })[0].reason, 'busy');
});

test('parkWorktree commits uncommitted work and pushes the branch under its name', async () => {
  const { wt, bare } = setup();
  fs.writeFileSync(path.join(wt, 'new.txt'), 'work in progress');
  const r = await parkWorktree(wt, 'push');
  assert.equal(r.saved.files, 1);
  assert.deepEqual(r.pushed, { remote: 'origin', branch: 'feature' });
  assert.match(sh(bare, 'show', 'feature:new.txt'), /work in progress/);
});

test('parkWorktree never pushes onto the default branch, and parks a diverged branch instead of forcing', async () => {
  const { repo, wt, bare } = setup();
  // a worktree on main: goes to synapse/parked/...
  sh(wt, 'switch', '-q', '-c', 'tmp'); sh(repo, 'worktree', 'remove', wt);
  const onMain = path.join(path.dirname(wt), 'main-wt');
  sh(repo, 'switch', '-q', '-c', 'other'); sh(repo, 'worktree', 'add', '-q', onMain, 'main');
  fs.writeFileSync(path.join(onMain, 'x.txt'), 'x');
  const r = await parkWorktree(onMain, 'push');
  assert.match(r.pushed.branch, /^synapse\/parked\/main-wt-/);
  assert.equal(sh(bare, 'rev-parse', 'main'), sh(repo, 'rev-parse', 'origin/main'));
  // diverged: the remote has a commit the worktree lacks
  const wt2 = path.join(path.dirname(wt), 'feat2');
  sh(repo, 'worktree', 'add', '-q', '-b', 'feat2', wt2, 'main');
  sh(wt2, 'push', '-q', 'origin', 'feat2');
  sh(wt2, 'commit', '-q', '--allow-empty', '-m', 'remote side'); sh(wt2, 'push', '-q', 'origin', 'feat2'); sh(wt2, 'reset', '-q', '--hard', 'HEAD~1');
  sh(wt2, 'commit', '-q', '--allow-empty', '-m', 'local side');
  const r2 = await parkWorktree(wt2, 'push');
  assert.match(r2.pushed.branch, /^synapse\/parked\/feat2-/);
  assert.match(sh(bare, 'log', '-1', '--format=%s', 'feat2'), /remote side/);
});

test('parkWorktree without a remote, or with remove, only saves', async () => {
  const { wt } = setup({ remote: false });
  fs.writeFileSync(path.join(wt, 'n.txt'), 'n');
  const r = await parkWorktree(wt, 'push');
  assert.equal(r.pushed, null);
  assert.equal(r.saved.saved, true);
  assert.equal(sh(wt, 'status', '--porcelain'), '');
  const { wt: wt2 } = setup();
  assert.equal((await parkWorktree(wt2, 'remove')).pushed, null);
});
