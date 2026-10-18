// Agent talk, owner side: a friend's agent asks one of mine, a tool-less fork answers (the runner comes separately).
// This file holds the conversations, the checks on every ask and the per-agent queue.
import { FILES, KINDS, readJSON, writeJSON, localAgents, remoteId } from './lib.mjs';
import { config } from './remote.mjs';

export const LIMITS = {
  question: 4000, answer: 8000, answerMs: 120_000, waiting: 5, idleMs: 1_800_000,
  turns: 20, perHour: 60, askWaitMs: 90_000, replayChars: 150_000,
};
// how a kind answers: claude forks natively, everything else gets its transcript replayed into a fresh claude
export const ADAPTERS = Object.fromEntries(KINDS.map((k) => [k, k === 'claude' ? 'native' : 'replay']));

const KEEP_ENDED_MS = 30 * 24 * 3600_000;
const HOUR = 3600_000;

function load() {
  const s = readJSON(FILES.talks, {});
  return { conversations: [], queue: [], rate: {}, running: [], outgoing: [], ...s };
}
function save(s) {
  // ended conversations only stay a month
  const cutoff = Date.now() - KEEP_ENDED_MS;
  s.conversations = s.conversations.filter((c) => c.status !== 'ended' || (c.lastAt || 0) > cutoff);
  writeJSON(FILES.talks, s);
}

const isStr = (v) => typeof v === 'string' && v.length > 0;
const end = (conv, reason, note, now = Date.now()) => {
  conv.status = 'ended'; conv.endReason = reason; conv.lastAt = now;
  if (note) conv.endNote = note;
};
const endItem = (conv, reason, note) => ({ type: 'talk-end', conv, reason, ...(note ? { note } : {}) });

// Has this peer shared the target agent with me as a talk edge, and did they come in through a request?
export function allowed(peer, target, asker) {
  if (config().peers?.[peer]?.via !== 'request') return { reason: 'refused' };
  const edge = readJSON(FILES.edges, []).find((e) => !e.mirrored && e.from === target && e.to === remoteId(peer, asker) && e.mode === 'talk');
  return edge ? { edge } : { reason: 'refused' };
}

export function receiveAsk(peer, item, now = Date.now()) {
  const conv = item && item.conv;
  if (!item || !isStr(conv) || !isStr(item.target) || !isStr(item.asker) || !Number.isInteger(item.seq) || typeof item.question !== 'string') {
    return [endItem(typeof conv === 'string' ? conv : '', 'refused')];
  }
  const question = item.question.trim();
  if (!question || question.length > LIMITS.question) return [endItem(conv, 'refused')];

  const s = load();
  // sixty questions an hour per peer, counting the ones we turn away
  const recent = (s.rate[peer] || []).filter((t) => now - t < HOUR);
  recent.push(now);
  s.rate[peer] = recent;
  if (recent.length > LIMITS.perHour) { save(s); return [endItem(conv, 'busy')]; }

  const ok = allowed(peer, item.target, item.asker);
  if (!ok.edge) { save(s); return [endItem(conv, 'refused')]; }

  let c = s.conversations.find((x) => x.id === conv);
  // an ended conversation id is spent: a new ask under it starts fresh
  if (c && c.status === 'ended') { s.conversations = s.conversations.filter((x) => x !== c); c = null; }
  if (c && (c.peer !== peer || c.target !== item.target || c.asker !== item.asker)) { save(s); return [endItem(conv, 'refused')]; }
  if (c && c.turns.some((t) => t.seq === item.seq)) { save(s); return []; } // a repeated delivery

  if (s.queue.filter((j) => convOf(s, j.conv)?.target === item.target).length >= LIMITS.waiting) { save(s); return [endItem(conv, 'busy')]; }

  if (c && c.turns.length >= LIMITS.turns) {
    end(c, 'idle', 'turn limit', now);
    s.queue = s.queue.filter((j) => j.conv !== c.id);
    save(s);
    return [endItem(conv, 'idle', 'turn limit')];
  }

  if (!c) {
    const live = localAgents().find((a) => a.id === item.target);
    const kind = live?.kind || ok.edge.snapshot?.kind;
    const p = config().peers[peer];
    c = {
      id: conv, role: 'owner', peer, peerName: p.name, peerHandle: p.handle || null,
      asker: item.asker, askerName: String(item.askerName || '').slice(0, 80),
      target: item.target, targetName: live?.name || ok.edge.snapshot?.name || item.target,
      mode: ADAPTERS[kind] || 'replay', forkSession: null, status: 'open', turns: [], createdAt: now, lastAt: now,
    };
    s.conversations.push(c);
  }
  c.turns.push({ seq: item.seq, q: question, a: null, askedAt: now });
  c.lastAt = now;
  s.queue.push({ conv: c.id, seq: item.seq });
  const position = s.queue.filter((j) => convOf(s, j.conv)?.target === c.target).length;
  save(s);
  return [{ type: 'talk-status', conv: c.id, seq: item.seq, state: 'queued', position }];
}

const convOf = (s, id) => s.conversations.find((c) => c.id === id);

// The next question that can start now: first in line whose agent has nothing running. Checked again here
// because the edge may have gone while it waited.
export function nextJob(now = Date.now()) {
  const s = load();
  const busy = new Set(s.running.map((r) => convOf(s, r.conv)?.target).filter(Boolean));
  let found = null;
  let changed = false;
  for (const job of [...s.queue]) {
    const c = convOf(s, job.conv);
    if (!c || c.status !== 'open') { s.queue = s.queue.filter((j) => j !== job && !(j.conv === job.conv && j.seq === job.seq)); changed = true; continue; }
    if (busy.has(c.target)) continue;
    if (!allowed(c.peer, c.target, c.asker).edge) {
      end(c, 'refused', null, now);
      s.queue = s.queue.filter((j) => j.conv !== c.id);
      s.outgoing.push({ to: c.peer, item: endItem(c.id, 'refused') });
      changed = true;
      continue;
    }
    found = { conv: job.conv, seq: job.seq };
    break;
  }
  if (changed) save(s);
  return found;
}

export function endConversation(convId, reason, note) {
  const s = load();
  const c = convOf(s, convId);
  if (!c || c.status === 'ended') return;
  end(c, reason, note);
  s.queue = s.queue.filter((j) => j.conv !== convId);
  s.outgoing.push({ to: c.peer, item: endItem(convId, reason, note) });
  save(s);
}

export function takeOutgoing() {
  const s = load();
  const out = s.outgoing;
  if (!out.length) return [];
  s.outgoing = [];
  save(s);
  return out;
}

// Close what can no longer go on: the friend is gone, the share is no longer talk, or nobody has spoken for a while.
export function reconcile(now = Date.now()) {
  const s = load();
  const peers = config().peers || {};
  const edges = readJSON(FILES.edges, []);
  const ended = [];
  for (const c of s.conversations) {
    if (c.status !== 'open') continue;
    let reason = null;
    if (!peers[c.peer]) reason = 'revoked';
    else if (!edges.some((e) => !e.mirrored && e.from === c.target && e.to === remoteId(c.peer, c.asker) && e.mode === 'talk')) reason = 'owner';
    else if (now - c.lastAt >= LIMITS.idleMs) reason = 'idle';
    if (!reason) continue;
    end(c, reason, null, now);
    s.queue = s.queue.filter((j) => j.conv !== c.id);
    s.outgoing.push({ to: c.peer, item: endItem(c.id, reason) });
    ended.push(c.id);
  }
  if (ended.length) save(s);
  return ended;
}
