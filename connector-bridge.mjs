// What an agent runs for a Synapse connector (connectors.mjs): node connector-bridge.mjs <connector id>.
// A server reached by URL: each MCP message from the agent (stdin, one JSON per line) is POSTed to it with the
// account's token (Streamable HTTP), and its answers (JSON or an event stream) go back on stdout. On a 401 the token
// is refreshed once and the message sent again. A local server: started with its keychain env, stdio passed through.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { get, getSecret, accessToken } from './connectors.mjs';

const id = process.argv[2];
const c = id && get(id);
const say = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const fail = (msg, text) => { if (msg && msg.id !== undefined && msg.method) say({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: text } }); };

if (!c) {
  process.stderr.write(`synapse connector ${id} is not set up (Synapse > Settings > Connectors)\n`);
  process.exit(1);
}

if (c.transport === 'stdio') {
  const env = { ...process.env, ...(getSecret(c.id)?.env || {}) };
  const child = spawn(c.command, c.args || [], { stdio: 'inherit', env, shell: process.platform === 'win32' });
  child.on('exit', (code) => process.exit(code ?? 1));
  child.on('error', (e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
} else {
  let session = null, protocol = null;
  const extra = getSecret(c.id)?.headers || {};
  const NEEDS = `${c.label} (${c.name}) needs signing in again: Synapse > Settings > Connectors.`;

  async function post(msg, retry = true) {
    const token = c.auth === 'none' ? null : await accessToken(c.id);
    if (c.auth !== 'none' && !token) return fail(msg, NEEDS);
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra };
    if (token) headers.authorization = `Bearer ${token}`;
    if (session) headers['mcp-session-id'] = session;
    if (protocol) headers['mcp-protocol-version'] = protocol;
    let r;
    try { r = await fetch(c.url, { method: 'POST', headers, body: JSON.stringify(msg) }); }
    catch (e) { return fail(msg, `${c.label}: could not reach ${new URL(c.url).host} (${e.cause?.code || e.message})`); }
    if (r.status === 401 && retry && c.auth === 'oauth') { await accessToken(c.id, { force: true }); return post(msg, false); }
    if (r.status === 401) return fail(msg, NEEDS);
    if (r.status === 404 && session && msg.method !== 'initialize') { session = null; return fail(msg, `${c.label}: the server ended the session, restart the agent.`); }
    const sid = r.headers.get('mcp-session-id'); if (sid) session = sid;
    if (r.status === 202 || r.status === 204) return;
    const type = r.headers.get('content-type') || '';
    if (!r.ok) { const t = await r.text().catch(() => ''); return fail(msg, `${c.label}: ${r.status} ${t.slice(0, 300)}`); }
    if (type.includes('text/event-stream')) {
      const decoder = new TextDecoder(); let buf = '', data = [];
      for await (const chunk of r.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          else if (!line && data.length) { forward(data.join('\n'), msg); data = []; }
        }
      }
      if (data.length) forward(data.join('\n'), msg);
      return;
    }
    forward(await r.text(), msg);
  }
  function forward(text, msg) {
    if (!text.trim()) return;
    let v; try { v = JSON.parse(text); } catch { return fail(msg, `${c.label}: the server sent something that is not JSON`); }
    for (const m of Array.isArray(v) ? v : [v]) {
      if (msg.method === 'initialize' && m.id === msg.id && m.result?.protocolVersion) protocol = m.result.protocolVersion;
      say(m);
    }
  }

  // the first message (initialize) has to finish before the rest, so they carry its session id
  let ready = null;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const run = () => post(msg).catch((e) => fail(msg, `${c.label}: ${e.message}`));
    if (msg.method === 'initialize') ready = run();
    else (ready || Promise.resolve()).then(run);
  });
  rl.on('close', async () => {
    await ready?.catch(() => {});
    if (session) fetch(c.url, { method: 'DELETE', headers: { 'mcp-session-id': session, ...(c.auth !== 'none' ? { authorization: `Bearer ${await accessToken(c.id)}` } : {}) } }).catch(() => {}).finally(() => setTimeout(() => process.exit(0), 50));
    else setTimeout(() => process.exit(0), 50);
  });
}
