// Multiplayer: share agent context with friends' agents on other machines, through a Synapse relay.
//
// Each machine registers with the relay once and keeps its identity in ~/.synapse/remote.json.
// `synapse invite` prints a code, a friend runs `synapse join <code>`, and from then on both machines
// tell each other which agents they run. Links work as on one machine, with one rule: only the owner
// of an agent can share it. Drawing `my-agent -> friend's-agent` sends my agent's new activity to the
// friend's machine, where it lands in ~/.synapse/remote/<machine>/<agent>.jsonl and reaches their agent
// through the prompt hook and synapse_read, like a local transcript. Agents on different machines do
// not message each other.
//
// Everything goes over plain HTTPS polling: the canvas server syncs every few seconds, and the prompt
// hook and `synapse read` sync once before they look.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  FILES, REMOTE_DIR, KINDS, readJSON, writeJSON, localAgents, readAgentMessages, logEvent, projectOf, remoteId, remoteLog,
} from './lib.mjs';

export const DEFAULT_RELAY = 'https://relay-production-b5a8.up.railway.app';
const SENT = path.join(REMOTE_DIR, 'sent.json');     // how far each shared transcript has been sent, per friend
const OUTBOX = path.join(REMOTE_DIR, 'outbox.json'); // items waiting for the next sync ("stop sharing with me")
const LOCK = path.join(REMOTE_DIR, 'sync.lock');
const HEARTBEAT = 20_000;                            // our agent list is resent at least this often
const PUSH_CHARS = 40_000, PUSH_MSGS = 80, MSG_CHARS = 4000;
const CODE_PREFIX = 'synapse-invite:';

fs.mkdirSync(REMOTE_DIR, { recursive: true });

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

// ---------------------------------------------------------------- config

export function config() {
  const c = readJSON(FILES.remote, {});
  return { relay: null, machineId: null, token: null, name: null, peers: {}, blocked: [], ...c };
}
const saveConfig = (c) => writeJSON(FILES.remote, c);
// Worth talking to the relay: we have friends, or an invite of ours may be accepted any moment.
// a machine bound to a Synapse account keeps polling: synapse requests and their answers arrive through it
export const isConnected = (c = config()) => !!c.token && (Object.keys(c.peers).length > 0 || !!c.user || Date.now() - (c.invitedAt || 0) < 7 * 24 * 3600_000);

// signed in to Synapse Cloud (account.mjs owns the file; read here so the two modules do not import each other)
function session() {
  const a = readJSON(FILES.account, null);
  return a?.token ? { cloud: (process.env.SYNAPSE_CLOUD || a.cloud || '').replace(/\/+$/, ''), token: a.token, user: a.user?.id || null } : null;
}

function defaultName() {
  try {
    const n = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    if (n) return clean(n.split(/\s+/)[0], 40);
  } catch {}
  return clean(os.userInfo().username, 40) || 'someone';
}

export function setName(name) {
  const c = config();
  c.name = clean(name, 40) || defaultName();
  saveConfig(c);
  return { name: c.name };
}

// ---------------------------------------------------------------- relay calls

async function call(relay, route, body, token, timeout = 8000) {
  const r = await fetch(relay.replace(/\/+$/, '') + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeout),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(out.error || `relay answered ${r.status}`); e.status = r.status; throw e; }
  return out;
}

// sessionToken: register with the signed-in account, so the cloud knows whose machine this is
async function ensureIdentity(c, relay, sessionToken = null, user = null) {
  const peers = Object.keys(c.peers).length > 0;
  if (c.token && c.relay === relay && (!sessionToken || (user && c.user === user))) return c;
  if (c.token && c.relay !== relay && peers) {
    throw new Error(`this machine already has friends on ${c.relay}; both sides need the same relay`);
  }
  // already known to this cloud: keep the machine id (friends address it) and bind it to the account
  const keep = sessionToken && c.token && c.relay === relay ? { machineToken: c.token } : {};
  const r = await call(relay, '/v1/register', { name: c.name, ...keep }, sessionToken);
  Object.assign(c, { relay, machineId: r.machineId, token: r.token, user: sessionToken ? (r.user?.id || r.user || user) : null });
  saveConfig(c);
  return c;
}

// The machine identity on Synapse Cloud, bound to the signed-in account (account.mjs uses it for requests).
export async function cloudMachine(cloud, sessionToken) {
  const s = session();
  const c = config();
  if (!c.name) c.name = defaultName();
  return ensureIdentity(c, cloud.replace(/\/+$/, ''), sessionToken, s?.user || null);
}

// A friend made through an accepted request: the cloud signed the pairing. Such a friend only ever
// sees the agents shared with them (see push), never the rest of this machine.
export function addPeer(machineId, { name, pair, handle }) {
  const c = config();
  c.peers[machineId] = { ...c.peers[machineId], name: clean(name, 40) || 'friend', pair, via: 'request', ...(clean(handle, 24) ? { handle: clean(handle, 24) } : {}), since: c.peers[machineId]?.since || Date.now() };
  c.blocked = c.blocked.filter((m) => m !== machineId);
  saveConfig(c);
  return c.peers[machineId];
}

// where new identities go: the cloud when signed in, else the relay
const relayFor = (c) => c.relay || process.env.SYNAPSE_RELAY || session()?.cloud || DEFAULT_RELAY;

// ---------------------------------------------------------------- invite, join, friends

export async function invite({ name } = {}) {
  const c = config();
  if (name || !c.name) c.name = clean(name, 40) || defaultName();
  saveConfig(c);
  const relay = relayFor(c), s = session();
  await ensureIdentity(c, relay, s?.cloud === relay ? s.token : null, s?.cloud === relay ? s.user : null);
  const { code } = await call(c.relay, '/v1/invite', { name: c.name }, c.token);
  c.invitedAt = Date.now();
  saveConfig(c);
  const full = CODE_PREFIX + Buffer.from(JSON.stringify({ r: c.relay, c: code })).toString('base64url');
  return { code: full, as: c.name, expires: 'in 7 days', next: `Your friend runs: synapse join ${full}` };
}

export function parseInvite(code) {
  const raw = String(code || '').trim().replace(/^synapse join\s+/, '');
  if (!raw.startsWith(CODE_PREFIX)) throw new Error('that does not look like a Synapse invite code');
  try {
    const { r, c } = JSON.parse(Buffer.from(raw.slice(CODE_PREFIX.length), 'base64url').toString('utf8'));
    if (typeof r !== 'string' || !/^https?:\/\//.test(r) || typeof c !== 'string') throw new Error();
    return { relay: r, code: c };
  } catch { throw new Error('this invite code is damaged; copy it again'); }
}

export async function join(code, { name } = {}) {
  const inv = parseInvite(code);
  const c = config();
  if (name || !c.name) c.name = clean(name, 40) || defaultName();
  saveConfig(c);
  await ensureIdentity(c, inv.relay);
  const { peer, pair } = await call(c.relay, '/v1/join', { code: inv.code, name: c.name }, c.token);
  const now = config();
  now.peers[peer.machineId] = { name: clean(peer.name, 40), pair, since: Date.now() };
  now.blocked = now.blocked.filter((m) => m !== peer.machineId);
  saveConfig(now);
  logEvent({ type: 'friend', name: peer.name });
  await sync().catch(() => {}); // show them our agents straight away
  return { friend: peer.name, as: now.name };
}

export function friends() {
  const c = config();
  const states = readJSON(FILES.peerState, {});
  const now = Date.now();
  return {
    name: c.name, relay: c.relay, machineId: c.machineId,
    friends: Object.entries(c.peers).map(([m, p]) => {
      const st = states[m];
      return {
        name: st?.name || p.name, machineId: m, since: p.since,
        online: !!st && now - st.seen < 90_000, lastSeen: st?.seen || null,
        agents: st?.agents?.length || 0, sharingWithYou: st?.shares?.length || 0,
      };
    }),
  };
}

function findFriend(c, query) {
  const q = String(query || '').toLowerCase().trim();
  const hit = Object.entries(c.peers).find(([m, p]) => m === q || p.name.toLowerCase() === q)
    || Object.entries(c.peers).find(([, p]) => p.name.toLowerCase().startsWith(q));
  if (!hit) throw new Error(`no friend matches "${query}"`);
  return hit;
}

// Forget a friend: their agents leave the canvas, every link with them goes, and anything they still send is ignored.
export function unfriend(query) {
  const c = config();
  const [m, p] = findFriend(c, query);
  forget(m, { block: true });
  return { removed: p.name };
}

// Drop everything about one friend's machine. Blocking also ignores whatever they still send;
// a revoked request does not block, so trusting each other again and a new request can pair again.
function forget(m, { block }) {
  const c = config();
  delete c.peers[m];
  if (block && !c.blocked.includes(m)) c.blocked.push(m);
  saveConfig(c);
  const prefix = remoteId(m, '');
  writeJSON(FILES.edges, readJSON(FILES.edges, []).filter((e) => !e.from.startsWith(prefix) && !e.to.startsWith(prefix)));
  const states = readJSON(FILES.peerState, {});
  delete states[m];
  writeJSON(FILES.peerState, states);
  const sent = readJSON(SENT, {});
  for (const k of Object.keys(sent)) if (k.startsWith(`${m}:`)) delete sent[k];
  writeJSON(SENT, sent);
  fs.rmSync(path.join(REMOTE_DIR, m), { recursive: true, force: true });
  const out = readJSON(OUTBOX, []);
  writeJSON(OUTBOX, out.filter((o) => o.to !== m));
}

// The friend's side of a link was removed on our canvas: ask its owner to stop sharing.
export function queueDrop(edge) {
  const prefix = remoteId(edge.remote, '');
  const out = readJSON(OUTBOX, []);
  out.push({ to: edge.remote, item: { type: 'drop', agent: edge.from.slice(prefix.length), target: edge.to } });
  writeJSON(OUTBOX, out.slice(-200));
}

// ---------------------------------------------------------------- sync

// One sync at a time per machine: the canvas server, prompt hooks and the CLI all call this.
function lock() {
  try {
    const fd = fs.openSync(LOCK, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
    return true;
  } catch {
    try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 20_000) { fs.rmSync(LOCK, { force: true }); return lock(); } } catch {}
    return false;
  }
}
const unlock = () => fs.rmSync(LOCK, { force: true });

let running = null;
export function sync(opts = {}) {
  if (!running) running = doSync(opts).finally(() => { running = null; });
  return running;
}

async function doSync({ timeout = 8000 } = {}) {
  if (!isConnected()) return { skipped: 'no friends yet' };
  if (!lock()) return { skipped: 'another sync is running' };
  try {
    const pulled = await pull(config(), timeout);
    const pushed = await push(config(), timeout);
    return { pulled, pushed };
  } finally { unlock(); }
}

// ---- receiving

const ROLES = new Set(['user', 'assistant']);
function cleanAgents(list) {
  return (Array.isArray(list) ? list : []).slice(0, 200).filter((a) => a && typeof a.id === 'string').map((a) => ({
    id: clean(a.id, 120), name: clean(a.name, 48) || 'agent', kind: KINDS.includes(a.kind) ? a.kind : 'agent',
    status: a.status === 'busy' || a.status === 'closed' ? a.status : 'idle', project: clean(a.project, 60) || 'project',
    startedAt: Number(a.startedAt) || null,
  }));
}
function cleanShares(list) {
  return (Array.isArray(list) ? list : []).slice(0, 500).filter((s) => s && typeof s.from === 'string' && typeof s.to === 'string')
    .map((s) => ({ from: clean(s.from, 120), to: clean(s.to, 160), fromName: clean(s.fromName, 48), ...(s.mode === 'talk' ? { mode: 'talk' } : {}) }));
}

// The links a friend has drawn from their agents to ours live in our edges.json too ("mirrored"),
// so the hook, synapse_read and the canvas treat them like any other link.
function mirror(m, shares, owner) {
  const edges = readJSON(FILES.edges, []);
  const before = edges.filter((e) => e.mirrored && e.remote === m);
  const locals = new Map(localAgents().map((a) => [a.id, a]));
  const next = shares.map((s) => {
    const id = `m-${sha(`${m}|${s.from}|${s.to}`).slice(0, 16)}`;
    const old = before.find((e) => e.id === id);
    return {
      id, from: remoteId(m, s.from), to: s.to, fromName: s.fromName, toName: locals.get(s.to)?.name || old?.toName || s.to,
      ...(s.mode ? { mode: s.mode } : {}), fromKind: old?.fromKind, toKind: locals.get(s.to)?.kind, mirrored: true, remote: m, owner, createdAt: old?.createdAt || Date.now(),
    };
  });
  const same = before.length === next.length && before.every((e) => next.some((x) => x.id === e.id && x.fromName === e.fromName && x.owner === e.owner && x.mode === e.mode));
  if (same) return;
  writeJSON(FILES.edges, [...edges.filter((e) => !(e.mirrored && e.remote === m)), ...next]);
  const gone = before.filter((e) => !next.some((x) => x.id === e.id));
  if (gone.length) {
    const cursors = readJSON(FILES.cursors, {});
    for (const e of gone) delete cursors[e.id];
    writeJSON(FILES.cursors, cursors);
  }
  for (const e of next) if (!before.some((x) => x.id === e.id)) logEvent({ type: 'shared', edge: e.id, from: e.from, to: e.to, owner });
}

function appendLog(m, agentId, messages) {
  const file = remoteLog(m, agentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const keysFile = `${file}.keys`;
  const keys = new Set(readJSON(keysFile, []));
  const fresh = [];
  for (const x of Array.isArray(messages) ? messages : []) {
    if (!x || !ROLES.has(x.role) || typeof x.text !== 'string') continue;
    const msg = { role: x.role, text: x.text.slice(0, MSG_CHARS * 2), ts: clean(x.ts, 40) || null, tool: !!x.tool };
    const k = sha(`${msg.ts}|${msg.role}|${msg.text}`).slice(0, 16);
    if (keys.has(k)) continue;
    keys.add(k); fresh.push(msg);
  }
  if (!fresh.length) return 0;
  fs.appendFileSync(file, fresh.map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeJSON(keysFile, [...keys].slice(-5000));
  return fresh.length;
}

async function pull(c, timeout) {
  const { items } = await call(c.relay, '/v1/poll', {}, c.token, timeout);
  if (!items?.length) return 0;
  const states = readJSON(FILES.peerState, {});
  let cfgChanged = false;
  const revoked = new Set();
  for (const it of items) {
    // a synapse request was answered (from the cloud, not from a friend's machine)
    if (it.type === 'request' && typeof it.id === 'string') { noteRequest(it); continue; }
    // trust ended: the cloud tells both machines to drop the pairing (friends cannot send this, it carries no pair)
    if (it.type === 'revoked' && !it.pair) {
      if (typeof it.id === 'string') noteRequest({ id: it.id, status: 'revoked' });
      const m = clean(it.machine, 40);
      if (m) {
        if (c.peers[m]) logEvent({ type: 'friend-revoked', name: c.peers[m].name });
        delete c.peers[m];
        delete states[m];
        revoked.add(m);
        forget(m, { block: false });
      }
      continue;
    }
    const m = it.from;
    if (!m || c.blocked.includes(m) || revoked.has(m)) continue;
    if (!c.peers[m]) {
      // a friend who joined our invite, or who accepted our request: the cloud vouches for the pairing token it carries
      if (!it.pair) continue;
      c.peers[m] = { name: clean(it.name, 40) || 'friend', pair: it.pair, ...(it.type === 'paired' && it.via === 'request' ? { via: 'request' } : {}), since: Date.now() };
      if (it.type === 'paired' && clean(it.handle, 24)) c.peers[m].handle = clean(it.handle, 24);
      cfgChanged = true;
      logEvent({ type: 'friend', name: c.peers[m].name });
    } else if (it.type === 'paired' && it.via === 'request' && c.peers[m].via !== 'request') {
      c.peers[m].via = 'request';
      cfgChanged = true;
    }
    if (it.type === 'paired' && clean(it.handle, 24) && c.peers[m].handle !== clean(it.handle, 24)) {
      c.peers[m].handle = clean(it.handle, 24);
      cfgChanged = true;
    }
    if (it.type === 'state') {
      const name = clean(it.name, 40) || c.peers[m].name;
      if (name !== c.peers[m].name) { c.peers[m].name = name; cfgChanged = true; }
      const shares = cleanShares(it.shares);
      states[m] = { name, agents: cleanAgents(it.agents), shares, seen: Date.now() };
      mirror(m, shares, name);
    } else if (it.type === 'context' && typeof it.agent === 'string') {
      const n = appendLog(m, it.agent, it.messages);
      if (n) {
        const from = remoteId(m, it.agent);
        for (const e of readJSON(FILES.edges, []).filter((x) => x.from === from)) {
          logEvent({ type: 'remote-context', edge: e.id, from, to: e.to, owner: c.peers[m].name, count: n });
        }
      }
    } else if (it.type === 'drop' && typeof it.agent === 'string') {
      // they removed the link on their side: stop sharing that agent with that agent of theirs
      const target = remoteId(m, String(it.target || ''));
      writeJSON(FILES.edges, readJSON(FILES.edges, []).filter((e) => !(e.from === it.agent && e.to === target && !e.mirrored)));
    }
  }
  if (cfgChanged) {
    const latest = config();
    for (const [m, p] of Object.entries(c.peers)) if (!latest.blocked.includes(m) && !revoked.has(m)) latest.peers[m] = { ...latest.peers[m], ...p };
    saveConfig(latest);
  }
  writeJSON(FILES.peerState, states);
  return items.length;
}

// ---- sending

function noteRequest(it) {
  const status = clean(it.status, 20);
  logEvent({ type: 'request', id: it.id, status, shared: Array.isArray(it.shared) ? it.shared.map((a) => clean(a?.name, 48)) : [] });
  const cache = readJSON(FILES.requests, null);
  if (!cache) return;
  for (const r of [...(cache.incoming || []), ...(cache.outgoing || [])]) {
    if (r.id === it.id) { r.status = status; if (Array.isArray(it.shared)) r.shared = it.shared; r.decidedAt = Date.now(); }
  }
  cache.stale = true;
  writeJSON(FILES.requests, cache);
}

function pack(messages) {
  const out = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0 && out.length < PUSH_MSGS; i--) {
    const m = messages[i];
    const text = m.text.length > MSG_CHARS ? `${m.text.slice(0, MSG_CHARS)}…` : m.text;
    if (used + text.length > PUSH_CHARS && out.length) break;
    out.push({ role: m.role, text, ts: m.ts || null, tool: !!m.tool });
    used += text.length;
  }
  return out.reverse();
}

// While a talk source is live, keep its snapshot current so the answer can come from it after it closes.
function refreshSnapshots(edges, byId) {
  let changed = false;
  for (const e of edges) {
    const a = e.mode === 'talk' && !e.mirrored && byId.get(e.from);
    if (!a || e.snapshot?.transcript === a.transcript) continue;
    e.snapshot = { kind: a.kind, name: a.name, cwd: a.cwd, transcript: a.transcript, format: a.format };
    changed = true;
  }
  if (changed) writeJSON(FILES.edges, edges);
}

async function push(c, timeout) {
  const locals = localAgents();
  const byId = new Map(locals.map((a) => [a.id, a]));
  const edges = readJSON(FILES.edges, []);
  refreshSnapshots(edges, byId);
  const sent = readJSON(SENT, {});
  let outbox = readJSON(OUTBOX, []);
  const now = Date.now();
  const brief = locals.map((a) => ({ id: a.id, name: a.name, kind: a.kind, status: a.status, project: projectOf(a.cwd).label, startedAt: a.startedAt }));
  let count = 0;

  for (const [m, peer] of Object.entries(c.peers)) {
    const prefix = remoteId(m, '');
    // a talk edge outlives its session: the friend still sees the agent (closed) and can ask it
    const shares = edges.filter((e) => !e.mirrored && e.to.startsWith(prefix) && (byId.has(e.from) || (e.mode === 'talk' && e.snapshot)))
      .map((e) => (byId.has(e.from)
        ? { from: e.from, to: e.to.slice(prefix.length), fromName: byId.get(e.from).name, ...(e.mode === 'talk' ? { mode: 'talk' } : {}) }
        : { from: e.from, to: e.to.slice(prefix.length), fromName: e.snapshot.name, mode: 'talk', dormant: true }));
    const items = [];
    const marks = {};
    const sharedFrom = [...new Set(shares.map((s) => s.from))];

    // A friend from an invite code sees which agents run here, so links can be drawn either way.
    // A friend from a request sees only what is shared with them and their own agents' counterparts here.
    let agents = brief;
    if (peer.via === 'request') {
      const theirs = new Set(edges.filter((e) => e.mirrored && e.remote === m).map((e) => e.to));
      agents = brief.filter((a) => sharedFrom.includes(a.id) || theirs.has(a.id));
    }
    for (const e of edges) {
      if (e.mirrored || !e.to.startsWith(prefix) || byId.has(e.from) || e.mode !== 'talk' || !e.snapshot) continue;
      if (agents.some((a) => a.id === e.from)) continue;
      agents = [...agents, { id: e.from, name: e.snapshot.name, kind: e.snapshot.kind, status: 'closed', project: projectOf(e.snapshot.cwd).label, startedAt: null }];
    }
    const sig = sha(JSON.stringify([c.name, agents.map((a) => [a.id, a.name, a.status, a.project]), shares]));
    const last = sent[`state:${m}`];
    if (!last || last.sig !== sig || now - last.t > HEARTBEAT) {
      items.push({ type: 'state', name: c.name, agents, shares });
      marks[`state:${m}`] = { sig, t: now };
    }

    for (const from of sharedFrom.filter((x) => byId.has(x))) {
      const a = byId.get(from), key = `${m}:${from}`;
      if (!a.transcript) continue;
      const { messages, end } = readAgentMessages(a, sent[key]?.cursor ?? null, { tailBytes: 300_000, minMessages: 6 });
      if (messages.length) items.push({ type: 'context', agent: from, messages: pack(messages) });
      if (end != null && end !== sent[key]?.cursor) marks[key] = { cursor: end };
    }
    // stop tracking agents we no longer share, so sharing again starts from their recent context
    for (const k of Object.keys(sent)) if (k.startsWith(`${m}:`) && !sharedFrom.includes(k.slice(m.length + 1))) delete sent[k];

    const queued = outbox.filter((o) => o.to === m);
    items.push(...queued.map((o) => o.item));
    if (!items.length) { Object.assign(sent, marks); continue; }
    try {
      await call(c.relay, '/v1/send', { to: m, pair: peer.pair, items }, c.token, timeout);
      Object.assign(sent, marks);
      outbox = outbox.filter((o) => !queued.includes(o));
      count += items.length;
    } catch (e) {
      if (e.status === 403) outbox = outbox.filter((o) => !queued.includes(o)); // pairing no longer valid: nothing will get through
    }
  }
  writeJSON(SENT, sent);
  writeJSON(OUTBOX, outbox);
  return count;
}
