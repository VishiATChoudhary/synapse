#!/usr/bin/env node
// Stands in for `claude -p` in tests: answers with its own argv, stdin and the talk env, as JSON.
import crypto from 'node:crypto';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  setTimeout(() => {
    const result = JSON.stringify({ argv: process.argv.slice(2), stdin, external: process.env.SYNAPSE_EXTERNAL || null });
    // the session claude would report: a named one, else the resumed one, else a fresh fork
    const argv = process.argv.slice(2);
    const flag = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
    const session = process.env.FAKE_CLAUDE_SESSION || flag('--session-id') || (!argv.includes('--fork-session') && flag('--resume')) || crypto.randomUUID();
    process.stdout.write(JSON.stringify({ type: 'result', session_id: session, result }));
    process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
  }, Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0));
});
