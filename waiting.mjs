// What an agent is waiting on outside itself: checks on a pull request, a deploy, a review, a merge. The agent says
// so (MCP synapse_waiting, CLI "synapse waiting"); the app shows it as Watching until the agent clears it, the
// user sends it a new prompt, or a week passes. Kept in ~/.synapse/waiting.json: agent id -> { what, url, since }.
import path from 'node:path';
import { DATA, readJSON, writeJSON } from './lib.mjs';

export const FILE = path.join(DATA, 'waiting.json');
const WEEK = 7 * 24 * 3600_000;

export function all() {
  const w = readJSON(FILE, {}), now = Date.now();
  return Object.fromEntries(Object.entries(w).filter(([, v]) => v && now - (v.since || 0) < WEEK));
}
export function set(agentId, { what, url } = {}) {
  const text = String(what ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!text) throw new Error('Say what you are waiting for, e.g. "checks on PR #12 to pass".');
  let link = null;
  if (url) { try { const u = new URL(String(url)); if (/^https?:$/.test(u.protocol)) link = u.href.slice(0, 1000); } catch {} }
  const w = all();
  w[agentId] = { what: text, url: link, since: w[agentId]?.what === text ? w[agentId].since : Date.now() };
  writeJSON(FILE, w);
  return w[agentId];
}
export function clear(agentId) {
  const w = all();
  if (!w[agentId]) return false;
  delete w[agentId]; writeJSON(FILE, w);
  return true;
}
