// Shared plans: agents of any kind (Claude, Codex, Gemini, ...) work out a plan together. One agent starts a plan
// with a goal and the agents it wants on it; they are linked with each other, and every change (a note, a task
// added, claimed or done) goes to the other members as a message, so each sees it on its next prompt. In the
// Synapse app an idle member is woken by that message (renderer: wakeAgents), so a plan moves on by itself.
// Plans live in ~/.synapse/plans.json.
import crypto from 'node:crypto';
import { FILES, readJSON, writeJSON, listAgents, findAgent, postMessage } from './lib.mjs';
import { createEdge } from './ops.mjs';

const MAX_PLANS = 100, MAX_NOTES = 200;
const load = () => readJSON(FILES.plans, []);
const save = (plans) => writeJSON(FILES.plans, plans.slice(-MAX_PLANS));
const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function resolve(agents, query) {
  const a = findAgent(agents, query);
  if (!a) throw new Error(`No live agent matches "${query}". Run "peers --all" (synapse_peers all=true) to see every agent.`);
  if (a.remote) throw new Error(`${a.name} runs on ${a.remote.owner}'s machine. Plans are for agents on this machine.`);
  return a;
}

// the plan to act on: by id (or its first characters); with none given, the one I last touched
function find(plans, me, id) {
  const mine = plans.filter((p) => p.members.some((m) => m.id === me.id));
  if (id) {
    const p = mine.find((x) => x.id === id || x.id.startsWith(String(id)));
    if (!p) throw new Error(`You are not on a plan "${id}". synapse_plan lists yours.`);
    return p;
  }
  const p = mine.filter((x) => x.status !== 'closed').sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!p) throw new Error('You are not on any open plan. Start one with synapse_plan_start.');
  return p;
}

// what an agent sees of a plan
export function show(p) {
  return {
    id: p.id, goal: p.goal, status: p.status, startedBy: p.startedBy.name,
    members: p.members.map((m) => `${m.name} (${m.kind})`),
    tasks: p.tasks.map((t) => ({ n: t.n, task: t.text, status: t.status, ...(t.owner ? { owner: t.owner.name } : {}) })),
    notes: p.notes.slice(-30).map((n) => `${n.by}: ${n.text}`),
  };
}

const HOW = 'Plan together: share your ideas, concerns and questions with synapse_plan_update note=..., split the work into tasks ' +
  '(add_tasks), claim the ones you will do (claim), and mark them done (done). Every change reaches the other members. ' +
  'Agree on the plan before anyone starts editing shared files.';

// tell the other members what changed
function broadcast(p, me, text) {
  const agents = new Map(listAgents().map((a) => [a.id, a]));
  for (const m of p.members) {
    if (m.id === me.id) continue;
    const to = agents.get(m.id) || m;
    postMessage(me, to, `[plan ${p.id.slice(0, 8)}: ${clip(p.goal, 80)}] ${text}`);
  }
}

export function start(me, { goal, agents: queries = [], tasks = [] }) {
  goal = String(goal || '').trim();
  if (!goal) throw new Error('A plan needs a goal.');
  const all = listAgents();
  const others = [...new Map(queries.map((q) => resolve(all, q)).filter((a) => a.id !== me.id).map((a) => [a.id, a])).values()];
  if (!others.length) throw new Error('Name at least one other agent to plan with (synapse_peers all=true lists them).');
  for (const o of others) { createEdge(me, o); createEdge(o, me); }
  const member = (a) => ({ id: a.id, name: a.name, kind: a.kind });
  const now = Date.now();
  const p = {
    id: crypto.randomUUID(), goal, status: 'open', startedBy: member(me), members: [member(me), ...others.map(member)],
    tasks: [], notes: [], createdAt: now, updatedAt: now,
  };
  for (const t of tasks) addTask(p, me, t);
  const plans = load(); plans.push(p); save(plans);
  broadcast(p, me, `${me.name} started a plan with ${others.map((o) => o.name).join(', ')}.\n` +
    `Goal: ${goal}\n${p.tasks.length ? `Tasks so far:\n${p.tasks.map((t) => `${t.n}. ${t.text}`).join('\n')}\n` : ''}` +
    `Read it with synapse_plan id=${p.id.slice(0, 8)} (CLI: synapse plan ${p.id.slice(0, 8)}). ${HOW}`);
  return { ...show(p), next: `The others got the plan. ${HOW} Replies arrive in synapse_inbox or with your next prompt.` };
}

function addTask(p, me, text) {
  text = String(text || '').trim();
  if (!text) return;
  p.tasks.push({ n: (p.tasks.at(-1)?.n || 0) + 1, text, status: 'open', owner: null, by: me.name });
}

export function list(me, { id } = {}) {
  const plans = load();
  if (id) return show(find(plans, me, id));
  const mine = plans.filter((p) => p.members.some((m) => m.id === me.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!mine.length) return { plans: [], next: 'You are not on any plan. Start one with synapse_plan_start goal=... agents=[...].' };
  const [latest, ...rest] = mine;
  return { latest: show(latest), others: rest.slice(0, 10).map((p) => ({ id: p.id.slice(0, 8), goal: clip(p.goal, 100), status: p.status })) };
}

// one call does any of: a note, new tasks, claim / done / reopen a task, close the plan
export function update(me, { id, note, add_tasks: add = [], claim, done, reopen, close } = {}) {
  const plans = load();
  const p = find(plans, me, id);
  const task = (n) => {
    const t = p.tasks.find((x) => x.n === Number(n));
    if (!t) throw new Error(`The plan has no task ${n}.`);
    return t;
  };
  const changes = [];
  if (note && String(note).trim()) {
    p.notes.push({ by: me.name, t: Date.now(), text: String(note).trim() });
    p.notes = p.notes.slice(-MAX_NOTES);
    changes.push(String(note).trim());
  }
  const before = p.tasks.length;
  for (const t of [].concat(add)) addTask(p, me, t);
  if (p.tasks.length > before) changes.push(`Added tasks:\n${p.tasks.slice(before).map((t) => `${t.n}. ${t.text}`).join('\n')}`);
  if (claim != null) {
    const t = task(claim);
    if (t.owner && t.owner.id !== me.id && t.status !== 'done') throw new Error(`Task ${t.n} is already ${t.owner.name}'s.`);
    t.owner = { id: me.id, name: me.name }; t.status = 'doing';
    changes.push(`I am taking task ${t.n}: ${t.text}`);
  }
  if (done != null) { const t = task(done); t.status = 'done'; t.owner ||= { id: me.id, name: me.name }; changes.push(`Done with task ${t.n}: ${t.text}`); }
  if (reopen != null) { const t = task(reopen); t.status = 'open'; t.owner = null; changes.push(`Reopened task ${t.n}: ${t.text}`); }
  if (close) { p.status = 'closed'; changes.push('Closed the plan.'); }
  if (!changes.length) throw new Error('Nothing to update: give a note, add_tasks, claim, done, reopen or close.');
  p.updatedAt = Date.now();
  save(plans);
  broadcast(p, me, changes.join('\n'));
  const open = p.tasks.filter((t) => t.status !== 'done').length;
  return { ...show(p), next: open || p.status === 'closed' ? 'The other members got this.' : 'Every task is done: close the plan (close=true) once everyone agrees.' };
}
