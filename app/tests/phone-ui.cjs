// Real Electron flow for the phone link: a phone (the phone app's own protocol code) signs in to the same
// account on a local Synapse Cloud, Synapse asks in settings, the phone is allowed there, and it starts an
// agent that opens a terminal here with its first prompt typed in.
const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
if (typeof electron === 'string') {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-phone-ui-')));
  const result = spawnSync(electron, [__filename], { env: { ...process.env, SYNAPSE_PHONE_FIXTURE: fixture }, stdio: 'inherit' });
  fs.rmSync(fixture, { recursive: true, force: true }); process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = electron;
const fixture = process.env.SYNAPSE_PHONE_FIXTURE;
const root = path.resolve(__dirname, '../..'), state = path.join(fixture, 'state'), repo = path.join(fixture, 'repo');
for (const dir of [state, repo]) fs.mkdirSync(dir);
execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
Object.assign(process.env, { SYNAPSE_HOME: state, SUPERSET_HOME: path.join(fixture, 'superset'), SHELL: '/bin/sh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG') delete process.env[key];
// "claude" writes what it is sent to a file here, so the test never starts a real agent
const typed = path.join(fixture, 'typed.txt');
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ autoSymlink: false, workspaces: [repo], profiles: { shell: { command: 'cat', label: 'Shell' }, claude: { command: `cat > ${typed}`, label: 'Claude Code' } } }));
process.chdir(repo); app.setPath('userData', path.join(fixture, 'electron'));
let win;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await sleep(100); } throw new Error(`Timed out: ${label}`); }
const js = (code) => win.webContents.executeJavaScript(code, true);
(async () => {
  const { startCloud } = await import(pathToFileURL(path.join(__dirname, 'cloud-fixture.mjs')));
  const cloud = await startCloud();
  process.env.SYNAPSE_CLOUD = cloud.base;
  const owner = await cloud.signup('owner@example.com', 'Owner');
  fs.writeFileSync(path.join(state, 'account.json'), JSON.stringify({ cloud: cloud.base, token: owner.token, user: owner.user }));
  const link = await import(pathToFileURL(path.join(root, 'mobile/src/link.js')));
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'window');
  await until(() => js(`document.querySelectorAll('.term').length === 1`), 'initial shell');

  const me = await link.signIn(cloud.base, { email: 'owner@example.com', password: 'correct horse' }, 'Test iPhone');
  const [mac] = await (async () => { let l = []; await until(async () => (l = await link.computers(me)).length, 'the Mac registers'); return l; })();
  const c = link.connect(me, mac);
  await c.send({ t: 'hello' });

  await js(`document.querySelector('#settings').click()`);
  // the open settings redraw by themselves when the phone turns up
  await until(() => js(`[...document.querySelectorAll('.phones .btn')].some((b) => b.textContent === 'allow')`), 'the phone asks in settings', 30000);
  if (process.env.SYNAPSE_PHONE_SHOT) { win.show(); await js(`document.querySelector('.phones').scrollIntoView()`); await sleep(800); fs.writeFileSync(process.env.SYNAPSE_PHONE_SHOT, (await win.webContents.capturePage()).toPNG()); }
  await js(`[...document.querySelectorAll('.phones .btn')].find((b) => b.textContent === 'allow').click()`);
  await until(() => js(`[...document.querySelectorAll('.phones .person .c')].some((e) => e.textContent.startsWith('allowed'))`), 'allowed in settings');

  await c.send({ t: 'hello' });
  const inbox = [];
  await until(async () => { inbox.push(...await c.poll()); return inbox.some((m) => m.t === 'state'); }, 'state on the phone');
  const st = inbox.find((m) => m.t === 'state');
  assert.equal(st.projects[0].worktrees[0].path, repo);
  assert.ok(st.kinds.includes('claude') && !st.kinds.includes('shell'));

  await js(`document.querySelector('#modal').hidden = true`);
  await c.send({ t: 'spawn', req: 'ui1', cwd: repo, kind: 'claude', prompt: 'hello from the phone' });
  await until(() => js(`document.querySelectorAll('.term').length === 2`), 'a terminal opens for the phone');
  await until(() => fs.existsSync(typed) && fs.readFileSync(typed, 'utf8').includes('hello from the phone'), 'first prompt typed in and sent', 25000);

  console.log('PASS phone ui: phone signs in, Synapse asks in settings, allowed, agent started from the phone with its prompt');
  cloud.stop();
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
