// The worktree garbage collector. A worktree you added to Synapse and have not used for a while (settings: Cleanup)
// is parked: its agents are closed, its uncommitted work is committed to its branch (saveWorktree), the branch is
// pushed to the repo's remote when there is one, and then the folder goes. Nothing is lost: the branch stays (locally,
// and on the remote when pushed), so opening it as a worktree again brings everything back.
// Only linked worktrees that are in Synapse's workspace list are ever touched, never a repo's main checkout.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git, listWorktrees, saveWorktree } from './worktrees.mjs';

const exec = promisify(execFile);
export const HOUR = 3_600_000, DAY = 24 * HOUR;
// after: how long unused before it is parked (0: never). action: 'push' (push the branch, then remove; without a
// remote it is only removed) or 'remove' (remove, the branch stays local). every: how often to look (0: at launch only).
export const GC_DEFAULT = { after: 0, action: 'push', every: 6 * HOUR };

export function cleanPolicy(p = {}) {
  const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? (n === 0 ? 0 : Math.min(max, Math.max(min, n))) : d; };
  return {
    after: num(p?.after, GC_DEFAULT.after, HOUR, 365 * DAY),
    action: ['push', 'remove'].includes(p?.action) ? p.action : GC_DEFAULT.action,
    every: num(p?.every, GC_DEFAULT.every, 15 * 60_000, 7 * DAY),
  };
}

const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const inside = (dir, p) => !!p && (p === dir || p.startsWith(dir + path.sep));

// The last time a worktree was used: an agent there said something, you typed in a terminal there (used, kept by the
// app), or its HEAD moved (a commit, checkout or reset, from anywhere). A worktree nobody ever touched counts from
// when it was made. A git status does not count: the changes panel runs one every few seconds.
export function lastUse(dir, gitDir, { used = {}, agents = [] } = {}) {
  let at = Math.max(mtime(path.join(gitDir, 'logs', 'HEAD')), mtime(path.join(gitDir, 'HEAD')));
  try { at = Math.max(at, fs.statSync(dir).birthtimeMs || 0); } catch {}
  for (const [p, t] of Object.entries(used)) if (inside(dir, p)) at = Math.max(at, t || 0);
  for (const a of agents) if (inside(dir, a.cwd) || a.worktreePath === dir) at = Math.max(at, a.lastActivity || 0);
  return at;
}

// Every linked worktree in the workspace list, with when it was last used and whether it is due. blocked(dir) gives
// a reason to leave one alone (an agent working there), or null.
export function planCleanup({ workspaces = [], policy, now = Date.now(), used, agents, blocked = () => null }) {
  const repos = new Map();
  for (const ws of workspaces) {
    let common; try { common = path.resolve(ws, git(ws, ['rev-parse', '--git-common-dir'])); } catch { continue; }
    if (!repos.has(common)) repos.set(common, ws);
  }
  const out = [];
  for (const repo of repos.values()) {
    let list; try { list = listWorktrees(repo); } catch { continue; }
    for (const w of list) {
      if (w.home || w.bare || w.missing || !workspaces.includes(w.path)) continue;
      let gitDir; try { gitDir = path.resolve(w.path, git(w.path, ['rev-parse', '--git-dir'])); } catch { continue; }
      const lastUsed = lastUse(w.path, gitDir, { used, agents });
      const reason = w.locked ? 'locked in Git' : blocked(w.path) || null;
      out.push({ repo, dir: w.path, branch: w.branch || null, lastUsed, due: !!policy.after && now - lastUsed > policy.after, reason });
    }
  }
  return out.sort((a, b) => a.lastUsed - b.lastUsed);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const PROTECTED = new Set(['main', 'master', 'trunk', 'develop']);

function remoteFor(dir, branch) {
  const remotes = git(dir, ['remote']).split('\n').filter(Boolean);
  if (!remotes.length) return null;
  let tracked = ''; try { tracked = git(dir, ['config', `branch.${branch}.remote`]); } catch {}
  return remotes.includes(tracked) ? tracked : remotes.includes('origin') ? 'origin' : remotes[0];
}

async function push(dir, remote, target) {
  await exec('git', ['-C', dir, 'push', '--no-verify', '--quiet', remote, `HEAD:refs/heads/${target}`],
    { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' } });
}

// Save the worktree's work and push its branch. The branch goes up under its own name; the repo's default branch
// (or main/master) never does: it goes to synapse/parked/<folder>-<time>, and so does a branch whose remote copy
// has moved on (no force push, ever). A push that fails for any other reason (offline, no access) throws, and the
// worktree stays.
export async function parkWorktree(dir, action) {
  const saved = saveWorktree(dir);
  let branch = saved.branch; try { branch ||= git(dir, ['branch', '--show-current']) || null; } catch {}
  if (action !== 'push' || !branch) return { saved, branch, pushed: null };
  const remote = remoteFor(dir, branch);
  if (!remote) return { saved, branch, pushed: null };
  let head = ''; try { head = git(dir, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]).replace(`${remote}/`, ''); } catch {}
  const parked = `synapse/parked/${path.basename(dir).replace(/[^\w.-]+/g, '-')}-${stamp()}`;
  let target = branch === head || PROTECTED.has(branch) ? parked : branch;
  try { await push(dir, remote, target); }
  catch (e) {
    if (target === parked || !/rejected|non-fast-forward|fetch first/i.test(String(e.stderr || e.message))) throw new Error(`Could not push ${branch} to ${remote}: ${String(e.stderr || e.message).trim().split('\n').at(-1)}`);
    target = parked; await push(dir, remote, target);
  }
  return { saved, branch, pushed: { remote, branch: target } };
}
