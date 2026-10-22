// Working or not, from each agent's own transcript: Codex by its task events, OpenCode by its newest message,
// Gemini by the chat's last message. Unknown formats and empty transcripts give null (the caller falls back to CPU).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-status-'));
process.env.SYNAPSE_HOME = path.join(tmp, 'synapse');
let turnBusy;
before(async () => ({ turnBusy } = await import('../lib.mjs')));

const ev = (type) => JSON.stringify({ type: 'event_msg', payload: { type } });
test('codex: the last task event decides, text that mentions one does not', () => {
  const p = path.join(tmp, 'rollout.jsonl');
  const src = { transcript: p, format: 'codex' };
  fs.writeFileSync(p, JSON.stringify({ type: 'session_meta', payload: { cwd: tmp } }) + '\n');
  assert.equal(turnBusy(src), null, 'no turn yet');
  fs.appendFileSync(p, ev('task_started') + '\n');
  assert.equal(turnBusy(src), true);
  fs.appendFileSync(p, JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [{ text: '{"type":"event_msg","payload":{"type":"task_complete"}}' }] } }) + '\n');
  assert.equal(turnBusy(src), true, 'a message quoting the event is not the event');
  fs.appendFileSync(p, ev('task_complete') + '\n');
  assert.equal(turnBusy(src), false);
  fs.appendFileSync(p, ev('task_started') + '\n' + ev('turn_aborted') + '\n');
  assert.equal(turnBusy(src), false, 'interrupted');
});

test('opencode: a prompt, an unfinished reply or a tool call is a turn under way', (t) => {
  const sqlite = process.getBuiltinModule?.('node:sqlite');
  if (!sqlite) return t.skip('node:sqlite missing');
  const file = path.join(tmp, 'opencode.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  let n = 0;
  const add = (data) => { n++; db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(`m${n}`, 's1', n, n, JSON.stringify(data)); };
  const src = { transcript: `${file}#s1`, format: 'opencode' };
  assert.equal(turnBusy(src), null, 'empty session');
  add({ role: 'user' });
  assert.equal(turnBusy(src), true);
  add({ role: 'assistant', time: { created: 2 } });
  assert.equal(turnBusy(src), true, 'reply under way');
  db.prepare('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify({ role: 'assistant', time: { created: 2, completed: 3 }, finish: 'tool-calls' }), `m${n}`);
  assert.equal(turnBusy(src), true, 'it called tools, more follows');
  add({ role: 'assistant', time: { created: 4, completed: 5 }, finish: 'stop' });
  assert.equal(turnBusy(src), false);
  db.close();
});

test('gemini: the prompt or a reply calling tools is a turn under way', () => {
  const p = path.join(tmp, 'chat.json');
  const src = { transcript: p, format: 'gemini' };
  const save = (messages) => fs.writeFileSync(p, JSON.stringify({ sessionId: 'x', messages }) + ' '.repeat(messages.length));
  save([{ type: 'user', content: 'hi' }]);
  assert.equal(turnBusy(src), true);
  save([{ type: 'user', content: 'hi' }, { type: 'gemini', content: '', toolCalls: [{ name: 'ls' }] }]);
  assert.equal(turnBusy(src), true);
  save([{ type: 'user', content: 'hi' }, { type: 'gemini', content: '', toolCalls: [{ name: 'ls' }] }, { type: 'gemini', content: 'done' }]);
  assert.equal(turnBusy(src), false);
});

test('formats with no turn markers fall back', () => {
  assert.equal(turnBusy({ transcript: path.join(tmp, 'x.db'), format: 'cursor-agent' }), null);
  assert.equal(turnBusy({ transcript: path.join(tmp, 'missing.jsonl'), format: 'codex' }), null);
});
