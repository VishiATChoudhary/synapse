// Messages from other agents that Synapse types into an idle agent's prompt show in the Messages tab, not in the
// conversation as if you had said them; what you type yourself still shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeMessage, codexMessage } from '../lib.mjs';

const WAKE = 'Synapse: messages from other agents (sent to you, not typed by the user):\n\nFrom "design":\nDone.\n\nAnswer them with synapse_send.';
const claude = (text) => ({ type: 'user', timestamp: '2026-11-19T03:00:00Z', message: { role: 'user', content: text } });
const codex = (text) => ({ type: 'response_item', timestamp: '2026-11-19T03:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

test('relayed agent messages are not your messages in the conversation', () => {
  assert.equal(claudeMessage(claude(WAKE)), null);
  assert.equal(claudeMessage(claude(`<pasted_content id="a1">\n${WAKE}\n</pasted_content id="a1">`)), null);
  assert.equal(codexMessage(codex(WAKE)), null);
  assert.equal(claudeMessage(claude('Tell me what Synapse: messages from other agents means')).text, 'Tell me what Synapse: messages from other agents means');
  assert.equal(codexMessage(codex('fix the sidebar')).text, 'fix the sidebar');
});
