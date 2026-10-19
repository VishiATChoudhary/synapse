// The canvas server's agent talk routes: edge mode, the conversation list, ending a conversation.
// Runs server.mjs against a demo home on a spare port; no relay, no claude.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-talk-api-'));
const PORT = 49000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${PORT}`;
const write = (f, v) => fs.writeFileSync(path.join(home, f), JSON.stringify(v));
const read = (f) => JSON.parse(fs.readFileSync(path.join(home, f), 'utf8'));

// m1 paired through a request (may talk), m2 through an invite code (may not)
write('remote.json', { relay: 'http://127.0.0.1:1', token: 't', peers: {
  m1: { name: 'Bob', pair: 'p', via: 'request', handle: 'bob', since: 1 },
  m2: { name: 'Eve', pair: 'q', since: 1 },
}, blocked: [] });
write('edges.json', [
  { id: 'e-req', from: 'demo-api-auth', to: 'r-m1-x', fromName: 'api-auth', toName: 'x' },
  { id: 'e-inv', from: 'demo-api-auth', to: 'r-m2-y', fromName: 'api-auth', toName: 'y' },
]);

let server;
before(async () => {
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SYNAPSE_HOME: home, SYNAPSE_DEMO: '1', NO_OPEN: '1', PORT: String(PORT), SYNAPSE_SYNC_MS: '600000' },
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('synapse running')) resolve(); });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});
after(() => { server?.kill(); fs.rmSync(home, { recursive: true, force: true }); });

const call = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json() };
};

test('mode talk on an invite-code friend is a 409 with the reason', async () => {
  const r = await call('/api/edges/e-inv/mode', 'POST', { mode: 'talk' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /request/);
  assert.equal(read('edges.json').find((e) => e.id === 'e-inv').mode, undefined);
});

test('mode talk and back to sync on a request friend', async () => {
  let r = await call('/api/edges/e-req/mode', 'POST', { mode: 'talk' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'talk');
  assert.equal(read('edges.json').find((e) => e.id === 'e-req').mode, 'talk');
  r = await call('/api/edges/e-req/mode', 'POST', { mode: 'sync' });
  assert.equal(r.status, 200);
  assert.equal('mode' in read('edges.json').find((e) => e.id === 'e-req'), false);
  assert.equal((await call('/api/edges/nope/mode', 'POST', { mode: 'talk' })).status, 409);
});

test('GET /api/talks lists both sides, recent ones only, and state carries the open ones', async () => {
  assert.deepEqual((await call('/api/talks')).body, []);
  await call('/api/edges/e-req/mode', 'POST', { mode: 'talk' });
  const now = Date.now();
  write('talks.json', { conversations: [
    { id: 'c-own', role: 'owner', peer: 'm1', peerName: 'Bob', peerHandle: 'bob', asker: 'x', askerName: 'bobs-agent', target: 'demo-api-auth',
      targetName: 'api-auth', mode: 'native', forkSession: '11111111-1111-1111-1111-111111111111', status: 'open',
      turns: [{ seq: 1, q: 'why jwt?', a: 'rotation', askedAt: now - 5000, answeredAt: now - 4000 }, { seq: 2, q: 'and refresh?', a: null, askedAt: now }],
      createdAt: now - 5000, lastAt: now },
    { id: 'c-ask', role: 'asker', peer: 'm1', peerName: 'Bob', target: 'z', targetName: 'bob-api', asker: 'demo-docs', askerName: 'docs',
      status: 'open', turns: [{ seq: 1, q: 'hi?', a: null, askedAt: now, state: 'answering' }], createdAt: now, lastAt: now },
    { id: 'c-old', role: 'owner', peer: 'm1', peerName: 'Bob', asker: 'x', target: 'demo-api-auth', status: 'ended', endReason: 'idle',
      turns: [], createdAt: now - 40 * 864e5, lastAt: now - 40 * 864e5 },
  ], queue: [{ conv: 'c-own', seq: 2 }], running: [], rate: {}, outgoing: [] });
  const list = (await call('/api/talks')).body;
  assert.deepEqual(list.map((c) => c.id).sort(), ['c-ask', 'c-own']);
  const own = list.find((c) => c.id === 'c-own');
  assert.equal(own.role, 'owner');
  assert.equal(own.live, 'queued');
  assert.equal(own.turns.length, 2);
  assert.equal('forkSession' in own, false);
  assert.equal(list.find((c) => c.id === 'c-ask').live, 'answering');
  const st = (await call('/api/state')).body;
  assert.deepEqual(st.talks.map((c) => c.id).sort(), ['c-ask', 'c-own']);
});

test('POST /api/talks/:id/end ends my side as owner and hers as asker', async () => {
  let r = await call('/api/talks/c-own/end', 'POST');
  assert.equal(r.status, 200);
  let c = read('talks.json').conversations.find((x) => x.id === 'c-own');
  assert.equal(c.status, 'ended');
  assert.equal(c.endReason, 'owner');
  assert.ok(read('talks.json').outgoing.some((o) => o.to === 'm1' && o.item.type === 'talk-end' && o.item.conv === 'c-own' && o.item.reason === 'owner'));

  r = await call('/api/talks/c-ask/end', 'POST');
  assert.equal(r.status, 200);
  c = read('talks.json').conversations.find((x) => x.id === 'c-ask');
  assert.equal(c.status, 'ended');
  assert.equal(c.endReason, 'asker');

  assert.deepEqual((await call('/api/state')).body.talks, []);
  assert.equal((await call('/api/talks/nope/end', 'POST')).status, 404);
});
