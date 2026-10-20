// The phone's end of app/phone.mjs, through Synapse Cloud: sign in, register this phone as a device of the
// account with a public key, find the account's computers, and talk to one in sealed boxes (NaCl box).
// Plain JS with fetch and tweetnacl only, so it runs in the app and in Node tests.
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';

export const DEFAULT_CLOUD = process.env.EXPO_PUBLIC_SYNAPSE_CLOUD || 'https://app.heysynapse.dev'; // a local cloud while developing
export const setRandom = (fn) => nacl.setPRNG((x, n) => x.set(fn(n)));

export async function api(cloud, method, route, { body, token } = {}) {
  let r;
  try {
    r = await fetch(cloud + route, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error('Could not reach Synapse. Check your connection.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Synapse answered ${r.status}`), { status: r.status });
  return j;
}

// sign in (or create the account), then register this phone: everything the app keeps in the keychain
export async function signIn(cloud, { email, password, name, create }, phoneName) {
  const route = create ? '/v1/auth/signup' : '/v1/auth/login';
  const { token, user } = await api(cloud, 'POST', route, { body: { email, password, name, client: 'phone', label: phoneName } });
  const keys = nacl.box.keyPair();
  const publicKey = util.encodeBase64(keys.publicKey);
  const m = await api(cloud, 'POST', '/v1/register', { token, body: { kind: 'phone', name: phoneName, publicKey } });
  return { cloud, session: token, user, me: m.machineId, machine: m.token, publicKey, secretKey: util.encodeBase64(keys.secretKey) };
}

// signing out takes this phone off the account's devices, so no computer accepts it any more
export async function signOut(acc) {
  await api(acc.cloud, 'DELETE', `/v1/machines/${acc.me}`, { token: acc.session }).catch(() => {});
  await api(acc.cloud, 'POST', '/v1/auth/logout', { body: {}, token: acc.session }).catch(() => {});
}

export const computers = async (acc) => (await api(acc.cloud, 'GET', '/v1/machines', { token: acc.session })).machines.filter((m) => m.kind === 'computer');

const mid = () => util.encodeBase64(nacl.randomBytes(12));

export function seal(acc, theirKey, msg) {
  const n = nacl.randomBytes(24);
  const body = util.decodeUTF8(JSON.stringify({ ...msg, ts: Date.now(), mid: mid() }));
  return { type: 'box', n: util.encodeBase64(n), c: util.encodeBase64(nacl.box(body, n, util.decodeBase64(theirKey), util.decodeBase64(acc.secretKey))) };
}

export function unseal(acc, theirKey, item) {
  if (item?.type !== 'box') return null;
  try {
    const m = nacl.box.open(util.decodeBase64(item.c), util.decodeBase64(item.n), util.decodeBase64(theirKey), util.decodeBase64(acc.secretKey));
    return m ? JSON.parse(util.encodeUTF8(m)) : null;
  } catch { return null; }
}

// one computer of the account: send sealed messages, poll for the ones it sent (only from it, only ones that open)
export function connect(acc, computer) {
  return {
    send: (msg) => api(acc.cloud, 'POST', '/v1/send', { token: acc.machine, body: { to: computer.id, items: [seal(acc, computer.publicKey, msg)] } }),
    async poll() {
      const { items } = await api(acc.cloud, 'POST', '/v1/poll', { token: acc.machine, body: {} });
      return items.filter((it) => it.from === computer.id).map((it) => unseal(acc, computer.publicKey, it)).filter(Boolean);
    },
  };
}
