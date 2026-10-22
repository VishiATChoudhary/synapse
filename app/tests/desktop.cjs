// Runs real PTYs and both renderers in an isolated Electron app. No agent credentials are used.
const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

if (typeof electron === 'string') {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-desktop-'));
  const result = spawnSync(electron, [__filename], { env: { ...process.env, SYNAPSE_DESKTOP_FIXTURE: fixture }, stdio: 'inherit' });
  fs.rmSync(fixture, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = electron;
const fixture = process.env.SYNAPSE_DESKTOP_FIXTURE;
assert.ok(fixture);
const root = path.resolve(__dirname, '../..'), state = path.join(fixture, 'state'), repo = path.join(fixture, 'sample-project');
fs.mkdirSync(state); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, '-c', 'user.name=Desktop Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [repo], autoSymlink: false, skipLogin: true,
  profiles: { shell: { command: '/bin/cat', label: 'Shell' }, claude: { command: '/bin/cat', label: 'Fixture agent' } } }));
const userHome = path.join(fixture, 'user'), bin = path.join(fixture, 'bin');
fs.mkdirSync(bin); fs.mkdirSync(userHome);
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$2" = get ]; then exit 1; fi\nexit 0\n', { mode: 0o755 });
fs.mkdirSync(path.join(userHome, '.gemini'));
fs.writeFileSync(path.join(userHome, '.gemini', 'settings.json'), '{"theme":"fixture"}\n');
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_USER_HOME: userHome, CODEX_HOME: path.join(userHome, '.codex'),
  SYNAPSE_DEMO: '1', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/sh', SUPERSET_HOME: path.join(fixture, 'superset'), PATH: `${bin}:${process.env.PATH}` });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG') delete process.env[key];
process.argv.push('--demo');
process.chdir(repo);
app.setPath('userData', path.join(fixture, 'electron'));
let win, gui, failed = false;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(40); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const page = (code) => gui.executeJavaScript(code, true);
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const tap = (selector) => page(`document.querySelector(${JSON.stringify(selector)}).click()`);
const rpc = (action, args = {}) => page(`new Promise((resolve, reject) => {
  const request = 'test-' + crypto.randomUUID();
  const listener = (e) => { if (e.source !== parent || e.data?.request !== request) return;
    removeEventListener('message', listener); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.value); };
  addEventListener('message', listener);
  parent.postMessage({ type: 'synapse:desktop-call', request, action: ${JSON.stringify(action)}, args: ${JSON.stringify(args)} }, '*');
})`);
const choose = (id) => tap(`[data-agent="${id}"]`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'native window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  await until(() => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => page(`document.body?.classList.contains('desktop')`), 'desktop capabilities');
  await until(async () => (await rpc('state')).sessions.length === 5, 'demo fork stack');
  const initial = await rpc('state'), first = initial.sessions[0];
  assert.equal(await page('typeof window.synapse'), 'undefined', 'the local iframe has no native IPC');
  await choose(first.id);
  await until(() => page(`!document.querySelector('#thread-view').hidden`), 'conversation');

  const prompt = 'desktop parity: literal $HOME and `echo no-execution`';
  await page(`document.querySelector('#message-input').value = ${JSON.stringify(prompt)};
    document.querySelector('#message-input').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer').requestSubmit();`);
  await until(async () => (await rpc('output', { id: first.id })).terminal.includes(prompt), 'prompt reaches the original PTY');
  await until(() => page(`document.querySelector('#message-input').value === ''`), 'sent prompt clears composer');
  console.log('PASS GUI prompt reaches a real PTY; prompt text stays literal');

  await page(`document.querySelector('#message-input').value = 'Unsent draft'; document.querySelector('#message-input').dispatchEvent(new Event('input', { bubbles: true }));`);
  for (let i = 0; i < 4; i++) { await click('#mode-terminal'); await click('#mode-gui'); }
  assert.equal(await page(`document.querySelector('#message-input').value`), 'Unsent draft');
  let snapshot = await rpc('state');
  assert.equal(snapshot.sessions.length, initial.sessions.length);
  assert.equal(snapshot.sessions.find((s) => s.id === first.id).pid, first.pid);
  process.kill(first.pid, 0);
  assert.ok((await rpc('output', { id: first.id })).terminal.includes(prompt));
  console.log('PASS mode switching preserves PID, output, drafts, and session count');

  await tap('#connect-agent');
  await page(`document.querySelector('#agent-kind').value = 'claude'; document.querySelector('#action-form').requestSubmit();`);
  await until(async () => (await rpc('state')).sessions.length === 6, 'GUI session launcher');
  await until(() => page(`!document.querySelector('#action-dialog').open`), 'launcher completion');
  snapshot = await rpc('state');
  const added = snapshot.sessions.find((s) => !initial.sessions.some((old) => old.id === s.id));
  assert.equal(added.kind, 'claude');
  process.kill(added.pid, 0);
  console.log('PASS GUI launches a session in the selected project');

  await tap('#fork-session');
  await page(`document.querySelector('#fork-question').value = 'Explore the child branch'; document.querySelector('#action-form').requestSubmit();`);
  await until(async () => (await rpc('state')).sessions.length === 7, 'GUI fork');
  snapshot = await rpc('state');
  const child = snapshot.sessions.find((s) => s.parent === added.id);
  assert.ok(child, 'fork points to its original parent');
  assert.ok(snapshot.sessions.some((s) => s.id === added.id), 'parent remains live');
  console.log('PASS GUI fork retains the parent and records the child');

  await until(() => page(`!document.querySelector('#action-dialog').open`), 'fork completion');
  await tap('#session-menu'); await tap('[data-session-action="close"]');
  await until(async () => !(await rpc('state')).sessions.some((s) => s.id === child.id), 'close child');
  assert.ok((await rpc('state')).sessions.some((s) => s.id === added.id));
  await click('#desktop-settings');
  await until(() => js(`!document.querySelector('#modal').hidden && document.querySelector('#modal-title').textContent === 'settings'`), 'shared settings');
  await js(`document.querySelector('#modal').hidden = true`);
  console.log('PASS close is scoped to the chosen fork; desktop settings are reachable');

  await tap(`[data-create-worktree="${initial.projects[0].key}"]`);
  await until(() => js(`document.querySelector('#modal-title').textContent === 'open branch or worktree'`), 'worktree dialog');
  await click('#modal-body [data-mode="new"]');
  await js(`document.querySelector('#modal-body input').value = 'desktop-branch'; document.querySelector('#modal-body .btn.sig').click();`);
  await until(async () => (await rpc('state')).projects[0].worktrees.length === 2, 'worktree created from GUI');
  const checkout = (await rpc('state')).projects[0].worktrees.find((w) => w.branch === 'desktop-branch');
  assert.ok(checkout && fs.existsSync(checkout.path));
  console.log('PASS GUI creates a Git worktree and opens its terminal');

  const preview = await js('synapse.integrations.preview()');
  assert.ok(preview.includes('Dry run'));
  assert.ok(!fs.existsSync(path.join(userHome, '.codex', 'config.toml')));
  const installed = await js('synapse.integrations.install()');
  assert.ok(installed.includes('Done.'));
  const settings = JSON.parse(fs.readFileSync(path.join(userHome, '.gemini', 'settings.json')));
  assert.equal(settings.theme, 'fixture');
  assert.ok(fs.existsSync(path.join(userHome, '.gemini', 'settings.json.bak-synapse')));
  const runtime = settings.mcpServers.synapse.command;
  assert.match(execFileSync(runtime, ['--version'], { encoding: 'utf8' }), /^v\d/);
  console.log('PASS bundled integration setup preserves settings, backs up files, and runs without external Node');

  // A full-width screenshot exercises the actual packaged renderer, not a mockup.
  await choose(first.id);
  await choose('demo-api-auth');
  await sleep(300);
  assert.ok(await page(`document.querySelector('#breadcrumbs').textContent.includes('api-auth')`), 'a delayed terminal selection cannot replace a newer GUI selection');
  if (process.env.SYNAPSE_DESKTOP_SCREENSHOT) {
    await page(`if (document.documentElement.dataset.theme === 'night') document.querySelector('#theme-toggle').click(); document.querySelector('#message-input').value = ''; document.querySelector('#message-input').dispatchEvent(new Event('input', { bubbles: true }));`);
    await sleep(3000);
    fs.writeFileSync(process.env.SYNAPSE_DESKTOP_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  }
  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|404/.test(e)), [], 'renderer errors');
  console.log('PASS renderer completed without runtime errors');
})().catch((error) => { failed = true; console.error(error); }).finally(() => {
  app.once('will-quit', () => app.exit(failed ? 1 : 0));
  app.quit();
});
