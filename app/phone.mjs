// Phone remote: the Synapse phone app, signed in to the same Synapse account, sees this machine's agents,
// starts new ones and sends them messages while the app is open here.
//
// Both ends are devices of the account on Synapse Cloud: this machine registers a mailbox of its own there
// as a "computer" (apart from multiplayer's identity, so neither collects the other's items), the phone as
// a "phone", each with a public key. The cloud lets an account's devices drop items into each other's
// mailbox. Every item is sealed end to end (NaCl box, X25519) to the receiver's key, so the cloud only
// carries ciphertext. Messages carry a time and an id; old or repeated ones are dropped.
//
// Signing in is not enough to steer this machine: the first time a phone turns up, Synapse asks here
// whether to allow it, and only allowed phones get anything but "waiting". The phone sees agents running
// anywhere on this machine; it can only type into the ones in this app's terminals, and new agents start
// in an added workspace, as a known kind.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import nacl from 'tweetnacl';
import { DATA, readJSON, writeJSON, listAgents, readAgentMessages, projectOf, colorOf } from '../lib.mjs';
import * as media from './phone-media.mjs';
import * as shares from './phone-share.mjs';

const FILE = path.join(DATA, 'phones.json');
const ACTIVE = 2 * 60_000;           // a phone that checked in this recently gets live updates
const FAST = 1500, SLOW = 10_000;    // poll while a phone is around, else now and then
const MAX_AGE = 5 * 60_000;          // older messages are replays, or a phone with a very wrong clock
const MSGS = 40, MSG_CHARS = 4000, TEXT_CHARS = 20_000;

const b64 = (u) => Buffer.from(u).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64'));
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const hostName = () => os.hostname().replace(/\.local$/, '');

const load = () => ({ cloud: null, user: null, machineId: null, token: null, publicKey: null, secretKey: null, allowed: {}, asking: {}, ...readJSON(FILE, {}) });
const save = (s) => { writeJSON(FILE, s); try { fs.chmodSync(FILE, 0o600); } catch {} };

let account = null; // ../account.mjs, loaded on first use like the app does
const acct = async () => (account ||= await import('../account.mjs'));

async function call(url, route, { body, bearer, method = 'POST' } = {}) {
  const r = await fetch(url + route, {
    method, signal: AbortSignal.timeout(10_000),
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Synapse Cloud answered ${r.status}`), { status: r.status });
  return j;
}

const seal = (s, theirKey, msg) => {
  const n = nacl.randomBytes(24);
  return { type: 'box', n: b64(n), c: b64(nacl.box(Buffer.from(JSON.stringify(msg)), n, unb64(theirKey), unb64(s.secretKey))) };
};
// a video piece: the bytes ride in the box as they are (not base64 inside JSON), after a JSON header
// [4 bytes header length][header][bytes]
const sealBin = (s, theirKey, msg, bytes) => {
  const head = Buffer.from(JSON.stringify(msg)), len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  const n = nacl.randomBytes(24);
  return { type: 'box', bin: 1, n: b64(n), c: b64(nacl.box(Buffer.concat([len, head, bytes]), n, unb64(theirKey), unb64(s.secretKey))) };
};
function unseal(s, theirKey, item) {
  const m = nacl.box.open(unb64(item.c), unb64(item.n), unb64(theirKey), unb64(s.secretKey));
  if (!m) return null;
  try { return JSON.parse(Buffer.from(m).toString('utf8')); } catch { return null; }
}

// ---------------------------------------------------------------- identity

// this machine as a "computer" of the signed-in account; a new account (or a new cloud) starts over
async function identity() {
  const { account: signedIn, cloudUrl } = await acct();
  const a = signedIn();
  if (!a) return null;
  let s = load();
  const cloud = cloudUrl();
  if (s.user !== a.user?.id || s.cloud !== cloud) s = { ...s, cloud, user: a.user?.id, machineId: null, token: null, allowed: {}, asking: {} };
  if (!s.secretKey) { const k = nacl.box.keyPair(); Object.assign(s, { publicKey: b64(k.publicKey), secretKey: b64(k.secretKey) }); }
  if (!s.token) {
    const r = await call(cloud, '/v1/register', { bearer: a.token, body: { kind: 'computer', name: hostName(), publicKey: s.publicKey } });
    Object.assign(s, { machineId: r.machineId, token: r.token });
    save(s);
  }
  return { s, session: a.token };
}

// the account's phones, with their keys; asked again when an unknown one writes
let phones = { at: 0, list: [] };
async function phonesOf(id, force = false) {
  if (force || Date.now() - phones.at > 30_000) {
    try { phones = { at: Date.now(), list: (await call(id.s.cloud, '/v1/machines', { bearer: id.session, method: 'GET' })).machines.filter((m) => m.kind === 'phone') }; } catch {}
  }
  return phones.list;
}

// ---------------------------------------------------------------- the bridge

let host = null;           // what the app lends us: projects, terminals, spawning
let timer = null;
const live = new Map();    // phone id -> { watch, media, sent: { state, messages } } (memory only)
const seen = new Map();    // message id -> time, against replays
const spawns = new Map();  // request id -> { phone, at, pty }

export function start(h) {
  host = h;
  media.setOnChange(() => schedule(100)); // a video copy is ready: tell the phone now
  shares.sweep();
  shares.attach((list) => { schedule(100); host.changed({ shares: list }); }); // a link went live, got more time or ended
  schedule(1000);
}
// live links, for the Mac's own list and for quitting
export const liveShares = () => shares.list();
export const stopShare = (id) => shares.stop(id);
export const stopShares = () => shares.stopAll();
const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(tick, ms); };
export const wake = () => schedule(200); // signed in or out, a phone allowed: look again now

async function tick() {
  let id = null, recent = false;
  try {
    id = await identity();
    if (id) {
      const { items } = await call(id.s.cloud, '/v1/poll', { bearer: id.s.token, body: {} });
      for (const it of items) await receive(id, it);
      await push(id);
      recent = [...live.keys()].length > 0 || Object.keys(load().asking).length > 0;
    }
  } catch (e) {
    if (e.status === 401 && id) { const s = load(); s.token = null; save(s); } // the cloud forgot this mailbox: register again
  }
  schedule(recent ? FAST : SLOW);
}

async function receive(id, it) {
  if (it.type !== 'box' || !it.from) return;
  let phone = (await phonesOf(id)).find((p) => p.id === it.from);
  if (!phone) phone = (await phonesOf(id, true)).find((p) => p.id === it.from);
  if (!phone?.publicKey) return; // not a phone of this account
  const m = unseal(id.s, phone.publicKey, it);
  if (!m || typeof m.t !== 'string' || !m.mid || seen.has(m.mid) || Math.abs(Date.now() - Number(m.ts)) > MAX_AGE) return;
  seen.set(m.mid, Date.now());
  for (const [k, t] of seen) if (Date.now() - t > 2 * MAX_AGE) seen.delete(k);
  const s = load();
  if (!s.allowed[phone.id]) {
    if (!s.asking[phone.id]) { s.asking[phone.id] = { name: clean(phone.name, 40) || 'phone', at: Date.now() }; save(s); host.changed({ asking: s.asking[phone.id].name }); }
    if (m.t === 'hello' || m.t === 'ping') await send(id, phone, { t: 'waiting', computer: hostName() });
    return;
  }
  s.allowed[phone.id].seen = Date.now();
  save(s);
  try { await handle(id, phone, m); }
  catch (e) { await send(id, phone, { t: 'error', req: m.req, error: e.message }); }
}

async function handle(id, phone, m) {
  const l = live.get(phone.id) || { watch: null, media: false, sent: {} };
  live.set(phone.id, l);
  // a phone that says media: 1 shows images and videos; older builds (and the switch off) get text only
  if (m.t === 'hello') { l.sent = {}; l.media = m.media === 1; return send(id, phone, { t: 'hello', computer: hostName(), media: 1 }); }
  if (m.t === 'media') {
    const img = media.image(String(m.id || ''));
    if (!img) return send(id, phone, { t: 'media', id: m.id, gone: true });
    const small = await media.shrink(img);
    return send(id, phone, { t: 'media', id: m.id, mime: small.mime, data: small.data });
  }
  if (m.t === 'piece') {
    const p = media.piece(String(m.id || ''), Number(m.i));
    if (!p) return send(id, phone, { t: 'piece', id: m.id, i: m.i, gone: true });
    return sendBin(id, phone, { t: 'piece', id: m.id, i: p.i, n: p.n, size: p.size }, p.bytes);
  }
  // a link or file in an agent's chat, opened on the phone: only what that agent's messages mention, nothing else
  // on this Mac. Starting a tunnel takes seconds, so the answer comes later and the mailbox keeps flowing.
  if (m.t === 'share') {
    const a = listAgents().find((x) => x.id === m.id && !x.remote);
    if (!a) throw new Error('that agent is no longer running');
    const target = String(m.target || '');
    if (![...messagesOf(a), ...messagesOf(a, true)].some((x) => shares.targetsIn(x.text).includes(target))) throw new Error('that link is not in this chat');
    shares.share(target, { cwd: a.cwd })
      .then((s) => send(id, phone, { t: 'shared', req: m.req, share: s }))
      .catch((e) => send(id, phone, { t: 'error', req: m.req, error: e.message }));
    return;
  }
  if (m.t === 'extend') return send(id, phone, { t: 'shared', req: m.req, share: shares.extend(String(m.share || '')) });
  if (m.t === 'unshare') { shares.stop(String(m.share || '')); return; }
  if (m.t === 'watch') { l.watch = typeof m.id === 'string' ? m.id : null; l.sent.messages = null; return; }
  if (m.t === 'bye') { live.delete(phone.id); return; }
  if (m.t === 'send' || m.t === 'stop') {
    const a = listAgents().find((x) => x.id === m.id && !x.remote);
    if (!a) throw new Error('that agent is no longer running');
    const pty = host.ptyOf(a.pid);
    if (!pty) throw new Error(`${a.name} runs outside the Synapse app, so the phone can only read it`);
    if (m.t === 'stop') return host.write(pty, '\x1b');
    const text = String(m.text || '').slice(0, TEXT_CHARS);
    if (text.trim()) host.submit(pty, text);
    return;
  }
  if (m.t === 'spawn') {
    const cwd = String(m.cwd || ''), kind = String(m.kind || '');
    if (!host.projects().some((p) => p.worktrees.some((w) => w.path === cwd))) throw new Error('that folder is not a workspace in Synapse');
    if (!host.kinds().includes(kind)) throw new Error(`unknown agent ${kind}`);
    const req = clean(m.req, 40) || String(Date.now());
    spawns.set(req, { phone: phone.id, at: Date.now(), pty: null });
    host.spawn({ req, cwd, kind, prompt: String(m.prompt || '').slice(0, TEXT_CHARS) });
  }
}

// the renderer opened the terminal a phone asked for: once the agent in it shows up, tell the phone its id
export function spawned(req, pty) {
  const r = spawns.get(req);
  if (r) r.pty = pty;
}

function send(id, phone, msg) {
  const sealed = seal(id.s, phone.publicKey, { ...msg, ts: Date.now(), mid: b64(nacl.randomBytes(12)) });
  return call(id.s.cloud, '/v1/send', { bearer: id.s.token, body: { to: phone.id, items: [sealed] } });
}
function sendBin(id, phone, msg, bytes) {
  const sealed = sealBin(id.s, phone.publicKey, { ...msg, ts: Date.now(), mid: b64(nacl.randomBytes(12)) }, bytes);
  return call(id.s.cloud, '/v1/send', { bearer: id.s.token, body: { to: phone.id, items: [sealed] } });
}

// ---------------------------------------------------------------- settings: which phones may steer this machine

export async function devices() {
  const id = await identity().catch(() => null);
  const s = load();
  const signedIn = !!(await acct()).account();
  // a phone that signed out (or was removed elsewhere) is no longer a device of the account: forget it
  if (id) {
    const known = new Set((await phonesOf(id, true)).map((p) => p.id));
    let pruned = false;
    for (const k of ['asking', 'allowed']) for (const p of Object.keys(s[k])) if (!known.has(p)) { delete s[k][p]; pruned = true; }
    if (pruned) save(s);
  }
  const list = [
    ...Object.entries(s.asking).map(([id, d]) => ({ id, name: d.name, state: 'asking', at: d.at })),
    ...Object.entries(s.allowed).map(([id, d]) => ({ id, name: d.name, state: 'allowed', at: d.at, seen: d.seen || null })),
  ];
  return { signedIn, list };
}

export function allow(phoneId) {
  const s = load();
  const d = s.asking[phoneId];
  if (!d) throw new Error('that phone is not asking any more');
  s.allowed[phoneId] = { name: d.name, at: Date.now() };
  delete s.asking[phoneId];
  save(s);
  wake();
}

// deny or remove: the phone loses this machine, and is signed out of the account's devices
export async function remove(phoneId) {
  const s = load();
  delete s.asking[phoneId];
  delete s.allowed[phoneId];
  save(s);
  live.delete(phoneId);
  const id = await identity().catch(() => null);
  if (id) await call(id.s.cloud, `/v1/machines/${encodeURIComponent(phoneId)}`, { bearer: id.session, method: 'DELETE' }).catch(() => {});
  phones.at = 0;
}

// ---------------------------------------------------------------- what the phone sees

const cache = new Map(); // transcript (+ media) -> { stamp, messages }
const MEDIA_PER_MESSAGE = 12;
function messagesOf(a, withMedia = false) {
  if (!a.transcript) return [];
  let stamp = '';
  try { const st = fs.statSync(a.transcript); stamp = `${st.size}:${st.mtimeMs}`; } catch { if (a.format !== 'demo') return []; } // demo agents have no file
  const key = `${a.transcript}${withMedia ? '#media' : ''}`;
  const hit = cache.get(key);
  if (hit?.stamp === stamp) return hit.messages;
  let messages = [];
  try {
    const read = readAgentMessages(a, null, withMedia ? { media: true, tailBytes: 2_000_000, minMessages: 12 } : {}).messages || [];
    for (const x of read) {
      const refs = withMedia && x.media ? [
        ...x.media.images.map((img) => media.addImage(img).id),
        ...x.media.videos.map((p) => media.addVideo(p, a.cwd)).filter(Boolean),
      ] : [];
      const text = x.text?.trim() ? x.text.slice(0, MSG_CHARS) : '';
      // a turn that is only media (a screenshot's tool result) belongs to the message before it
      if (!text) {
        const prev = messages.at(-1);
        if (refs.length && prev) prev.media = [...new Set([...(prev.media || []), ...refs])].slice(-MEDIA_PER_MESSAGE);
        continue;
      }
      messages.push({ role: x.role, text, ts: x.ts, tool: !!x.tool, ...(refs.length ? { media: [...new Set(refs)].slice(-MEDIA_PER_MESSAGE) } : {}) });
    }
    messages = messages.slice(-MSGS);
  } catch {}
  cache.set(key, { stamp, messages });
  return messages;
}
// media ids as the phone sees them, with how far each video is
const withRefs = (messages) => messages.map((m) => (m.media ? { ...m, media: m.media.map((id) => (id.startsWith('v') ? media.videoRef(id) : { id, kind: 'image' })).filter(Boolean) } : m));

function snapshot() {
  const projects = host.projects().map((p) => ({
    key: p.key, label: p.label, color: p.color,
    worktrees: p.worktrees.map((w) => ({ path: w.path, name: w.name, branch: w.branch, home: !!w.home })),
  }));
  const agents = listAgents().filter((a) => !a.remote).map((a) => {
    const pr = projectOf(a.cwd), msgs = messagesOf(a);
    const last = [...msgs].reverse().find((x) => !x.tool) || msgs.at(-1);
    return {
      id: a.id, kind: a.kind, name: a.name, status: a.status, forkOf: a.forkOf || null,
      project: { key: pr.key, label: pr.label, color: colorOf(pr.key) },
      worktree: pr.worktree?.name || null,
      inApp: !!host.ptyOf(a.pid),
      updatedAt: Date.parse(last?.ts) || a.startedAt || Date.now(),
      preview: last ? { role: last.role, text: last.text.slice(0, 200) } : null,
    };
  });
  return { projects, agents, kinds: host.kinds(), shares: shares.list() };
}

async function push(id) {
  const s = load(), now = Date.now();
  const active = Object.keys(s.allowed).filter((p) => now - (s.allowed[p].seen || 0) < ACTIVE && live.has(p));
  if (!active.length) return;
  const list = await phonesOf(id);
  const snap = snapshot();
  const state = JSON.stringify(snap);
  // a terminal the phone asked for has its agent now: hand over the id so the phone can open the chat
  for (const [req, r] of spawns) {
    if (now - r.at > 60_000) { spawns.delete(req); continue; }
    const a = r.pty && listAgents().find((x) => host.ptyOf(x.pid) === r.pty);
    const phone = list.find((p) => p.id === r.phone);
    if (a && phone) { spawns.delete(req); await send(id, phone, { t: 'spawned', req, id: a.id }); }
  }
  for (const pid of active) {
    const phone = list.find((p) => p.id === pid), l = live.get(pid);
    if (!phone) continue;
    if (l.sent.state !== state) { await send(id, phone, { t: 'state', ...snap }); l.sent.state = state; }
    if (l.watch) {
      const a = listAgents().find((x) => x.id === l.watch);
      const raw = a ? messagesOf(a, l.media) : [];
      // videos in what the phone is looking at get their phone copy made now, so they are ready when reached
      if (l.media) for (const m of raw) for (const mid of m.media || []) if (mid.startsWith('v')) media.prepare(mid);
      const messages = withRefs(raw);
      const body = JSON.stringify(messages);
      if (l.sent.messages !== body) { await send(id, phone, { t: 'messages', id: l.watch, messages }); l.sent.messages = body; }
    }
  }
}
