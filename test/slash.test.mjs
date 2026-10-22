// Slash commands and @friends in the GUI: a command at the start of a message (Claude's /goal and //goal, Codex's
// /ultrafast) shows as a chip, paths do not count, Claude's logged <command-name> tags read back as the command
// line, and @handles are marked outside email addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slashCommand, messageBody, renderMarkdown } from '../public/workspace.mjs';

test('a slash command is the first token, with one or two slashes', () => {
  assert.deepEqual(slashCommand('/goal ship the share flow'), { command: '/goal', rest: 'ship the share flow' });
  assert.deepEqual(slashCommand('//goal'), { command: '//goal', rest: '' });
  assert.deepEqual(slashCommand('/ultrafast'), { command: '/ultrafast', rest: '' });
  assert.deepEqual(slashCommand('/plugin:review now'), { command: '/plugin:review', rest: 'now' });
  for (const t of ['/Users/vishi/notes.md', 'please run /goal', '/ 3', '/123', 'a/b']) assert.equal(slashCommand(t), null, t);
});

test('a user message that is a command renders the command as a chip', () => {
  const html = messageBody('/goal make <b>it</b> **work**', true);
  assert.match(html, /^<div class="slash-head"><span class="slash-cmd">\/goal<\/span><\/div>/);
  assert.match(html, /make &lt;b&gt;it&lt;\/b&gt; <strong>work<\/strong>/);
  assert.doesNotMatch(messageBody('/goal x', false), /slash-cmd/, 'only what the user typed');
});

test('@friends are marked, email addresses are not', () => {
  assert.match(renderMarkdown('ask @mara about it'), /ask <span class="mention">@mara<\/span> about/);
  assert.doesNotMatch(renderMarkdown('mail me@example.com'), /mention/);
});

test("Claude's logged slash commands read back as the command line", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-slash-'));
  process.env.SYNAPSE_HOME = path.join(tmp, 'home');
  const { readAgentMessages } = await import('../lib.mjs');
  const file = path.join(tmp, 's.jsonl'), t = new Date().toISOString();
  const line = (o) => JSON.stringify({ timestamp: t, ...o });
  fs.writeFileSync(file, [
    line({ type: 'user', message: { role: 'user', content: '<command-message>goal is running…</command-message>\n<command-name>/goal</command-name>\n<command-args>ship the share flow</command-args>' } }),
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'expanded goal prompt' } }),
    line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' } }),
    line({ type: 'user', message: { role: 'user', content: '<local-command-stdout>cleared</local-command-stdout>' } }),
  ].join('\n') + '\n');
  const { messages } = readAgentMessages({ transcript: file, format: 'claude' });
  assert.deepEqual(messages.map((m) => m.text), ['/goal ship the share flow', '/clear']);
});
