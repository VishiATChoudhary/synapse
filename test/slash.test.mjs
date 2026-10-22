// Slash commands and @friends in the GUI: a command at the start of a message (Claude's /goal and //goal, Codex's
// /ultrafast) shows as a chip, paths do not count, Claude's logged <command-name> tags read back as the command
// line, and @handles are marked outside email addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slashCommand, messageBody, renderMarkdown, filePaths, agentHandles, mentionOptions, promptHistory } from '../public/workspace.mjs';

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

test('bare web addresses become links, without the full stop after them', () => {
  const html = renderMarkdown('see https://example.com/a?b=1. and [docs](https://x.dev) and `https://in.code`');
  assert.match(html, /<a href="https:\/\/example.com\/a\?b=1" target="_blank"[^>]*>https:\/\/example.com\/a\?b=1<\/a>\. and/);
  assert.match(html, /<a href="https:\/\/x.dev"[^>]*>docs<\/a>/);
  assert.match(html, /<code>https:\/\/in.code<\/code>/, 'code stays code');
});

test('file path candidates skip versions and urls', () => {
  assert.deepEqual(filePaths('edit lib.mjs:12, app/main.mjs and ~/notes.md.').map((h) => h.path), ['lib.mjs:12', 'app/main.mjs', '~/notes.md']);
  assert.deepEqual(filePaths('v1.2.3 or 0.6.2 at https://a.com/b.js').map((h) => h.path), []);
});

test('@ lists friends, then agents in this project, and searches the rest', () => {
  const agents = agentHandles([
    { id: 'a', name: 'claude', projectKey: 'syn', project: 'synapse', lastActivity: 1 },
    { id: 'b', name: 'claude', projectKey: 'shop', project: 'shop', lastActivity: 2 },
    { id: 'c', name: 'Codex main', projectKey: 'syn', project: 'synapse', lastActivity: 3 },
    { id: 'd', name: 'mara', projectKey: 'syn', project: 'synapse' },
  ], ['mara']);
  assert.deepEqual([...agents.keys()], ['claude', 'claude-2', 'Codex-main', 'mara-2'], 'repeated names are numbered; a friend keeps @mara');
  const friends = [{ handle: 'mara', name: 'Mara' }];
  const pick = (query) => mentionOptions({ friends, agents, project: 'syn', query }).map((o) => `${o.type}:${o.handle}`);
  assert.deepEqual(pick(''), ['friend:mara', 'agent:Codex-main', 'agent:claude', 'agent:mara-2'], 'other projects wait for a search');
  assert.deepEqual(pick('cl'), ['agent:claude', 'agent:claude-2']);
  assert.deepEqual(pick('shop'), ['agent:claude-2'], 'search finds agents by project');
});

test('an agent handle never ends in a dash, so it still reads as a mention', () => {
  const [handle] = agentHandles([{ id: 'x', name: 'codex-synapse-links-ui-abc' }]).keys();
  assert.equal(handle, 'codex-synapse-links');
  assert.match(`@${handle} hi`, /@codex-synapse-links\b/);
});

test('Up steps back through your prompts, transcript and queued messages in time order', () => {
  const data = {
    messages: [{ role: 'user', text: 'fix it', ts: '2026-10-22T10:00:00Z' }, { role: 'assistant', text: 'done' }, { role: 'user', text: 'fix it', ts: '2026-10-22T10:01:00Z' }, { role: 'user', text: '/goal ship', ts: '2026-10-22T10:03:00Z' }],
    chat: [{ from: 'synapse-user', text: 'check the build', t: Date.parse('2026-10-22T10:02:00Z') }, { from: 'codex-1', text: 'not mine', t: 1 }],
  };
  assert.deepEqual(promptHistory(data), ['fix it', 'check the build', '/goal ship']);
  assert.deepEqual(promptHistory(null), []);
});
