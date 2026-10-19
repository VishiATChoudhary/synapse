// The phone link end to end, without a phone or a window: a local relay, the app's bridge (app/phone.mjs)
// with a stand-in for the app, and the phone app's own protocol code (mobile/src/link.js).
//   node app/tests/phone.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-phone-'));
process.env.SYNAPSE_HOME = home;
process.env.SYNAPSE_DEMO = '1';
const { server } = await import('../../relay/relay.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.SYNAPSE_RELAY = `http://127.0.0.1:${server.address().port}`;

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
const pollInto = async (c) => { inbox.push(...await c.poll()); };
const take = (t) => inbox.find((m) => m.t === t);

// pairing: the code from the QR, then the phone joins it
const { url, svg } = await phone.pair();
assert.match(svg, /<svg/);
const p = link.parsePairing(url);
assert.ok(p, 'the QR link parses');
const me = await link.pair(p, 'test phone');
await until('the computer accepts the phone', () => phone.devices().length === 1);
assert.equal(phone.devices()[0].name, 'test phone');
assert.deepEqual(changes.at(-1), { paired: 'test phone' });

// a second phone with the same code is turned away: a code is good once
const late = await link.pair(p, 'someone else');
const intruder = link.connect(late);
await intruder.send({ t: 'send', id: api.id, text: 'rm -rf /' });

const c = link.connect(me);
await c.send({ t: 'hello' });
await until('state arrives', async () => { await pollInto(c); return take('state'); });
const st = take('state');
assert.ok(st.agents.some((a) => a.id === api.id && a.inApp), 'the agent in an app terminal can be steered');
assert.ok(st.agents.some((a) => !a.inApp), 'agents elsewhere are listed read only');
assert.deepEqual(st.kinds, ['claude', 'codex']);

await c.send({ t: 'watch', id: api.id });
await until('the watched conversation arrives', async () => { await pollInto(c); return take('messages'); });
assert.ok(take('messages').messages.length > 0);

await c.send({ t: 'send', id: api.id, text: 'ship it' });
await until('the prompt is typed into its terminal', () => typed.some((x) => x.text === 'ship it'));
assert.equal(phone.devices().length, 1, 'the second phone never got paired');
assert.ok(!typed.some((x) => x.text === 'rm -rf /'), 'nothing from the second phone was typed');

// a replayed box does nothing the second time
const box = link.seal(me.key, { t: 'send', id: api.id, text: 'once' });
const relay = me.relay;
const resend = () => fetch(`${relay}/v1/send`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` }, body: JSON.stringify({ to: me.peer, pair: me.pair, items: [box] }) });
await resend(); await resend();
await until('the box is read', () => typed.some((x) => x.text === 'once'));
await new Promise((r) => setTimeout(r, 2500));
assert.equal(typed.filter((x) => x.text === 'once').length, 1, 'a replay is dropped');

// a box sealed with another key is dropped
await c.send({ t: 'send', id: api.id, text: 'fine' });
const forged = link.seal(Buffer.alloc(32, 1).toString('base64'), { t: 'send', id: api.id, text: 'forged' });
await fetch(`${relay}/v1/send`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${me.token}` }, body: JSON.stringify({ to: me.peer, pair: me.pair, items: [forged] }) });
await until('later messages still work', () => typed.some((x) => x.text === 'fine'));
await new Promise((r) => setTimeout(r, 2000));
assert.ok(!typed.some((x) => x.text === 'forged'), 'a box with the wrong key is dropped');

// stop is Esc; an agent outside the app cannot be typed into
await c.send({ t: 'stop', id: api.id });
await until('stop sends Esc', () => typed.some((x) => x.data === '\x1b'));
const outside = st.agents.find((a) => !a.inApp);
inbox.length = 0;
await c.send({ t: 'send', id: outside.id, text: 'hi' });
await until('an error comes back', async () => { await pollInto(c); return take('error'); });
assert.match(take('error').error, /outside the Synapse app/);

// spawning: only added workspaces, only known kinds
inbox.length = 0;
await c.send({ t: 'spawn', req: 'r1', cwd: '/etc', kind: 'claude' });
await until('a folder outside the workspaces is refused', async () => { await pollInto(c); return take('error'); });
assert.match(take('error').error, /not a workspace/);
inbox.length = 0;
await c.send({ t: 'spawn', req: 'r2', cwd: '/dev/acme-api', kind: 'bash -c evil' });
await until('an unknown kind is refused', async () => { await pollInto(c); return take('error'); });
inbox.length = 0;
await c.send({ t: 'spawn', req: 'r3', cwd: '/dev/acme-api', kind: 'claude', prompt: 'hello there' });
await until('the new agent is reported', async () => { await pollInto(c); return take('spawned'); });
assert.equal(take('spawned').req, 'r3');
assert.equal(take('spawned').id, api.id);
assert.deepEqual(spawnAsks.map((r) => r.req), ['r3']);
assert.equal(spawnAsks[0].prompt, 'hello there');

// unpairing from the phone removes it here
await c.send({ t: 'unpair' });
await until('the phone is gone', () => phone.devices().length === 0);

console.log('PASS phone link: pairing, one-time code, state, chat, replay and forgery dropped, read-only agents, spawn rules, unpair');
server.close();
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
