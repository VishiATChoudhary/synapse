import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const git = (cwd, args) => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim(); }
  catch (e) { throw new Error((e.stderr || e.message || '').toString().trim()); }
};

export function listWorktrees(repo) {
  return git(repo, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean).map((record, i) => {
    const fields = Object.fromEntries(record.split('\0').filter(Boolean).map(line => {
      const at = line.indexOf(' ');
      return at < 0 ? [line, true] : [line.slice(0, at), line.slice(at + 1)];
    }));
    // git prints C:/forward/slashes on Windows; resolve so they compare equal to paths from anywhere else
    return { path: path.resolve(fields.worktree), branch: (fields.branch || '').replace(/^refs\/heads\//, ''), home: i === 0, locked: !!fields.locked, missing: !fs.existsSync(fields.worktree), bare: !!fields.bare };
  });
}

export function listChoices(repo) {
  const worktrees = listWorktrees(repo).filter(w => !w.bare);
  const branches = git(repo, ['for-each-ref', '--format=%(refname)%09%(symref)%09%(upstream)', 'refs/heads/', 'refs/remotes/'])
    .split('\n').filter(Boolean).map(line => {
      const [ref, symref, upstream] = line.split('\t');
      const remote = ref.startsWith('refs/remotes/');
      return { ref, symref, upstream, kind: remote ? 'remote' : 'local', name: ref.replace(/^refs\/(heads|remotes)\//, '') };
    }).filter(b => !b.symref);
  return [
    ...worktrees.map(w => ({ ...w, kind: 'worktree', name: w.branch || 'detached HEAD' })),
    ...branches.filter(b => b.kind === 'remote' || !worktrees.some(w => `refs/heads/${w.branch}` === b.ref)),
  ];
}

// Keep branch names out of paths; slashes, aliases, and same-named repositories cannot collide.
function destination(repo, name, home) {
  const parent = path.join(home, path.basename(repo));
  fs.mkdirSync(parent, { recursive: true });
  const stem = name.replace(/[^\w.-]+/g, '-').replace(/^\.+/, '') || 'checkout';
  let dir = path.join(parent, stem), n = 2;
  while (fs.existsSync(dir)) dir = path.join(parent, `${stem}-${n++}`);
  return dir;
}

export function createWorktree(repo, name, base, home) {
  name = String(name || '').trim();
  git(repo, ['check-ref-format', `refs/heads/${name}`]);
  if (name.startsWith('-') || name === 'HEAD') throw new Error('invalid branch name');
  const dir = destination(repo, name, home);
  git(repo, ['worktree', 'add', '-b', name, dir, base || 'HEAD']);
  return dir;
}

export function openWorktree(repo, choice, home) {
  const choices = listChoices(repo);
  if (choice.kind === 'worktree') {
    const found = choices.find(w => w.kind === 'worktree' && w.path === choice.path);
    if (!found || found.missing) throw new Error('This worktree no longer exists.');
    return found.path;
  }
  // A checkout may have been opened since the picker loaded. Reuse it.
  if (choice.kind === 'local') {
    const existing = choices.find(w => w.kind === 'worktree' && `refs/heads/${w.branch}` === choice.ref);
    if (existing) return openWorktree(repo, existing, home);
  }
  const branch = choices.find(b => b.ref === choice.ref && b.kind === choice.kind);
  if (!branch) throw new Error('This branch no longer exists. Refresh the list.');
  if (branch.kind === 'local') {
    const dir = destination(repo, branch.name, home);
    git(repo, ['worktree', 'add', dir, branch.name]);
    return dir;
  }
  if (branch.kind !== 'remote') throw new Error('Choose a local or remote branch.');
  const remote = git(repo, ['remote']).split('\n').sort((a, b) => b.length - a.length).find(r => branch.name.startsWith(r + '/'));
  if (!remote) throw new Error('The remote for this branch no longer exists.');
  const name = branch.name.slice(remote.length + 1);
  const locals = git(repo, ['for-each-ref', '--format=%(refname)%09%(upstream)', 'refs/heads/']).split('\n');
  const tracking = locals.find(l => l.split('\t')[1] === branch.ref)?.split('\t')[0];
  if (tracking) return openWorktree(repo, { kind: 'local', ref: tracking }, home);
  // Do not silently open an unrelated local branch with the same name.
  let localName = name;
  if (locals.some(l => l.split('\t')[0] === `refs/heads/${localName}`)) localName = `${name}-${remote}`;
  let candidate = localName, n = 2;
  while (locals.some(l => l.split('\t')[0] === `refs/heads/${candidate}`)) candidate = `${localName}-${n++}`;
  const dir = destination(repo, candidate, home);
  git(repo, ['worktree', 'add', '--track', '-b', candidate, dir, branch.ref]);
  return dir;
}

export function deleteWorktree(repo, dir, force = false) {
  const w = listWorktrees(repo).find(w => w.path === dir);
  if (!w || w.home || w.bare) throw new Error('Only a linked worktree can be deleted.');
  if (w.locked) throw new Error('This worktree is locked. Unlock it in Git before deleting it.');
  // Normal deletion protects local changes; the existing context menu explicitly confirms force.
  git(repo, ['worktree', 'remove', ...(force === true ? ['--force'] : []), '--', dir]);
}

// Safe deletion: nothing in the checkout is lost. Uncommitted work (staged, unstaged, untracked, conflicted) becomes
// a commit on its branch; a detached HEAD whose commits no branch holds gets a branch of its own first. The branch
// outlives the folder, so `git switch <branch>` (or a new worktree on it) brings everything back.
// Ignored files (node_modules, build output, .env) are not saved: they go with the folder.
const slow = (cwd, args, env) => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, env: { ...process.env, ...env } }).trim(); }
  catch (e) { throw new Error((e.stderr || e.message || '').toString().trim()); }
};
const has = (cwd, args) => { try { git(cwd, args); return true; } catch { return false; } };
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

export function saveWorktree(dir) {
  const files = git(dir, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean).length;
  let branch = git(dir, ['branch', '--show-current']);
  let made = false;
  if (!branch) { // detached (or mid-rebase): keep HEAD reachable before anything else
    const held = has(dir, ['rev-parse', '--verify', 'HEAD']) && git(dir, ['branch', '--contains', 'HEAD', '--format=%(refname:short)']).split('\n').filter(Boolean).length > 0;
    if (!files && held) return { saved: false, files: 0, branch: null };
    let name = `synapse/saved/${path.basename(dir).replace(/[^\w.-]+/g, '-')}-${stamp()}`, n = 2;
    while (has(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) name = `${name.replace(/-\d+$/, '')}-${n++}`;
    git(dir, ['branch', name, 'HEAD']); // HEAD stays detached; the commit below is moved onto the branch after
    branch = name; made = true;
  }
  if (!files) return { saved: made, files: 0, branch, created: made };
  slow(dir, ['add', '-A', '--', '.']);
  // no hooks (a failing lint must not block saving), no signing prompt, an identity even where none is configured
  const who = has(dir, ['config', 'user.email']) ? [] : ['-c', 'user.name=Synapse', '-c', 'user.email=synapse@localhost'];
  slow(dir, [...who, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', `Saved by Synapse before deleting worktree ${path.basename(dir)}`,
    '-m', `${files} uncommitted change${files === 1 ? '' : 's'} kept here so deleting the checkout lost nothing.`]);
  if (made) git(dir, ['branch', '-f', branch, 'HEAD']);
  return { saved: true, files, branch, commit: git(dir, ['rev-parse', '--short', 'HEAD']), created: made };
}

export function safeDeleteWorktree(repo, dir) {
  const w = listWorktrees(repo).find(w => w.path === dir);
  if (!w || w.home || w.bare) throw new Error('Only a linked worktree can be deleted.');
  if (w.missing) { git(repo, ['worktree', 'prune']); return { saved: false, files: 0, branch: w.branch || null }; }
  const result = saveWorktree(dir);
  if (w.locked) git(repo, ['worktree', 'unlock', '--', dir]);
  if (git(dir, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Could not save every change in this worktree; nothing was deleted.');
  git(repo, ['worktree', 'remove', '--force', '--', dir]); // clean now; --force only for ignored files and submodules
  return result;
}

export async function fetchBranches(repo) {
  await exec('git', ['-C', repo, 'fetch', '--all'], { timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

const prCache = new Map();
// Status is optional: local Git operations still work offline or without an authenticated gh.
export function pullRequests(repo) {
  let key;
  try {
    if (!git(repo, ['remote'])) return Promise.resolve({ pulls: [], error: '' });
    key = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  } catch { return Promise.resolve({ pulls: [], error: '' }); }
  const cached = prCache.get(key);
  if (cached && Date.now() - cached.time < 60000) return cached.promise;
  const promise = (async () => {
    try {
      const { stdout } = await exec('gh', ['api', 'repos/{owner}/{repo}/pulls?state=all&per_page=100&sort=updated&direction=desc', '--paginate', '--slurp'], { cwd: repo, timeout: 20000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
      return { pulls: JSON.parse(stdout).flat().map(p => ({ branch: p.head.ref, repository: p.head.repo?.full_name?.toLowerCase(), state: p.merged_at ? 'MERGED' : p.state.toUpperCase(), number: p.number, url: p.html_url })), error: '' };
    } catch { return { pulls: [], error: 'PR status unavailable. Check GitHub CLI sign-in or your connection.' }; }
  })();
  prCache.set(key, { time: Date.now(), promise });
  return promise;
}

export function choicePullRequest(repo, choice, pulls) {
  if (!pulls.length) return null;
  let branch = choice.branch || choice.name, remote = 'origin';
  try {
    const ref = choice.kind === 'remote' ? choice.ref : git(repo, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`]);
    if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length);
      remote = git(repo, ['remote']).split('\n').sort((a, b) => b.length - a.length).find(r => name.startsWith(r + '/'));
      if (!remote) return null;
      branch = name.slice(remote.length + 1);
    }
    const url = git(repo, ['remote', 'get-url', remote]);
    const repository = url.replace(/\.git$/, '').match(/[:/]([^/:]+\/[^/]+)$/)?.[1]?.toLowerCase();
    if (!repository) return null;
    const matches = pulls.filter(p => p.branch === branch && p.repository === repository);
    return matches.find(p => p.state === 'OPEN') || matches[0] || null;
  } catch { return null; }
}
