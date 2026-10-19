// The phone's end of app/phone.mjs: pair through the relay with the code from the QR, then talk to the
// computer in sealed boxes. Plain JS with fetch and tweetnacl only, so it runs in the app and in Node tests.
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';

export const setRandom = (fn) => nacl.setPRNG((x, n) => x.set(fn(n)));

const fromUrl64 = (s) => util.decodeBase64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

// synapse://pair?r=<relay>&c=<invite>&k=<key>&n=<computer name>
export function parsePairing(text) {
  const m = /^synapse:\/\/pair\?(.+)$/.exec(String(text || '').trim());
  if (!m) return null;
  const dec = (v) => decodeURIComponent(v.replace(/\+/g, ' '));
  const q = Object.fromEntries(m[1].split('&').map((kv) => { const i = kv.indexOf('='); return [dec(kv.slice(0, i)), dec(kv.slice(i + 1))]; }));
  if (!q.r || !q.c || !q.k || !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(q.r)) return null; // a local relay only for tests
  const key = fromUrl64(q.k);
  if (key.length !== 32) return null;
  return { relay: q.r.replace(/\/+$/, ''), code: q.c, key: util.encodeBase64(key), name: q.n || 'computer' };
}

async function call(relay, route, body, token) {
  const r = await fetch(relay + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `relay answered ${r.status}`), { status: r.status });
  return j;
}

// register this phone with the relay and join the computer's invite: returns everything needed later
export async function pair(p, phoneName) {
  const { machineId, token } = await call(p.relay, '/v1/register', { name: phoneName });
  const { peer, pair: pairToken } = await call(p.relay, '/v1/join', { code: p.code, name: phoneName }, token);
  return { relay: p.relay, key: p.key, computer: p.name, me: machineId, token, peer: peer.machineId, pair: pairToken };
}

const mid = () => util.encodeBase64(nacl.randomBytes(12));

export function seal(key, msg) {
  const n = nacl.randomBytes(24);
  const body = util.decodeUTF8(JSON.stringify({ ...msg, ts: Date.now(), mid: mid() }));
  return { type: 'box', n: util.encodeBase64(n), c: util.encodeBase64(nacl.secretbox(body, n, util.decodeBase64(key))) };
}

export function unseal(key, item) {
  if (item?.type !== 'box') return null;
  try {
    const m = nacl.secretbox.open(util.decodeBase64(item.c), util.decodeBase64(item.n), util.decodeBase64(key));
    return m ? JSON.parse(util.encodeUTF8(m)) : null;
  } catch { return null; }
}

// one paired computer: send sealed messages, poll for the ones it sent (only from it, only ones that open)
export function connect(link) {
  return {
    send: (msg) => call(link.relay, '/v1/send', { to: link.peer, pair: link.pair, items: [seal(link.key, msg)] }, link.token),
    async poll() {
      const { items } = await call(link.relay, '/v1/poll', {}, link.token);
      return items.filter((it) => it.from === link.peer).map((it) => unseal(link.key, it)).filter(Boolean);
    },
  };
}
