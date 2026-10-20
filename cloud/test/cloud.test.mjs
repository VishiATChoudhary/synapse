// End to end against a real cloud process: sign-up, sign-in, reset, verify, OAuth (fake provider),
// device sign-in, profiles, trusted people, requests, and the mailbox.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let base, proc, mock, mockBase;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'syncloud-'));

// a fake GitHub / Google / X: /<p>/authorize redirects straight back with a code
const profiles = {
  github: { user: { id: 101, login: 'octo', name: 'Octo Cat', avatar_url: 'https://avatars.example/octo.png' }, emails: [{ email: 'octo@example.com', primary: true, verified: true }] },
  google: { user: { sub: 'g-202', email: 'gina@example.com', email_verified: true, name: 'Gina G', picture: 'https://lh3.example/gina.png' } },
  x: { user: { data: { id: 'x-303', name: 'Xavier', username: 'xav', profile_image_url: 'https://pbs.example/xav_normal.png' } } },
};
// a fake Apple: its signing keys, so tests can mint identity tokens the cloud accepts
const apple = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const appleJwk = { ...apple.publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
function appleToken(claims, { key = apple.privateKey, kid = 'test-kid' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${enc({ alg: 'RS256', kid })}.${enc({ iss: 'https://appleid.apple.com', aud: 'dev.synapse.mobile', exp: Math.floor(Date.now() / 1000) + 600, ...claims })}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}
// Apple on the web signs its client secret with an EC key (the .p8)
const appleWebKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const seen = [];
function startMock() {
  return new Promise((resolve) => {
    mock = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      const [, p, step] = u.pathname.split('/');
      if (p === 'apple' && step === 'keys') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ keys: [appleJwk] })); }
      let body = '';
      for await (const c of req) body += c;
      seen.push({ p, step, method: req.method, auth: req.headers.authorization, body });
      if (step === 'authorize') {
        res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=code-${p}&state=${u.searchParams.get('state')}` });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (p === 'apple' && step === 'token') return res.end(JSON.stringify({ access_token: 'at-apple', id_token: appleToken({ aud: 'dev.synapse.web', sub: 'apple-web-1', email: 'webby@privaterelay.appleid.com', email_verified: 'true' }) }));
      if (step === 'token') return res.end(JSON.stringify({ access_token: `at-${p}`, token_type: 'bearer' }));
      if (step === 'user') return res.end(JSON.stringify(profiles[p].user));
      if (step === 'emails') return res.end(JSON.stringify(profiles[p].emails));
      res.end('{}');
    }).listen(0, '127.0.0.1', () => { mockBase = `http://127.0.0.1:${mock.address().port}`; resolve(); });
  });
}

before(async () => {
  await startMock();
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), PUBLIC_URL: base, CLOUD_DATA: data, CLOUD_SECRET: 'test-secret', CLOUD_DEV_MAIL: '1', CLOUD_IP_LIMIT_SCALE: '50', OAUTH_MOCK_BASE: mockBase,
      APPLE_KEYS_URL: `${mockBase}/apple/keys`, APPLE_SERVICES_ID: 'dev.synapse.web', APPLE_TEAM_ID: 'TEAM123', APPLE_KEY_ID: 'KEY123',
      APPLE_PRIVATE_KEY: appleWebKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n'), GITHUB_CLIENT_ID: 'gh', GITHUB_CLIENT_SECRET: 'ghs', GOOGLE_CLIENT_ID: 'go', GOOGLE_CLIENT_SECRET: 'gos', X_CLIENT_ID: 'xi', X_CLIENT_SECRET: 'xs' },
  });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`cloud did not start: ${err}`);
});
after(() => { proc?.kill(); mock?.close(); fs.rmSync(data, { recursive: true, force: true }); });

async function call(route, { body, token, method, cookie, origin } = {}) {
  const r = await fetch(base + route, {
    method: method || (body ? 'POST' : 'GET'), redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
const outbox = async () => (await call('/v1/dev/outbox')).json.mail;
const linkIn = (mail, to, subject) => {
  const m = [...mail].reverse().find((x) => x.to === to && x.subject.includes(subject));
  assert.ok(m, `no "${subject}" mail to ${to}`);
  return new URL(m.text.match(/https?:\/\/\S+/)[0]);
};
const signup = (email, name, password = 'correct horse', extra = {}) => call('/v1/auth/signup', { body: { email, name, password, client: 'app', ...extra } });

test('email sign-up, verification, sign-in, wrong password', async () => {
  const s = await signup('Ada@Example.com', 'Ada Lovelace');
  assert.equal(s.status, 201);
  assert.match(s.json.token, /^syn_/);
  assert.equal(s.json.user.email, 'ada@example.com');
  assert.equal(s.json.user.handle, 'ada');
  assert.equal(s.json.user.emailVerified, false);

  assert.equal((await signup('ada@example.com', 'Again')).status, 409);
  assert.equal((await signup('not-an-email', 'X')).status, 400);
  assert.equal((await signup('short@example.com', 'X', 'short')).status, 400);

  const link = linkIn(await outbox(), 'ada@example.com', 'Confirm');
  assert.equal(link.pathname, '/verify');
  assert.equal((await call('/v1/auth/verify', { body: { token: link.searchParams.get('token') } })).status, 200);
  assert.equal((await call('/v1/auth/verify', { body: { token: link.searchParams.get('token') } })).status, 400, 'links are single use');
  assert.equal((await call('/v1/me', { token: s.json.token })).json.user.emailVerified, true);

  assert.equal((await call('/v1/auth/login', { body: { email: 'ada@example.com', password: 'nope nope' } })).status, 401);
  const ok = await call('/v1/auth/login', { body: { email: 'ADA@example.com', password: 'correct horse', client: 'cli' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.handle, 'ada');
});

test('web sign-in sets an HttpOnly cookie; cookie writes need our origin; logout clears it', async () => {
  await signup('web@example.com', 'Web Person');
  const r = await call('/v1/auth/login', { body: { email: 'web@example.com', password: 'correct horse' } });
  const set = r.headers.get('set-cookie');
  assert.match(set, /syn_session=syn_/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  const cookie = set.split(';')[0];
  assert.equal((await call('/v1/me', { cookie })).json.user.handle, 'web');
  assert.equal((await call('/v1/me', { cookie, method: 'PATCH', body: { name: 'Evil' }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/v1/me', { cookie, method: 'PATCH', body: { name: 'Web P' }, origin: base })).json.user.name, 'Web P');
  // pages see the cookie
  const settings = await call('/settings', { cookie });
  assert.equal(settings.status, 200);
  assert.match(settings.text, /@web/);
  await call('/v1/auth/logout', { cookie, body: {}, origin: base });
  assert.equal((await call('/v1/me', { cookie })).status, 401);
  assert.equal((await call('/settings', {})).status, 302);
});

test('forgot password: same answer for unknown emails, reset works once, old sessions end', async () => {
  const s = await signup('forgetful@example.com', 'Forgetful');
  const before = (await outbox()).length;
  assert.equal((await call('/v1/auth/forgot', { body: { email: 'nobody@example.com' } })).status, 200);
  assert.equal((await outbox()).length, before, 'no mail for unknown addresses');
  assert.equal((await call('/v1/auth/forgot', { body: { email: 'forgetful@example.com' } })).status, 200);
  const link = linkIn(await outbox(), 'forgetful@example.com', 'Reset');
  assert.equal(link.pathname, '/reset');
  const token = link.searchParams.get('token');
  assert.equal((await call('/v1/auth/reset', { body: { token, password: 'short' } })).status, 400);
  assert.equal((await call('/v1/auth/reset', { body: { token, password: 'brand new pass' } })).status, 200);
  assert.equal((await call('/v1/auth/reset', { body: { token, password: 'another one!' } })).status, 400, 'single use');
  assert.equal((await call('/v1/me', { token: s.json.token })).status, 401, 'reset signs out everywhere');
  assert.equal((await call('/v1/auth/login', { body: { email: 'forgetful@example.com', password: 'correct horse' } })).status, 401);
  const ok = await call('/v1/auth/login', { body: { email: 'forgetful@example.com', password: 'brand new pass', client: 'app' } });
  assert.equal(ok.json.user.emailVerified, true, 'the reset link proved the inbox');
});

test('change password needs the current one and signs out other devices', async () => {
  const a = await signup('pw@example.com', 'Pw');
  const other = await call('/v1/auth/login', { body: { email: 'pw@example.com', password: 'correct horse', client: 'app' } });
  assert.equal((await call('/v1/me/password', { token: a.json.token, body: { current: 'wrong', password: 'next password' } })).status, 401);
  assert.equal((await call('/v1/me/password', { token: a.json.token, body: { current: 'correct horse', password: 'next password' } })).status, 200);
  assert.equal((await call('/v1/me', { token: other.json.token })).status, 401);
  assert.equal((await call('/v1/me', { token: a.json.token })).status, 200);
});

test('login is rate limited per email', async () => {
  await signup('brute@example.com', 'Brute');
  let last;
  for (let i = 0; i < 11; i++) last = await call('/v1/auth/login', { body: { email: 'brute@example.com', password: `guess ${i}xx` } });
  assert.equal(last.status, 429);
});

async function oauth(provider, cookie) {
  const start = await call(`/auth/${provider}/start?next=/welcome`, { cookie });
  assert.equal(start.status, 302);
  const auth = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = await call(new URL(auth.headers.get('location')).pathname + new URL(auth.headers.get('location')).search);
  return cb;
}

test('GitHub, Google and X sign-up and sign-in', async () => {
  assert.deepEqual((await call('/v1/auth/providers')).json, { apple: true, github: true, google: true, x: true, email: true, mail: true });

  const gh = await oauth('github');
  assert.equal(gh.status, 302);
  assert.equal(gh.headers.get('location'), '/welcome');
  const ghCookie = gh.headers.get('set-cookie').split(';')[0];
  const ghMe = (await call('/v1/me', { cookie: ghCookie })).json.user;
  assert.equal(ghMe.handle, 'octo');
  assert.equal(ghMe.email, 'octo@example.com');
  assert.equal(ghMe.emailVerified, true);
  assert.deepEqual(ghMe.providers, ['github']);
  assert.equal(ghMe.hasPassword, false);
  assert.equal(ghMe.avatar, 'https://avatars.example/octo.png');
  // signing in again finds the same account
  const again = (await call('/v1/me', { cookie: (await oauth('github')).headers.get('set-cookie').split(';')[0] })).json.user;
  assert.equal(again.id, ghMe.id);
  // a password login for a GitHub-only account says which button to use
  assert.match((await call('/v1/auth/login', { body: { email: 'octo@example.com', password: 'whatever1' } })).json.error, /github/);

  const go = await oauth('google');
  const goMe = (await call('/v1/me', { cookie: go.headers.get('set-cookie').split(';')[0] })).json.user;
  assert.equal(goMe.email, 'gina@example.com');
  assert.deepEqual(goMe.providers, ['google']);
  const pk = seen.find((s) => s.p === 'google' && s.step === 'token');
  assert.match(pk.body, /code_verifier=/, 'Google uses PKCE');

  const x = await oauth('x');
  const xMe = (await call('/v1/me', { cookie: x.headers.get('set-cookie').split(';')[0] })).json.user;
  assert.equal(xMe.handle, 'xav');
  assert.equal(xMe.email, null, 'X gave no email');
  assert.equal(xMe.avatar, 'https://pbs.example/xav_400x400.png');
  const xt = seen.find((s) => s.p === 'x' && s.step === 'token');
  assert.match(xt.auth, /^Basic /, 'X takes client credentials as Basic auth');
  assert.match(xt.body, /code_verifier=/);
});

test('OAuth with a verified email joins the existing email account; linking from settings', async () => {
  const s = await signup('gina2@example.com', 'Gina Two');
  profiles.google.user = { sub: 'g-999', email: 'gina2@example.com', email_verified: true, name: 'Gina Two', picture: 'https://lh3.example/g2.png' };
  const me = (await call('/v1/me', { cookie: (await oauth('google')).headers.get('set-cookie').split(';')[0] })).json.user;
  assert.equal(me.id, s.json.user.id);
  assert.deepEqual(me.providers.sort(), ['google']);
  assert.equal(me.hasPassword, true);

  // link GitHub to a signed-in web session
  const web = await call('/v1/auth/login', { body: { email: 'gina2@example.com', password: 'correct horse' } });
  const cookie = web.headers.get('set-cookie').split(';')[0];
  profiles.github.user = { id: 555, login: 'gina-gh', name: 'Gina', avatar_url: 'https://a/g.png' };
  profiles.github.emails = [{ email: 'other@example.com', primary: true, verified: true }];
  const start = await call('/auth/github/start?link=1', { cookie });
  const auth = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = await call(new URL(auth.headers.get('location')).pathname + new URL(auth.headers.get('location')).search);
  assert.equal(cb.headers.get('location'), '/settings?linked=1');
  assert.deepEqual((await call('/v1/me', { cookie })).json.user.providers.sort(), ['github', 'google']);
});

test('OAuth state is single use and expires', async () => {
  const start = await call('/auth/github/start');
  const auth = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const back = new URL(auth.headers.get('location'));
  assert.equal((await call(back.pathname + back.search)).status, 302);
  const replay = await call(back.pathname + back.search);
  assert.match(replay.headers.get('location'), /^\/login\?error=/);
});

test('device sign-in: the app gets a token once the browser approves', async () => {
  const s = await signup('mac@example.com', 'Mac User');
  const d = (await call('/v1/device/start', { body: { label: 'Synapse on Ada\'s MacBook' } })).json;
  assert.match(d.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
  assert.equal(new URL(d.url).pathname, '/device');
  assert.equal((await call('/v1/device/poll', { body: { deviceCode: d.deviceCode } })).json.status, 'pending');
  // signed-out browser is sent to sign in first
  assert.match((await call(`/device?code=${d.userCode}`)).headers.get('location'), /^\/login\?next=/);
  assert.match((await call(`/device?code=${d.userCode}&via=github`)).headers.get('location'), /^\/auth\/github\/start/);
  const web = await call('/v1/auth/login', { body: { email: 'mac@example.com', password: 'correct horse' } });
  const cookie = web.headers.get('set-cookie').split(';')[0];
  const page = await call(`/device?code=${d.userCode}`, { cookie });
  assert.match(page.text, new RegExp(d.userCode));
  assert.equal((await call('/v1/device/approve', { cookie, origin: base, body: { userCode: d.userCode } })).status, 200);
  const done = await call('/v1/device/poll', { body: { deviceCode: d.deviceCode } });
  assert.equal(done.json.status, 'approved');
  assert.equal(done.json.user.id, s.json.user.id);
  assert.equal((await call('/v1/me', { token: done.json.token })).status, 200);
  assert.equal((await call('/v1/device/poll', { body: { deviceCode: d.deviceCode } })).status, 410, 'token handed out once');
  const sessions = (await call('/v1/me/sessions', { token: done.json.token })).json.sessions;
  assert.ok(sessions.some((x) => x.label === 'Synapse on Ada\'s MacBook' && x.kind === 'app' && x.current));
});

test('profile: handle rules, public profile page, delete account', async () => {
  const a = await signup('prof@example.com', 'Prof');
  const b = await signup('prof2@example.com', 'Prof Two');
  assert.equal((await call('/v1/me', { token: a.json.token, method: 'PATCH', body: { handle: 'A!' } })).status, 400);
  assert.equal((await call('/v1/me', { token: a.json.token, method: 'PATCH', body: { handle: b.json.user.handle } })).status, 409);
  assert.equal((await call('/v1/me', { token: a.json.token, method: 'PATCH', body: { avatar: 'javascript:alert(1)' } })).status, 400);
  const u = (await call('/v1/me', { token: a.json.token, method: 'PATCH', body: { handle: '@Professor', name: 'The Prof', avatar: 'https://img.example/p.png' } })).json.user;
  assert.equal(u.handle, 'professor');
  assert.deepEqual((await call('/v1/users/professor')).json, { handle: 'professor', name: 'The Prof', avatar: 'https://img.example/p.png', createdAt: u.createdAt });
  const page = await call('/u/professor');
  assert.equal(page.status, 200);
  assert.match(page.text, /The Prof/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await call('/u/nobody-here')).status, 404);
  assert.equal((await call('/v1/me', { token: a.json.token, method: 'DELETE', body: { password: 'wrong' } })).status, 401);
  assert.equal((await call('/v1/me', { token: a.json.token, method: 'DELETE', body: { password: 'correct horse' } })).status, 200);
  assert.equal((await call('/v1/users/professor')).status, 404);
});

// two people, two machines: trust, request, accept, deny, and the mailbox between them
async function machine(token) {
  const r = await call('/v1/register', { token, body: {} });
  assert.equal(r.status, 200);
  return r.json;
}

test('trusted people, synapse request, accept delivers the pair; deny and cancel', async () => {
  const sam = await signup('sam@example.com', 'Sam');
  const kim = await signup('kim@example.com', 'Kim');
  const samM = await machine(sam.json.token), kimM = await machine(kim.json.token);

  // not trusted yet: refused
  const agent = { id: 'sess-1', name: 'api-claude', kind: 'claude', project: 'api' };
  assert.equal((await call('/v1/requests', { token: sam.json.token, body: { to: 'kim', machineId: samM.machineId, agent } })).status, 403);

  assert.equal((await call('/v1/trusted', { token: sam.json.token, body: { who: '@nobody' } })).status, 404);
  assert.equal((await call('/v1/trusted', { token: sam.json.token, body: { who: 'sam@example.com' } })).status, 400);
  const p = (await call('/v1/trusted', { token: sam.json.token, body: { who: '@kim' } })).json.person;
  assert.equal(p.handle, 'kim');
  assert.equal(p.trustsYou, false);
  await call('/v1/trusted', { token: kim.json.token, body: { who: 'SAM@example.com' } });
  assert.equal((await call('/v1/trusted', { token: sam.json.token })).json.trusted[0].trustsYou, true);

  // a machine that is not yours cannot send
  assert.equal((await call('/v1/requests', { token: sam.json.token, body: { to: 'kim', machineId: kimM.machineId, agent } })).status, 400);
  const r = await call('/v1/requests', { token: sam.json.token, body: { to: 'Kim', machineId: samM.machineId, agent, target: 'web agent', note: 'need the auth flow' } });
  assert.equal(r.status, 201);
  const req = r.json.request;
  assert.equal(req.status, 'pending');
  assert.equal(req.to.handle, 'kim');
  const dup = await call('/v1/requests', { token: sam.json.token, body: { to: 'kim', machineId: samM.machineId, agent } });
  assert.equal(dup.json.request.id, req.id, 'same agent, same person: one request');

  const inbox = (await call('/v1/requests', { token: kim.json.token })).json;
  assert.equal(inbox.incoming.length, 1);
  assert.equal(inbox.incoming[0].agent.name, 'api-claude');
  assert.equal(inbox.incoming[0].note, 'need the auth flow');
  assert.ok((await outbox()).some((m) => m.to === 'kim@example.com' && m.subject.includes('Sam wants to synapse')) === false, 'Kim has not confirmed the email: no mail');

  // only the recipient decides
  assert.equal((await call(`/v1/requests/${req.id}/accept`, { token: sam.json.token, body: { machineId: samM.machineId, agents: [agent] } })).status, 404);
  assert.equal((await call(`/v1/requests/${req.id}/accept`, { token: kim.json.token, body: { machineId: kimM.machineId, agents: [] } })).status, 400);
  const shared = [{ id: 'kim-sess-9', name: 'web-codex', kind: 'codex', project: 'web' }];
  const acc = await call(`/v1/requests/${req.id}/accept`, { token: kim.json.token, body: { machineId: kimM.machineId, agents: shared } });
  assert.equal(acc.status, 200);
  assert.equal(acc.json.request.status, 'accepted');
  assert.deepEqual(acc.json.peer, { machineId: samM.machineId, name: 'Sam', handle: 'sam' });
  assert.equal((await call(`/v1/requests/${req.id}/deny`, { token: kim.json.token, body: {} })).status, 409);

  // Sam's machine gets the pairing and the answer
  const items = (await call('/v1/poll', { token: samM.token, body: {} })).json.items;
  assert.deepEqual(items.map((i) => i.type), ['paired', 'request']);
  assert.equal(items[0].from, kimM.machineId);
  assert.equal(items[0].pair, acc.json.pair);
  assert.deepEqual(items[1].shared, shared);
  assert.equal((await call('/v1/poll', { token: samM.token, body: {} })).json.items.length, 0, 'collected once');

  // the pair lets the machines exchange context, both ways
  assert.equal((await call('/v1/send', { token: kimM.token, body: { to: samM.machineId, pair: acc.json.pair, items: [{ type: 'context', agent: 'kim-sess-9', messages: [{ role: 'user', text: 'hi' }] }] } })).json.queued, 1);
  const ctx = (await call('/v1/poll', { token: samM.token, body: {} })).json.items;
  assert.equal(ctx[0].type, 'context');
  assert.equal(ctx[0].from, kimM.machineId);
  assert.equal((await call('/v1/send', { token: samM.token, body: { to: 'ffffffffffff', pair: acc.json.pair, items: [{}] } })).status, 403);

  // deny path
  const r2 = (await call('/v1/requests', { token: sam.json.token, body: { to: 'kim', machineId: samM.machineId, agent: { ...agent, id: 'sess-2', name: 'docs-claude' } } })).json.request;
  const den = await call(`/v1/requests/${r2.id}/deny`, { token: kim.json.token, body: {} });
  assert.equal(den.json.request.status, 'denied');
  const after = (await call('/v1/poll', { token: samM.token, body: {} })).json.items;
  assert.deepEqual(after.map((i) => [i.type, i.status]), [['request', 'denied']]);

  // cancel path
  const r3 = (await call('/v1/requests', { token: sam.json.token, body: { to: 'kim', machineId: samM.machineId, agent: { ...agent, id: 'sess-3' } } })).json.request;
  assert.equal((await call(`/v1/requests/${r3.id}/cancel`, { token: sam.json.token, body: {} })).json.request.status, 'cancelled');
  const statuses = (await call('/v1/requests', { token: kim.json.token })).json.incoming.map((x) => x.status).sort();
  assert.deepEqual(statuses, ['accepted', 'cancelled', 'denied']);
});

test('only someone who trusts you can ask you; ending trust revokes what was shared', async () => {
  const ava = await signup('ava@example.com', 'Ava');
  const ben = await signup('ben@example.com', 'Ben');
  const avaM = await machine(ava.json.token), benM = await machine(ben.json.token);
  const agent = { id: 'ava-1', name: 'api-claude', kind: 'claude', project: 'api' };
  const ask = (id = agent.id) => call('/v1/requests', { token: ava.json.token, body: { to: 'ben', machineId: avaM.machineId, agent: { ...agent, id } } });

  // Ava trusting Ben is not enough: Ben has to trust Ava before she can knock
  await call('/v1/trusted', { token: ava.json.token, body: { who: '@ben' } });
  const oneWay = await ask();
  assert.equal(oneWay.status, 403);
  assert.match(oneWay.json.error, /Ben has not added you to their trusted people/);
  const benTrust = (await call('/v1/trusted', { token: ben.json.token, body: { who: '@ava' } })).json.person;
  const req = (await ask()).json.request;
  assert.equal(req.status, 'pending');

  // Ben stops trusting Ava before answering: accepting is refused
  await call(`/v1/trusted/${benTrust.id}`, { token: ben.json.token, method: 'DELETE' });
  assert.equal((await call(`/v1/requests/${req.id}/accept`, { token: ben.json.token, body: { machineId: benM.machineId, agents: [{ id: 'ben-1', name: 'web' }] } })).status, 409);
  await call(`/v1/requests/${req.id}/deny`, { token: ben.json.token, body: {} });

  // trust again, ask, accept: the machines pair
  const again = (await call('/v1/trusted', { token: ben.json.token, body: { who: '@ava' } })).json.person;
  const r2 = (await ask('ava-2')).json.request;
  const acc = await call(`/v1/requests/${r2.id}/accept`, { token: ben.json.token, body: { machineId: benM.machineId, agents: [{ id: 'ben-1', name: 'web' }] } });
  assert.equal(acc.status, 200);
  await call('/v1/poll', { token: avaM.token, body: {} });
  const send = (from, to, items) => call('/v1/send', { token: from.token, body: { to: to.machineId, pair: acc.json.pair, items } });
  assert.equal((await send(benM, avaM, [{ type: 'context', agent: 'ben-1', messages: [] }])).status, 200);
  // a friend cannot forge what only the cloud sends
  await send(benM, avaM, [{ type: 'revoked', id: r2.id, machine: benM.machineId }, { type: 'request', id: r2.id, status: 'denied' }]);
  assert.deepEqual((await call('/v1/poll', { token: avaM.token, body: {} })).json.items.map((i) => i.type), ['context']);

  // Ben removes Ava: the share is revoked, both machines hear it, and the mailbox refuses them
  await call(`/v1/trusted/${again.id}`, { token: ben.json.token, method: 'DELETE' });
  const toAva = (await call('/v1/poll', { token: avaM.token, body: {} })).json.items;
  const toBen = (await call('/v1/poll', { token: benM.token, body: {} })).json.items.filter((i) => i.type !== 'trusted'); // Ben also holds Ava's "added you" note
  assert.deepEqual(toAva.map((i) => [i.type, i.id, i.machine]), [['revoked', r2.id, benM.machineId]]);
  assert.deepEqual(toBen.map((i) => [i.type, i.id, i.machine]), [['revoked', r2.id, avaM.machineId]]);
  assert.equal((await send(benM, avaM, [{ type: 'context', agent: 'ben-1', messages: [] }])).status, 403);
  assert.equal((await send(avaM, benM, [{ type: 'state', agents: [] }])).status, 403);
  const statuses = (await call('/v1/requests', { token: ava.json.token })).json.outgoing.map((x) => [x.id, x.status]);
  assert.deepEqual(statuses.find(([id]) => id === r2.id), [r2.id, 'revoked']);
});

test('trusting an email without an account invites them; signing up and confirming claims it', async () => {
  const lee = await signup('lee@example.com', 'Lee');
  const p = (await call('/v1/trusted', { token: lee.json.token, body: { who: 'newbie@example.com' } })).json.person;
  assert.equal(p.pending, true);
  const invite = linkIn(await outbox(), 'newbie@example.com', 'trusted person');
  assert.equal(invite.pathname, '/signup');
  assert.equal(invite.searchParams.get('email'), 'newbie@example.com');
  const nb = await signup('newbie@example.com', 'Newbie');
  // unconfirmed: still pending (no one can claim an address they do not own)
  assert.equal((await call('/v1/trusted', { token: lee.json.token })).json.trusted[0].pending, true);
  const link = linkIn(await outbox(), 'newbie@example.com', 'Confirm');
  await call('/v1/auth/verify', { body: { token: link.searchParams.get('token') } });
  const t = (await call('/v1/trusted', { token: lee.json.token })).json.trusted[0];
  assert.equal(t.pending, false);
  assert.equal(t.handle, nb.json.user.handle);
  // and a request to someone pending is explained
  await call('/v1/trusted', { token: lee.json.token, body: { who: 'later@example.com' } });
  const m = await machine(lee.json.token);
  const r = await call('/v1/requests', { token: lee.json.token, body: { to: 'later@example.com', machineId: m.machineId, agent: { id: 'a', name: 'a' } } });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /has not joined/);
});

test('a machine registered before sign-in keeps its id when it signs in', async () => {
  const anon = await call('/v1/register', { body: {} });
  const u = await signup('late@example.com', 'Late');
  const bound = await call('/v1/register', { token: u.json.token, body: { machineToken: anon.json.token } });
  assert.equal(bound.json.machineId, anon.json.machineId);
  assert.equal(bound.json.user.handle, 'late');
  // someone else cannot take it over
  const other = await signup('thief@example.com', 'Thief');
  const stolen = await call('/v1/register', { token: other.json.token, body: { machineToken: anon.json.token } });
  assert.notEqual(stolen.json.machineId, anon.json.machineId);
});

test('legacy invite and join still work on the cloud mailbox', async () => {
  const a = (await call('/v1/register', { body: {} })).json, b = (await call('/v1/register', { body: {} })).json;
  const { code } = (await call('/v1/invite', { token: a.token, body: { name: 'A' } })).json;
  const j = (await call('/v1/join', { token: b.token, body: { code, name: 'B' } })).json;
  assert.equal(j.peer.machineId, a.machineId);
  const items = (await call('/v1/poll', { token: a.token, body: {} })).json.items;
  assert.equal(items[0].type, 'paired');
  assert.equal(items[0].name, 'B');
});

test('pages render for signed-out visitors and keep next safe', async () => {
  for (const p of ['/signup', '/login', '/forgot', '/reset?token=x', '/privacy', '/terms', '/verify?token=x']) {
    const r = await call(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  assert.equal((await call('/download')).status, 302);
  assert.match((await call('/download')).headers.get('location'), /Synapse-arm64\.dmg$/);
  assert.equal((await call('/welcome')).headers.get('location'), '/login?next=%2Fwelcome');
  const evil = await call('/auth/github/start?next=//evil.example');
  const auth = await fetch(evil.headers.get('location'), { redirect: 'manual' });
  const cb = await call(new URL(auth.headers.get('location')).pathname + new URL(auth.headers.get('location')).search);
  assert.equal(cb.headers.get('location'), '/welcome', 'no open redirect');
});

test('the database survives a restart', async () => {
  const before = await call('/v1/auth/login', { body: { email: 'kim@example.com', password: 'correct horse', client: 'app' } });
  assert.equal(before.status, 200);
  // a second process on the same data dir sees the same users
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p2 = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CLOUD_DATA: data, CLOUD_SECRET: 'test-secret', CLOUD_DEV_MAIL: '1' } });
  try {
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) { try { ok = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const r = await fetch(`http://127.0.0.1:${port}/v1/me`, { headers: { authorization: `Bearer ${before.json.token}` } });
    assert.equal((await r.json()).user.handle, 'kim');
  } finally { p2.kill(); }
});

test('trust back: the person you added hears about it once, sees you under incoming, and can trust back or ignore', async () => {
  const zed = await signup('zed@example.com', 'Zed <b>Z</b>');
  const yui = await signup('yui@example.com', 'Yui');
  const xan = await signup('xan@example.com', 'Xan');
  for (const who of ['yui', 'xan']) {
    const l = linkIn(await outbox(), `${who}@example.com`, 'Confirm');
    await call('/v1/auth/verify', { body: { token: l.searchParams.get('token') } });
  }
  const yuiM = await machine(yui.json.token), xanM = await machine(xan.json.token);
  const mails = async (to) => (await outbox()).filter((m) => m.to === to && m.subject.includes('added you on Synapse'));

  assert.deepEqual((await call('/v1/trusted/incoming', { token: yui.json.token })).json.incoming, []);
  assert.equal((await call('/v1/trusted/incoming')).status, 401);

  // Zed adds Yui and Xan: each gets one mailbox item and one email
  const zedYui = (await call('/v1/trusted', { token: zed.json.token, body: { who: '@yui' } })).json.person;
  await call('/v1/trusted', { token: zed.json.token, body: { who: '@xan' } });
  const items = (await call('/v1/poll', { token: yuiM.token, body: {} })).json.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'trusted');
  assert.equal(items[0].from.handle, 'zed');
  assert.equal(items[0].from.name, 'Zed <b>Z</b>');
  const m = await mails('yui@example.com');
  assert.equal(m.length, 1);
  assert.ok(m[0].subject.includes('Zed <b>Z</b> added you'));
  assert.ok(m[0].text.includes('/settings#trust'));
  const { emails } = await import('../mail.mjs');
  assert.ok(!emails.trustedBack('Zed <b>Z</b>', 'https://x.example').html.includes('<b>Z</b>'), 'friend name is escaped in the email');

  // adding again (remove and re-add) does not repeat the item or the mail
  await call(`/v1/trusted/${zedYui.id}`, { token: zed.json.token, method: 'DELETE' });
  await call('/v1/trusted', { token: zed.json.token, body: { who: '@yui' } });
  assert.equal((await call('/v1/poll', { token: yuiM.token, body: {} })).json.items.length, 0);
  assert.equal((await mails('yui@example.com')).length, 1);

  // incoming lists the one-way truster; trusting back removes them (and sends nothing back)
  const inc = (await call('/v1/trusted/incoming', { token: yui.json.token })).json.incoming;
  assert.equal(inc.length, 1);
  assert.equal(inc[0].handle, 'zed');
  assert.ok(inc[0].id && inc[0].since);
  await call('/v1/trusted', { token: yui.json.token, body: { who: '@zed' } });
  assert.deepEqual((await call('/v1/trusted/incoming', { token: yui.json.token })).json.incoming, []);
  assert.equal((await call('/v1/poll', { token: (await machine(zed.json.token)).token, body: {} })).json.items.filter((i) => i.type === 'trusted').length, 0, 'trusting back does not notify');

  // dismiss hides them, only for the dismisser
  assert.equal((await call('/v1/trusted/incoming', { token: xan.json.token })).json.incoming.length, 1);
  const id = (await call('/v1/trusted/incoming', { token: xan.json.token })).json.incoming[0].id;
  assert.equal((await call(`/v1/trusted/incoming/${id}/dismiss`, { token: xan.json.token, body: {} })).json.ok, true);
  assert.deepEqual((await call('/v1/trusted/incoming', { token: xan.json.token })).json.incoming, []);

  // peers cannot forge it
  const pair = (await call('/v1/invite', { token: yuiM.token, body: {} })).json.code;
  const joined = await call('/v1/join', { token: xanM.token, body: { code: pair } });
  await call('/v1/poll', { token: yuiM.token, body: {} });
  await call('/v1/send', { token: xanM.token, body: { to: yuiM.machineId, pair: joined.json.pair, items: [{ type: 'trusted', from: { handle: 'evil' } }, { type: 'context', agent: 'a', messages: [] }] } });
  assert.deepEqual((await call('/v1/poll', { token: yuiM.token, body: {} })).json.items.map((i) => i.type), ['context']);

  // the settings page has the section
  const cookie = (await call('/v1/auth/login', { body: { email: 'yui@example.com', password: 'correct horse' } })).headers.get('set-cookie').split(';')[0];
  const page = await call('/settings', { cookie });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('id="trust"') && page.text.includes('People who trust you'));
});

test('an account\'s computer and phone find each other and talk without an invite; nobody else can', async () => {
  const me = (await signup('pho@example.com', 'Pho Owner')).json.token;
  const other = (await signup('stranger@example.com', 'Stranger')).json.token;
  const key = (c) => Buffer.alloc(32, c).toString('base64');
  const reg = (token, kind, name, publicKey) => call('/v1/register', { token, body: { kind, name, publicKey } });

  const mac = (await reg(me, 'computer', 'Mac', key(1))).json;
  const phone = (await reg(me, 'phone', 'iPhone', key(2))).json;
  const theirs = (await reg(other, 'phone', 'Their phone', key(3))).json;
  const plain = (await call('/v1/register', { token: me, body: {} })).json; // multiplayer's identity: no kind
  assert.equal((await reg(me, 'phone', 'Bad', 'nope')).status, 400, 'keys are checked');

  const list = (await call('/v1/machines', { token: me })).json.machines;
  assert.deepEqual(list.map((m) => m.kind).sort(), ['computer', 'phone']);
  assert.equal(list.find((m) => m.kind === 'computer').publicKey, key(1));
  assert.ok(!list.some((m) => m.id === theirs.machineId || m.id === plain.machineId));
  assert.equal((await call('/v1/machines')).status, 401);

  const send = (from, to) => call('/v1/send', { token: from.token, body: { to: to.machineId, items: [{ type: 'box', n: 'n', c: 'c' }] } });
  assert.equal((await send(phone, mac)).status, 200, 'same account, no pair token');
  const got = (await call('/v1/poll', { token: mac.token, body: {} })).json.items;
  assert.equal(got.length, 1);
  assert.equal(got[0].from, phone.machineId);
  assert.equal((await send(theirs, mac)).status, 403, 'another account\'s phone cannot');
  assert.equal((await send(plain, mac)).status, 403, 'a machine that is not a device of the account cannot');

  // the computer removes the phone (or the phone signs out): it is gone and cannot send any more
  assert.equal((await call(`/v1/machines/${phone.machineId}`, { token: other, method: 'DELETE' })).status, 404, 'only the owner removes it');
  assert.equal((await call(`/v1/machines/${phone.machineId}`, { token: me, method: 'DELETE' })).status, 200);
  assert.equal((await send(phone, mac)).status, 403);
  assert.equal((await call('/v1/machines', { token: me })).json.machines.length, 1);
});

test('Sign in with Apple from the phone: Apple-signed tokens only, same person signs in again, verified email joins its account', async () => {
  const apple = (identityToken, name) => call('/v1/auth/apple', { body: { identityToken, name, client: 'phone', label: 'iPhone' } });
  const first = await apple(appleToken({ sub: 'apple-1', email: 'x1@privaterelay.appleid.com', email_verified: true }), 'Appy Person');
  assert.equal(first.status, 200);
  assert.match(first.json.token, /^syn_/);
  assert.equal(first.json.user.name, 'Appy Person');
  assert.deepEqual(first.json.user.providers, ['apple']);
  const again = await apple(appleToken({ sub: 'apple-1' }));
  assert.equal(again.json.user.handle, first.json.user.handle, 'the same Apple ID is the same account');

  await signup('mixed@example.com', 'Mixed');
  const joined = await apple(appleToken({ sub: 'apple-2', email: 'mixed@example.com', email_verified: 'true' }));
  assert.equal(joined.json.user.email, 'mixed@example.com', 'a verified email joins the existing account');

  assert.equal((await apple(appleToken({ sub: 'apple-3', aud: 'com.someone.else' }))).status, 401, 'tokens for other apps are refused');
  assert.equal((await apple(appleToken({ sub: 'apple-3', exp: Math.floor(Date.now() / 1000) - 10 }))).status, 401, 'expired tokens are refused');
  assert.equal((await apple(appleToken({ sub: 'apple-3', iss: 'https://evil.example' }))).status, 401, 'only Apple issues them');
  const forger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal((await apple(appleToken({ sub: 'apple-1' }, { key: forger.privateKey }))).status, 401, 'a token not signed by Apple is refused');
  assert.equal((await apple('not.a.token')).status, 401);
});

test('Sign in with Apple on the web: form_post bounced to a same-site GET, signed client secret, name from the first sign-in', async () => {
  const start = await call('/auth/apple/start?next=/welcome');
  const to = new URL(start.headers.get('location'));
  assert.equal(to.searchParams.get('client_id'), 'dev.synapse.web');
  assert.equal(to.searchParams.get('response_mode'), 'form_post');
  const r = await fetch(`${base}/auth/apple/callback`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://appleid.apple.com' },
    body: new URLSearchParams({ code: 'code-apple', state: to.searchParams.get('state'), user: JSON.stringify({ name: { firstName: 'Webby', lastName: 'Apple' } }) }) });
  assert.equal(r.status, 200);
  assert.ok(!r.headers.get('set-cookie'), 'no cookie on the cross-site post');
  const next = (await r.text()).match(/url=([^"]+)"/)[1].replace(/&amp;/g, '&');
  const cb = await call(next);
  assert.equal(cb.headers.get('location'), '/welcome');
  const me = (await call('/v1/me', { cookie: cb.headers.get('set-cookie').split(';')[0] })).json.user;
  assert.equal(me.name, 'Webby Apple');
  assert.deepEqual(me.providers, ['apple']);

  const tk = seen.find((x) => x.p === 'apple' && x.step === 'token');
  const secret = new URLSearchParams(tk.body).get('client_secret');
  const [h, b, sig] = secret.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY123' });
  const c = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(c.iss, 'TEAM123'); assert.equal(c.sub, 'dev.synapse.web'); assert.equal(c.aud, 'https://appleid.apple.com');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${b}`), { key: appleWebKey.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'signed with the .p8 key');
  assert.match((await call(next)).headers.get('location'), /^\/login\?error=/, 'the state works once');
});

test('the phone app signs in with GitHub through its browser sheet: a one-time code back to the app, no code to compare', async () => {
  const state = 'phone-state-1234567890';
  const start = await call(`/auth/github/start?next=${encodeURIComponent(`/app/done?state=${state}`)}`);
  const auth = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = await call(new URL(auth.headers.get('location')).pathname + new URL(auth.headers.get('location')).search);
  assert.equal(cb.headers.get('location'), `/app/done?state=${state}`);
  const done = await call(`/app/done?state=${state}`, { cookie: cb.headers.get('set-cookie').split(';')[0] });
  const back = new URL(done.headers.get('location'));
  assert.equal(back.protocol, 'synapse:');
  assert.equal(back.searchParams.get('state'), state);
  const ex = await call('/v1/auth/app-code', { body: { code: back.searchParams.get('code'), client: 'phone', label: 'iPhone' } });
  assert.equal(ex.status, 200);
  assert.match(ex.json.token, /^syn_/);
  assert.ok(ex.json.user.providers.includes('github'), 'signed in as the account the GitHub login belongs to');
  assert.equal((await call('/v1/auth/app-code', { body: { code: back.searchParams.get('code') } })).status, 401, 'a code works once');
  assert.match((await call(`/app/done?state=${state}`)).headers.get('location'), /^\/login\?next=/, 'signed out: sign in first');
  assert.equal((await call('/app/done?state=x')).status, 400);
});
