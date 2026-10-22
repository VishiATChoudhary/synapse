#!/usr/bin/env node
// Synapse cloud: accounts (email + password, GitHub, Google, X), trusted people, synapse requests between
// agents of different people, the machine mailbox that carries shared context, and the web pages for all of it.
// Plain Node 22.13+ (node:sqlite), no dependencies. API contract: docs/superpowers/specs/2026-10-17-synapse-cloud.md
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { get, all, run, tx, DB_FILE } from './db.mjs';
import { sendMail, emails, devOutbox, mailConfigured } from './mail.mjs';
import * as oauth from './oauth.mjs';
import * as pages from './pages.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_URL = (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://127.0.0.1:${PORT}`)).replace(/\/+$/, '');
const SECURE = PUBLIC_URL.startsWith('https://');
// once PUBLIC_URL is a custom domain, the railway.app address it replaced is the old one
const OLD_HOST = new URL(PUBLIC_URL).host.endsWith('.up.railway.app') ? null : /\.up\.railway\.app$/;
const SECRET = process.env.CLOUD_SECRET || process.env.RELAY_SECRET;
if (!SECRET) throw new Error('CLOUD_SECRET is not set');
// WAITLIST=1: new accounts wait until an admin approves them before they can share.
// Admins are the verified emails in ADMIN_EMAILS (the /admin page), or anyone sending x-admin-secret: ADMIN_SECRET
const WAITLIST = !!process.env.WAITLIST && process.env.WAITLIST !== '0';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const ADMIN_EMAILS = new Set(String(process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const STARTED = Date.now();
export const DMG_URL = process.env.DMG_URL || 'https://github.com/VishiATChoudhary/synapse/releases/latest/download/Synapse-arm64.dmg';

const HOUR = 3600_000, DAY = 24 * HOUR;
const WEB_SESSION = 30 * DAY, APP_SESSION = 365 * DAY;
const MAX_BODY = 2 << 20, MAX_MAILBOX = 8 << 20, ITEM_TTL = DAY, INVITE_TTL = 7 * DAY;

// ---------------------------------------------------------------- small helpers

const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const normEmail = (s) => String(s || '').trim().toLowerCase();
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;
const HANDLE = /^[a-z0-9_-]{2,24}$/;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

// HMAC tokens for machines, invites and pairs, compatible with relay/relay.mjs
const mac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
export function sign(obj) { const body = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${body}.${mac(body)}`; }
export function verify(token, kind) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (obj.k !== kind || (obj.exp && obj.exp < now())) return null;
    return obj;
  } catch { return null; }
}
const pairOf = (a, b) => sign({ k: 'pair', m: [a, b].sort() });
const CLOUD_ONLY = new Set(['request', 'revoked', 'trusted']);
const DEVICE_KINDS = new Set(['computer', 'phone']);
function sameAccount(a, b) {
  const ma = get('SELECT user_id, kind FROM machines WHERE id = ?', a), mb = get('SELECT user_id, kind FROM machines WHERE id = ?', b);
  return !!(ma?.user_id && ma.kind && mb?.kind && ma.user_id === mb.user_id && a !== b);
}
const pairCovers =(token, a, b) => { const p = verify(token, 'pair'); return !!p && p.m.includes(a) && p.m.includes(b) && a !== b; };

// passwords: scrypt with a per-user salt
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 << 20 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p, maxmem: 64 << 20 });
  return crypto.timingSafeEqual(want, got);
}
const DUMMY_HASH = hashPassword(rid());
function validPassword(pw) {
  pw = String(pw || '');
  if (pw.length < 8) fail(400, 'Use at least 8 characters for the password.');
  if (pw.length > 200) fail(400, 'That password is too long.');
  return pw;
}

// rate limits, in memory (one process): bucket -> key -> timestamps
const buckets = new Map();
function limit(bucket, key, max, windowMs) {
  const b = buckets.get(bucket) || new Map(); buckets.set(bucket, b);
  const t = now(), list = (b.get(key) || []).filter((x) => t - x < windowMs);
  if (list.length >= max) fail(429, 'Too many attempts. Wait a few minutes and try again.');
  list.push(t); b.set(key, list);
}
// per-IP limits scale for shared networks and tests (CLOUD_IP_LIMIT_SCALE); per-account limits do not
const IP_SCALE = Number(process.env.CLOUD_IP_LIMIT_SCALE || 1);
const limitIp = (bucket, req, max, windowMs) => limit(bucket, ipOf(req), Math.ceil(max * IP_SCALE), windowMs);
setInterval(() => { const t = now(); for (const b of buckets.values()) for (const [k, l] of b) if (!l.some((x) => t - x < DAY)) b.delete(k); }, HOUR).unref();

// ---------------------------------------------------------------- users

function uniqueHandle(base) {
  let h = String(base || 'user').toLowerCase().normalize('NFKD').replace(/[^a-z0-9_-]+/g, '').slice(0, 20);
  if (h.length < 2) h = `user${h}`;
  if (!get('SELECT 1 FROM users WHERE handle = ?', h)) return h;
  for (let i = 0; i < 50; i++) { const c = `${h.slice(0, 18)}${crypto.randomInt(10, 9999)}`; if (!get('SELECT 1 FROM users WHERE handle = ?', c)) return c; }
  return `u${rid(6).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

function createUser({ email, name, password, emailVerified = false, avatar = null, handle }) {
  const id = `u_${rid(9)}`, t = now();
  email = email ? normEmail(email) : null;
  name = clean(name, 60) || (email ? email.split('@')[0] : handle) || 'Synapse user';
  run(`INSERT INTO users (id, email, email_verified, handle, name, avatar, password_hash, created_at, updated_at, access) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, email, emailVerified ? 1 : 0, uniqueHandle(handle || email?.split('@')[0] || name), name, avatar, password ? hashPassword(password) : null, t, t, WAITLIST ? 'waiting' : 'active');
  if (emailVerified) claimInvites(id, email);
  return get('SELECT * FROM users WHERE id = ?', id);
}

// someone added this email to their trusted people before it had an account
function claimInvites(userId, email) {
  if (!email) return;
  // an admin's confirmed email never waits
  if (ADMIN_EMAILS.has(email)) run("UPDATE users SET access = 'active' WHERE id = ? AND email = ? AND email_verified = 1", userId, email);
  for (const row of all('SELECT * FROM trusted WHERE email = ? AND trusted_user IS NULL', email)) {
    if (row.user_id === userId || get('SELECT 1 FROM trusted WHERE user_id = ? AND trusted_user = ?', row.user_id, userId)) { run('DELETE FROM trusted WHERE id = ?', row.id); continue; }
    run('UPDATE trusted SET trusted_user = ?, email = NULL WHERE id = ?', userId, row.id);
  }
}

const publicUser = (u) => u && ({ handle: u.handle, name: u.name, avatar: u.avatar || null, createdAt: u.created_at });
function meUser(u) {
  return {
    id: u.id, email: u.email, emailVerified: !!u.email_verified, handle: u.handle, name: u.name, avatar: u.avatar || null,
    providers: all('SELECT provider FROM identities WHERE user_id = ?', u.id).map((r) => r.provider),
    hasPassword: !!u.password_hash, createdAt: u.created_at,
    access: u.access, waitlistPosition: u.access === 'waiting' ? waitlistPosition(u) : null, admin: isAdmin(u),
  };
}
const isAdmin = (u) => !!(u?.email && u.email_verified && ADMIN_EMAILS.has(u.email));
const waitlistPosition = (u) => get("SELECT COUNT(*) AS n FROM users WHERE access = 'waiting' AND created_at <= ?", u.created_at).n;

// ---------------------------------------------------------------- sessions

function createSession(userId, kind, label, ip) {
  const token = `syn_${rid(32)}`, t = now();
  run('INSERT INTO sessions (id, token_hash, user_id, kind, label, ip, created_at, last_used, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    `s_${rid(9)}`, sha(token), userId, kind, clean(label, 80) || null, ip, t, t, t + (kind === 'web' ? WEB_SESSION : APP_SESSION));
  return token;
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}${SECURE ? '; Secure' : ''}`;

// who is calling: a bearer session (app, CLI) or the web cookie
function auth(req) {
  if (req._auth !== undefined) return req._auth;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = bearer.startsWith('syn_') ? bearer : cookies(req).syn_session;
  req._auth = null;
  if (!token) return null;
  const s = get('SELECT * FROM sessions WHERE token_hash = ?', sha(token));
  if (!s || s.expires_at < now()) return null;
  const user = get('SELECT * FROM users WHERE id = ?', s.user_id);
  if (!user) return null;
  if (now() - s.last_used > 10 * 60_000) run('UPDATE sessions SET last_used = ? WHERE id = ?', now(), s.id);
  req._auth = { user, session: s, viaCookie: !bearer.startsWith('syn_') };
  return req._auth;
}
function must(req) {
  const a = auth(req);
  if (!a) fail(401, 'Sign in first.');
  return a;
}
// signed in and let in: what sharing with other people needs
const WAITING = (n) => `You are on the Synapse waitlist (#${n}). You can share with friends once you are let in: we email you.`;
const NOT_LET_IN = 'Your Synapse account is not let in to sharing with friends.';
const shut = (u) => (u.access === 'waiting' ? WAITING(waitlistPosition(u)) : NOT_LET_IN);
function member(req) {
  const a = must(req);
  if (a.user.access !== 'active') fail(403, shut(a.user));
  return a;
}
// admin routes answer 404 to everyone else, so they do not show they exist
function admin(req) {
  if (isAdmin(auth(req)?.user)) return;
  const got = Buffer.from(String(req.headers['x-admin-secret'] || '')), want = Buffer.from(ADMIN_SECRET);
  if (!ADMIN_SECRET || got.length !== want.length || !crypto.timingSafeEqual(got, want)) fail(404, 'not found');
}
const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
// what the admin page shows: the waitlist, and the numbers that say when the cloud needs more
function overview() {
  const t = now();
  const count = (sql, ...a) => get(sql, ...a).n;
  const people = (where, order) => all(`SELECT id, email, handle, name, created_at, approved_at FROM users WHERE ${where} ORDER BY ${order} LIMIT 500`);
  const mailbox = get('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM mailbox');
  return {
    waitlist: WAITLIST,
    waiting: people("access = 'waiting'", 'created_at'),
    rejected: people("access = 'rejected'", 'updated_at DESC'),
    approved: people("access = 'active' AND approved_at IS NOT NULL", 'approved_at DESC').slice(0, 20),
    stats: {
      users: count('SELECT COUNT(*) AS n FROM users'),
      active: count("SELECT COUNT(*) AS n FROM users WHERE access = 'active'"),
      signups24h: count('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', t - DAY),
      signups7d: count('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', t - 7 * DAY),
      machines: count('SELECT COUNT(*) AS n FROM machines'),
      machinesSeen24h: count('SELECT COUNT(*) AS n FROM machines WHERE last_seen > ?', t - DAY),
      machinesSeen5m: count('SELECT COUNT(*) AS n FROM machines WHERE last_seen > ?', t - 5 * 60_000),
      sessions: count('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', t),
      shares: count("SELECT COUNT(*) AS n FROM requests WHERE status = 'accepted'"),
      pendingRequests: count("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'"),
      mailboxItems: mailbox.n, mailboxBytes: mailbox.bytes,
      dbBytes: fileSize(DB_FILE) + fileSize(`${DB_FILE}-wal`),
      rssBytes: process.memoryUsage().rss, uptimeMs: t - STARTED,
      mail: mailConfigured(),
    },
  };
}
const findUser = (who) => {
  who = String(who || '').trim();
  return get('SELECT * FROM users WHERE id = ? OR email = ? OR handle = ?', who, normEmail(who), who.replace(/^@/, '').toLowerCase());
};

// email links (verify, reset): random token, stored hashed, single use
function emailToken(userId, purpose, ttl, email) {
  const token = rid(32);
  run('INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at) VALUES (?, ?, ?, ?, ?)', sha(token), userId, purpose, email, now() + ttl);
  return token;
}
function useEmailToken(token, purpose) {
  const row = get('SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ?', sha(String(token || '')), purpose);
  if (!row || row.used_at || row.expires_at < now()) return null;
  run('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?', now(), row.token_hash);
  return row;
}

async function mail(to, msg) {
  try { await sendMail({ to, ...msg }); } catch (e) { console.error(`mail to ${to} failed: ${e.message}`); }
}
function sendVerification(user) {
  if (!user.email || user.email_verified) return;
  const link = `${PUBLIC_URL}/verify?token=${emailToken(user.id, 'verify', DAY, user.email)}`;
  return mail(user.email, emails.verify(user.name, link));
}

// ---------------------------------------------------------------- trusted people and requests

// ---- the friends board: people who trust each other both ways and have both joined see each other's last
// 7 days. Joining is sending your own numbers; leaving deletes them.
const BOARD_KEYS = ['tokens', 'tokensOut', 'prompts', 'code', 'activeDays', 'streak', 'level', 'xp'];
const boardStats = (b) => Object.fromEntries(BOARD_KEYS.map((k) => [k, Math.max(0, Math.min(1e13, Math.floor(Number(b?.[k]) || 0)))]));
const mutual = (a, b) => trusts(a, b) && trusts(b, a);
function boardOf(userId) {
  const mine = get('SELECT * FROM board WHERE user_id = ?', userId);
  const friends = all(`SELECT u.id, u.handle, u.name, u.avatar, b.stats, b.at FROM trusted t JOIN users u ON u.id = t.trusted_user
                       JOIN board b ON b.user_id = u.id WHERE t.user_id = ?`, userId).filter((r) => mutual(userId, r.id));
  if (!mine) return { joined: false, waiting: friends.length };
  const me = get('SELECT id, handle, name, avatar FROM users WHERE id = ?', userId);
  const row = (u, b, isMe) => ({ handle: u.handle, name: u.name, avatar: u.avatar || null, me: isMe, at: b.at, ...JSON.parse(b.stats) });
  return { joined: true, people: [row(me, mine, true), ...friends.map((r) => row(r, r, false))] };
}

function trustedList(userId) {
  return all(`SELECT t.id, t.email AS invited, u.id AS uid, u.handle, u.name, u.avatar, u.email
              FROM trusted t LEFT JOIN users u ON u.id = t.trusted_user WHERE t.user_id = ? ORDER BY t.created_at`, userId)
    .map((r) => r.uid
      ? { id: r.id, handle: r.handle, name: r.name, avatar: r.avatar || null, email: r.email, pending: false,
          trustsYou: !!get('SELECT 1 FROM trusted WHERE user_id = ? AND trusted_user = ?', r.uid, userId) }
      : { id: r.id, handle: null, name: r.invited, avatar: null, email: r.invited, pending: true, trustsYou: false });
}

// People who trust you and you do not trust back, minus the ones you ignored.
function incomingTrust(userId) {
  return all(`SELECT t.id, t.created_at AS since, u.handle, u.name, u.avatar FROM trusted t JOIN users u ON u.id = t.user_id
              WHERE t.trusted_user = ?
                AND NOT EXISTS (SELECT 1 FROM trusted b WHERE b.user_id = ? AND b.trusted_user = t.user_id)
                AND NOT EXISTS (SELECT 1 FROM trust_dismissed d WHERE d.user_id = ? AND d.other_user = t.user_id)
              ORDER BY t.created_at DESC`, userId, userId, userId)
    .map((r) => ({ id: r.id, handle: r.handle, name: r.name, avatar: r.avatar || null, since: r.since }));
}

// `from` just added `to`. If `to` does not trust them back, tell every machine and the inbox, once per 30 days per pair.
async function tellTrusted(from, to) {
  if (trusts(to.id, from.id)) return;
  if (get('SELECT 1 FROM trust_dismissed WHERE user_id = ? AND other_user = ?', to.id, from.id)) return;
  if (get('SELECT 1 FROM trust_notified WHERE user_id = ? AND other_user = ? AND at > ?', to.id, from.id, now() - 30 * DAY)) return;
  run('INSERT OR REPLACE INTO trust_notified (user_id, other_user, at) VALUES (?, ?, ?)', to.id, from.id, now());
  const who = { id: from.id, handle: from.handle, name: from.name, avatar: from.avatar || null };
  for (const m of all('SELECT id FROM machines WHERE user_id = ?', to.id)) deliver(m.id, { type: 'trusted', from: who });
  if (to.email && to.email_verified) await mail(to.email, emails.trustedBack(from.name, `${PUBLIC_URL}/settings#trust`));
}

const trusts = (userId, otherId) => !!get('SELECT 1 FROM trusted WHERE user_id = ? AND trusted_user = ?', userId, otherId);

// Trust ended between two people: every share made through an accepted request between them stops.
// Both machines hear it, drop the pairing, and the mailbox refuses anything they still send each other.
function revokeBetween(a, b) {
  const rows = all(`SELECT * FROM requests WHERE status = 'accepted' AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))`, a, b, b, a);
  for (const r of rows) {
    run("UPDATE requests SET status = 'revoked', decided_at = ? WHERE id = ?", now(), r.id);
    deliver(r.from_machine, { type: 'revoked', id: r.id, machine: r.to_machine });
    if (r.to_machine) deliver(r.to_machine, { type: 'revoked', id: r.id, machine: r.from_machine });
  }
}

// Machines paired through a request may only talk while their owners trust each other.
function pairStillTrusted(a, b) {
  const viaRequest = get(`SELECT 1 FROM requests WHERE status IN ('accepted', 'revoked')
    AND ((from_machine = ? AND to_machine = ?) OR (from_machine = ? AND to_machine = ?))`, a, b, b, a);
  if (!viaRequest) return true; // paired with an invite code: not a request share
  const ua = get('SELECT user_id FROM machines WHERE id = ?', a)?.user_id, ub = get('SELECT user_id FROM machines WHERE id = ?', b)?.user_id;
  return !!(ua && ub && trusts(ua, ub) && trusts(ub, ua));
}

function findUserByWho(who) {
  const q = String(who || '').trim();
  if (EMAIL.test(q)) return { email: normEmail(q), user: get('SELECT * FROM users WHERE email = ?', normEmail(q)) };
  const h = q.replace(/^@/, '').toLowerCase();
  return { handle: h, user: get('SELECT * FROM users WHERE handle = ?', h) };
}

const requestJSON = (r) => {
  const from = get('SELECT * FROM users WHERE id = ?', r.from_user), to = get('SELECT * FROM users WHERE id = ?', r.to_user);
  return {
    id: r.id, kind: r.kind || 'ask', mode: r.mode || null, status: r.status, from: publicUser(from), to: publicUser(to), agent: JSON.parse(r.agent), target: r.target, note: r.note,
    createdAt: r.created_at, decidedAt: r.decided_at, fromMachine: r.from_machine, toMachine: r.to_machine, shared: r.shared ? JSON.parse(r.shared) : [],
  };
};
const cleanAgent = (a) => ({ id: clean(a?.id, 120), name: clean(a?.name, 48) || 'agent', kind: clean(a?.kind, 20) || 'agent', project: clean(a?.project, 60) || null });

function ownMachine(userId, machineId) {
  const m = get('SELECT * FROM machines WHERE id = ?', String(machineId || ''));
  if (!m || m.user_id !== userId) fail(400, 'This machine is not registered to your account. Sign in again in the Synapse app.');
  return m;
}

// ---------------------------------------------------------------- mailbox (persisted)

function deliver(to, item) {
  const text = JSON.stringify(item);
  run('INSERT INTO mailbox (machine_id, t, size, item) VALUES (?, ?, ?, ?)', to, now(), text.length, text);
  let total = get('SELECT COALESCE(SUM(size), 0) AS n FROM mailbox WHERE machine_id = ?', to).n;
  while (total > MAX_MAILBOX) {
    const oldest = get('SELECT seq, size FROM mailbox WHERE machine_id = ? ORDER BY seq LIMIT 1', to);
    if (!oldest) break;
    run('DELETE FROM mailbox WHERE seq = ?', oldest.seq); total -= oldest.size;
  }
}
function collect(id) {
  return tx(() => {
    const rows = all('SELECT seq, item FROM mailbox WHERE machine_id = ? AND t > ? ORDER BY seq', id, now() - ITEM_TTL);
    run('DELETE FROM mailbox WHERE machine_id = ?', id);
    return rows.map((r) => JSON.parse(r.item));
  });
}
setInterval(() => {
  run('DELETE FROM mailbox WHERE t < ?', now() - ITEM_TTL);
  run('DELETE FROM devices WHERE expires_at < ?', now() - HOUR);
  run('DELETE FROM oauth_states WHERE expires_at < ?', now());
  run('DELETE FROM email_tokens WHERE expires_at < ?', now() - DAY);
  run('DELETE FROM sessions WHERE expires_at < ?', now());
}, 10 * 60_000).unref();

// ---------------------------------------------------------------- http plumbing

const SECURITY = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY',
  ...(SECURE ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
};
const CSP = "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
function json(res, code, v, headers = {}) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY, ...headers }); res.end(JSON.stringify(v)); }
function html(res, code, body, headers = {}) { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP, ...SECURITY, ...headers }); res.end(body); }
function redirect(res, to, headers = {}) { res.writeHead(302, { location: to, 'cache-control': 'no-store', ...SECURITY, ...headers }); res.end(); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '', n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new HttpError(413, 'request too large')); req.destroy(); } else d += c; });
    req.on('end', () => {
      if (/application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) return resolve(Object.fromEntries(new URLSearchParams(d)));
      try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
// a cookie-authenticated write must come from our own pages
function sameOrigin(req) {
  const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
  return !origin || origin === PUBLIC_URL || origin === new URL(PUBLIC_URL).origin;
}
const safeNext = (n, fallback = '/welcome') => (typeof n === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(n) ? n : fallback);

// ---------------------------------------------------------------- API routes

function signedIn(res, req, user, b, status = 200) {
  const client = ['app', 'cli', 'phone'].includes(b.client) ? b.client : 'web';
  const token = createSession(user.id, client, b.label || (client === 'web' ? clean(req.headers['user-agent'], 80) : null), ipOf(req));
  const headers = client === 'web' ? { 'set-cookie': cookie('syn_session', token, WEB_SESSION) } : {};
  return json(res, status, { token, user: meUser(user) }, headers);
}

const routes = {
  'POST /v1/auth/signup': async (req, res, b) => {
    limitIp('signup', req, 10, HOUR);
    const email = normEmail(b.email);
    if (!EMAIL.test(email)) fail(400, 'That email address does not look right.');
    const password = validPassword(b.password);
    if (get('SELECT 1 FROM users WHERE email = ?', email)) fail(409, 'An account with this email already exists. Sign in instead, or reset your password.');
    const user = createUser({ email, name: b.name, password });
    sendVerification(user);
    return signedIn(res, req, user, b, 201);
  },
  'POST /v1/auth/login': async (req, res, b) => {
    const email = normEmail(b.email);
    limitIp('login-ip', req, 30, 15 * 60_000);
    limit('login-email', email, 10, 15 * 60_000);
    const user = get('SELECT * FROM users WHERE email = ?', email);
    const ok = checkPassword(String(b.password || ''), user?.password_hash || DUMMY_HASH);
    if (!user || !ok) {
      if (user && !user.password_hash) fail(401, `This account signs in with ${meUser(user).providers.join(' or ') || 'a provider'}. Use that button, or reset the password to set one.`);
      fail(401, 'Wrong email or password.');
    }
    return signedIn(res, req, user, b);
  },
  // Sign in with Apple from the phone app: Apple's identity token in, a session out
  'POST /v1/auth/apple': async (req, res, b) => {
    limitIp('apple', req, 30, 15 * 60_000);
    let p;
    try { p = await oauth.verifyApple(b.identityToken); }
    catch (e) { fail(401, `Sign in with Apple did not work: ${e.message}.`); }
    const user = userForIdentity('apple', p, clean(b.name, 60));
    return signedIn(res, req, user, b);
  },
  // the phone app trades the one-time code from /app/done for a session (or, if the return link got lost,
  // the state it opened the sign-in with)
  'POST /v1/auth/app-code': async (req, res, b) => {
    limitIp('app-code', req, 30, 15 * 60_000);
    const row = b.state ? (/^[\w-]{16,64}$/.test(String(b.state)) ? useEmailToken(`state:${b.state}`, 'app-state') : null) : useEmailToken(b.code, 'app');
    console.log(`app-code ${b.state ? 'by state' : 'by code'} ${row ? 'ok' : 'refused'}`);
    if (!row) fail(401, 'That sign-in expired. Try again.');
    return signedIn(res, req, get('SELECT * FROM users WHERE id = ?', row.user_id), b);
  },
  'POST /v1/auth/logout': async (req, res) => {
    const a = auth(req);
    if (a) run('DELETE FROM sessions WHERE id = ?', a.session.id);
    return json(res, 200, { ok: true }, { 'set-cookie': cookie('syn_session', '', 0) });
  },
  'POST /v1/auth/forgot': async (req, res, b) => {
    const email = normEmail(b.email);
    limitIp('forgot-ip', req, 10, HOUR);
    if (EMAIL.test(email)) {
      limit('forgot-email', email, 3, HOUR);
      const user = get('SELECT * FROM users WHERE email = ?', email);
      if (user) await mail(email, emails.reset(user.name, `${PUBLIC_URL}/reset?token=${emailToken(user.id, 'reset', HOUR, email)}`));
    }
    return json(res, 200, { ok: true }); // same answer either way: no account probing
  },
  'POST /v1/auth/reset': async (req, res, b) => {
    limitIp('reset', req, 20, HOUR);
    const password = validPassword(b.password);
    const row = useEmailToken(b.token, 'reset');
    if (!row) fail(400, 'This reset link is not valid any more. Ask for a new one.');
    tx(() => {
      run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(password), now(), row.user_id);
      // the link proved the inbox, so the email counts as verified
      run('UPDATE users SET email_verified = 1 WHERE id = ? AND email = ?', row.user_id, row.email);
      run('DELETE FROM sessions WHERE user_id = ?', row.user_id);
    });
    claimInvites(row.user_id, row.email);
    return json(res, 200, { ok: true });
  },
  'POST /v1/auth/verify': async (req, res, b) => {
    const row = useEmailToken(b.token, 'verify');
    if (!row) fail(400, 'This confirmation link is not valid any more. Sign in and ask for a new one.');
    run('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ? AND email = ?', now(), row.user_id, row.email);
    claimInvites(row.user_id, row.email);
    return json(res, 200, { ok: true });
  },
  'POST /v1/auth/resend-verification': async (req, res) => {
    const { user } = must(req);
    limit('resend', user.id, 5, HOUR);
    if (user.email_verified) return json(res, 200, { ok: true, already: true });
    await sendVerification(user);
    return json(res, 200, { ok: true });
  },
  'GET /v1/auth/providers': async (req, res) => json(res, 200, { ...oauth.providerStatus(), email: true, mail: mailConfigured() }),

  // ---- device sign-in for the app and CLI
  'POST /v1/device/start': async (req, res, b) => {
    limitIp('device', req, 30, HOUR);
    const deviceCode = rid(32);
    const alphabet = 'BCDFGHJKLMNPQRSTVWXZ';
    const raw = Array.from(crypto.randomBytes(8), (x) => alphabet[x % alphabet.length]).join('');
    const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    run('INSERT INTO devices (device_hash, user_code, label, expires_at) VALUES (?, ?, ?, ?)', sha(deviceCode), userCode, clean(b.label, 80) || 'Synapse', now() + 10 * 60_000);
    return json(res, 200, { deviceCode, userCode, url: `${PUBLIC_URL}/device?code=${userCode}`, interval: 2, expiresIn: 600 });
  },
  'POST /v1/device/poll': async (req, res, b) => {
    const d = get('SELECT * FROM devices WHERE device_hash = ?', sha(String(b.deviceCode || '')));
    if (!d || d.expires_at < now()) fail(410, 'This sign-in expired. Start again.');
    if (d.status === 'denied') { run('DELETE FROM devices WHERE device_hash = ?', d.device_hash); fail(410, 'Sign-in was cancelled in the browser.'); }
    if (d.status !== 'approved') return json(res, 200, { status: 'pending' });
    run('DELETE FROM devices WHERE device_hash = ?', d.device_hash); // the token is handed out once
    return json(res, 200, { status: 'approved', token: d.token, user: meUser(get('SELECT * FROM users WHERE id = ?', d.user_id)) });
  },
  'POST /v1/device/approve': async (req, res, b) => {
    const { user } = must(req);
    const d = get('SELECT * FROM devices WHERE user_code = ?', String(b.userCode || '').toUpperCase().trim());
    if (!d || d.expires_at < now() || d.status !== 'pending') fail(410, 'This code expired. Start the sign-in again in the app.');
    if (b.deny) { run("UPDATE devices SET status = 'denied' WHERE device_hash = ?", d.device_hash); return json(res, 200, { ok: true }); }
    const token = createSession(user.id, 'app', d.label, ipOf(req));
    run("UPDATE devices SET status = 'approved', user_id = ?, token = ? WHERE device_hash = ?", user.id, token, d.device_hash);
    return json(res, 200, { ok: true, label: d.label });
  },

  // ---- me
  'GET /v1/me': async (req, res) => json(res, 200, { user: meUser(must(req).user) }),
  'PATCH /v1/me': async (req, res, b) => {
    const { user } = must(req);
    const name = b.name !== undefined ? clean(b.name, 60) : user.name;
    if (!name) fail(400, 'Your name cannot be empty.');
    let handle = user.handle;
    if (b.handle !== undefined) {
      handle = String(b.handle).trim().replace(/^@/, '').toLowerCase();
      if (!HANDLE.test(handle)) fail(400, 'A handle is 2 to 24 characters: a-z, 0-9, _ and -.');
      if (handle !== user.handle && get('SELECT 1 FROM users WHERE handle = ?', handle)) fail(409, `@${handle} is taken.`);
    }
    let avatar = user.avatar;
    if (b.avatar !== undefined) {
      avatar = String(b.avatar || '').trim() || null;
      if (avatar && (!/^https:\/\/\S+$/.test(avatar) || avatar.length > 500)) fail(400, 'The avatar has to be an https:// image link.');
    }
    run('UPDATE users SET name = ?, handle = ?, avatar = ?, updated_at = ? WHERE id = ?', name, handle, avatar, now(), user.id);
    return json(res, 200, { user: meUser(get('SELECT * FROM users WHERE id = ?', user.id)) });
  },
  'POST /v1/me/password': async (req, res, b) => {
    const { user, session } = must(req);
    limit('password', user.id, 10, HOUR);
    const password = validPassword(b.password);
    if (user.password_hash && !checkPassword(String(b.current || ''), user.password_hash)) fail(401, 'Your current password is not right.');
    tx(() => {
      run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(password), now(), user.id);
      run('DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, session.id); // sign out everywhere else
    });
    return json(res, 200, { ok: true });
  },
  'DELETE /v1/me': async (req, res, b) => {
    const { user } = must(req);
    if (user.password_hash && !checkPassword(String(b.password || ''), user.password_hash)) fail(401, 'Type your password to delete the account.');
    const others = all("SELECT DISTINCT CASE WHEN from_user = ? THEN to_user ELSE from_user END AS id FROM requests WHERE status = 'accepted' AND (from_user = ? OR to_user = ?)", user.id, user.id, user.id);
    for (const o of others) revokeBetween(user.id, o.id);
    run('DELETE FROM users WHERE id = ?', user.id);
    return json(res, 200, { ok: true }, { 'set-cookie': cookie('syn_session', '', 0) });
  },
  'GET /v1/me/sessions': async (req, res) => {
    const { user, session } = must(req);
    const sessions = all('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_used DESC', user.id, now())
      .map((s) => ({ id: s.id, kind: s.kind, label: s.label, createdAt: s.created_at, lastUsed: s.last_used, current: s.id === session.id }));
    return json(res, 200, { sessions });
  },
  'POST /v1/me/unlink': async (req, res, b) => {
    const { user } = must(req);
    const ids = all('SELECT provider FROM identities WHERE user_id = ?', user.id);
    if (!user.password_hash && ids.length <= 1) fail(400, 'Set a password first, or you could not sign in any more.');
    run('DELETE FROM identities WHERE user_id = ? AND provider = ?', user.id, String(b.provider));
    return json(res, 200, { user: meUser(user) });
  },

  // ---- trusted people
  'GET /v1/board': async (req, res) => json(res, 200, boardOf(must(req).user.id)),
  'PUT /v1/board': async (req, res, b) => {
    const { user } = must(req);
    run('INSERT INTO board (user_id, stats, at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET stats = excluded.stats, at = excluded.at', user.id, JSON.stringify(boardStats(b)), now());
    return json(res, 200, boardOf(user.id));
  },
  'DELETE /v1/board': async (req, res) => { const { user } = must(req); run('DELETE FROM board WHERE user_id = ?', user.id); return json(res, 200, boardOf(user.id)); },
  'GET /v1/trusted': async (req, res) => json(res, 200, { trusted: trustedList(must(req).user.id) }),
  'POST /v1/trusted': async (req, res, b) => {
    const { user } = member(req);
    limit('trust', user.id, 60, HOUR);
    const who = String(b.who || '').trim();
    if (!who) fail(400, 'Type an email or @handle.');
    const hit = findUserByWho(who);
    if (hit.user?.id === user.id) fail(400, 'That is you.');
    if (hit.user) {
      if (!get('SELECT 1 FROM trusted WHERE user_id = ? AND trusted_user = ?', user.id, hit.user.id)) {
        run('INSERT INTO trusted (id, user_id, trusted_user, created_at) VALUES (?, ?, ?, ?)', `t_${rid(9)}`, user.id, hit.user.id, now());
        await tellTrusted(user, hit.user);
      }
    } else if (hit.email) {
      if (!get('SELECT 1 FROM trusted WHERE user_id = ? AND email = ? AND trusted_user IS NULL', user.id, hit.email)) {
        run('INSERT INTO trusted (id, user_id, email, created_at) VALUES (?, ?, ?, ?)', `t_${rid(9)}`, user.id, hit.email, now());
        limit('invite-mail', user.id, 20, DAY);
        await mail(hit.email, emails.trustedInvite(user.name, `${PUBLIC_URL}/signup?email=${encodeURIComponent(hit.email)}&from=${encodeURIComponent(user.handle)}`));
      }
    } else fail(404, `Nobody on Synapse is called @${hit.handle}. Add them by email instead: they get an invite.`);
    const person = trustedList(user.id).find((p) => (hit.user ? p.handle === hit.user.handle : p.email === hit.email));
    return json(res, 200, { person, emailed: !hit.user && mailConfigured() });
  },
  'GET /v1/trusted/incoming': async (req, res) => json(res, 200, { incoming: incomingTrust(must(req).user.id) }),
  'POST /v1/trusted/incoming/:id/dismiss': async (req, res, b, params) => {
    const { user } = must(req);
    const row = get('SELECT user_id FROM trusted WHERE id = ? AND trusted_user = ?', params.id, user.id);
    if (!row) fail(404, 'No such person.');
    run('INSERT OR REPLACE INTO trust_dismissed (user_id, other_user, at) VALUES (?, ?, ?)', user.id, row.user_id, now());
    return json(res, 200, { ok: true });
  },
  'DELETE /v1/trusted/:id': async (req, res, b, params) => {
    const { user } = must(req);
    const row = get('SELECT * FROM trusted WHERE id = ? AND user_id = ?', params.id, user.id);
    run('DELETE FROM trusted WHERE id = ? AND user_id = ?', params.id, user.id);
    if (row?.trusted_user) revokeBetween(user.id, row.trusted_user);
    return json(res, 200, { ok: true });
  },
  'GET /v1/users/:handle': async (req, res, b, params) => {
    const u = get('SELECT * FROM users WHERE handle = ?', params.handle.toLowerCase());
    if (!u) fail(404, 'No such person.');
    return json(res, 200, publicUser(u));
  },

  // ---- synapse requests
  'POST /v1/requests': async (req, res, b) => {
    const { user } = member(req);
    limit('request', user.id, 60, HOUR);
    const mine = ownMachine(user.id, b.machineId);
    const agent = cleanAgent(b.agent);
    if (!agent.id) fail(400, 'Which agent is asking? Send agent.id.');
    const q = String(b.to || '').trim().replace(/^@/, '').toLowerCase();
    if (!q) fail(400, 'Who should get the request?');
    const list = trustedList(user.id);
    const person = list.find((p) => p.handle === q || p.email?.toLowerCase() === q)
      || list.find((p) => p.name.toLowerCase() === q) || list.find((p) => p.name.toLowerCase().startsWith(q) || p.handle?.startsWith(q));
    if (!person) fail(403, `"${b.to}" is not in your trusted people. Add them under Settings, then ask again.`);
    if (person.pending) fail(409, `${person.email} has not joined Synapse yet. They got an invite by email.`);
    const to = get('SELECT * FROM users WHERE handle = ?', person.handle);
    // only people who trust you can ask you: trust is what lets someone knock, never access by itself
    if (!trusts(to.id, user.id)) fail(403, `${to.name} has not added you to their trusted people yet. Ask them to, then try again.`);
    // an offer: I share one of my agents with them (they pick which of theirs receives it); an ask: theirs for mine
    const kind = b.kind === 'offer' ? 'offer' : 'ask', mode = kind === 'offer' ? (b.mode === 'talk' ? 'talk' : 'sync') : null;
    const dup = get("SELECT * FROM requests WHERE from_user = ? AND to_user = ? AND status = 'pending' AND kind = ? AND json_extract(agent, '$.id') = ?", user.id, to.id, kind, agent.id);
    if (dup) { if (mode && dup.mode !== mode) run('UPDATE requests SET mode = ? WHERE id = ?', mode, dup.id); return json(res, 200, { request: requestJSON(get('SELECT * FROM requests WHERE id = ?', dup.id)) }); }
    const id = `r_${rid(9)}`;
    run('INSERT INTO requests (id, from_user, to_user, from_machine, agent, target, note, created_at, kind, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, user.id, to.id, mine.id, JSON.stringify(agent), clean(b.target, 120) || null, clean(b.note, 500) || null, now(), kind, mode);
    if (to.email && to.email_verified) mail(to.email, (kind === 'offer' ? emails.offer : emails.request)(user.name, agent.name, `${PUBLIC_URL}/settings#requests-card`));
    return json(res, 201, { request: requestJSON(get('SELECT * FROM requests WHERE id = ?', id)) });
  },
  'GET /v1/requests': async (req, res) => {
    const { user } = must(req);
    const since = now() - 30 * DAY;
    const pick = (col) => all(`SELECT * FROM requests WHERE ${col} = ? AND (status = 'pending' OR created_at > ?) ORDER BY created_at DESC LIMIT 100`, user.id, since).map(requestJSON);
    return json(res, 200, { incoming: pick('to_user'), outgoing: pick('from_user') });
  },
  'POST /v1/requests/:id/accept': async (req, res, b, params) => {
    const { user } = member(req);
    const r = get('SELECT * FROM requests WHERE id = ? AND to_user = ?', params.id, user.id);
    if (!r) fail(404, 'No such request.');
    if (r.status !== 'pending') fail(409, `This request was already ${r.status}.`);
    const mine = ownMachine(user.id, b.machineId);
    if (mine.id === r.from_machine) fail(400, 'Both agents are on this machine: link them on the canvas instead.');
    if (!trusts(user.id, r.from_user) || !trusts(r.from_user, user.id)) fail(409, 'You no longer trust each other, so this request cannot be accepted. Deny it instead.');
    // an offer is accepted with the one agent of mine that receives it; an ask with the agents of mine I share
    const offer = r.kind === 'offer', receiver = offer ? cleanAgent(b.receiver) : null;
    if (offer && !receiver.id) fail(400, 'Pick which of your agents gets it.');
    const shared = offer ? [receiver] : (Array.isArray(b.agents) ? b.agents : []).slice(0, 20).map(cleanAgent).filter((a) => a.id);
    if (!shared.length) fail(400, 'Pick at least one of your agents to share.');
    const pair = pairOf(mine.id, r.from_machine);
    run("UPDATE requests SET status = 'accepted', decided_at = ?, to_machine = ?, shared = ? WHERE id = ?", now(), mine.id, JSON.stringify(shared), r.id);
    const from = get('SELECT * FROM users WHERE id = ?', r.from_user);
    deliver(r.from_machine, { type: 'paired', via: 'request', from: mine.id, name: user.name, handle: user.handle, pair });
    deliver(r.from_machine, { type: 'request', id: r.id, status: 'accepted', from: mine.id, pair, shared, agent: JSON.parse(r.agent), ...(offer ? { kind: 'offer', mode: r.mode || 'sync', receiver } : {}) });
    return json(res, 200, { request: requestJSON(get('SELECT * FROM requests WHERE id = ?', r.id)), pair, peer: { machineId: r.from_machine, name: from.name, handle: from.handle } });
  },
  'POST /v1/requests/:id/deny': async (req, res, b, params) => {
    const { user } = must(req);
    const r = get('SELECT * FROM requests WHERE id = ? AND to_user = ?', params.id, user.id);
    if (!r) fail(404, 'No such request.');
    if (r.status !== 'pending') fail(409, `This request was already ${r.status}.`);
    run("UPDATE requests SET status = 'denied', decided_at = ? WHERE id = ?", now(), r.id);
    deliver(r.from_machine, { type: 'request', id: r.id, status: 'denied', agent: JSON.parse(r.agent) });
    return json(res, 200, { request: requestJSON(get('SELECT * FROM requests WHERE id = ?', r.id)) });
  },
  'POST /v1/requests/:id/cancel': async (req, res, b, params) => {
    const { user } = must(req);
    const r = get('SELECT * FROM requests WHERE id = ? AND from_user = ?', params.id, user.id);
    if (!r) fail(404, 'No such request.');
    if (r.status === 'pending') run("UPDATE requests SET status = 'cancelled', decided_at = ? WHERE id = ?", now(), r.id);
    return json(res, 200, { request: requestJSON(get('SELECT * FROM requests WHERE id = ?', r.id)) });
  },

  // ---- waitlist admin (x-admin-secret: ADMIN_SECRET)
  'GET /v1/admin/waitlist': async (req, res) => {
    admin(req);
    const waiting = overview().waiting.map((u, i) => ({ position: i + 1, id: u.id, email: u.email, handle: u.handle, name: u.name, createdAt: u.created_at }));
    return json(res, 200, { waiting });
  },
  'GET /v1/admin/overview': async (req, res) => { admin(req); return json(res, 200, overview()); },
  'POST /v1/admin/approve': async (req, res, b) => {
    admin(req);
    const u = findUser(b.who);
    if (!u) fail(404, `Nobody on Synapse matches "${b.who}".`);
    if (u.access === 'active') return json(res, 200, { ok: true, already: true });
    run("UPDATE users SET access = 'active', approved_at = ?, updated_at = ? WHERE id = ?", now(), now(), u.id);
    if (u.email) await mail(u.email, emails.approved(u.name, `${PUBLIC_URL}/welcome`));
    return json(res, 200, { ok: true, user: meUser(get('SELECT * FROM users WHERE id = ?', u.id)) });
  },
  // back in line, e.g. an account made before the waitlist. No email
  'POST /v1/admin/hold': async (req, res, b) => {
    admin(req);
    const u = findUser(b.who);
    if (!u) fail(404, `Nobody on Synapse matches "${b.who}".`);
    if (isAdmin(u)) fail(400, 'That is an admin.');
    run("UPDATE users SET access = 'waiting', approved_at = NULL, updated_at = ? WHERE id = ?", now(), u.id);
    return json(res, 200, { ok: true, user: meUser(get('SELECT * FROM users WHERE id = ?', u.id)) });
  },
  // no email: they keep their account and the app, just not sharing. Approve undoes it
  'POST /v1/admin/reject': async (req, res, b) => {
    admin(req);
    const u = findUser(b.who);
    if (!u) fail(404, `Nobody on Synapse matches "${b.who}".`);
    if (isAdmin(u)) fail(400, 'That is an admin.');
    run("UPDATE users SET access = 'rejected', approved_at = NULL, updated_at = ? WHERE id = ?", now(), u.id);
    return json(res, 200, { ok: true, user: meUser(get('SELECT * FROM users WHERE id = ?', u.id)) });
  },

  // ---- machine mailbox (same protocol as relay/relay.mjs)
  'POST /v1/register': async (req, res, b) => {
    limitIp('register', req, 30, HOUR);
    const a = auth(req);
    // a machine that registered before signing in keeps its id and gets bound to the account
    const prev = verify(b.machineToken, 'machine');
    let machineId = prev?.m;
    if (machineId) {
      const row = get('SELECT * FROM machines WHERE id = ?', machineId);
      if (row?.user_id && a && row.user_id !== a.user.id) machineId = null; // someone else's machine: start fresh
    }
    machineId ||= crypto.randomBytes(6).toString('hex');
    run('INSERT INTO machines (id, user_id, created_at, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET user_id = COALESCE(excluded.user_id, machines.user_id), last_seen = excluded.last_seen',
      machineId, a?.user.id || null, now(), now());
    // a device of the account (Synapse on a computer, or the phone app): what it is and its public key
    if (a && DEVICE_KINDS.has(b.kind)) {
      if (!/^[A-Za-z0-9+/]{43}=$/.test(String(b.publicKey || ''))) fail(400, 'publicKey must be a base64 X25519 key');
      run('UPDATE machines SET kind = ?, name = ?, public_key = ? WHERE id = ?', b.kind, clean(b.name, 40) || b.kind, b.publicKey, machineId);
    }
    return json(res, 200, { machineId, token: sign({ k: 'machine', m: machineId }), user: a ? meUser(a.user) : null });
  },
  // the account's computers and phones, for the phone app to find its computer and Synapse to know its phones
  'GET /v1/machines': async (req, res) => {
    const { user } = must(req);
    return json(res, 200, { machines: all('SELECT * FROM machines WHERE user_id = ? AND kind IS NOT NULL ORDER BY last_seen DESC', user.id)
      .map((m) => ({ id: m.id, kind: m.kind, name: m.name, publicKey: m.public_key, lastSeen: m.last_seen })) });
  },
  // signing a phone out, or removing it in Synapse: it can no longer reach the account's computers
  'DELETE /v1/machines/:id': async (req, res, b, params) => {
    const { user } = must(req);
    const m = get('SELECT * FROM machines WHERE id = ? AND user_id = ? AND kind IS NOT NULL', params.id, user.id);
    if (!m) fail(404, 'No such device on your account.');
    run('DELETE FROM machines WHERE id = ?', m.id);
    run('DELETE FROM mailbox WHERE machine_id = ?', m.id);
    return json(res, 200, { ok: true });
  },
};

const machineRoutes = {
  'POST /v1/invite': (me, b) => ({ code: sign({ k: 'invite', m: me, name: clean(b.name, 40) || 'someone', exp: now() + INVITE_TTL }) }),
  'POST /v1/join': (me, b) => {
    const inv = verify(b.code, 'invite');
    if (!inv) fail(400, 'this invite is not valid (it may have expired)');
    if (inv.m === me) fail(400, 'that is your own invite');
    const pair = pairOf(me, inv.m);
    deliver(inv.m, { type: 'paired', from: me, name: clean(b.name, 40) || 'someone', pair });
    return { peer: { machineId: inv.m, name: inv.name }, pair };
  },
  'POST /v1/send': (me, b) => {
    // the same account's devices (a phone and its computer) need no invite: the account pairs them
    if (!sameAccount(me, b.to)) {
      if (!pairCovers(b.pair, me, b.to)) fail(403, 'not paired with that machine');
      if (!pairStillTrusted(me, b.to)) fail(403, 'you no longer trust each other');
    }
    const items = Array.isArray(b.items) ? b.items : [];
    // request answers and revocations only ever come from the cloud itself
    for (const it of items) if (it && typeof it === 'object' && !CLOUD_ONLY.has(it.type)) deliver(b.to, { ...it, from: me, pair: b.pair });
    return { queued: items.length };
  },
  'POST /v1/poll': (me) => {
    run('UPDATE machines SET last_seen = ? WHERE id = ?', now(), me);
    return { items: collect(me) };
  },
};

// ---------------------------------------------------------------- OAuth routes

async function oauthStart(req, res, provider, url) {
  if (!oauth.configured(provider)) return html(res, 404, pages.message({ title: 'Not available', body: `Sign in with ${pages.providerLabel(provider)} is not set up yet. Use email instead.`, link: '/login', cta: 'Back to sign in' }));
  limitIp('oauth', req, 60, HOUR);
  const state = rid(24), { verifier, challenge } = oauth.newPkce();
  const a = auth(req);
  run('INSERT INTO oauth_states (state, provider, verifier, next, link_user, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    state, provider, verifier, safeNext(url.searchParams.get('next')), url.searchParams.get('link') && a ? a.user.id : null, now() + 15 * 60_000);
  return redirect(res, oauth.authorizeUrl(provider, { state, challenge, redirect: `${PUBLIC_URL}/auth/${provider}/callback` }));
}

// the account behind a provider identity: the one it is linked to, else the one with the same verified email
// (the provider vouched for it), else a new one; the identity is linked to it either way
function userForIdentity(provider, p, name) {
  const email = p.emailVerified ? normEmail(p.email) : null;
  const known = get('SELECT * FROM identities WHERE provider = ? AND provider_id = ?', provider, p.id);
  let user;
  if (known) user = get('SELECT * FROM users WHERE id = ?', known.user_id);
  else if (email && (user = get('SELECT * FROM users WHERE email = ?', email))) {
    // same verified email: same person. The provider vouched for it, so mark it verified
    if (!user.email_verified) { run('UPDATE users SET email_verified = 1 WHERE id = ?', user.id); claimInvites(user.id, email); }
  } else user = createUser({ email, name: name || p.name, emailVerified: !!email, avatar: p.avatar, handle: p.username });
  if (!known) run('INSERT INTO identities (provider, provider_id, user_id, email, username, created_at) VALUES (?, ?, ?, ?, ?, ?)', provider, p.id, user.id, email, p.username || null, now());
  if (!user.avatar && p.avatar) run('UPDATE users SET avatar = ? WHERE id = ?', p.avatar, user.id);
  return user;
}

// Apple sends the name only the first time, as JSON next to the code
function appleName(raw) {
  try { const n = JSON.parse(raw || '{}').name || {}; return clean([n.firstName, n.lastName].filter(Boolean).join(' '), 60) || undefined; } catch { return undefined; }
}

async function oauthCallback(req, res, provider, url) {
  const st = get('SELECT * FROM oauth_states WHERE state = ? AND provider = ?', String(url.searchParams.get('state') || ''), provider);
  if (st) run('DELETE FROM oauth_states WHERE state = ?', st.state);
  const back = (msg) => redirect(res, `/login?error=${encodeURIComponent(msg)}`);
  console.log(`oauth callback ${provider} state=${st ? 'known' : 'unknown'} next=${st?.next || '-'}`);
  if (!st || st.expires_at < now()) return back('That sign-in took too long. Try again.');
  if (url.searchParams.get('error')) return back(`${pages.providerLabel(provider)} sign-in was cancelled.`);
  let p;
  try { p = await oauth.exchange(provider, { code: url.searchParams.get('code'), verifier: st.verifier, redirect: `${PUBLIC_URL}/auth/${provider}/callback` }); }
  catch (e) { console.error(e.message); return back(`${pages.providerLabel(provider)} sign-in failed. Try again.`); }

  let user;
  if (st.link_user) {
    // linking to the signed-in account
    const email = p.emailVerified ? normEmail(p.email) : null;
    const known = get('SELECT * FROM identities WHERE provider = ? AND provider_id = ?', provider, p.id);
    if (known && known.user_id !== st.link_user) return redirect(res, `/settings?error=${encodeURIComponent(`That ${pages.providerLabel(provider)} account belongs to another Synapse account.`)}`);
    user = get('SELECT * FROM users WHERE id = ?', st.link_user);
    if (!known) run('INSERT INTO identities (provider, provider_id, user_id, email, username, created_at) VALUES (?, ?, ?, ?, ?, ?)', provider, p.id, user.id, email, p.username || null, now());
    if (!user.avatar && p.avatar) run('UPDATE users SET avatar = ? WHERE id = ?', p.avatar, user.id);
  } else user = userForIdentity(provider, p, provider === 'apple' ? appleName(url.searchParams.get('user')) : undefined);
  const token = createSession(user.id, 'web', clean(req.headers['user-agent'], 80), ipOf(req));
  return redirect(res, st.link_user ? '/settings?linked=1' : st.next || '/welcome', { 'set-cookie': cookie('syn_session', token, WEB_SESSION) });
}

// ---------------------------------------------------------------- pages

function page(req, res, url) {
  const p = url.pathname;
  const a = auth(req);
  const ctx = { user: a ? meUser(a.user) : null, providers: oauth.providerStatus(), mail: mailConfigured(), q: Object.fromEntries(url.searchParams), dmg: DMG_URL, base: PUBLIC_URL };
  const needUser = (to) => (ctx.user ? null : redirect(res, `/login?next=${encodeURIComponent(to)}`));
  switch (p) {
    case '/': return redirect(res, ctx.user ? '/welcome' : '/signup');
    case '/signup': return ctx.user && !ctx.q.next ? redirect(res, '/welcome') : html(res, 200, pages.signup(ctx));
    case '/login': return ctx.user && !ctx.q.next ? redirect(res, '/welcome') : html(res, 200, pages.login(ctx));
    case '/forgot': return html(res, 200, pages.forgot(ctx));
    case '/reset': return html(res, 200, pages.reset(ctx));
    case '/verify': return html(res, 200, pages.verify(ctx));
    case '/device': {
      if (!ctx.user) {
        const via = ctx.q.via;
        const next = `/device?code=${encodeURIComponent(ctx.q.code || '')}`;
        if (via && oauth.configured(via)) return redirect(res, `/auth/${via}/start?next=${encodeURIComponent(next)}`);
        return redirect(res, `/login?next=${encodeURIComponent(next)}`);
      }
      const d = get('SELECT * FROM devices WHERE user_code = ?', String(ctx.q.code || '').toUpperCase());
      return html(res, 200, pages.device({ ...ctx, device: d && d.expires_at > now() && d.status === 'pending' ? { code: d.user_code, label: d.label } : null }));
    }
    // the phone app's GitHub, Google or X sign-in ends here (in its browser sheet): hand the app a one-time
    // code through its own redirect, which only the app that opened the sheet receives
    case '/app/done': {
      const state = String(ctx.q.state || '');
      if (!/^[\w-]{16,64}$/.test(state)) return html(res, 400, pages.message({ title: 'Hold on', body: 'This sign-in link is not complete. Start again in the app.', link: '/', cta: 'Home' }));
      console.log(`app/done state=${state.slice(0, 6)}… signed-in=${!!ctx.user} ua=${clean(req.headers['user-agent'], 60)}`);
      if (!ctx.user) return needUser(`/app/done?state=${state}`);
      // also kept under the app's own state, so the app can collect it even if the return link gets lost
      run('INSERT OR REPLACE INTO email_tokens (token_hash, user_id, purpose, email, expires_at) VALUES (?, ?, ?, ?, ?)', sha(`state:${state}`), a.user.id, 'app-state', null, now() + 2 * 60_000);
      return redirect(res, `synapse://signed-in?code=${emailToken(a.user.id, 'app', 2 * 60_000, null)}&state=${state}`);
    }
    case '/welcome': return needUser('/welcome') || html(res, 200, pages.welcome({ ...ctx,
      hasApp: !!get("SELECT 1 FROM sessions WHERE user_id = ? AND kind IN ('app', 'cli')", a.user.id),
      trusted: trustedList(a.user.id) }));
    case '/settings': return needUser('/settings') || html(res, 200, pages.settings(ctx));
    case '/admin': return ctx.user?.admin ? html(res, 200, pages.admin({ ...ctx, ...overview() }))
      : html(res, 404, pages.message({ ...ctx, title: 'Not found', body: 'There is nothing at this address.', link: '/', cta: 'Home' }));
    case '/download': return redirect(res, DMG_URL);
    case '/privacy': return html(res, 200, pages.privacy(ctx));
    case '/terms': return html(res, 200, pages.terms(ctx));
  }
  const prof = p.match(/^\/u\/([a-z0-9_-]{2,24})\/?$/i);
  if (prof) {
    const u = get('SELECT * FROM users WHERE handle = ?', prof[1].toLowerCase());
    if (!u) return html(res, 404, pages.message({ ...ctx, title: 'Nobody here', body: `There is no @${pages.esc(prof[1])} on Synapse.`, link: '/', cta: 'Home' }));
    const trusted = a ? !!get('SELECT 1 FROM trusted WHERE user_id = ? AND trusted_user = ?', a.user.id, u.id) : false;
    return html(res, 200, pages.profile({ ...ctx, person: publicUser(u), self: a?.user.id === u.id, trusted }));
  }
  return null;
}

// ---------------------------------------------------------------- server

const FONTS = path.join(ROOT, 'public', 'fonts');
export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/health') return json(res, 200, { ok: true, service: 'synapse-cloud' });
    // pages on the old railway.app address move to PUBLIC_URL (their cookies only work there); the API stays on both
    if (OLD_HOST?.test(req.headers.host || '') &&!p.startsWith('/v1/') && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(301, { location: PUBLIC_URL + req.url });
      return res.end();
    }
    const font = p.match(/^\/fonts\/([a-z-]+\.woff2)$/);
    if (font) {
      const file = path.join(FONTS, font[1]);
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
      return fs.createReadStream(file).pipe(res);
    }
    const icon = { '/icon.svg': ['icon.svg', 'image/svg+xml'], '/icon.png': ['icon.png', 'image/png'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'], '/favicon.ico': ['icon.png', 'image/png'] }[p];
    if (icon) {
      res.writeHead(200, { 'content-type': icon[1], 'cache-control': 'public, max-age=86400' });
      return fs.createReadStream(path.join(ROOT, 'public', icon[0])).pipe(res);
    }
    if (p === '/app.css') { res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'public, max-age=300' }); return res.end(pages.CSS); }
    if (p === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=300' }); return res.end(pages.JS); }

    const op = p.match(/^\/auth\/(apple|github|google|x)\/(start|callback)$/);
    if (op && req.method === 'GET') return op[2] === 'start' ? await oauthStart(req, res, op[1], url) : await oauthCallback(req, res, op[1], url);
    // Apple posts its answer from appleid.apple.com (form_post). Bounce it to a same-site GET of the same
    // callback, so the session cookie is set on a request the browser treats as ours.
    if (op && op[1] === 'apple' && op[2] === 'callback' && req.method === 'POST') {
      const b = await readBody(req);
      const q = new URLSearchParams(Object.entries(b).filter(([k]) => ['code', 'state', 'error', 'user'].includes(k)).map(([k, v]) => [k, String(v)]));
      return html(res, 200, `<!doctype html><meta http-equiv="refresh" content="0;url=/auth/apple/callback?${pages.esc(q)}"><title>Signing in</title>`);
    }

    if (p.startsWith('/v1/')) {
      if (req.method === 'OPTIONS') return json(res, 204, {});
      if (p === '/v1/dev/outbox' && process.env.CLOUD_DEV_MAIL) return json(res, 200, { mail: devOutbox });
      const b = req.method === 'GET' ? {} : await readBody(req);
      const mr = machineRoutes[`${req.method} ${p}`];
      if (mr) {
        const me = verify(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), 'machine')?.m;
        if (!me) return json(res, 401, { error: 'unknown machine, register again' });
        if (WAITLIST && (p === '/v1/invite' || p === '/v1/join')) {
          const owner = get('SELECT u.* FROM machines m JOIN users u ON u.id = m.user_id WHERE m.id = ?', me);
          if (!owner) return json(res, 403, { error: 'Sign in to Synapse to add friends.' });
          if (owner.access !== 'active') return json(res, 403, { error: shut(owner) });
        }
        return json(res, 200, mr(me, b));
      }
      let handler = routes[`${req.method} ${p}`], params = {};
      if (!handler) {
        for (const [key, fn] of Object.entries(routes)) {
          const [m, pat] = key.split(' ');
          if (m !== req.method || !pat.includes(':')) continue;
          const names = [];
          const re = new RegExp(`^${pat.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([\\w-]+)'; })}$`);
          const hit = p.match(re);
          if (hit) { handler = fn; params = Object.fromEntries(names.map((n, i) => [n, hit[i + 1]])); break; }
        }
      }
      if (!handler) return json(res, 404, { error: 'not found' });
      if (req.method !== 'GET' && auth(req)?.viaCookie && !sameOrigin(req)) return json(res, 403, { error: 'cross-site request refused' });
      return await handler(req, res, b, params);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && page(req, res, url) !== null) return;
    return html(res, 404, pages.message({ title: 'Not found', body: 'There is nothing at this address.', link: '/', cta: 'Home' }));
  } catch (e) {
    if (res.headersSent) return;
    if (e instanceof HttpError) return p.startsWith('/v1/') ? json(res, e.status, { error: e.message }) : html(res, e.status, pages.message({ title: 'Hold on', body: pages.esc(e.message), link: '/', cta: 'Home' }));
    console.error(e);
    return p.startsWith('/v1/') ? json(res, 500, { error: 'Something went wrong on our side.' }) : html(res, 500, pages.message({ title: 'Something broke', body: 'Something went wrong on our side. Try again in a moment.', link: '/', cta: 'Home' }));
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '0.0.0.0', () => console.log(`synapse cloud on :${PORT} as ${PUBLIC_URL} (mail: ${mailConfigured() ? 'on' : 'off'}, oauth: ${JSON.stringify(oauth.providerStatus())})`));
}
