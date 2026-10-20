// One store for the whole app. Signed in, the source is one of the account's computers (src/remote.js);
// the demo is only there for App Review and anyone who wants to look first. The sign-in and this phone's
// keys live in the keychain, so they survive restarts.
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { createDemo } from './demo';
import { DEFAULT_CLOUD, api, computers, setRandom, signIn, signOut } from './link';
import { createRemote } from './remote';

setRandom(getRandomBytes);

const keychain = (key) => (Platform.OS === 'web'
  ? { get: async () => globalThis.localStorage?.getItem(key), set: async (v) => (v ? localStorage.setItem(key, v) : localStorage.removeItem(key)) }
  : { get: () => SecureStore.getItemAsync(key), set: (v) => (v ? SecureStore.setItemAsync(key, v) : SecureStore.deleteItemAsync(key)) });
const ACCOUNT = keychain('account-v1'), CHOSEN = keychain('computer-v1');

// mode: 'loading' | 'signed-out' | 'demo' | 'account'
let state = { agents: [], projects: [], kinds: null, mode: 'loading', user: null, computers: [], computerId: null };
const listeners = new Set();
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const set = (patch) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
let current = null, acc = null, refresh = null;

function use(make, mode) {
  current?.close?.();
  current = make((next) => set({ ...next, mode }));
}
const empty = { agents: [], projects: [], kinds: null, computer: null, online: false, access: null, error: null };

// the account's computers; the chosen one (or the most recently seen) is the source
async function loadComputers() {
  let list = [];
  try { list = await computers(acc); }
  catch (e) { if (e.status === 401) return signOutNow(); return; }
  const saved = await CHOSEN.get().catch(() => null);
  const pick = list.find((c) => c.id === (state.computerId || saved)) || list[0] || null;
  set({ computers: list });
  if (pick?.id !== state.computerId || !current) choose(pick);
}

export function choose(computer) {
  current?.close?.();
  current = null;
  set({ ...empty, mode: 'account', computerId: computer?.id || null });
  if (!computer) return;
  CHOSEN.set(computer.id).catch(() => {});
  use((emit) => createRemote(emit, acc, computer), 'account');
}

function startAccount(a) {
  acc = a;
  set({ ...empty, mode: 'account', user: a.user, computers: [], computerId: null });
  loadComputers();
  clearInterval(refresh);
  refresh = setInterval(loadComputers, 30_000);
}

async function signOutNow() {
  clearInterval(refresh);
  current?.close?.();
  current = null;
  const old = acc;
  acc = null;
  await ACCOUNT.set(null);
  set({ ...empty, mode: 'signed-out', user: null, computers: [], computerId: null });
  if (old) await signOut(old);
}

ACCOUNT.get().then((v) => (v ? startAccount(JSON.parse(v)) : set({ mode: 'signed-out' }))).catch(() => set({ mode: 'signed-out' }));

export async function signInWith(form, phoneName) {
  const a = await signIn(DEFAULT_CLOUD, form, phoneName);
  await ACCOUNT.set(JSON.stringify(a));
  startAccount(a);
}
export const signOutPhone = signOutNow;
export function tryDemo() { use((emit) => createDemo(emit), 'demo'); }
export function leaveDemo() { current?.close?.(); current = null; set({ ...empty, mode: 'signed-out' }); }

// App Review 5.1.1(v): an account made in the app can be deleted in the app
export async function deleteAccount(password) {
  await api(acc.cloud, 'DELETE', '/v1/me', { body: { password }, token: acc.session });
  await signOutNow();
}

// what the screens call; whichever source is current answers
export const source = {
  get name() { return state.mode; },
  send: (id, text) => current?.send(id, text),
  answer: (id, option) => current?.answer(id, option),
  stop: (id) => current?.stop(id),
  watch: (id) => current?.watch?.(id),
  spawn: async (opts) => (current ? current.spawn(opts) : null),
};

export const useSynapse = () => useSyncExternalStore(subscribe, () => state);
export const useAgent = (id) => useSynapse().agents.find((a) => a.id === id);

// needs you first, then working, then most recently active
const rank = (a) => (a.needs ? 0 : a.status === 'busy' ? 1 : 2);
export const byAttention = (agents) => [...agents].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
