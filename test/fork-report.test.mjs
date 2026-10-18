// forkReport: what forks found since they were forked, as one message for their parent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SYNAPSE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-fork-report-'));
const { forkReport } = await import('../ops.mjs');

const at = (s) => new Date(Date.UTC(2026, 9, 18, 12, 0, s)).toISOString();
function transcript(name, lines) {
  const file = path.join(process.env.SYNAPSE_HOME, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map(([type, content, s]) => JSON.stringify({ type, timestamp: at(s), message: { content } })).join('\n') + '\n');
  return file;
}
const forkAt = Date.parse(at(10));
// a forked session carries the parent's history from before the fork
const a = { id: 'a', name: 'why not <=', forkAt, transcript: transcript('a', [
  ['user', 'inherited question', 1], ['assistant', [{ type: 'text', text: 'inherited answer' }], 2],
  ['user', 'why not just <= ?', 11], ['assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: 'auth.js' } }], 12],
  ['assistant', [{ type: 'text', text: 'Because expiry is exclusive.' }], 13],
]) };
const b = { id: 'b', name: 'clock skew', forkAt, transcript: transcript('b', [['user', 'how big is the skew?', 11], ['assistant', [{ type: 'text', text: 'About 2s.' }], 12]]) };
const idle = { id: 'c', name: 'idle', forkAt, transcript: transcript('c', [['user', 'inherited question', 1]]) };

test('one message with every child, only what came after the fork, no tool calls', () => {
  const r = forkReport([a, b, idle]);
  assert.equal(r.count, 2);
  assert.match(r.text, /^2 forks of this session are done/);
  assert.match(r.text, /<fork name="why not <=">\nUSER: why not just <= \?\n\nAGENT: Because expiry is exclusive\.\n<\/fork>/);
  assert.match(r.text, /<fork name="clock skew">[\s\S]*About 2s\./);
  assert.doesNotMatch(r.text, /inherited|Read/);
  assert.deepEqual(r.newest, { a: Date.parse(at(13)), b: Date.parse(at(12)) });
});

test('a restamped inherited history is cut at the fork question', () => {
  const c = { id: 'd', name: 'restamped', forkAt, forkQ: 'look at retries', transcript: transcript('d', [
    ['user', 'inherited question', 11], ['assistant', [{ type: 'text', text: 'inherited answer' }], 11],
    ['user', 'look at retries', 12], ['assistant', [{ type: 'text', text: 'Three retries.' }], 13],
  ]) };
  const r = forkReport([c]);
  assert.doesNotMatch(r.text, /inherited/);
  assert.match(r.text, /USER: look at retries\n\nAGENT: Three retries\./);
});

test('handing back again sends only what is new', () => {
  assert.equal(forkReport([a, b], { a: Date.parse(at(13)), b: Date.parse(at(12)) }), null);
  const r = forkReport([a], { a: Date.parse(at(11)) });
  assert.match(r.text, /^A fork of this session is done/);
  assert.doesNotMatch(r.text, /USER: why not/);
});
