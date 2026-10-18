// Unit tests for agent talk's data layer: edge mode, peer handle, closed talk agents. No network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-talk-'));
process.env.SYNAPSE_HOME = home;
process.env.SYNAPSE_DEMO = '1';
process.env.SYNAPSE_CLAUDE_HOME = path.join(home, 'claude');
const lib = await import('../lib.mjs');
const ops = await import('../ops.mjs');
const { FILES, readJSON, writeJSON, listAgents, localAgents, findAgent } = lib;
fs.mkdirSync(path.dirname(FILES.peerState), { recursive: true });

const peer = (extra = {}) => writeJSON(FILES.remote, { relay: 'http://x', token: 't', peers: { m1: { name: 'Bob', pair: 'p', since: 1, ...extra } }, blocked: [] });
const edgeFor = () => {
  const from = localAgents()[0];
  const { edge } = ops.createEdge(from, { id: 'r-m1-x', name: 'x', kind: 'agent', cwd: '/tmp/x' });
  return { from, edge };
};

beforeEach(() => { writeJSON(FILES.edges, []); writeJSON(FILES.peerState, {}); });

test('setMode talk needs a request peer', () => {
  peer();
  const { edge } = edgeFor();
  assert.throws(() => ops.setMode(edge.id, 'talk'), /request/);
});

test('setMode talk stores a snapshot and sync clears it', () => {
  peer({ via: 'request' });
  const { from, edge } = edgeFor();
  const out = ops.setMode(edge.id, 'talk');
  assert.equal(out.edge.mode, 'talk');
  const saved = readJSON(FILES.edges, []).find((e) => e.id === edge.id);
  assert.equal(saved.mode, 'talk');
  assert.equal(saved.snapshot.kind, from.kind);
  ops.setMode(edge.id, 'sync');
  const after = readJSON(FILES.edges, []).find((e) => e.id === edge.id);
  assert.equal('mode' in after, false);
  assert.equal('snapshot' in after, false);
});

test('setMode refuses a mirrored edge', () => {
  peer({ via: 'request' });
  writeJSON(FILES.edges, [{ id: 'mm', from: 'r-m1-x', to: 'demo-docs', mirrored: true, remote: 'm1', owner: 'Bob' }]);
  assert.throws(() => ops.setMode('mm', 'talk'), /owner/);
});

test('findAgent matches name@handle', () => {
  peer({ via: 'request', handle: 'bob' });
  writeJSON(FILES.peerState, { m1: { name: 'Robert', seen: Date.now(), shares: [], agents: [{ id: 'x', name: 'api', kind: 'claude', status: 'idle', project: 'p', startedAt: 1 }] } });
  const hit = findAgent(listAgents(), 'api@bob');
  assert.equal(hit.id, 'r-m1-x');
  assert.equal(hit.remote.handle, 'bob');
});

// ---------------------------------------------------------------- talk.mjs: store, validation, queue
const talk = await import('../talk.mjs');
const reset = () => { writeJSON(FILES.talks, {}); writeJSON(FILES.edges, []); };
const talkEdge = (target = localAgents()[0].id, asker = 'x') => {
  peer({ via: 'request', handle: 'bob' });
  const e = { id: 'te1', from: target, to: `r-m1-${asker}`, mode: 'talk', snapshot: { kind: 'codex', name: 'snap', cwd: '/tmp', transcript: null, format: 'codex' } };
  writeJSON(FILES.edges, [e]);
  return { target, asker };
};
const ask = (target, seq = 1, extra = {}) => ({ type: 'talk-ask', conv: 'c1', seq, target, asker: 'x', askerName: 'ax', question: 'why?', ...extra });
const state = () => readJSON(FILES.talks, {});

test('ask without a talk edge is refused', () => {
  reset(); peer({ via: 'request' });
  const out = talk.receiveAsk('m1', ask(localAgents()[0].id));
  assert.equal(out[0].type, 'talk-end');
  assert.equal(out[0].reason, 'refused');
  assert.equal((state().conversations || []).length, 0);
});

test('ask over 4000 chars is refused', () => {
  reset(); const { target } = talkEdge();
  const out = talk.receiveAsk('m1', ask(target, 1, { question: 'a'.repeat(4001) }));
  assert.equal(out[0].reason, 'refused');
  assert.equal((state().conversations || []).length, 0);
});

test('first ask opens a conversation and queues it', () => {
  reset(); const { target } = talkEdge();
  const out = talk.receiveAsk('m1', ask(target));
  const s = state();
  assert.equal(s.conversations[0].status, 'open');
  assert.equal(s.conversations[0].peerHandle, 'bob');
  assert.equal(s.queue.length, 1);
  assert.equal(out[0].type, 'talk-status');
  assert.equal(out[0].position, 1);
});

test('mode follows the target kind', () => {
  reset(); const { target } = talkEdge();
  talk.receiveAsk('m1', ask(target));
  const kind = localAgents().find((a) => a.id === target).kind;
  assert.equal(state().conversations[0].mode, talk.ADAPTERS[kind]);
});

test('sixth waiting ask for one agent is busy', () => {
  reset(); const { target } = talkEdge();
  for (let i = 1; i <= 5; i++) assert.equal(talk.receiveAsk('m1', ask(target, i, { conv: `c${i}` }))[0].type, 'talk-status');
  const out = talk.receiveAsk('m1', ask(target, 1, { conv: 'c6' }));
  assert.equal(out[0].reason, 'busy');
  assert.equal(state().queue.length, 5);
});

test('61st ask in an hour is busy', () => {
  reset(); const { target } = talkEdge();
  const t0 = Date.now();
  for (let i = 1; i <= 60; i++) {
    assert.equal(talk.receiveAsk('m1', ask(target, 1, { conv: `r${i}` }), t0 + i)[0].type, 'talk-status', `ask ${i}`);
    writeJSON(FILES.talks, { ...state(), queue: [] });
  }
  assert.equal(talk.receiveAsk('m1', ask(target, 1, { conv: 'r61' }), t0 + 100)[0].reason, 'busy');
  assert.equal(talk.receiveAsk('m1', ask(target, 1, { conv: 'r62' }), t0 + 3_700_000)[0].type, 'talk-status');
});

test('the 21st turn ends the conversation and the next ask starts fresh', () => {
  reset(); const { target } = talkEdge();
  const n = Date.now();
  for (let i = 1; i <= 20; i++) { talk.receiveAsk('m1', ask(target, i), n + i); writeJSON(FILES.talks, { ...state(), queue: [] }); }
  const out = talk.receiveAsk('m1', ask(target, 21), n + 2000);
  assert.deepEqual([out[0].reason, out[0].note], ['idle', 'turn limit']);
  assert.equal(state().conversations[0].status, 'ended');
  assert.equal(talk.receiveAsk('m1', ask(target, 22), n + 2001)[0].type, 'talk-status');
  assert.equal(state().conversations.filter((c) => c.status === 'open')[0].turns.length, 1);
});

test('revalidates at the front of the queue', () => {
  reset(); const { target } = talkEdge();
  talk.receiveAsk('m1', ask(target));
  writeJSON(FILES.edges, []);
  assert.equal(talk.nextJob(), null);
  const out = talk.takeOutgoing();
  assert.equal(out[0].to, 'm1');
  assert.equal(out[0].item.type, 'talk-end');
  assert.equal(out[0].item.reason, 'refused');
  assert.deepEqual(talk.takeOutgoing(), []);
});

test('nextJob skips a target that is running', () => {
  reset(); const { target } = talkEdge();
  talk.receiveAsk('m1', ask(target));
  assert.deepEqual(talk.nextJob(), { conv: 'c1', seq: 1 });
  writeJSON(FILES.talks, { ...state(), running: [{ conv: 'c1', pid: 1 }] });
  assert.equal(talk.nextJob(), null);
});

test('reconcile ends idle and cut conversations', () => {
  reset(); const { target } = talkEdge();
  const t0 = Date.now();
  talk.receiveAsk('m1', ask(target), t0);
  assert.deepEqual(talk.reconcile(t0 + 31 * 60_000), ['c1']);
  assert.equal(state().conversations[0].endReason, 'idle');
  assert.equal(state().queue.length, 0);
  writeJSON(FILES.talks, {});
  talk.receiveAsk('m1', ask(target), t0);
  writeJSON(FILES.edges, readJSON(FILES.edges, []).map((e) => { const { mode, snapshot, ...rest } = e; return rest; }));
  assert.deepEqual(talk.reconcile(t0 + 1000), ['c1']);
  assert.equal(state().conversations[0].endReason, 'owner');
});

test('reconcile ends a conversation whose peer is gone', () => {
  reset(); const { target } = talkEdge();
  talk.receiveAsk('m1', ask(target));
  writeJSON(FILES.remote, { relay: 'http://x', token: 't', peers: {}, blocked: [] });
  assert.deepEqual(talk.reconcile(), ['c1']);
  assert.equal(state().conversations[0].endReason, 'revoked');
});

// ---------------------------------------------------------------- talk.mjs: the answering runner
import { spawn as realSpawn } from 'node:child_process';
const FAKE = new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname;
process.env.SYNAPSE_TALK_CLAUDE = FAKE;
const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); }
};
const idle = () => (state().running || []).length === 0;
const conv0 = () => state().conversations[0];
const echoOf = (seq = 1) => JSON.parse(conv0().turns.find((t) => t.seq === seq).a);
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const answerOnce = async (target, seq = 1, opts = {}) => { talk.receiveAsk('m1', ask(target, seq)); await talk.tick(opts); await waitFor(idle); };
const toolless = (argv) => {
  assert.ok(argv.includes('-p'));
  assert.equal(after(argv, '--tools'), '');
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(after(argv, '--output-format'), 'json');
  assert.ok(after(argv, '--append-system-prompt').includes('You have no tools'));
  assert.ok(after(argv, '--append-system-prompt').includes('Never write tool calls'));
};

test('native first turn forks the session tool-less', async () => {
  reset(); const { target } = talkEdge('demo-api-auth');
  await answerOnce(target);
  const e = echoOf();
  toolless(e.argv);
  assert.equal(after(e.argv, '--resume'), 'demo-api-auth');
  assert.ok(e.argv.includes('--fork-session'));
  assert.equal(e.external, '1');
  assert.equal(e.stdin.trim(), 'why?');
  assert.ok(conv0().forkSession);
  const items = talk.takeOutgoing().map((o) => o.item);
  assert.deepEqual(items.map((i) => i.type === 'talk-status' ? i.state : i.type), ['answering', 'talk-answer']);
  assert.equal(items[1].seq, 1);
});

test('follow-up resumes the fork, not the agent', async () => {
  reset(); const { target } = talkEdge('demo-api-auth');
  await answerOnce(target, 1);
  const fork = conv0().forkSession;
  await answerOnce(target, 2);
  const e = echoOf(2);
  toolless(e.argv);
  assert.equal(after(e.argv, '--resume'), fork);
  assert.ok(!e.argv.includes('--fork-session'));
  assert.ok(!e.argv.includes('demo-api-auth'));
  assert.equal(conv0().forkSession, fork);
});

test('replay for a codex agent carries its transcript and no --resume on turn 1', async () => {
  reset(); const { target } = talkEdge('demo-api-rate-limit');
  await answerOnce(target);
  assert.equal(conv0().mode, 'replay');
  const e = echoOf();
  toolless(e.argv);
  assert.ok(!e.argv.includes('--resume'));
  assert.ok(!e.argv.includes('--fork-session'));
  assert.match(after(e.argv, '--append-system-prompt'), /a codex agent/);
  assert.match(e.stdin, /Token bucket per tenant/);
  assert.match(e.stdin, /why\?/);
  assert.equal(e.external, '1');
  // its follow-up resumes the answerer session
  const fork = conv0().forkSession;
  await answerOnce(target, 2);
  assert.equal(after(echoOf(2).argv, '--resume'), fork);
});

test('profile flags are stripped to the allowlist', () => {
  writeJSON(FILES.app, { profiles: { claude: { command: 'FOO=bar SYNAPSE_EXTERNAL=0 claude --dangerously-skip-permissions --model opus --mcp-config x.json' } } });
  try {
    const conv = { id: 'c', mode: 'native', forkSession: null, targetName: 'api', peerHandle: 'bob', turns: [] };
    const cmd = talk.answerCommand(conv, { seq: 1, q: 'hi' }, { kind: 'claude', id: 'sess', cwd: '/nope', name: 'api' });
    assert.equal(after(cmd.args, '--model'), 'opus');
    for (const bad of ['--dangerously-skip-permissions', '--mcp-config', 'x.json', 'claude']) assert.ok(!cmd.args.includes(bad), bad);
    toolless(cmd.args);
    assert.equal(cmd.env.FOO, 'bar');
    assert.equal(cmd.env.SYNAPSE_EXTERNAL, '1');
    assert.equal(cmd.bin, FAKE);
  } finally { fs.rmSync(FILES.app, { force: true }); }
});

test('times out after 120 s', async () => {
  reset(); const { target } = talkEdge('demo-api-auth');
  assert.equal(talk.LIMITS.answerMs, 120_000);
  talk._setLimit('answerMs', 300);
  process.env.FAKE_CLAUDE_SLEEP_MS = '10000';
  try {
    talk.receiveAsk('m1', ask(target));
    await talk.tick();
    const pid = state().running[0].pid;
    assert.ok(pid > 0);
    await waitFor(idle);
    assert.equal(conv0().endReason, 'error');
    assert.ok(talk.takeOutgoing().some((o) => o.item.type === 'talk-end' && o.item.reason === 'error'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { talk._setLimit('answerMs', 120_000); delete process.env.FAKE_CLAUDE_SLEEP_MS; }
});

test('crash ends with error', async () => {
  reset(); const { target } = talkEdge('demo-api-auth');
  process.env.FAKE_CLAUDE_EXIT = '1';
  try { await answerOnce(target); } finally { delete process.env.FAKE_CLAUDE_EXIT; }
  assert.equal(conv0().status, 'ended');
  assert.equal(conv0().endReason, 'error');
  assert.equal(conv0().turns[0].a, null);
});

test('missing transcript is unavailable', async () => {
  reset(); const { target } = talkEdge('demo-docs');
  let spawned = 0;
  await answerOnce(target, 1, { spawn: (...a) => { spawned++; return realSpawn(...a); } });
  assert.equal(spawned, 0);
  assert.equal(conv0().endReason, 'unavailable');
  assert.ok(talk.takeOutgoing().some((o) => o.item.reason === 'unavailable'));
});

test('no claude binary is unsupported', async () => {
  reset(); const { target } = talkEdge('demo-api-rate-limit');
  process.env.SYNAPSE_TALK_CLAUDE = path.join(home, 'no-such-claude');
  try { await answerOnce(target); } finally { process.env.SYNAPSE_TALK_CLAUDE = FAKE; }
  assert.equal(conv0().endReason, 'unsupported');
  assert.equal(conv0().endNote, 'Claude Code is needed to answer for this agent');
});

test('external forks never show as agents', async () => {
  reset(); const { target } = talkEdge('demo-api-auth');
  process.env.FAKE_CLAUDE_SLEEP_MS = '10000';
  try {
    talk.receiveAsk('m1', ask(target));
    await talk.tick();
    const pid = state().running[0].pid;
    assert.ok(lib.externalForks().pids.has(pid));
    assert.ok(!localAgents().some((a) => a.pid === pid));
    // ending the conversation kills its answer at once
    talk.endConversation('c1', 'owner');
    await waitFor(idle);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal(conv0().endReason, 'owner');
  } finally { delete process.env.FAKE_CLAUDE_SLEEP_MS; }
  // a demo agent stands in for a fork: by pid while running, by session id afterwards
  writeJSON(FILES.talks, { conversations: [{ id: 'z', forkSession: 'demo-api-auth', status: 'ended', lastAt: Date.now() }], running: [{ conv: 'z', pid: 102 }] });
  const ids = localAgents().map((a) => a.id);
  assert.ok(!ids.includes('demo-api-auth'));
  assert.ok(!ids.includes('demo-api-review'));
  assert.ok(ids.includes('demo-docs'));
});

test('cleanup deletes only the fork session file', async () => {
  reset(); const { target } = talkEdge('demo-api-auth');
  await answerOnce(target);
  const fork = conv0().forkSession;
  const dir = path.join(home, 'claude', 'projects', '-dev-acme-api');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [`${fork}.jsonl`, 'demo-api-auth.jsonl', `${fork}.jsonl.bak`]) fs.writeFileSync(path.join(dir, f), '{}\n');
  talk.endConversation('c1', 'asker');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['demo-api-auth.jsonl', `${fork}.jsonl.bak`].sort());
});

test('state writes are serialized by a lock file', () => {
  reset();
  fs.writeFileSync(`${FILES.talks}.lock`, '1');
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(`${FILES.talks}.lock`, old, old);
  // a stale lock is broken, and the lock is released after the write
  talk.endConversation('nope', 'owner');
  assert.equal(fs.existsSync(`${FILES.talks}.lock`), false);
});

test('first turn passes a pre-made --session-id', async () => {
  reset(); const { target } = talkEdge('demo-api-auth');
  await answerOnce(target);
  const native = echoOf().argv;
  assert.match(after(native, '--session-id'), /^[0-9a-f-]{36}$/);
  assert.equal(after(native, '--session-id'), conv0().forkSession);
  assert.ok(native.includes('--fork-session'));
  await answerOnce(target, 2);
  assert.ok(!echoOf(2).argv.includes('--session-id'));
  reset(); talkEdge('demo-api-rate-limit');
  await answerOnce('demo-api-rate-limit');
  const replay = echoOf().argv;
  assert.equal(after(replay, '--session-id'), conv0().forkSession);
  assert.ok(!replay.includes('--resume'));
});

test('killed first turn still gets cleaned up', async () => {
  reset(); const { target } = talkEdge('demo-api-auth');
  process.env.FAKE_CLAUDE_SLEEP_MS = '10000';
  try {
    talk.receiveAsk('m1', ask(target));
    await talk.tick();
    const fork = conv0().forkSession;
    assert.match(fork, /^[0-9a-f-]{36}$/);
    assert.ok(lib.externalForks().sessions.has(fork));
    const dir = path.join(home, 'claude', 'projects', '-dev-killed');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${fork}.jsonl`), '{}\n');
    talk.endConversation('c1', 'owner');
    await waitFor(idle);
    assert.equal(fs.existsSync(path.join(dir, `${fork}.jsonl`)), false);
  } finally { delete process.env.FAKE_CLAUDE_SLEEP_MS; }
});

test('session id equal to the agent is rejected', async () => {
  reset(); const { target } = talkEdge('demo-api-auth');
  const dir = path.join(home, 'claude', 'projects', '-dev-own');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'demo-api-auth.jsonl'), '{}\n');
  process.env.FAKE_CLAUDE_SESSION = 'demo-api-auth';
  try { await answerOnce(target); } finally { delete process.env.FAKE_CLAUDE_SESSION; }
  assert.equal(conv0().endReason, 'error');
  assert.notEqual(conv0().forkSession, 'demo-api-auth');
  assert.equal(conv0().turns[0].a, null);
  assert.ok(fs.existsSync(path.join(dir, 'demo-api-auth.jsonl')));
  // cleanup itself refuses the agent's own id and anything not shaped like a session uuid
  const uuid = '11111111-2222-3333-4444-555555555555';
  for (const f of [`${uuid}.jsonl`, 'abc.jsonl']) fs.writeFileSync(path.join(dir, f), '{}\n');
  talk.cleanup({ forkSession: uuid, target: uuid });
  talk.cleanup({ forkSession: 'abc', target: 'x' });
  assert.ok(fs.existsSync(path.join(dir, `${uuid}.jsonl`)));
  assert.ok(fs.existsSync(path.join(dir, 'abc.jsonl')));
});

// ---------------------------------------------------------------- wiring: mailbox, hook
const remote = await import('../remote.mjs');
const { spawnSync } = await import('node:child_process');
const asker = (extra = {}) => ({
  id: 'c9', role: 'asker', peer: 'm1', target: 'r-m1-x', status: 'open', turns: [{ seq: 1, q: 'hi', a: null }], createdAt: 1, lastAt: 1, ...extra,
});

// the production path: remote.sync() polling a stub relay that hands out `items` once (push is refused, which
// leaves the outbox alone)
const http = await import('node:http');
const viaRelay = async (items) => {
  let first = true;
  const srv = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/v1/poll') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ items: first ? items : [] })); first = false; }
    else { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = readJSON(FILES.remote, {});
  writeJSON(FILES.remote, { ...cfg, relay: `http://127.0.0.1:${srv.address().port}` });
  try { await remote.sync().catch(() => {}); } finally { srv.close(); }
};

test('malformed talk items never break pull', async () => {
  reset(); talkEdge();
  writeJSON(FILES.remote, {
    relay: 'http://x', token: 't', blocked: [],
    peers: { m1: { name: 'Bob', pair: 'p', since: 1, via: 'request' }, m2: { name: 'Eve', pair: 'p', since: 1 } },
  });
  writeJSON(path.join(home, 'remote', 'outbox.json'), []);
  const target = localAgents()[0].id;
  await viaRelay([
    null, 7, { type: 'talk-ask', from: 'm1', conv: 'a', seq: 1, target, asker: 'x', question: 'q'.repeat(10_000) },
    { type: 'talk-ask', from: 'm1', conv: 'b', seq: 'x', target, asker: 'x', question: 'q' },
    { type: 'talk-answer', from: 'm1', conv: 'nope', seq: 1, answer: 'a' },
    { type: 'talk-ask', from: 'm2', conv: 'd', seq: 1, target, asker: 'x', question: 'q' },
    { type: 'talk-end', from: 'm3', conv: 'e' },
  ]);
  assert.deepEqual(state().conversations || [], []);
  const out = readJSON(path.join(home, 'remote', 'outbox.json'), []);
  assert.ok(out.length >= 1);
  assert.ok(out.every((o) => o.item.type === 'talk-end' && o.item.reason === 'refused'));
  assert.equal(out.filter((o) => o.to === 'm2').length, 1);
});

test('queueItem appends to the outbox', () => {
  writeJSON(path.join(home, 'remote', 'outbox.json'), []);
  remote.queueItem('m1', { type: 'talk-end', conv: 'z', reason: 'owner' });
  assert.deepEqual(readJSON(path.join(home, 'remote', 'outbox.json'), []), [{ to: 'm1', item: { type: 'talk-end', conv: 'z', reason: 'owner' } }]);
});

test('receiveReply records status, answer and end for the asker only', () => {
  reset(); peer({ via: 'request' });
  writeJSON(FILES.talks, { conversations: [asker(), asker({ id: 'o1', role: 'owner' })] });
  talk.receiveReply('m1', { type: 'talk-status', conv: 'c9', seq: 1, state: 'answering' });
  assert.equal(state().conversations[0].turns[0].state, 'answering');
  talk.receiveReply('m2', { type: 'talk-answer', conv: 'c9', seq: 1, answer: 'wrong peer' });
  talk.receiveReply('m1', { type: 'talk-answer', conv: 'unknown', seq: 1, answer: 'x' });
  talk.receiveReply('m1', { type: 'talk-answer', conv: 'o1', seq: 1, answer: 'owner role' });
  assert.equal(state().conversations[0].turns[0].a, null);
  talk.receiveReply('m1', { type: 'talk-answer', conv: 'c9', seq: 1, answer: 'a'.repeat(9000) });
  assert.equal(state().conversations[0].turns[0].a.length, 8000);
  talk.receiveReply('m1', { type: 'talk-end', conv: 'c9', reason: 'owner' });
  assert.equal(state().conversations[0].status, 'ended');
  assert.equal(state().conversations[0].endReason, 'owner');
  assert.equal(state().conversations[1].turns.length, 1);
});

test('hook is silent for external forks', () => {
  const run = (env) => spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'hook.mjs')], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'demo-api-auth', prompt: 'hello' }),
    env: { ...process.env, SYNAPSE_HOME: home, ...env }, encoding: 'utf8',
  });
  assert.equal(run({ SYNAPSE_EXTERNAL: '1' }).stdout, '');
});

// ---------------------------------------------------------------- asker side: ask, end, exactly-once delivery
const me = () => localAgents()[0];
const sharedWithMe = (mode = 'talk') => {
  peer({ via: 'request', handle: 'bob' });
  writeJSON(FILES.peerState, { m1: { name: 'Robert', seen: Date.now(), shares: [], agents: [{ id: 'x', name: 'api', kind: 'claude', status: 'idle', project: 'p', startedAt: 1 }] } });
  writeJSON(FILES.edges, [{ id: 'mm', from: 'r-m1-x', to: me().id, mirrored: true, remote: 'm1', owner: 'Robert', ...(mode === 'talk' ? { mode } : {}) }]);
  writeJSON(FILES.messages, []);
  writeJSON(FILES.talks, {});
  writeJSON(path.join(home, 'remote', 'outbox.json'), []);
};
const outbox = () => readJSON(path.join(home, 'remote', 'outbox.json'), []);
const noSync = async () => {};
// answers the open question the way a sync that pulled a talk-answer would
const answerWith = (answer, at) => async () => {
  const c = state().conversations[0];
  talk.receiveReply('m1', { type: 'talk-answer', conv: c.id, seq: c.turns[c.turns.length - 1].seq, answer }, at());
};

test('ask resolves name@handle and queues talk-ask', async () => {
  sharedWithMe();
  const r = await ops.ask(me(), 'api@bob', 'why?', { waitMs: 0, sync: noSync });
  assert.equal(r.status, 'queued');
  const c = state().conversations[0];
  assert.equal(c.role, 'asker');
  assert.equal(c.peer, 'm1');
  assert.equal(c.target, 'x');
  assert.equal(c.asker, me().id);
  assert.equal(r.conversation, c.id);
  const [o] = outbox();
  assert.equal(o.to, 'm1');
  assert.deepEqual(o.item, { type: 'talk-ask', conv: c.id, seq: 1, target: 'x', asker: me().id, askerName: me().name, question: 'why?' });
});

test('ask on a sync share explains talk is off', async () => {
  sharedWithMe('sync');
  await assert.rejects(ops.ask(me(), 'api@bob', 'why?', { waitMs: 0, sync: noSync }), /not.*questions|talk/i);
  assert.equal(outbox().length, 0);
});

test('ask on a local agent points to send', async () => {
  sharedWithMe();
  const other = localAgents()[1];
  await assert.rejects(ops.ask(me(), other.name, 'why?', { sync: noSync }), /send/);
});

test('ask reuses the open conversation, an ended one is never reused', async () => {
  sharedWithMe();
  const a = await ops.ask(me(), 'api@bob', 'one', { waitMs: 0, sync: noSync });
  const b = await ops.ask(me(), 'api@bob', 'two', { waitMs: 0, sync: noSync });
  assert.equal(b.conversation, a.conversation);
  assert.equal(state().conversations[0].turns[1].seq, 2);
  assert.deepEqual(ops.endTalk(me(), a.conversation), { ended: true });
  assert.deepEqual(outbox().pop().item, { type: 'talk-end', conv: a.conversation, reason: 'asker' });
  assert.equal(state().conversations[0].endReason, 'asker');
  const c = await ops.ask(me(), 'api@bob', 'three', { waitMs: 0, sync: noSync });
  assert.notEqual(c.conversation, a.conversation);
  await assert.rejects(ops.ask(me(), 'api@bob', 'four', { conversation: a.conversation, waitMs: 0, sync: noSync }), /ended/);
});

test('an answer inside the wait is returned and never reaches the inbox', async () => {
  sharedWithMe();
  const t0 = 1_000_000;
  let t = t0;
  const r = await ops.ask(me(), 'api@bob', 'why?', { waitMs: 90_000, now: () => t, interval: 0, sync: answerWith('because', () => t) });
  assert.deepEqual({ answer: r.answer }, { answer: 'because' });
  assert.equal(lib.takeInbox(me().id).length, 0);
});

test('answer at the deadline is delivered once', async () => {
  // the answer lands just after the deadline, before ask has cleared waitUntil: inbox xor return
  sharedWithMe();
  let t = 1_000_000;
  const r = await ops.ask(me(), 'api@bob', 'why?', {
    waitMs: 90_000, interval: 0, now: () => t,
    sync: async () => { t += 90_001; await answerWith('late', () => t)(); },
  });
  const inbox = lib.takeInbox(me().id);
  assert.equal((r.answer === 'late' ? 1 : 0) + inbox.filter((m) => m.text.includes('late')).length, 1);
  assert.equal(r.status, 'queued');
  assert.equal(inbox.length, 1);
});

test('answer after the wait cleared waitUntil lands in the inbox', async () => {
  sharedWithMe();
  const r = await ops.ask(me(), 'api@bob', 'why?', { waitMs: 0, sync: noSync });
  assert.equal(r.status, 'queued');
  assert.equal(state().conversations[0].turns[0].waitUntil, null);
  talk.receiveReply('m1', { type: 'talk-answer', conv: r.conversation, seq: 1, answer: 'finally' });
  const inbox = lib.takeInbox(me().id);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].fromName, 'api@Robert');
  assert.equal(inbox[0].from, 'r-m1-x');
  assert.match(inbox[0].text, /finally/);
  assert.match(inbox[0].text, new RegExp(r.conversation));
  // a repeated delivery of the same answer adds nothing
  talk.receiveReply('m1', { type: 'talk-answer', conv: r.conversation, seq: 1, answer: 'finally' });
  assert.equal(lib.takeInbox(me().id).length, 0);
});

test('late answer lands in the inbox', async () => {
  sharedWithMe();
  const r = await ops.ask(me(), 'api@bob', 'why?', { waitMs: 0, sync: noSync });
  talk.receiveReply('m1', { type: 'talk-answer', conv: r.conversation, seq: 1, answer: 'sorry for the wait' });
  assert.match(lib.takeInbox(me().id)[0].text, /sorry for the wait/);
});

test('an end during the wait is returned as ended', async () => {
  sharedWithMe();
  const r = await ops.ask(me(), 'api@bob', 'why?', {
    waitMs: 90_000, interval: 0,
    sync: async () => { talk.receiveReply('m1', { type: 'talk-end', conv: state().conversations[0].id, reason: 'refused' }); },
  });
  assert.equal(r.status, 'ended');
  assert.equal(r.reason, 'refused');
  assert.equal(lib.takeInbox(me().id).length, 0);
});

test('an end after the wait lands in the inbox', async () => {
  sharedWithMe();
  const r = await ops.ask(me(), 'api@bob', 'why?', { waitMs: 0, sync: noSync });
  talk.receiveReply('m1', { type: 'talk-end', conv: r.conversation, reason: 'busy' });
  const inbox = lib.takeInbox(me().id);
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].text, /busy/);
});

test('ask keeps syncing until the wait is over', async () => {
  sharedWithMe();
  let t = 0, calls = 0;
  const r = await ops.ask(me(), 'api@bob', 'why?', { waitMs: 5000, interval: 0, now: () => (t += 1000), sync: async () => { calls++; } });
  assert.equal(r.status, 'queued');
  assert.ok(calls >= 3, `synced ${calls} times`);
});

test('ask says offline when the friend was last seen long ago', async () => {
  sharedWithMe();
  const states = readJSON(FILES.peerState, {});
  states.m1.seen = Date.now() - lib.REMOTE_OFFLINE - 5000;
  writeJSON(FILES.peerState, states);
  let synced = 0;
  const r = await ops.ask(me(), 'api@bob', 'why?', { sync: async () => { synced++; } });
  assert.equal(r.status, 'offline');
  assert.equal(outbox().length, 1);
  assert.equal(state().conversations[0].turns[0].waitUntil ?? null, null);
});

test('ask rejects an empty or oversized question', async () => {
  sharedWithMe();
  await assert.rejects(ops.ask(me(), 'api@bob', '   ', { sync: noSync }), /question/i);
  await assert.rejects(ops.ask(me(), 'api@bob', 'a'.repeat(4001), { sync: noSync }), /4000/);
  assert.equal(outbox().length, 0);
});

test('endTalk refuses a conversation that is not yours', () => {
  sharedWithMe();
  writeJSON(FILES.talks, { conversations: [asker({ id: 'o1', role: 'owner' })] });
  assert.throws(() => ops.endTalk(me(), 'o1'), /conversation/i);
  assert.throws(() => ops.endTalk(me(), 'nope'), /conversation/i);
});

test('answer survives a waiter that died', () => {
  sharedWithMe();
  const t0 = 1_000_000;
  writeJSON(FILES.talks, { conversations: [asker({ targetName: 'api', peerName: 'Robert', asker: me().id, askerName: me().name, turns: [{ seq: 1, q: 'hi', a: 'stored', waitUntil: t0 + 90_000 }] })] });
  talk.sweepAnswers(t0 + 1000); // the waiter's deadline has not passed: still its to return
  assert.equal(lib.takeInbox(me().id).length, 0);
  talk.sweepAnswers(t0 + 90_001);
  const inbox = lib.takeInbox(me().id);
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].text, /stored/);
  talk.sweepAnswers(t0 + 200_000);
  assert.equal(lib.takeInbox(me().id).length, 0);
});

test('a taken answer is not swept into the inbox', () => {
  sharedWithMe();
  writeJSON(FILES.talks, { conversations: [asker({ targetName: 'api', peerName: 'Robert', asker: me().id, turns: [{ seq: 1, q: 'hi', a: 'x', taken: true, waitUntil: null }] })] });
  talk.sweepAnswers();
  assert.equal(lib.takeInbox(me().id).length, 0);
});

test('ask clears waitUntil when it leaves by a throw', async () => {
  sharedWithMe();
  let calls = 0;
  const now = () => { if (++calls > 2) throw new Error('cancelled'); return 1_000_000; };
  // the answer lands inside the wait, then ask dies before it can take it
  await assert.rejects(ops.ask(me(), 'api@bob', 'why?', { waitMs: 90_000, interval: 0, now, sync: answerWith('mid', () => 1_000_000) }), /cancelled/);
  const turn = state().conversations[0].turns[0];
  assert.equal(turn.waitUntil, null);
  const inbox = lib.takeInbox(me().id);
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].text, /mid/);
});

test('a sync with an empty mailbox still sweeps a dead waiter\'s answer', async () => {
  sharedWithMe();
  writeJSON(FILES.talks, { conversations: [asker({ targetName: 'api', peerName: 'Robert', asker: me().id, askerName: me().name, turns: [{ seq: 1, q: 'hi', a: 'stored', waitUntil: Date.now() - 1000 }] })] });
  await viaRelay([]);
  const inbox = lib.takeInbox(me().id);
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].text, /stored/);
  await viaRelay([]);
  assert.equal(lib.takeInbox(me().id).length, 0);
});

test('ending your own conversation puts nothing in the inbox', async () => {
  sharedWithMe();
  const r = await ops.ask(me(), 'api@bob', 'why?', { waitMs: 0, sync: noSync });
  ops.endTalk(me(), r.conversation);
  talk.sweepAnswers(Date.now() + 200_000);
  await viaRelay([]);
  assert.equal(lib.takeInbox(me().id).length, 0);
});
