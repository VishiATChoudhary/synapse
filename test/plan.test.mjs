// Shared plans between agents of different kinds: start links the members and tells them, every change reaches the
// others as a message, tasks are claimed and finished, and only members can touch a plan.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-plan-'));
process.env.SYNAPSE_HOME = home;
process.env.SYNAPSE_DEMO = '1';
process.env.SYNAPSE_CLAUDE_HOME = path.join(home, 'claude');
const { FILES, readJSON, writeJSON, localAgents, takeInbox, linked } = await import('../lib.mjs');
const plan = await import('../plan.mjs');

const agent = (name) => localAgents().find((a) => a.name === name);
const claude = agent('api-auth'), codex = agent('api-rate-limit'), gemini = agent('web-e2e'), opencode = agent('docs');

beforeEach(() => { writeJSON(FILES.edges, []); writeJSON(FILES.messages, []); writeJSON(FILES.plans, []); });

test('a Claude agent starts a plan with Codex and Gemini agents: linked, and both told the goal', () => {
  const out = plan.start(claude, { goal: 'Add rate limits to the login API', agents: ['api-rate-limit', 'web-e2e'], tasks: ['Pick limits per route'] });
  assert.deepEqual(out.members, ['api-auth (claude)', 'api-rate-limit (codex)', 'web-e2e (gemini)']);
  assert.deepEqual(out.tasks, [{ n: 1, task: 'Pick limits per route', status: 'open' }]);
  const edges = readJSON(FILES.edges, []);
  for (const o of [codex, gemini]) assert.ok(linked(edges, claude.id, o.id) && edges.some((e) => e.from === o.id && e.to === claude.id), `${o.name} linked both ways`);
  for (const o of [codex, gemini]) {
    const [m] = takeInbox(o.id);
    assert.match(m.text, /api-auth started a plan with api-rate-limit, web-e2e/);
    assert.match(m.text, /Goal: Add rate limits to the login API/);
    assert.match(m.text, /1\. Pick limits per route/);
  }
  assert.deepEqual(takeInbox(claude.id), [], 'the starter is not told about its own plan');
});

test('notes, tasks, claim and done reach every other member, and the plan shows who does what', () => {
  const { id } = plan.start(claude, { goal: 'Ship the docs', agents: ['docs', 'api-rate-limit'] });
  takeInbox(opencode.id); takeInbox(codex.id);

  plan.update(opencode, { note: 'I can write the API reference.', add_tasks: ['API reference', 'Quick start'] });
  for (const o of [claude, codex]) {
    const [m] = takeInbox(o.id);
    assert.match(m.text, /^\[plan [0-9a-f]{8}: Ship the docs\] I can write the API reference\.\nAdded tasks:\n1\. API reference\n2\. Quick start$/);
  }
  assert.deepEqual(takeInbox(opencode.id), []);

  plan.update(opencode, { id: id.slice(0, 8), claim: 1 });
  assert.throws(() => plan.update(codex, { claim: 1 }), /already docs's/);
  plan.update(codex, { claim: 2 });
  const out = plan.update(opencode, { done: 1 });
  assert.deepEqual(out.tasks, [
    { n: 1, task: 'API reference', status: 'done', owner: 'docs' },
    { n: 2, task: 'Quick start', status: 'doing', owner: 'api-rate-limit' },
  ]);
  assert.deepEqual(out.notes, ['docs: I can write the API reference.']);
  assert.match(takeInbox(claude.id).map((m) => m.text).join('\n'), /I am taking task 1[\s\S]*I am taking task 2[\s\S]*Done with task 1/);

  plan.update(codex, { done: 2 });
  assert.match(plan.update(claude, { note: 'Looks good.' }).next, /close the plan/);
  plan.update(claude, { close: true });
  assert.equal(plan.list(codex, { id }).status, 'closed');
});

test('only members see or change a plan; a plan needs a goal and someone else', () => {
  plan.start(claude, { goal: 'Private plan', agents: ['api-rate-limit'] });
  assert.throws(() => plan.update(gemini, { note: 'hi' }), /not on any open plan/);
  assert.deepEqual(plan.list(gemini).plans, []);
  assert.equal(plan.list(codex).latest.goal, 'Private plan');
  assert.throws(() => plan.start(claude, { goal: '', agents: ['api-rate-limit'] }), /needs a goal/);
  assert.throws(() => plan.start(claude, { goal: 'Alone', agents: ['api-auth'] }), /at least one other agent/);
  assert.throws(() => plan.start(claude, { goal: 'Nobody', agents: ['no-such-agent'] }), /No live agent matches/);
  assert.throws(() => plan.update(codex, {}), /Nothing to update/);
});
