// Real Electron test: the orchestrator. Turned on (here on a stand-in Gemini, so any agent kind works), it is pinned
// at the top of the GUI's session list, and its tools (through the app's local endpoint, as the MCP server calls it)
// list sessions, start one with a prompt, prompt it, open and delete a worktree and close a session. Only the
// orchestrator's own agent id is taken; the MCP server lists the tools only inside the orchestrator's folder.
// Run: SYNAPSE_APP_PORT=<free port> ./node_modules/.bin/electron tests/gui-orchestrator.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-orch-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), repo = path.join(fixture, 'proj'), log = path.join(fixture, 'log');
for (const d of [state, bin, repo]) fs.mkdirSync(d, { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n'); git('add', '.'); git('commit', '-qm', 'init');
// a stand-in Gemini: a prompt, then every line it reads goes to the log with the folder it runs in
fs.writeFileSync(path.join(bin, 'gemini'), `#!/bin/sh
printf '> Type your message\\r\\n'
while read line; do echo "$(pwd)|$line" >> ${JSON.stringify(log)}; done
`, { mode: 0o755 });
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [repo], skipLogin: true, safeWorktreeDelete: true, orchestrator: { on: true, kind: 'gemini' },
  profiles: { shell: { command: '', label: 'shell' }, gemini: { command: path.join(bin, 'gemini'), label: 'Gemini' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/sh', HOME: fixture });
process.chdir(fixture); app.setPath('userData', path.join(fixture, 'electron'));
let win; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 30000) { const d = Date.now() + ms; while (Date.now() < d) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(200); } throw new Error(`Timed out: ${label}`); }
const ui = (code) => { const f = win.webContents.mainFrame.frames.find((x) => x.url.includes('?desktop=1')); return f.executeJavaScript(code, true); };
const lines = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const orchFile = () => JSON.parse(fs.readFileSync(path.join(state, 'orchestrator.json'), 'utf8'));
async function act(action, args = {}, agent = orchFile().agent) {
  const { port, token } = orchFile();
  const res = await fetch(`http://127.0.0.1:${port}/act`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agent, action, args }) });
  const body = await res.json(); if (body.error) throw new Error(body.error); return body.value;
}
function mcpTools(cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(root, 'mcp.mjs')], { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PWD: cwd }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; const line = out.split('\n').find((l) => l.includes('"id":2')); if (line) { p.kill(); resolve(JSON.parse(line).result.tools.map((t) => t.name)); } });
    p.on('error', reject);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  });
}
(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'window'); win.setBounds({ width: 1300, height: 850 }); win.show();
  await until(() => win.webContents.mainFrame.frames.some((f) => f.url.includes('?desktop=1')), 'frame');

  await until(() => ui(`!!document.querySelector('.orchestrator-pin .session-row')`), 'the pinned orchestrator row');
  assert.equal(await ui(`document.getElementById('project-list').firstElementChild.classList.contains('orchestrator-pin')`), true);
  const pinned = await ui(`document.querySelector('.orchestrator-pin .session-row').dataset.agent`);
  assert.equal(await ui(`[...document.querySelectorAll('.project-group .session-row')].some((r) => r.dataset.agent === ${JSON.stringify(pinned)})`), false, 'the orchestrator is not listed under a project');
  console.log('PASS the orchestrator is pinned at the top of the sessions');
  assert.equal(fs.readFileSync(path.join(state, 'orchestrator', 'GEMINI.md'), 'utf8').includes('synapse_orch_sessions'), true);
  assert.equal(fs.existsSync(path.join(state, 'orchestrator', 'AGENTS.md')) && fs.existsSync(path.join(state, 'orchestrator', 'CLAUDE.md')), true);
  console.log('PASS its folder tells any agent the job (AGENTS.md, CLAUDE.md, GEMINI.md)');

  await until(() => orchFile().agent, 'the app knows which agent the orchestrator is', 40000);
  await assert.rejects(act('sessions', {}, 'someone-else'), /Only the Synapse orchestrator/);
  console.log('PASS another agent cannot use the orchestrator tools');

  const inOrch = await mcpTools(path.join(state, 'orchestrator')), elsewhere = await mcpTools(repo);
  assert.ok(inOrch.includes('synapse_orch_sessions') && inOrch.includes('synapse_orch_worktree_open'), inOrch.join(','));
  assert.ok(!elsewhere.some((t) => t.startsWith('synapse_orch_')), elsewhere.join(','));
  console.log('PASS the MCP server lists the orchestrator tools only for the orchestrator');

  const agents = (l) => l.sessions.filter((x) => x.kind !== 'shell'); // the first launch opens a shell too
  let list = await act('sessions');
  assert.equal(list.projects[0].project, 'proj'); assert.equal(agents(list).length, 0); assert.ok(list.agents.includes('gemini') && !list.agents.includes('shell'));
  const shown = await ui(`document.querySelector('.session-row[aria-current]')?.dataset.agent || ''`);
  const started = await act('start', { project: 'proj', kind: 'gemini', prompt: 'build the thing' });
  await until(() => lines().some((l) => l.startsWith(`${repo}|`) && l.includes('build the thing')), 'the new session got its first prompt', 30000);
  list = await act('sessions');
  assert.equal(agents(list).length, 1); assert.equal(agents(list)[0].id, started.id); assert.equal(agents(list)[0].cwd, repo);
  await sleep(1500);
  assert.equal(await ui(`document.querySelector('.session-row[aria-current]')?.dataset.agent || ''`), shown, 'starting a session does not take you away');
  console.log('PASS it starts a session with a first prompt, in the background');
  if (process.env.ORCH_SHOT) { await sleep(1500); fs.writeFileSync(process.env.ORCH_SHOT, (await win.webContents.capturePage()).toPNG()); }

  await act('prompt', { session: started.id, text: 'and test it' });
  await until(() => lines().some((l) => l.startsWith(`${repo}|`) && l.includes('and test it')), 'the prompt reached the session');
  console.log('PASS it prompts a session');

  const wt = await act('worktree-open', { project: 'proj', branch: 'feat-x', kind: 'gemini', prompt: 'work on x' });
  assert.equal(wt.created, true); assert.ok(fs.existsSync(wt.path));
  await until(() => lines().some((l) => l.startsWith(`${wt.path}|`) && l.includes('work on x')), 'a session started in the new worktree');
  list = await act('sessions');
  assert.ok(list.projects[0].worktrees.some((w) => w.branch === 'feat-x' && w.sessions === 1), JSON.stringify(list.projects));
  console.log('PASS it opens a worktree on a new branch and starts a session there');

  fs.writeFileSync(path.join(wt.path, 'new.txt'), 'unsaved\n');
  await assert.rejects(act('worktree-close', { project: 'proj', worktree: 'main' }), /main checkout/);
  const gone = await act('worktree-close', { project: 'proj', worktree: 'feat-x' });
  assert.equal(gone.closedSessions, 1); assert.ok(!fs.existsSync(wt.path));
  assert.match(git('log', 'feat-x', '--oneline', '-1'), /./); assert.ok(git('show', '--stat', 'feat-x').includes('new.txt'), 'safe deletion kept the change on the branch');
  console.log('PASS it deletes a worktree, its changes kept on the branch; never the main checkout');

  await act('close', { session: started.id });
  list = await act('sessions'); assert.equal(agents(list).length, 0);
  await assert.rejects(act('close', { session: 'Orchestrator' }), /No session matches|That is you/);
  console.log('PASS it closes a session, never itself');

  await win.webContents.executeJavaScript(`synapse.settings.set({ orchestrator: { on: false } })`);
  await win.webContents.executeJavaScript(`synapse.state()`); // the next state push carries it
  await until(() => ui(`!document.querySelector('.orchestrator-pin .session-row')`), 'the orchestrator is gone when turned off', 30000);
  await until(() => orchFile().agent === null, 'its tools stop working');
  await assert.rejects(act('sessions', {}, 'x'), /orchestrator is off/);
  console.log('PASS turning it off removes it and its tools');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
