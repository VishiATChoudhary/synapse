// Real Electron test for todos: added on the Todos page and linked to an agent, added by an agent (the CLI), ticked,
// shown on the agent's panel; when the agent ends you are asked which of its todos are done. Linear (a stand-in
// GraphQL server): connecting with a key brings in the issues assigned to you, and ticking one moves it there.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-todos.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-todos-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), claudeHome = path.join(fixture, 'claude'), ctl = path.join(fixture, 'ctl');
for (const d of [state, bin, ctl, path.join(claudeHome, 'sessions')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
let slot = 0; for (;; slot++) { try { fs.writeFileSync(path.join(${JSON.stringify(ctl)}, 'slot-' + slot), String(process.pid), { flag: 'wx' }); break; } catch {} }
const file = path.join(${JSON.stringify(path.join(claudeHome, 'sessions'))}, process.pid + '.json');
const control = path.join(${JSON.stringify(ctl)}, 'state-' + slot);
let status = '';
const tick = () => {
  let want = 'busy'; try { want = fs.readFileSync(control, 'utf8').trim() || 'busy'; } catch {}
  if (want !== status) { status = want; fs.writeFileSync(file, JSON.stringify({ sessionId: 'stand-in-' + process.pid, pid: process.pid, cwd: process.cwd(), status, startedAt: Date.now(), updatedAt: Date.now() })); }
  process.stdout.write('agent ' + slot + ' working ' + Date.now() + '\\r\\n');
};
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', (d) => fs.appendFileSync(path.join(${JSON.stringify(ctl)}, 'typed-' + slot), d.toString()));
tick(); setInterval(tick, 250);
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { claude: { command: `exec ${path.join(bin, 'claude')}`, label: 'Claude' } } }));
fs.writeFileSync(path.join(state, 'workspace-ui.json'), JSON.stringify({ 'synapse-group': 'status' }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLAUDE_HOME: claudeHome, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win, gui, failed = false;
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
// the GUI frame is looked up on each call (a reload replaces it), and a call to a frame going away gives up
const ui = (code) => { const f = win.webContents.mainFrame.frames.find((x) => x.url.includes('?desktop=1')) || gui; return Promise.race([f.executeJavaScript(code, true), sleep(3000).then(() => { throw new Error('frame did not answer'); })]); };
const native = (code) => win.webContents.executeJavaScript(code, true);
const pidOf = (slot) => fs.readFileSync(path.join(ctl, `slot-${slot}`), 'utf8').trim();
const set = (slot, status) => fs.writeFileSync(path.join(ctl, `state-${slot}`), status);

const typed = () => { try { return fs.readFileSync(path.join(ctl, 'typed-0'), 'utf8'); } catch { return ''; } };
const send = (text) => ui(`(() => { const i = document.querySelector('#message-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); })()`);
const queue = () => ui(`[...document.querySelectorAll('#prompt-queue .queued-text')].map((e) => e.textContent)`);
const key = (k) => ui(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', metaKey: true, bubbles: true }))`);
const rows = () => ui(`[...document.querySelectorAll('#todo-list .todo-row')].map((r) => ({ id: r.dataset.todo, text: r.querySelector('.todo-text').textContent, done: r.classList.contains('done'), agent: (r.closest('.todo-group')?.querySelector('button.todo-group-head .todo-group-name') || r.querySelector('.todo-who > span:last-child'))?.textContent || null, linear: r.querySelector('.todo-linear')?.textContent || null }))`);
const todosFile = () => { try { return JSON.parse(fs.readFileSync(path.join(state, 'todos.json'), 'utf8')); } catch { return []; } };

// a stand-in for Linear
const issues = [{ id: 'i1', identifier: 'ENG-7', title: 'Fix the flaky login', url: 'https://linear.app/x/issue/ENG-7', team: { id: 'T1' }, state: 'started' }];
const linear = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const { query, variables } = JSON.parse(raw), send = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.headers.authorization !== 'lin_test_key') return send({ errors: [{ message: 'Authentication required' }] });
  if (query.includes('teams(first')) return send({ data: { viewer: { id: 'me', name: 'Test' }, teams: { nodes: [{ id: 'T1', name: 'Eng', key: 'ENG' }] } } });
  if (query.includes('assignedIssues')) return send({ data: { viewer: { assignedIssues: { nodes: issues.filter((i) => i.state !== 'completed') } } } });
  if (query.includes('issues(first')) return send({ data: { issues: { nodes: issues.filter((i) => variables.ids.includes(i.id)).map((i) => ({ ...i, state: { type: i.state } })) } } });
  if (query.includes('team(id')) return send({ data: { team: { states: { nodes: [{ id: 'S-done', type: 'completed', position: 2 }, { id: 'S-todo', type: 'unstarted', position: 1 }] } } } });
  if (query.includes('issueUpdate')) { issues.find((i) => i.id === variables.id).state = variables.state === 'S-done' ? 'completed' : 'unstarted'; return send({ data: { issueUpdate: { success: true } } }); }
  send({ errors: [{ message: 'unknown' }] });
});

(async () => {
  await new Promise((r) => linear.listen(0, '127.0.0.1', r));
  process.env.SYNAPSE_LINEAR_URL = `http://127.0.0.1:${linear.address().port}/graphql`;
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Claude').click()`);
  await until(() => fs.existsSync(path.join(ctl, 'slot-0')), 'agent started');
  set(0, 'idle');
  await until(() => ui(`[...document.querySelectorAll('#project-list .session-row')].some((r) => r.dataset.state !== 'working' && r.dataset.state !== 'ended')`), 'agent listed');
  await until(() => ui(`!!document.querySelector('#project-list .session-row[data-agent^="desktop-"]') && location.hash.includes('desktop-')`).catch(() => false), 'agent merged', 20000).catch(() => {});

  // the Todos page: add one linked to the agent
  await ui(`document.getElementById('todos-nav').click()`);
  await until(() => ui(`!document.getElementById('todos-view').hidden`), 'Todos page');
  await ui(`document.getElementById('todo-agent-pick').click()`);
  await until(() => ui(`document.querySelectorAll('.pop-menu button').length > 1`), 'agent picker');
  const agentName = await ui(`document.querySelectorAll('.pop-menu button')[1].querySelector(':scope > span:not(.agent-avatar)').firstChild.textContent`);
  await ui(`document.querySelectorAll('.pop-menu button')[1].click()`);
  await ui(`(() => { const i = document.getElementById('todo-input'); i.value = 'Write the docs'; document.getElementById('todo-add').requestSubmit(); })()`);
  await until(async () => (await rows()).some((r) => r.text === 'Write the docs' && r.agent), 'added, linked to the agent');
  const linked = todosFile()[0].agent;
  assert.ok(linked?.id, 'linked by id');

  // an agent adds one through the CLI, linked to the same agent: it shows up
  // (by its session id once Synapse has matched the new session; until then the agent is not listed for the CLI)
  await until(() => { const id = todosFile()[0].agent.id; try { execFileSync('node', [path.join(root, 'cli.mjs'), 'todo', 'add', 'Fix', 'the', 'tests', '--agent', id], { env: process.env, stdio: 'pipe' }); return true; } catch { return false; } }, 'the CLI adds a todo for the agent');
  await until(async () => (await rows()).some((r) => r.text === 'Fix the tests' && r.agent), 'an agent added a todo');
  assert.equal(await ui(`document.getElementById('todo-count').textContent`), '2');
  if (process.env.TODO_PAGE_SHOT) { // through CDP: capturePage is blank while the window is covered
    await ui(`document.querySelector('[data-todo-pick-clear]')?.click()`); await sleep(100);
    await ui(`(() => { const i = document.getElementById('todo-input'); i.value = 'Ship the release'; document.getElementById('todo-add').requestSubmit(); })()`);
    await until(async () => (await rows()).some((r) => r.text === 'Ship the release'), 'an unlinked todo');
    await sleep(500); const d = win.webContents.debugger; d.attach('1.3');
    fs.writeFileSync(process.env.TODO_PAGE_SHOT, Buffer.from((await d.sendCommand('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await ui(`document.querySelector('.todo-row:last-of-type')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
    d.detach();
  }
  // tick one
  const docs = (await rows()).find((r) => r.text === 'Write the docs');
  await ui(`document.querySelector('[data-todo-check="${docs.id}"]').click()`);
  await until(() => todosFile().find((t) => t.id === docs.id)?.done === true, 'ticked');
  await until(async () => !(await rows()).some((r) => r.text === 'Write the docs'), 'done ones fold away');
  await ui(`document.querySelector('[data-todo-done-toggle]').click()`);
  await until(async () => (await rows()).some((r) => r.text === 'Write the docs' && r.done), 'shown under Done');
  console.log('PASS todos: added and linked on the Todos page, added by an agent, ticked, folded under Done');

  // the agent's panel lists its open todos
  await ui(`document.querySelector('[data-todo-agent]').click()`);
  await until(() => ui(`location.hash.startsWith('#agent=')`), 'the chip opens the agent');
  await ui(`if (document.getElementById('inspector').hidden) document.querySelector('[data-action="toggle-inspector"], #toggle-inspector')?.click()`);
  await until(() => ui(`!!document.querySelector('[data-inspector-tab="todos"]')`), 'panel tabs');
  await ui(`document.querySelector('[data-inspector-tab="todos"]').click()`);
  await until(() => ui(`[...document.querySelectorAll('.todo-tab > .todo-row .todo-text')].map((e) => e.textContent).join('|') === 'Fix the tests'`), 'the Todos tab shows its open todo', 10000);
  assert.equal(await ui(`document.querySelector('[data-inspector-tab="todos"] .tab-count')?.textContent`), '1', 'the tab counts open todos');
  // added on the tab: linked to this agent, and on the Todos page too
  await ui(`(() => { const i = document.querySelector('.todo-tab-add input'); i.value = 'Ship the tab'; i.form.requestSubmit(); })()`);
  await until(() => todosFile().some((t) => t.text === 'Ship the tab' && t.agent?.id), 'added from the tab, linked to the agent');
  await until(() => ui(`[...document.querySelectorAll('.todo-tab > .todo-row .todo-text')].some((e) => e.textContent === 'Ship the tab')`), 'shows on the tab');
  if (process.env.SHOT_DIR) { await sleep(500); fs.writeFileSync(path.join(process.env.SHOT_DIR, 'todos-tab.png'), (await win.webContents.capturePage()).toPNG()); }
  await ui(`document.getElementById('todos-nav').click()`);
  await until(() => rows().then((r) => r.some((x) => x.text === 'Ship the tab' && x.agent)), 'and on the Todos page, with its agent');
  await ui(`history.back()`);
  console.log('PASS agent panel: its open todos');

  // the agent ends: asked which todos are done
  process.kill(Number(pidOf(0)), 'SIGKILL');
  await until(() => ui(`document.getElementById('action-dialog').open && /ended/.test(document.getElementById('dialog-title').textContent)`), 'asked when the agent ended', 40000);
  assert.match(await ui(`document.getElementById('dialog-content').textContent`), /Fix the tests/);
  await ui(`document.getElementById('dialog-submit').click()`);
  await until(() => todosFile().every((t) => t.done), 'marked done from the question');
  console.log('PASS agent ended: asked which of its todos are done, and they are ticked');

  // Linear: connect with a key, its assigned issue comes in; ticking it moves the issue
  await ui(`location.hash = 'todos'`);
  await until(() => ui(`!!document.querySelector('[data-linear="connect"]')`), 'Connect Linear');
  await ui(`document.querySelector('[data-linear="connect"]').click()`);
  await until(() => ui(`!!document.getElementById('linear-key')`), 'key field');
  await ui(`document.getElementById('linear-key').value = 'lin_test_key'; document.getElementById('dialog-submit').click()`);
  await until(async () => (await rows()).some((r) => r.text === 'Fix the flaky login' && r.linear === 'ENG-7'), 'the assigned issue came in');
  assert.ok(!fs.readFileSync(path.join(state, 'todos.json'), 'utf8').includes('lin_test_key'));
  const issue = (await rows()).find((r) => r.linear === 'ENG-7');
  await ui(`document.querySelector('[data-todo-check="${issue.id}"]').click()`);
  await until(() => issues[0].state === 'completed', 'done in Linear too');
  console.log('PASS Linear: connected with a key, the assigned issue came in, ticking it finished it in Linear');
  if (process.env.TODO_SHOT) { await ui(`document.querySelector('[data-todo-done-toggle]')?.getAttribute('aria-expanded') === 'false' && document.querySelector('[data-todo-done-toggle]').click()`); await sleep(400); fs.writeFileSync(process.env.TODO_SHOT, (await win.webContents.capturePage()).toPNG()); }
  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|net::ERR/.test(e)), []);
})().catch(async (e) => {
  failed = true; console.error(e); console.error('page errors:', errors);
  if (win) fs.writeFileSync('/tmp/gui-todos.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => { linear.close(); app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit(); });
