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
