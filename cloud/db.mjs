// SQLite (node:sqlite, no dependencies) on the Railway volume. One process, so one connection.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DIR = process.env.CLOUD_DATA || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(process.cwd(), 'data');
fs.mkdirSync(DIR, { recursive: true });
export const DB_FILE = path.join(DIR, 'synapse.db');
export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// numbered migrations, each runs once
const MIGRATIONS = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     email TEXT UNIQUE,
     email_verified INTEGER NOT NULL DEFAULT 0,
     handle TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     avatar TEXT,
     password_hash TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE identities (
     provider TEXT NOT NULL,
     provider_id TEXT NOT NULL,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     email TEXT,
     username TEXT,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (provider, provider_id)
   );
   CREATE INDEX identities_user ON identities(user_id);
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     label TEXT,
     ip TEXT,
     created_at INTEGER NOT NULL,
     last_used INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE email_tokens (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     purpose TEXT NOT NULL,
     email TEXT,
     expires_at INTEGER NOT NULL,
     used_at INTEGER
   );
   CREATE TABLE devices (
     device_hash TEXT PRIMARY KEY,
     user_code TEXT NOT NULL UNIQUE,
     label TEXT,
     user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
     status TEXT NOT NULL DEFAULT 'pending',
     token TEXT,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE oauth_states (
     state TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     verifier TEXT NOT NULL,
     next TEXT,
     link_user TEXT,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE trusted (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     trusted_user TEXT REFERENCES users(id) ON DELETE CASCADE,
     email TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE UNIQUE INDEX trusted_pair ON trusted(user_id, trusted_user) WHERE trusted_user IS NOT NULL;
   CREATE UNIQUE INDEX trusted_email ON trusted(user_id, email) WHERE trusted_user IS NULL;
   CREATE TABLE machines (
     id TEXT PRIMARY KEY,
     user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
     created_at INTEGER NOT NULL,
     last_seen INTEGER
   );
   CREATE TABLE requests (
     id TEXT PRIMARY KEY,
     from_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     to_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     from_machine TEXT NOT NULL,
     to_machine TEXT,
     agent TEXT NOT NULL,
     target TEXT,
     note TEXT,
     shared TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at INTEGER NOT NULL,
     decided_at INTEGER
   );
   CREATE INDEX requests_to ON requests(to_user, status);
   CREATE INDEX requests_from ON requests(from_user, status);
   CREATE TABLE mailbox (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     machine_id TEXT NOT NULL,
     t INTEGER NOT NULL,
     size INTEGER NOT NULL,
     item TEXT NOT NULL
   );
   CREATE INDEX mailbox_machine ON mailbox(machine_id, seq);`,
  // people who trust you that you chose to ignore, and who has already been told about whom
  `CREATE TABLE trust_dismissed (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     other_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     at INTEGER NOT NULL,
     PRIMARY KEY (user_id, other_user)
   );
   CREATE TABLE trust_notified (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     other_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     at INTEGER NOT NULL,
     PRIMARY KEY (user_id, other_user)
   );`,
  // the waitlist: accounts made before it stay active
  `ALTER TABLE users ADD COLUMN access TEXT NOT NULL DEFAULT 'active';
   ALTER TABLE users ADD COLUMN approved_at INTEGER;`,
];

db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
const version = Number(db.prepare("SELECT v FROM meta WHERE k = 'schema'").get()?.v || 0);
for (let i = version; i < MIGRATIONS.length; i++) {
  db.exec('BEGIN');
  try {
    db.exec(MIGRATIONS[i]);
    db.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(i + 1));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const cache = new Map();
const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
export const get = (sql, ...a) => stmt(sql).get(...a);
export const all = (sql, ...a) => stmt(sql).all(...a);
export const run = (sql, ...a) => stmt(sql).run(...a);
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
