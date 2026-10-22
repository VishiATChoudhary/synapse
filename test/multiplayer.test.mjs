// End-to-end multiplayer test: a relay and two "machines" (two SYNAPSE_HOME folders running the demo agents),
// paired with invite/join, sharing one agent across. Runs against a local relay unless SYNAPSE_RELAY is set.
//
//   npm test                       (or: SYNAPSE_RELAY=https://... npm test)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-mp-'));
const HOME_A = path.join(tmp, 'alice'), HOME_B = path.join(tmp, 'bob');
let relay = process.env.SYNAPSE_RELAY, relayProc = null;
const procs = [];

const envFor = (home, extra = {}) => ({ ...process.env, SYNAPSE_HOME: home, SYNAPSE_DEMO: '1', SYNAPSE_RELAY: relay, NO_OPEN: '1', ...extra });
function cli(home, args, extra) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { env: envFor(home, extra), timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${args.join(' ')}: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
}
const cliJSON = async (home, args, extra) => JSON.parse(await cli(home, args, extra));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(250); }
}
function startServer(home, port) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: envFor(home, { PORT: String(port), SYNAPSE_SYNC_MS: '500' }), stdio: 'ignore' });
  procs.push(p);
  return until(() => fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.ok, () => false));
}
const api = (port, p, body, method = body ? 'POST' : 'GET') =>
  fetch(`http://127.0.0.1:${port}${p}`, { method, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  if (!relay) {
    const port = 18000 + Math.floor(Math.random() * 1000);
    relayProc = spawn(process.execPath, [path.join(ROOT, 'relay', 'relay.mjs')], { env: { ...process.env, PORT: String(port), RELAY_SECRET: 'test' }, stdio: 'ignore' });
    relay = `http://127.0.0.1:${port}`;
    await until(() => fetch(`${relay}/health`).then((r) => r.ok, () => false));
  }
});
after(() => {
  for (const p of procs) p.kill();
  relayProc?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let A, B; // machine ids

test('invite and join pair the two machines', async () => {
  const inv = await cliJSON(HOME_A, ['invite', '--name', 'alice']);
  assert.match(inv.code, /^synapse-invite:/);
  const joined = await cliJSON(HOME_B, ['join', inv.code, '--name', 'bob']);
  assert.equal(joined.friend, 'alice');
  await cliJSON(HOME_A, ['sync']);
  const fa = await cliJSON(HOME_A, ['friends']), fb = await cliJSON(HOME_B, ['friends']);
  assert.deepEqual(fa.friends.map((f) => f.name), ['bob']);
  assert.deepEqual(fb.friends.map((f) => f.name), ['alice']);
  A = fa.machineId; B = fb.machineId;
  // bob's join announced bob's agents; alice sees them
  const agents = await cliJSON(HOME_A, ['agents']);
  assert.ok(agents.some((a) => a.id === `r-${B}-demo-ml-eval`), 'alice sees bob\'s agents');
});

test('own invite code cannot be used by yourself, and garbage is rejected', async () => {
  const inv = await cliJSON(HOME_A, ['invite']);
  await assert.rejects(cli(HOME_A, ['join', inv.code]), /own invite/);
  await assert.rejects(cli(HOME_B, ['join', 'synapse-invite:nope']), /damaged/);
});

test('sharing an agent sends its context to the friend, who reads it like a local one', async () => {
  await startServer(HOME_A, 18601);
  await startServer(HOME_B, 18602);
  // alice shares her api-auth agent with bob's ml-eval agent, on her canvas
  const made = await api(18601, '/api/edges', { from: 'demo-api-auth', to: `r-${B}-demo-ml-eval` });
  assert.equal(made.status, 201);

  // bob's canvas gets alice's agents and the mirrored link
  const edge = await until(async () => (await api(18602, '/api/state')).body.edges.find((e) => e.mirrored && e.to === 'demo-ml-eval'));
  assert.equal(edge.from, `r-${A}-demo-api-auth`);
  const st = (await api(18602, '/api/state')).body;
  const foreign = st.agents.find((a) => a.id === edge.from);
  assert.equal(foreign.remote.owner, 'alice');
  assert.match(foreign.projectKey, /^remote:/);
  await until(() => fs.existsSync(path.join(HOME_B, 'remote', A, 'demo-api-auth.jsonl')));

  // bob's agent reads it with the CLI (same path as synapse_read)
  const out = await cli(HOME_B, ['read', 'api-auth@alice'], { SYNAPSE_AGENT: 'demo-ml-eval' });
  assert.match(out, /refresh_tokens/);

  // and the prompt hook injects it, labelled as coming from alice's machine
  const hook = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'hook.mjs')], { env: envFor(HOME_B) });
    let o = ''; p.stdout.on('data', (d) => (o += d)); p.on('close', () => resolve(o));
    p.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'demo-ml-eval' }));
  });
  const ctx = JSON.parse(hook).hookSpecificOutput.additionalContext;
  assert.match(ctx, /owner="alice"/);
  assert.match(ctx, /refresh_tokens/);
});

test('only the owner can share: bob cannot link alice\'s agent to his, nor message it', async () => {
  const r = await api(18602, '/api/edges', { from: `r-${A}-demo-api-review`, to: 'demo-ml-eval' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Only alice can share it/);
  await assert.rejects(cli(HOME_B, ['send', 'api-auth@alice', 'hi'], { SYNAPSE_AGENT: 'demo-ml-eval' }), /do not message each other/);
});

test('removing the link on the friend\'s side stops the sharing at the owner', async () => {
  const st = (await api(18602, '/api/state')).body;
  const edge = st.edges.find((e) => e.mirrored && e.to === 'demo-ml-eval');
  await api(18602, `/api/edges/${edge.id}`, null, 'DELETE');
  await until(() => !readJSON(path.join(HOME_A, 'edges.json'), []).some((e) => e.from === 'demo-api-auth' && e.to.startsWith(`r-${B}-`)));
  await until(async () => !(await api(18602, '/api/state')).body.edges.some((e) => e.mirrored));
});

test('unfriend removes their agents and ignores them afterwards', async () => {
  await api(18601, '/api/edges', { from: 'demo-web-e2e', to: `r-${B}-demo-docs` });
  await until(async () => (await api(18602, '/api/state')).body.edges.some((e) => e.mirrored));
  const out = await api(18602, '/api/remote/unfriend', { machineId: A });
  assert.equal(out.body.removed, 'alice');
  await sleep(1500);
  const st = (await api(18602, '/api/state')).body;
  assert.ok(!st.agents.some((a) => a.remote), 'no foreign agents left');
  assert.ok(!st.edges.some((e) => e.mirrored), 'no mirrored links left');
});
