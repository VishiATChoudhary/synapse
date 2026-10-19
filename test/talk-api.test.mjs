// The canvas server's agent talk routes: edge mode, the conversation list, ending a conversation.
// Runs server.mjs against a demo home on a spare port; no relay, no claude.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
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
  // the live state carries no texts, only how many were asked
  const lean = st.talks.find((c) => c.id === 'c-own');
  assert.equal('turns' in lean, false);
  assert.equal(lean.asked, 2);
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

// a friend's agent asked over the sync share e-req: Allow flips it to talk, Not now leaves it sync
const pendingReq = (id, extra = {}) => ({ id, peer: 'm1', peerName: 'Bob', peerHandle: 'bob', target: 'demo-api-auth', targetName: 'api-auth',
  asker: 'x', askerName: 'bobs-agent', at: Date.now(), status: 'pending', ...extra });
test('talk requests: state lists the open ones, allow and not now decide them', async () => {
  await call('/api/edges/e-req/mode', 'POST', { mode: 'sync' });
  const R1 = '11111111-1111-4111-8111-111111111111', R2 = '22222222-2222-4222-8222-222222222222';
  write('talks.json', { conversations: [], talkRequests: [pendingReq(R1), pendingReq(R2, { asker: 'gone' })], outgoing: [] });
  assert.deepEqual((await call('/api/state')).body.talkRequests.map((r) => r.id), [R1], 'only requests whose share is still there');
  assert.equal((await call(`/api/talk-requests/${R2}/allow`, 'POST')).status, 409);
  const r = await call(`/api/talk-requests/${R1}/allow`, 'POST');
  assert.equal(r.status, 200);
  assert.equal(read('edges.json').find((e) => e.id === 'e-req').mode, 'talk');
  assert.equal(read('talks.json').talkRequests.find((x) => x.id === R1).status, 'allowed');
  assert.deepEqual((await call('/api/state')).body.talkRequests, []);

  await call('/api/edges/e-req/mode', 'POST', { mode: 'sync' });
  write('talks.json', { conversations: [], talkRequests: [pendingReq(R2)], outgoing: [] });
  assert.equal((await call(`/api/talk-requests/${R2}/dismiss`, 'POST')).status, 200);
  assert.equal(read('talks.json').talkRequests[0].status, 'dismissed');
  assert.equal('mode' in read('edges.json').find((e) => e.id === 'e-req'), false);
  assert.equal((await call(`/api/talk-requests/${R2}/dismiss`, 'POST')).status, 409);
  write('talks.json', { conversations: [], talkRequests: [pendingReq(R1)], outgoing: [] });
});

// a page on another site (or a rebinding host name) must not flip a share to talk, end a conversation, or read one
const raw = (p, method, headers) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  r.on('error', reject);
  r.end(method === 'POST' ? JSON.stringify({ mode: 'talk' }) : undefined);
});
test('talk routes refuse cross-site callers', async () => {
  const hostile = [
    { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', 'content-type': 'text/plain' },
    { origin: 'https://evil.example' },
    { host: `evil.example:${PORT}` },
  ];
  for (const h of hostile) {
    assert.equal(await raw('/api/edges/e-req/mode', 'POST', h), 403);
    assert.equal(await raw('/api/talks/c-own/end', 'POST', h), 403);
    assert.equal(await raw('/api/talks', 'GET', h), 403);
    assert.equal(await raw('/api/talk-requests/11111111-1111-4111-8111-111111111111/allow', 'POST', h), 403);
    assert.equal(await raw('/api/talk-requests/11111111-1111-4111-8111-111111111111/dismiss', 'POST', h), 403);
  }
  assert.equal(read('talks.json').talkRequests[0].status, 'pending', 'nothing was decided from outside');
  // the canvas itself still gets through
  assert.equal(await raw('/api/talks', 'GET', { 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${PORT}` }), 200);
});

// every API route: a rebinding host name reads nothing, a foreign page changes nothing
test('a foreign Host gets 403 on every API route', async () => {
  const foreign = { host: `evil.example:${PORT}` };
  for (const p of ['/api/state', '/api/agents/demo-api-auth/recent', '/api/remote']) assert.equal(await raw(p, 'GET', foreign), 403, p);
  // localhost by any of its names still reads
  for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, 'localhost']) {
    assert.equal(await raw('/api/state', 'GET', { host }), 200, host);
    assert.equal(await raw('/api/agents/demo-api-auth/recent', 'GET', { host }), 200, host);
  }
});

test('a cross-site write to any API route gets 403', async () => {
  const site = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', 'content-type': 'text/plain' };
  assert.equal(await raw('/api/edges/e-req', 'DELETE', site), 403);
  assert.ok(read('edges.json').some((e) => e.id === 'e-req'), 'the edge is still there');
  for (const p of ['/api/edges', '/api/layout', '/api/agents/demo-api-auth/name', '/api/projects/name', '/api/remote/name']) {
    assert.equal(await raw(p, 'POST', site), 403, p);
  }
  // the canvas page itself may: a layout write with its own Origin
  assert.equal(await raw('/api/layout', 'POST', { 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${PORT}` }), 200);
});
