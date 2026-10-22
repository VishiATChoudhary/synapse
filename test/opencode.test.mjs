import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildOpenCode, buildOpenCodeV2, OC_SESSION, OC_V2_SESSION } from './fixtures/make-sessions.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-opencode-'));
process.env.SYNAPSE_HOME = path.join(home, 'synapse');
const { readAgentMessages, opencodeTranscript, turnBusy } = await import('../lib.mjs');
after(() => fs.rmSync(home, { recursive: true, force: true }));
const cwd = '/work/fixture-app', now = Date.now();
const file = buildOpenCode(home, cwd, now - 1000);
buildOpenCodeV2(home, cwd, now);
const src = { transcript: `${file}#${OC_V2_SESSION}`, format: 'opencode' };

test('OpenCode V2 reads inline messages and tools while V1 remains readable in the same database', () => {
  const { messages, end } = readAgentMessages(src);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(messages[0].text, 'Please add a retry to the fetch helper');
  assert.equal(messages[1].text, 'I will wrap fetch in a backoff loop.\n[shell: rg fetchHelper src]');
  assert.equal(messages[2].text, 'Use three attempts');
  assert.equal(messages[3].text, '[edit: src/fetch.js]');
  assert.equal(messages[3].tool, true);
  assert.doesNotMatch(JSON.stringify(messages), /private/);
  assert.equal(end, 4);
  assert.deepEqual(readAgentMessages(src, 3).messages, messages.slice(3));
  assert.equal(readAgentMessages(src, end).messages.length, 0);
  const legacy = readAgentMessages({ ...src, transcript: `${file}#${OC_SESSION}` });
  assert.equal(legacy.messages.length, 4);
  assert.match(legacy.messages[1].text, /\[bash:/);
});

test('OpenCode discovers V2 sessions and reconnects an explicit older session without borrowing another history', () => {
  assert.equal(opencodeTranscript(cwd, now, home), src.transcript);
  assert.equal(opencodeTranscript('/work/elsewhere', now, home), null);
  const restarted = now + 3_600_000;
  assert.equal(opencodeTranscript(cwd, restarted, home), null);
  for (const flag of [`--session ${OC_V2_SESSION}`, `-s ${OC_V2_SESSION}`, `--session=${OC_V2_SESSION}`]) {
    assert.equal(opencodeTranscript(cwd, restarted, home, `opencode ${flag}`), src.transcript);
  }
  assert.equal(opencodeTranscript(cwd, now, home, 'opencode --session ses_missing'), null);
  assert.equal(opencodeTranscript('/work/elsewhere', now, home, `opencode -s ${OC_V2_SESSION}`), null);
  assert.equal(opencodeTranscript(cwd, restarted, home, `opencode -s ${OC_SESSION}`), `${file}#${OC_SESSION}`);
});

test('OpenCode V2 working state follows prompts, streaming replies, tool calls and idle outcomes through WAL writes', () => {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?)').run('ses_turn', cwd, null, now, now);
    const turn = { ...src, transcript: `${file}#ses_turn` };
    let seq = 0;
    const add = (type, data) => {
      seq++;
      db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(`turn${seq}`, 'ses_turn', type, seq, now + seq, now + seq, JSON.stringify(data));
      const stamp = (now + seq * 1000) / 1000;
      fs.utimesSync(`${file}-wal`, stamp, stamp);
    };
    assert.equal(turnBusy(turn), null);
    add('user', { text: 'Do the work' });
    assert.equal(turnBusy(turn), true);
    add('assistant', { time: { created: now } });
    assert.equal(turnBusy(turn), true);
    add('assistant', { time: { created: now, completed: now + 1 }, finish: 'tool-calls' });
    assert.equal(turnBusy(turn), true);
    add('idle', { outcome: 'failed' });
    assert.equal(turnBusy(turn), false);
    add('user', { text: 'Try again' });
    assert.equal(turnBusy(turn), true);
    add('assistant', { time: { completed: now + 2 }, finish: 'stop' });
    assert.equal(turnBusy(turn), false);
    add('idle', { outcome: 'succeeded' });
    add('system', { text: 'internal context' });
    assert.equal(turnBusy(turn), false);
  } finally { db.close(); }
});
