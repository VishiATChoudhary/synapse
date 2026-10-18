// Unit tests for agent talk's data layer: edge mode, peer handle, closed talk agents. No network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-talk-'));
process.env.SYNAPSE_HOME = home;
process.env.SYNAPSE_DEMO = '1';
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
