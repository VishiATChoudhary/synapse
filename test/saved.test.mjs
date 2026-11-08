// ⌘S archives: the transcript is packed losslessly in place of the original and rebuilt byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-saved-'));
process.env.SYNAPSE_HOME = home;
const saved = await import('../saved.mjs');

const png = crypto.randomBytes(30_000); // stands in for a screenshot: does not compress
function transcript(file) {
  const line = (o) => JSON.stringify(o);
  const rows = [];
  for (let i = 0; i < 150; i++) {
    rows.push(line({ type: 'user', message: { content: `question ${i} about the parser` }, timestamp: '2026-11-03T10:00:00Z' }));
    rows.push(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/parse.ts' } }, { type: 'text', text: `answer ${i}: ${'détail ✓ '.repeat(40)}` }] } }));
    rows.push(line({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', data: png.toString('base64') } }] }] } }));
  }
  rows.push('{"type":"odd", "spacing" : 1}'); // a line JSON would write differently
  fs.writeFileSync(file, rows.join('\n') + '\nÿ'); // and a trailing byte that is not valid UTF-8 on its own
  return fs.readFileSync(file);
}

test('pack and unpack rebuild a transcript byte for byte, images stored once', async () => {
  const raw = transcript(path.join(home, 'a.jsonl'));
  const a = await saved.pack(raw);
  assert.ok((await saved.unpack(a)).equals(raw));
  assert.ok(a.length < 45_000, `150 copies of one 30 KB image and the text: ${a.length} bytes`);
  const bad = Buffer.from(a); bad[bad.length - 1] ^= 1;
  await assert.rejects(saved.unpack(bad));
});

test('a transcript with a NUL byte is still exact (images left in the text)', async () => {
  const raw = Buffer.concat([Buffer.from(`{"x":"${png.toString('base64')}"}\n`), Buffer.from([0, 1, 2]), Buffer.from('\n')]);
  assert.ok((await saved.unpack(await saved.pack(raw))).equals(raw));
});

test('archive replaces the original; read, render and restore bring it back exactly', async () => {
  const file = path.join(home, 'proj', 'sess-1.jsonl');
  fs.mkdirSync(path.dirname(file));
  const raw = transcript(file);
  const agent = { id: 'sess-1', name: 'Parser work', kind: 'claude', format: 'claude', cwd: '/p', transcript: file };
  const p = saved.prepare(agent);
  assert.equal(p.messages, 300);
  assert.match(p.digest, /synapse saved .*-parser-work-/);
  assert.match(p.digest, /Files edited: src\/parse\.ts/);
  const e = await saved.archive(agent, p.id);
  assert.equal(e.removed, true);
  assert.equal(fs.existsSync(file), false, 'not kept twice');
  assert.ok(e.size < raw.length / 20);
  assert.ok((await saved.read('parser')).raw.equals(raw));
  assert.match(await saved.render(p.id), /U: question 149 about the parser[\s\S]*\[Edit: src\/parse\.ts\]/);
  const r = await saved.restore(p.id);
  assert.equal(r.resume, 'claude --resume sess-1');
  assert.ok(fs.readFileSync(file).equals(raw));
  assert.equal((await saved.restore(p.id)).already, true);
  fs.appendFileSync(file, 'x');
  await assert.rejects(saved.restore(p.id), /differs/);
});

test('a transcript still being written is archived but kept', async () => {
  const file = path.join(home, 'live.jsonl');
  transcript(file);
  const agent = { id: 'live', name: 'live', kind: 'claude', format: 'claude', cwd: '/p', transcript: file };
  const p = saved.prepare(agent);
  const t = setInterval(() => fs.appendFileSync(file, '{"type":"user","message":{"content":"more"}}\n'), 5);
  try { assert.equal((await saved.archive(agent, p.id)).removed, false); } finally { clearInterval(t); }
  assert.ok(fs.existsSync(file));
});
