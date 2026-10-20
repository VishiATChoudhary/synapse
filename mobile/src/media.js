// Screenshots and videos from the computer, for the agent chat. The computer sends media ids with the
// messages; this asks for each one once and keeps it in the app's cache folder:
//   images: { t: 'media', id } -> { t: 'media', id, mime, data } (base64)
//   videos: { t: 'piece', id, i } -> { t: 'piece', id, i, n, size, bytes }, two pieces on their way at a time
// The "show images and videos" switch (settings) is kept on the phone; off, nothing is asked for.
import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import util from 'tweetnacl-util';

export const supported = Platform.OS === 'ios' || Platform.OS === 'android';
const KEY = 'media-v1';
const CACHE_MAX = 300 << 20;
const WINDOW = 2, RETRY = 20_000;

// ---------------------------------------------------------------- the switch

let on = supported;
const switchers = new Set();
if (supported) SecureStore.getItemAsync(KEY).then((v) => { on = v !== 'off'; switchers.forEach((l) => l()); }).catch(() => {});
export const mediaOn = () => on;
export function setMediaOn(v) {
  on = !!v && supported;
  SecureStore.setItemAsync(KEY, on ? 'on' : 'off').catch(() => {});
  switchers.forEach((l) => l());
}
export const onSwitch = (l) => { switchers.add(l); return () => switchers.delete(l); };
export const useMediaOn = () => useSyncExternalStore((l) => { switchers.add(l); return () => switchers.delete(l); }, () => on);

// ---------------------------------------------------------------- the cache

let dir = null, known = null; // id -> uri of what is on disk
function cache() {
  if (known) return known;
  known = new Map();
  if (!supported) return known;
  try {
    dir = new Directory(Paths.cache, 'synapse-media');
    if (!dir.exists) dir.create();
    // oldest out first once the folder is past CACHE_MAX
    const files = dir.list().filter((f) => f instanceof File).sort((a, b) => (b.modificationTime || 0) - (a.modificationTime || 0));
    let total = 0;
    for (const f of files) {
      total += f.size || 0;
      if (total > CACHE_MAX) { try { f.delete(); } catch {} continue; }
      known.set(f.name.replace(/\.\w+$/, ''), f.uri);
    }
  } catch {}
  return known;
}
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4' };
function keep(id, mime, bytes) {
  cache();
  const f = new File(dir, `${id}.${EXT[mime] || 'bin'}`);
  if (f.exists) f.delete();
  f.create();
  f.writeSync(bytes);
  known.set(id, f.uri);
  return f.uri;
}

// ---------------------------------------------------------------- what each item is doing

const items = new Map(); // id -> { state: 'idle' | 'loading' | 'ready' | 'failed', uri, got, n }
const listeners = new Set();
const set = (id, patch) => { items.set(id, { ...(items.get(id) || { state: 'idle' }), ...patch }); listeners.forEach((l) => l()); };
const item = (id) => {
  if (!items.has(id)) { const uri = cache().get(id); items.set(id, uri ? { state: 'ready', uri } : { state: 'idle' }); }
  return items.get(id);
};
export const useMediaItem = (id) => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => (id ? item(id) : null));

// the open computer: how to ask it (set by src/remote.js)
let ask = null;
export const attach = (say) => { ask = say; };
export const detach = (say) => { if (ask === say) ask = null; };

export function wantImage(id) {
  const it = item(id);
  if (!on || !ask || it.state === 'ready' || (it.state === 'loading' && Date.now() - it.at < RETRY)) return;
  set(id, { state: 'loading', at: Date.now() });
  ask({ t: 'media', id });
}

const parts = new Map(); // video id -> { n, size, got: Map(i -> bytes), asked: Map(i -> time) }
export function wantVideo(ref) {
  const it = item(ref.id);
  if (!on || !ask || it.state === 'ready' || ref.state !== 'ready') return;
  let p = parts.get(ref.id);
  if (!p) { p = { n: ref.pieces, size: ref.size, got: new Map(), asked: new Map() }; parts.set(ref.id, p); set(ref.id, { state: 'loading', got: 0, n: p.n }); }
  pump(ref.id, p);
}
function pump(id, p) {
  const now = Date.now();
  for (const [i, t] of p.asked) if (now - t > RETRY) p.asked.delete(i); // lost on the way: ask again
  for (let i = 0; i < p.n && p.asked.size < WINDOW; i++) {
    if (p.got.has(i) || p.asked.has(i)) continue;
    p.asked.set(i, now);
    ask?.({ t: 'piece', id, i });
  }
}
// pieces that never came: look again now and then while the chat is open
setInterval(() => { for (const [id, p] of parts) pump(id, p); }, 5000);

// what the computer sent back
export function receive(m) {
  if (m.t === 'media') {
    if (m.gone || !m.data) return set(m.id, { state: 'failed' });
    try { set(m.id, { state: 'ready', uri: keep(m.id, m.mime, util.decodeBase64(m.data)) }); } catch { set(m.id, { state: 'failed' }); }
    return;
  }
  if (m.t === 'piece') {
    const p = parts.get(m.id);
    if (!p) return;
    if (m.gone) { parts.delete(m.id); return set(m.id, { state: 'failed' }); }
    p.asked.delete(m.i);
    if (m.bytes && !p.got.has(m.i)) p.got.set(m.i, m.bytes);
    set(m.id, { got: p.got.size, n: p.n });
    if (p.got.size < p.n) return pump(m.id, p);
    parts.delete(m.id);
    const all = new Uint8Array(p.size);
    let at = 0;
    for (let i = 0; i < p.n; i++) { all.set(p.got.get(i), at); at += p.got.get(i).length; }
    try { set(m.id, { state: 'ready', uri: keep(m.id, 'video/mp4', all) }); } catch { set(m.id, { state: 'failed' }); }
  }
}
