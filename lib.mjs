// Shared core: agent discovery (Claude, Codex, Amp, OpenCode, Copilot, Gemini, Superset CLI),
// transcript parsing, and the local state the server, hook and MCP server all use.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
export const CLAUDE = path.join(HOME, '.claude');
export const DATA = process.env.SYNAPSE_HOME || path.join(HOME, '.synapse');
fs.mkdirSync(DATA, { recursive: true });

// `npm run demo`: fixture agents instead of real sessions
const DEMO = process.env.SYNAPSE_DEMO ? await import('./demo.mjs') : null;

export const FILES = {
  edges: path.join(DATA, 'edges.json'),
  layout: path.join(DATA, 'layout.json'),
  cursors: path.join(DATA, 'cursors.json'),
  events: path.join(DATA, 'events.jsonl'),
  colors: path.join(DATA, 'colors.json'),
  messages: path.join(DATA, 'messages.json'),
};

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJSON(file, value) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export const logEvent = (ev) => fs.appendFileSync(FILES.events, `${JSON.stringify({ t: Date.now(), ...ev })}\n`);

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, maxBuffer: 32 << 20 }); }
  catch (e) { return e.stdout || ''; }
};

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---------------------------------------------------------------- transcripts

const NOISE = /^<(command-|local-command|system-reminder|task-notification|bash-|user-prompt-submit-hook|environment_context|user_instructions|permissions)/;

function claudeMessage(e) {
  if (e.isMeta || e.isSidechain || e.isCompactSummary) return null;
  const content = e.message?.content;
  if (e.type === 'user') {
    const parts = typeof content === 'string' ? [content]
      : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text) : [];
    const text = parts.filter((t) => !NOISE.test(t.trim())).join('\n').trim();
    return text ? { role: 'user', text, ts: e.timestamp } : null;
  }
  if (e.type === 'assistant' && Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (b.type === 'text' && b.text.trim()) parts.push(b.text.trim());
      if (b.type === 'tool_use') parts.push(toolLine(b.name, b.input));
    }
    return parts.length ? { role: 'assistant', text: parts.join('\n'), ts: e.timestamp, tool: !content.some((b) => b.type === 'text') } : null;
  }
  return null;
}

function codexMessage(e) {
  const p = e.payload || {};
  if (e.type !== 'response_item') return null;
  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    const text = (p.content || []).map((c) => c.text || '').join('\n').trim();
    if (!text || NOISE.test(text)) return null;
    return { role: p.role, text, ts: e.timestamp };
  }
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    let input = p.arguments || p.input || '';
    try { input = JSON.parse(input); } catch {}
    return { role: 'assistant', text: toolLine(p.name, input), ts: e.timestamp, tool: true };
  }
  return null;
}

function toolLine(name, input) {
  const i = typeof input === 'object' && input ? input : { command: String(input || '') };
  let what = i.description || i.command || i.cmd || i.file_path || i.path || i.pattern || i.url || i.prompt || '';
  if (Array.isArray(what)) what = what.join(' ');
  return `[${name}${what ? `: ${clip(String(what).replace(/\s+/g, ' '), 120)}` : ''}]`;
}

const PARSERS = { claude: claudeMessage, codex: codexMessage };

// Read messages from a JSONL transcript starting at a byte offset (or the tail when offset is null).
// Returns the messages plus the byte offset of the last complete line consumed.
function readJsonl(file, fromByte, parse, tailBytes = 600_000, minMessages = 6) {
  const size = fs.statSync(file).size;
  if (fromByte == null) {
    // big tool outputs can crowd the tail, so widen the window until there is something to show
    for (let n = tailBytes; ; n *= 4) {
      const r = readRange(file, size, Math.max(0, size - n), true, parse);
      if (r.messages.length >= minMessages || n >= size || n >= 32_000_000) return r;
    }
  }
  return readRange(file, size, fromByte > size ? Math.max(0, size - tailBytes) : fromByte, false, parse);
}

function readRange(file, size, start, isTail, parse) {
  if (start === size) return { messages: [], end: size };
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  const tail = lines.pop(); // '' if file ends in newline, else a partial line still being written
  const end = size - Buffer.byteLength(tail);
  if (isTail && start > 0) lines.shift(); // first line is partial
  const messages = [];
  for (const l of lines) {
    if (!l) continue;
    try { const m = parse(JSON.parse(l)); if (m) messages.push(m); } catch {}
  }
  return { messages, end };
}

// Gemini keeps each chat as one JSON document; the cursor is a message index.
function readGemini(file, from) {
  const msgs = readJSON(file, {}).messages || [];
  const start = from == null ? Math.max(0, msgs.length - 40) : Math.min(from, msgs.length);
  const messages = [];
  for (const m of msgs.slice(start)) {
    const text = (typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join('\n') : '').trim();
    if (m.type === 'user' && text) messages.push({ role: 'user', text, ts: m.timestamp });
    else if (m.type === 'gemini') {
      const tools = (m.toolCalls || []).map((c) => toolLine(c.name, c.args));
      if (text || tools.length) messages.push({ role: 'assistant', text: [text, ...tools].filter(Boolean).join('\n'), ts: m.timestamp, tool: !text });
    }
  }
  return { messages, end: msgs.length };
}

// Unified reader. `src` is { transcript, format }.
export function readAgentMessages(src, cursor = null, opts = {}) {
  if (src?.format === 'demo') return { messages: cursor == null ? src.demo : src.demo.slice(cursor), end: src.demo.length };
  if (!src?.transcript || !fs.existsSync(src.transcript)) return { messages: [], end: cursor };
  if (src.format === 'gemini') return readGemini(src.transcript, cursor);
  return readJsonl(src.transcript, cursor, PARSERS[src.format] || claudeMessage, opts.tailBytes, opts.minMessages);
}

// Newest-first packing of messages into a character budget, rendered oldest-first.
export function formatMessages(messages, budget = 8000) {
  const out = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const line = `${m.role === 'user' ? 'USER' : 'AGENT'}: ${clip(m.text, 1800)}`;
    if (used + line.length > budget && out.length) break;
    out.push(line);
    used += line.length;
  }
  return out.reverse().join('\n\n');
}

// ---------------------------------------------------------------- discovery

const pathCache = new Map();
function claudeTranscript(sessionId, cwd) {
  if (pathCache.has(sessionId) && fs.existsSync(pathCache.get(sessionId))) return pathCache.get(sessionId);
  const projects = path.join(CLAUDE, 'projects');
  let found = null;
  const direct = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) found = direct;
  else {
    try {
      for (const d of fs.readdirSync(projects)) {
        const p = path.join(projects, d, `${sessionId}.jsonl`);
        if (fs.existsSync(p)) { found = p; break; }
      }
    } catch {}
  }
  if (found) pathCache.set(sessionId, found);
  return found;
}

function claudeAgents() {
  const dir = path.join(CLAUDE, 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const s = readJSON(path.join(dir, n), null);
    if (!s?.sessionId || !s.pid || !alive(s.pid)) continue;
    out.push({
      id: s.sessionId, pid: s.pid, kind: 'claude', name: s.name || path.basename(s.cwd), cwd: s.cwd,
      status: s.status || 'idle', startedAt: s.startedAt, updatedAt: s.updatedAt,
      transcript: claudeTranscript(s.sessionId, s.cwd), format: 'claude',
    });
  }
  return out;
}

export const KINDS = ['claude', 'codex', 'amp', 'opencode', 'copilot', 'gemini', 'cursor-agent', 'superset'];
const RUNTIMES = new Set(['node', 'bun', 'deno', 'bash', 'sh', 'zsh', 'python', 'python3']);
const SKIP_SUBCOMMANDS = new Set(['mcp', 'mcp-server', 'app-server', 'login', 'logout', 'daemon', 'host', 'serve', 'proto', '--version', '-v', 'update', 'completion']);

function processTable() {
  // lstart is five tokens, e.g. "Wed Oct 14 23:52:13 2026"
  const rows = [];
  for (const line of sh('ps', ['-axo', 'pid=,ppid=,pcpu=,lstart=,command=']).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], cpu: +m[3], start: Date.parse(m[4]), cmd: m[5] });
  }
  return rows;
}

function kindOf(cmd) {
  const argv = cmd.split(/\s+/);
  if (argv[0].includes('.app/')) return null; // desktop apps (e.g. Superset.app) are not CLI agents
  let i = 0;
  let base = path.basename(argv[0]);
  if (RUNTIMES.has(base) || /^python3?\.\d+$/.test(base)) { i = 1; while (argv[i]?.startsWith('-')) i++; base = path.basename(argv[i] || ''); }
  base = base.replace(/\.(m?js|cjs|ts)$/, '');
  if (!KINDS.includes(base) || base === 'claude') return null;
  if (SKIP_SUBCOMMANDS.has(argv[i + 1])) return null;
  return base;
}

function cwds(pids) {
  const out = new Map();
  if (!pids.length) return out;
  let pid = null;
  for (const l of sh('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]).split('\n')) {
    if (l[0] === 'p') pid = +l.slice(1);
    else if (l[0] === 'n' && pid) out.set(pid, l.slice(1));
  }
  return out;
}

const transcriptCache = new Map(); // agent id -> path
function codexTranscript(id, cwd, start) {
  if (transcriptCache.has(id)) return transcriptCache.get(id);
  const homes = [process.env.CODEX_HOME, path.join(HOME, '.codex')].filter(Boolean);
  let best = null;
  for (const home of homes) {
    for (let d = 0; d < 3; d++) {
      const day = new Date(start + d * 86400_000);
      const dir = path.join(home, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.startsWith('rollout-')); } catch { continue; }
      for (const f of files) {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        if (st.mtimeMs < start - 60_000) continue;
        try {
          // session_meta can be huge (it embeds instructions), so just pull cwd out of the head
          const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(65536); fs.readSync(fd, buf, 0, 65536, 0); fs.closeSync(fd);
          const m = buf.toString('utf8').match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (!m || JSON.parse(`"${m[1]}"`) !== cwd) continue;
        } catch { continue; }
        if (!best || st.mtimeMs > best.m) best = { p, m: st.mtimeMs };
      }
    }
  }
  if (best) transcriptCache.set(id, best.p);
  return best?.p || null;
}

function geminiTranscript(cwd, start) {
  const tmp = path.join(HOME, '.gemini', 'tmp');
  const names = [crypto.createHash('sha256').update(cwd).digest('hex')];
  const proj = readJSON(path.join(HOME, '.gemini', 'projects.json'), {}).projects?.[cwd];
  if (proj) names.push(proj);
  let best = null;
  for (const n of names) {
    const dir = path.join(tmp, n, 'chats');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs >= start - 60_000 && (!best || st.mtimeMs > best.m)) best = { p: path.join(dir, f), m: st.mtimeMs };
    }
  }
  return best?.p || null;
}

function processAgents() {
  const rows = processTable();
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const hits = rows.map((r) => ({ ...r, kind: kindOf(r.cmd) })).filter((r) => r.kind);
  const hitPids = new Map(hits.map((h) => [h.pid, h]));
  // keep only the outermost process of each agent (wrapper scripts spawn the real binary)
  const rootOf = (h) => {
    let root = h;
    for (let p = byPid.get(h.ppid); p; p = byPid.get(p.ppid)) if (hitPids.get(p.pid)?.kind === h.kind) root = p;
    return root;
  };
  const busyCpu = new Map();
  for (const h of hits) { const r = rootOf(h); busyCpu.set(r.pid, Math.max(busyCpu.get(r.pid) || 0, h.cpu)); }
  const roots = hits.filter((h) => rootOf(h) === h);
  const dirs = cwds(roots.map((r) => r.pid));
  return roots.filter((r) => dirs.get(r.pid)).map((r) => {
    const cwd = dirs.get(r.pid), id = `${r.kind}-${r.pid}`;
    const transcript = r.kind === 'codex' ? codexTranscript(id, cwd, r.start)
      : r.kind === 'gemini' ? geminiTranscript(cwd, r.start) : null;
    return {
      id, pid: r.pid, kind: r.kind, name: `${r.kind}-${path.basename(cwd)}`.toLowerCase(), cwd,
      status: (busyCpu.get(r.pid) || 0) > 4 ? 'busy' : 'idle', startedAt: r.start, updatedAt: r.start,
      transcript, format: r.kind === 'codex' || r.kind === 'gemini' ? r.kind : null,
    };
  });
}

export function listAgents() {
  if (DEMO) return DEMO.demoAgents();
  return [...claudeAgents(), ...processAgents()];
}

// Find which agent a process belongs to by walking up its parents (used by the MCP server).
export function agentForProcess(pid) {
  const agents = listAgents();
  const rows = new Map(processTable().map((r) => [r.pid, r]));
  for (let p = pid, guard = 0; p > 1 && guard < 64; p = rows.get(p)?.ppid, guard++) {
    const a = agents.find((x) => x.pid === p);
    if (a) return a;
  }
  return null;
}

// Resolve "name", "id" or a unique prefix of either.
export function findAgent(agents, query) {
  const q = String(query || '').toLowerCase().trim();
  return agents.find((a) => a.id === query || a.name.toLowerCase() === q)
    || agents.find((a) => a.name.toLowerCase().startsWith(q) || a.id.startsWith(q)) || null;
}

// ---------------------------------------------------------------- projects & colours

// Group sessions by real project: worktrees share their main repo's git dir.
const projectCache = new Map();
export function projectOf(cwd) {
  if (projectCache.has(cwd)) return projectCache.get(cwd);
  let key = cwd, label = path.basename(cwd);
  try {
    const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    key = common.replace(/\/\.git\/?$/, '');
    label = path.basename(key);
  } catch {}
  const wt = cwd.match(/\/worktrees\/([^/]+)\//); // e.g. ~/.superset/worktrees/<Project>/<branch>
  if (wt) label = wt[1];
  if (key === cwd) key = `project:${label}`; // not a git repo: group by name
  const p = { key, label };
  projectCache.set(cwd, p);
  return p;
}

// Stable colour per project: first come, first served from a flat palette, persisted.
// ordered so neighbours in the list are far apart in hue
const PALETTE = ['#6C7CFF', '#F2B33D', '#2EC4A0', '#FF5C7A', '#A3D33C', '#D65FE0', '#3FB8F5', '#FF8552', '#E8D8B0', '#14A3A3', '#B7835A', '#A3ADC2'];
export function colorOf(key) {
  const colors = readJSON(FILES.colors, {});
  if (!colors[key]) {
    const used = Object.values(colors);
    colors[key] = PALETTE.find((c) => !used.includes(c)) || PALETTE[used.length % PALETTE.length];
    writeJSON(FILES.colors, colors);
  }
  return colors[key];
}

// ---------------------------------------------------------------- messages

export function postMessage(from, to, text) {
  const all = readJSON(FILES.messages, []);
  const m = { id: crypto.randomUUID(), from: from.id, fromName: from.name, to: to.id, toName: to.name, text, t: Date.now(), delivered: false };
  all.push(m);
  writeJSON(FILES.messages, all.slice(-1000));
  const edge = readJSON(FILES.edges, []).find((e) => (e.from === from.id && e.to === to.id) || (e.from === to.id && e.to === from.id));
  logEvent({ type: 'message', edge: edge?.id, from: from.id, to: to.id, fromName: from.name, toName: to.name, preview: clip(text, 120) });
  return m;
}

export function takeInbox(id) {
  const all = readJSON(FILES.messages, []);
  const mine = all.filter((m) => m.to === id && !m.delivered);
  if (mine.length) { mine.forEach((m) => (m.delivered = true)); writeJSON(FILES.messages, all); }
  return mine;
}

export const linked = (edges, a, b) => edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
