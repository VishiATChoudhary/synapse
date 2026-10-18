// Sign in with GitHub, Google and X (OAuth 2.0 authorization code, PKCE where the provider takes it).
// A provider is on when its client id and secret are set. OAUTH_MOCK_BASE points every endpoint at a fake
// provider for tests.
import crypto from 'node:crypto';

const MOCK = process.env.OAUTH_MOCK_BASE;
const ep = (provider, real) => (MOCK ? Object.fromEntries(Object.keys(real).map((k) => [k, `${MOCK}/${provider}/${k}`])) : real);

const PROVIDERS = {
  github: {
    id: () => process.env.GITHUB_CLIENT_ID, secret: () => process.env.GITHUB_CLIENT_SECRET,
    urls: ep('github', { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', user: 'https://api.github.com/user', emails: 'https://api.github.com/user/emails' }),
    scope: 'read:user user:email', pkce: false,
    async profile(token, u) {
      const h = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'synapse-cloud' };
      const me = await getJSON(u.user, h);
      let email = null, emailVerified = false;
      try {
        const list = await getJSON(u.emails, h);
        const pick = list.find((e) => e.primary && e.verified) || list.find((e) => e.verified);
        if (pick) { email = pick.email; emailVerified = true; }
      } catch {}
      return { id: String(me.id), email, emailVerified, name: me.name || me.login, username: me.login, avatar: me.avatar_url };
    },
  },
  google: {
    id: () => process.env.GOOGLE_CLIENT_ID, secret: () => process.env.GOOGLE_CLIENT_SECRET,
    urls: ep('google', { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', user: 'https://openidconnect.googleapis.com/v1/userinfo' }),
    scope: 'openid email profile', pkce: true, extra: { prompt: 'select_account' },
    async profile(token, u) {
      const me = await getJSON(u.user, { authorization: `Bearer ${token}` });
      return { id: String(me.sub), email: me.email || null, emailVerified: !!me.email_verified, name: me.name || me.email, username: me.email?.split('@')[0], avatar: me.picture };
    },
  },
  x: {
    id: () => process.env.X_CLIENT_ID, secret: () => process.env.X_CLIENT_SECRET,
    urls: ep('x', { authorize: 'https://x.com/i/oauth2/authorize', token: 'https://api.x.com/2/oauth2/token', user: 'https://api.x.com/2/users/me' }),
    scope: 'users.read tweet.read users.email', pkce: true, basicAuth: true,
    async profile(token, u) {
      const { data: me } = await getJSON(`${u.user}?user.fields=profile_image_url,confirmed_email`, { authorization: `Bearer ${token}` });
      // X only returns an email the user confirmed, and only to apps allowed to ask for it
      return { id: String(me.id), email: me.confirmed_email || null, emailVerified: !!me.confirmed_email, name: me.name || me.username, username: me.username, avatar: me.profile_image_url?.replace('_normal', '_400x400') };
    },
  },
};

export const providerNames = Object.keys(PROVIDERS);
export const configured = (p) => !!(PROVIDERS[p]?.id() && PROVIDERS[p]?.secret());
export const providerStatus = () => Object.fromEntries(providerNames.map((p) => [p, configured(p)]));

async function getJSON(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

const b64url = (b) => Buffer.from(b).toString('base64url');
export function newPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

export function authorizeUrl(provider, { state, challenge, redirect }) {
  const p = PROVIDERS[provider];
  const q = new URLSearchParams({ client_id: p.id(), redirect_uri: redirect, response_type: 'code', scope: p.scope, state, ...(p.extra || {}) });
  if (p.pkce) { q.set('code_challenge', challenge); q.set('code_challenge_method', 'S256'); }
  return `${p.urls.authorize}?${q}`;
}

export async function exchange(provider, { code, verifier, redirect }) {
  const p = PROVIDERS[provider];
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect });
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (p.basicAuth) headers.authorization = `Basic ${Buffer.from(`${p.id()}:${p.secret()}`).toString('base64')}`;
  else { form.set('client_id', p.id()); form.set('client_secret', p.secret()); }
  if (p.pkce) form.set('code_verifier', verifier);
  if (p.basicAuth) form.set('client_id', p.id());
  const r = await fetch(p.urls.token, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(10_000) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok || !out.access_token) throw new Error(`${provider} sign-in failed: ${out.error_description || out.error || r.status}`);
  return p.profile(out.access_token, p.urls);
}
