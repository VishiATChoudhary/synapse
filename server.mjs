#!/usr/bin/env node
// Synapse local server: serves the canvas UI, streams live agent state over SSE,
// and stores the edges the hook reads.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { FILES, readJSON, writeJSON, listAgents, readAgentMessages, projectOf, colorOf, renameAgent } from './lib.mjs';
import { createEdge, removeEdge } from './ops.mjs';

const PORT = Number(process.env.PORT || 4747);

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
    const proj = projectOf(a.cwd);
    return { ...a, project: proj.label, projectKey: proj.key, color: colorOf(proj.key), lastActivity, preview };
  });
}

const state = () => ({ agents: agents(), edges: readJSON(FILES.edges, []), layout: readJSON(FILES.layout, {}) });

// --- SSE ---
const clients = new Set();
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (event, data) => clients.forEach((c) => send(c, event, data));

let lastSig = '';
setInterval(() => {
  if (!clients.size) return;
  const s = state();
  const sig = JSON.stringify([s.agents.map((a) => [a.id, a.status, a.name, a.lastActivity]), s.edges]);
  if (sig !== lastSig) { lastSig = sig; broadcast('state', s); }
}, 1000);

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
    const { edge, created } = createEdge(src, dst);
    if (!created) return json(res, 409, { error: 'exists' });
    lastSig = '';
    broadcast('state', state());
    return json(res, 201, edge);
  }
  const del = p.match(/^\/api\/edges\/([\w-]+)$/);
  if (del && req.method === 'DELETE') {
    removeEdge(del[1]);
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
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`synapse running at ${url}`);
  if (!process.env.NO_OPEN) exec(`open ${url}`);
});
