// A friend accepted my offer: the cloud's item makes this machine link my offered agent to the agent they picked,
// once, read only when talk cannot be switched on (the agent is not running here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-offers-'));
process.env.SYNAPSE_HOME = home;
const remote = await import('../remote.mjs');
const { FILES, readJSON, remoteId } = await import('../lib.mjs');

test('an accepted offer links my agent to the one they picked, once', async () => {
  const it = { type: 'request', id: 'r_1', kind: 'offer', status: 'accepted', mode: 'talk', from: 'm-lee', agent: { id: 'sess-ana', name: 'api-auth', kind: 'claude' }, receiver: { id: 'lee-4', name: 'web', kind: 'codex', project: 'shop' } };
  await remote.linkOffer(it);
  await remote.linkOffer(it);
  const edges = readJSON(FILES.edges, []);
  assert.equal(edges.length, 1, 'once');
  assert.equal(edges[0].from, 'sess-ana');
  assert.equal(edges[0].to, remoteId('m-lee', 'lee-4'));
  assert.equal(edges[0].toName, 'web');
  assert.equal(edges[0].mode, undefined, 'not running here: stays read only');
  await remote.linkOffer({ ...it, receiver: {} });
  assert.equal(readJSON(FILES.edges, []).length, 1, 'an item without a receiver links nothing');
});
