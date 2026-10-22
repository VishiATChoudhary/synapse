#!/usr/bin/env node
// Synapse's local workspace and canvas share the same live agents and message store.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { exec, execFile } from 'node:child_process';
import { FILES, readJSON, writeJSON, readAgentMessages, renameAgent, renameProject, listAgents, postMessage } from './lib.mjs';
import { createEdge, removeEdge, setMode, endTalk, allowTalkRequest, dismissTalkRequest } from './ops.mjs';
import { createDiscovery } from './discovery.mjs';
import * as remote from './remote.mjs';
import * as talk from './talk.mjs';

const PORT = Number(process.env.PORT || 4747);
const discovery = createDiscovery();
await discovery.refresh();
const agents = () => discovery.agents;

// Seed the demo state once: links and a few messages between the fixture agents.
if (process.env.SYNAPSE_DEMO && !fs.existsSync(FILES.edges)) {
  const { DEMO_EDGES, DEMO_MESSAGES, DEMO_LAYOUT } = await import('./demo.mjs');
  const all = agents();
  const by = (n) => all.find((a) => a.name === n);
  for (const [f, t] of DEMO_EDGES) createEdge(by(f), by(t));
  const msgs = DEMO_MESSAGES.map(([f, t, text], i) => ({ id: `m${i}`, from: by(f).id, fromName: f, to: by(t).id, toName: t, text, t: Date.now() - (3 - i) * 60_000, delivered: true }));
  writeJSON(FILES.messages, msgs);
  writeJSON(FILES.layout, Object.fromEntries(Object.entries(DEMO_LAYOUT).map(([n, [x, y]]) => [by(n).id, { x, y }])));
}
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC = new Map([
  ['/', ['public/workspace.html', 'text/html']],
  ['/index.html', ['public/workspace.html', 'text/html']],
  ['/canvas', ['public/index.html', 'text/html']],
  ['/canvas.html', ['public/index.html', 'text/html']],
  ['/workspace.css', ['public/workspace.css', 'text/css']],
  ['/workspace.mjs', ['public/workspace.mjs', 'text/javascript']],
  ['/activity.mjs', ['public/activity.mjs', 'text/javascript']],
  ['/activity.css', ['public/activity.css', 'text/css']],
  ['/tokens.css', ['tokens.css', 'text/css']],
]);
// Agent talk conversations for the canvas, both sides. `live` says what the thread is doing right now:
// on my side whether a fork is answering or a question waits, on hers what my machine last reported.
const MONTH = 30 * 24 * 3600_000;
function talks({ open = false } = {}) {
  const s = readJSON(FILES.talks, {});
  const running = new Set((s.running || []).map((r) => r.conv)), queued = new Set((s.queue || []).map((j) => j.conv));
  return (s.conversations || [])
    .filter((c) => (open ? c.status === 'open' : c.status === 'open' || Date.now() - (c.lastAt || 0) < MONTH))
    .map(({ forkSession, ...c }) => {
      const waiting = c.turns?.findLast((t) => t.a == null);
      const live = c.status !== 'open' ? 'ended' : c.role === 'owner'
        ? running.has(c.id) ? 'answering' : queued.has(c.id) ? 'queued' : 'open'
        : waiting ? waiting.state || 'queued' : 'open';
      return { ...c, live };
    });
}

// the canvas only needs who, which agents and what is happening; texts come from GET /api/talks
const brief = ({ turns, ...c }) => ({ ...c, asked: turns?.length || 0 });
// a friend's agent wants to ask one of mine that is shared read only: Allow / Not now on the target agent
const talkRequests = () => talk.openRequests(readJSON(FILES.talks, {})).map(({ id, peerName, peerHandle, target, targetName, asker, askerName, at }) => ({ id, peerName, peerHandle, target, targetName, asker, askerName, at }));
const state = () => ({
  agents: agents(), talks: talks({ open: true }).map(brief), talkRequests: talkRequests(), edges: readJSON(FILES.edges, []), layout: readJSON(FILES.layout, {}),
  demo: !!process.env.SYNAPSE_DEMO,
  messageRevision: fs.existsSync(FILES.messages) ? fs.statSync(FILES.messages).mtimeMs : 0,
});

// --- SSE ---
const clients = new Set();
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (event, data) => clients.forEach((c) => send(c, event, data));

let lastSig = '';
function broadcastState() {
  const s = state();
  const sig = JSON.stringify([s.agents.map((a) => [a.id, a.status, a.name, a.lastActivity]), s.edges, s.messageRevision, s.talks, s.talkRequests]);
  if (sig !== lastSig) { lastSig = sig; broadcast('state', s); }
}
const discoveryTimer = setInterval(async () => {
  if (!clients.size) return;
  try { await discovery.refresh(); broadcastState(); }
  catch (error) { console.error(`Agent discovery: ${error.message}`); }
}, 1000);

// Multiplayer: exchange agents and shared context with friends' machines every few seconds.
// The state loop above notices what changed (their agents, links they drew) and pushes it to the canvas.
let syncError = null;
const remoteTimer = setInterval(() => {
  if (!remote.isConnected()) return;
  remote.sync().then(() => { syncError = null; }, (e) => { syncError = e.message; });
}, Number(process.env.SYNAPSE_SYNC_MS || 3000));
// Friends' agents ask ours questions: start what is queued, close what can no longer go on.
// First, whatever the previous server was answering when it stopped is lost: end it and clean up.
try { talk.recover(); } catch {}
const talkTimer = setInterval(() => { talk.tick().catch(() => {}); }, Number(process.env.SYNAPSE_SYNC_MS || 3000));

// Context flow events written by the hook become edge pulses in the UI.
let eventsSize = fs.existsSync(FILES.events) ? fs.statSync(FILES.events).size : 0;
const flowTimer = setInterval(() => {
  if (!fs.existsSync(FILES.events)) return;
  const size = fs.statSync(FILES.events).size;
  if (size <= eventsSize) { eventsSize = size; return; }
  const buf = Buffer.alloc(size - eventsSize);
  const fd = fs.openSync(FILES.events, 'r');
  fs.readSync(fd, buf, 0, buf.length, eventsSize);
  fs.closeSync(fd);
  eventsSize = size;
  for (const l of buf.toString().split('\n')) if (l) try { broadcast('flow', JSON.parse(l)); } catch {}
}, 400);

// --- HTTP ---
function body(req) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) return reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
      data += chunk;
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const value = JSON.parse(data || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { reject(Object.assign(new Error('Send a valid JSON object.'), { status: 400 })); }
    });
  });
}
const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };

// ---------- files ----------
// paths agents mention are resolved against that agent's cwd: "~/x", "/abs/x", "src/x.ts:12"
const FILE_MAX = 1_000_000;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav' };
const extOf = (f) => path.extname(f).slice(1).toLowerCase();
function resolveFile(cwd, raw) {
  let p = String(raw || '').trim().replace(/^file:\/\//, '').replace(/(#L\d+(-L?\d+)?|:\d+(:\d+)?(-\d+)?)$/, '');
  if (!p) return null;
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd || os.homedir(), p);
}
const stat = (f) => { try { return fs.statSync(f); } catch { return null; } };
// the canvas only answers to its own host, so a rebinding DNS name can't read files through it
// and only to its own page: other sites can't read, open or proxy through it (Origin / Sec-Fetch-Site)
const localHost = (req) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '');
const ownPage = (req) => localHost(req) && /^(same-origin|none|)$/.test(req.headers['sec-fetch-site'] || '')
  && (!req.headers.origin || req.headers.origin.replace(/^https?:\/\//, '') === req.headers.host);

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('x-content-type-options', 'nosniff');
  const hostname = new URL(`http://${req.headers.host || 'localhost'}`).hostname;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return json(res, 403, { error: 'Use the local Synapse address.' });
  // Browser-originated writes must come from this local app, including the legacy canvas.
  if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.headers.origin;
    if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && !['http://localhost:', 'http://127.0.0.1:'].some((base) => origin === base + server.address().port))) {
      return json(res, 403, { error: 'Open Synapse on localhost to make changes.' });
    }
  }

  if (STATIC.has(p) && ['GET', 'HEAD'].includes(req.method)) {
    const [file, type] = STATIC.get(p);
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(path.join(ROOT, file)).pipe(res);
  }
  // bundled fonts, so the canvas makes no third-party requests
  const font = p.match(/^\/fonts\/([a-z-]+\.woff2)$/);
  if (font) {
    const file = path.join(ROOT, 'public', 'fonts', font[1]);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=31536000' });
    return fs.createReadStream(file).pipe(res);
  }
  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    clients.add(res);
    send(res, 'state', state());
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (p === '/api/state' && req.method === 'GET') {
    await discovery.refresh();
    return json(res, 200, state());
  }

  if (p === '/api/edges' && req.method === 'POST') {
    const { from, to } = await body(req);
    const live = agents();
    const src = live.find((a) => a.id === from), dst = live.find((a) => a.id === to);
    if (!src || !dst || from === to) return json(res, 400, { error: 'bad endpoints' });
    let made;
    try { made = createEdge(src, dst); } catch (error) { return json(res, 400, { error: error.message }); }
    const { edge, created } = made;
    if (!created) return json(res, 409, { error: 'exists' });
    lastSig = '';
    broadcast('state', state());
    return json(res, 201, edge);
  }
  // ---- multiplayer
  if (p === '/api/remote' && req.method === 'GET') {
    // `talk`: paired through a synapse request, so a share to them may be switched to talk
    const f = remote.friends(), peers = remote.config().peers || {};
    return json(res, 200, { ...f, friends: f.friends.map((x) => ({ ...x, talk: peers[x.machineId]?.via === 'request' })), syncError });
  }
  if (p === '/api/remote/invite' && req.method === 'POST') {
    try { return json(res, 200, await remote.invite({ name: (await body(req)).name })); }
    catch (e) { return json(res, 502, { error: e.message }); }
  }
  if (p === '/api/remote/join' && req.method === 'POST') {
    const b = await body(req);
    try { const out = await remote.join(b.code, { name: b.name }); lastSig = ''; return json(res, 200, out); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/remote/name' && req.method === 'POST') return json(res, 200, remote.setName((await body(req)).name));
  if (p === '/api/remote/unfriend' && req.method === 'POST') {
    try { const out = remote.unfriend((await body(req)).machineId); lastSig = ''; broadcast('state', state()); return json(res, 200, out); }
    catch (e) { return json(res, 404, { error: e.message }); }
  }

  // ---- agent talk: a friend's questions and answers, and switches only the canvas page itself may use
  if ((p === '/api/talks' || p.startsWith('/api/talks/') || p.startsWith('/api/talk-requests/') || /^\/api\/edges\/[^/]+\/mode$/.test(p)) && !ownPage(req)) return json(res, 403, { error: 'forbidden' });
  const treq = p.match(/^\/api\/talk-requests\/([\w-]+)\/(allow|dismiss)$/);
  if (treq && req.method === 'POST') {
    let out;
    try { out = treq[2] === 'allow' ? allowTalkRequest(treq[1]) : dismissTalkRequest(treq[1]); } catch (e) { return json(res, 409, { error: e.message }); }
    lastSig = '';
    broadcast('state', state());
    return json(res, 200, out);
  }
  const mode = p.match(/^\/api\/edges\/([\w-]+)\/mode$/);
  if (mode && req.method === 'POST') {
    let out;
    try { out = setMode(mode[1], (await body(req)).mode); } catch (e) { return json(res, 409, { error: e.message }); }
    // back to sync ends what was open over this share
    try { talk.reconcile(); talk.tick().catch(() => {}); } catch {}
    lastSig = '';
    broadcast('state', state());
    return json(res, 200, out.edge);
  }
  if (p === '/api/talks' && req.method === 'GET') return json(res, 200, talks());
  if (p === '/api/talks/usage' && req.method === 'GET') return json(res, 200, talk.usage());
  const endT = p.match(/^\/api\/talks\/([\w-]+)\/end$/);
  if (endT && req.method === 'POST') {
    const c = talks().find((x) => x.id === endT[1]);
    if (!c) return json(res, 404, { error: 'No such conversation.' });
    try {
      // my agent answering: end it here and tell her machine. Mine asking: end it as the asker would.
      if (c.role === 'owner') talk.endConversation(c.id, 'owner');
      else endTalk(listAgents().find((a) => a.id === c.asker) || { id: c.asker, name: c.askerName }, c.id);
      await talk.tick().catch(() => {});
    } catch (e) { return json(res, 409, { error: e.message }); }
    lastSig = '';
    broadcast('state', state());
    return json(res, 200, { ended: true });
  }

  const del = p.match(/^\/api\/edges\/([\w-]+)$/);
  if (del && req.method === 'DELETE') {
    removeEdge(del[1]);
    try { talk.reconcile(); talk.tick().catch(() => {}); } catch {}
    lastSig = '';
    broadcast('state', state());
    return json(res, 200, { ok: true });
  }
  if (p === '/api/layout' && req.method === 'POST') {
    writeJSON(FILES.layout, { ...readJSON(FILES.layout, {}), ...(await body(req)) });
    return json(res, 200, { ok: true });
  }
  const ren = p.match(/^\/api\/agents\/([\w-]+)\/name$/);
  if (ren && req.method === 'POST') {
    const a = agents().find((x) => x.id === ren[1]);
    if (!a) return json(res, 404, { error: 'gone' });
    try {
      const out = renameAgent(a, (await body(req)).name);
      await discovery.refresh();
      lastSig = '';
      broadcast('state', state());
      return json(res, 200, out);
    } catch (e) { return json(res, e.status || 409, { error: e.message }); }
  }
  if (p === '/api/projects/name' && req.method === 'POST') {
    const { key, name } = await body(req);
    if (!agents().some((a) => a.projectKey === key)) return json(res, 404, { error: 'gone' });
    try {
      const out = renameProject(key, name);
      lastSig = '';
      broadcast('state', state());
      return json(res, 200, out);
    } catch (e) { return json(res, 409, { error: e.message }); }
  }
  const message = p.match(/^\/api\/agents\/([\w-]+)\/messages$/);
  if (message && req.method === 'POST') {
    const agent = agents().find((a) => a.id === message[1]);
    if (!agent) return json(res, 404, { error: 'This session has ended. Choose a live session.' });
    const { text } = await body(req);
    if (typeof text !== 'string' || !text.trim() || text.length > 12_000) {
      return json(res, 400, { error: 'Write a message between 1 and 12,000 characters.' });
    }
    const sent = postMessage({ id: 'synapse-user', name: 'You' }, agent, text.trim());
    broadcastState();
    return json(res, 201, sent);
  }
  const recent = p.match(/^\/api\/agents\/([\w-]+)\/recent$/);
  if (recent && req.method === 'GET') {
    const a = agents().find((x) => x.id === recent[1]);
    if (!a) return json(res, 404, { error: 'gone' });
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 14));
    const { messages } = readAgentMessages(a, null, { tailBytes: 600_000 });
    const chat = readJSON(FILES.messages, []).filter((m) => m.from === a.id || m.to === a.id).slice(-100);
    return json(res, 200, {
      messages: messages.slice(-limit).map((m) => ({ ...m, text: m.text.slice(0, 16_000) })),
      hasMore: messages.length > limit,
      chat: chat.map((m) => ({ ...m, outgoing: m.from === a.id })),
    });
  }
  if (p.startsWith('/api/file') || p === '/api/link') {
    if (!ownPage(req)) return json(res, 403, { error: 'forbidden' });
    const q = req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams);
    try { return await files(req, res, p, q); } catch (e) { return json(res, 500, { error: e.code || e.message }); }
  }
  json(res, 404, { error: 'not found' });
}

async function files(req, res, p, q) {
  if (p === '/api/link') {
    if (!/^https?:\/\//.test(q.url || '')) return json(res, 400, { error: 'http(s) only' });
    // can the page sit in an iframe? check X-Frame-Options and CSP frame-ancestors before trying
    try {
      const r = await fetch(q.url, { redirect: 'follow', signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'Mozilla/5.0 Synapse' } });
      r.body?.cancel();
      const xfo = (r.headers.get('x-frame-options') || '').toLowerCase();
      const fa = (r.headers.get('content-security-policy') || '').match(/frame-ancestors([^;]*)/i)?.[1].trim();
      const embeddable = !/deny|sameorigin/.test(xfo) && (!fa || /(^|\s)\*(\s|$)/.test(fa));
      return json(res, 200, { status: r.status, url: r.url, embeddable });
    } catch (e) { return json(res, 200, { error: e.cause?.code || e.cause?.message || e.message }); }
  }
  const cwd = agents().find((x) => x.id === q.agent)?.cwd || q.cwd;
  if (p === '/api/files/exists') {
    const paths = (Array.isArray(q.paths) ? q.paths : []).slice(0, 400);
    return json(res, 200, Object.fromEntries(paths.map((x) => [x, !!stat(resolveFile(cwd, x))])));
  }
  const file = resolveFile(cwd, q.path), st = file && stat(file);
  if (!st) return json(res, 404, { error: 'not found', path: file });
  if (p === '/api/file/open' && req.method === 'POST') {
    if (process.platform === 'win32') execFile('explorer.exe', q.reveal ? [`/select,${file}`] : [file], () => {});
    else execFile('open', q.reveal ? ['-R', file] : [file], () => {});
    return json(res, 200, { ok: true });
  }
  // fifos and sockets would block the event loop on open, so only regular files are read
  if (p !== '/api/file/open' && !st.isFile() && !st.isDirectory()) return json(res, 415, { error: 'not a regular file' });
  if (p === '/api/file/raw') {
    if (!st.isFile()) return json(res, 415, { error: 'not a file' });
    // sandboxed so an svg can never run script on the canvas origin (Chrome won't render a sandboxed pdf)
    res.writeHead(200, { 'content-type': MIME[extOf(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store',
      ...(extOf(file) === 'pdf' ? {} : { 'content-security-policy': 'sandbox' }), 'x-content-type-options': 'nosniff' });
    return pipeline(fs.createReadStream(file), res, () => {});
  }
  if (p === '/api/file') {
    const base = { path: file, name: path.basename(file), mtime: st.mtimeMs, size: st.size };
    if (st.isDirectory()) {
      const entries = fs.readdirSync(file, { withFileTypes: true }).filter((d) => d.name !== '.DS_Store')
        .map((d) => ({ name: d.name, dir: d.isDirectory() || (d.isSymbolicLink() && !!stat(path.join(file, d.name))?.isDirectory()) }))
        .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
      return json(res, 200, { ...base, type: 'dir', entries });
    }
    const mime = MIME[extOf(file)];
    if (mime) return json(res, 200, { ...base, type: mime.split('/')[0] === 'application' ? 'pdf' : mime.split('/')[0], ext: extOf(file) });
    const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(Math.min(st.size, FILE_MAX));
    try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    if (buf.subarray(0, 8000).includes(0)) return json(res, 200, { ...base, type: 'binary' });
    return json(res, 200, { ...base, type: 'text', ext: extOf(file), text: buf.toString('utf8'), truncated: st.size > FILE_MAX });
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    json(res, error.status || 500, { error: error.status ? error.message : 'Synapse could not complete this request. Try again.' });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${server.address().port}`;
  console.log(`synapse running at ${url}`);
  if (!process.env.NO_OPEN) exec(process.platform === 'win32' ? `start "" ${url}` : `open ${url}`);
});

function shutdown() {
  clearInterval(discoveryTimer);
  clearInterval(flowTimer);
  clearInterval(remoteTimer);
  clearInterval(talkTimer);
  for (const client of clients) client.end();
  server.close();
  discovery.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
