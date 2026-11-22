// Rooms end to end over a local cloud: alice and bob (two SYNAPSE_HOME folders with the demo agents) are friends.
// Alice makes a room, both add their own agents, people @mention agents and the agents answer through a fake
// `claude` that records how it was called. Also a stress run: both post at once and the rooms must agree.
//
//   node --test test/rooms.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER = path.join(ROOT, 'cloud', 'server.mjs');
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-claude-room.mjs');
const skip = !fs.existsSync(SERVER) ? 'cloud/server.mjs is not there' : false;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-rooms-e2e-'));
const HOME_A = path.join(tmp, 'alice'), HOME_B = path.join(tmp, 'bob');
const FAKE_A = path.join(tmp, 'fake-a'), FAKE_B = path.join(tmp, 'fake-b');
for (const d of [FAKE_A, FAKE_B]) fs.mkdirSync(d, { recursive: true });
const RUN = Math.random().toString(36).slice(2, 8);
const ALICE = `alice-${RUN}@example.test`, BOB = `bob-${RUN}@example.test`, PASS = 'correct horse battery';
let cloud = null;
const procs = [];

const fakeDir = (home) => (home === HOME_A ? FAKE_A : FAKE_B);
const envFor = (home, extra = {}) => ({
  ...process.env, SYNAPSE_HOME: home, SYNAPSE_DEMO: '1', SYNAPSE_CLOUD: cloud, SYNAPSE_RELAY: '', NO_OPEN: '1',
  SYNAPSE_TALK_CLAUDE: FAKE, FAKE_ROOM_DIR: fakeDir(home), ANTHROPIC_BASE_URL: 'http://abliterated.local', ...extra,
});
function cli(home, args, extra = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { env: envFor(home, extra), timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${args.join(' ')}: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
}
const cliJSON = async (home, args, extra) => JSON.parse(await cli(home, args, extra));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(150); }
}
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const roomsOf = (home) => readJSON(path.join(home, 'rooms.json'), {}).rooms || [];
const roomIn = (home, id) => roomsOf(home).find((r) => r.id === id);
const msgs = (home, id) => roomIn(home, id)?.messages || [];
const agentMsgs = (home, id) => msgs(home, id).filter((m) => m.from.type === 'agent');
const calls = (home) => fs.existsSync(path.join(fakeDir(home), 'calls.jsonl')) ? fs.readFileSync(path.join(fakeDir(home), 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const setFake = (home, name, v) => { const f = path.join(fakeDir(home), name); if (v == null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, String(v)); };
function startCanvas(home, port) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: envFor(home, { PORT: String(port), SYNAPSE_SYNC_MS: '400' }), stdio: 'ignore' });
  procs.push(p);
  return until(() => fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.ok, () => false));
}
const randPort = () => 20000 + Math.floor(Math.random() * 20000);
let roomId = null;

before(async () => {
  if (skip) return;
  const port = 19000 + Math.floor(Math.random() * 1000);
  procs.push(spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), CLOUD_DATA: path.join(tmp, 'cloud'), CLOUD_SECRET: 'test', CLOUD_DEV_MAIL: '1', PUBLIC_URL: `http://127.0.0.1:${port}` },
    stdio: 'ignore',
  }));
  cloud = `http://127.0.0.1:${port}`;
  await until(() => fetch(`${cloud}/v1/auth/providers`).then((r) => r.ok, () => false));
  await cliJSON(HOME_A, ['signup', '--email', ALICE, '--password', PASS, '--name', 'alice']);
  await cliJSON(HOME_B, ['signup', '--email', BOB, '--password', PASS, '--name', 'bob']);
  await cliJSON(HOME_A, ['trust', BOB]);
  await cliJSON(HOME_B, ['trust', ALICE]);
  // a request accepted pairs the two machines (friends); what it shares does not matter here
  const sent = await cliJSON(HOME_A, ['request', BOB], { SYNAPSE_AGENT: 'demo-web-e2e' });
  await cliJSON(HOME_B, ['accept', sent.id, '--agents', 'docs', '--no-talk']);
  await startCanvas(HOME_A, randPort());
  await startCanvas(HOME_B, randPort());
  await until(() => Object.keys(readJSON(path.join(HOME_A, 'remote.json'), {}).peers || {}).length && Object.keys(readJSON(path.join(HOME_B, 'remote.json'), {}).peers || {}).length, 40000);
});
after(() => {
  for (const p of procs) p.kill();
  if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
});

test('alice makes a room and adds her own agents; only Claude and Codex get in', { skip }, async () => {
  const r = await cliJSON(HOME_A, ['room', 'new', 'launch', 'prep']);
  roomId = r.id;
  assert.equal(r.name, 'launch prep');
  assert.equal(r.hosted, true);
  assert.deepEqual(await cliJSON(HOME_A, ['room', 'agent', roomId, 'ml-eval']), { added: true });
  assert.deepEqual(await cliJSON(HOME_A, ['room', 'agent', roomId, 'infra-terraform']), { added: true });
  await assert.rejects(cli(HOME_A, ['room', 'agent', roomId, 'web-e2e']), /Only Claude and Codex/); // gemini
  await assert.rejects(cli(HOME_A, ['room', 'agent', roomId, 'cursor-landing']), /Only Claude and Codex/);
  assert.deepEqual(roomIn(HOME_A, roomId).agents.map((a) => a.name), ['ml-eval', 'infra-terraform']);
});

test('alice adds bob; bob gets the room and adds his own agent', { skip }, async () => {
  assert.deepEqual(await cliJSON(HOME_A, ['room', 'add', roomId, 'bob']), { added: true });
  await until(() => roomIn(HOME_B, roomId));
  assert.equal(roomIn(HOME_B, roomId).host, roomIn(HOME_A, roomId).host);
  assert.deepEqual(await cliJSON(HOME_B, ['room', 'agent', roomId, 'api-auth']), { added: true });
  await until(() => roomIn(HOME_A, roomId).agents.some((a) => a.name === 'api-auth' && a.owner === 'bob'));
  await until(() => roomIn(HOME_B, roomId).agents.length === 3);
});

test("bob @mentions alice's agent: a read-only Claude copy on alice's machine answers, no approval", { skip }, async () => {
  const before = calls(HOME_A).length;
  await cliJSON(HOME_B, ['room', 'say', roomId, '@ml-eval@alice what did the eval show?']);
  const answer = await until(() => agentMsgs(HOME_B, roomId).find((m) => m.from.name === 'ml-eval'));
  assert.equal(answer.from.owner, 'alice');
  const call = calls(HOME_A)[before];
  const flag = (f) => call.argv[call.argv.indexOf(f) + 1];
  assert.equal(flag('--tools'), '');
  assert.equal(flag('--setting-sources'), '');
  assert.equal(flag('--model'), 'sonnet');
  assert.ok(call.argv.includes('--strict-mcp-config'));
  assert.ok(call.argv.includes('--fork-session'));
  assert.equal(flag('--resume'), 'demo-ml-eval');
  assert.equal(call.external, '1');
  assert.equal(call.base, null, 'a model endpoint override never reaches the answering copy');
  assert.match(flag('--append-system-prompt'), /read-only copy[\s\S]*no tools[\s\S]*Never reveal secrets/);
  assert.match(call.stdin, /<room nonce="(\w+)">\n[\s\S]*bob \(person\): @ml-eval@alice what did the eval show\?\n<\/room nonce="\1">/);
  // the copy's session is gone, and nothing is left running
  await until(() => (readJSON(path.join(HOME_A, 'rooms.json'), {}).running || []).length === 0);
  // bob's other agents and alice's codex one were not mentioned and stayed quiet
  assert.equal(agentMsgs(HOME_A, roomId).length, 1);
});

test('a codex agent answers from a replay of its transcript, still a Claude model with no tools', { skip }, async () => {
  const before = calls(HOME_A).length;
  await cliJSON(HOME_A, ['room', 'say', roomId, '@infra-terraform how big is the replica?']);
  await until(() => agentMsgs(HOME_B, roomId).some((m) => m.from.name === 'infra-terraform'));
  const call = calls(HOME_A)[before];
  assert.ok(!call.argv.includes('--resume'));
  assert.equal(call.argv[call.argv.indexOf('--tools') + 1], '');
  assert.match(call.stdin, /infra-terraform's conversation so far[\s\S]*read replica/);
});

test('secrets in an answer are scrubbed before they leave the machine', { skip }, async () => {
  setFake(HOME_B, 'reply', 'Sure: ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 and the db is postgres://app:hunter22@db.internal:5432/app and ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  try {
    await cliJSON(HOME_A, ['room', 'say', roomId, '@api-auth what keys do you use?']);
    const m = await until(() => agentMsgs(HOME_A, roomId).find((x) => x.from.name === 'api-auth'));
    assert.doesNotMatch(m.text, /sk-ant|hunter22|ghp_/);
    assert.match(m.text, /\[redacted\]/);
  } finally { setFake(HOME_B, 'reply', null); }
});

test('an answer from a model that is not Claude is never posted', { skip }, async () => {
  setFake(HOME_B, 'model', 'llama-3-70b-abliterated');
  setFake(HOME_B, 'reply', 'uncensored answer');
  try {
    await cliJSON(HOME_A, ['room', 'say', roomId, '@api-auth are you there?']);
    const m = await until(() => agentMsgs(HOME_A, roomId).filter((x) => x.from.name === 'api-auth')[1]);
    assert.doesNotMatch(m.text, /uncensored/);
    assert.match(m.text, /not a Claude model/);
  } finally { setFake(HOME_B, 'model', null); setFake(HOME_B, 'reply', null); }
});

test('agents mentioning each other stop after a few hops', { skip }, async () => {
  setFake(HOME_A, 'reply', '@api-auth over to you');
  setFake(HOME_B, 'reply', '@ml-eval@alice back to you');
  try {
    const start = agentMsgs(HOME_A, roomId).length;
    await cliJSON(HOME_A, ['room', 'say', roomId, '@api-auth kick it off']);
    await until(() => agentMsgs(HOME_A, roomId).length - start >= 3);
    await sleep(4000); // long enough for a fourth hop, if there were one
    const hops = agentMsgs(HOME_A, roomId).slice(start);
    assert.equal(hops.length, 3, hops.map((m) => `${m.from.name}:${m.depth}`).join(' '));
    assert.deepEqual(hops.map((m) => m.depth), [1, 2, 3]);
  } finally { setFake(HOME_A, 'reply', null); setFake(HOME_B, 'reply', null); }
});

test('stress: both post at once; both machines end up with the same messages', { skip }, async () => {
  const n = 15;
  await Promise.all([
    ...Array.from({ length: n }, (_, i) => cliJSON(HOME_A, ['room', 'say', roomId, `alice ${i}`])),
    ...Array.from({ length: n }, (_, i) => cliJSON(HOME_B, ['room', 'say', roomId, `bob ${i}`])),
  ]);
  const ids = (home) => msgs(home, roomId).map((m) => m.id).sort().join();
  await until(() => msgs(HOME_A, roomId).filter((m) => /^(alice|bob) \d+$/.test(m.text)).length === 2 * n && ids(HOME_A) === ids(HOME_B), 30000);
  for (const home of [HOME_A, HOME_B]) {
    const texts = msgs(home, roomId).map((m) => m.text);
    for (let i = 0; i < n; i++) { assert.ok(texts.includes(`alice ${i}`)); assert.ok(texts.includes(`bob ${i}`)); }
  }
});

test('no answering copy is left behind or shows up as an agent', { skip }, async () => {
  for (const home of [HOME_A, HOME_B]) {
    const s = readJSON(path.join(home, 'rooms.json'), {});
    assert.equal((s.running || []).length, 0);
    assert.equal((s.jobs || []).length, 0);
  }
  const agents = await cliJSON(HOME_A, ['agents']);
  assert.ok(agents.every((a) => a.id.startsWith('demo-') || a.id.startsWith('r-')), agents.map((a) => a.id).join());
});

test("bob leaves: his agents go with him; alice closing the room removes it for everyone", { skip }, async () => {
  assert.deepEqual(await cliJSON(HOME_B, ['room', 'leave', roomId]), { left: true });
  assert.equal(roomIn(HOME_B, roomId), undefined);
  await until(() => !roomIn(HOME_A, roomId).members.some((m) => m.name === 'bob'));
  assert.ok(!roomIn(HOME_A, roomId).agents.some((a) => a.owner === 'bob'));
  // a second room with bob in it, closed by alice
  const r2 = await cliJSON(HOME_A, ['room', 'new', 'short', 'lived']);
  await cliJSON(HOME_A, ['room', 'add', r2.id, 'bob']);
  await until(() => roomIn(HOME_B, r2.id));
  await cliJSON(HOME_A, ['room', 'leave', r2.id]);
  await until(() => !roomIn(HOME_B, r2.id));
});
