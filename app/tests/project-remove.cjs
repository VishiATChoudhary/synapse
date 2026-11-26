// Removing a project from the GUI sidebar: it folds away in one motion and the projects below glide up once.
const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

if (typeof electron === 'string') {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-remove-')));
  const state = path.join(fixture, 'state'); fs.mkdirSync(state);
  const repos = ['alpha', 'beta', 'gamma'].map((name) => path.join(fixture, name));
  for (const repo of repos) {
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=GUI Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  }
  const wt = path.join(fixture, 'beta-feature');
  execFileSync('git', ['-C', repos[1], 'worktree', 'add', '-qb', 'beta-feature', wt]);
  fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [repos[0], repos[1], wt, repos[2]], autoSymlink: false, skipLogin: true, profiles: { shell: { command: 'cat', label: 'Shell' } } }));
  const session = (key) => ({ key, kind: 'shell', title: key, parent: null });
  fs.writeFileSync(path.join(state, 'sessions.json'), JSON.stringify({ version: 1, slots: [
    { worktree: repos[0], top: 0, focused: true, sessions: [session('a1')] },
    { worktree: repos[1], top: 0, sessions: [session('b1')] },
    { worktree: repos[1], top: 0, sessions: [session('b2')] },
    { worktree: wt, top: 0, sessions: [session('b3')] },
    { worktree: repos[2], top: 0, sessions: [session('c1')] },
  ] }));
  fs.writeFileSync(path.join(state, 'workspace-ui.json'), JSON.stringify({ 'synapse-mode': 'signal', 'synapse-inspector': 'closed' }));
  const result = spawnSync(electron, [__filename], { env: { ...process.env, SYNAPSE_GUI_FIXTURE: fixture }, stdio: 'inherit' });
  fs.rmSync(fixture, { recursive: true, force: true }); process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = electron;
const fixture = process.env.SYNAPSE_GUI_FIXTURE;
const state = path.join(fixture, 'state'), beta = path.join(fixture, 'beta');
for (const name of ['claude', 'codex', 'gh', 'user']) fs.mkdirSync(path.join(fixture, name), { recursive: true });
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_USER_DATA: path.join(fixture, 'electron'), SYNAPSE_USER_HOME: path.join(fixture, 'user'), SYNAPSE_DEMO: '1', SYNAPSE_DESKTOP_VIEW: 'gui', SYNAPSE_CLOUD: 'http://127.0.0.1:9', CLAUDE_CONFIG_DIR: path.join(fixture, 'claude'), CODEX_HOME: path.join(fixture, 'codex'), GH_CONFIG_DIR: path.join(fixture, 'gh'), SHELL: '/bin/sh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || ['SYNAPSE_DEBUG', 'GH_TOKEN', 'GITHUB_TOKEN'].includes(key)) delete process.env[key];
process.chdir(path.join(fixture, 'alpha'));
let win, gui;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ui = (code) => gui.executeJavaScript(code, true);
const native = (code) => win.webContents.executeJavaScript(code, true);
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(40); }
  throw new Error(`Timed out: ${label}`);
}
const rpc = (action, args = {}) => ui(`new Promise((resolve) => {
  const request = 'test-' + crypto.randomUUID();
  const receive = (e) => { if (e.source !== parent || e.data?.request !== request) return; removeEventListener('message', receive); resolve({ error: e.data.error, value: e.data.value }); };
  addEventListener('message', receive); parent.postMessage({ type: 'synapse:desktop-call', request, action: ${JSON.stringify(action)}, args: ${JSON.stringify(args)} }, '*');
})`).then((reply) => { if (reply.error) throw new Error(reply.error); return reply.value; });
const group = (key) => `.project-group[data-project-key=${JSON.stringify(key)}]`;

(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'window');
  win.setBounds({ width: 1400, height: 1000 }); win.show();
  await until(() => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => ui(`!!document.querySelector('[data-project-key$="/beta"] .session-row') && !!document.querySelector('[data-project-key$="/gamma"]')`), 'beta and gamma with sessions');
  await sleep(1500); // demo agents settle
  const gammaKey = await ui(`[...document.querySelectorAll('.project-group')].map((e) => e.dataset.projectKey).find((k) => k.endsWith('gamma'))`);
  // every frame: where the project below sits, and how many times the list changed shape
  await ui(`window.__frames = []; (function tick() { const g = document.querySelector(${JSON.stringify(group(gammaKey))}); const b = document.querySelector(${JSON.stringify(group(beta))});
    __frames.push({ t: performance.now(), gamma: g?.getBoundingClientRect().top, beta: b ? b.getBoundingClientRect().height : null, rows: b ? b.querySelectorAll('.session-row').length : 0 });
    if (!window.__stop) requestAnimationFrame(tick); })(); true`);
  await rpc('project-menu', { key: beta, x: 100, y: 100 });
  await native(`[...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Remove from sidebar').click()`);
  await until(() => native(`!!document.querySelector('#modal .btn.danger')`), 'confirm');
  await native(`document.querySelector('#modal .btn.danger').click()`);
  await until(() => ui(`!document.querySelector(${JSON.stringify(group(beta))})`), 'beta gone');
  await sleep(400);
  await ui('window.__stop = true');
  const frames = await ui('__frames');
  const start = frames[0].gamma, end = frames.at(-1).gamma;
  const moves = frames.slice(1).map((f, i) => f.gamma - frames[i].gamma).filter((d) => Math.abs(d) > 0.5);
  const jumps = moves.filter((d) => Math.abs(d) > (start - end) * 0.4);
  console.log(`gamma ${start.toFixed(0)} -> ${end.toFixed(0)}px over ${moves.length} frames; biggest step ${Math.max(...moves.map(Math.abs)).toFixed(1)}px; up only: ${moves.every((d) => d < 0)}`);
  const moving = frames.filter((f, i) => i && Math.abs(f.gamma - frames[i - 1].gamma) > 0.5); console.log(`moving frames at ms: ${moving.map((f) => Math.round(f.t - moving[0].t)).join(",")}`);
  assert.ok(start - end > 40, 'the project below moved up');
  assert.ok(moves.every((d) => d < 0), 'it only ever moved up, never back');
  assert.equal(jumps.length, 0, 'no single frame jump');
  assert.ok(moves.length >= 6, 'it glided over several frames');
  console.log('PASS removing a project folds it away in one smooth motion');
})().then(() => app.exit(0), (e) => { console.error(e); app.exit(1); });
