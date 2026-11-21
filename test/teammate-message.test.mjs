import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeMessage } from '../lib.mjs';

const entry = (content) => ({ type: 'user', timestamp: '2026-11-21T00:00:00Z', message: { role: 'user', content } });

test('a message from another Claude session is a note from it, not something you typed', () => {
  const m = claudeMessage(entry('Another Claude session sent a message:\n<teammate-message teammate_id="platform-opensb" color="blue" summary="Fallback added; smoke passed">\nBoth follow-ups are done.\n</teammate-message>'));
  assert.equal(m.teammate, true);
  assert.equal(m.fromName, 'platform-opensb');
  assert.equal(m.summary, 'Fallback added; smoke passed');
  assert.equal(m.text, 'Both follow-ups are done.');
});

test('a status ping shows its result, or a short line', () => {
  const ping = (j) => claudeMessage(entry(`Another Claude session sent a message:\n<teammate-message teammate_id="impl-1" color="blue">\n${JSON.stringify(j)}\n</teammate-message>`));
  assert.equal(ping({ type: 'idle_notification', from: 'impl-1', result: 'Status: DONE' }).text, 'Status: DONE');
  assert.equal(ping({ type: 'idle_notification', from: 'impl-1' }).text, 'Idle notification');
});

test('your own prompt that mentions the tag stays yours', () => {
  const m = claudeMessage(entry('why do I see <teammate-message> blocks?'));
  assert.equal(m.teammate, undefined);
  assert.equal(m.text, 'why do I see <teammate-message> blocks?');
});
