// A whole workspace shared with a friend: a relay and two "machines" (two SYNAPSE_HOME folders with the demo agents).
// Alice shares her acme-api workspace (three agents in three worktrees) with Bob. Any of Bob's agents can read any
// of them, nothing is pushed into prompts, the one that accepted hears about it once, and stopping takes it all back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-ws-'));
const HOME_A = path.join(tmp, 'alice'), HOME_B = path.join(tmp, 'bob');
let relay, relayProc;

const envFor = (home, extra = {}) => ({ ...process.env, SYNAPSE_HOME: home, SYNAPSE_DEMO: '1', SYNAPSE_RELAY: relay, NO_OPEN: '1', ...extra });
const run = (home, file, args, extra, input) => new Promise((resolve, reject) => {
  const p = execFile(process.execPath, [file, ...args], { env: envFor(home, extra), timeout: 20000 }, (err, stdout, stderr) => (err ? reject(new Error(`${args.join(' ')}: ${stderr || err.message}`)) : resolve(stdout)));
  if (input != null) p.stdin.end(input);
});
const cli = (home, args, extra) => run(home, path.join(ROOT, 'cli.mjs'), args, extra);
const cliJSON = async (home, args, extra) => JSON.parse(await cli(home, args, extra));
const node = (home, code) => run(home, '--input-type=module', ['-e', code]);
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(250); }
}
const syncBoth = async () => { await cliJSON(HOME_A, ['sync']); await cliJSON(HOME_B, ['sync']); await cliJSON(HOME_A, ['sync']); await cliJSON(HOME_B, ['sync']); };
const hook = (home, session) => run(home, path.join(ROOT, 'hook.mjs'), [], {}, JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session }))
  .then((o) => (o.trim() ? JSON.parse(o).hookSpecificOutput?.additionalContext || '' : ''));

before(async () => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  relayProc = spawn(process.execPath, [path.join(ROOT, 'relay', 'relay.mjs')], { env: { ...process.env, PORT: String(port), RELAY_SECRET: 'test' }, stdio: 'ignore' });
  relay = `http://127.0.0.1:${port}`;
  await until(() => fetch(`${relay}/health`).then((r) => r.ok, () => false));
});
after(() => { relayProc?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

let A, B;
test('a whole workspace is readable by every agent of the friend, on demand', async () => {
  const inv = await cliJSON(HOME_A, ['invite', '--name', 'alice']);
  await cliJSON(HOME_B, ['join', inv.code, '--name', 'bob']);
  await syncBoth();
  A = (await cliJSON(HOME_A, ['friends'])).machineId; B = (await cliJSON(HOME_B, ['friends'])).machineId;

  // Bob accepted Alice's workspace offer into his ml-eval agent: the cloud's item, as remote.mjs gets it
  fs.writeFileSync(path.join(HOME_A, 'offers.json'), JSON.stringify({ r_ws: { id: 'ws-1', name: 'acme-api (whole workspace)', kind: 'workspace', workspace: 'project:acme-api', label: 'acme-api', at: Date.now() } }));
  await node(HOME_A, `const r = await import(${JSON.stringify(path.join(ROOT, 'remote.mjs'))});
    await r.linkOffer({ type: 'request', id: 'r_ws', kind: 'offer', status: 'accepted', mode: 'sync', from: ${JSON.stringify(B)}, agent: { id: 'ws-1', name: 'acme-api (whole workspace)', kind: 'workspace' }, receiver: { id: 'demo-ml-eval', name: 'ml-eval', kind: 'claude' } });`);
  assert.equal(readJSON(path.join(HOME_A, 'edges.json'), []).length, 0, "no links of its own on alice's side");
  const shared = await cliJSON(HOME_A, ['workspaces']);
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0].agents.sort(), ['api-auth', 'api-rate-limit', 'api-review'].sort(), 'every agent in the workspace, worktrees too');

  await until(async () => { await syncBoth(); return readJSON(path.join(HOME_B, 'edges.json'), []).filter((e) => e.workspace).length === 3; });
  const edges = readJSON(path.join(HOME_B, 'edges.json'), []).filter((e) => e.workspace);
  assert.ok(edges.every((e) => e.onDemand && e.mirrored && e.workspace === 'acme-api'), 'read on demand');
  assert.ok(!edges.some((e) => e.from.endsWith('demo-web-checkout')), 'nothing from other workspaces');
  await until(() => fs.existsSync(path.join(HOME_B, 'remote', A, 'demo-api-auth.jsonl')));

  // an agent of bob's that did not accept it reads it too
  const out = await cli(HOME_B, ['read', 'api-auth@alice'], { SYNAPSE_AGENT: 'demo-docs' });
  assert.match(out, /refresh_tokens/);
  // but not an agent outside the workspace
  await assert.rejects(cli(HOME_B, ['read', 'web-checkout@alice'], { SYNAPSE_AGENT: 'demo-docs' }), /does not share context/);
  const peers = await cliJSON(HOME_B, ['peers'], { SYNAPSE_AGENT: 'demo-docs' });
  assert.equal(peers.friendsWorkspaces[0].owner, 'alice');
  assert.equal(peers.friendsWorkspaces[0].agents.length, 3);

  // the agent that accepted hears about it once, with nothing of the content pushed in
  const first = await hook(HOME_B, 'demo-ml-eval');
  assert.match(first, /alice shares their whole "acme-api" workspace/);
  assert.match(first, /api-auth@alice/);
  assert.doesNotMatch(first, /refresh_tokens/);
  const second = await hook(HOME_B, 'demo-ml-eval');
  assert.doesNotMatch(second, /whole "acme-api" workspace/);
});

test('stopping the workspace share takes it all back', async () => {
  const out = await cliJSON(HOME_A, ['unshare-workspace', 'bob', 'acme-api']);
  assert.equal(out.stopped, 'acme-api');
  await until(async () => { await syncBoth(); return !readJSON(path.join(HOME_B, 'edges.json'), []).some((e) => e.workspace); });
  await assert.rejects(cli(HOME_B, ['read', 'api-auth@alice'], { SYNAPSE_AGENT: 'demo-docs' }), /does not share context/);
});
