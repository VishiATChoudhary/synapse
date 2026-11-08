// What the computer sends can be lost on the way to the phone (a poll answer cut off when iOS suspends the app, a
// full mailbox). The phone says which tags it has ("have"); the computer sends again whatever is missing, and takes
// the open chat from there when the "watch" itself was lost. A real local Synapse Cloud and the app's bridge.
//   node app/tests/phone-heal.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCloud } from './cloud-fixture.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-phone-heal-'));
process.env.SYNAPSE_HOME = home;
process.env.SYNAPSE_DEMO = '1';
const cloud = await startCloud();
process.env.SYNAPSE_CLOUD = cloud.base;
const owner = await cloud.signup('owner@example.com', 'Owner');
fs.writeFileSync(path.join(home, 'account.json'), JSON.stringify({ cloud: cloud.base, token: owner.token, user: owner.user }));

const phone = await import('../phone.mjs');
const link = await import('../../mobile/src/link.js');
const { listAgents } = await import('../../lib.mjs');
const cwd = fs.realpathSync(home);
phone.start({
  projects: () => [{ key: cwd, label: 'proj', color: '#2F5BEA', worktrees: [{ path: cwd, name: 'proj', branch: 'main', home: true }] }],
  kinds: () => ['claude'], ptyOf: () => null, write: () => {}, submit: () => {}, spawn: () => {}, changed: () => {},
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(150); }
};
const me = await link.signIn(cloud.base, { email: 'owner@example.com', password: 'correct horse' }, 'Test iPhone');
const [mac] = await until('the Mac registers', async () => { const l = await link.computers(me); return l.length && l; });
const c = link.connect(me, mac);
let inbox = [], stateV = null; // the newest list tag the phone has (the demo list changes as its agents work)
const take = async () => { const got = await c.poll(); for (const m of got) if (m.t === 'state') stateV = m.v; inbox.push(...got); };
await c.send({ t: 'hello' });
await until('the Mac asks first', async () => { await take(); return inbox.some((m) => m.t === 'waiting'); });
phone.allow((await phone.devices()).list[0].id);
inbox = [];
await c.send({ t: 'hello' });
const st = await until('state', async () => { await take(); return inbox.find((m) => m.t === 'state'); });
assert.ok(st.v, 'the list carries a tag');
const [A, B, C] = listAgents().filter((a) => !a.remote).map((a) => a.id);
assert.ok(A && B && C, 'demo agents');

// the open chat arrives with a tag
await c.send({ t: 'watch', id: A });
const ma = await until('chat A', async () => { await take(); return inbox.find((m) => m.t === 'messages' && m.id === A && m.v); });

// up to date: nothing is sent again
await sleep(6500); await take();
inbox = [];
const had = stateV;
await c.send({ t: 'have', id: A, state: had, chat: ma.v });
await sleep(4000); await take();
assert.ok(!inbox.some((m) => (m.t === 'messages' && m.id === A) || (m.t === 'state' && m.v === had)), 'nothing resent when the phone has it all');

// chat B is watched, but its messages are lost on the way (the poll answer never reaches the phone)
await c.send({ t: 'watch', id: B });
await until('chat B sent (and dropped)', async () => (await c.poll()).some((m) => m.t === 'messages' && m.id === B));
await sleep(6500); // a tag sent moments ago is left to settle
inbox = [];
await c.send({ t: 'have', id: B, state: stateV, chat: null });
const mb = await until('chat B again', async () => { await take(); return inbox.find((m) => m.t === 'messages' && m.id === B); });
assert.ok(mb.messages.length, 'chat B has its messages');

// the watch for C is lost: the next "have" says which chat is open, and it comes
inbox = [];
await c.send({ t: 'have', id: C, state: stateV, chat: null });
await until('chat C from have alone', async () => { await take(); return inbox.find((m) => m.t === 'messages' && m.id === C); });

// the list was lost: a stale tag gets it again
inbox = [];
await c.send({ t: 'have', id: C, state: 'stale', chat: null });
const st2 = await until('state again', async () => { await take(); return inbox.find((m) => m.t === 'state'); });
assert.equal(st2.agents.length, st.agents.length);

console.log('phone-heal: ok');
process.exit(0);
