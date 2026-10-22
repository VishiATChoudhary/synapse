import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, searchSessions, sessionTree } from '../public/workspace.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let child, home, base;

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'synapse-workspace-test-'));
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: root, env: { ...process.env, PORT: '0', NO_OPEN: '1', SYNAPSE_DEMO: '1', SYNAPSE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Demo server did not start.')), 15000);
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.stderr.on('data', (data) => { output += data; });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited (${code}): ${output}`)); });
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM'); await exited;
  }
  if (home) await rm(home, { recursive: true, force: true });
});

const request = (url, body, method = 'POST', headers = {}) => fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('transcript markdown keeps executable content inert', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert) [safe](https://example.com/a?x=1&y=2)\n\n`<img src=x onerror=alert(1)>`');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('href="https://example.com/a?x=1&amp;y=2"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('<code>&lt;img'));
});

test('conversations render fenced code, lists, and comparison tables', () => {
  const html = renderMarkdown('## Findings\n\n1. **First**\n2. Second\n\n```js\nconst x = "<safe>";\n```\n\n| Tool | State |\n| --- | --- |\n| Codex | Ready |');
  assert.match(html, /<h3>Findings<\/h3>/);
  assert.match(html, /<ol><li><strong>First<\/strong>/);
  assert.match(html, /const x = &quot;&lt;safe&gt;&quot;;/);
  assert.match(html, /data-copy-code/);
  assert.match(html, /<th>Tool<\/th>/);
  assert.match(html, /<td>Codex<\/td>/);
});

test('search matches multiple words across project, provider, and folder', () => {
  const agents = [
    { id: 'one', name: 'rate-limit', kind: 'codex', project: 'api', cwd: '/dev/api', lastActivity: 10 },
    { id: 'two', name: 'checkout', kind: 'claude', project: 'web', cwd: '/dev/web', lastActivity: 20 },
  ];
  assert.deepEqual(searchSessions(agents, 'cdx api').map((agent) => agent.id), ['one']);
  assert.deepEqual(searchSessions(agents, 'checkout /dev').map((agent) => agent.id), ['two']);
  assert.deepEqual(searchSessions(agents, 'codex web'), []);
  assert.equal(searchSessions(agents, '')[0].id, 'two');
});

test('session trees preserve fork depth, sibling order, and orphaned sessions', () => {
  const agents = [
    { id: 'child-two', parent: 'root' }, { id: 'grandchild', parent: 'child-one' },
    { id: 'root', parent: null }, { id: 'child-one', parent: 'root' },
    { id: 'other', parent: null }, { id: 'orphan', parent: 'gone' },
  ];
  const tree = sessionTree(agents);
  assert.deepEqual(tree.map((n) => n.agent.id), ['root', 'other', 'orphan']);
  assert.deepEqual(tree[0].children.map((n) => n.agent.id), ['child-two', 'child-one']);
  assert.equal(tree[0].children[1].children[0].agent.id, 'grandchild');
  const cycle = sessionTree([{ id: 'a', forkOf: 'b' }, { id: 'b', forkOf: 'a' }]);
  assert.equal(cycle.length, 1);
  assert.equal(cycle[0].children[0].children.length, 0);
});

test('the GUI and original canvas are available without dependencies', async () => {
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.demo, true);
  assert.equal(state.agents.length, 10);
  assert.ok(state.agents.find((agent) => agent.id === 'demo-api-auth').preview);
  assert.match(await (await fetch(base)).text(), /src="\/workspace.mjs"/);
  assert.match(await (await fetch(base + '/canvas')).text(), /<canvas id="c">/);
  for (const asset of ['/workspace.css', '/workspace.mjs', '/tokens.css', '/fonts/geist.woff2']) {
    const response = await fetch(base + asset);
    assert.equal(response.status, 200, asset);
    assert.ok(Number(response.headers.get('content-length')) !== 0 || (await response.arrayBuffer()).byteLength > 0);
  }
});

test('messages are queued for the chosen agent and appear in its conversation', async () => {
  const response = await request('/api/agents/demo-api-auth/messages', { text: '  Please check the refresh-token test.  ' });
  assert.equal(response.status, 201);
  const message = await response.json();
  assert.equal(message.from, 'synapse-user');
  assert.equal(message.to, 'demo-api-auth');
  assert.equal(message.delivered, false);
  assert.equal(message.text, 'Please check the refresh-token test.');
  const recent = await (await fetch(base + '/api/agents/demo-api-auth/recent?limit=60')).json();
  assert.ok(recent.chat.some((entry) => entry.id === message.id && entry.delivered === false));
});

test('invalid messages and foreign-origin writes are rejected', async () => {
  for (const text of ['', '   ', 42, 'x'.repeat(12001)]) {
    assert.equal((await request('/api/agents/demo-api-auth/messages', { text })).status, 400);
  }
  assert.equal((await request('/api/agents/no-such-agent/messages', { text: 'Hello' })).status, 404);
  assert.equal((await request('/api/agents/demo-api-auth/messages', { text: 'No' }, 'POST', { origin: 'https://example.com' })).status, 403);
  assert.equal((await request('/api/agents/demo-api-auth/messages', { text: 'x'.repeat(70000) })).status, 413);
  const malformed = await fetch(base + '/api/agents/demo-api-auth/messages', { method: 'POST', body: '{bad json' });
  assert.equal(malformed.status, 400);
});

test('connections can be added, deduplicated, and removed', async () => {
  const endpoints = { from: 'demo-docs', to: 'demo-web-e2e' };
  const response = await request('/api/edges', endpoints);
  assert.equal(response.status, 201);
  const edge = await response.json();
  assert.equal((await request('/api/edges', endpoints)).status, 409);
  assert.equal((await request('/api/edges', { from: endpoints.from, to: endpoints.from })).status, 400);
  assert.equal((await fetch(base + `/api/edges/${edge.id}`, { method: 'DELETE' })).status, 200);
  const state = await (await fetch(base + '/api/state')).json();
  assert.ok(!state.edges.some((item) => item.id === edge.id));
});

test('renaming a session updates discovery and can restore its original name', async () => {
  assert.equal((await request('/api/agents/demo-api-auth/name', { name: 'Session rotation' })).status, 200);
  let state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.agents.find((agent) => agent.id === 'demo-api-auth').name, 'Session rotation');
  assert.equal((await request('/api/agents/demo-api-auth/name', { name: '' })).status, 200);
  state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.agents.find((agent) => agent.id === 'demo-api-auth').name, 'api-auth');
});

test('a connected workspace receives state changes over its event stream', async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(base + '/api/events', { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let data = decoder.decode((await reader.read()).value);
    assert.match(data, /event: state/);
    const sent = await request('/api/agents/demo-api-auth/messages', { text: 'An event stream check.' });
    assert.equal(sent.status, 201);
    while ((data.match(/event: state/g) || []).length < 2) data += decoder.decode((await reader.read()).value);
    assert.ok((data.match(/messageRevision/g) || []).length >= 2);
    await reader.cancel();
  } finally { clearTimeout(timeout); controller.abort(); }
});
