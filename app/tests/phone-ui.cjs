// Real Electron flow for the phone link: settings shows a pairing QR code, a phone (the phone app's own
// protocol code against a local relay) pairs, shows up in settings, and starts an agent that opens a
// terminal here with its first prompt typed in.
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
  const { server } = await import(pathToFileURL(path.join(root, 'relay/relay.mjs')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.SYNAPSE_RELAY = `http://127.0.0.1:${server.address().port}`;
  const link = await import(pathToFileURL(path.join(root, 'mobile/src/link.js')));
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'window');
  await until(() => js(`document.querySelectorAll('.term').length === 1`), 'initial shell');

  await js(`document.querySelector('.login-link.skip')?.click()`); // no account needed to pair a phone
  await js(`document.querySelector('#settings').click()`);
  await until(() => js(`[...document.querySelectorAll('.phones .btn')].some((b) => b.textContent === 'pair a phone')`), 'phone section');
  await js(`[...document.querySelectorAll('.phones .btn')].find((b) => b.textContent === 'pair a phone').click()`);
  await until(() => js(`!!document.querySelector('.phone-qr svg')`), 'QR code');
  if (process.env.SYNAPSE_PHONE_SHOT) { win.show(); await js(`document.querySelector('.phone-qr').scrollIntoView()`); await sleep(800); fs.writeFileSync(process.env.SYNAPSE_PHONE_SHOT, (await win.webContents.capturePage()).toPNG()); }

  // the phone scans: the same URL the QR code holds
  const { url } = await js('synapse.phone.pair()');
  const me = await link.pair(link.parsePairing(url), 'Test iPhone');
  await until(() => js(`[...document.querySelectorAll('.phones .person .k')].some((e) => e.textContent === 'Test iPhone')`), 'paired phone listed');
  assert.ok(await js(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Test iPhone is paired'))`), 'pairing toast');

  const c = link.connect(me);
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

  console.log('PASS phone ui: QR in settings, phone paired and listed, agent started from the phone with its prompt');
  server.close();
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
