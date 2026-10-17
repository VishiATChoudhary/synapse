// Real Git fixtures; no user repos, credentials, or network required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, listChoices, createWorktree, openWorktree, deleteWorktree, choicePullRequest, pullRequests, fetchBranches } from '../worktrees.mjs';

const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-worktrees-')));
const repo = path.join(fixture, 'repo'), home = path.join(fixture, 'checkouts');
const branch = (name) => git(repo, ['branch', name]);
try {
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial']);
  branch('feature/local'); branch('remote-only');
  const remote = path.join(fixture, 'remote.git');
  execFileSync('git', ['clone', '--bare', repo, remote], { stdio: 'pipe' });
  git(repo, ['remote', 'add', 'origin', remote]); git(repo, ['fetch', 'origin']);
  execFileSync('git', ['--git-dir', remote, 'branch', 'fetched-later', 'main']);
  await fetchBranches(repo);
  assert.ok(listChoices(repo).some(b => b.name === 'origin/fetched-later'));
  git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  git(repo, ['branch', '-D', 'remote-only']);
  const retained = path.join(fixture, 'retained space\ncheckout');
  git(repo, ['worktree', 'add', '-b', 'retained', retained]);
  let choices = listChoices(repo);
  assert.ok(choices.find(w => w.path === retained));
  assert.ok(choices.find(w => w.kind === 'local' && w.name === 'feature/local'));
  assert.ok(choices.find(w => w.kind === 'remote' && w.name === 'origin/remote-only'));
  assert.ok(!choices.find(w => w.name === 'origin/HEAD'));
  assert.equal(openWorktree(repo, { kind: 'worktree', path: retained }, home), retained);
  const local = openWorktree(repo, { kind: 'local', ref: 'refs/heads/feature/local' }, home);
  assert.equal(git(local, ['branch', '--show-current']), 'feature/local');
  assert.equal(openWorktree(repo, { kind: 'local', ref: 'refs/heads/feature/local' }, home), local);
  const tracking = openWorktree(repo, { kind: 'remote', ref: 'refs/remotes/origin/remote-only' }, home);
  assert.equal(git(tracking, ['rev-parse', '--abbrev-ref', '@{upstream}']), 'origin/remote-only');
  assert.equal(openWorktree(repo, { kind: 'remote', ref: 'refs/remotes/origin/remote-only' }, home), tracking);
  // Same-named local branch without this upstream must not hijack a remote selection.
  const collision = openWorktree(repo, { kind: 'remote', ref: 'refs/remotes/origin/feature/local' }, home);
  assert.notEqual(collision, local);
  assert.equal(git(collision, ['branch', '--show-current']), 'feature/local-origin');
  assert.equal(git(collision, ['rev-parse', '--abbrev-ref', '@{upstream}']), 'origin/feature/local');
  const fresh = createWorktree(repo, 'new/nested', '', home);
  assert.equal(git(fresh, ['branch', '--show-current']), 'new/nested');
  assert.ok(fresh.startsWith(home + path.sep));
  for (const name of ['../escape', '-bad', 'HEAD', 'bad..branch']) assert.throws(() => createWorktree(repo, name, '', home));
  assert.throws(() => deleteWorktree(repo, repo), /Only a linked/);
  git(repo, ['worktree', 'lock', retained]);
  assert.throws(() => deleteWorktree(repo, retained), /locked/);
  git(repo, ['worktree', 'unlock', retained]);
  fs.writeFileSync(path.join(fresh, 'unsaved.txt'), 'keep me');
  assert.throws(() => deleteWorktree(repo, fresh), /untracked|modified/);
  assert.equal(fs.readFileSync(path.join(fresh, 'unsaved.txt'), 'utf8'), 'keep me');
  fs.unlinkSync(path.join(fresh, 'unsaved.txt'));
  deleteWorktree(repo, fresh);
  assert.equal(fs.existsSync(fresh), false);
  assert.ok(git(repo, ['branch', '--list', 'new/nested']));
  assert.throws(() => openWorktree(repo, { kind: 'worktree', path: fresh }, home), /no longer exists/);
  const detached = path.join(fixture, 'detached');
  git(repo, ['worktree', 'add', '--detach', detached]);
  assert.equal(listChoices(repo).find(w => w.path === detached).name, 'detached HEAD');
  assert.equal(openWorktree(repo, { kind: 'worktree', path: detached }, home), detached);
  console.log('PASS local/remote/retained/detached opening, tracking, collisions, safe creation and deletion');

  git(repo, ['remote', 'set-url', 'origin', 'git@github.com:acme/repo.git']);
  const prs = [
    { branch: 'remote-only', repository: 'someone/fork', state: 'OPEN', number: 1 },
    { branch: 'remote-only', repository: 'acme/repo', state: 'CLOSED', number: 2 },
    { branch: 'remote-only', repository: 'acme/repo', state: 'OPEN', number: 3 },
    { branch: 'retained', repository: 'acme/repo', state: 'MERGED', number: 4 },
  ];
  assert.equal(choicePullRequest(repo, { kind: 'remote', ref: 'refs/remotes/origin/remote-only' }, prs).number, 3);
  assert.equal(choicePullRequest(repo, { branch: 'remote-only' }, prs).number, 3);
  assert.equal(choicePullRequest(repo, { branch: 'retained' }, prs).state, 'MERGED');
  assert.equal(choicePullRequest(repo, { branch: 'no-pr' }, prs), null);
  assert.equal(choicePullRequest(repo, { branch: 'remote-only' }, prs.slice(0, 2)).state, 'CLOSED');
  const bin = path.join(fixture, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf \'%s\' \'[[{"head":{"ref":"retained","repo":{"full_name":"acme/repo"}},"merged_at":"today","state":"closed","number":4,"html_url":"https://github.com/acme/repo/pull/4"}]]\'\n', { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const result = await pullRequests(repo);
  assert.equal(result.error, ''); assert.equal(result.pulls[0].state, 'MERGED');
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.deepEqual(await pullRequests(repo), result, 'cached per repository');
  const offline = path.join(fixture, 'offline'); fs.mkdirSync(offline); git(offline, ['init', '-q']);
  git(offline, ['remote', 'add', 'origin', 'https://github.com/acme/offline.git']);
  assert.match((await pullRequests(offline)).error, /unavailable/);
  console.log('PASS open/closed/merged/no PR, source repository matching, caching and offline fallback');
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
