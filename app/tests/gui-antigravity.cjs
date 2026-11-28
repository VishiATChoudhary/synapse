// Real Electron test: Antigravity. A stand-in agy (a program named agy that keeps its conversation the way the real
// one does: SQLite of protobuf steps, holding presence/<id>.lock while it runs) started from the GUI shows up as an
// Antigravity session with its chat: your prompt, its reply and its tool calls; a prompt sent from the GUI reaches
// it and the answer shows; while a turn is under way it reads as working.
// Run: SYNAPSE_APP_PORT=<free port> ./node_modules/.bin/electron tests/gui-antigravity.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-agy-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), proj = path.join(fixture, 'proj');
for (const d of [state, bin, proj]) fs.mkdirSync(d, { recursive: true });
const store = pathToFileURL(path.join(root, 'test/fixtures/agy-store.mjs')).href;
// the stand-in: one conversation, a lock held for it; each line typed in becomes a prompt step, then a reply
fs.writeFileSync(path.join(bin, 'agy'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
(async () => {
  const { writeStore, userStep, modelStep, resultStep } = await import(${JSON.stringify(store)});
  const home = path.join(process.env.HOME, '.gemini', 'antigravity-cli'), id = 'conv-' + process.pid;
  for (const d of ['presence', 'conversations']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const db = path.join(home, 'conversations', id + '.db');
  writeStore(db, [userStep('check the training pipelines'), modelStep('', [['run_command', { CommandLine: 'git status -s', toolSummary: 'Workspace status' }]]), resultStep(), modelStep('The pipelines look **fine**.')]);
  const lock = fs.openSync(path.join(home, 'presence', id + '.lock'), 'w'); // held while it runs
  process.stdout.write('> Type your message\\r\\n');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d.toString().replace(/\\x1b\\[20[01]~/g, '');
    let at; while ((at = buf.search(/[\\r\\n]/)) >= 0) {
      const line = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
      if (!line) continue;
      writeStore(db, [userStep(line), modelStep('', [], 2)]); // a turn under way
      setTimeout(() => writeStore(db, [modelStep('Answer to: ' + line)]), 2500);
    }
  });
})();
`, { mode: 0o755 });
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [proj], skipLogin: true, profiles: { antigravity: { command: `exec ${path.join(bin, 'agy')}`, label: 'Antigravity' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/zsh', HOME: fixture });
process.chdir(fixture); app.setPath('userData', path.join(fixture, 'electron'));
let win, gui, failed = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 30000) { const d = Date.now() + ms; while (Date.now() < d) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(200); } throw new Error(`Timed out: ${label}`); }
const ui = (code) => gui.executeJavaScript(code, true);
const native = (code) => win.webContents.executeJavaScript(code, true);
const send = (text) => ui(`(() => { const i = document.querySelector('#message-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); })()`);
const thread = () => ui(`document.getElementById('message-list').textContent`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'window'); win.setBounds({ width: 1400, height: 950 }); win.show();
  await until(() => (gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1'))), 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim().endsWith('Antigravity'))`), 'Antigravity launcher');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim().endsWith('Antigravity')).click()`);

  await until(async () => { await ui(`[...document.querySelectorAll('.session-row')].find((r) => /antigravity/i.test(r.textContent))?.click()`); return (await thread()).includes('The pipelines look fine'); }, 'its chat shows', 45000);
  const t = await thread();
  assert.ok(t.includes('check the training pipelines'), 'your prompt');
  assert.ok(await ui(`[...document.querySelectorAll('#message-list strong')].some((s) => s.textContent === 'fine')`), 'its reply, as markdown');
  console.log('PASS an Antigravity session shows its chat: your prompt and its reply');
  assert.ok(await ui(`[...document.querySelectorAll('#message-list .tool-verb, #message-list summary')].some((e) => /Ran|Worked/.test(e.textContent))`), 'its tool call');
  console.log('PASS its tool calls show as steps');

  await send('and the eval?');
  await until(async () => /Working|working/.test(await ui(`document.body.textContent`)), 'it reads as working while the turn runs', 15000);
  await until(async () => (await thread()).includes('Answer to: and the eval?'), 'the answer to a prompt from the GUI', 30000);
  console.log('PASS a prompt from the GUI reaches it, it works, and its answer shows');
  await until(() => ui(`[...document.querySelectorAll('#message-list .message.user')].filter((m) => m.textContent.includes('and the eval?')).length === 1`), 'your prompt shows once, not twice');
  if (process.env.AGY_SHOT) { await sleep(800); fs.writeFileSync(process.env.AGY_SHOT, (await win.webContents.capturePage()).toPNG()); }
})().catch((e) => { console.error(e); failed = true; }).finally(() => app.exit(failed ? 1 : 0));
