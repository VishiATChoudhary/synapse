// Codex transcripts: a fresh session gets a rollout file born after the process started, but `codex resume <id>`
// (how the app brings agents back after a restart) keeps appending to the session's original, older rollout.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-codex-'));
process.env.SYNAPSE_HOME = path.join(tmp, 'synapse');
process.env.CODEX_HOME = path.join(tmp, 'codex');
let codexTranscript;
before(async () => ({ codexTranscript } = await import('../lib.mjs')));

const pad = (n) => String(n).padStart(2, '0');
function rollout(born, id, cwd, mtime) {
  const dir = path.join(process.env.CODEX_HOME, 'sessions', String(born.getFullYear()), pad(born.getMonth() + 1), pad(born.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${born.getFullYear()}-${pad(born.getMonth() + 1)}-${pad(born.getDate())}T${pad(born.getHours())}-${pad(born.getMinutes())}-${pad(born.getSeconds())}`;
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n`);
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

test('a resumed codex session reads its original rollout, found by the id on its command line', () => {
  const start = Date.now() - 60_000;
  const id = '01a1512b-5d3c-70f0-9624-d3acd71244ae';
  const file = rollout(new Date(start - 2 * 86400_000), id, '/work/a', Date.now());
  assert.equal(codexTranscript('codex-1', '/work/a', start, `node /opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox resume ${id}`), file);
});

test('a fresh codex session still picks the rollout born after it started, and ignores older sessions in the same folder', () => {
  const start = Date.now() - 60_000;
  rollout(new Date(start - 86400_000), '11111111-1111-4111-8111-111111111111', '/work/b', Date.now()); // an earlier run, touched since
  const fresh = rollout(new Date(start + 5000), '22222222-2222-4222-8222-222222222222', '/work/b', Date.now());
  assert.equal(codexTranscript('codex-2', '/work/b', start, 'node /opt/homebrew/bin/codex'), fresh);
});

test('resume by id never picks another session, and an unknown id finds nothing', () => {
  const start = Date.now() - 60_000;
  rollout(new Date(start - 86400_000), '33333333-3333-4333-8333-333333333333', '/work/c', Date.now());
  assert.equal(codexTranscript('codex-3', '/work/c', start, 'codex resume 44444444-4444-4444-8444-444444444444'), null);
});

test('codex progress: commands from CommandExecution events show as clean lines, code-mode exec wrappers do not', async () => {
  const { readAgentMessages } = await import('../lib.mjs');
  const file = path.join(tmp, 'progress.jsonl');
  const ts = new Date().toISOString();
  const lines = [
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'check the jobs' }] } },
    { timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.exec_command({cmd:"squeue -u me"}))' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1', command: ['/bin/zsh', '-lc', 'squeue -u me'], status: 'completed', exit_code: 0 } } },
    { timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch' } },
    { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Two jobs are running.' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const { messages } = readAgentMessages({ transcript: file, format: 'codex' });
  assert.deepEqual(messages.map((m) => [m.role, m.text, !!m.tool]), [
    ['user', 'check the jobs', false],
    ['assistant', '[exec: squeue -u me]', true],
    ['assistant', '[apply_patch: *** Begin Patch]', true],
    ['assistant', 'Two jobs are running.', false],
  ]);
});
