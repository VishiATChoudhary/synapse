// Operations shared by the CLI (skill), the MCP server and the web server.
// Every call is made "as" an agent: `me` is the agent record of the caller.
import crypto from 'node:crypto';
import {
  FILES, readJSON, writeJSON, listAgents, findAgent, readAgentMessages, formatMessages,
  postMessage, takeInbox, linked, projectOfAgent, colorOf, remoteId, localAgents, REMOTE_OFFLINE,
} from './lib.mjs';
import * as remote from './remote.mjs';
import { queueDrop, config } from './remote.mjs';
import * as talk from './talk.mjs';

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
  if (mode === 'talk') talk.resolveRequestsFor(peer[0], edge.from, edge.to.slice(remoteId(peer[0], '').length));
  return { edge };
}

// A friend's agent asked one of mine over a sync share: Allow switches exactly that share to talk and tells
// their machine; Not now keeps the same request quiet for a day.
export function allowTalkRequest(id) {
  const r = talk.openRequests().find((x) => x.id === id);
  if (!r) throw new Error('No such request.');
  const edge = readJSON(FILES.edges, []).find((e) => !e.mirrored && e.from === r.target && e.to === remoteId(r.peer, r.asker));
  if (!edge) throw new Error('That share is gone.');
  setMode(edge.id, 'talk'); // allows the request and tells the asker
  return { allowed: true, edge: edge.id };
}
export function dismissTalkRequest(id) {
  if (!talk.decideRequest(id, 'dismissed')) throw new Error('No such request.');
  return { dismissed: true };
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

// ---------------------------------------------------------------- asking a friend's agent (talk)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT_NOTE = 'Still waiting for the answer. It will arrive in synapse_inbox (or your next prompt).';

// Ask an agent on a friend's machine a question. A tool-less copy of it answers; we wait up to waitMs for the answer,
// syncing about once a second (the canvas server may not be running), and anything later goes to the inbox.
// `now`, `sync` and `interval` can be replaced in tests.
export async function ask(me, query, question, { conversation, waitMs = talk.LIMITS.askWaitMs, sync = remote.sync, now = Date.now, interval = 1000 } = {}) {
  const other = resolve(listAgents(), query);
  if (!other.remote) throw new Error(`${other.name} runs on this machine. Use "send" to message it; ask is for a friend's agent.`);
  const edges = readJSON(FILES.edges, []);
  const shared = edges.filter((e) => e.mirrored && e.from === other.id && e.to === me.id);
  if (!shared.some((e) => e.mode === 'talk')) {
    // read only, from a friend paired through a request: ask them to let us ask, rather than a dead end
    if (!shared.length || config().peers?.[other.remote.machine]?.via !== 'request') {
      throw new Error(`talk is off: ${other.remote.owner} shares ${other.name} with you for reading only. Questions work once ${other.remote.owner} turns on talk for it (use "read" meanwhile).`);
    }
    // an owner on 0.4.0 drops a talk-request silently: no waiting for a note that can never come
    if (readJSON(FILES.peerState, {})[other.remote.machine]?.talkRequests !== true) {
      throw new Error(`talk is off: ${other.remote.owner} shares ${other.name} read-only, and their Synapse is too old to get your request. Ask them to switch talk on.`);
    }
    const { id, send } = talk.openTalkRequest({ me, agent: other, now: now() });
    if (send) {
      remote.queueItem(other.remote.machine, { type: 'talk-request', id, target: other.remote.agentId, asker: me.id, askerName: me.name });
      await Promise.resolve(sync()).catch(() => {});
    }
    return { status: 'requested', request: id, note: `Asked ${other.remote.owner} to let you ask ${other.name}. Try again once they allow it.` };
  }
  const q = String(question ?? '').trim();
  if (!q) throw new Error('Give a question to ask.');
  if (q.length > talk.LIMITS.question) throw new Error(`Questions are at most ${talk.LIMITS.question} characters; this one is ${q.length}.`);

  // a friend whose machine has been quiet will not answer now; the question waits for them
  const seen = readJSON(FILES.peerState, {})[other.remote.machine]?.seen || 0;
  const offline = Date.now() - seen > REMOTE_OFFLINE;
  const { conv, seq } = talk.openAsk({ me, agent: other, conversation, question: q, now: now(), waitMs, offline });
  remote.queueItem(other.remote.machine, { type: 'talk-ask', conv, seq, target: other.remote.agentId, asker: me.id, askerName: me.name, question: q });
  const done = (r) => ({ ...r, conversation: conv });
  if (offline) return done({ status: 'offline', note: `${other.remote.owner} looks offline. The question is queued; the answer will arrive in synapse_inbox.` });

  const deadline = now() + waitMs;
  try {
    for (;;) {
      await Promise.resolve(sync()).catch(() => {});
      const over = now() >= deadline;
      const got = talk.takeAnswer(conv, seq, { final: over });
      if (got.answer != null) return done({ answer: got.answer });
      if (got.ended) return done({ status: 'ended', reason: got.reason, note: `The conversation ended (${got.reason}${got.note ? `: ${got.note}` : ''}). Ask again to start a new one.` });
      if (got.gone) return done({ status: 'ended', reason: 'error', note: 'The conversation is gone.' });
      if (over) return done({ status: 'queued', note: WAIT_NOTE });
      await sleep(Math.max(0, Math.min(interval, deadline - now())));
    }
  } finally {
    // however we leave (a throw, a cancel), the turn must not stay held back from the inbox
    talk.release(conv, seq);
  }
}

// End a conversation with a friend's agent; their machine is told on the next sync.
export function endTalk(me, conversation) {
  const out = talk.endAsked(conversation, me);
  if (out) remote.queueItem(out.peer, { type: 'talk-end', conv: out.conv, reason: 'asker' });
  return { ended: true };
}
