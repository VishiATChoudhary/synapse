// The activity view's numbers: prompts counted from Claude and Codex transcripts (not tool results, meta lines,
// subagents or command echoes), commits by your git email once per commit, and the streak, level and badges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collect, summarize, promptAt, dayOf, levelAt } from '../app/activity.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-activity-')));
const day = 86400_000, now = Date.now(), iso = (ms) => new Date(ms).toISOString();
const write = (file, lines) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); };

test('only prompts a person typed count', () => {
  const t = iso(now);
  const claude = (o) => promptAt('claude', JSON.stringify({ type: 'user', timestamp: t, ...o }));
  assert.equal(claude({ message: { role: 'user', content: 'fix the bug' } }), Date.parse(t));
  assert.equal(claude({ message: { role: 'user', content: [{ type: 'text', text: 'and this' }] } }), Date.parse(t));
  assert.equal(claude({ message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }), null);
  assert.equal(claude({ isMeta: true, message: { role: 'user', content: 'caveat' } }), null);
  assert.equal(claude({ isSidechain: true, message: { role: 'user', content: 'subagent task' } }), null);
  assert.equal(claude({ message: { role: 'user', content: '<command-name>/clear</command-name>' } }), null);
  const codex = (text) => promptAt('codex', JSON.stringify({ timestamp: t, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
  assert.equal(codex('check the jobs'), Date.parse(t));
  assert.equal(codex('<environment_context>cwd</environment_context>'), null);
  assert.equal(codex('# AGENTS.md instructions for /x'), null);
  assert.equal(promptAt('codex', JSON.stringify({ timestamp: t, type: 'event_msg', payload: { type: 'user_message', message: 'check the jobs' } })), null, 'the event twin of a prompt is not counted again');
});

test('collect counts prompts per day and your commits once, and caches transcripts', async () => {
  const homes = { claude: path.join(tmp, 'claude'), codex: path.join(tmp, 'codex') };
  write(path.join(homes.claude, 'p', 's.jsonl'), [
    { type: 'user', timestamp: iso(now), message: { content: 'one' } },
    { type: 'user', timestamp: iso(now - day), message: { content: 'two' } },
    { type: 'user', timestamp: iso(now - 400 * day), message: { content: 'too old' } },
  ]);
  write(path.join(homes.codex, '2026', 'r.jsonl'), [{ timestamp: iso(now), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'three' }] } }]);
  const repo = path.join(tmp, 'repo'), g = (...a) => execFileSync('git', ['-C', repo, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  fs.mkdirSync(repo); g('init', '-q', '-b', 'main'); g('config', 'user.email', 'me@x.dev'); g('config', 'user.name', 'Me');
  g('commit', '-q', '--allow-empty', '-m', 'mine');
  g('-c', 'user.email=other@x.dev', 'commit', '-q', '--allow-empty', '-m', 'theirs');
  const wt = path.join(tmp, 'wt'); g('worktree', 'add', '-q', wt, '-b', 'side');
  const cacheFile = path.join(tmp, 'cache.json');
  const a = await collect({ repos: [repo, wt], cacheFile, homes, now, gh: async () => null });
  assert.deepEqual(a.prompts.claude, { [dayOf(now)]: 1, [dayOf(now - day)]: 1 });
  assert.deepEqual(a.prompts.codex, { [dayOf(now)]: 1 });
  assert.deepEqual(a.commits, { [dayOf(now)]: 1 }, 'my commit, once across two worktrees; not theirs');
  assert.equal(a.totals.todayPrompts, 2);
  assert.ok(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).files[path.join(homes.claude, 'p', 's.jsonl')], 'transcript cached');
  const gh = await collect({ repos: [], cacheFile, homes, now, gh: async () => ({ login: 'me', days: { [dayOf(now)]: 5 } }) });
  assert.equal(gh.totals.code, 5, 'GitHub contributions are the code count when gh is signed in');
});

test('tokens: a Claude reply counts once though its usage repeats and a fork copies it; Codex counts each step', async () => {
  const homes = { claude: path.join(tmp, 'tc'), codex: path.join(tmp, 'tx') };
  const reply = { type: 'assistant', timestamp: iso(now), message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 } } };
  const ask = { type: 'user', uuid: 'u1', timestamp: iso(now), message: { content: 'hi' } };
  write(path.join(homes.claude, 'p', 'parent.jsonl'), [ask, reply, reply]);
  write(path.join(homes.claude, 'p', 'fork.jsonl'), [ask, reply, { ...reply, message: { ...reply.message, id: 'msg_2' } }]);
  const usage = (all, out) => ({ timestamp: iso(now), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: all, output_tokens: out } } } });
  write(path.join(homes.codex, 'r.jsonl'), [{ timestamp: iso(now), type: 'turn_context', payload: { model: 'gpt-6-sol' } }, usage(100, 4), usage(100, 4), usage(250, 10)]);
  const a = await collect({ repos: [], cacheFile: path.join(tmp, 'tcache.json'), homes, now, gh: async () => null });
  assert.equal(a.totals.claude, 1, 'the forked prompt is the same prompt');
  assert.deepEqual(a.tokens[dayOf(now)], { all: 1115 * 2 + 250, out: 5 * 2 + 10 });
  assert.deepEqual(a.models, [{ name: 'claude-opus-5-5', tokens: 2230 }, { name: 'gpt-6-sol', tokens: 250 }]);
  assert.equal(a.totals.todayTokens, 2480);
});

test('streaks survive a quiet today, and level, XP and badges follow the counts', () => {
  const at = (i) => dayOf(now - i * day);
  const claude = {}, codex = { [at(3)]: 1 };
  for (let i = 1; i <= 8; i++) claude[at(i)] = 150; // yesterday back 8 days, nothing today
  claude[at(20)] = 1;
  const s = summarize({ github: null, commits: { [at(1)]: 2 }, prompts: { claude, codex } }, now);
  assert.equal(s.streak, 8);
  assert.equal(s.longest, 8);
  assert.equal(s.xp, 2 * 10 + (8 * 150 + 1 + 1) * 2);
  assert.equal(s.level, levelAt(s.xp));
  assert.ok(s.levelFrom <= s.xp && s.xp < s.levelTo);
  const got = s.badges.filter((b) => b.got).map((b) => b.id).sort();
  assert.deepEqual(got, ['bigday', 'duo', 'prompt1k', 'streak7']);
  assert.equal(levelAt(0), 1); assert.equal(levelAt(100), 2); assert.equal(levelAt(399), 2); assert.equal(levelAt(400), 3);
});
