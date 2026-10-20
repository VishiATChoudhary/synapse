// The phone link end to end, without a phone or a window: a real local Synapse Cloud, the app's bridge
// (app/phone.mjs) with a stand-in for the app, and the phone app's own protocol code (mobile/src/link.js).
//   node app/tests/phone.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCloud } from './cloud-fixture.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-phone-'));
process.env.SYNAPSE_HOME = home;
process.env.SYNAPSE_DEMO = '1';
const cloud = await startCloud();
process.env.SYNAPSE_CLOUD = cloud.base;

// this Mac is signed in, as the app would be
const owner = await cloud.signup('owner@example.com', 'Owner');
fs.writeFileSync(path.join(home, 'account.json'), JSON.stringify({ cloud: cloud.base, token: owner.token, user: owner.user }));

const phone = await import('../phone.mjs');
const link = await import('../../mobile/src/link.js');
const { listAgents } = await import('../../lib.mjs');

const api = listAgents().find((a) => a.name === 'api-auth');
const typed = [], spawnAsks = [], changes = [];
phone.start({
  projects: () => [{ key: '/dev/acme-api', label: 'acme-api', color: '#2F5BEA', worktrees: [{ path: '/dev/acme-api', name: 'acme-api', branch: 'main', home: true }] }],
  kinds: () => ['claude', 'codex'],
  ptyOf: (pid) => (pid === api.pid ? '7' : null),
  write: (id, data) => typed.push({ id, data }),
  submit: (id, text) => typed.push({ id, text }),
  spawn: (r) => { spawnAsks.push(r); setTimeout(() => phone.spawned(r.req, '7'), 50); },
  changed: (e) => changes.push(e),
});

const until = async (what, fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 200)); }
};
const inbox = [];
const take = (t) => inbox.find((m) => m.t === t);
const wait = (c, t, what) => until(what, async () => { inbox.push(...await c.poll()); return take(t); });

// the phone signs in to the same account and finds this Mac
await assert.rejects(link.signIn(cloud.base, { email: 'owner@example.com', password: 'wrong wrong' }, 'x'), /Wrong email or password/);
const me = await link.signIn(cloud.base, { email: 'owner@example.com', password: 'correct horse' }, 'Test iPhone');
const [mac] = await until('the Mac registers as a computer', async () => { const l = await link.computers(me); return l.length && l; });
assert.equal(mac.name, os.hostname().replace(/\.local$/, ''));
const c = link.connect(me, mac);

// signed in is not enough: the Mac asks first
await c.send({ t: 'hello' });
await wait(c, 'waiting', 'the Mac says it is waiting');
assert.deepEqual(changes.at(-1), { asking: 'Test iPhone' });
let dev = await phone.devices();
assert.equal(dev.list[0].state, 'asking');
await c.send({ t: 'send', id: api.id, text: 'too early' });
await new Promise((r) => setTimeout(r, 2500));
assert.ok(!typed.some((x) => x.text === 'too early'), 'nothing is typed before the phone is allowed');

phone.allow(dev.list[0].id);
inbox.length = 0;
await c.send({ t: 'hello' });
await wait(c, 'state', 'state arrives once allowed');
const st = take('state');
assert.ok(st.agents.some((a) => a.id === api.id && a.inApp), 'the agent in an app terminal can be steered');
assert.ok(st.agents.some((a) => !a.inApp), 'agents elsewhere are listed read only');
assert.deepEqual(st.kinds, ['claude', 'codex']);

await c.send({ t: 'watch', id: api.id });
await wait(c, 'messages', 'the watched conversation arrives');
assert.ok(take('messages').messages.length > 0);

await c.send({ t: 'send', id: api.id, text: 'ship it' });
await until('the prompt is typed into its terminal', () => typed.some((x) => x.text === 'ship it'));

// another account's phone can neither see this Mac nor write to it
const stranger = await cloud.signup('stranger@example.com', 'Stranger');
const them = await link.signIn(cloud.base, { email: 'stranger@example.com', password: 'correct horse' }, 'Their phone');
assert.equal((await link.computers(them)).length, 0);
await assert.rejects(link.connect(them, mac).send({ t: 'send', id: api.id, text: 'rm -rf /' }), (e) => e.status === 403);

// a replayed box does nothing the second time; a box sealed with another key is dropped
const raw = (item) => fetch(`${cloud.base}/v1/send`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${me.machine}` }, body: JSON.stringify({ to: mac.id, items: [item] }) });
const box = link.seal(me, mac.publicKey, { t: 'send', id: api.id, text: 'once' });
await raw(box); await raw(box);
await until('the box is read', () => typed.some((x) => x.text === 'once'));
const forger = { ...me, secretKey: Buffer.alloc(32, 9).toString('base64') };
await raw(link.seal(forger, mac.publicKey, { t: 'send', id: api.id, text: 'forged' }));
await c.send({ t: 'send', id: api.id, text: 'fine' });
await until('later messages still work', () => typed.some((x) => x.text === 'fine'));
await new Promise((r) => setTimeout(r, 2000));
assert.equal(typed.filter((x) => x.text === 'once').length, 1, 'a replay is dropped');
assert.ok(!typed.some((x) => x.text === 'forged'), 'a box with the wrong key is dropped');

// stop is Esc; an agent outside the app cannot be typed into
await c.send({ t: 'stop', id: api.id });
await until('stop sends Esc', () => typed.some((x) => x.data === '\x1b'));
inbox.length = 0;
await c.send({ t: 'send', id: st.agents.find((a) => !a.inApp).id, text: 'hi' });
await wait(c, 'error', 'an error comes back');
assert.match(take('error').error, /outside the Synapse app/);

// spawning: only added workspaces, only known kinds
inbox.length = 0;
await c.send({ t: 'spawn', req: 'r1', cwd: '/etc', kind: 'claude' });
await wait(c, 'error', 'a folder outside the workspaces is refused');
assert.match(take('error').error, /not a workspace/);
inbox.length = 0;
await c.send({ t: 'spawn', req: 'r2', cwd: '/dev/acme-api', kind: 'bash -c evil' });
await wait(c, 'error', 'an unknown kind is refused');
inbox.length = 0;
await c.send({ t: 'spawn', req: 'r3', cwd: '/dev/acme-api', kind: 'claude', prompt: 'hello there' });
await wait(c, 'spawned', 'the new agent is reported');
assert.equal(take('spawned').id, api.id);
assert.deepEqual(spawnAsks.map((r) => r.req), ['r3']);
assert.equal(spawnAsks[0].prompt, 'hello there');

// removed on the Mac: the phone is off the account's devices and cannot send any more
await phone.remove(dev.list[0].id);
await assert.rejects(c.send({ t: 'hello' }), (e) => e.status === 403);
dev = await phone.devices();
assert.equal(dev.list.length, 0);

// signing out on the phone does the same for the next phone
const again = await link.signIn(cloud.base, { email: 'owner@example.com', password: 'correct horse' }, 'Second iPhone');
await link.signOut(again);
await assert.rejects(link.connect(again, mac).send({ t: 'hello' }), (e) => e.status === 403);

console.log('PASS phone link: account sign-in, the Mac asks first, state, chat, other accounts shut out, replay and forgery dropped, read-only agents, spawn rules, remove and sign out');
cloud.stop();
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
