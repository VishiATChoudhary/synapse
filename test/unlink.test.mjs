// Removing a link to a friend's shared agent sticks: their machine stops sharing it, and the link never comes back
// on ours, not from a state they sent before they heard, nor when their agent restarts.
//
//   node --test test/unlink.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER = path.join(ROOT, 'cloud', 'server.mjs');
const skip = !fs.existsSync(SERVER) ? 'cloud/server.mjs is not there' : false;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-unlink-'));
const HOME_A = path.join(tmp, 'alice'), HOME_B = path.join(tmp, 'bob');
const RUN = Math.random().toString(36).slice(2, 8);
const ALICE = `alice-${RUN}@example.test`, BOB = `bob-${RUN}@example.test`, PASS = 'correct horse battery';
let cloud = null, portA = 0, portB = 0;
const procs = [], canvases = {};
const envFor = (home, extra = {}) => ({ ...process.env, SYNAPSE_HOME: home, SYNAPSE_DEMO: '1', SYNAPSE_CLOUD: cloud, SYNAPSE_RELAY: '', NO_OPEN: '1', ...extra });
const cli = (home, args, extra) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { env: envFor(home, extra), timeout: 60000 }, (e, out, err) => (e ? reject(new Error(`${args.join(' ')}: ${err || e.message}`)) : resolve(out))));
const cliJSON = async (...a) => JSON.parse(await cli(...a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(150); } }
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const edgesOf = (home) => readJSON(path.join(home, 'edges.json'), []);
const randPort = () => 20000 + Math.floor(Math.random() * 20000);
function startCanvas(home, port) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: envFor(home, { PORT: String(port), SYNAPSE_SYNC_MS: '300' }), stdio: 'ignore' });
  procs.push(p);
  canvases[home] = p;
  return until(() => fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.ok, () => false));
}
// bob's view of alice's ml-eval shared into his web-e2e
const bobSees = () => edgesOf(HOME_B).filter((e) => e.mirrored && e.from.endsWith('-demo-ml-eval') && e.to === 'demo-web-e2e');
const aliceShares = () => edgesOf(HOME_A).filter((e) => !e.mirrored && e.from === 'demo-ml-eval' && e.to.endsWith('-demo-web-e2e'));

before(async () => {
  if (skip) return;
  const port = 19000 + Math.floor(Math.random() * 1000);
  procs.push(spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), CLOUD_DATA: path.join(tmp, 'cloud'), CLOUD_SECRET: 'test', CLOUD_DEV_MAIL: '1', PUBLIC_URL: `http://127.0.0.1:${port}` }, stdio: 'ignore' }));
  cloud = `http://127.0.0.1:${port}`;
  await until(() => fetch(`${cloud}/v1/auth/providers`).then((r) => r.ok, () => false));
  await cliJSON(HOME_A, ['signup', '--email', ALICE, '--password', PASS, '--name', 'alice']);
  await cliJSON(HOME_B, ['signup', '--email', BOB, '--password', PASS, '--name', 'bob']);
  await cliJSON(HOME_A, ['trust', BOB]);
  await cliJSON(HOME_B, ['trust', ALICE]);
  portA = randPort(); portB = randPort();
  await startCanvas(HOME_A, portA);
  await startCanvas(HOME_B, portB);
});
after(() => { for (const p of procs) p.kill(); if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true }); });

test('bob removes the link to alice’s shared agent: it is gone on both machines and stays gone', { skip }, async () => {
  // bob asks, alice shares ml-eval into bob's web-e2e, read and ask
  const sent = await cliJSON(HOME_B, ['request', ALICE], { SYNAPSE_AGENT: 'demo-web-e2e' });
  await cliJSON(HOME_A, ['accept', sent.id, '--agents', 'ml-eval']);
  await until(() => bobSees().length === 1);
  const [edge] = bobSees();
  const r = await fetch(`http://127.0.0.1:${portB}/api/edges/${encodeURIComponent(edge.id)}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  // from the moment bob removes it, not even a state alice sent before she heard may bring it back
  let flicker = 0;
  await until(() => { if (bobSees().length) flicker++; return aliceShares().length === 0; });
  assert.equal(flicker, 0, 'the link reappeared on bob’s side before alice dropped it');
  // a few heartbeats later (alice's machine resends its state every 20 s at the latest; syncs run every 300 ms)
  const end = Date.now() + 25_000;
  while (Date.now() < end) { assert.equal(bobSees().length, 0, 'the link came back on bob’s side'); await sleep(250); }
  assert.equal(aliceShares().length, 0);
});

test('a state alice sent before she heard of the removal does not bring the link back', { skip }, async () => {
  const sent = await cliJSON(HOME_B, ['request', ALICE], { SYNAPSE_AGENT: 'demo-web-e2e' });
  await cliJSON(HOME_A, ['accept', sent.id, '--agents', 'ml-eval']);
  await until(() => bobSees().length === 1);
  canvases[HOME_B].kill('SIGSTOP');
  try {
    // alice's machine sends a fresh state (a rename changes it), still listing the share, into bob's mailbox
    await cli(HOME_A, ['rename', 'ml-eval', 'ml-eval-renamed']);
    await sleep(2500);
    canvases[HOME_A].kill('SIGSTOP'); // and does not hear of the removal for a while
    const [edge] = bobSees();
    await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', `import { removeEdge } from ${JSON.stringify(path.join(ROOT, 'ops.mjs'))}; removeEdge(${JSON.stringify(edge.id)});`], { env: envFor(HOME_B) }, (e) => (e ? reject(e) : resolve())));
    assert.equal(bobSees().length, 0);
  } finally { canvases[HOME_B].kill('SIGCONT'); }
  try {
    const end = Date.now() + 4000; // bob pulls alice's old state first
    while (Date.now() < end) { assert.equal(bobSees().length, 0, 'an old state brought the link back'); await sleep(150); }
  } finally { canvases[HOME_A].kill('SIGCONT'); }
  await until(() => aliceShares().length === 0);
  await sleep(3000);
  assert.equal(bobSees().length, 0);
  // once alice no longer lists it, bob forgets the removal: sharing it again later works
  await until(() => Object.keys(readJSON(path.join(HOME_B, 'remote', 'dropped.json'), {})).length === 0);
});
