// Real Electron test: Settings > Connectors and Claude plugins. Two accounts of one service (a stand-in OAuth + MCP
// server) are added and signed in, each in its own sign-in window; both reach Claude Code, Codex and OpenCode, one is
// taken away from Codex, one removed. An agent's own server is brought in. A plugin is installed and turned off.
// Run: SYNAPSE_APP_PORT=<free port> ./node_modules/.bin/electron tests/gui-connectors.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-connectors-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), home = path.join(fixture, 'home');
const market = path.join(home, '.claude', 'plugins', 'marketplaces', 'acme');
for (const d of [state, bin, path.join(home, '.codex'), path.join(home, '.config', 'opencode'), path.join(market, '.claude-plugin')]) fs.mkdirSync(d, { recursive: true });
const claudeJson = path.join(home, '.claude.json'), settingsJson = path.join(home, '.claude', 'settings.json'), installedJson = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { tools: { type: 'stdio', command: '/usr/bin/true', args: ['x'], env: { TOKEN: 'abc' } } } }));
fs.writeFileSync(settingsJson, JSON.stringify({ enabledPlugins: {} }));
fs.writeFileSync(installedJson, JSON.stringify({ version: 2, plugins: {} }));
fs.writeFileSync(path.join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ acme: { installLocation: market } }));
fs.writeFileSync(path.join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'linter', description: 'Lints things' }, { name: 'deploy', description: 'Ships things' }] }));
fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n');
fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ mcp: {} }));
// a stand-in claude CLI: mcp add-json/remove and plugin install/enable/disable, the way the real one keeps them
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), a = process.argv.slice(2), rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8')), wr = (f, v) => fs.writeFileSync(f, JSON.stringify(v));
if (a[0] === 'mcp') { const d = rd(${JSON.stringify(claudeJson)}); d.mcpServers ||= {}; if (a[1] === 'add-json') d.mcpServers[a[4]] = JSON.parse(a[5]); if (a[1] === 'remove') delete d.mcpServers[a[4]]; wr(${JSON.stringify(claudeJson)}, d); }
if (a[0] === 'plugin') {
  const s = rd(${JSON.stringify(settingsJson)}), i = rd(${JSON.stringify(installedJson)});
  if (a[1] === 'install') { i.plugins[a[2]] = [{ version: '1.0.0' }]; s.enabledPlugins[a[2]] = true; }
  if (a[1] === 'enable' || a[1] === 'disable') s.enabledPlugins[a[2]] = a[1] === 'enable';
  wr(${JSON.stringify(settingsJson)}, s); wr(${JSON.stringify(installedJson)}, i);
}
`, { mode: 0o755 });
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ onboarding: Date.now() }));
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { shell: { command: '', label: 'shell' } } }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_USER_HOME: home, HOME: home, CODEX_HOME: path.join(home, '.codex'), SYNAPSE_CONNECTOR_SECRETS: path.join(state, 'secrets.json'), SYNAPSE_CLAUDE_CLI: path.join(bin, 'claude'), SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/sh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));

// the stand-in service: its OAuth server signs in whoever comes (account 1, 2, ...), its MCP endpoint wants a token
const codes = new Map();
let accounts = 0;
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const ch of req) body += ch;
  const u = new URL(req.url, origin), j = (code, v, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(v)); };
  if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return j(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
  if (u.pathname === '/.well-known/oauth-authorization-server') return j(200, { authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` });
  if (u.pathname === '/register') return j(201, { client_id: crypto.randomUUID() });
  if (u.pathname === '/authorize') { const p = u.searchParams, code = crypto.randomUUID(); codes.set(code, ++accounts); res.writeHead(302, { location: `${p.get('redirect_uri')}?code=${code}&state=${p.get('state')}` }); return res.end(); }
  if (u.pathname === '/token') { const p = new URLSearchParams(body), who = codes.get(p.get('code')); const payload = Buffer.from(JSON.stringify({ email: `user${who}@example.com` })).toString('base64url'); return j(200, { access_token: `x.${payload}.y`, refresh_token: `r${who}`, expires_in: 3600 }); }
  if (u.pathname === '/mcp') return j(401, {}, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
  j(404, {});
});
let origin;

let win, failed = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const claudeServers = () => Object.keys(rd(claudeJson).mcpServers).sort();
const codexToml = () => fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
const opencodeServers = () => Object.keys(rd(path.join(home, '.config', 'opencode', 'opencode.json')).mcp).sort();
const rows = () => js(`[...document.querySelectorAll('[data-pane="connectors"] .conn-row')].map((r) => ({ name: r.dataset.connector, status: r.dataset.status, text: r.textContent, agents: [...r.querySelectorAll('.conn-agents .on')].map((b) => b.dataset.agent) }))`);
async function addAccount(name) {
  await js(`(() => { const f = document.querySelector('.conn-form'); const s = f.querySelector('select'); s.value = 'custom'; s.dispatchEvent(new Event('change'));
    const set = (ph, v) => { const i = [...f.querySelectorAll('input')].find((x) => x.placeholder === ph); i.value = v; i.dispatchEvent(new Event('input')); };
    set('linear-work', ${JSON.stringify(name)}); set('https://…/mcp', ${JSON.stringify(`${origin}/mcp`)}); f.requestSubmit(); })()`);
  await until(async () => (await rows()).some((r) => r.name === name && r.status === 'ready'), `${name} signed in`);
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'window');
  await until(() => js(`document.readyState === 'complete' && typeof synapse === 'object'`), 'renderer');
  await sleep(1500);
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))`);
  await until(() => js(`!!document.querySelector('[data-settings-pane="connectors"]')`), 'settings');
  await js(`document.querySelector('[data-settings-pane="connectors"]').click()`);
  await until(() => js(`document.querySelector('.conn-form select')?.options.length > 3`), 'connector form');

  // two accounts of the same service: each its own sign-in window, its own account
  const windows = BrowserWindow.getAllWindows().length;
  let sawSignin = false; app.on('browser-window-created', (_, w) => { if (w.getTitle().startsWith('Connect') || BrowserWindow.getAllWindows().length > windows) sawSignin = true; });
  await addAccount('linear-work');
  await addAccount('linear-home');
  assert.ok(sawSignin, 'signed in in a window of its own');
  let r = await rows();
  assert.match(r.find((x) => x.name === 'linear-work').text, /user1@example\.com/);
  assert.match(r.find((x) => x.name === 'linear-home').text, /user2@example\.com/);
  await until(() => claudeServers().includes('linear-home') && codexToml().includes('[mcp_servers.linear-home]') && opencodeServers().includes('linear-home'), 'both in every agent');
  assert.deepEqual(claudeServers(), ['linear-home', 'linear-work', 'tools']);
  assert.match(JSON.stringify(rd(claudeJson).mcpServers['linear-work']), /connector-bridge\.mjs/);
  console.log('PASS two accounts: each signed in in its own window, both reach Claude, Codex and OpenCode');

  // not for Codex; then removed altogether
  await js(`document.querySelector('[data-connector="linear-home"] [data-agent="codex"]').click()`);
  await until(() => !codexToml().includes('linear-home') && claudeServers().includes('linear-home'), 'taken from Codex only');
  await js(`document.querySelector('[data-connector="linear-work"] [data-act="remove"]').click()`);
  await until(() => !claudeServers().includes('linear-work') && !codexToml().includes('linear-work') && !opencodeServers().includes('linear-work'), 'removed everywhere');
  assert.ok(claudeServers().includes('tools'), 'the agent’s own server stays');
  console.log('PASS per agent and remove: taken from Codex only, then removed from every agent');

  // Claude's own server, brought in: every agent gets it, its env from the keychain
  await until(() => js(`!!document.querySelector('[data-other="tools"] [data-act="adopt"]')`), 'Claude’s own server listed');
  await js(`document.querySelector('[data-other="tools"] [data-act="adopt"]').click()`);
  await until(() => codexToml().includes('[mcp_servers.tools]') && opencodeServers().includes('tools') && /connector-bridge/.test(JSON.stringify(rd(claudeJson).mcpServers.tools)), 'brought in for every agent');
  assert.equal(rd(path.join(state, 'secrets.json'))[rd(path.join(state, 'connectors.json')).find((c) => c.name === 'tools').id].env.TOKEN, 'abc');
  console.log('PASS bring in: Claude’s own server now reaches every agent, its env kept as a secret');

  // Claude plugins: listed from the marketplace, installed, turned off
  assert.ok(await js(`!document.querySelector('[data-settings-pane="plugins"]')`), 'no tab of its own: plugins sit in Connectors');
  await until(() => js(`!!document.querySelector('[data-plugin="linter@acme"] [data-act="install"]')`), 'plugins listed');
  await js(`document.querySelector('[data-plugin="linter@acme"] [data-act="install"]').click()`);
  await until(() => rd(installedJson).plugins['linter@acme'] && js(`!!document.querySelector('[data-plugin="linter@acme"] input.switch')`), 'installed');
  await js(`(() => { const s = document.querySelector('[data-plugin="linter@acme"] input.switch'); s.checked = false; s.dispatchEvent(new Event('change')); })()`);
  await until(() => rd(settingsJson).enabledPlugins['linter@acme'] === false, 'turned off');
  console.log('PASS plugins: installed from its marketplace and turned off');
  if (process.env.SHOT) { await js(`document.querySelector('[data-settings-pane="connectors"]').click()`); await sleep(500); fs.writeFileSync(process.env.SHOT, (await win.capturePage()).toPNG()); }
})().catch((e) => { failed = true; console.error(e); }).finally(() => { server.close(); fs.rmSync(fixture, { recursive: true, force: true }); app.exit(failed ? 1 : 0); });
