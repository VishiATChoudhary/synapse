// Multiplayer with a live transcript: what alice's agent writes after the link is drawn reaches bob's agent,
// bob's canvas gets a "new context" event, and bob's next prompt only carries the new part.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-mp-live-'));
const HOME_A = path.join(tmp, 'alice'), HOME_B = path.join(tmp, 'bob');
const CLAUDE_A = path.join(tmp, 'alice-claude'), PROJ = path.join(tmp, 'alice-proj');
const SESSION = 'sess-alice-1';
const TRANSCRIPT = path.join(CLAUDE_A, 'projects', PROJ.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`);
let relay = process.env.SYNAPSE_RELAY, relayProc = null;
const procs = [];

// alice runs a (fake) Claude session; bob runs the demo agents
const envA = (x = {}) => ({ ...process.env, SYNAPSE_HOME: HOME_A, SYNAPSE_CLAUDE_HOME: CLAUDE_A, SYNAPSE_RELAY: relay, NO_OPEN: '1', ...x });
const envB = (x = {}) => ({ ...process.env, SYNAPSE_HOME: HOME_B, SYNAPSE_DEMO: '1', SYNAPSE_RELAY: relay, NO_OPEN: '1', ...x });
const cli = (env, args) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { env, timeout: 20000 },
  (err, out, se) => (err ? reject(new Error(se || err.message)) : resolve(JSON.parse(out)))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(250); }
}
function server(env, port) {
  procs.push(spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: env({ PORT: String(port), SYNAPSE_SYNC_MS: '500' }), stdio: 'ignore' }));
  return until(() => fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.ok, () => false));
}
function hook(env, session) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'hook.mjs')], { env });
    let o = ''; p.stdout.on('data', (d) => (o += d)); p.on('close', () => resolve(o ? JSON.parse(o).hookSpecificOutput?.additionalContext || '' : ''));
    p.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session }));
  });
}
const say = (role, text) => fs.appendFileSync(TRANSCRIPT, JSON.stringify(role === 'user'
  ? { type: 'user', message: { content: text }, timestamp: new Date().toISOString() }
  : { type: 'assistant', message: { content: [{ type: 'text', text }] }, timestamp: new Date().toISOString() }) + '\n');

before(async () => {
  if (!relay) {
    const port = 19000 + Math.floor(Math.random() * 1000);
    relayProc = spawn(process.execPath, [path.join(ROOT, 'relay', 'relay.mjs')], { env: { ...process.env, PORT: String(port), RELAY_SECRET: 'test' }, stdio: 'ignore' });
    relay = `http://127.0.0.1:${port}`;
    await until(() => fetch(`${relay}/health`).then((r) => r.ok, () => false));
  }
  fs.mkdirSync(path.join(CLAUDE_A, 'sessions'), { recursive: true });
  fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
  fs.mkdirSync(PROJ, { recursive: true });
  fs.writeFileSync(path.join(CLAUDE_A, 'sessions', 'a.json'), JSON.stringify({ sessionId: SESSION, pid: process.pid, cwd: PROJ, name: 'alice-auth', status: 'busy', startedAt: Date.now() }));
  say('user', 'Plan the auth migration.');
  say('assistant', 'Step one: add the sessions table.');
});
after(() => { for (const p of procs) p.kill(); relayProc?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('new activity of a shared agent reaches the friend, and their next prompt gets only the new part', async () => {
  const inv = await cli(envA(), ['invite', '--name', 'alice']);
  await cli(envB(), ['join', inv.code, '--name', 'bob']);
  const B = (await cli(envB(), ['friends'])).machineId, A = (await cli(envA(), ['friends'])).machineId;
  await server(envA, 18701);
  await server(envB, 18702);
  await until(async () => (await (await fetch('http://127.0.0.1:18701/api/state')).json()).agents.some((a) => a.id === `r-${B}-demo-ml-eval`));
  const r = await fetch('http://127.0.0.1:18701/api/edges', { method: 'POST', body: JSON.stringify({ from: SESSION, to: `r-${B}-demo-ml-eval` }) });
  assert.equal(r.status, 201);

  const log = path.join(HOME_B, 'remote', A, `${SESSION}.jsonl`);
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('sessions table'));
  const first = await hook(envB(), 'demo-ml-eval');
  assert.match(first, /Recent context from agent "alice-auth", which runs on alice's machine/);
  assert.match(first, /sessions table/);

  // alice's agent keeps working
  say('assistant', 'Step two: rotate refresh tokens on every use.');
  await until(() => fs.readFileSync(log, 'utf8').includes('rotate refresh tokens'));
  const events = fs.readFileSync(path.join(HOME_B, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.type === 'remote-context' && e.owner === 'alice'), 'bob\'s canvas is told new context arrived');

  const second = await hook(envB(), 'demo-ml-eval');
  assert.match(second, /New activity since your last prompt/);
  assert.match(second, /rotate refresh tokens/);
  assert.doesNotMatch(second, /sessions table/);
});
