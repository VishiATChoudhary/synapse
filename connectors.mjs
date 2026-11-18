// Connectors: MCP servers you set up once in Synapse (Settings > Connectors) and every agent gets: Claude Code,
// Codex and OpenCode. Each connector is one account, so two Linear workspaces or three Gmail inboxes are three
// connectors with their own names (linear-work, linear-home, ...).
//
// Agents never hold the secrets. Their config points at connector-bridge.mjs <id>, which reads the token from the
// keychain (refreshing it when it runs out) and forwards the agent's MCP messages to the server. OAuth follows the
// MCP spec: discovery from the server, dynamic client registration, PKCE; servers without registration (Gmail)
// take a client id and secret you create in their console.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = () => process.env.SYNAPSE_USER_HOME || os.homedir();
const DATA = () => process.env.SYNAPSE_HOME || path.join(os.homedir(), '.synapse');
const FILE = () => path.join(DATA(), 'connectors.json');
const WIN = process.platform === 'win32';
export const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;

// What the add form offers. Anything else is a custom URL or command.
export const PRESETS = {
  linear: { label: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth', keyHint: 'Or a personal API key (Linear > Settings > Security & access)' },
  gmail: { label: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1', auth: 'oauth', client: true, scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose', note: 'Google’s Gmail MCP is in developer preview: create an OAuth client (Desktop app) in Google Cloud and paste its id and secret.' },
  notion: { label: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth' },
  github: { label: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', auth: 'bearer', keyHint: 'A personal access token' },
  sentry: { label: 'Sentry', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth' },
  atlassian: { label: 'Atlassian', url: 'https://mcp.atlassian.com/v1/mcp', auth: 'oauth' },
  custom: { label: 'Custom', url: '', auth: 'oauth' },
};

// ---------------------------------------------------------------- registry

const readJSON = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, f); };
export const list = () => (readJSON(FILE(), []) || []).filter((c) => c && c.id && NAME.test(c.name));
const saveList = (l) => writeJSON(FILE(), l);
export const get = (id) => list().find((c) => c.id === id || c.name === id) || null;

// ---------------------------------------------------------------- secrets
// macOS: the login keychain, through the security tool so the bridge (run by the agents) can read it too.
// Elsewhere, and in tests: a file only you can read.
const SERVICE = 'synapse-connectors';
const secretFile = () => process.env.SYNAPSE_CONNECTOR_SECRETS || (process.platform === 'darwin' ? null : path.join(DATA(), 'connector-secrets.json'));
export function getSecret(id) {
  const f = secretFile();
  if (f) return readJSON(f, {})[id] || null;
  try { return JSON.parse(execFileSync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', id, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { return null; }
}
export function setSecret(id, value) {
  const f = secretFile();
  if (f) { const all = readJSON(f, {}); if (value) all[id] = value; else delete all[id]; writeJSON(f, all); return; }
  if (!value) { spawnSync('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', id], { stdio: 'ignore' }); return; }
  const r = spawnSync('/usr/bin/security', ['add-generic-password', '-U', '-s', SERVICE, '-a', id, '-l', `Synapse connector ${id}`, '-w', JSON.stringify(value)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Could not save to the keychain: ${(r.stderr || '').trim()}`);
}
const patchSecret = (id, patch) => setSecret(id, { ...(getSecret(id) || {}), ...patch });

// ---------------------------------------------------------------- add, change, remove

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
export function add(input) {
  const preset = PRESETS[input.preset] || PRESETS.custom;
  const transport = input.transport === 'stdio' ? 'stdio' : 'http';
  const name = slug(input.name || `${input.preset || 'mcp'}`);
  if (!NAME.test(name)) throw new Error('Give it a name: letters, numbers, - and _ (like linear-work).');
  if (name === 'synapse') throw new Error('“synapse” is taken by Synapse itself. Pick another name.');
  if (list().some((c) => c.name === name)) throw new Error(`There is already a connector called ${name}.`);
  const c = { id: `c${crypto.randomBytes(5).toString('hex')}`, name, label: String(input.label || preset.label || name).slice(0, 80), preset: input.preset || 'custom', transport, agents: { claude: true, codex: true, opencode: true, ...(input.agents || {}) }, enabled: true, created: Date.now() };
  if (transport === 'http') {
    const url = String(input.url || preset.url || '').trim();
    let u; try { u = new URL(url); } catch { throw new Error('Enter the server’s URL (https://…).'); }
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('The server URL must use https.');
    c.url = u.href;
    c.auth = ['oauth', 'bearer', 'none'].includes(input.auth) ? input.auth : preset.auth;
    if (input.scope || preset.scope) c.scope = String(input.scope || preset.scope).slice(0, 2000);
    const headers = input.headers && typeof input.headers === 'object' ? Object.fromEntries(Object.entries(input.headers).filter(([k, v]) => /^[\w-]{1,60}$/.test(k) && typeof v === 'string').slice(0, 20)) : {};
    if (Object.keys(headers).length) c.headers = Object.keys(headers); // the values are secrets
    const secret = {};
    if (c.auth === 'bearer') { if (!String(input.token || '').trim()) throw new Error('Paste the API key or token.'); secret.token = String(input.token).trim(); }
    if (input.clientId) secret.client = { id: String(input.clientId).trim(), secret: String(input.clientSecret || '').trim() || undefined, given: true };
    if (Object.keys(headers).length) secret.headers = headers;
    if (Object.keys(secret).length) setSecret(c.id, secret);
  } else {
    const command = String(input.command || '').trim();
    if (!command) throw new Error('Enter the command that starts the server.');
    c.command = command;
    c.args = Array.isArray(input.args) ? input.args.map(String) : String(input.args || '').match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) || [];
    const env = input.env && typeof input.env === 'object' ? Object.fromEntries(Object.entries(input.env).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string')) : {};
    if (Object.keys(env).length) { c.env = Object.keys(env); setSecret(c.id, { env }); }
    c.auth = 'none';
  }
  saveList([...list(), c]);
  return c;
}
export function update(id, patch) {
  const l = list(), c = l.find((x) => x.id === id);
  if (!c) throw new Error('That connector is gone.');
  if ('enabled' in patch) c.enabled = !!patch.enabled;
  if (patch.agents) for (const k of ['claude', 'codex', 'opencode']) if (k in patch.agents) c.agents[k] = !!patch.agents[k];
  if (typeof patch.label === 'string' && patch.label.trim()) c.label = patch.label.trim().slice(0, 80);
  if (typeof patch.token === 'string' && patch.token.trim() && c.auth === 'bearer') patchSecret(c.id, { token: patch.token.trim() });
  saveList(l);
  return c;
}
export function remove(id) {
  const c = get(id);
  saveList(list().filter((x) => x.id !== id));
  if (c) setSecret(c.id, null);
  return c;
}

// Whether a connector can be used: a token for OAuth and bearer ones (OAuth: until a refresh fails).
export function status(c) {
  if (!c.enabled) return 'off';
  if (c.transport === 'stdio' || c.auth === 'none') return 'ready';
  const s = getSecret(c.id) || {};
  if (c.auth === 'bearer') return s.token ? 'ready' : 'needs-key';
  if (s.broken) return 'reconnect';
  return s.tokens?.access_token ? 'ready' : 'needs-login';
}
export const view = (c) => {
  const s = getSecret(c.id) || {};
  return { ...c, status: status(c), account: s.account || null, expires: s.tokens?.expires_at || null, hasClient: !!s.client?.given };
};

// ---------------------------------------------------------------- OAuth (MCP authorization)

const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error(`${r.url} answered ${r.status}: ${t.slice(0, 200)}`); } };
async function firstJSON(urls) {
  for (const u of urls) {
    try { const r = await fetch(u, { headers: { accept: 'application/json' } }); if (r.ok) return await r.json(); } catch {}
  }
  return null;
}
// Where to sign in for a server: its protected-resource metadata (from the 401 or the well-known path) names the
// authorization server; that server's metadata has the endpoints.
export async function discover(serverUrl) {
  const u = new URL(serverUrl);
  let resourceMeta = null;
  try {
    const r = await fetch(serverUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Synapse', version: '1' } } }) });
    const m = /resource_metadata="([^"]+)"/.exec(r.headers.get('www-authenticate') || '');
    if (m) resourceMeta = await firstJSON([new URL(m[1], serverUrl).href]);
  } catch {}
  const trimmed = u.pathname.replace(/\/$/, '');
  resourceMeta ||= await firstJSON([`${u.origin}/.well-known/oauth-protected-resource${trimmed}`, `${u.origin}/.well-known/oauth-protected-resource`]);
  const issuer = new URL(resourceMeta?.authorization_servers?.[0] || u.origin);
  const ip = issuer.pathname.replace(/\/$/, '');
  const meta = await firstJSON([
    `${issuer.origin}/.well-known/oauth-authorization-server${ip}`, `${issuer.origin}/.well-known/openid-configuration${ip}`,
    ...(ip ? [`${issuer.origin}${ip}/.well-known/openid-configuration`, `${issuer.origin}/.well-known/oauth-authorization-server`] : []),
  ]);
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) throw new Error(`${u.host} does not say where to sign in (no OAuth metadata). Use an API key instead.`);
  return { ...meta, resource: resourceMeta?.resource || serverUrl, scopes: resourceMeta?.scopes_supported || meta.scopes_supported || [] };
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// Sign in for one connector. open(url) shows the sign-in page (the app: a window or the browser); resolves once the
// server sent the browser back with a code and it was traded for tokens.
export async function login(id, open, { timeout = 5 * 60_000 } = {}) {
  const c = get(id);
  if (!c || c.transport !== 'http' || c.auth !== 'oauth') throw new Error('That connector does not sign in with OAuth.');
  const meta = await discover(c.url);
  const s = getSecret(c.id) || {};
  const state = b64url(crypto.randomBytes(16)), verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  try {
    let client = s.client?.given ? s.client : null;
    if (!client) {
      if (!meta.registration_endpoint) throw new Error(`${new URL(c.url).host} needs an OAuth client: create one in its console and add the connector again with its client id and secret.`);
      const reg = await json(await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ client_name: `Synapse (${c.name})`, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) }));
      if (!reg.client_id) throw new Error(`Registering with ${new URL(meta.registration_endpoint).host} failed: ${reg.error_description || reg.error || 'no client id'}`);
      client = { id: reg.client_id, secret: reg.client_secret || undefined };
    }
    const scope = c.scope || (meta.scopes.length ? meta.scopes.join(' ') : '');
    const google = /(^|\.)google\.com$/.test(new URL(meta.authorization_endpoint).hostname);
    if (google) meta.resource = null; // Google refuses parameters it does not know
    const auth = new URL(meta.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.id, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: 'S256', ...(meta.resource ? { resource: meta.resource } : {}), ...(scope ? { scope } : {}), ...(google ? { access_type: 'offline', prompt: 'consent select_account' } : {}) })) auth.searchParams.set(k, v);
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out. Try again.')), timeout);
      server.on('request', (req, res) => {
        const q = new URL(req.url, redirect);
        if (q.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
        const ok = q.searchParams.get('state') === state && q.searchParams.get('code');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Synapse</title><body style="font:16px -apple-system,system-ui;padding:48px;background:#111;color:#eee">${ok ? `Connected <b>${c.label.replace(/[<&]/g, '')}</b>. You can close this tab and go back to Synapse.` : 'Sign-in did not finish. Go back to Synapse and try again.'}</body>`);
        clearTimeout(timer);
        if (ok) resolve(q.searchParams.get('code'));
        else reject(new Error(q.searchParams.get('error_description') || q.searchParams.get('error') || 'Sign-in was cancelled.'));
      });
      Promise.resolve(open(auth.href, c)).catch(reject);
    });
    const tokens = await exchange(meta.token_endpoint, { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, ...(meta.resource ? { resource: meta.resource } : {}) }, client);
    setSecret(c.id, { ...s, client: { ...client, given: !!s.client?.given }, token_endpoint: meta.token_endpoint, resource: meta.resource, tokens, broken: false, account: accountOf(tokens) || s.account || null });
    return view(get(id));
  } finally { server.close(); server.closeAllConnections?.(); }
}
// Who signed in, when the token says (an id_token or a JWT access token with an email); otherwise unknown.
function accountOf(tokens) {
  for (const t of [tokens.id_token, tokens.access_token]) {
    try { const p = JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()); const who = p.email || p.preferred_username || p.name; if (who) return String(who).slice(0, 120); } catch {}
  }
  return null;
}
async function exchange(endpoint, params, client) {
  const body = new URLSearchParams({ ...params, client_id: client.id, ...(client.secret ? { client_secret: client.secret } : {}) });
  const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  const t = await json(r);
  if (!r.ok || !t.access_token) throw new Error(`Sign-in failed: ${t.error_description || t.error || r.status}`);
  return { access_token: t.access_token, refresh_token: t.refresh_token || params.refresh_token || null, id_token: t.id_token || undefined, expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null };
}
// A usable access token: refreshed when it is about to run out (or force, after the server said 401).
export async function accessToken(id, { force = false } = {}) {
  const c = get(id), s = c && getSecret(c.id);
  if (!c || !s) return null;
  if (c.auth === 'bearer') return s.token || null;
  if (c.auth !== 'oauth' || !s.tokens) return null;
  const fresh = !s.tokens.expires_at || s.tokens.expires_at - Date.now() > 60_000;
  if (fresh && !force) return s.tokens.access_token;
  if (!s.tokens.refresh_token) { patchSecret(c.id, { broken: true }); return null; }
  try {
    const tokens = await exchange(s.token_endpoint, { grant_type: 'refresh_token', refresh_token: s.tokens.refresh_token, ...(s.resource ? { resource: s.resource } : {}) }, s.client);
    patchSecret(c.id, { tokens, broken: false });
    return tokens.access_token;
  } catch { patchSecret(c.id, { broken: true }); return null; }
}

// ---------------------------------------------------------------- the agents' configs

const claudeJson = () => path.join(HOME(), '.claude.json');
const codexToml = () => path.join(process.env.CODEX_HOME || path.join(HOME(), '.codex'), 'config.toml');
const opencodeJson = () => path.join(HOME(), '.config', 'opencode', 'opencode.json');
export const AGENTS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
const installed = { claude: () => fs.existsSync(path.join(HOME(), '.claude')) || fs.existsSync(claudeJson()), codex: () => fs.existsSync(path.dirname(codexToml())), opencode: () => fs.existsSync(path.dirname(opencodeJson())) };

// Codex TOML: the [mcp_servers.<name>] table and its sub-tables
const tomlKey = (n) => (/^[A-Za-z0-9_-]+$/.test(n) ? n : JSON.stringify(n));
function tomlTables(toml) {
  const out = new Map();
  for (const m of toml.matchAll(/^\[mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)(\.[^\]]*)?\]\s*$/gm)) {
    const name = m[1].replace(/^"|"$/g, '');
    if (!out.has(name)) out.set(name, { managed: false });
  }
  for (const m of toml.matchAll(/^# synapse-connector (\S+)$/gm)) if (out.has(m[1])) out.get(m[1]).managed = true;
  return out;
}
function tomlWithout(toml, name) {
  const lines = toml.split('\n'), out = [];
  const head = new RegExp(`^\\[mcp_servers\\.(?:${name.replace(/[-]/g, '\\-')}|"${name}")(?:\\.[^\\]]*)?\\]\\s*$`);
  let skip = false;
  for (const l of lines) {
    if (l === `# synapse-connector ${name}`) { skip = true; continue; }
    if (/^\[/.test(l)) skip = head.test(l);
    if (!skip) out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// What each agent has set up now: name -> { managed (ours), how (a short description) }
export function inventory() {
  const result = {};
  if (installed.claude()) {
    const d = readJSON(claudeJson(), {}) || {};
    result.claude = Object.fromEntries(Object.entries(d.mcpServers || {}).map(([n, v]) => [n, { managed: /connector-bridge\.mjs/.test(JSON.stringify(v.args || [])), how: v.url || [v.command, ...(v.args || [])].filter(Boolean).join(' '), def: v }]));
  }
  if (installed.codex()) {
    let t = ''; try { t = fs.readFileSync(codexToml(), 'utf8'); } catch {}
    result.codex = Object.fromEntries([...tomlTables(t)].map(([n, v]) => [n, { managed: v.managed, how: '' }]));
  }
  if (installed.opencode()) {
    const d = readJSON(opencodeJson(), null);
    result.opencode = d ? Object.fromEntries(Object.entries(d.mcp || {}).filter(([, v]) => v && typeof v === 'object' && (v.type || v.command || v.url)).map(([n, v]) => [n, { managed: /connector-bridge\.mjs/.test(JSON.stringify(v.command || [])), how: v.url || (v.command || []).join(' '), def: v }])) : {};
  }
  return result;
}

// Write every ready connector into the agents it is for, and take out the ones that are gone, off or not for that
// agent any more. Only entries Synapse made are ever removed. node + bridge: how an agent starts the bridge.
export function sync({ node, bridge, claude = 'claude', env = process.env }) {
  const report = [], want = new Map();
  for (const c of list()) if (status(c) === 'ready') want.set(c.name, c);
  const inv = inventory();
  const def = (c) => ({ command: node, args: [bridge, c.id] });

  if (inv.claude) {
    for (const [n, e] of Object.entries(inv.claude)) {
      const c = want.get(n);
      if (e.managed && (!c || !c.agents.claude)) { spawnSync(claude, ['mcp', 'remove', '-s', 'user', n], { stdio: 'ignore', shell: WIN, env }); report.push(`claude: removed ${n}`); }
    }
    for (const c of want.values()) {
      if (!c.agents.claude) continue;
      const e = inv.claude[c.name];
      if (e?.managed && JSON.stringify(e.def.args) === JSON.stringify([bridge, c.id]) && e.def.command === node) continue;
      if (e) spawnSync(claude, ['mcp', 'remove', '-s', 'user', c.name], { stdio: 'ignore', shell: WIN, env });
      const r = spawnSync(claude, ['mcp', 'add-json', '-s', 'user', c.name, JSON.stringify({ type: 'stdio', ...def(c) })], { encoding: 'utf8', shell: WIN, env });
      report.push(r.status === 0 ? `claude: added ${c.name}` : `claude: could not add ${c.name}: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`);
    }
  }
  if (inv.codex) {
    const file = codexToml();
    let t = ''; try { t = fs.readFileSync(file, 'utf8'); } catch {}
    const before = t;
    for (const [n, e] of Object.entries(inv.codex)) if (e.managed || (want.has(n) && want.get(n).agents.codex)) t = tomlWithout(t, n);
    for (const c of want.values()) {
      if (!c.agents.codex) continue;
      t = `${t.replace(/\s*$/, '\n')}\n# synapse-connector ${c.name}\n[mcp_servers.${tomlKey(c.name)}]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(bridge)}, ${JSON.stringify(c.id)}]\n`;
    }
    if (t !== before) { if (!fs.existsSync(`${file}.bak-synapse-connectors`) && before) fs.writeFileSync(`${file}.bak-synapse-connectors`, before); fs.writeFileSync(file, t); report.push('codex: updated'); }
  }
  if (inv.opencode) {
    const file = opencodeJson(), d = readJSON(file, null);
    if (d) {
      const before = JSON.stringify(d);
      d.mcp ||= {};
      for (const [n, e] of Object.entries(inv.opencode)) if (e.managed && (!want.get(n)?.agents.opencode)) delete d.mcp[n];
      for (const c of want.values()) if (c.agents.opencode) d.mcp[c.name] = { type: 'local', command: [node, bridge, c.id], enabled: true };
      if (JSON.stringify(d) !== before) { if (!fs.existsSync(`${file}.bak-synapse-connectors`)) fs.copyFileSync(file, `${file}.bak-synapse-connectors`); writeJSON(file, d); report.push('opencode: updated'); }
    } else if (fs.existsSync(file)) report.push('opencode: opencode.json has comments, add connectors there by hand');
  }
  return report;
}

// An MCP server one agent has (not made by Synapse), brought in as a connector so every agent gets it. Local
// commands come over as they are (their env values go to the keychain); URLs need signing in again, since the
// tokens stay with the agent that has them.
export function adopt(agent, name) {
  const e = inventory()[agent]?.[name];
  if (!e || e.managed) throw new Error('Nothing to bring in.');
  if (list().some((c) => c.name === name)) throw new Error(`There is already a connector called ${name}.`);
  const d = e.def || {};
  if (agent === 'codex') throw new Error('Bring Codex servers in by adding them here by hand.');
  if (d.url) return add({ name, label: name, preset: 'custom', url: d.url, auth: d.headers?.Authorization ? 'bearer' : 'oauth', token: String(d.headers?.Authorization || '').replace(/^Bearer\s+/i, '') || undefined });
  const argv = agent === 'opencode' ? d.command || [] : [d.command, ...(d.args || [])];
  return add({ name, label: name, preset: 'custom', transport: 'stdio', command: argv[0], args: argv.slice(1), env: d.env || d.environment || {} });
}

// ---------------------------------------------------------------- Claude Code plugins

const pluginsDir = () => path.join(HOME(), '.claude', 'plugins');
export function plugins() {
  const settings = readJSON(path.join(HOME(), '.claude', 'settings.json'), {}) || {};
  const enabled = settings.enabledPlugins || {};
  const installedList = readJSON(path.join(pluginsDir(), 'installed_plugins.json'), {})?.plugins || {};
  const markets = readJSON(path.join(pluginsDir(), 'known_marketplaces.json'), {}) || {};
  const out = [];
  for (const [market, m] of Object.entries(markets)) {
    const manifest = readJSON(path.join(m.installLocation || path.join(pluginsDir(), 'marketplaces', market), '.claude-plugin', 'marketplace.json'), {});
    for (const p of manifest?.plugins || []) {
      if (!p?.name) continue;
      const id = `${p.name}@${market}`;
      out.push({ id, name: p.name, market, description: String(p.description || '').slice(0, 300), installed: !!installedList[id], enabled: !!enabled[id], version: installedList[id]?.[0]?.version || null });
    }
  }
  for (const id of Object.keys(installedList)) if (!out.some((p) => p.id === id)) { const [name, market] = id.split('@'); out.push({ id, name, market, description: '', installed: true, enabled: !!enabled[id], version: installedList[id]?.[0]?.version || null }); }
  return out.sort((a, b) => (b.installed - a.installed) || a.name.localeCompare(b.name));
}
// install, uninstall, enable, disable: through Claude's own CLI, which knows how
export function pluginAction(action, id, claude = 'claude', env = process.env) {
  if (!['install', 'uninstall', 'enable', 'disable'].includes(action)) throw new Error('Unknown plugin action.');
  if (!/^[\w.-]+@[\w.-]+$/.test(id)) throw new Error('Unknown plugin.');
  return new Promise((resolve, reject) => {
    execFile(claude, ['plugin', action, id, ...(action === 'install' || action === 'uninstall' ? ['--scope', 'user'] : [])], { timeout: 180_000, shell: WIN, env }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim().split('\n').slice(-3).join(' ')));
      else resolve(plugins().find((p) => p.id === id) || null);
    });
  });
}

// node connectors.mjs sync <node> <bridge>: the app runs the sync this way, so the claude CLI calls never block it
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'sync') {
  console.log(sync({ node: process.argv[3], bridge: process.argv[4], claude: process.argv[5] || 'claude' }).join('\n'));
}
