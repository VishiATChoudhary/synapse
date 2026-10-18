#!/usr/bin/env node
// Stands in for `claude -p` in tests: answers with its own argv, stdin and the talk env, as JSON.
import crypto from 'node:crypto';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  setTimeout(() => {
    const result = JSON.stringify({ argv: process.argv.slice(2), stdin, external: process.env.SYNAPSE_EXTERNAL || null });
    process.stdout.write(JSON.stringify({ type: 'result', session_id: crypto.randomUUID(), result }));
    process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
  }, Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0));
});
