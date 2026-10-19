#!/usr/bin/env node
// Synapse local server: serves the canvas UI, streams live agent state over SSE,
// and stores the edges the hook reads.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec, execFile } from 'node:child_process';
import { pipeline } from 'node:stream';
import { FILES, readJSON, writeJSON, listAgents, readAgentMessages, projectOfAgent, colorOf, renameAgent, renameProject } from './lib.mjs';
import { createEdge, removeEdge, setMode, endTalk } from './ops.mjs';
import * as remote from './remote.mjs';
import * as talk from './talk.mjs';

const PORT = Number(process.env.PORT || 4747);
// the branch a repo's own folder has checked out, or null (not a repo, detached HEAD)
const branchOf = (dir) => {
  try { return fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').match(/^ref: refs\/heads\/(.+)/)?.[1].trim() || null; } catch { return null; }
};

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
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const INDEX = path.join(ROOT, 'public', 'index.html');

const previewCache = new Map(); // sessionId -> { mtime, preview }

function agents() {
  return listAgents().map((a) => {
    let lastActivity = a.updatedAt || a.startedAt;
    let preview = '';
    if (a.transcript && fs.existsSync(a.transcript)) {
      const mtime = fs.statSync(a.transcript).mtimeMs;
      lastActivity = Math.max(lastActivity, mtime);
      const hit = previewCache.get(a.id);
      if (hit?.mtime === mtime) preview = hit.preview;
      else {
        const { messages } = readAgentMessages(a, null, { tailBytes: 120_000, minMessages: 1 });
        const last = [...messages].reverse().find((m) => !m.tool) || messages.at(-1);
        preview = last ? last.text.replace(/\s+/g, ' ').slice(0, 160) : '';
        previewCache.set(a.id, { mtime, preview });
      }
    }
    const proj = projectOfAgent(a), wt = proj.worktree;
    // the canvas frames each worktree apart (same colour as its repo), labelled "repo / worktree";
    // inside the repo's frame each worktree's own frame is labelled `frameSub` (worktree name, or the checkout's branch)
    return { ...a, project: proj.label, projectAuto: proj.autoLabel, projectKey: proj.key, color: colorOf(proj.key),
      frameKey: wt ? `${proj.key}#${wt.path}` : proj.key, frame: wt ? `${proj.label} / ${wt.name}` : proj.label,
      frameSub: wt ? wt.name : a.remote ? null : branchOf(proj.key), lastActivity, preview };
  });
}

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
const state = () => ({ agents: agents(), edges: readJSON(FILES.edges, []), layout: readJSON(FILES.layout, {}), talks: talks({ open: true }).map(brief) });

// --- SSE ---
const clients = new Set();
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (event, data) => clients.forEach((c) => send(c, event, data));

let lastSig = '';
setInterval(() => {
  if (!clients.size) return;
  const s = state();
  const sig = JSON.stringify([s.agents.map((a) => [a.id, a.status, a.name, a.lastActivity]), s.edges, s.talks]);
  if (sig !== lastSig) { lastSig = sig; broadcast('state', s); }
}, 1000);

// Multiplayer: exchange agents and shared context with friends' machines every few seconds.
// The state loop above notices what changed (their agents, links they drew) and pushes it to the canvas.
let syncError = null;
setInterval(() => {
  if (!remote.isConnected()) return;
  remote.sync().then(() => { syncError = null; }, (e) => { syncError = e.message; });
}, Number(process.env.SYNAPSE_SYNC_MS || 3000));
// Friends' agents ask ours questions: start what is queued, close what can no longer go on.
// First, whatever the previous server was answering when it stopped is lost: end it and clean up.
try { talk.recover(); } catch {}
setInterval(() => { talk.tick().catch(() => {}); }, Number(process.env.SYNAPSE_SYNC_MS || 3000));

// Context flow events written by the hook become edge pulses in the UI.
let eventsSize = fs.existsSync(FILES.events) ? fs.statSync(FILES.events).size : 0;
setInterval(() => {
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
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(INDEX).pipe(res);
  }
  // bundled fonts, so the canvas makes no third-party requests
  const font = p.match(/^\/fonts\/([a-z-]+\.woff2)$/);
  if (font) {
    const file = path.join(ROOT, 'public', 'fonts', font[1]);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=31536000' });
    return fs.createReadStream(file).pipe(res);
  }
  // every API route answers only to its own host (no DNS rebinding), and only the canvas page itself may change things
  if (p.startsWith('/api/') && (!localHost(req) || (req.method !== 'GET' && !ownPage(req)))) return json(res, 403, { error: 'forbidden' });
  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    clients.add(res);
    send(res, 'state', state());
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  if (p === '/api/state') return json(res, 200, state());

  if (p === '/api/edges' && req.method === 'POST') {
    const { from, to } = await body(req);
    const live = agents();
    const src = live.find((a) => a.id === from), dst = live.find((a) => a.id === to);
    if (!src || !dst || from === to) return json(res, 400, { error: 'bad endpoints' });
    let made;
    try { made = createEdge(src, dst); } catch (e) { return json(res, 400, { error: e.message }); }
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
  if ((p === '/api/talks' || p.startsWith('/api/talks/') || /^\/api\/edges\/[^/]+\/mode$/.test(p)) && !ownPage(req)) return json(res, 403, { error: 'forbidden' });
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
    // a cut talk edge ends its conversations and kills the fork now, not at the next interval
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
      lastSig = '';
      broadcast('state', state());
      return json(res, 200, out);
    } catch (e) { return json(res, 409, { error: e.message }); }
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
  const recent = p.match(/^\/api\/agents\/([\w-]+)\/recent$/);
  if (recent) {
    const a = agents().find((x) => x.id === recent[1]);
    if (!a) return json(res, 404, { error: 'gone' });
    const { messages } = readAgentMessages(a, null, { tailBytes: 200_000 });
    const chat = readJSON(FILES.messages, []).filter((m) => m.from === a.id || m.to === a.id).slice(-20);
    return json(res, 200, {
      messages: messages.slice(-14).map((m) => ({ ...m, text: m.text.slice(0, 4000) })),
      chat: chat.map(({ fromName, toName, from, text, t }) => ({ fromName, toName, outgoing: from === a.id, text: text.slice(0, 4000), t })),
    });
  }
  if (p.startsWith('/api/file') || p === '/api/link') {
    if (!ownPage(req)) return json(res, 403, { error: 'forbidden' });
    const q = req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams);
    try { return await files(req, res, p, q); } catch (e) { return json(res, 500, { error: e.code || e.message }); }
  }
  json(res, 404, { error: 'not found' });
});

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
    execFile('open', q.reveal ? ['-R', file] : [file], () => {});
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

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`synapse running at ${url}`);
  if (!process.env.NO_OPEN) exec(`open ${url}`);
});
