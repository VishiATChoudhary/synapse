// One store for the whole app. A source (demo now, the paired laptop over the relay next)
// pushes state in and takes actions out: send, answer, stop, spawn.
import { useSyncExternalStore } from 'react';
import { createDemo } from './demo';

let state = { agents: [], projects: [] };
const listeners = new Set();
const emit = (next) => { state = next; listeners.forEach((l) => l()); };
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };

export const source = createDemo(emit);

export const useSynapse = () => useSyncExternalStore(subscribe, () => state);
export const useAgent = (id) => useSynapse().agents.find((a) => a.id === id);

// needs you first, then working, then most recently active
const rank = (a) => (a.needs ? 0 : a.status === 'busy' ? 1 : 2);
export const byAttention = (agents) => [...agents].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
