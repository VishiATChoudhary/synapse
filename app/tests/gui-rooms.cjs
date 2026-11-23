// Real Electron test: the bottom bar has no todos, account or connections buttons; an agent's panel has "Add to a
// room", which makes a room with it; the room's agent picker groups agents by project.
// (setup shared with gui-queue.cjs)
// Real Electron test for queued prompts. A stand-in "claude" takes its state from a control file and records what is
// typed into it. Prompts sent while it works (or waits on a question) wait in the GUI and go in one at a time, in
// order, once it is free; nothing reaches its terminal while it is busy. Edit, remove and Send now work on the queue.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-queue.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-queue-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), claudeHome = path.join(fixture, 'claude'), ctl = path.join(fixture, 'ctl');
for (const d of [state, bin, ctl, path.join(claudeHome, 'sessions')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
let slot = 0; for (;; slot++) { try { fs.writeFileSync(path.join(${JSON.stringify(ctl)}, 'slot-' + slot), String(process.pid), { flag: 'wx' }); break; } catch {} }
const file = path.join(${JSON.stringify(path.join(claudeHome, 'sessions'))}, process.pid + '.json');
const control = path.join(${JSON.stringify(ctl)}, 'state-' + slot);
let status = '';
const sid = 'tm-' + process.pid, proj = path.join(${JSON.stringify(path.join(claudeHome, 'projects', 'x'))});
fs.mkdirSync(proj, { recursive: true });
const line = (type, content, i) => JSON.stringify({ type, uuid: 'u' + i, timestamp: new Date(Date.now() - 60000 + i * 1000).toISOString(), cwd: process.cwd(), sessionId: sid, message: { role: type, content } });
fs.writeFileSync(path.join(proj, sid + '.jsonl'), [
  line('user', 'Check the browser fallback', 0),
  line('assistant', [{ type: 'text', text: 'Asked the platform session to do it.' }], 1),
  line('user', 'Another Claude session sent a message:\\n<teammate-message teammate_id="platform-opensb" color="blue" summary="Start-failure fallback added; Agent37 live smoke passed">\\nBoth follow-ups are done and nothing is committed.\\n</teammate-message>', 2),
  line('assistant', [{ type: 'text', text: 'Noted, thanks.' }], 3),
].join('\\n') + '\\n');
const tick = () => {
  let want = 'idle'; try { want = fs.readFileSync(control, 'utf8').trim() || 'busy'; } catch {}
  if (want !== status) { status = want; fs.writeFileSync(file, JSON.stringify({ sessionId: sid, pid: process.pid, cwd: process.cwd(), status, startedAt: Date.now(), updatedAt: Date.now() })); }
  process.stdout.write('agent ' + slot + ' working ' + Date.now() + '\\r\\n');
};
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', (d) => fs.appendFileSync(path.join(${JSON.stringify(ctl)}, 'typed-' + slot), d.toString()));
tick(); setInterval(tick, 250);
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);
const projA = path.join(fixture, 'alpha'), projB = path.join(fixture, 'beta'); for (const d of [projA, projB]) fs.mkdirSync(d);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [projA, projB], skipLogin: true, profiles: { claude: { command: `exec ${path.join(bin, 'claude')}`, label: 'Claude' } } }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLAUDE_HOME: claudeHome, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(projA);
app.setPath('userData', path.join(fixture, 'electron'));
let win, gui, failed = false;
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const ui = (code) => gui.executeJavaScript(code, true);
const native = (code) => win.webContents.executeJavaScript(code, true);
const pidOf = (slot) => fs.readFileSync(path.join(ctl, `slot-${slot}`), 'utf8').trim();
const set = (slot, status) => fs.writeFileSync(path.join(ctl, `state-${slot}`), status);


(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => ui(`!!document.querySelector('#desktop-settings')`), 'GUI ready');
  assert.deepEqual(await ui(`['todos-nav', 'desktop-account'].map((id) => getComputedStyle(document.getElementById(id)).display).concat(getComputedStyle(document.querySelector('[data-view="connections"]')).display)`), ['none', 'none', 'none']);
  const claude = path.join(bin, 'claude');
  for (const cwd of [projA, projB]) await native(`synapse.pty.spawn({ cwd: ${JSON.stringify(cwd)}, kind: 'claude', command: ${JSON.stringify(`exec ${claude}`)}, cols: 80, rows: 24 })`);
  await until(() => fs.existsSync(path.join(ctl, 'slot-1')), 'two agents');
  await until(async () => (await ui(`document.querySelectorAll('.session-row').length`)) >= 2, 'both in the sidebar', 40000);
  await until(async () => { await ui(`[...document.querySelectorAll('.session-row')].find((r) => /alpha/.test(r.textContent))?.click()`); return ui(`!!document.querySelector('[data-add-to-room]')`); }, 'Add to a room in the panel', 40000).catch(async (e) => { console.error(await ui(`document.getElementById('inspector')?.innerText.slice(0, 600)`)); throw e; });
  assert.equal(await ui(`[...document.querySelectorAll('.inspector-label')].some((h) => h.textContent === 'Connected agents')`), false, 'no empty connections section');
  assert.equal(await ui(`[...document.querySelectorAll('[data-inspector-tab]')].map((b) => b.dataset.inspectorTab).join()`), 'details,browser');
  await ui(`document.querySelector('[data-add-to-room]').click()`);
  await until(() => ui(`!!document.getElementById('room-new-name')`), 'the room dialog');
  await ui(`document.getElementById('room-new-name').value = 'launch'; document.getElementById('dialog-submit').click()`);
  await until(() => ui(`[...document.querySelectorAll('.room-chip')].some((c) => c.textContent.includes('launch'))`), 'the panel shows the room', 20000);
  if (process.env.ROOMS_SHOT) fs.writeFileSync(`${process.env.ROOMS_SHOT}-panel.png`, (await win.webContents.capturePage()).toPNG());
  await ui(`document.querySelector('.room-chip').click()`);
  await until(() => ui(`!!document.querySelector('[data-room-add-agent]')`), 'the room');
  await ui(`document.querySelector('[data-room-add-agent]').click()`);
  await until(() => ui(`!!document.querySelector('.room-picker')`), 'the picker');
  assert.deepEqual(await ui(`[...document.querySelectorAll('.room-picker-group h4')].map((h) => h.firstChild.textContent)`), ['beta']);
  if (process.env.ROOMS_SHOT) await new Promise((r) => setTimeout(r, 600)), fs.writeFileSync(`${process.env.ROOMS_SHOT}-picker.png`, (await win.webContents.capturePage()).toPNG());
  await ui(`document.querySelector('.room-picker input').click(); document.getElementById('dialog-submit').click()`);
  await until(() => ui(`document.querySelectorAll('.room-agent').length === 2`), 'both agents in the room', 20000);
  assert.deepEqual(errors.filter((e) => !/Autofill|favicon/i.test(e)), []);
  if (process.env.ROOMS_SHOT) { await new Promise((r) => setTimeout(r, 600)); fs.writeFileSync(`${process.env.ROOMS_SHOT}-room.png`, (await win.webContents.capturePage()).toPNG()); }
  console.log('gui-rooms: ok');
})().catch((e) => { failed = true; console.error(e); }).finally(() => { fs.rmSync(fixture, { recursive: true, force: true }); app.exit(failed ? 1 : 0); });
