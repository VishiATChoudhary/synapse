// End-to-end Synapse Cloud test: the cloud service and two "machines" (two SYNAPSE_HOME folders running the
// demo agents), each signed in to its own account. Alice trusts Bob, her agent sends a synapse request,
// Bob accepts and his agent's context reaches hers; the deny path too. Skipped while cloud/server.mjs is missing.
//
//   npm test                       (or: SYNAPSE_CLOUD=https://... npm test, against a deployed cloud)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER = path.join(ROOT, 'cloud', 'server.mjs');
const skip = !process.env.SYNAPSE_CLOUD && !fs.existsSync(SERVER) ? 'cloud/server.mjs is not there yet' : false;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-cloud-'));
const HOME_A = path.join(tmp, 'alice'), HOME_B = path.join(tmp, 'bob');
const RUN = Math.random().toString(36).slice(2, 8); // unique emails, so a deployed cloud can be reused
const ALICE = `alice-${RUN}@example.test`, BOB = `bob-${RUN}@example.test`, PASS = 'correct horse battery';
let cloud = process.env.SYNAPSE_CLOUD, cloudProc = null;
const procs = [];

const envFor = (home, extra = {}) => ({ ...process.env, SYNAPSE_HOME: home, SYNAPSE_DEMO: '1', SYNAPSE_CLOUD: cloud, SYNAPSE_RELAY: '', NO_OPEN: '1', ...extra });
function cli(home, args, extra) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { env: envFor(home, extra), timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${args.join(' ')}: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
}
const cliJSON = async (home, args, extra) => JSON.parse(await cli(home, args, extra));
// run a snippet with account.mjs loaded for one machine
const inHome = (home, code) => new Promise((resolve, reject) => {
  execFile(process.execPath, ['--input-type=module', '-e', `import * as account from ${JSON.stringify(path.join(ROOT, 'account.mjs'))};\nconsole.log(JSON.stringify(await (async () => { ${code} })()));`],
    { env: envFor(home), timeout: 30000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(JSON.parse(stdout))));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(300); }
}
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function startCanvas(home, port) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: envFor(home, { PORT: String(port), SYNAPSE_SYNC_MS: '500' }), stdio: 'ignore' });
  procs.push(p);
  return until(() => fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.ok, () => false));
}

before(async () => {
  if (skip || cloud) return;
  const port = 19000 + Math.floor(Math.random() * 1000);
  cloudProc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), CLOUD_DATA: path.join(tmp, 'cloud'), CLOUD_SECRET: 'test', CLOUD_DEV_MAIL: '1', PUBLIC_URL: `http://127.0.0.1:${port}` },
    stdio: 'ignore',
  });
  cloud = `http://127.0.0.1:${port}`;
  await until(() => fetch(`${cloud}/v1/auth/providers`).then((r) => r.ok, () => false));
});
after(() => {
  for (const p of procs) p.kill();
  cloudProc?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let requestId;

test('both sign up; the token stays private to the machine', { skip }, async () => {
  const a = await cliJSON(HOME_A, ['signup', '--email', ALICE, '--password', PASS, '--name', 'alice']);
  const b = await cliJSON(HOME_B, ['signup', '--email', BOB, '--password', PASS, '--name', 'bob']);
  assert.equal(a.user.email, ALICE);
  assert.equal(b.user.email, BOB);
  assert.equal(fs.statSync(path.join(HOME_A, 'account.json')).mode & 0o777, 0o600);
  const who = await cliJSON(HOME_A, ['whoami']);
  assert.equal(who.email, ALICE);
  // and signing in again works
  await cli(HOME_A, ['logout']);
  assert.ok(!fs.existsSync(path.join(HOME_A, 'account.json')));
  await cliJSON(HOME_A, ['login', '--email', ALICE, '--password', PASS]);
  await assert.rejects(cli(HOME_B, ['login', '--email', BOB, '--password', 'wrong password']), /synapse:/);
  await cliJSON(HOME_B, ['login', '--email', BOB, '--password', PASS]);
});

test('a request needs the person in your trusted list', { skip }, async () => {
  await assert.rejects(cli(HOME_A, ['request', BOB, '--target', 'ml eval'], { SYNAPSE_AGENT: 'demo-web-e2e' }), /synapse:/);
  const person = await cliJSON(HOME_A, ['trust', BOB]);
  assert.equal(person.name, 'bob');
  const people = await cliJSON(HOME_A, ['people']);
  assert.equal(people.length, 1);
  // and bob has to trust alice back before she can ask him
  await assert.rejects(cli(HOME_A, ['request', BOB, '--target', 'ml eval'], { SYNAPSE_AGENT: 'demo-web-e2e' }), /has not added you to their trusted people/);
  await cliJSON(HOME_B, ['trust', ALICE]);
});

test('alice\'s agent asks, bob accepts, and his agent\'s context reaches hers', { skip }, async () => {
  await startCanvas(HOME_A, 18801);
  await startCanvas(HOME_B, 18802);
  const sent = await cliJSON(HOME_A, ['request', BOB, '--target', 'the ml eval agent', '--note', 'need the ranking numbers'], { SYNAPSE_AGENT: 'demo-web-e2e' });
  assert.equal(sent.status, 'pending');
  requestId = sent.id;

  const { incoming } = await cliJSON(HOME_B, ['requests']);
  const req = incoming.find((r) => r.id === requestId);
  assert.ok(req, 'bob sees the request');
  assert.equal(req.agent, 'web-e2e');
  assert.equal(readJSON(path.join(HOME_B, 'requests.json'), {}).incoming.length, 1, 'cached for the app');

  // no --agents: the "ml eval" hint picks his ml-eval agent
  const accepted = await cliJSON(HOME_B, ['accept', requestId]);
  assert.equal(accepted.status, 'accepted');
  const bobMachine = readJSON(path.join(HOME_B, 'remote.json'), {}).machineId;
  assert.ok(readJSON(path.join(HOME_B, 'edges.json'), []).some((e) => e.from === 'demo-ml-eval' && e.to.endsWith('-demo-web-e2e')));

  // alice's machine gets the pairing, bob's agents and the mirrored link
  const from = `r-${bobMachine}-demo-ml-eval`;
  await until(() => readJSON(path.join(HOME_A, 'edges.json'), []).some((e) => e.mirrored && e.from === from && e.to === 'demo-web-e2e'));
  await until(() => fs.existsSync(path.join(HOME_A, 'remote', bobMachine, 'demo-ml-eval.jsonl')));
  const out = await cli(HOME_A, ['read', 'ml-eval@bob'], { SYNAPSE_AGENT: 'demo-web-e2e' });
  assert.match(out, /nDCG@10/);

  const { outgoing } = await cliJSON(HOME_A, ['requests']);
  assert.equal(outgoing.find((r) => r.id === requestId).status, 'accepted');

  // both apps list the link for the green circle
  const inA = await inHome(HOME_A, 'return account.externalLinks();');
  assert.deepEqual(inA.map((l) => [l.direction, l.owner, l.agent.name, l.local.name]), [['in', 'bob', 'ml-eval', 'web-e2e']]);
  const outB = await inHome(HOME_B, 'return account.externalLinks();');
  assert.equal(outB[0].direction, 'out');
  assert.equal(outB[0].local.name, 'ml-eval');

  // each side sees only the agents in the share, not everything the other machine runs
  const aliceMachine = readJSON(path.join(HOME_A, 'remote.json'), {}).machineId;
  assert.ok((await cliJSON(HOME_B, ['agents'])).length > 2, 'bob runs several agents');
  await until(() => readJSON(path.join(HOME_B, 'remote', 'state.json'), {})[aliceMachine]?.agents?.length);
  assert.deepEqual(readJSON(path.join(HOME_A, 'remote', 'state.json'), {})[bobMachine].agents.map((a) => a.id), ['demo-ml-eval']);
  assert.deepEqual(readJSON(path.join(HOME_B, 'remote', 'state.json'), {})[aliceMachine].agents.map((a) => a.id), ['demo-web-e2e']);
});

test('a denied request reaches the asker and shares nothing', { skip }, async () => {
  await cliJSON(HOME_B, ['trust', ALICE]);
  const sent = await cliJSON(HOME_B, ['request', 'alice', '--target', 'docs'], { SYNAPSE_AGENT: 'demo-docs' });
  const denied = await cliJSON(HOME_A, ['deny', sent.id]);
  assert.equal(denied.status, 'denied');
  const { outgoing } = await cliJSON(HOME_B, ['requests']);
  assert.equal(outgoing.find((r) => r.id === sent.id).status, 'denied');
  await assert.rejects(cli(HOME_A, ['accept', sent.id]), /already denied/);
  assert.ok(!readJSON(path.join(HOME_A, 'edges.json'), []).some((e) => !e.mirrored && e.to.endsWith('-demo-docs')));
});

test('removing someone from your trusted people ends what you shared with them', { skip }, async () => {
  const bobMachine = readJSON(path.join(HOME_B, 'remote.json'), {}).machineId;
  const aliceMachine = readJSON(path.join(HOME_A, 'remote.json'), {}).machineId;
  await cliJSON(HOME_B, ['untrust', ALICE]);
  // both sides drop it on their next sync (untrust syncs right away unless the canvas is already syncing)
  await until(() => !readJSON(path.join(HOME_B, 'remote.json'), {}).peers[aliceMachine]);
  assert.ok(!readJSON(path.join(HOME_B, 'edges.json'), []).some((e) => e.to.startsWith(`r-${aliceMachine}-`)));
  await until(() => !readJSON(path.join(HOME_A, 'remote.json'), {}).peers[bobMachine]);
  assert.ok(!readJSON(path.join(HOME_A, 'edges.json'), []).some((e) => e.from.startsWith(`r-${bobMachine}-`)));
  assert.ok(!fs.existsSync(path.join(HOME_A, 'remote', bobMachine)));
  await assert.rejects(cli(HOME_A, ['read', 'ml-eval@bob'], { SYNAPSE_AGENT: 'demo-web-e2e' }));
  const { outgoing } = await cliJSON(HOME_A, ['requests']);
  assert.equal(outgoing.find((r) => r.id === requestId).status, 'revoked');
});

test('signed out, the agent tools say how to sign in', { skip }, async () => {
  await cli(HOME_A, ['logout']);
  await assert.rejects(cli(HOME_A, ['people']), /Not signed in to Synapse/);
});
