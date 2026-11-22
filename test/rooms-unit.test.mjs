// Rooms, one machine: what a friend's machine may and may not do through relay items, and the secret scrubber.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-rooms-unit-'));
process.env.SYNAPSE_HOME = home;
process.env.SYNAPSE_DEMO = '1';
fs.writeFileSync(path.join(home, 'remote.json'), JSON.stringify({ machineId: 'host', name: 'alice', peers: { bob: { name: 'bob' }, eve: { name: 'eve' } } }));
const rooms = await import('../rooms.mjs');
const state = () => JSON.parse(fs.readFileSync(path.join(home, 'rooms.json'), 'utf8'));
const room = (id) => state().rooms.find((r) => r.id === id);
const uuid = () => crypto.randomUUID();

const r = rooms.create({ name: 'team' });
rooms.addMember(r.id, 'bob');
rooms.receive('bob', { type: 'room-agent', room: r.id, op: 'add', agent: { id: 'b1', name: 'helper', kind: 'claude' } });

test('a friend who is not a member can not post, add agents or leave for others', () => {
  const n = room(r.id).messages.length;
  rooms.receive('eve', { type: 'room-post', room: r.id, msg: { id: uuid(), text: 'hi', from: { type: 'human', machine: 'eve' } } });
  rooms.receive('eve', { type: 'room-agent', room: r.id, op: 'add', agent: { id: 'e1', name: 'x', kind: 'claude' } });
  rooms.receive('eve', { type: 'room-leave', room: r.id });
  assert.equal(room(r.id).messages.length, n);
  assert.ok(!room(r.id).agents.some((a) => a.machine === 'eve'));
  assert.ok(room(r.id).members.some((m) => m.machine === 'bob'));
});

test('a member can not post as someone else or as an agent that is not theirs', () => {
  const n = room(r.id).messages.length;
  rooms.receive('bob', { type: 'room-post', room: r.id, msg: { id: uuid(), text: 'i am alice', from: { type: 'human', machine: 'host' } } });
  rooms.receive('bob', { type: 'room-post', room: r.id, msg: { id: uuid(), text: 'fake', from: { type: 'agent', machine: 'bob', agent: 'not-added' } } });
  rooms.receive('bob', { type: 'room-msg', room: r.id, msg: { id: uuid(), text: 'only the host passes messages on', from: { type: 'human', machine: 'bob' } } });
  assert.equal(room(r.id).messages.length, n);
  rooms.receive('bob', { type: 'room-post', room: r.id, msg: { id: uuid(), text: 'real', from: { type: 'human', machine: 'bob', name: 'ALICE (owner)' } } });
  const last = room(r.id).messages.at(-1);
  assert.equal(last.text, 'real');
  assert.equal(last.from.name, 'bob', 'the name comes from the room, not the sender');
});

test('only Claude and Codex agents get in, from any machine', () => {
  for (const kind of ['gemini', 'opencode', 'cursor-agent', 'custom']) rooms.receive('bob', { type: 'room-agent', room: r.id, op: 'add', agent: { id: `k-${kind}`, name: kind, kind } });
  assert.deepEqual(room(r.id).agents.map((a) => a.kind), ['claude']);
  assert.throws(() => rooms.addAgent(r.id, 'demo-web-e2e'), /Only Claude and Codex/);
});

test('a room state from anyone but its host changes nothing', () => {
  rooms.receive('eve', { type: 'room-state', room: { id: r.id, name: 'hijacked', host: 'eve', members: [{ machine: 'host' }, { machine: 'eve' }], agents: [], messages: [] } });
  assert.equal(room(r.id).name, 'team');
});

test('mentions: @name, @name@owner, not inside other words or emails', () => {
  const rm = { agents: [{ id: 'a', name: 'ml-eval', owner: 'alice', machine: 'host' }, { id: 'b', name: 'ml-eval', owner: 'bob', machine: 'bob' }, { id: 'c', name: 'api', owner: 'bob', machine: 'bob' }] };
  assert.deepEqual(rooms.mentionsIn(rm, 'hey @ml-eval@alice'), ['host:a']);
  assert.deepEqual(rooms.mentionsIn(rm, '@ml-eval go').sort(), ['bob:b', 'host:a']);
  assert.deepEqual(rooms.mentionsIn(rm, 'mail me at x@api.com or @api-gateway'), []);
  assert.deepEqual(rooms.mentionsIn(rm, '(@API)'), ['bob:c']);
});

test('redact scrubs keys, tokens, connection strings and named secrets, keeps ordinary text', () => {
  const t = rooms.redact([
    'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA', 'aws AKIAABCDEFGHIJKLMNOP', 'gh ghp_0123456789abcdefghijABCDEFGHIJ',
    'slack xoxb-1234567890-abcdefghij', 'DB postgres://u:pw1234@h:5432/db', 'STRIPE_SECRET_KEY=whsec_live_abcdef123',
    '"password": "correct-horse"', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
  ].join('\n'));
  for (const s of ['sk-ant', 'AKIAABCD', 'ghp_', 'xoxb-', 'pw1234', 'whsec_live', 'correct-horse', 'abcdefghijklmnopqrstuvwxyz', 'MIIabc']) assert.ok(!t.includes(s), s);
  assert.equal(rooms.redact('nDCG@10 went 0.412 to 0.447; token budget is fine'), 'nDCG@10 went 0.412 to 0.447; token budget is fine');
});

test('answers: only from a Claude model, only for the session asked for', () => {
  const out = (o) => JSON.stringify({ type: 'result', session_id: 's1', result: 'ok', modelUsage: { 'claude-sonnet-5-5': {} }, ...o });
  assert.deepEqual(rooms.parseAnswer(out(), 's1'), { text: 'ok' });
  assert.match(rooms.parseAnswer(out({ modelUsage: { 'qwen-abliterated': {} } }), 's1').error, /not a Claude/);
  assert.match(rooms.parseAnswer(out({ modelUsage: { 'claude-sonnet-5-5': {}, 'llama-3': {} } }), 's1').error, /not a Claude/);
  assert.match(rooms.parseAnswer(out({ modelUsage: {} }), 's1').error, /not a Claude/);
  assert.match(rooms.parseAnswer(out(), 's2').error, /wrong session/);
});

test('the answering command: no tools, no MCP, no settings, a Claude model, no endpoint override', () => {
  process.env.ANTHROPIC_BASE_URL = 'http://elsewhere';
  const cmd = rooms.answerCommand({ room: room(r.id), msg: room(r.id).messages.at(-1), agent: { name: 'ml-eval', owner: 'alice' }, source: { id: 'demo-ml-eval', kind: 'claude', cwd: '/nope' } });
  const flag = (f) => cmd.args[cmd.args.indexOf(f) + 1];
  assert.equal(flag('--tools'), '');
  assert.equal(flag('--setting-sources'), '');
  assert.ok(rooms.ROOM_MODELS.includes(flag('--model')));
  assert.ok(cmd.args.includes('--strict-mcp-config'));
  assert.equal(cmd.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(cmd.env.SYNAPSE_EXTERNAL, '1');
  delete process.env.ANTHROPIC_BASE_URL;
});
