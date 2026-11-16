// Watching: what an agent waits on outside itself. From a Claude Code transcript: background commands and monitors
// still running (a task notification ends each; ones from before the process started are gone), and a wake-up still
// ahead. From the agent itself: synapse_waiting, kept until cleared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-watching-'));
process.env.SYNAPSE_HOME = home;
const { transcriptWatching } = await import('../discovery.mjs');
const waiting = await import('../waiting.mjs');

const T = (ms) => new Date(ms).toISOString();
const use = (id, input, name = 'Bash', at = 1000) => ({ type: 'assistant', timestamp: T(at), message: { content: [{ type: 'tool_use', id, name, input }] } });
const started = (id, task, at = 1001) => ({ type: 'user', timestamp: T(at), toolUseResult: { backgroundTaskId: task }, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Command running in background' }] } });
const note = (task, status, at = 2000) => ({ type: 'user', timestamp: T(at), message: { role: 'user', content: `<task-notification>\n<task-id>${task}</task-id>\n<status>${status}</status>\n</task-notification>` } });
const file = (records) => { const f = path.join(home, `t-${Math.random()}.jsonl`); fs.writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n'); return f; };

test('a background command shows until its notification; one from an earlier process does not', () => {
  const f = file([use('u1', { command: 'npm run build', description: 'Build the app', run_in_background: true }), started('u1', 'b1'), use('u2', { command: 'sleep 9', run_in_background: true }, 'Bash', 1100), started('u2', 'b2', 1101)]);
  assert.deepEqual(transcriptWatching(f, 0).background.map((t) => t.label), ['Build the app', 'sleep 9']);
  fs.appendFileSync(f, JSON.stringify(note('b1', 'completed')) + '\n');
  assert.deepEqual(transcriptWatching(f, 0).background.map((t) => t.label), ['sleep 9']);
  assert.deepEqual(transcriptWatching(f, 50_000).background, [], 'started before this process: gone');
});

test('a monitor counts; a scheduled wake-up shows while it is ahead', () => {
  const now = Date.now();
  const f = file([use('m1', { description: 'Watch CI on PR 12' }, 'Monitor', now - 5000), started('m1', 'mon1', now - 4999), use('w1', { delaySeconds: 600, reason: 'check the deploy' }, 'ScheduleWakeup', now - 1000)]);
  const w = transcriptWatching(f, 0, now);
  assert.deepEqual(w.background.map((t) => t.label), ['Watch CI on PR 12']);
  assert.equal(w.wake.reason, 'check the deploy');
  assert.ok(w.wake.at > now);
  assert.equal(transcriptWatching(f, 0, now + 700_000).wake, null, 'once it passed');
});

test('synapse_waiting: set with a link, same note keeps its start, cleared', () => {
  const a = waiting.set('agent-1', { what: '  checks on PR #12 ', url: 'https://github.com/x/y/pull/12' });
  assert.equal(a.what, 'checks on PR #12');
  assert.equal(a.url, 'https://github.com/x/y/pull/12');
  assert.equal(waiting.set('agent-1', { what: 'checks on PR #12' }).since, a.since);
  assert.equal(waiting.set('agent-2', { what: 'deploy', url: 'javascript:alert(1)' }).url, null, 'only web links');
  assert.throws(() => waiting.set('agent-1', { what: ' ' }), /Say what/);
  assert.equal(waiting.clear('agent-1'), true);
  assert.deepEqual(Object.keys(waiting.all()), ['agent-2']);
});
