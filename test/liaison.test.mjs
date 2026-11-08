// A liaison (⌘N, ask a friend) reads and asks a friend's agent as the agent of mine it works for, and hears the
// answers itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-liaison-'));
process.env.SYNAPSE_HOME = home;
process.env.SYNAPSE_DEMO = '1';
process.env.SYNAPSE_CLAUDE_HOME = path.join(home, 'claude');
const lib = await import('../lib.mjs');
const ops = await import('../ops.mjs');
const talk = await import('../talk.mjs');
const { FILES, readJSON, writeJSON, localAgents } = lib;
fs.mkdirSync(path.dirname(FILES.peerState), { recursive: true });

const [worker, liaison] = localAgents();
const outbox = () => readJSON(path.join(home, 'remote', 'outbox.json'), []);
function shared() {
  writeJSON(FILES.remote, { relay: 'http://x', token: 't', peers: { m1: { name: 'Bob', pair: 'p', since: 1, via: 'request', handle: 'bob' } }, blocked: [] });
  writeJSON(FILES.peerState, { m1: { name: 'Robert', seen: Date.now(), shares: [], talkRequests: true, agents: [{ id: 'x', name: 'api', kind: 'claude', status: 'busy', project: 'p', startedAt: 1 }] } });
  writeJSON(FILES.edges, [{ id: 'mm', from: 'r-m1-x', to: worker.id, mirrored: true, remote: 'm1', owner: 'Robert', mode: 'talk' }]);
  writeJSON(FILES.liaisons, {});
  writeJSON(FILES.talks, {});
  writeJSON(path.join(home, 'remote', 'outbox.json'), []);
}

test('an agent that is not a liaison cannot ask what was shared with another', async () => {
  shared();
  await assert.rejects(ops.ask(liaison, 'api@bob', 'why?', { waitMs: 0, sync: async () => {} }), /talk is off/);
});

test('a liaison asks as the agent it works for, links to it, and hears late answers itself', async () => {
  shared();
  process.env.SYNAPSE_LIAISON_FOR = worker.id;
  process.env.SYNAPSE_LIAISON_NAME = worker.name;
  try {
    const peers = ops.peers(liaison);
    assert.equal(peers.liaisonFor.id, worker.id);
    assert.deepEqual(peers.friendsAgents.map((a) => a.id), ['r-m1-x']);
    // its conversation reaches the worker through a link from the liaison
    assert.ok(readJSON(FILES.edges, []).some((e) => e.from === liaison.id && e.to === worker.id && e.liaison));

    const r = await ops.ask(liaison, 'api@bob', 'what are you changing?', { waitMs: 0, sync: async () => {} });
    assert.equal(r.status, 'queued');
    const [o] = outbox();
    assert.equal(o.item.asker, worker.id); // the friend's machine checks its share to the worker
    const c = readJSON(FILES.talks, {}).conversations[0];
    assert.equal(c.via, liaison.id);
    talk.receiveReply('m1', { type: 'talk-answer', conv: c.id, seq: 1, answer: 'the auth middleware' }, Date.now());
    const msgs = readJSON(FILES.messages, []);
    assert.ok(msgs.some((m) => m.to === liaison.id && /auth middleware/.test(m.text)));
    assert.ok(!msgs.some((m) => m.to === worker.id), 'the worker is not interrupted');
  } finally {
    delete process.env.SYNAPSE_LIAISON_FOR; delete process.env.SYNAPSE_LIAISON_NAME;
  }
  // the role sticks without the env (after a restart)
  assert.equal(ops.liaisonFor(liaison).id, worker.id);
});
