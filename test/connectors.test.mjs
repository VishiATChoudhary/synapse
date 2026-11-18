// Connectors: OAuth sign-in (discovery, registration, PKCE), refresh, the bridge an agent runs, and the agents'
// configs Synapse writes them into. A stand-in server plays both the MCP server and its authorization server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-connectors-')));
const home = path.join(tmp, 'home'), data = path.join(tmp, 'data'), bin = path.join(tmp, 'bin');
for (const d of [path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.config', 'opencode'), data, bin]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, { SYNAPSE_HOME: data, SYNAPSE_USER_HOME: home, SYNAPSE_CONNECTOR_SECRETS: path.join(data, 'secrets.json'), CODEX_HOME: path.join(home, '.codex') });
// a stand-in claude CLI: mcp add-json / remove edit ~/.claude.json like the real one
const claudeJson = path.join(home, '.claude.json');
fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { whatsapp: { type: 'http', url: 'https://askparrot.app/mcp' } } }));
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), f = ${JSON.stringify(claudeJson)}, d = JSON.parse(fs.readFileSync(f, 'utf8')), a = process.argv.slice(2);
d.mcpServers ||= {};
if (a[1] === 'add-json') d.mcpServers[a[4]] = JSON.parse(a[5]);
if (a[1] === 'remove') delete d.mcpServers[a[4]];
fs.writeFileSync(f, JSON.stringify(d));
`, { mode: 0o755 });
fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n\n[mcp_servers.vishlang]\ncommand = "vishlang"\n\n[mcp_servers.vishlang.tools.a]\napproval_mode = "approve"\n');
fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ model: 'a/b', mcp: { synapse: { type: 'local', command: ['node', 'mcp.mjs'] } } }));

const C = await import(path.join(ROOT, 'connectors.mjs'));

// ---- the stand-in server
const codes = new Map(), seen = [];
let issued = 0, sessionId = 'sess-1';
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const ch of req) body += ch;
  const u = new URL(req.url, origin), j = (code, v, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(v)); };
  if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return j(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['read'] });
  if (u.pathname === '/.well-known/oauth-authorization-server') return j(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` });
  if (u.pathname === '/register') { const r = JSON.parse(body); return j(201, { client_id: `client-${r.redirect_uris[0].split(':')[2].split('/')[0]}` }); }
  if (u.pathname === '/authorize') {
    const p = u.searchParams; assert.equal(p.get('code_challenge_method'), 'S256'); assert.equal(p.get('resource'), `${origin}/mcp`); assert.equal(p.get('scope'), 'read');
    const code = crypto.randomUUID(); codes.set(code, p.get('code_challenge'));
    res.writeHead(302, { location: `${p.get('redirect_uri')}?code=${code}&state=${p.get('state')}` }); return res.end();
  }
  if (u.pathname === '/token') {
    const p = new URLSearchParams(body);
    if (p.get('grant_type') === 'authorization_code') {
      const challenge = crypto.createHash('sha256').update(p.get('code_verifier')).digest('base64url');
      if (codes.get(p.get('code')) !== challenge) return j(400, { error: 'invalid_grant' });
      return j(200, { access_token: `tok${++issued}`, refresh_token: 'refresh-1', expires_in: 3600 });
    }
    if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'refresh-1') return j(200, { access_token: `tok${++issued}`, expires_in: 3600 });
    return j(400, { error: 'invalid_grant' });
  }
  if (u.pathname === '/mcp' && req.method === 'POST') {
    const auth = req.headers.authorization || '';
    seen.push({ auth, session: req.headers['mcp-session-id'] || null, body });
    if (auth !== `Bearer tok${issued}` || !issued) return j(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
    const msg = JSON.parse(body);
    if (msg.method === 'initialize') { res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': sessionId }); res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stand-in' } } })}\n\n`); return res.end(); }
    if (!msg.id) { res.writeHead(202); return res.end(); }
    return j(200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'hello', session: req.headers['mcp-session-id'] }] } });
  }
  if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
  j(404, {});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// the bridge, as an agent runs it: messages in, answers out
function bridge(id, messages) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'connector-bridge.mjs'), id], { env: process.env });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.split('\n').filter(Boolean).length >= messages.filter((m) => m.id !== undefined).length) p.stdin.end(); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => resolve({ out: out.split('\n').filter(Boolean).map((l) => JSON.parse(l)), err }));
    p.on('error', reject);
    for (const m of messages) p.stdin.write(`${JSON.stringify(m)}\n`);
    setTimeout(() => p.kill(), 8000);
  });
}
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

test('two accounts of one service are two connectors, each signs in on its own (discovery, registration, PKCE)', async () => {
  const work = C.add({ preset: 'custom', name: 'Linear Work', url: `${origin}/mcp`, auth: 'oauth' });
  const home2 = C.add({ preset: 'custom', name: 'linear-home', url: `${origin}/mcp`, auth: 'oauth' });
  assert.equal(work.name, 'linear-work');
  assert.throws(() => C.add({ preset: 'custom', name: 'linear-work', url: `${origin}/mcp` }), /already a connector/);
  assert.throws(() => C.add({ preset: 'custom', name: 'x', url: 'http://example.com/mcp' }), /https/);
  assert.equal(C.status(work), 'needs-login');
  const opened = [];
  await C.login(work.id, async (url) => { opened.push(url); await fetch(url); });
  assert.equal(C.status(C.get(work.id)), 'ready');
  assert.equal(C.status(C.get(home2.id)), 'needs-login', 'the other account is not signed in by the first');
  assert.match(opened[0], /code_challenge=/);
  assert.equal(C.getSecret(work.id).tokens.access_token, 'tok1');
});

test('the bridge forwards MCP messages with the token and the session, and answers from an event stream', async () => {
  const id = C.get('linear-work').id;
  const { out, err } = await bridge(id, [INIT, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  assert.equal(err, '');
  assert.equal(out[0].result.serverInfo.name, 'stand-in');
  assert.equal(out[1].result.tools[0].session, 'sess-1', 'later messages carry the session id');
});

test('a token the server refuses is refreshed once and the message sent again', async () => {
  const id = C.get('linear-work').id;
  issued++; // the server moved on: tok1 is refused, the refresh gives the current one
  const { out } = await bridge(id, [INIT]);
  assert.equal(out[0].result.serverInfo.name, 'stand-in');
  assert.equal(C.getSecret(id).tokens.access_token, `tok${issued}`);
});

test('a connector that is not signed in answers the agent with what to do', async () => {
  const { out } = await bridge(C.get('linear-home').id, [INIT]);
  assert.match(out[0].error.message, /needs signing in again: Synapse > Settings > Connectors/);
});

test('sync writes ready connectors into Claude, Codex and OpenCode, and takes out only its own', async () => {
  const node = '/x/synapse-node', bridgePath = path.join(ROOT, 'connector-bridge.mjs');
  const keyed = C.add({ preset: 'github', name: 'github-me', auth: 'bearer', token: 'ghp_x' });
  C.update(keyed.id, { agents: { opencode: false } });
  const report = C.sync({ node, bridge: bridgePath, claude: path.join(bin, 'claude') });
  assert.ok(report.length, 'something was written');
  const claude = JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(claude).sort(), ['github-me', 'linear-work', 'whatsapp'], 'not-signed-in linear-home is left out; whatsapp untouched');
  assert.deepEqual(claude['linear-work'].args, [bridgePath, C.get('linear-work').id]);
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /# synapse-connector linear-work\n\[mcp_servers\.linear-work\]\ncommand = "\/x\/synapse-node"/);
  assert.match(toml, /\[mcp_servers\.vishlang\.tools\.a\]/, 'the user’s own tables stay');
  const oc = JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.deepEqual(Object.keys(oc.mcp).sort(), ['linear-work', 'synapse'], 'github-me is off for OpenCode');
  assert.equal(oc.model, 'a/b');
  assert.deepEqual(C.sync({ node, bridge: bridgePath, claude: path.join(bin, 'claude') }), [], 'a second sync changes nothing');

  // removed: gone from every agent; the user's own entries stay
  C.remove(keyed.id); C.update(C.get('linear-work').id, { enabled: false });
  C.sync({ node, bridge: bridgePath, claude: path.join(bin, 'claude') });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers), ['whatsapp']);
  const toml2 = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.doesNotMatch(toml2, /linear-work|github-me/); assert.match(toml2, /\[mcp_servers\.vishlang\]/);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8')).mcp), ['synapse']);
  assert.equal(C.getSecret(keyed.id), null, 'its secret is gone too');
});

test('an agent’s own server can be brought in, so every agent gets it', () => {
  const inv = C.inventory();
  assert.equal(inv.claude.whatsapp.managed, false);
  const c = C.adopt('claude', 'whatsapp');
  assert.equal(c.url, 'https://askparrot.app/mcp'); assert.equal(c.auth, 'oauth');
  assert.equal(C.status(c), 'needs-login', 'until signed in here, Claude keeps its own entry');
});
