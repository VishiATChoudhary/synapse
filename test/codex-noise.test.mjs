// What Codex sends as the user without you typing it (the AGENTS.md instructions, the environment block) is not
// shown as your message; what you typed is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexMessage } from '../lib.mjs';

const user = (text) => ({ type: 'response_item', timestamp: '2026-11-18T21:38:09Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

test('Codex AGENTS.md instructions and environment block are not your messages', () => {
  assert.equal(codexMessage(user('# AGENTS.md instructions\n\n<INSTRUCTIONS>\n## Synapse\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>/x</cwd>\n</environment_context>')), null);
  assert.equal(codexMessage(user('<INSTRUCTIONS>\nbe nice\n</INSTRUCTIONS>')), null);
  assert.equal(codexMessage(user('<environment_context>\n  <cwd>/x</cwd>\n</environment_context>')), null);
  assert.equal(codexMessage(user('How do I read AGENTS.md instructions in this repo?')).text, 'How do I read AGENTS.md instructions in this repo?');
});
