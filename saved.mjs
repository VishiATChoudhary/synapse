// Saved chats (⌘S in the app, `synapse saved` on the command line). An agent's transcript is archived losslessly
// in place of the original: the archive rebuilds it byte for byte (checked before the original is removed), so the
// chat can be cleared now and resumed later exactly as it was (`synapse saved restore <id>`). Nothing is kept twice.
//
// The archive (.synz): images that agents saw sit in transcripts as base64, often the same screenshot several
// times; each one is stored once, as binary. The rest of the text is compressed with zstd over a long window, which
// catches the files and tool outputs a session reads again and again. Layout:
//   "SYNZ1\n", header length (4 bytes, big endian), header JSON, zstd(text), zstd(blob + blob + ...)
// In the text an image is "\0<n>\0" where its base64 string stood: a raw NUL never occurs in JSON Lines, and a
// transcript that has one is stored without lifting images out.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DATA, readJSON, writeJSON, readAgentMessages, transcriptFile } from './lib.mjs';

export const SAVED = path.join(DATA, 'saved');
const INDEX = path.join(SAVED, 'index.json');
const MAGIC = Buffer.from('SYNZ1\n');
const zstd = promisify(zlib.zstdCompress), unzstd = promisify(zlib.zstdDecompress);
const ZOPTS = { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19, [zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1, [zlib.constants.ZSTD_c_windowLog]: 27 } };
const DOPTS = { params: { [zlib.constants.ZSTD_d_windowLogMax]: 27 } };
const B64 = /"([A-Za-z0-9+/]{1000,}={0,2})"/g;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// a transcript (Buffer) -> archive (Buffer)
export async function pack(raw) {
  let text = raw.toString('latin1'); // one char per byte: whatever the bytes are, they come back the same
  const blobs = [], byHash = new Map();
  if (!text.includes('\0')) {
    text = text.replace(B64, (whole, b64) => {
      const bin = Buffer.from(b64, 'base64');
      if (bin.toString('base64') !== b64) return whole; // not canonical base64: leave it as text
      const h = sha(bin);
      if (!byHash.has(h)) { byHash.set(h, blobs.length); blobs.push(bin); }
      return `"\0${byHash.get(h)}\0"`;
    });
  }
  // screenshots are PNG or JPEG already, but similar ones and the odd other blob still give a little
  const [z, zb] = await Promise.all([zstd(Buffer.from(text, 'latin1'), ZOPTS), blobs.length ? zstd(Buffer.concat(blobs), ZOPTS) : Buffer.alloc(0)]);
  const header = Buffer.from(JSON.stringify({ v: 1, bytes: raw.length, sha256: sha(raw), text: z.length, packed: zb.length, blobs: blobs.map((b) => b.length) }));
  const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
  return Buffer.concat([MAGIC, len, header, z, zb]);
}

// archive -> the transcript, exactly; throws if it does not hash to what was packed
export async function unpack(archive) {
  if (!archive.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Synapse archive.');
  const hl = archive.readUInt32BE(MAGIC.length), at = MAGIC.length + 4;
  const h = JSON.parse(archive.subarray(at, at + hl).toString());
  let off = at + hl;
  const text = (await unzstd(archive.subarray(off, off + h.text), DOPTS)).toString('latin1');
  off += h.text;
  const all = h.blobs.length ? await unzstd(archive.subarray(off, off + h.packed), DOPTS) : Buffer.alloc(0);
  let bo = 0;
  const blobs = h.blobs.map((n) => { const b = all.subarray(bo, bo + n); bo += n; return b; });
  const raw = Buffer.from(blobs.length ? text.replace(/"\0(\d+)\0"/g, (_, i) => `"${blobs[+i].toString('base64')}"`) : text, 'latin1');
  if (raw.length !== h.bytes || sha(raw) !== h.sha256) throw new Error('The archive does not rebuild the transcript exactly.');
  return raw;
}

// ---------------------------------------------------------------- what to start a cleared session with

const one = (t, n) => { t = String(t).replace(/\s+/g, ' ').trim(); return t.length <= n ? t : `${t.slice(0, n - 1)}…`; };
// a few lines from the conversation (prompts and answers; tool calls left out)
export function digest(id, messages) {
  const asks = messages.filter((m) => m.role === 'user').map((m) => m.text);
  const answer = [...messages].reverse().find((m) => m.role === 'assistant' && !m.tool)?.text || '';
  const edited = [...new Set(messages.flatMap((m) => [...String(m.text).matchAll(/^\[(?:Edit|MultiEdit|Write|NotebookEdit|apply_patch): ([^\]]+)\]$/gm)].map((x) => x[1].trim())))];
  return [
    `Context from before the clear. The whole earlier chat is archived losslessly as ${id}: run \`synapse saved ${id}\` to read it (prompts, answers and every command) before answering anything about earlier work.`,
    asks[0] ? `Started with: ${one(asks[0], 300)}` : '',
    asks.length > 1 ? `Then asked:\n${asks.slice(1).slice(-6).map((a) => `- ${one(a, 160)}`).join('\n')}` : '',
    answer ? `Last answer: ${one(answer, 500)}` : '',
    edited.length ? `Files edited: ${edited.slice(-12).join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- saving, listing, reading, restoring

const slug = (s) => String(s || 'agent').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'agent';
export const list = () => readJSON(INDEX, []);
const put = (entry) => writeJSON(INDEX, [entry, ...list().filter((e) => e.id !== entry.id)]);
const ARCHIVABLE = ['claude', 'codex']; // one JSON Lines file per session, which `--resume` / `resume` reads back

// what ⌘S shows before anything happens: the id the archive will have, its digest, how big the transcript is
export function prepare(agent, now = Date.now()) {
  const file = transcriptFile(agent);
  if (!file || !ARCHIVABLE.includes(agent.format || agent.kind) || !fs.existsSync(file)) throw new Error(`${agent.name || 'This agent'} has no transcript Synapse can archive (Claude and Codex chats can be).`);
  const { messages } = readAgentMessages(agent, 0);
  if (!messages.length) throw new Error(`${agent.name || 'This agent'} has nothing to save yet.`);
  const id = `${new Date(now).toISOString().slice(0, 10)}-${slug(agent.name)}-${crypto.randomBytes(2).toString('hex')}`;
  return { id, file, raw: fs.statSync(file).size, messages: messages.length, digest: digest(id, messages) };
}

// archive the transcript as `id`, check it rebuilds exactly, then remove the original (keep: leave it)
export async function archive(agent, id, { keep = false, now = Date.now() } = {}) {
  const file = transcriptFile(agent);
  const before = fs.statSync(file), raw = fs.readFileSync(file);
  const body = await pack(raw);
  if (!(await unpack(body)).equals(raw)) throw new Error('The archive did not rebuild the transcript; nothing was removed.');
  fs.mkdirSync(SAVED, { recursive: true });
  fs.writeFileSync(path.join(SAVED, `${id}.synz`), body);
  // removed only if nothing was written to it while packing; a session still writing keeps its file
  const after = fs.statSync(file);
  const removed = !keep && after.size === before.size && after.mtimeMs === before.mtimeMs;
  if (removed) fs.unlinkSync(file);
  const entry = { id, name: agent.name, kind: agent.kind, format: agent.format || agent.kind, cwd: agent.cwd, agent: agent.id, src: file, savedAt: now, raw: raw.length, size: body.length, removed };
  put(entry);
  return entry;
}

function find(query) {
  const all = list(), q = String(query || '').toLowerCase();
  const hit = all.find((e) => e.id === query) || all.find((e) => e.id.includes(q) || String(e.name).toLowerCase().includes(q));
  if (!hit) throw new Error(`No saved chat matches "${query}". Run "synapse saved" to list them.`);
  return hit;
}
const archiveOf = (e) => path.join(SAVED, `${e.id}.synz`);

// the transcript, rebuilt in memory
export async function read(query) {
  const e = find(query);
  return { entry: e, raw: await unpack(fs.readFileSync(archiveOf(e))) };
}

// the conversation as text: every prompt, answer and command, oldest first
export async function render(query) {
  const { entry, raw } = await read(query);
  const tmp = path.join(SAVED, `.read-${process.pid}.jsonl`);
  fs.writeFileSync(tmp, raw);
  try {
    const { messages } = readAgentMessages({ transcript: tmp, format: entry.format }, 0);
    return [`# ${entry.name} (${entry.kind}) · ${entry.cwd} · saved ${new Date(entry.savedAt).toISOString()}`,
      ...messages.map((m) => `${m.role === 'user' ? 'U' : 'A'}: ${m.text}`)].join('\n\n');
  } finally { fs.rmSync(tmp, { force: true }); }
}

// put the transcript back where it was, exactly, so the agent's own resume picks it up again
export async function restore(query) {
  const { entry, raw } = await read(query);
  if (fs.existsSync(entry.src)) {
    if (sha(fs.readFileSync(entry.src)) === sha(raw)) return { ...entry, restored: entry.src, already: true };
    throw new Error(`${entry.src} exists and differs from the archive; move it away first.`);
  }
  fs.mkdirSync(path.dirname(entry.src), { recursive: true });
  fs.writeFileSync(entry.src, raw);
  put({ ...entry, removed: false });
  return { ...entry, restored: entry.src, resume: entry.kind === 'claude' ? `claude --resume ${path.basename(entry.src, '.jsonl')}` : entry.kind === 'codex' ? 'codex resume' : null };
}
