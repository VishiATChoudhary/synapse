// The waitlist: with WAITLIST=1 new accounts can sign in but not share until an admin approves them.
// Accounts made before the waitlist was switched on stay active.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'syncloud-wait-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const ADMIN = 'admin-secret';
let proc;

async function start(env) {
  proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), PUBLIC_URL: base, CLOUD_DATA: data, CLOUD_SECRET: 'test-secret', CLOUD_DEV_MAIL: '1', CLOUD_IP_LIMIT_SCALE: '50', ...env },
  });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`cloud did not start: ${err}`);
}
async function stop() {
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill();
  await exited;
}
after(() => { proc?.kill(); fs.rmSync(data, { recursive: true, force: true }); });

async function call(route, { body, token, method, headers } = {}) {
  const r = await fetch(base + route, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const signup = (email, name) => call('/v1/auth/signup', { body: { email, name, password: 'correct horse', client: 'app' } });
const asAdmin = (route, body, secret = ADMIN) => call(route, { body, headers: { 'x-admin-secret': secret } });
const machine = async (token) => (await call('/v1/register', { body: {}, token })).json;

let old;
before(async () => {
  // an account from before the waitlist
  await start({});
  old = (await signup('old@example.com', 'Old Timer')).json;
  assert.equal(old.user.access, 'active');
  await stop();
  await start({ WAITLIST: '1', ADMIN_SECRET: ADMIN, ADMIN_EMAILS: 'boss@example.com, other@example.com' });
});

test('accounts made before the waitlist stay active', async () => {
  const me = (await call('/v1/me', { token: old.token })).json.user;
  assert.equal(me.access, 'active');
  assert.equal(me.waitlistPosition, null);
  assert.equal((await call('/v1/trusted', { body: { who: 'someone@example.com' }, token: old.token })).status, 200);
});

test('a new account waits: signs in, sees its place, cannot share', async () => {
  const a = (await signup('wait1@example.com', 'Wait One')).json;
  const b = (await signup('wait2@example.com', 'Wait Two')).json;
  assert.equal(a.user.access, 'waiting');
  assert.equal(a.user.waitlistPosition, 1);
  assert.equal(b.user.waitlistPosition, 2);
  assert.equal((await call('/v1/auth/login', { body: { email: 'wait1@example.com', password: 'correct horse' } })).status, 200);

  const t = await call('/v1/trusted', { body: { who: 'old@example.com' }, token: a.token });
  assert.equal(t.status, 403);
  assert.match(t.json.error, /waitlist \(#1\)/);
  const r = await call('/v1/requests', { body: { to: 'old', agent: { id: 'x' } }, token: a.token });
  assert.equal(r.status, 403);

  // a machine can register, but cannot make new pairs with invite codes
  const m = await machine(a.token);
  assert.ok(m.token);
  const inv = await call('/v1/invite', { body: { name: 'w' }, token: m.token });
  assert.equal(inv.status, 403);
  assert.match(inv.json.error, /waitlist/);
  const anon = await machine(null);
  assert.equal((await call('/v1/invite', { body: {}, token: anon.token })).status, 403, 'no account, no invites');
  assert.equal((await call('/v1/poll', { body: {}, token: m.token })).status, 200, 'polling still works');
});

test('only the admin secret sees and approves the waitlist', async () => {
  assert.equal((await call('/v1/admin/waitlist')).status, 404);
  assert.equal((await call('/v1/admin/waitlist', { headers: { 'x-admin-secret': 'wrong' } })).status, 404);
  assert.equal((await asAdmin('/v1/admin/approve', { who: 'wait1@example.com' }, 'nope')).status, 404);

  const list = (await call('/v1/admin/waitlist', { headers: { 'x-admin-secret': ADMIN } })).json.waiting;
  assert.deepEqual(list.map((u) => [u.position, u.email]), [[1, 'wait1@example.com'], [2, 'wait2@example.com']]);

  const ok = await asAdmin('/v1/admin/approve', { who: 'wait1@example.com' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.access, 'active');
  assert.equal((await asAdmin('/v1/admin/approve', { who: '@wait1' })).json.already, true);
  assert.equal((await asAdmin('/v1/admin/approve', { who: 'nobody@example.com' })).status, 404);

  const mail = (await call('/v1/dev/outbox')).json.mail;
  assert.ok(mail.some((m) => m.to === 'wait1@example.com' && /You are in/.test(m.subject)));

  const login = (await call('/v1/auth/login', { body: { email: 'wait1@example.com', password: 'correct horse' } })).json;
  assert.equal((await call('/v1/trusted', { body: { who: 'old@example.com' }, token: login.token })).status, 200);
  const m = await machine(login.token);
  assert.equal((await call('/v1/invite', { body: {}, token: m.token })).status, 200);

  // the one behind moves up
  const two = (await call('/v1/auth/login', { body: { email: 'wait2@example.com', password: 'correct horse' } })).json;
  assert.equal(two.user.waitlistPosition, 1);
});

test('being invited by a trusted person does not skip the waitlist', async () => {
  const s = (await call('/v1/auth/login', { body: { email: 'old@example.com', password: 'correct horse' } })).json;
  assert.equal((await asAdmin('/v1/admin/hold', { who: 'old@example.com' })).status, 200, 'an old account can be put back in line');
  const held = await call('/v1/trusted', { body: { who: 'x@example.com' }, token: s.token });
  assert.equal(held.status, 403);
  assert.match(held.json.error, /waitlist/);
  assert.equal((await asAdmin('/v1/admin/hold', { who: 'old@example.com' }, 'nope')).status, 404);
  assert.equal((await asAdmin('/v1/admin/approve', { who: 'old@example.com' })).status, 200);
  await call('/v1/trusted', { body: { who: 'invited@example.com' }, token: s.token });
  const n = (await signup('invited@example.com', 'Invited')).json;
  assert.equal(n.user.access, 'waiting');
});

const page = (route, cookie) => fetch(base + route, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
async function webLogin(email) {
  const r = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email, password: 'correct horse' }) });
  return r.headers.get('set-cookie').split(';')[0];
}

test('the admin page: only verified admin emails, shows the waitlist, approve and reject from it', async () => {
  await signup('boss@example.com', 'The Boss');
  await signup('queue@example.com', 'In Queue');
  const boss = await webLogin('boss@example.com');
  assert.equal((await page('/admin', boss)).status, 404, 'an unconfirmed admin email is not an admin');
  assert.equal((await call('/v1/admin/overview', { headers: { cookie: boss } })).status, 404);

  const mail = (await call('/v1/dev/outbox')).json.mail;
  const link = new URL([...mail].reverse().find((m) => m.to === 'boss@example.com' && /Confirm/.test(m.subject)).text.match(/https?:\/\/\S+/)[0]);
  await call('/v1/auth/verify', { body: { token: link.searchParams.get('token') } });

  const me = (await call('/v1/me', { headers: { cookie: boss } })).json.user;
  assert.equal(me.access, 'active', 'confirming an admin email lets it in');
  assert.equal(me.admin, true);
  const html = await (await page('/admin', boss)).text();
  assert.doesNotMatch(html.split('Recently approved')[0], /boss@example\.com/, 'admins are not on the waitlist');
  assert.match(html, /Waitlist is <b>on<\/b>/);
  assert.match(html, /queue@example\.com/);
  assert.match(html, /href="\/admin">admin</, 'admins get a nav link');
  assert.equal((await page('/admin')).status, 404, 'signed out');
  const queue = await webLogin('queue@example.com');
  assert.equal((await page('/admin', queue)).status, 404, 'not an admin');
  assert.doesNotMatch(await (await page('/welcome', queue)).text(), /href="\/admin"/);
  assert.equal((await call('/v1/admin/approve', { body: { who: 'queue@example.com' }, headers: { cookie: queue, origin: base } })).status, 404);

  const o = (await call('/v1/admin/overview', { headers: { cookie: boss } })).json;
  assert.equal(o.waitlist, true);
  assert.ok(o.stats.users >= 5 && o.stats.dbBytes > 0 && o.stats.machines >= 1);
  const q = o.waiting.find((u) => u.email === 'queue@example.com');

  // writes from the page need our origin, like every cookie write
  assert.equal((await call('/v1/admin/reject', { body: { who: q.id }, headers: { cookie: boss, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/v1/admin/reject', { body: { who: q.id }, headers: { cookie: boss, origin: base } })).status, 200);
  const qs = (await call('/v1/auth/login', { body: { email: 'queue@example.com', password: 'correct horse' } })).json;
  assert.equal(qs.user.access, 'rejected');
  const t = await call('/v1/trusted', { body: { who: 'old@example.com' }, token: qs.token });
  assert.equal(t.status, 403);
  assert.match(t.json.error, /not let in/);
  assert.match(await (await page('/admin', boss)).text(), /Rejected · 1/);

  assert.equal((await call('/v1/admin/approve', { body: { who: q.id }, headers: { cookie: boss, origin: base } })).status, 200);
  assert.equal((await call('/v1/trusted', { body: { who: 'old@example.com' }, token: qs.token })).status, 200);
  assert.equal((await call('/v1/admin/reject', { body: { who: 'boss@example.com' }, headers: { cookie: boss, origin: base } })).status, 400, 'admins cannot be rejected');
});
