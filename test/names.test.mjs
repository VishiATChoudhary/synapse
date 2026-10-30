// Agent names: every generated name is <kind>-<folder> (Claude Code's own made-up names give way), a second agent
// of a kind in one folder is -2, and a name set in Claude Code stays. An agent known by its pid (Codex, Gemini, ...)
// that comes back from a restart writing the same transcript keeps its name, links, unread messages and plans.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-names-')));
process.env.SYNAPSE_HOME = path.join(home, 'state');
process.env.SYNAPSE_CLAUDE_HOME = path.join(home, 'claude');
delete process.env.SYNAPSE_DEMO;
const proj = path.join(home, 'Staging');
fs.mkdirSync(proj);
fs.mkdirSync(path.join(home, 'claude', 'sessions'), { recursive: true });
const session = (n, extra) => fs.writeFileSync(path.join(home, 'claude', 'sessions', `${n}.json`),
  JSON.stringify({ pid: process.pid, sessionId: `00000000-0000-0000-0000-00000000000${n}`, cwd: proj, startedAt: 1000 + n, status: 'idle', ...extra }));
session(1, { name: 'staging-4d', nameSource: 'derived' });
session(2, { name: 'staging-e0', nameSource: 'derived' });
session(3, { name: 'Thesis', nameSource: 'user' });
const lib = await import('../lib.mjs');

test('generated names are <kind>-<folder>, numbered in the order the agents started; a name given in Claude stays', () => {
  const mine = lib.localAgents().filter((a) => a.cwd === proj).sort((a, b) => a.startedAt - b.startedAt).map((a) => a.name);
  assert.deepEqual(mine, ['claude-staging', 'claude-staging-2', 'Thesis']);
});

test('a Codex back from a restart with the same transcript takes over the name, links, unread messages and plans', () => {
  const { FILES, readJSON, writeJSON, carryOver } = lib;
  const t = path.join(home, 'rollout-1.jsonl');
  carryOver([{ id: 'codex-25465', kind: 'codex', transcript: t }]);
  writeJSON(FILES.names, { 'codex-25465': 'bookingestCodex' });
  writeJSON(FILES.edges, [{ id: 'e1', from: 'claude-a', to: 'codex-25465' }, { id: 'e2', from: 'codex-25465', to: 'claude-a' }]);
  writeJSON(FILES.messages, [{ id: 'm1', from: 'claude-a', to: 'codex-25465', text: 'hi', delivered: false }, { id: 'm2', from: 'claude-a', to: 'codex-25465', text: 'old', delivered: true }]);
  writeJSON(FILES.plans, [{ id: 'p', startedBy: { id: 'claude-a' }, members: [{ id: 'claude-a' }, { id: 'codex-25465' }], tasks: [{ n: 1, owner: { id: 'codex-25465' } }] }]);

  // still running, next to another Codex: nothing moves
  carryOver([{ id: 'codex-25465', kind: 'codex', transcript: t }, { id: 'codex-3588', kind: 'codex', transcript: path.join(home, 'rollout-2.jsonl') }]);
  assert.equal(readJSON(FILES.names, {})['codex-25465'], 'bookingestCodex');

  carryOver([{ id: 'codex-9999', kind: 'codex', transcript: t }]);
  assert.deepEqual(readJSON(FILES.names, {}), { 'codex-9999': 'bookingestCodex' });
  assert.deepEqual(readJSON(FILES.edges, []).map((e) => `${e.from}>${e.to}`), ['claude-a>codex-9999', 'codex-9999>claude-a']);
  assert.deepEqual(readJSON(FILES.messages, []).map((m) => m.to), ['codex-9999', 'codex-25465'], 'unread ones only');
  const [p] = readJSON(FILES.plans, []);
  assert.deepEqual([p.members[1].id, p.tasks[0].owner.id], ['codex-9999', 'codex-9999']);
});
