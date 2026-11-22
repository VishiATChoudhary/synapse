#!/usr/bin/env node
// A stand-in for `claude -p` in the rooms tests: answers with what a reply file says (or, with none, its argv and
// stdin as JSON), from the model a model file names, after the delay a sleep file asks for.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_ROOM_DIR;
const read = (n, d) => { try { return fs.readFileSync(path.join(dir, n), 'utf8'); } catch { return d; } };
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const flag = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv, stdin, external: process.env.SYNAPSE_EXTERNAL || null, base: process.env.ANTHROPIC_BASE_URL || null }) + '\n');
  setTimeout(() => {
    const reply = read('reply', null);
    const result = reply != null ? reply : JSON.stringify({ argv, stdin });
    process.stdout.write(JSON.stringify({ type: 'result', session_id: flag('--session-id'), result, modelUsage: { [read('model', 'claude-sonnet-5-5').trim()]: {} } }));
  }, Number(read('sleep', '0')));
});
