// Operations shared by the CLI (skill), the MCP server and the web server.
// Every call is made "as" an agent: `me` is the agent record of the caller.
import crypto from 'node:crypto';
import {
  FILES, readJSON, writeJSON, listAgents, findAgent, readAgentMessages, formatMessages,
  postMessage, takeInbox, linked, projectOfAgent, colorOf, remoteId, localAgents,
} from './lib.mjs';
import { queueDrop, config } from './remote.mjs';

const brief = (a) => ({ name: a.name, id: a.id, kind: a.kind, cwd: a.cwd, status: a.status, ...(a.remote ? { owner: a.remote.owner } : {}) });

function resolve(agents, query) {
  const a = findAgent(agents, query);
  if (!a) throw new Error(`No live agent matches "${query}". Run "peers --all" to see every agent.`);
  return a;
}

// extra.onDemand: the target reads the source when it asks (synapse_read); the hook pushes nothing
export function createEdge(from, to, extra = {}) {
  if (from.id === to.id) throw new Error('An agent cannot link to itself.');
  // only the owner of an agent decides who sees it: a friend's agent is shared from their machine
  if (from.remote) throw new Error(`${from.name} runs on ${from.remote.owner}'s machine. Only ${from.remote.owner} can share it.`);
  const edges = readJSON(FILES.edges, []);
  const existing = edges.find((e) => e.from === from.id && e.to === to.id);
  if (existing) return { edge: existing, created: false };
  const color = (a) => colorOf(projectOfAgent(a).key);
  const edge = {
    id: crypto.randomUUID(), from: from.id, to: to.id, fromName: from.name, toName: to.name,
    fromColor: color(from), toColor: color(to), fromKind: from.kind, toKind: to.kind, createdAt: Date.now(), ...extra,
  };
  edges.push(edge);
  writeJSON(FILES.edges, edges);
  return { edge, created: true };
}

export function removeEdge(id) {
  const edge = readJSON(FILES.edges, []).find((e) => e.id === id);
  if (edge?.mirrored) queueDrop(edge); // a friend shares this one: ask their machine to stop
  writeJSON(FILES.edges, readJSON(FILES.edges, []).filter((e) => e.id !== id));
  const cursors = readJSON(FILES.cursors, {});
  delete cursors[id];
  writeJSON(FILES.cursors, cursors);
}

// Share edge mode: 'sync' (default, the friend's agent reads my context) or 'talk' (the friend's agent may ask mine).
// Talk keeps a snapshot of the source so the friend can still ask after the session closes.
export function setMode(edgeId, mode) {
  if (mode !== 'sync' && mode !== 'talk') throw new Error('mode is "sync" or "talk".');
  const edges = readJSON(FILES.edges, []);
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge) throw new Error('No such share.');
  if (edge.mirrored) throw new Error(`${edge.owner || 'The owner'} shares this one; only the owner can change how it is shared.`);
  const peer = Object.entries(config().peers).find(([m]) => edge.to.startsWith(remoteId(m, '')));
  if (!peer) throw new Error("Only a share to a friend's agent can be set to talk.");
  if (mode === 'talk') {
    if (peer[1].via !== 'request') throw new Error('Talk works only with friends you connected through a synapse request.');
    const a = localAgents().find((x) => x.id === edge.from);
    if (!a) throw new Error('The agent has to be running to turn talk on.');
    edge.mode = 'talk';
    edge.snapshot = { kind: a.kind, name: a.name, cwd: a.cwd, transcript: a.transcript, format: a.format };
  } else {
    delete edge.mode;
    delete edge.snapshot;
  }
  writeJSON(FILES.edges, edges);
  return { edge };
}

// Who am I connected to?
export function peers(me, { all = false } = {}) {
  const agents = listAgents();
  const edges = readJSON(FILES.edges, []);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const tag = (e, other) => ({ ...brief(other), ...(e.mode === 'talk' ? { talk: true } : {}) });
  const readsFrom = edges.filter((e) => e.to === me.id && byId.has(e.from)).map((e) => tag(e, byId.get(e.from)));
  const sharesWith = edges.filter((e) => e.from === me.id && byId.has(e.to)).map((e) => tag(e, byId.get(e.to)));
  const out = { me: brief(me), readsFrom, sharesWith };
  if (all) out.allAgents = agents.filter((a) => a.id !== me.id).map(brief);
  return out;
}

// direction: 'in' (they share with me), 'out' (I share with them), 'both'
export function link(me, query, direction = 'both') {
  const other = resolve(listAgents(), query);
  if (other.remote && direction === 'in') throw new Error(`${other.name} runs on ${other.remote.owner}'s machine. Only ${other.remote.owner} can share it with you.`);
  if (other.remote) direction = 'out'; // across machines a link only goes from the owner's agent
  const made = [];
  if (direction === 'in' || direction === 'both') made.push(createEdge(other, me));
  if (direction === 'out' || direction === 'both') made.push(createEdge(me, other));
  return { linked: other.name, direction, created: made.filter((m) => m.created).length };
}

export function unlink(me, query) {
  const other = resolve(listAgents(), query);
  const gone = readJSON(FILES.edges, []).filter((e) => (e.from === me.id && e.to === other.id) || (e.from === other.id && e.to === me.id));
  gone.forEach((e) => removeEdge(e.id));
  return { unlinked: other.name, removed: gone.length };
}

// Read another agent's recent conversation. Allowed when they share with me.
export function readContext(me, query, maxChars = 12000) {
  const other = resolve(listAgents(), query);
  const edges = readJSON(FILES.edges, []);
  if (!edges.some((e) => e.from === other.id && e.to === me.id)) {
    throw new Error(`${other.name} does not share context with you. Link it first ("link ${other.name}").`);
  }
  const { messages } = readAgentMessages(other);
  if (other.remote) {
    return {
      agent: brief(other),
      context: messages.length ? formatMessages(messages, maxChars) : `(${other.remote.owner} shares ${other.name} with you, but nothing has arrived yet.)`,
      recentMessagesToYou: [],
    };
  }
  const shared = readJSON(FILES.messages, []).filter((m) => m.from === other.id && m.to === me.id).slice(-5);
  return {
    agent: brief(other),
    transcript: other.transcript,
    context: messages.length ? formatMessages(messages, maxChars)
      : '(No readable transcript for this agent type. Ask it directly with send.)',
    recentMessagesToYou: shared.map((m) => m.text),
  };
}

// Send a message. Allowed when the two agents are linked in either direction.
export function send(me, query, text) {
  const other = resolve(listAgents(), query);
  if (other.remote) throw new Error(`${other.name} runs on ${other.remote.owner}'s machine. Agents on different machines do not message each other; it can read what you share with it.`);
  if (!linked(readJSON(FILES.edges, []), me.id, other.id)) {
    throw new Error(`You are not linked to ${other.name}. Link first ("link ${other.name}").`);
  }
  const m = postMessage(me, other, text);
  return { sent: true, to: other.name, id: m.id, note: 'Delivered on their next prompt (Claude) or next inbox check (other agents).' };
}

export function inbox(me) {
  return takeInbox(me.id).map((m) => ({ from: m.fromName, at: new Date(m.t).toISOString(), text: m.text }));
}
