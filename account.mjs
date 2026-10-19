// Synapse Cloud account: sign-in, profile, trusted people and synapse requests.
// The app, the CLI and the MCP server share one sign-in in ~/.synapse/account.json.
import fs from 'node:fs';
import os from 'node:os';
import { FILES, readJSON, writeJSON, localAgents, findAgent, projectOf, remoteId, logEvent } from './lib.mjs';
import { createEdge, setMode } from './ops.mjs';
import * as remote from './remote.mjs';

export const DEFAULT_CLOUD = 'https://app.heysynapse.dev';
const NOT_SIGNED_IN = 'Not signed in to Synapse. Ask the user to sign in in the Synapse app or run: synapse login';

export function account() {
  const a = readJSON(FILES.account, null);
  return a?.token ? a : null;
}
export const cloudUrl = () => (process.env.SYNAPSE_CLOUD || account()?.cloud || readJSON(FILES.account, {})?.cloud || DEFAULT_CLOUD).replace(/\/+$/, '');

function save(a) {
  writeJSON(FILES.account, a);
  try { fs.chmodSync(FILES.account, 0o600); } catch {}
}
const client = () => (process.versions.electron ? 'app' : 'cli');
const defaultLabel = () => os.hostname().replace(/\.local$/, '');

async function api(method, route, body, { auth = true, timeout = 10000 } = {}) {
  const a = account();
  if (auth && !a) throw new Error(NOT_SIGNED_IN);
  let r;
  try {
    r = await fetch(cloudUrl() + route, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: `Bearer ${a.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch { throw new Error(`could not reach Synapse Cloud at ${cloudUrl()}`); }
  const out = await r.json().catch(() => ({}));
  if (r.status === 401 && auth) throw new Error('Your Synapse sign-in expired. Sign in again (synapse login or the app).');
  if (!r.ok) { const e = new Error(out.error || `Synapse Cloud answered ${r.status}`); e.status = r.status; throw e; }
  return out;
}

// a fresh sign-in: keep the token, show friends the account's name
function signedIn({ token, user }) {
  save({ cloud: cloudUrl(), token, user });
  remote.setName(user.name || user.handle);
  return { user };
}

export async function signup({ email, password, name, label } = {}) {
  return signedIn(await api('POST', '/v1/auth/signup', { email, password, name, client: client(), label: label || defaultLabel() }, { auth: false }));
}
export async function login({ email, password, label } = {}) {
  return signedIn(await api('POST', '/v1/auth/login', { email, password, client: client(), label: label || defaultLabel() }, { auth: false }));
}
export async function logout() {
  if (account()) await api('POST', '/v1/auth/logout', {}, { timeout: 4000 }).catch(() => {});
  fs.rmSync(FILES.account, { force: true });
  fs.rmSync(FILES.requests, { force: true });
  return { ok: true };
}

export const providers = () => api('GET', '/v1/auth/providers', null, { auth: false });

export const deviceStart = (label) => api('POST', '/v1/device/start', { label: label || defaultLabel() }, { auth: false })
  .then((d) => ({ ...d, url: /^https?:/.test(d.url) ? d.url : cloudUrl() + d.url }));
export async function devicePoll(deviceCode) {
  const r = await api('POST', '/v1/device/poll', { deviceCode }, { auth: false });
  if (r.status !== 'approved') return { status: 'pending' };
  return { status: 'approved', ...signedIn(r) };
}

export async function me() {
  const { user } = await api('GET', '/v1/me');
  save({ ...account(), user });
  return user;
}
export async function updateMe(patch) {
  const { user } = await api('PATCH', '/v1/me', patch);
  save({ ...account(), user });
  return user;
}
export const changePassword = ({ current, password }) => api('POST', '/v1/me/password', { current, password });
export const forgot = (email) => api('POST', '/v1/auth/forgot', { email }, { auth: false });
export const resendVerification = () => api('POST', '/v1/auth/resend-verification', {});

export const trusted = () => api('GET', '/v1/trusted').then((r) => r.trusted);
export const trust = (who) => api('POST', '/v1/trusted', { who }).then((r) => r.person);
export const incomingTrust = () => api('GET', '/v1/trusted/incoming').then((r) => r.incoming);
export const dismissTrust = (id) => api('POST', `/v1/trusted/incoming/${encodeURIComponent(id)}/dismiss`, {}).then(async (r) => { await requests().catch(() => {}); return r; });
export async function untrust(id) {
  // an id, or a handle / email / name from the list
  const q = String(id || '').replace(/^@/, '').toLowerCase();
  const hit = (await trusted()).find((p) => p.id === id || [p.handle, p.email, p.name].some((v) => v && v.toLowerCase() === q));
  if (!hit) throw new Error(`no trusted person matches "${id}"`);
  const out = await api('DELETE', `/v1/trusted/${encodeURIComponent(hit.id)}`);
  await remote.sync().catch(() => {}); // the cloud revoked what was shared between you: drop it now, not on the next sync
  return out;
}

// Synapse requests, plus the people who added you and you have not trusted back (incomingTrust), cached for
// the app and the agents. An older cloud without the incoming route keeps whatever the mailbox told us.
export async function requests() {
  const [{ incoming = [], outgoing = [] }, incomingTrust] = await Promise.all([
    api('GET', '/v1/requests'),
    api('GET', '/v1/trusted/incoming').then((r) => r.incoming || [], () => readJSON(FILES.requests, {})?.incomingTrust || []),
  ]);
  writeJSON(FILES.requests, { incoming, outgoing, incomingTrust, t: Date.now() });
  return { incoming, outgoing, incomingTrust };
}

const agentBrief = (a) => ({ id: a.id, name: a.name, kind: a.kind, project: a.cwd ? projectOf(a.cwd).label : 'project' });

export async function sendRequest({ to, agent, target, note } = {}) {
  if (!agent?.id) throw new Error('which agent is asking? (no agent given)');
  const c = await remote.cloudMachine(cloudUrl(), account()?.token);
  const { request } = await api('POST', '/v1/requests', { to, machineId: c.machineId, agent: agentBrief(agent), target, note });
  await requests().catch(() => {});
  return request;
}

async function incoming(id) {
  const { incoming: list } = await requests();
  const r = list.find((x) => x.id === id || x.id.startsWith(id));
  if (!r) throw new Error(`no incoming request ${id}`);
  return r;
}

// Which of my agents to share: the ones asked for, else the best match for the requester's hint.
function pickAgents(req, ids) {
  const mine = localAgents();
  if (ids?.length) {
    return ids.map((q) => {
      const a = mine.find((x) => x.id === q) || findAgent(mine, q);
      if (!a) throw new Error(`no local agent matches "${q}"`);
      return a;
    });
  }
  const hint = String(req.target || '').toLowerCase();
  const words = hint.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && w !== 'agent');
  const score = (a) => words.filter((w) => `${a.name} ${a.cwd ? projectOf(a.cwd).label : ''}`.toLowerCase().includes(w)).length;
  const best = mine.map((a) => [score(a), a]).filter(([s]) => s > 0).sort((x, y) => y[0] - x[0]);
  if (best.length) return [best[0][1]];
  if (mine.length === 1) return mine;
  throw new Error(`say which agents to share: ${mine.map((a) => a.name).join(', ') || '(no agents running)'}`);
}

// talk: their agent may also ask the shared agents questions (a tool-less fork answers). Only the shares this
// accept makes are switched, never another share with the same friend.
export async function accept(id, agentIds = [], { talk = true } = {}) {
  const req = await incoming(id);
  if (req.status !== 'pending') throw new Error(`this request is already ${req.status}`);
  const chosen = pickAgents(req, agentIds);
  const c = await remote.cloudMachine(cloudUrl(), account()?.token);
  const out = await api('POST', `/v1/requests/${encodeURIComponent(req.id)}/accept`, { machineId: c.machineId, agents: chosen.map(agentBrief) });
  const m = out.peer?.machineId || req.fromMachine;
  const owner = out.peer?.name || req.from?.name || req.from?.handle || 'friend';
  remote.addPeer(m, { name: owner, pair: out.pair, handle: req.from?.handle });
  // share each chosen agent with the agent that asked; the next sync ships their context
  const asker = { id: remoteId(m, req.agent.id), name: req.agent.name, kind: req.agent.kind, remote: { machine: m, owner, agentId: req.agent.id, project: req.agent.project } };
  const made = chosen.map((a) => createEdge(a, asker).edge);
  if (talk) for (const e of made) { try { setMode(e.id, 'talk'); } catch {} }
  logEvent({ type: 'request-accepted', id: req.id, from: owner, shared: chosen.map((a) => a.name), talk: !!talk });
  await remote.sync().catch(() => {});
  await requests().catch(() => {});
  return out.request || req;
}

export async function deny(id) {
  const req = await incoming(id);
  const { request } = await api('POST', `/v1/requests/${encodeURIComponent(req.id)}/deny`, {});
  await requests().catch(() => {});
  return request;
}
export async function cancel(id) {
  const { outgoing } = await requests();
  const req = outgoing.find((x) => x.id === id || x.id.startsWith(id));
  if (!req) throw new Error(`no outgoing request ${id}`);
  const { request } = await api('POST', `/v1/requests/${encodeURIComponent(req.id)}/cancel`, {});
  await requests().catch(() => {});
  return request;
}

// Links that cross machines: theirs shared with me ('in') and mine shared with them ('out').
export function externalLinks() {
  const cfg = remote.config(), states = readJSON(FILES.peerState, {});
  const ownerOf = (m) => states[m]?.name || cfg.peers[m]?.name || 'friend';
  const machines = Object.keys(cfg.peers);
  const kindIn = (m, id) => states[m]?.agents?.find((a) => remoteId(m, a.id) === id)?.kind;
  const out = [];
  for (const e of readJSON(FILES.edges, [])) {
    if (e.mirrored) {
      out.push({ direction: 'in', owner: e.owner || ownerOf(e.remote), agent: { id: e.from, name: e.fromName, kind: e.fromKind || kindIn(e.remote, e.from) }, local: { id: e.to, name: e.toName }, edgeId: e.id });
      continue;
    }
    const m = machines.find((x) => e.to.startsWith(remoteId(x, '')));
    if (m) out.push({ direction: 'out', owner: ownerOf(m), agent: { id: e.to, name: e.toName, kind: e.toKind || kindIn(m, e.to) }, local: { id: e.from, name: e.fromName }, edgeId: e.id });
  }
  return out;
}
