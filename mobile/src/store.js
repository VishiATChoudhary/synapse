// One store for the whole app. A source pushes state in and takes actions out: the demo until a computer is
// paired, then that computer (src/remote.js). The pairing lives in the keychain, so it survives restarts.
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { createDemo } from './demo';
import { pair, setRandom } from './link';
import { createRemote } from './remote';

setRandom(getRandomBytes);

const KEY = 'pairing-v1';
const keep = Platform.OS === 'web'
  ? { get: async () => globalThis.localStorage?.getItem(KEY), set: async (v) => (v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY)) }
  : { get: () => SecureStore.getItemAsync(KEY), set: (v) => (v ? SecureStore.setItemAsync(KEY, v) : SecureStore.deleteItemAsync(KEY)) };

let state = { agents: [], projects: [], kinds: null, mode: 'demo', ready: false };
const listeners = new Set();
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
let current = null;

function use(make, mode) {
  current?.close?.();
  const emit = (next) => { state = { ...next, mode, ready: true }; listeners.forEach((l) => l()); };
  current = make(emit);
}
const useDemo = () => use((emit) => createDemo(emit), 'demo');

useDemo();
keep.get().then((v) => { if (v) use((emit) => createRemote(emit, JSON.parse(v)), 'paired'); }).catch(() => {});

// what the screens call; whichever source is current answers
export const source = {
  get name() { return state.mode; },
  send: (id, text) => current.send(id, text),
  answer: (id, option) => current.answer(id, option),
  stop: (id) => current.stop(id),
  watch: (id) => current.watch?.(id),
  spawn: async (opts) => current.spawn(opts),
};

export async function pairWith(pairing, phoneName) {
  const link = await pair(pairing, phoneName);
  await keep.set(JSON.stringify(link));
  use((emit) => createRemote(emit, link), 'paired');
  return link;
}

export async function unpair() {
  await current.forget?.(); // the computer drops this phone too
  await keep.set(null);
  useDemo();
}

export const useSynapse = () => useSyncExternalStore(subscribe, () => state);
export const useAgent = (id) => useSynapse().agents.find((a) => a.id === id);

// needs you first, then working, then most recently active
const rank = (a) => (a.needs ? 0 : a.status === 'busy' ? 1 : 2);
export const byAttention = (agents) => [...agents].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
