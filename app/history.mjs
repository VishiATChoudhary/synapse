// Chats people already had before Synapse: their Claude Code and Codex sessions, brought in so they can pick one up
// where they left it. Importing links each CLI's own session folder into ~/.synapse/history (nothing is copied or
// moved, and the CLIs keep writing there); the past-chats list reads through those links, and resuming one starts
// the CLI on it in its own folder (`claude --resume <id>`, `codex resume <id>`).
// What a chat is called and where it ran is read from the head of its transcript once, then kept in index.json
// keyed by file and mtime, so the list stays quick with thousands of chats.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE, DATA, WIN, readJSON, writeJSON, claudeMessage, codexMessage } from '../lib.mjs';

const HISTORY = path.join(DATA, 'history');
const INDEX = path.join(HISTORY, 'index.json');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODEX = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// what can be imported; the rest are listed as coming soon
export const SOURCES = [
  { kind: 'claude', label: 'Claude Code', dir: () => path.join(CLAUDE, 'projects') },
  { kind: 'codex', label: 'Codex', dir: () => path.join(CODEX, 'sessions') },
];
export const SOON = [{ kind: 'gemini', label: 'Gemini CLI' }, { kind: 'opencode', label: 'OpenCode' }, { kind: 'cursor-agent', label: 'Cursor' }, { kind: 'copilot', label: 'Copilot' }];

const link = (kind) => path.join(HISTORY, kind);
const imported = (kind) => { try { return fs.lstatSync(link(kind)).isSymbolicLink() && fs.existsSync(link(kind)); } catch { return false; } };

// the transcript files under a session folder: Claude keeps <uuid>.jsonl per project folder (subagents sit deeper
// and are left out), Codex keeps sessions/YYYY/MM/DD/rollout-*.jsonl
function files(kind, root) {
  const out = [];
  const kids = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  if (kind === 'claude') {
    for (const p of kids(root)) if (p.isDirectory()) for (const f of kids(path.join(root, p.name))) {
      if (f.isFile() && f.name.endsWith('.jsonl') && UUID.test(f.name.slice(0, -6))) out.push(path.join(root, p.name, f.name));
    }
  } else {
    const walk = (d, depth) => { for (const e of kids(d)) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 3) walk(p, depth + 1); else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p); } };
    walk(root, 0);
  }
  return out;
}

// how many chats each CLI has, and whether they are imported yet
export function sources() {
  return [
    ...SOURCES.map((s) => ({ kind: s.kind, label: s.label, dir: s.dir(), found: fs.existsSync(s.dir()) ? files(s.kind, s.dir()).length : 0, imported: imported(s.kind) })),
    ...SOON.map((s) => ({ ...s, soon: true })),
  ];
}

export function importChats(kind) {
  const s = SOURCES.find((x) => x.kind === kind);
  if (!s) throw new Error(`Importing ${kind} chats is coming soon.`);
  if (!fs.existsSync(s.dir())) throw new Error(`No ${s.label} chats found in ${s.dir()}.`);
  fs.mkdirSync(HISTORY, { recursive: true });
  if (!imported(kind)) {
    try { fs.unlinkSync(link(kind)); } catch {}
    fs.symlinkSync(s.dir(), link(kind), WIN ? 'junction' : 'dir');
  }
  return sources();
}

// only the link goes: the chats stay where the CLI keeps them
export function removeChats(kind) {
  try { if (fs.lstatSync(link(kind)).isSymbolicLink()) fs.unlinkSync(link(kind)); } catch {}
  return sources();
}

// the start of a transcript, as whole lines; most chats name themselves within the first 64 KB, a few begin with
// large hook or instruction entries and need more
function* head(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let carry = '', at = 0;
    for (const size of [65536, 262144, 1048576]) {
      const buf = Buffer.alloc(size), n = fs.readSync(fd, buf, 0, size, at);
      if (!n) return;
      at += n;
      const lines = (carry + buf.toString('utf8', 0, n)).split('\n');
      carry = lines.pop();
      for (const l of lines) { try { yield JSON.parse(l); } catch {} }
    }
  } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
}

const clip = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 140);
// instructions a CLI puts in the first user message, not something the person typed, and bare commands (/clear)
const PREAMBLE = /^(# AGENTS\.md|<|Caveat:|\/[\w:-]+$)/;

function describe(kind, file) {
  let id = null, cwd = null, title = null, summary = null, started = null;
  if (kind === 'claude') id = path.basename(file, '.jsonl');
  for (const e of head(file)) {
    if (kind === 'claude') {
      cwd ||= e.cwd || null;
      started ||= e.timestamp || null;
      if (e.type === 'summary' && e.summary) summary ||= e.summary;
      if (e.type === 'custom-title' && e.customTitle) summary = e.customTitle;
      const m = !title && claudeMessage(e);
      if (m?.role === 'user' && !PREAMBLE.test(m.text)) title = m.text;
    } else {
      if (e.type === 'session_meta') { id = e.payload?.id || id; cwd = e.payload?.cwd || cwd; started = e.payload?.timestamp || e.timestamp; }
      if (!title && e.type === 'event_msg' && e.payload?.type === 'user_message' && e.payload.message) title = e.payload.message;
      const m = !title && codexMessage(e);
      if (m?.role === 'user' && !PREAMBLE.test(m.text)) title = m.text;
    }
    if (cwd && title && (kind !== 'claude' || summary)) break;
  }
  if (!id || !cwd || !(title || summary)) return null; // a session that never got a prompt has nothing to go back to
  return { id, cwd, title: clip(summary || title), started };
}

// the imported chats, newest first; a chat whose folder is gone is still listed, marked missing. The first scan
// reads thousands of files: it hands the event loop back every few dozen so the app stays responsive
let scanning = null;
export function pastChats(opts) { return (scanning ||= scan(opts).finally(() => { scanning = null; })); }
async function scan({ limit = 2000 } = {}) {
  const index = readJSON(INDEX, {}), next = {};
  const out = [];
  for (const s of SOURCES) {
    if (!imported(s.kind)) continue;
    for (const [i, file] of files(s.kind, link(s.kind)).entries()) {
      if (i % 40 === 39) await new Promise((ok) => setImmediate(ok));
      let st; try { st = fs.statSync(file); } catch { continue; }
      const real = path.join(s.dir(), path.relative(link(s.kind), file)); // what the CLI itself calls the file
      const known = index[real];
      const d = known && known.mtime === st.mtimeMs ? known.d : describe(s.kind, file);
      next[real] = { mtime: st.mtimeMs, d };
      if (d) out.push({ kind: s.kind, ...d, transcript: real, updatedAt: st.mtimeMs, missing: !fs.existsSync(d.cwd) });
    }
  }
  try { fs.mkdirSync(HISTORY, { recursive: true }); writeJSON(INDEX, next); } catch {}
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
