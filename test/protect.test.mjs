// Protected folders: agents there only read and pull. Claude's edits and branch-changing git commands are refused
// (PreToolUse), and every prompt and session start carries the rule, for Codex too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-protect-')));
const staging = path.join(home, 'staging'), other = path.join(home, 'scratch');
fs.mkdirSync(staging); fs.mkdirSync(other);
fs.mkdirSync(path.join(home, 'state'));
fs.writeFileSync(path.join(home, 'state', 'app.json'), JSON.stringify({ workspaces: [staging, other], protected: [staging] }));
const HOOK = new URL('../hook.mjs', import.meta.url).pathname;
const run = (input) => {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, SYNAPSE_HOME: path.join(home, 'state'), SYNAPSE_CLAUDE_HOME: path.join(home, 'claude'), SYNAPSE_DEMO: '' } });
  return r.stdout ? JSON.parse(r.stdout) : null;
};
const tool = (name, toolInput, cwd = staging) => run({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: toolInput, cwd })?.hookSpecificOutput;

test('edits in a protected folder are refused, with the way out', () => {
  const out = tool('Edit', { file_path: path.join(staging, 'src', 'a.ts') });
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /protected/);
  assert.match(out.permissionDecisionReason, /worktree add -b <branch>/);
  assert.equal(tool('Write', { file_path: 'notes.md' })?.permissionDecision, 'deny', 'a relative path counts from the cwd');
  assert.equal(tool('Write', { file_path: path.join(other, 'x.md') }), undefined, 'another folder is fine');
  assert.equal(tool('Edit', { file_path: path.join(staging, 'a.ts') }, other)?.permissionDecision, 'deny', 'from anywhere');
});

test('git that moves the branch or changes files is refused there; pull, fetch and worktree add are not', () => {
  for (const c of ['git commit -am x', 'git checkout -b feat', 'git switch main', 'git -C . reset --hard', 'git stash', 'git rebase main']) assert.equal(tool('Bash', { command: c })?.permissionDecision, 'deny', c);
  for (const c of ['git pull', 'git fetch --all', 'git status', 'git log -3', `git worktree add -b feat ${home}/feat`]) assert.equal(tool('Bash', { command: c }), undefined, c);
  assert.equal(tool('Bash', { command: 'git commit -am x' }, other), undefined, 'outside a protected folder');
});

test('the rule comes with every prompt and session start in a protected folder (Claude and Codex alike)', () => {
  const prompt = run({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug', cwd: staging });
  assert.match(prompt.hookSpecificOutput.additionalContext, /<protected-folder>[\s\S]*only read and pull/);
  const start = run({ hook_event_name: 'SessionStart', cwd: path.join(staging, 'src') });
  assert.match(start.hookSpecificOutput.additionalContext, /is protected/);
  assert.equal(run({ hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: other }), null);
});
