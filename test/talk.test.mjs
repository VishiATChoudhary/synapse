// Agent talk end to end over a local cloud: two "machines" (two SYNAPSE_HOME folders with the demo agents), each
// signed in, trusting each other. The answering `claude` is a fake that echoes its argv and stdin.
//
//   node --test test/talk.test.mjs      (scenario numbers are those of the design spec)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER = path.join(ROOT, 'cloud', 'server.mjs');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.mjs');
const skip = !fs.existsSync(SERVER) ? 'cloud/server.mjs is not there yet' : false;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-talk-e2e-'));
const HOME_A = path.join(tmp, 'alice'), HOME_B = path.join(tmp, 'bob');
const RUN = Math.random().toString(36).slice(2, 8);
const ALICE = `alice-${RUN}@example.test`, BOB = `bob-${RUN}@example.test`, PASS = 'correct horse battery';
const WEB = 'demo-web-e2e', ML = 'demo-ml-eval';
let cloud = null, cloudProc = null, portB = 0, portA = 0;
const procs = [];

// the fake's delay is read per answer from a file, so each scenario can pick its own
const SLEEP = path.join(tmp, 'sleep-ms');
const WRAPPER = path.join(tmp, 'claude-wrapper.mjs');
const setSleep = (ms) => fs.writeFileSync(SLEEP, String(ms));
fs.writeFileSync(WRAPPER, `#!/usr/bin/env node\nimport fs from 'node:fs';\ntry { process.env.FAKE_CLAUDE_SLEEP_MS = fs.readFileSync(${JSON.stringify(SLEEP)}, 'utf8').trim(); } catch {}\nawait import(${JSON.stringify(FAKE)});\n`, { mode: 0o755 });
setSleep(0);

const envFor = (home, extra = {}) => ({ ...process.env, SYNAPSE_HOME: home, SYNAPSE_DEMO: '1', SYNAPSE_CLOUD: cloud, SYNAPSE_RELAY: '', NO_OPEN: '1', SYNAPSE_TALK_CLAUDE: WRAPPER, ...extra });
function cli(home, args, extra) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { env: envFor(home, extra), timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${args.join(' ')}: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
}
const cliJSON = async (home, args, extra) => JSON.parse(await cli(home, args, extra));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(200); }
}
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function startCanvas(home, port) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: envFor(home, { PORT: String(port), SYNAPSE_SYNC_MS: '500' }), stdio: 'ignore' });
  procs.push(p);
  return until(() => fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.ok, () => false));
}
const randPort = () => 20000 + Math.floor(Math.random() * 20000);

const convs = (home, role) => readJSON(path.join(home, 'talks.json'), {}).conversations?.filter((c) => !role || c.role === role) || [];
const aliceAsk = (query, question, extra = [], env = {}) => cliJSON(HOME_A, ['ask', query, question, ...extra], { SYNAPSE_AGENT: WEB, ...env });
const bobAsk = (query, question, extra = []) => cliJSON(HOME_B, ['ask', query, question, ...extra], { SYNAPSE_AGENT: ML });
const edgesOf = (home) => readJSON(path.join(home, 'edges.json'), []);
// alice's mirrored view of one of bob's agents, once its mode has arrived (or gone)
const aliceSees = (agent, mode) => until(() => edgesOf(HOME_A).some((e) => e.mirrored && e.from.endsWith(`-${agent}`) && e.to === WEB && e.mode === mode) || (!mode && edgesOf(HOME_A).some((e) => e.mirrored && e.from.endsWith(`-${agent}`) && !e.mode)));
const fakeOut = (r) => { assert.ok(r.answer, JSON.stringify(r)); return JSON.parse(r.answer); }; // the fake answers with { argv, stdin, external }

before(async () => {
  if (skip) return;
  const port = 19000 + Math.floor(Math.random() * 1000);
  cloudProc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), CLOUD_DATA: path.join(tmp, 'cloud'), CLOUD_SECRET: 'test', CLOUD_DEV_MAIL: '1', PUBLIC_URL: `http://127.0.0.1:${port}` },
    stdio: 'ignore',
  });
  cloud = `http://127.0.0.1:${port}`;
  await until(() => fetch(`${cloud}/v1/auth/providers`).then((r) => r.ok, () => false));

  await cliJSON(HOME_A, ['signup', '--email', ALICE, '--password', PASS, '--name', 'alice']);
  await cliJSON(HOME_B, ['signup', '--email', BOB, '--password', PASS, '--name', 'bob']);
  await cliJSON(HOME_A, ['trust', BOB]);
  await cliJSON(HOME_B, ['trust', ALICE]);
  portA = randPort(); portB = randPort();
  await startCanvas(HOME_A, portA);
  await startCanvas(HOME_B, portB);

  // alice's agent asks bob for four of his agents: two claude, a codex one, and one that stays read-only
  const sent = await cliJSON(HOME_A, ['request', BOB, '--target', 'the backend agents'], { SYNAPSE_AGENT: WEB });
  const shared = 'ml-eval,api-auth,api-rate-limit,api-review';
  // read only to begin with: the scenarios below switch talk on agent by agent (accept with talk is scenario 10)
  assert.equal((await cliJSON(HOME_B, ['accept', sent.id, '--agents', shared, '--no-talk'])).status, 'accepted');
  await until(() => ['ml-eval', 'api-auth', 'api-rate-limit', 'api-review'].every((n) => edgesOf(HOME_A).some((e) => e.mirrored && e.from.endsWith(`-demo-${n}`))));
});
after(() => {
  for (const p of procs) p.kill();
  cloudProc?.kill();
  if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
});

test('talk on and off print what they switched', { skip }, async () => {
  assert.deepEqual(await cliJSON(HOME_B, ['talk', 'ml-eval', 'on']), { agent: 'ml-eval', mode: 'talk', edges: 1 });
  assert.ok(edgesOf(HOME_B).find((e) => e.from === ML && !e.mirrored).mode === 'talk');
  await assert.rejects(cli(HOME_B, ['talk', 'ml-eval', 'maybe']), /usage/);
  await assert.rejects(cli(HOME_B, ['talk', 'nobody', 'on']), /No agent/);
});

test('1 simple ask: the fork answers, bob keeps the conversation', { skip }, async () => {
  await aliceSees('demo-ml-eval', 'talk');
  const r = await aliceAsk('ml-eval@bob', 'What did the eval show?');
  assert.ok(r.conversation);
  const out = fakeOut(r);
  assert.match(out.stdin, /agent asks \(not your owner[^\n]*\n<question [^\n]*>\nWhat did the eval show\?\n<\/question nonce="\w+">$/);
  assert.equal(out.external, '1');
  for (const flag of ['--tools', '--strict-mcp-config', '--fork-session']) assert.ok(out.argv.includes(flag), flag);
  const owner = convs(HOME_B, 'owner');
  assert.equal(owner.length, 1);
  assert.equal(owner[0].status, 'open');
  assert.equal(owner[0].turns.length, 1);
  assert.equal(owner[0].turns[0].q, 'What did the eval show?');
  assert.ok(owner[0].forkSession);
});

test('2 a follow-up resumes the same fork', { skip }, async () => {
  const first = convs(HOME_B, 'owner')[0];
  const r = await aliceAsk('ml-eval@bob', 'And on long queries?', ['--conversation', first.id]);
  assert.equal(r.conversation, first.id);
  const out = fakeOut(r);
  assert.equal(out.argv[out.argv.indexOf('--resume') + 1], first.forkSession);
  assert.ok(!out.argv.includes('--fork-session'));
  assert.equal(convs(HOME_B, 'owner')[0].turns.length, 2);
});

test('3 a busy line queues the second question, then answers it', { skip }, async () => {
  setSleep(4000);
  const conv = convs(HOME_B, 'owner')[0].id;
  const one = aliceAsk('ml-eval@bob', 'first of two', ['--conversation', conv]);
  await until(() => convs(HOME_B, 'owner')[0].turns.some((t) => t.q === 'first of two'));
  const two = aliceAsk('ml-eval@bob', 'second of two', ['--conversation', conv]);
  const [a, b] = await Promise.all([one, two]);
  setSleep(0);
  assert.match(fakeOut(a).stdin, /\nfirst of two\n<\/question nonce="\w+">$/);
  assert.match(fakeOut(b).stdin, /\nsecond of two\n<\/question nonce="\w+">$/);
  const turns = convs(HOME_A, 'asker').find((c) => c.id === conv).turns;
  assert.equal(turns.find((t) => t.q === 'second of two').position, 2, 'behind the running answer she is second');
  const owner = convs(HOME_B, 'owner')[0].turns;
  assert.ok(owner.find((t) => t.q === 'first of two').answeredAt <= owner.find((t) => t.q === 'second of two').answeredAt, 'answered in order');
});

const talkRequests = (home) => readJSON(path.join(home, 'talks.json'), {}).talkRequests || [];
test('7 sync only: reading works, asking asks bob to allow it', { skip }, async () => {
  const read = await cli(HOME_A, ['read', 'api-review@bob'], { SYNAPSE_AGENT: WEB });
  assert.match(read, /P1/);
  const r = await aliceAsk('api-review@bob', 'anything?');
  assert.equal(r.status, 'requested', JSON.stringify(r));
  assert.equal(r.note, 'Asked bob to let you ask api-review. Try again once they allow it.');
  await until(() => talkRequests(HOME_B).some((x) => x.status === 'pending' && x.target === 'demo-api-review'));
  assert.equal(convs(HOME_B, 'owner').filter((c) => c.target === 'demo-api-review').length, 0, 'nothing is answered yet');
  // and turning talk off again closes the line
  await cliJSON(HOME_B, ['talk', 'ml-eval', 'off']);
  await until(() => !convs(HOME_B, 'owner').some((c) => c.status === 'open'));
  await aliceSees('demo-ml-eval', null);
  assert.equal((await aliceAsk('ml-eval@bob', 'still there?')).status, 'requested');
});

test('11 bob allows the request and alice\'s next ask is answered', { skip }, async () => {
  // asked again within the hour: still one prompt on bob's side
  assert.equal((await aliceAsk('api-review@bob', 'anything now?')).status, 'requested');
  await sleep(1500);
  const pending = talkRequests(HOME_B).filter((x) => x.target === 'demo-api-review');
  assert.equal(pending.length, 1);
  const st = await (await fetch(`http://127.0.0.1:${portB}/api/state`)).json();
  const row = st.talkRequests.find((x) => x.target === 'demo-api-review');
  assert.ok(row, 'the canvas state carries the prompt');
  assert.equal(row.peerName, 'alice');
  // another site can not allow it for bob
  const evil = await fetch(`http://127.0.0.1:${portB}/api/talk-requests/${row.id}/allow`, { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const ok = await fetch(`http://127.0.0.1:${portB}/api/talk-requests/${row.id}/allow`, { method: 'POST' });
  assert.equal(ok.status, 200);
  assert.equal(edgesOf(HOME_B).find((e) => !e.mirrored && e.from === 'demo-api-review').mode, 'talk');
  await aliceSees('demo-api-review', 'talk');
  // alice's agent hears it in its inbox
  await until(async () => (await cliJSON(HOME_A, ['inbox'], { SYNAPSE_AGENT: WEB })).some((m) => /bob let you ask api-review/.test(m.text)));
  const r = await aliceAsk('api-review@bob', 'Which finding is P1?');
  assert.match(fakeOut(r).stdin, /Which finding is P1\?/);
});

test('5 an agent bob never shared cannot be asked', { skip }, async () => {
  await assert.rejects(aliceAsk('docs@bob', 'hello?'), /No live agent matches "docs@bob"/);
  await assert.rejects(aliceAsk('web-checkout@bob', 'hello?'), /No live agent matches "web-checkout@bob"/);
  assert.equal(convs(HOME_B, 'owner').filter((c) => c.target === 'demo-docs').length, 0);
});

test('9 a codex target is answered by replaying its transcript', { skip }, async () => {
  await cliJSON(HOME_B, ['talk', 'api-rate-limit', 'on']);
  await aliceSees('demo-api-rate-limit', 'talk');
  const r = await aliceAsk('api-rate-limit@bob', 'Where do the limits live?');
  const out = fakeOut(r);
  assert.ok(!out.argv.includes('--resume'));
  assert.ok(!out.argv.includes('--fork-session'));
  assert.ok(out.argv.includes('--session-id'));
  assert.ok(out.argv.includes('--tools') && out.argv.includes('--strict-mcp-config'));
  assert.ok(out.stdin.includes('Token bucket per tenant in Redis. Limits live in `config/limits.yaml`. 42 tests passing.'), 'a line of its demo transcript');
  assert.match(out.stdin, /Where do the limits live\?/);
  assert.equal(convs(HOME_B, 'owner').find((c) => c.target === 'demo-api-rate-limit').mode, 'replay');
});

test('6 the owner cuts a conversation during a slow answer', { skip }, async () => {
  await cliJSON(HOME_B, ['talk', 'api-auth', 'on']);
  await aliceSees('demo-api-auth', 'talk');
  setSleep(5000);
  const pending = aliceAsk('api-auth@bob', 'explain the refresh rotation');
  const pid = (await until(() => readJSON(path.join(HOME_B, 'talks.json'), {}).running?.find((r) => r.pid))).pid;
  process.kill(pid, 0); // the answering child is alive before the cut
  const edge = edgesOf(HOME_B).find((e) => !e.mirrored && e.from === 'demo-api-auth' && e.to.startsWith('r-'));
  const cutAt = Date.now();
  const res = await fetch(`http://127.0.0.1:${portB}/api/edges/${edge.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const r = await pending;
  setSleep(0);
  assert.equal(r.status, 'ended', JSON.stringify(r));
  assert.equal(r.reason, 'owner');
  assert.ok(Date.now() - cutAt < 5000, `told within 5 s (${Date.now() - cutAt} ms)`);
  assert.equal(readJSON(path.join(HOME_B, 'talks.json'), {}).running.length, 0);
  await until(() => !edgesOf(HOME_A).some((e) => e.mirrored && e.from.endsWith('-demo-api-auth')));
  await until(() => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }, 3000);
  await assert.rejects(aliceAsk('api-auth@bob', 'one more?'), /No live agent matches "api-auth@bob"/);
});

test('10 both ways: each side asks the other at the same time', { skip }, async () => {
  const sent = await cliJSON(HOME_B, ['request', 'alice', '--target', 'web tests'], { SYNAPSE_AGENT: ML });
  assert.equal((await cliJSON(HOME_A, ['accept', sent.id, '--agents', 'web-e2e'])).status, 'accepted');
  // accepted with talk (the default): bob's agent may ask straight away, and only over this new share
  const mine = edgesOf(HOME_A).filter((e) => !e.mirrored && e.to.startsWith('r-'));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].from, WEB);
  assert.equal(mine[0].mode, 'talk');
  await cliJSON(HOME_B, ['talk', 'ml-eval', 'on']);
  await aliceSees('demo-ml-eval', 'talk');
  await until(() => edgesOf(HOME_B).some((e) => e.mirrored && e.to === ML && e.mode === 'talk'));
  setSleep(800);
  const [a, b] = await Promise.all([aliceAsk('ml-eval@bob', 'ping from alice'), bobAsk('web-e2e@alice', 'ping from bob')]);
  setSleep(0);
  assert.match(fakeOut(a).stdin, /\nping from alice\n<\/question nonce="\w+">$/);
  assert.match(fakeOut(b).stdin, /ping from bob\n<\/question nonce="\w+">$/);
});
