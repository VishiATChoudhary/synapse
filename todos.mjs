// Todos: a list the user and their agents share. A todo can be linked to the agent working on it; when that agent
// ends, the app asks whether its open todos are done. Agents add, change and remove todos (MCP synapse_todo_*,
// CLI "synapse todo"). With Linear connected (a personal API key), issues assigned to you come in as todos, and
// marking one done or open again moves the issue too; any todo can be sent to Linear.
// Todos live in ~/.synapse/todos.json, the Linear key in ~/.synapse/linear.json (readable by you only).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, readJSON, writeJSON, listAgents, findAgent } from './lib.mjs';

export const FILE = path.join(DATA, 'todos.json');
const LINEAR_FILE = path.join(DATA, 'linear.json');
const LINEAR_URL = () => process.env.SYNAPSE_LINEAR_URL || 'https://api.linear.app/graphql';
const MAX = 2000;

export const all = () => readJSON(FILE, []);
const save = (todos) => writeJSON(FILE, todos.slice(-MAX));
const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);

function find(todos, id) {
  const q = String(id ?? '').trim();
  const t = todos.find((x) => x.id === q) || todos.find((x) => q && (x.id.startsWith(q) || x.linear?.identifier?.toLowerCase() === q.toLowerCase()));
  if (!t) throw new Error(`No todo "${id}". synapse_todos lists them with their ids.`);
  return t;
}

// an agent to link to: its id and name, as the app shows it (a name, part of one, or an id)
function agentRef(query) {
  if (query == null || query === '' || query === 'none') return null;
  if (typeof query === 'object') return query.id ? { id: String(query.id), name: String(query.name || query.id) } : null;
  const a = findAgent(listAgents(), String(query));
  if (!a) throw new Error(`No live agent matches "${query}". synapse_peers all=true lists them.`);
  if (a.remote) throw new Error(`${a.name} runs on ${a.remote.owner}'s machine; todos link to agents on this machine.`);
  return { id: a.id, name: a.name };
}

// what an agent sees of a todo
export const show = (t) => ({ id: t.id, todo: t.text, done: t.done, ...(t.agent ? { agent: t.agent.name } : {}), ...(t.linear ? { linear: t.linear.identifier, url: t.linear.url } : {}), by: t.by });

export function list({ agent, done } = {}) {
  let todos = all();
  if (agent) { const id = typeof agent === 'object' ? agent.id : agent; todos = todos.filter((t) => t.agent?.id === id); }
  if (done !== undefined && done !== null) todos = todos.filter((t) => t.done === !!done);
  return todos;
}

export async function add({ text, agent, by = 'you', linear = false }) {
  const body = clean(text);
  if (!body) throw new Error('A todo needs some text.');
  const todos = all(), now = Date.now();
  const t = { id: crypto.randomBytes(4).toString('hex'), text: body, done: false, agent: agentRef(agent), by: String(by || 'you').slice(0, 80), createdAt: now, updatedAt: now };
  todos.push(t); save(todos);
  if (linear) return toLinear(t.id);
  return t;
}

// change: text, done, agent (a name/id, or null/"none" to unlink); done syncs to Linear for a linked issue
export async function update(id, change = {}) {
  const todos = all(), t = find(todos, id), now = Date.now();
  if (change.text !== undefined) { const body = clean(change.text); if (!body) throw new Error('A todo needs some text.'); t.text = body; }
  if (change.agent !== undefined) t.agent = agentRef(change.agent);
  const flips = change.done !== undefined && !!change.done !== t.done;
  if (change.done !== undefined) { t.done = !!change.done; t.doneAt = t.done ? now : undefined; }
  if (change.asked !== undefined) t.asked = !!change.asked;
  t.updatedAt = now; save(todos);
  if (flips && t.linear && linearKey()) {
    try { await moveIssue(t.linear, t.done); } catch (e) { return { ...t, warning: `Saved here, but Linear did not take it: ${e.message}` }; }
  }
  return t;
}

export function remove(id) {
  const todos = all(), t = find(todos, id);
  save(todos.filter((x) => x !== t));
  return t;
}

// ---------------------------------------------------------------- Linear

export const linearKey = () => readJSON(LINEAR_FILE, null)?.key || null;
export function linearStatus() {
  const l = readJSON(LINEAR_FILE, null);
  return l?.key ? { connected: true, name: l.name || '', team: l.team || null, teams: l.teams || [], syncedAt: l.syncedAt || 0, error: l.error || '' } : { connected: false };
}

async function gql(query, variables = {}, key = linearKey()) {
  if (!key) throw new Error('Linear is not connected.');
  const res = await fetch(LINEAR_URL(), { method: 'POST', headers: { 'content-type': 'application/json', authorization: key }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new Error('Linear did not accept the API key.');
  if (body.errors?.length) throw new Error(body.errors[0].message || 'Linear returned an error.');
  if (!res.ok) throw new Error(`Linear answered ${res.status}.`);
  return body.data;
}

export async function connectLinear(key) {
  const k = String(key || '').trim();
  if (!k) throw new Error('Paste a Linear API key.');
  const d = await gql('query { viewer { id name } teams(first: 50) { nodes { id name key } } }', {}, k);
  const teams = d.teams.nodes.map((t) => ({ id: t.id, name: t.name, key: t.key }));
  fs.writeFileSync(LINEAR_FILE, JSON.stringify({ key: k, viewer: d.viewer.id, name: d.viewer.name, teams, team: teams[0]?.id || null }, null, 2), { mode: 0o600 });
  fs.chmodSync(LINEAR_FILE, 0o600);
  return linearStatus();
}
export function disconnectLinear() { try { fs.unlinkSync(LINEAR_FILE); } catch {} return { connected: false }; }
export function setLinearTeam(team) {
  const l = readJSON(LINEAR_FILE, null);
  if (!l?.key) throw new Error('Linear is not connected.');
  if (!l.teams?.some((t) => t.id === team)) throw new Error('No such team.');
  l.team = team; fs.writeFileSync(LINEAR_FILE, JSON.stringify(l, null, 2), { mode: 0o600 });
  return linearStatus();
}
const noteLinear = (fields) => { const l = readJSON(LINEAR_FILE, null); if (l?.key) fs.writeFileSync(LINEAR_FILE, JSON.stringify({ ...l, ...fields }, null, 2), { mode: 0o600 }); };

const stateCache = new Map(); // team -> its workflow states
async function teamStates(team) {
  if (!stateCache.has(team)) {
    const d = await gql('query($id: String!) { team(id: $id) { states { nodes { id type position } } } }', { id: team });
    stateCache.set(team, d.team.states.nodes);
  }
  return stateCache.get(team);
}
async function moveIssue(link, done) {
  const states = (await teamStates(link.team)).slice().sort((a, b) => a.position - b.position);
  const to = done ? states.find((s) => s.type === 'completed') : states.find((s) => s.type === 'unstarted') || states.find((s) => s.type === 'backlog');
  if (!to) throw new Error(`Its team has no ${done ? 'completed' : 'open'} state.`);
  const d = await gql('mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }', { id: link.id, state: to.id });
  if (!d.issueUpdate.success) throw new Error('Linear did not update the issue.');
}

// a todo becomes a Linear issue, assigned to you, in your chosen team
export async function toLinear(id) {
  const l = readJSON(LINEAR_FILE, null);
  if (!l?.key) throw new Error('Linear is not connected. Connect it on the Todos page in Synapse.');
  let t = find(all(), id);
  if (t.linear) return t;
  if (!l.team) throw new Error('Pick a Linear team on the Todos page first.');
  const d = await gql('mutation($team: String!, $title: String!, $me: String) { issueCreate(input: { teamId: $team, title: $title, assigneeId: $me }) { success issue { id identifier url team { id } } } }', { team: l.team, title: t.text, me: l.viewer || null });
  if (!d.issueCreate.success) throw new Error('Linear did not create the issue.');
  const i = d.issueCreate.issue, todos = all();
  t = find(todos, id);
  t.linear = { id: i.id, identifier: i.identifier, url: i.url, team: i.team.id }; t.updatedAt = Date.now();
  save(todos);
  if (t.done) await moveIssue(t.linear, true).catch(() => {});
  return t;
}

// Pull: open issues assigned to you come in as todos; issues of todos here that were finished (or reopened) in
// Linear follow. Titles follow Linear. Returns what changed.
export async function syncLinear() {
  if (!linearKey()) return { connected: false };
  try {
    const d = await gql('query { viewer { assignedIssues(first: 100, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id identifier title url team { id } } } } }');
    const open = d.viewer.assignedIssues.nodes;
    const todos = all(), byIssue = new Map(todos.filter((t) => t.linear).map((t) => [t.linear.id, t]));
    let added = 0, changed = 0;
    const now = Date.now();
    for (const i of open) {
      const t = byIssue.get(i.id);
      if (!t) { todos.push({ id: crypto.randomBytes(4).toString('hex'), text: clean(i.title), done: false, agent: null, by: 'Linear', createdAt: now, updatedAt: now, linear: { id: i.id, identifier: i.identifier, url: i.url, team: i.team.id } }); added++; continue; }
      if (t.text !== clean(i.title)) { t.text = clean(i.title); changed++; }
      // open in Linear but done here: reopened there (a todo finished here was moved there when it was ticked)
      if (t.done && (t.doneAt || 0) < now - 60_000) { t.done = false; t.doneAt = undefined; changed++; }
    }
    // linked todos still open here whose issue is no longer open (finished or canceled there): done
    const openIds = new Set(open.map((i) => i.id)), gone = todos.filter((t) => t.linear && !t.done && !openIds.has(t.linear.id));
    if (gone.length) {
      const q = await gql('query($ids: [ID!]) { issues(first: 100, filter: { id: { in: $ids } }) { nodes { id title state { type } } } }', { ids: gone.map((t) => t.linear.id) });
      const state = new Map(q.issues.nodes.map((i) => [i.id, i]));
      for (const t of gone) {
        const i = state.get(t.linear.id);
        if (i && ['completed', 'canceled'].includes(i.state.type)) { t.done = true; t.doneAt = now; changed++; }
      }
    }
    if (added || changed) save(todos);
    noteLinear({ syncedAt: now, error: '' });
    return { connected: true, added, changed };
  } catch (e) {
    noteLinear({ error: e.message });
    throw e;
  }
}
