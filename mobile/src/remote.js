// One of the account's computers as a source: its agents and workspaces, kept fresh by polling Synapse Cloud
// while the app is in front, plus the actions the screens call. Same shape as the demo source.
import { AppState } from 'react-native';
import { connect } from './link';
import * as cache from './cache';
import * as media from './media';

const FAST = 1500, SHELL_FAST = 400, PING = 30_000;
// what the computer sends can get lost on the way (a poll answer cut off when the app is suspended, a full mailbox):
// every few seconds the phone says what it has, and the computer sends again what is missing
const HAVE = 5000;

export function createRemote(emit, acc, computer) {
  const conn = connect(acc, computer);
  // access: 'unknown' until the computer answers, 'waiting' until it is allowed there, then 'ok'
  let state = { agents: [], projects: [], kinds: [], computer: computer.name, online: false, access: 'unknown', error: null };
  let snap = { agents: [], projects: [], kinds: [], shares: [] };
  let watch = null, messages = {}, screens = {}, lastSeen = 0, lastPing = 0, timer = null, stopped = false;
  let stateV = null, lastHave = 0, listed = false; // listed: the computer's own list arrived (not the one kept from last time)
  const versions = {}; // chat or shell -> tag of what arrived last
  const waiting = new Map(); // spawn request -> resolve
  const opening = new Map(); // share request -> resolve({ share } or { error })

  const publish = () => {
    const agents = snap.agents.map((a) => ({ ...a, needs: null, messages: messages[a.id] || [], ...(a.shell ? { screen: screens[a.id] || null } : {}) }));
    state = { ...state, agents, listed, projects: snap.projects, kinds: snap.kinds, shares: snap.shares, online: Date.now() - lastSeen < 15_000 };
    emit(state);
  };
  const fail = (e) => { state = { ...state, error: e.message }; emit(state); setTimeout(() => { state = { ...state, error: null }; emit(state); }, 5000); };
  const say = (msg) => conn.send(msg).catch(fail);
  // hello says whether this phone shows images and videos (the settings switch)
  // and which chats it keeps (cache.js), so the computer keeps those fresh too
  const hello = () => ({ t: 'hello', keep: cache.keep(), ...(media.supported && media.mediaOn() ? { media: 1 } : {}) });
  const ask = (msg) => conn.send(msg).catch(() => {});
  media.attach(ask);

  function receive(m) {
    lastSeen = Date.now();
    if (m.t === 'waiting') state = { ...state, access: 'waiting' };
    else if (m.t !== 'error') state = { ...state, access: 'ok' };
    if (m.t === 'state') { snap = { agents: m.agents || [], projects: m.projects || [], kinds: m.kinds || [], shares: m.shares || [] }; stateV = m.v || null; listed = true; cache.rememberState(computer.id, snap); }
    else if (m.t === 'messages') { messages = { ...messages, [m.id]: m.messages || [] }; if (m.v) versions[m.id] = m.v; cache.remember(m.id, m.messages || []); }
    else if (m.t === 'screen') { screens = { ...screens, [m.id]: m.gone ? null : { lines: m.lines || [], cursor: m.cursor || null, cols: m.cols } }; if (m.v) versions[m.id] = m.v; }
    else if (m.t === 'media' || m.t === 'piece') media.receive(m);
    else if (m.t === 'spawned') { waiting.get(m.req)?.(m.id); waiting.delete(m.req); }
    else if (m.t === 'shared') { opening.get(m.req)?.({ share: m.share }); opening.delete(m.req); }
    else if (m.t === 'renamed') { opening.get(m.req)?.({ ok: true, name: m.name }); opening.delete(m.req); }
    else if (m.t === 'error' && m.req && opening.has(m.req)) { opening.get(m.req)({ error: m.error }); opening.delete(m.req); } // shown where it was asked
    else if (m.t === 'error') { if (m.req && waiting.has(m.req)) { waiting.get(m.req)(null); waiting.delete(m.req); } fail(new Error(m.error)); }
  }

  async function tick() {
    if (stopped) return;
    try {
      // until the computer has allowed this phone, keep saying hello so it answers as soon as it is allowed
      const ok = state.access === 'ok';
      if (Date.now() - lastPing > (ok ? PING : 4000)) { lastPing = Date.now(); await conn.send(ok ? { t: 'ping', keep: cache.keep() } : hello()); }
      if (ok && Date.now() - lastHave > HAVE) { lastHave = Date.now(); await conn.send({ t: 'have', id: watch, state: stateV, chat: (watch && versions[watch]) || null }); }
      for (const m of await conn.poll()) receive(m);
      publish();
    } catch (e) {
      if (e.status === 403) state = { ...state, access: 'removed' }; // the computer removed this phone, or it signed out elsewhere
      else if (e.status === 401) fail(new Error('Your sign-in expired. Sign in again.'));
    }
    // a shell open on the phone looks more often, so what is typed shows up quickly
    if (AppState.currentState === 'active') timer = setTimeout(tick, state.access === 'waiting' ? 4000 : watch?.startsWith('sh-') ? SHELL_FAST : FAST);
  }
  function request(msg, ms) {
    const req = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const done = new Promise((resolve) => {
      opening.set(req, resolve);
      setTimeout(() => { if (opening.delete(req)) resolve({ error: 'Your computer did not answer in time.' }); }, ms);
    });
    conn.send({ ...msg, req }).catch((e) => { const r = opening.get(req); opening.delete(req); r?.({ error: e.message }); });
    return done;
  }
  const wake = () => { clearTimeout(timer); lastPing = Date.now(); say(hello()).then(tick); if (watch) say({ t: 'watch', id: watch }); };
  const offSwitch = media.onSwitch(() => wake()); // switched in settings: tell the computer
  const sub = AppState.addEventListener('change', (s) => { if (s === 'active') wake(); else clearTimeout(timer); });
  // the kept chats show at once, before the computer answers
  cache.load().then((kept) => { messages = { ...kept, ...messages }; publish(); });
  // the list as it was last time, until the computer answers: the app opens on chats, not on an empty screen
  cache.lastState(computer.id).then((old) => { if (old && !snap.agents.length) { snap = old; publish(); } });
  wake();
  emit(state);

  return {
    name: 'account',
    close() { stopped = true; clearTimeout(timer); offSwitch(); sub.remove(); media.detach(ask); conn.send({ t: 'bye' }).catch(() => {}); },
    watch(id) {
      watch = id;
      if (id) cache.opened(id);
      say({ t: 'watch', id, keep: cache.keep() });
    },
    // an empty name goes back to the automatic one; resolves with { ok, name } or { error }
    async rename(id, name) {
      const r = await request({ t: 'rename', id, name: String(name || '').trim().slice(0, 48) }, 15_000);
      if (r.ok) { snap = { ...snap, agents: snap.agents.map((a) => (a.id === id ? { ...a, name: r.name } : a)) }; publish(); }
      return r;
    },
    send(id, text) {
      messages = { ...messages, [id]: [...(messages[id] || []), { role: 'user', text, ts: new Date().toISOString(), tool: false }] };
      publish();
      say({ t: 'send', id, text });
    },
    answer(id, option) { say({ t: 'send', id, text: option }); },
    stop(id) { say({ t: 'stop', id }); },
    keys(id, keys) { say({ t: 'keys', id, keys }); },
    type(id, text) { say({ t: 'send', id, text }); }, // a shell: typed as is, no chat bubble
    // resolves with the new agent's id once it is running on the computer (null if it did not start)
    // a link or file from an agent's chat, opened through a tunnel on the computer: resolves once it is live
    share(id, target) { return request({ t: 'share', id, target }, 90_000); }, // a tunnel plus its name appearing in DNS: about 10 s, at most about 70
    extend(share) { return request({ t: 'extend', share }, 20_000); },
    unshare(share) { say({ t: 'unshare', share }); snap = { ...snap, shares: snap.shares.filter((s) => s.id !== share) }; publish(); },
    spawn({ cwd, kind, prompt }) {
      const req = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const done = new Promise((resolve) => {
        waiting.set(req, resolve);
        setTimeout(() => { if (waiting.delete(req)) resolve(null); }, 60_000);
      });
      say({ t: 'spawn', req, cwd, kind, prompt });
      return done;
    },
  };
}
