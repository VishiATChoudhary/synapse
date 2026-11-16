import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, searchSessions, sessionTree, parseApproval } from '../public/workspace.mjs';
import { transcriptTitle } from '../discovery.mjs';
import { writeFileSync, readFileSync } from 'node:fs';

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

test('agents hidden from the canvas stay hidden until shown again', async () => {
  const { agents } = await (await fetch(base + '/api/state')).json();
  const [a, b] = agents;
  assert.deepEqual((await (await request('/api/canvas/hidden', { ids: [a.id, b.id], hidden: true })).json()).hidden, [a.id, b.id]);
  assert.deepEqual((await (await fetch(base + '/api/state')).json()).hidden, [a.id, b.id]);
  assert.deepEqual((await (await request('/api/canvas/hidden', { ids: [a.id], hidden: false })).json()).hidden, [b.id]);
  assert.deepEqual((await (await request('/api/canvas/hidden', { all: true, hidden: false })).json()).hidden, []);
});

test('search finds sessions by title and worktree, fuzzily, but not by the main checkout label', () => {
  const agents = [
    { id: 'a', name: 'claude-2', title: 'Short-lived JWTs with refresh rotation', project: 'acme-api', worktreeName: 'Main checkout', worktreeHome: true, kind: 'claude', cwd: '/dev/acme-api' },
    { id: 'b', name: 'web-checkout', title: 'Checkout on the new design system', project: 'acme-web', worktreeName: 'Main checkout', worktreeHome: true, kind: 'claude', cwd: '/dev/acme-web' },
    { id: 'c', name: 'codex', title: '', project: 'acme-api', worktreeName: 'rate-limit', worktreeHome: false, kind: 'codex', cwd: '/dev/wt/rate' },
  ];
  assert.deepEqual(searchSessions(agents, 'jwt').map((a) => a.id), ['a']);
  assert.deepEqual(searchSessions(agents, 'chkout').map((a) => a.id), ['b']);
  assert.deepEqual(searchSessions(agents, 'ratelim').map((a) => a.id), ['c']);
  assert.deepEqual(searchSessions(agents, 'conn').map((a) => a.id), [], 'scattered letters are not a match');
});

test('approval prompts are read off the terminal screen as a question and numbered choices', () => {
  const claude = parseApproval(['╭────╮', '│ Bash command │', '│   rm -rf build │', '│ Do you want to proceed? │', '│ ❯ 1. Yes │', "│   2. Yes, and don't ask again │", '│   3. No, and tell Claude what to do differently (esc) │', '╰────╯']);
  assert.match(claude.question, /rm -rf build\nDo you want to proceed\?/);
  assert.deepEqual(claude.options.map((o) => [o.key, o.selected]), [['1', true], ['2', false], ['3', false]]);
  const codex = parseApproval(['Allow command?', '  rm x', '› 1. Yes, proceed (y)', '  2. No (esc)']);
  assert.equal(codex.question, 'Allow command?\nrm x');
  assert.equal(codex.options.length, 2);
  assert.deepEqual(parseApproval(['Press Enter to continue']).options, []);
});

test('agent prompts read from real Claude Code screens: questions, tabs, multi-select, permission, review, menus', () => {
  const screen = (name) => parseApproval(readFileSync(path.join(root, 'test/fixtures/prompts', `${name}.txt`), 'utf8').split('\n'));
  const short = (p) => p.options.map((o) => [o.key, o.label, ...(o.selected ? ['>'] : []), ...(o.checked !== undefined ? [o.checked ? 'x' : ' '] : []), ...(o.input ? ['input'] : []), ...(o.chat ? ['chat'] : [])]);
  const q = screen('claude-question');
  assert.equal(q.title, 'Color theme'); assert.equal(q.text, 'Which color theme do you prefer?');
  assert.deepEqual(short(q), [['1', 'Light', '>'], ['2', 'Dark'], ['3', 'High contrast'], ['4', 'Type something.', 'input'], ['5', 'Chat about this', 'chat']]);
  assert.match(q.options[1].description, /^Dark backgrounds with light text/);
  const tabs = screen('claude-questions-tabs');
  assert.deepEqual(tabs.tabs.map((t) => t.label), ['Color', 'Animal']); assert.equal(tabs.text, 'What is your favorite color?');
  assert.equal(tabs.options.length, 5);
  const multi = screen('claude-multiselect');
  assert.ok(multi.multi && multi.submit);
  assert.deepEqual(short(multi).slice(0, 4), [['1', 'Apple', '>', ' '], ['2', 'Banana', ' '], ['3', 'Cherry', ' '], ['4', 'Type something', ' ', 'input']]);
  const perm = screen('claude-permission');
  assert.equal(perm.title, 'Bash command'); assert.equal(perm.detail, 'touch synapse-perm-test.txt');
  assert.equal(perm.text, 'Create empty file synapse-perm-test.txt\nDo you want to proceed?');
  assert.deepEqual(perm.options.map((o) => o.label), ['Yes', 'Yes, and always allow access to /private/tmp/cap from this project', 'Yes, and switch to auto mode · auto mode handles these prompts for you', 'No']);
  const review = screen('claude-review');
  assert.equal(review.title, 'Review your answers'); assert.match(review.text, /→ Apple, Cherry\nReady to submit your answers\?/);
  assert.deepEqual(short(review), [['1', 'Submit answers', '>'], ['2', 'Cancel']]);
  const trust = screen('claude-trust');
  assert.deepEqual(short(trust), [['nav:0', 'No, exit', '>'], ['nav:1', 'Yes, I trust this folder']]);
  assert.match(trust.text, /Quick safety check/);
  assert.deepEqual(short(screen('claude-menu')), [['1', 'Yes', '>'], ['2', 'Not now'], ['3', "Don't show again"]]);
});

test('a transcript title is Claude Code\'s newest aiTitle, else the first thing you asked', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'synapse-title-'));
  const claude = path.join(dir, 'c.jsonl'), codex = path.join(dir, 'x.jsonl'), plain = path.join(dir, 'p.jsonl');
  writeFileSync(claude, [{ type: 'user', message: { content: 'fix it' } }, { type: 'ai-title', aiTitle: 'Old name' }, { type: 'ai-title', aiTitle: 'Fix the login redirect loop' }].map((o) => JSON.stringify(o)).join('\n'));
  writeFileSync(codex, [{ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n...' }] } }, { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'Add rate limits to the public API, per tenant, stored in Redis with a token bucket and tests' }] } }].map((o) => JSON.stringify(o)).join('\n'));
  writeFileSync(plain, JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }));
  assert.equal(transcriptTitle(claude), 'Fix the login redirect loop');
  assert.equal(transcriptTitle(codex), 'Add rate limits to the public API, per tenant, stored in Redis…');
  assert.equal(transcriptTitle(plain), '');
  await rm(dir, { recursive: true, force: true });
});

test('a project shows its GitHub owner picture; checkouts not on GitHub get none', async () => {
  const { execFileSync } = await import('node:child_process');
  const { ownerFromRemote } = await import('../lib.mjs');
  assert.deepEqual(['git@github.com:pingdotgg/t3code.git', 'https://github.com/acme-inc/api', 'ssh://git@github.com/acme/x.git', 'https://gitlab.com/a/b.git', ''].map(ownerFromRemote), ['pingdotgg', 'acme-inc', 'acme', null, null]);
  const repo = await mkdtemp(path.join(tmpdir(), 'synapse-avatar-')), plain = await mkdtemp(path.join(tmpdir(), 'synapse-avatar-'));
  for (const dir of [repo, plain]) execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme-inc/api.git']);
  const on = await fetch(`${base}/api/avatar?dir=${encodeURIComponent(repo)}`, { redirect: 'manual' });
  assert.equal(on.status, 302);
  assert.equal(on.headers.get('location'), 'https://github.com/acme-inc.png?size=96');
  assert.equal((await fetch(`${base}/api/avatar?dir=${encodeURIComponent(plain)}`, { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(`${base}/api/avatar?dir=relative/path`, { redirect: 'manual' })).status, 404);
  await rm(repo, { recursive: true, force: true }); await rm(plain, { recursive: true, force: true });
});

test('a plan from the GUI needs a running agent to start it', async () => {
  const r = await fetch(`${base}/api/plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'nobody', agents: ['x'], goal: 'g' }) });
  assert.equal(r.status, 404);
});

test('ending an idle agent needs this page and a known local agent', async () => {
  const cross = await fetch(`${base}/api/agents/anything/end`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);
  assert.equal((await fetch(`${base}/api/agents/nobody-here/end`, { method: 'POST' })).status, 404);
});
