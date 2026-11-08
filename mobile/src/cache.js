// The chats this phone opens most, kept on the phone: they show at once when opened, before the computer has
// answered, and the computer keeps them fresh in the background (remote.js asks for them with "keep"). A chat
// not opened for two weeks is dropped, and only the most used ones are kept.
import { Platform } from 'react-native';

const KEEP = 8, STALE = 14 * 24 * 3600_000, NAME = 'chats-v1.json';
let entries = {}; // agent id -> { opens, at, messages }
let ready = null, timer = null;

const store = Platform.OS === 'web'
  ? { read: async () => globalThis.localStorage?.getItem(NAME) || null, write: async (s) => globalThis.localStorage?.setItem(NAME, s) }
  : (() => {
    const { File, Paths } = require('expo-file-system');
    const file = () => new File(Paths.document, NAME);
    return {
      read: async () => (file().exists ? file().text() : null),
      write: async (s) => { const f = file(); if (!f.exists) f.create(); await f.write(s); },
    };
  })();

// most opened and most recent first: each open counts less the longer ago it was (a week halves it)
const score = (e) => e.opens * 0.5 ** ((Date.now() - e.at) / (7 * 24 * 3600_000));
function prune() {
  const now = Date.now();
  const kept = Object.entries(entries).filter(([, e]) => now - e.at < STALE).sort(([, a], [, b]) => score(b) - score(a)).slice(0, KEEP);
  entries = Object.fromEntries(kept);
}
const save = () => {
  clearTimeout(timer);
  timer = setTimeout(() => { prune(); store.write(JSON.stringify(entries)).catch(() => {}); }, 1000);
};

// resolves with { id: messages } for the kept chats
export function load() {
  return (ready ||= store.read().then((s) => {
    try { entries = s ? JSON.parse(s) : {}; } catch { entries = {}; }
    prune();
    return Object.fromEntries(Object.entries(entries).map(([id, e]) => [id, e.messages || []]));
  }).catch(() => ({})));
}
// the ids the computer should keep fresh
export const keep = () => Object.keys(entries);
export function opened(id) {
  const e = entries[id] || { opens: 0, messages: [] };
  entries[id] = { ...e, opens: e.opens + 1, at: Date.now() };
  prune();
  save();
}
export function remember(id, messages) {
  if (!entries[id]) return;
  entries[id] = { ...entries[id], messages: messages.slice(-40) };
  save();
}

// the last list of agents from each computer, so the app opens on it before the computer answers
const STATE = 'state-v1.json';
const states = Platform.OS === 'web'
  ? { read: async () => globalThis.localStorage?.getItem(STATE) || null, write: async (v) => globalThis.localStorage?.setItem(STATE, v) }
  : (() => {
    const { File, Paths } = require('expo-file-system');
    const file = () => new File(Paths.document, STATE);
    return {
      read: async () => (file().exists ? file().text() : null),
      write: async (v) => { const f = file(); if (!f.exists) f.create(); await f.write(v); },
    };
  })();
let lastStates = null, stateTimer = null;
const readStates = async () => (lastStates ||= await states.read().then((v) => JSON.parse(v || '{}')).catch(() => ({})));
export const lastState = async (computer) => (await readStates())[computer] || null;
export function rememberState(computer, snap) {
  readStates().then((all) => {
    all[computer] = snap;
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => states.write(JSON.stringify(all)).catch(() => {}), 2000);
  });
}
