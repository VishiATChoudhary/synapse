#!/usr/bin/env node
// Synapse relay: lets Synapse on two machines share agent context over the internet.
// It is a mailbox, nothing more. Machines connect out to it, drop items into a paired machine's
// mailbox and collect their own. Nothing is written to disk: identities, invites and pairings are
// signed tokens the machines keep, so a restart only loses items that were still in flight.
//
//   POST /v1/register {name}          -> {machineId, token}           a new machine identity
//   POST /v1/invite                   -> {code}                       an invite only this machine can hand out
//   POST /v1/join {code, name}        -> {peer, pair}                 accept an invite; the inviter is told too
//   POST /v1/send {to, pair, items}   -> {queued}                     drop items into a paired machine's mailbox
//   POST /v1/poll                     -> {items}                      collect (and clear) this machine's mailbox
//   GET  /health
//
// Every /v1 call except register carries "authorization: Bearer <token>".
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.RELAY_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.RELAY_SECRET) console.warn('RELAY_SECRET is not set: tokens stop working when this process restarts');

const MAX_BODY = 2 << 20;          // per request
const MAX_MAILBOX = 8 << 20;       // per machine; the oldest items go first
const ITEM_TTL = 24 * 3600_000;    // undelivered items are dropped after a day
const INVITE_TTL = 7 * 24 * 3600_000;

// ---------------------------------------------------------------- signed tokens

const b64 = (s) => Buffer.from(s).toString('base64url');
const mac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
export function sign(obj) { const body = b64(JSON.stringify(obj)); return `${body}.${mac(body)}`; }
export function verify(token, kind) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (obj.k !== kind || (obj.exp && obj.exp < Date.now())) return null;
    return obj;
  } catch { return null; }
}
const pairOf = (a, b) => sign({ k: 'pair', m: [a, b].sort() });
const pairCovers = (token, a, b) => { const p = verify(token, 'pair'); return !!p && p.m.includes(a) && p.m.includes(b) && a !== b; };
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'someone';

// ---------------------------------------------------------------- mailboxes

const boxes = new Map(); // machineId -> { items: [{t, size, item}], bytes }
function deliver(to, item) {
  const box = boxes.get(to) || { items: [], bytes: 0 };
  const size = JSON.stringify(item).length;
  box.items.push({ t: Date.now(), size, item });
  box.bytes += size;
  while (box.bytes > MAX_MAILBOX && box.items.length > 1) box.bytes -= box.items.shift().size;
  boxes.set(to, box);
}
function collect(id) {
  const box = boxes.get(id);
  if (!box) return [];
  boxes.delete(id);
  const fresh = Date.now() - ITEM_TTL;
  return box.items.filter((x) => x.t > fresh).map((x) => x.item);
}
setInterval(() => {
  const fresh = Date.now() - ITEM_TTL;
  for (const [id, box] of boxes) {
    box.items = box.items.filter((x) => x.t > fresh);
    box.bytes = box.items.reduce((v, x) => v + x.size, 0);
    if (!box.items.length) boxes.delete(id);
  }
}, 600_000).unref();

// a little brake on anonymous registrations
const regs = new Map(); // ip -> [timestamps]
function allowRegister(ip) {
  const now = Date.now(), recent = (regs.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= 20) return false;
  recent.push(now); regs.set(ip, recent);
  return true;
}

// ---------------------------------------------------------------- http

const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
function body(req) {
  return new Promise((resolve, reject) => {
    let d = '', n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('too big')); req.destroy(); } else d += c; });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

export const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/' || p === '/health') return json(res, 200, { ok: true, service: 'synapse-relay' });
  if (req.method !== 'POST' || !p.startsWith('/v1/')) return json(res, 404, { error: 'not found' });
  let b;
  try { b = await body(req); } catch { return json(res, 413, { error: 'request too large' }); }

  if (p === '/v1/register') {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!allowRegister(ip)) return json(res, 429, { error: 'too many registrations, try again later' });
    const machineId = crypto.randomBytes(6).toString('hex');
    return json(res, 200, { machineId, token: sign({ k: 'machine', m: machineId }) });
  }

  const me = verify(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), 'machine')?.m;
  if (!me) return json(res, 401, { error: 'unknown machine, register again' });

  if (p === '/v1/invite') {
    return json(res, 200, { code: sign({ k: 'invite', m: me, name: cleanName(b.name), exp: Date.now() + INVITE_TTL }) });
  }
  if (p === '/v1/join') {
    const inv = verify(b.code, 'invite');
    if (!inv) return json(res, 400, { error: 'this invite is not valid (it may have expired)' });
    if (inv.m === me) return json(res, 400, { error: 'that is your own invite' });
    const pair = pairOf(me, inv.m);
    deliver(inv.m, { type: 'paired', from: me, name: cleanName(b.name), pair });
    return json(res, 200, { peer: { machineId: inv.m, name: inv.name }, pair });
  }
  if (p === '/v1/send') {
    if (!pairCovers(b.pair, me, b.to)) return json(res, 403, { error: 'not paired with that machine' });
    const items = Array.isArray(b.items) ? b.items : [];
    for (const it of items) if (it && typeof it === 'object') deliver(b.to, { ...it, from: me, pair: b.pair });
    return json(res, 200, { queued: items.length });
  }
  if (p === '/v1/poll') return json(res, 200, { items: collect(me) });
  json(res, 404, { error: 'not found' });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '0.0.0.0', () => console.log(`synapse relay on :${PORT}`));
}
