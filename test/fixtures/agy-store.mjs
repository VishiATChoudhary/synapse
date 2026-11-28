// Builds an Antigravity conversation store (SQLite of protobuf steps) like the agy CLI writes, for tests.
import { DatabaseSync } from 'node:sqlite';
const varint = (n) => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
const field = (f, v) => (typeof v === 'number' ? Buffer.concat([varint(f * 8), varint(v)]) : Buffer.concat([varint(f * 8 + 2), varint(Buffer.byteLength(v)), Buffer.from(v)]));
const msg = (...parts) => Buffer.concat(parts);
export const userStep = (text) => ({ type: 14, payload: msg(field(19, msg(field(2, text)))) });
export const modelStep = (text, tools = [], status = 3) => ({ type: 15, status, payload: msg(field(20, msg(...(text ? [field(1, text)] : []), ...tools.map(([name, args]) => field(7, msg(field(1, 'call_1'), field(2, name), field(3, JSON.stringify(args)))))))) });
export const resultStep = () => ({ type: 132, payload: msg(field(5, 'x')) });
export function writeStore(file, steps, start = Math.floor(Date.now() / 1000)) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))');
  const at = db.prepare('SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM steps').get().n;
  const put = db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)');
  steps.forEach((s, k) => put.run(at + k, s.type, s.status ?? 3, msg(field(1, msg(field(1, start + at + k)))), s.payload));
  db.close();
}
