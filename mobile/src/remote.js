// The paired computer as a source: its agents and workspaces, kept fresh by polling the relay while the app
// is in front, plus the actions the screens call. Same shape as the demo source.
import { AppState } from 'react-native';
import { connect } from './link';

const FAST = 1500, PING = 30_000;

export function createRemote(emit, link) {
  const conn = connect(link);
  let state = { agents: [], projects: [], kinds: [], computer: link.computer, online: false, error: null };
  let snap = { agents: [], projects: [], kinds: [] };
  let watch = null, messages = {}, lastSeen = 0, lastPing = 0, timer = null, stopped = false;
  const waiting = new Map(); // spawn request -> resolve

  const publish = () => {
    const agents = snap.agents.map((a) => ({ ...a, needs: null, messages: messages[a.id] || [] }));
    state = { ...state, agents, projects: snap.projects, kinds: snap.kinds, online: Date.now() - lastSeen < 15_000 };
    emit(state);
  };
  const fail = (e) => { state = { ...state, error: e.message }; emit(state); setTimeout(() => { state = { ...state, error: null }; emit(state); }, 5000); };
  const say = (msg) => conn.send(msg).catch(fail);

  function receive(m) {
    lastSeen = Date.now();
    if (m.t === 'state') snap = { agents: m.agents || [], projects: m.projects || [], kinds: m.kinds || [] };
    else if (m.t === 'messages') messages = { ...messages, [m.id]: m.messages || [] };
    else if (m.t === 'spawned') { waiting.get(m.req)?.(m.id); waiting.delete(m.req); }
    else if (m.t === 'error') { if (m.req && waiting.has(m.req)) { waiting.get(m.req)(null); waiting.delete(m.req); } fail(new Error(m.error)); }
  }

  async function tick() {
    if (stopped) return;
    try {
      if (Date.now() - lastPing > PING) { lastPing = Date.now(); await conn.send({ t: 'ping' }); }
      for (const m of await conn.poll()) receive(m);
      publish();
    } catch (e) { if (e.status === 401) fail(new Error('the relay no longer knows this phone: pair again')); }
    if (AppState.currentState === 'active') timer = setTimeout(tick, FAST);
  }
  const wake = () => { clearTimeout(timer); lastPing = Date.now(); say({ t: 'hello' }).then(tick); if (watch) say({ t: 'watch', id: watch }); };
  const sub = AppState.addEventListener('change', (s) => { if (s === 'active') wake(); else clearTimeout(timer); });
  wake();
  emit(state);

  return {
    name: 'paired',
    close() { stopped = true; clearTimeout(timer); sub.remove(); conn.send({ t: 'bye' }).catch(() => {}); },
    forget: () => conn.send({ t: 'unpair' }).catch(() => {}),
    watch(id) { watch = id; say({ t: 'watch', id }); },
    send(id, text) {
      messages = { ...messages, [id]: [...(messages[id] || []), { role: 'user', text, ts: new Date().toISOString(), tool: false }] };
      publish();
      say({ t: 'send', id, text });
    },
    answer(id, option) { say({ t: 'send', id, text: option }); },
    stop(id) { say({ t: 'stop', id }); },
    // resolves with the new agent's id once it is running on the computer (null if it did not start)
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
