// Phone remote: the Synapse phone app pairs with this machine by scanning a QR code, then sees its agents,
// starts new ones and sends them messages while the app is open here.
//
// It rides on the relay's mailboxes (relay/relay.mjs) under an identity of its own, apart from multiplayer's,
// so neither side collects the other's items. Pairing is a one-off relay invite shown as a QR code together
// with a fresh 32-byte key. The phone joins the invite and from then on every item either way is sealed with
// that key (NaCl secretbox), so the relay only ever carries noise and nobody without the code can steer
// agents here. A code is good for one phone and ten minutes. Messages carry a time and an id, and old or
// repeated ones are dropped, so a replayed item does nothing.
//
// The phone sees agents running anywhere on this machine; it can only type into the ones in this app's
// terminals. It never gets to run anything else: new agents start in an added workspace, as a known kind.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import nacl from 'tweetnacl';
import QRCode from 'qrcode';
import { DATA, readJSON, writeJSON, listAgents, readAgentMessages, projectOf, colorOf } from '../lib.mjs';
import { DEFAULT_RELAY } from '../remote.mjs';

const FILE = path.join(DATA, 'phones.json');
const PAIR_TTL = 10 * 60_000;
const ACTIVE = 2 * 60_000;           // a phone that checked in this recently gets live updates
const FAST = 1500, SLOW = 10_000;    // poll while a phone is around or a code is showing, else now and then
const MAX_AGE = 5 * 60_000;          // older messages are replays, or a phone with a very wrong clock
const MSGS = 40, MSG_CHARS = 4000, TEXT_CHARS = 20_000;

const b64 = (u) => Buffer.from(u).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64'));
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

const load = () => ({ relay: process.env.SYNAPSE_RELAY || DEFAULT_RELAY, machineId: null, token: null, devices: {}, ...readJSON(FILE, {}) });
const save = (s) => { writeJSON(FILE, s); try { fs.chmodSync(FILE, 0o600); } catch {} };

async function call(s, route, body, auth = true) {
  const r = await fetch(s.relay + route, {
    method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${s.token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `relay answered ${r.status}`), { status: r.status });
  return j;
}

function seal(key, msg) {
  const n = nacl.randomBytes(24);
  return { type: 'box', n: b64(n), c: b64(nacl.secretbox(Buffer.from(JSON.stringify(msg)), n, unb64(key))) };
}
function unseal(key, item) {
  const m = nacl.secretbox.open(unb64(item.c), unb64(item.n), unb64(key));
  if (!m) return null;
  try { return JSON.parse(Buffer.from(m).toString('utf8')); } catch { return null; }
}

// ---------------------------------------------------------------- the bridge

let host = null;           // what the app lends us: projects, terminals, spawning
let pending = null;        // the code on screen: { key, exp }
let timer = null;
const live = new Map();    // phone id -> { watch, sent: { state, messages } } (memory only)
const seen = new Map();    // message id -> time, against replays
const spawns = new Map();  // request id -> { phone, at, pty }

export function start(h) {
  host = h;
  schedule(1000);
}

function schedule(ms) { clearTimeout(timer); timer = setTimeout(tick, ms); }

async function identity(s) {
  if (s.token) return s;
  const r = await call(s, '/v1/register', { name: os.hostname() }, false);
  Object.assign(s, { machineId: r.machineId, token: r.token, devices: {} });
  save(s);
  return s;
}

const hostName = () => os.hostname().replace(/\.local$/, '');

export async function pair() {
  const s = await identity(load());
  const { code } = await call(s, '/v1/invite', { name: hostName() });
  const key = nacl.randomBytes(32);
  pending = { key: b64(key), exp: Date.now() + PAIR_TTL };
  const url = `synapse://pair?${new URLSearchParams({ r: s.relay, c: code, k: Buffer.from(key).toString('base64url'), n: hostName() })}`;
  schedule(FAST);
  return { url, svg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), exp: pending.exp };
}

export function cancelPair() { pending = null; }

export function devices() {
  return Object.entries(load().devices).map(([id, d]) => ({ id, name: d.name, pairedAt: d.pairedAt, seen: d.seen || null }));
}

export function remove(id) {
  const s = load();
  delete s.devices[id];
  live.delete(id);
  save(s);
}

async function tick() {
  let s = load();
  const phones = Object.keys(s.devices).length;
  if (pending && pending.exp < Date.now()) pending = null;
  if (!s.token || (!pending && !phones)) return; // nothing paired: pair() starts the loop again
  try {
    const { items } = await call(s, '/v1/poll', {});
    for (const it of items) await receive(s, it);
    await push(load());
  } catch (e) {
    if (e.status === 401) { s.token = null; save(s); } // the relay forgot us: phones have to pair again
  }
  s = load();
  const recent = Object.values(s.devices).some((d) => Date.now() - (d.seen || 0) < ACTIVE);
  schedule(pending || recent ? FAST : SLOW);
}

async function receive(s, it) {
  if (it.type === 'paired') {
    if (!pending || pending.exp < Date.now()) return; // a code nobody is showing any more
    s.devices[it.from] = { name: clean(it.name, 40) || 'phone', key: pending.key, pair: it.pair, pairedAt: Date.now(), seen: Date.now() };
    pending = null;
    save(s);
    host.changed({ paired: s.devices[it.from].name });
    return;
  }
  const d = s.devices[it.from];
  if (it.type !== 'box' || !d) return;
  const m = unseal(d.key, it);
  if (!m || typeof m.t !== 'string' || !m.mid || seen.has(m.mid) || Math.abs(Date.now() - Number(m.ts)) > MAX_AGE) return;
  seen.set(m.mid, Date.now());
  for (const [k, t] of seen) if (Date.now() - t > 2 * MAX_AGE) seen.delete(k);
  d.seen = Date.now();
  save(s);
  try { await handle(s, it.from, m); }
  catch (e) { await send(s, it.from, { t: 'error', req: m.req, error: e.message }); }
}

async function handle(s, phone, m) {
  const l = live.get(phone) || { watch: null, sent: {} };
  live.set(phone, l);
  if (m.t === 'hello') { l.sent = {}; return send(s, phone, { t: 'hello', name: hostName() }); }
  if (m.t === 'watch') { l.watch = typeof m.id === 'string' ? m.id : null; l.sent.messages = null; return; }
  if (m.t === 'bye') { live.delete(phone); return; }
  if (m.t === 'unpair') { remove(phone); host.changed({}); return; }
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
    spawns.set(req, { phone, at: Date.now(), pty: null });
    host.spawn({ req, cwd, kind, prompt: String(m.prompt || '').slice(0, TEXT_CHARS) });
  }
}

// the renderer opened the terminal a phone asked for: once the agent in it shows up, tell the phone its id
export function spawned(req, pty) {
  const r = spawns.get(req);
  if (r) r.pty = pty;
}

function send(s, phone, msg) {
  const d = s.devices[phone];
  if (!d) return;
  const sealed = seal(d.key, { ...msg, ts: Date.now(), mid: b64(nacl.randomBytes(12)) });
  return call(s, '/v1/send', { to: phone, pair: d.pair, items: [sealed] });
}

// ---------------------------------------------------------------- what the phone sees

const cache = new Map(); // transcript -> { stamp, messages }
function messagesOf(a) {
  if (!a.transcript) return [];
  let stamp = '';
  try { const st = fs.statSync(a.transcript); stamp = `${st.size}:${st.mtimeMs}`; } catch { if (a.format !== 'demo') return []; } // demo agents have no file
  const hit = cache.get(a.transcript);
  if (hit?.stamp === stamp) return hit.messages;
  let messages = [];
  try { messages = (readAgentMessages(a).messages || []).filter((x) => x.text?.trim()).slice(-MSGS).map((x) => ({ role: x.role, text: x.text.slice(0, MSG_CHARS), ts: x.ts, tool: !!x.tool })); } catch {}
  cache.set(a.transcript, { stamp, messages });
  return messages;
}

function snapshot() {
  const projects = host.projects().map((p) => ({
    key: p.key, label: p.label, color: p.color,
    worktrees: p.worktrees.map((w) => ({ path: w.path, name: w.name, branch: w.branch, home: !!w.home })),
  }));
  const agents = listAgents().filter((a) => !a.remote).map((a) => {
    const pr = projectOf(a.cwd), msgs = messagesOf(a);
    const last = [...msgs].reverse().find((x) => !x.tool) || msgs.at(-1);
    return {
      id: a.id, kind: a.kind, name: a.name, status: a.status,
      project: { key: pr.key, label: pr.label, color: colorOf(pr.key) },
      worktree: pr.worktree?.name || null,
      inApp: !!host.ptyOf(a.pid),
      updatedAt: Date.parse(last?.ts) || a.startedAt || Date.now(),
      preview: last ? { role: last.role, text: last.text.slice(0, 200) } : null,
    };
  });
  return { projects, agents, kinds: host.kinds() };
}

async function push(s) {
  const now = Date.now();
  const phones = Object.keys(s.devices).filter((id) => now - (s.devices[id].seen || 0) < ACTIVE && live.has(id));
  if (!phones.length) return;
  const snap = snapshot();
  const state = JSON.stringify(snap);
  // a terminal the phone asked for has its agent now: hand over the id so the phone can open the chat
  for (const [req, r] of spawns) {
    if (now - r.at > 60_000) { spawns.delete(req); continue; }
    const a = r.pty && listAgents().find((x) => host.ptyOf(x.pid) === r.pty);
    if (a) { spawns.delete(req); await send(s, r.phone, { t: 'spawned', req, id: a.id }); }
  }
  for (const id of phones) {
    const l = live.get(id);
    if (l.sent.state !== state) { await send(s, id, { t: 'state', ...snap }); l.sent.state = state; }
    if (l.watch) {
      const a = listAgents().find((x) => x.id === l.watch);
      const messages = a ? messagesOf(a) : [];
      const body = JSON.stringify(messages);
      if (l.sent.messages !== body) { await send(s, id, { t: 'messages', id: l.watch, messages }); l.sent.messages = body; }
    }
  }
}
