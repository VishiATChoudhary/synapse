// Synthetic OpenCode and Cursor session stores (invented text, same layout as the real ones).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const OC_SESSION = 'ses_fixture1';

// <home>/opencode/opencode.db with one session for `cwd` and one subagent session
export function buildOpenCode(home, cwd, now = Date.now()) {
  fs.mkdirSync(path.join(home, 'opencode'), { recursive: true });
  const file = path.join(home, 'opencode', 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  const sess = db.prepare('INSERT INTO session VALUES (?,?,?,?,?)');
  sess.run(OC_SESSION, cwd, null, now, now);
  sess.run('ses_child', cwd, OC_SESSION, now, now + 5);
  let t = now;
  const msg = (id, data, parts) => {
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, OC_SESSION, ++t, t, JSON.stringify(data));
    parts.forEach((p, i) => db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(`${id}_p${i}`, id, OC_SESSION, ++t, t, JSON.stringify(p)));
  };
  msg('m1', { role: 'user' }, [{ type: 'text', text: 'Please add a retry to the fetch helper' }]);
  msg('m2', { role: 'assistant' }, [
    { type: 'step-start' }, { type: 'reasoning', text: 'thinking about retries' },
    { type: 'text', text: 'I will wrap fetch in a backoff loop.' },
    { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'grep -rn fetchHelper src' }, output: 'src/a.js' } },
    { type: 'step-finish' },
  ]);
  msg('m3', { role: 'user' }, [{ type: 'text', text: 'Use three attempts' }, { type: 'text', text: 'synthetic context', synthetic: true }]);
  msg('m4', { role: 'assistant' }, [{ type: 'tool', tool: 'edit', state: { input: { file_path: 'src/fetch.js' } } }]);
  db.close();
  return file;
}

export const OC_V2_SESSION = 'ses_fixture2';

export function buildOpenCodeV2(home, cwd, now = Date.now()) {
  fs.mkdirSync(path.join(home, 'opencode'), { recursive: true });
  const file = path.join(home, 'opencode', 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  const session = db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?)');
  session.run(OC_V2_SESSION, cwd, null, now, now);
  session.run('ses_v2child', cwd, OC_V2_SESSION, now, now + 100);
  let seq = 0;
  const msg = (type, data) => {
    seq++;
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(`v2m${seq}`, OC_V2_SESSION, type, seq, now + seq, now + seq, JSON.stringify(data));
  };
  msg('system', { text: 'private system instructions' });
  msg('user', { text: 'Please add a retry to the fetch helper', files: [], agents: [] });
  msg('assistant', { content: [
    { type: 'reasoning', text: 'private reasoning' },
    { type: 'text', text: 'I will wrap fetch in a backoff loop.' },
    { type: 'tool', name: 'shell', state: { status: 'completed', input: { command: 'rg fetchHelper src' }, content: [{ type: 'text', text: 'src/a.js' }] } },
  ], time: { completed: now + 3 }, finish: 'tool-calls' });
  msg('user', { text: 'Use three attempts' });
  msg('assistant', { content: [{ type: 'tool', name: 'edit', state: { input: { file_path: 'src/fetch.js' } } }] });
  msg('idle', { outcome: 'succeeded' });
  msg('synthetic', { text: 'private injected context' });
  db.close();
  return file;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest();

// <home>/chats/<md5 cwd>/<chat id>/store.db; returns its path
export function buildCursor(home, cwd, now = Date.now(), chat = 'chat-fixture1') {
  const dir = path.join(home, 'chats', crypto.createHash('md5').update(cwd).digest('hex'), chat);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'store.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
  const put = (data) => { const b = Buffer.from(data); const id = sha(b); db.prepare('INSERT OR IGNORE INTO blobs VALUES (?,?)').run(id.toString('hex'), b); return id; };
  const ids = [
    put(JSON.stringify({ role: 'system', content: 'You are a coding agent.' })),
    put(JSON.stringify({ role: 'user', content: '<user_info>OS: test</user_info><rules>none</rules>' })),
    put(JSON.stringify({ role: 'user', content: [{ type: 'text', text: '<user_query>\nWhy is the build slow?\n</user_query>' }] })),
    put(JSON.stringify({ role: 'assistant', content: [{ type: 'redacted-reasoning', data: 'xx' }, { type: 'text', text: 'Checking the bundler config.' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'Grep', args: { pattern: 'webpack' } }] })),
    put(JSON.stringify({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', result: 'a.js' }] })),
    put(JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Source maps are the cause.' }] })),
  ];
  const root = put(Buffer.concat([...ids.flatMap((i) => [Buffer.from([0x0a, 32]), i]), Buffer.from([0x2a, 2, 0x08, 0x01])]));
  db.prepare('INSERT INTO meta VALUES (?,?)').run('0', Buffer.from(JSON.stringify({ agentId: chat, latestRootBlobId: root.toString('hex'), name: 'Fixture', createdAt: now })).toString('hex'));
  db.close();
  return file;
}
