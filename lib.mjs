// Shared core: agent discovery (Claude, Codex, Amp, OpenCode, Copilot, Gemini, Superset CLI),
// transcript parsing, and the local state the server, hook and MCP server all use.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
export const CLAUDE = process.env.SYNAPSE_CLAUDE_HOME || path.join(HOME, '.claude');
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
  names: path.join(DATA, 'names.json'),
  projects: path.join(DATA, 'projects.json'),
  forks: path.join(DATA, 'forks.json'),
  lineage: path.join(DATA, 'lineage.json'),
  app: path.join(DATA, 'app.json'),
  remote: path.join(DATA, 'remote.json'),           // multiplayer: this machine's relay identity and its friends
  peerState: path.join(DATA, 'remote', 'state.json'), // the agents each friend's machine last reported
  account: path.join(DATA, 'account.json'),         // Synapse Cloud sign-in: { cloud, token, user }
  offers: path.join(DATA, 'offers.json'),           // my agents I offered to friends, by request id, to link once they accept
  requests: path.join(DATA, 'requests.json'),       // synapse requests last fetched from the cloud
  talks: path.join(DATA, 'talks.json'),             // agent talk: conversations with friends' agents
};
export const REMOTE_DIR = path.join(DATA, 'remote');

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJSON(file, value) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// A read-modify-write that other processes (server, MCP, CLI, hooks) may run at the same time: hold a lock file
// while fn runs. A holder that died leaves the lock behind; after 5 s it counts as stale.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function withLock(lock, fn) {
  for (let i = 0; ; i++) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (i > 600) throw new Error(`${path.basename(lock)} stayed locked`);
      pause(10);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
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
  // newer Codex logs each shell command as a CommandExecution item, often with no matching function_call
  if (e.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'CommandExecution') {
    const c = p.item.command;
    const cmd = Array.isArray(c) ? (c.length >= 3 && /^-l?c$/.test(c[c.length - 2]) ? c[c.length - 1] : c.join(' ')) : typeof c === 'string' ? c : '';
    return cmd ? { role: 'assistant', text: toolLine('exec', { command: cmd }), ts: e.timestamp, tool: true } : null;
  }
  if (e.type !== 'response_item') return null;
  // code mode wraps commands in a script (`tools.exec_command(...)`); those show up as CommandExecution above
  if (p.type === 'custom_tool_call' && p.name === 'exec') {
    const called = [...new Set([...String(p.input || '').matchAll(/tools\.(\w+)\(/g)].map((m) => m[1]))].filter((n) => n !== 'exec_command');
    return called.length ? { role: 'assistant', text: toolLine('exec', { command: called.join(', ') }), ts: e.timestamp, tool: true } : null;
  }
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

// friends' agents arrive as our own JSONL of {role, text, ts, tool} (see remote.mjs)
const remoteMessage = (e) => (e.role && typeof e.text === 'string' ? { role: e.role, text: e.text, ts: e.ts, tool: e.tool } : null);

const PARSERS = { claude: claudeMessage, codex: codexMessage, remote: remoteMessage };

// ---- media, for the phone: images an agent saw (screenshots, images it opened, images pasted in) and video
// files it touched. Claude keeps images as base64 blocks (in tool results and user content), Codex as data
// URLs (tool outputs, input_image); videos are only ever paths in what the agent ran or said.
const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/;
const VIDEO_PATH = /(?:^|[\s"'`(=,[])((?:~|\.{1,2})?\/?[\w@%+.\-/]*[\w-]\.(?:mp4|mov|m4v|webm|gif))(?=$|[\s"'`),\]:;!?\\]|\.(?:\s|$))/gi;
function mediaOf(e, line, format) {
  if (format === 'claude' ? !['user', 'assistant'].includes(e.type) || e.isMeta || e.isSidechain : e.type !== 'response_item') return null;
  const images = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 8 || images.length >= 12) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    if (o.type === 'image' && o.source?.type === 'base64' && IMAGE_MIME.test(o.source.media_type || '') && o.source.data) images.push({ mime: o.source.media_type, data: o.source.data });
    for (const v of Object.values(o)) {
      if (typeof v === 'string' && v.startsWith('data:image/')) {
        const m = v.match(/^data:(image\/[\w+.-]+);base64,(.+)$/s);
        if (m && IMAGE_MIME.test(m[1])) images.push({ mime: m[1], data: m[2] });
      } else if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(format === 'claude' ? e.message?.content : e.payload, 0);
  const videos = [...new Set([...line.matchAll(VIDEO_PATH)].map((m) => m[1]))].slice(0, 3);
  return images.length || videos.length ? { images, videos } : null;
}
// a parser that also keeps the media of each entry; an entry that is only media becomes a media-only message
const withMedia = (parse, format) => (e, line) => {
  const m = parse(e), media = mediaOf(e, line, format);
  if (!media) return m;
  return m ? { ...m, media } : { role: 'assistant', text: '', ts: e.timestamp, tool: true, media };
};

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
    try { const m = parse(JSON.parse(l), l); if (m) messages.push(m); } catch {}
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

// OpenCode and Cursor keep sessions in SQLite; node:sqlite (Node >= 22.5) reads them without a dependency.
// A store that cannot be opened reads as an empty conversation.
function openDb(file) {
  try {
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    return sqlite ? new sqlite.DatabaseSync(file, { readOnly: true }) : null;
  } catch { return null; }
}

function windowFrom(all, from) {
  const start = from == null ? Math.max(0, all.length - 60) : Math.min(from, all.length);
  return { messages: all.slice(start), end: all.length };
}

// OpenCode: one opencode.db for every session. The transcript is "<db>#<session id>"; messages are rows
// (data.role) and their text and tool calls are rows of `part`.
function readOpenCode(transcript, from) {
  const file = transcriptFile({ transcript, format: 'opencode' });
  const id = transcript.slice(file.length + 1);
  const db = openDb(file);
  if (!db || !id) return { messages: [], end: from };
  const all = [];
  try {
    const parts = new Map();
    for (const r of db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id').all(id)) {
      if (!parts.has(r.message_id)) parts.set(r.message_id, []);
      try { parts.get(r.message_id).push(JSON.parse(r.data)); } catch {}
    }
    for (const r of db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(id)) {
      let role; try { role = JSON.parse(r.data).role; } catch { continue; }
      const ps = parts.get(r.id) || [];
      const text = ps.filter((p) => p.type === 'text' && !p.synthetic && !p.ignored).map((p) => p.text || '').join('\n').trim();
      if (role === 'user') { if (text && !NOISE.test(text)) all.push({ role, text, ts: r.time_created }); continue; }
      if (role !== 'assistant') continue;
      const tools = ps.filter((p) => p.type === 'tool').map((p) => toolLine(p.tool, p.state?.input));
      if (text || tools.length) all.push({ role, text: [text, ...tools].filter(Boolean).join('\n'), ts: r.time_created, tool: !text });
    }
  } catch {} finally { try { db.close(); } catch {} }
  return windowFrom(all, from);
}

// Cursor: each chat is a store.db of content-addressed blobs. meta holds (as hex JSON) the id of a root blob
// whose protobuf starts with the 32-byte ids of the message blobs, in order; each message is JSON.
function cursorRefs(root) {
  const refs = [];
  for (let i = 0; i + 34 <= root.length && root[i] === 0x0a && root[i + 1] === 32; i += 34) refs.push(Buffer.from(root.subarray(i + 2, i + 34)).toString('hex'));
  return refs;
}

function readCursor(file, from) {
  const db = openDb(file);
  if (!db) return { messages: [], end: from };
  const all = [];
  try {
    const meta = JSON.parse(Buffer.from(db.prepare('SELECT value FROM meta LIMIT 1').get().value, 'hex').toString());
    const get = db.prepare('SELECT data FROM blobs WHERE id = ?');
    const root = get.get(meta.latestRootBlobId)?.data;
    const ts = meta.createdAt;
    for (const ref of root ? cursorRefs(root) : []) {
      let m; try { m = JSON.parse(Buffer.from(get.get(ref).data).toString()); } catch { continue; }
      const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('\n').trim();
      if (m.role === 'user') {
        // the first user message is Cursor's own context; the person's words sit in <user_query>
        const q = /<user_query>([\s\S]*?)<\/user_query>/.exec(text)?.[1].trim();
        const t = q ?? (text.startsWith('<') ? '' : text);
        if (t) all.push({ role: 'user', text: t, ts });
      } else if (m.role === 'assistant') {
        const tools = parts.filter((p) => p.type === 'tool-call').map((p) => toolLine(p.toolName, p.args));
        if (text || tools.length) all.push({ role: 'assistant', text: [text, ...tools].filter(Boolean).join('\n'), ts, tool: !text });
      }
    }
  } catch {} finally { try { db.close(); } catch {} }
  return windowFrom(all, from);
}

// The file on disk behind a transcript. Only OpenCode adds "#<session id>"; every other path is taken whole,
// so a claude or codex path with a '#' in it still reads.
export function transcriptFile(src) {
  const t = src?.transcript;
  if (typeof t !== 'string' || !t) return null;
  if (src.format !== 'opencode') return t;
  const at = t.lastIndexOf('#');
  return at > 0 ? t.slice(0, at) : t;
}

// Unified reader. `src` is { transcript, format }.
export function readAgentMessages(src, cursor = null, opts = {}) {
  if (src?.format === 'demo') return { messages: cursor == null ? src.demo : src.demo.slice(cursor), end: src.demo.length };
  const file = transcriptFile(src);
  if (!file || !fs.existsSync(file)) return { messages: [], end: cursor };
  if (src.format === 'opencode') return readOpenCode(src.transcript, cursor);
  if (src.format === 'cursor-agent') return readCursor(src.transcript, cursor);
  if (src.format === 'gemini') return readGemini(src.transcript, cursor);
  const parse = PARSERS[src.format] || claudeMessage;
  const media = opts.media && ['claude', 'codex'].includes(src.format || 'claude');
  return readJsonl(src.transcript, cursor, media ? withMedia(parse, src.format || 'claude') : parse, opts.tailBytes, opts.minMessages);
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
const transcriptMiss = new Map();  // agent id -> when a search last came up empty, so it is not redone every second
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The `resume` subcommand of a codex command line: { id } for `resume [flags] <id>`, { last: true } for
// `resume --last` or the picker, null when this is not a resume. Read token by token, so a prompt that merely
// mentions "resume <uuid>" does not count.
export function codexResume(cmd) {
  const argv = String(cmd || '').split(/\s+/).filter(Boolean);
  const at = argv.findIndex((t, i) => t === 'resume' && argv.slice(0, i).every((x) => x.startsWith('-') || /(^|\/)(node|codex)$/.test(x)));
  if (at < 0) return null;
  for (let i = at + 1; i < argv.length; i++) {
    if (UUID_RE.test(argv[i])) return { id: argv[i].toLowerCase() };
    if (argv[i] === '--last') return { last: true };
    if (!argv[i].startsWith('-')) break; // the prompt, or a flag's value
    if (!argv[i].includes('=') && argv[i + 1] && !argv[i + 1].startsWith('-') && !UUID_RE.test(argv[i + 1])) i++; // skip a flag's value
  }
  return { last: true };
}

// every rollout under sessions/YYYY/MM/DD, newest day first
function* codexRollouts(homes) {
  const kids = (d) => { try { return fs.readdirSync(d).sort().reverse(); } catch { return []; } };
  for (const home of homes) {
    const root = path.join(home, 'sessions');
    for (const y of kids(root)) for (const m of kids(path.join(root, y))) for (const d of kids(path.join(root, y, m))) {
      for (const f of kids(path.join(root, y, m, d))) if (f.startsWith('rollout-')) yield path.join(root, y, m, d, f);
    }
  }
}

// session_meta can be huge (it embeds instructions), so just pull cwd out of the head
function codexCwd(p) {
  try {
    const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(65536); fs.readSync(fd, buf, 0, 65536, 0); fs.closeSync(fd);
    const m = buf.toString('utf8').match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; }
}

export function codexTranscript(id, cwd, start, cmd = '') {
  if (transcriptCache.has(id)) return transcriptCache.get(id);
  if (Date.now() - (transcriptMiss.get(id) || 0) < 60_000) return null;
  const homes = [process.env.CODEX_HOME, path.join(HOME, '.codex')].filter(Boolean);
  const found = (p) => { if (p) transcriptCache.set(id, p); else transcriptMiss.set(id, Date.now()); return p; };
  // `codex resume` (how the app brings agents back after a restart) keeps appending to the session's original
  // rollout, born long before this process: by the id in its name, or for --last the newest one written since
  const resume = codexResume(cmd);
  if (resume?.id) {
    const suffix = `-${resume.id}.jsonl`;
    for (const p of codexRollouts(homes)) if (p.endsWith(suffix)) return found(p);
    return found(null);
  }
  if (resume?.last) {
    let best = null;
    for (const p of codexRollouts(homes)) {
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs < start || (best && st.mtimeMs <= best.m) || codexCwd(p) !== cwd) continue;
      best = { p, m: st.mtimeMs };
    }
    return found(best?.p || null);
  }
  let best = null;
  for (const home of homes) {
    for (let d = 0; d < 3; d++) {
      const day = new Date(start + d * 86400_000);
      const dir = path.join(home, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.startsWith('rollout-')); } catch { continue; }
      for (const f of files) {
        const p = path.join(dir, f);
        // the name carries the session's creation time (local); a session created before this process started
        // belongs to an earlier run, even if Codex touched the file since (it rewrites old rollouts on startup)
        const born = /^rollout-(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(f);
        if (born && new Date(+born[1], born[2] - 1, +born[3], +born[4], +born[5], +born[6]).getTime() < start - 2000) continue;
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

// OpenCode: the newest top-level session of this directory touched since the process started.
export function opencodeTranscript(cwd, start, home = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share')) {
  const file = path.join(home, 'opencode', 'opencode.db');
  if (!fs.existsSync(file)) return null;
  const db = openDb(file);
  if (!db) return null;
  try {
    const row = db.prepare('SELECT id FROM session WHERE directory = ? AND parent_id IS NULL AND time_updated >= ? ORDER BY time_updated DESC LIMIT 1').get(cwd, start - 60_000);
    return row ? `${file}#${row.id}` : null;
  } catch { return null; } finally { try { db.close(); } catch {} }
}

// Cursor: chats/<md5 of the workspace path>/<chat id>/store.db; take the one written to since the process started.
export function cursorTranscript(cwd, start, home = path.join(HOME, '.cursor')) {
  const dir = path.join(home, 'chats', crypto.createHash('md5').update(cwd).digest('hex'));
  let best = null;
  try {
    for (const id of fs.readdirSync(dir)) {
      const db = path.join(dir, id, 'store.db');
      let m = 0;
      for (const f of [db, `${db}-wal`]) { try { m = Math.max(m, fs.statSync(f).mtimeMs); } catch {} }
      if (m && m >= start - 60_000 && (!best || m > best.m)) best = { p: db, m };
    }
  } catch {}
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
    const transcript = r.kind === 'codex' ? codexTranscript(id, cwd, r.start, r.cmd)
      : r.kind === 'gemini' ? geminiTranscript(cwd, r.start)
      : r.kind === 'opencode' ? opencodeTranscript(cwd, r.start)
      : r.kind === 'cursor-agent' ? cursorTranscript(cwd, r.start) : null;
    return {
      id, pid: r.pid, kind: r.kind, name: `${r.kind}-${path.basename(cwd)}`.toLowerCase(), cwd,
      status: (busyCpu.get(r.pid) || 0) > 4 ? 'busy' : 'idle', startedAt: r.start, updatedAt: r.start,
      transcript, format: ['codex', 'gemini', 'opencode', 'cursor-agent'].includes(r.kind) ? r.kind : null,
    };
  });
}

// ---------------------------------------------------------------- friends' agents (multiplayer)

// A friend's agent gets an id of its own here: their machine id plus the id it has over there.
export const remoteId = (machine, agentId) => `r-${machine}-${agentId}`;
export const remoteLog = (machine, agentId) => path.join(REMOTE_DIR, machine, `${String(agentId).replace(/[^\w.-]/g, '_')}.jsonl`);
export const REMOTE_STALE = 10 * 60_000;  // a friend's agents leave the canvas this long after their machine went quiet
export const REMOTE_OFFLINE = 90_000;     // ... and show as offline after this

function remoteAgents() {
  const cfg = readJSON(FILES.remote, null);
  if (!cfg?.peers) return [];
  const states = readJSON(FILES.peerState, {});
  const now = Date.now(), out = [];
  for (const [m, peer] of Object.entries(cfg.peers)) {
    const st = states[m];
    if (!st || now - st.seen > REMOTE_STALE) continue;
    const owner = st.name || peer.name;
    for (const a of st.agents || []) {
      const closed = a.status === 'closed'; // a talk agent whose session ended; its owner still answers from a snapshot
      const log = remoteLog(m, a.id);
      out.push({
        id: remoteId(m, a.id), pid: null, kind: a.kind, name: a.name, cwd: `${owner}'s machine · ${a.project}`,
        status: closed ? 'closed' : now - st.seen > REMOTE_OFFLINE ? 'offline' : a.status, startedAt: a.startedAt, updatedAt: st.seen,
        transcript: fs.existsSync(log) ? log : null, format: 'remote',
        remote: { machine: m, owner, handle: peer.handle || null, agentId: a.id, project: a.project },
      });
    }
  }
  return out;
}

// Every agent Synapse knows about: this machine's, then friends' (multiplayer). Friends' agents carry `remote`.
export function listAgents() {
  return [...localAgents(), ...remoteAgents()];
}

// The processes and sessions answering a friend's questions (agent talk). They are never agents of their own:
// not listed, linked, shared or resumable. Read here rather than in talk.mjs, which imports this file.
export function externalForks() {
  const s = readJSON(FILES.talks, {});
  const sessions = new Set((s.conversations || []).map((c) => c.forkSession).filter((v) => typeof v === 'string' && v));
  const pids = new Set((s.running || []).map((r) => r.pid).filter(Number.isInteger));
  return { sessions, pids };
}

export function localAgents() {
  const ext = externalForks();
  const found = (DEMO ? DEMO.demoAgents() : [...claudeAgents(), ...processAgents()])
    .filter((a) => !ext.sessions.has(a.id) && !ext.pids.has(a.pid));
  // names given in the canvas or with `synapse rename` win over the generated ones
  const names = readJSON(FILES.names, {});
  // forks: which agent each one was forked from and the question it was given (the app records it by pid)
  const lineage = readJSON(FILES.lineage, {});
  return found.map((a) => {
    const n = names[a.id] ? { ...a, name: names[a.id], autoName: a.name } : a;
    const f = lineage[a.pid];
    return f ? { ...n, forkOf: f.parent, forkQ: f.question } : n;
  });
}

// Remember that the process `pid` was forked from agent `parent` to look into `question`. Entries for
// processes that are gone are dropped on the way, so the file never grows past what is running.
const processAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function recordFork(pid, parent, question) {
  const lineage = readJSON(FILES.lineage, {});
  for (const k of Object.keys(lineage)) if (!processAlive(Number(k))) delete lineage[k];
  lineage[pid] = { parent, question: String(question || ''), at: Date.now() };
  writeJSON(FILES.lineage, lineage);
}

// Rename an agent; an empty name goes back to the generated one. Links keep the new name too.
export function renameAgent(agent, name) {
  if (agent.remote) throw new Error(`${agent.name} runs on ${agent.remote.owner}'s machine; only they can rename it`);
  name = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 48);
  const others = localAgents().filter((a) => a.id !== agent.id);
  if (name && others.some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new Error(`another agent is already called "${name}"`);
  const names = readJSON(FILES.names, {});
  if (name) names[agent.id] = name; else delete names[agent.id];
  writeJSON(FILES.names, names);
  const shown = name || agent.autoName || agent.name;
  const edges = readJSON(FILES.edges, []);
  let touched = false;
  for (const e of edges) {
    if (e.from === agent.id) { e.fromName = shown; touched = true; }
    if (e.to === agent.id) { e.toName = shown; touched = true; }
  }
  if (touched) writeJSON(FILES.edges, edges);
  return { id: agent.id, name: shown };
}

// Find which agent a process belongs to by walking up its parents (used by the MCP server).
export function agentForProcess(pid) {
  const agents = localAgents();
  const rows = new Map(processTable().map((r) => [r.pid, r]));
  for (let p = pid, guard = 0; p > 1 && guard < 64; p = rows.get(p)?.ppid, guard++) {
    const a = agents.find((x) => x.pid === p);
    if (a) return a;
  }
  return null;
}

// Resolve "name", "id" or a unique prefix of either. A friend's agent also answers to "name@friend" (their name or their handle).
export function findAgent(agents, query) {
  const q = String(query || '').toLowerCase().trim();
  return agents.find((a) => a.id === query || a.name.toLowerCase() === q)
    || agents.find((a) => a.remote && (`${a.name}@${a.remote.owner}`.toLowerCase() === q || (a.remote.handle && `${a.name}@${a.remote.handle}`.toLowerCase() === q)))
    || agents.find((a) => a.name.toLowerCase().startsWith(q) || a.id.startsWith(q)) || null;
}

// ---------------------------------------------------------------- projects & colours

// Group sessions by real project: worktrees share their main repo's git dir.
// `label` is what is shown (a name given in the canvas or with `synapse rename-project` wins),
// `autoLabel` is the generated one. `worktree` is set when cwd is in a linked worktree.
const projectCache = new Map();
export function projectOf(cwd) {
  let p = projectCache.get(cwd);
  if (!p) {
    let key = null, label = path.basename(cwd), worktree = null;
    try {
      const [top, common] = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim().split('\n');
      key = common.replace(/\/\.git\/?$/, '');
      label = path.basename(key);
      if (top && top !== key) worktree = { path: top, name: path.basename(top) }; // a linked worktree, not the repo's own folder
    } catch {}
    const wt = cwd.match(/\/worktrees\/([^/]+)\//); // e.g. ~/.superset/worktrees/<Project>/<branch>
    if (wt) label = wt[1];
    if (!key) key = `project:${label}`; // not a git repo: group by name
    else if (!worktree) { // a repo's own folder was once keyed by name: carry its given name over
      const given = readJSON(FILES.projects, {}), old = `project:${label}`;
      if (given[old] && !given[key]) { given[key] = given[old]; delete given[old]; writeJSON(FILES.projects, given); }
    }
    p = { key, autoLabel: label, worktree };
    projectCache.set(cwd, p);
  }
  const given = readJSON(FILES.projects, {})[p.key];
  return { key: p.key, label: given || p.autoLabel, autoLabel: p.autoLabel, worktree: p.worktree };
}

// A friend's agents are grouped by friend and project, apart from this machine's projects.
export function projectOfAgent(a) {
  if (!a.remote) return projectOf(a.cwd);
  const label = `${a.remote.owner} · ${a.remote.project}`;
  return { key: `remote:${a.remote.machine}:${a.remote.project}`, label, autoLabel: label };
}

// Rename a project; an empty name goes back to the generated one.
export function renameProject(key, name) {
  name = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 48);
  const live = new Map(localAgents().map((a) => { const p = projectOf(a.cwd); return [p.key, p]; }));
  if (name && [...live.values()].some((p) => p.key !== key && p.label.toLowerCase() === name.toLowerCase())) {
    throw new Error(`another project is already called "${name}"`);
  }
  const given = readJSON(FILES.projects, {});
  if (name) given[key] = name; else delete given[key];
  writeJSON(FILES.projects, given);
  const auto = live.get(key)?.autoLabel ?? [...projectCache.values()].find((p) => p.key === key)?.autoLabel ?? path.basename(key);
  return { key, label: name || auto };
}

// Stable colour per project: first come, first served from a flat palette, persisted.
// Print-ink colours that read on both the light and the dark canvas, ordered so neighbours
// are far apart in hue. Orange is left out: the canvas uses it for "working".
const PALETTE = ['#2F5BEA', '#E3A600', '#00A36C', '#E5458F', '#6F8F1F', '#7B4FD8', '#1D9BB0', '#C2410C', '#9C6B3C', '#0F766E', '#B0306A', '#64748B'];
// colours handed out before the palette changed, mapped slot for slot onto the new one
const OLD_PALETTE = ['#6C7CFF', '#F2B33D', '#2EC4A0', '#FF5C7A', '#A3D33C', '#D65FE0', '#3FB8F5', '#FF8552', '#E8D8B0', '#14A3A3', '#B7835A', '#A3ADC2'];
export function colorOf(key) {
  const colors = readJSON(FILES.colors, {});
  let migrated = false;
  for (const [k, c] of Object.entries(colors)) {
    const i = OLD_PALETTE.indexOf(c);
    if (i >= 0) { colors[k] = PALETTE[i]; migrated = true; }
  }
  // two projects on one slot (e.g. an agent still running older code picked one): first keeps it
  const seen = new Set();
  for (const [k, c] of Object.entries(colors)) {
    if (!seen.has(c)) { seen.add(c); continue; }
    const free = PALETTE.find((p) => !seen.has(p));
    if (free) { colors[k] = free; seen.add(free); migrated = true; }
  }
  if (migrated) writeJSON(FILES.colors, colors);
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
