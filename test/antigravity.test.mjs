// Antigravity (agy): its conversation store reads back as your prompts, its replies and its tool calls, and the
// newest step says whether a turn is under way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAgentMessages, turnBusy } from '../lib.mjs';
import { writeStore, userStep, modelStep, resultStep } from './fixtures/agy-store.mjs';

test('an antigravity conversation reads as prompts, replies and tool calls', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-')), 'c.db');
  writeStore(file, [
    userStep('check the training pipelines'),
    modelStep('', [['run_command', { CommandLine: 'git status -s', toolSummary: 'status' }]]),
    resultStep(),
    modelStep('**GaitFM v3** passed its self-tests.'),
  ], Date.parse('2026-11-27T10:00:00Z') / 1000);
  const src = { transcript: file, format: 'antigravity' };
  const r = readAgentMessages(src);
  assert.equal(r.end, 4);
  assert.deepEqual(r.messages.map((m) => [m.role, m.text, !!m.tool]), [
    ['user', 'check the training pipelines', false],
    ['assistant', '[run_command: status]', true],
    ['assistant', '**GaitFM v3** passed its self-tests.', false],
  ]);
  assert.equal(r.messages[0].ts, '2026-11-27T10:00:00.000Z');
  assert.deepEqual(readAgentMessages(src, r.end).messages, []);
  assert.equal(turnBusy(src), false);
  writeStore(file, [userStep('and the eval?')]);
  assert.equal(readAgentMessages(src, r.end).messages[0].text, 'and the eval?');
  assert.equal(turnBusy(src), true, 'your prompt waits for the model');
});

test('a store that is not there reads as empty', () => {
  assert.deepEqual(readAgentMessages({ transcript: '/nope/x.db', format: 'antigravity' }).messages, []);
});
