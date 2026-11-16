// Todos shared by the user and their agents: added, linked to an agent, ticked, reworded, removed; and Linear
// (against a stand-in GraphQL server): assigned issues come in, ticking moves the issue, a todo can become an issue,
// and an issue finished in Linear ticks its todo here.
import { test, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-todos-'));
process.env.SYNAPSE_HOME = home;
process.env.SYNAPSE_DEMO = '1';
process.env.SYNAPSE_CLAUDE_HOME = path.join(home, 'claude');
const { localAgents } = await import('../lib.mjs');
const todos = await import('../todos.mjs');

const agent = (name) => localAgents().find((a) => a.name === name);
beforeEach(() => { fs.writeFileSync(todos.FILE, '[]'); todos.disconnectLinear(); });

test('add links to an agent, update ticks, rewords and relinks, remove deletes', async () => {
  const claude = agent('api-auth'), codex = agent('api-rate-limit');
  const t = await todos.add({ text: '  Fix the   login bug ', agent: 'api-auth', by: 'api-auth' });
  assert.equal(t.text, 'Fix the login bug');
  assert.deepEqual(t.agent, { id: claude.id, name: 'api-auth' });
  assert.deepEqual(todos.list({ agent: claude.id, done: false }).map((x) => x.id), [t.id]);
  await todos.update(t.id.slice(0, 4), { done: true });
  assert.equal(todos.list({ done: true }).length, 1);
  await todos.update(t.id, { text: 'Fix login', agent: 'api-rate-limit' });
  assert.equal(todos.all()[0].agent.id, codex.id);
  await todos.update(t.id, { agent: 'none' });
  assert.equal(todos.all()[0].agent, null);
  assert.deepEqual(todos.show(todos.all()[0]), { id: t.id, todo: 'Fix login', done: true, by: 'api-auth' });
  todos.remove(t.id);
  assert.deepEqual(todos.all(), []);
  await assert.rejects(todos.add({ text: '   ' }), /needs some text/);
  await assert.rejects(todos.update('nope', { done: true }), /No todo "nope"/);
  await assert.rejects(todos.add({ text: 'x', agent: 'no-such-agent' }), /No live agent/);
});

// a stand-in for Linear's GraphQL API
let server, calls = [];
const issues = new Map([['i1', { id: 'i1', identifier: 'ENG-1', title: 'Ship todos', url: 'https://linear.app/x/issue/ENG-1', team: { id: 'T1' }, state: { type: 'started' } }]]);
before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const { query, variables } = JSON.parse(raw);
    calls.push({ query, variables, key: req.headers.authorization });
    const send = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== 'lin_good') return send({ errors: [{ message: 'Authentication required' }] });
    if (query.includes('teams(first')) return send({ data: { viewer: { id: 'me', name: 'Vi' }, teams: { nodes: [{ id: 'T1', name: 'Eng', key: 'ENG' }] } } });
    if (query.includes('assignedIssues')) return send({ data: { viewer: { assignedIssues: { nodes: [...issues.values()].filter((i) => !['completed', 'canceled'].includes(i.state.type)) } } } });
    if (query.includes('issues(first')) return send({ data: { issues: { nodes: variables.ids.map((id) => issues.get(id)).filter(Boolean) } } });
    if (query.includes('team(id')) return send({ data: { team: { states: { nodes: [{ id: 'S-done', type: 'completed', position: 3 }, { id: 'S-todo', type: 'unstarted', position: 1 }, { id: 'S-back', type: 'backlog', position: 0 }] } } } });
    if (query.includes('issueUpdate')) { issues.get(variables.id).state.type = variables.state === 'S-done' ? 'completed' : 'unstarted'; return send({ data: { issueUpdate: { success: true } } }); }
    if (query.includes('issueCreate')) { const i = { id: 'i2', identifier: 'ENG-2', title: variables.title, url: 'https://linear.app/x/issue/ENG-2', team: { id: variables.team }, state: { type: 'unstarted' }, assignee: variables.me }; issues.set('i2', i); return send({ data: { issueCreate: { success: true, issue: i } } }); }
    send({ errors: [{ message: 'unknown query' }] });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.SYNAPSE_LINEAR_URL = `http://127.0.0.1:${server.address().port}/graphql`;
});
after(() => server.close());

test('Linear: a bad key is refused; a good one connects, kept readable by you only, without showing the key', async () => {
  await assert.rejects(todos.connectLinear('lin_bad'), /Authentication required/);
  const status = await todos.connectLinear('lin_good');
  assert.deepEqual(status, { connected: true, name: 'Vi', team: 'T1', teams: [{ id: 'T1', name: 'Eng', key: 'ENG' }], syncedAt: 0, error: '' });
  assert.equal(fs.statSync(path.join(home, 'linear.json')).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(todos.linearStatus()).includes('lin_good'));
});

test('Linear: assigned issues come in, ticking moves the issue, finishing in Linear ticks here, a todo becomes an issue', async () => {
  await todos.connectLinear('lin_good');
  issues.get('i1').state.type = 'started';
  assert.deepEqual(await todos.syncLinear(), { connected: true, added: 1, changed: 0 });
  const [t] = todos.all();
  assert.equal(t.text, 'Ship todos'); assert.equal(t.linear.identifier, 'ENG-1'); assert.equal(t.by, 'Linear');
  assert.deepEqual(await todos.syncLinear(), { connected: true, added: 0, changed: 0 }, 'no duplicates');

  await todos.update('ENG-1', { done: true });
  assert.equal(issues.get('i1').state.type, 'completed', 'ticked here: done in Linear');
  await todos.update(t.id, { done: false });
  assert.equal(issues.get('i1').state.type, 'unstarted', 'reopened here: open in Linear');

  issues.get('i1').state.type = 'completed'; // finished in Linear
  await todos.syncLinear();
  assert.equal(todos.all()[0].done, true, 'finished in Linear: ticked here');

  const mine = await todos.add({ text: 'Write the changelog', linear: true });
  assert.equal(mine.linear.identifier, 'ENG-2');
  assert.equal(issues.get('i2').assignee, 'me');
  assert.equal(issues.get('i2').title, 'Write the changelog');
  todos.disconnectLinear();
  assert.deepEqual(todos.linearStatus(), { connected: false });
  await assert.rejects(todos.toLinear(mine.id), /not connected/);
});
