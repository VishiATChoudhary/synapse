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
  { const w = new (require('node:sqlite').DatabaseSync)(db); w.exec('PRAGMA journal_mode=WAL'); w.close(); } // as agy keeps it: readers never block its writes
  const lock = fs.openSync(path.join(home, 'presence', id + '.lock'), 'w'); // held while it runs
  process.stdout.write('> Type your message\\r\\n');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d.toString().replace(/\\x1b\\[20[01]~/g, '');
    let at; while ((at = buf.search(/[\\r\\n]/)) >= 0) {
      const line = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
      if (!line) continue;
      if (line === 'stream') { // the way the real one runs a turn: a tool call, its result, a pause, then the reply streamed into one row
        const { DatabaseSync } = require('node:sqlite');
        const wait = (ms) => new Promise((r) => setTimeout(r, ms)), past = () => Math.floor(Date.now() / 1000) - 60; // its steps' times: not ahead of the clock
        (async () => {
          writeStore(db, [userStep(line), modelStep('', [['run_command', { CommandLine: 'ls', toolSummary: 'List files' }]])], past());
          await wait(1500); writeStore(db, [resultStep()], past());
          await wait(2500); writeStore(db, [modelStep('Streaming', [], 8)], past());
          const sql = new DatabaseSync(db), row = sql.prepare('SELECT MAX(idx) AS i FROM steps').get().i;
          const put = sql.prepare('UPDATE steps SET status = ?, step_payload = ? WHERE idx = ?');
          let text = 'Streaming';
          for (let k = 0; k < 20; k++) { await wait(150); text += ' word' + k; put.run(8, modelStep(text).payload, row); fs.appendFileSync('/tmp/agy-standin.log', k + ' ' + Date.now() + '\\n'); }
          put.run(3, modelStep(text + ' done.').payload, row); sql.close();
        })().catch((e) => fs.appendFileSync('/tmp/agy-standin.log', e.stack + '\\n'));
        continue;
      }
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
  // a turn with a tool call and a streamed reply: working the whole way through, and the reply grows in one element
  await send('stream');
  const row = `[...document.querySelectorAll('.session-row')].find((r) => /antigravity/i.test(r.textContent))`;
  await until(() => ui(`!!${row}?.querySelector('.status-dot.busy')`), 'working once the turn starts', 15000);
  // its status is read first, then its conversation: a turn the conversation shows as open has to read as working
  let idle = 0, open = 0, swaps = 0, el = null;
  for (const end = Date.now() + 30000; Date.now() < end;) {
    const s = await ui(`(async () => {
      const a = (await (await fetch('/api/state')).json()).agents.find((x) => /conv-/.test(x.transcript || ''));
      const d = await (await fetch('/api/agents/' + a.id + '/recent?limit=60')).json();
      const at = d.messages.findLastIndex((m) => m.role === 'user' && m.text === 'stream'), last = d.messages.at(-1);
      const m = [...document.querySelectorAll('#message-list .message.assistant')].find((x) => x.textContent.includes('Streaming'));
      if (m && !m.__seen) m.__seen = (window.__agySeen = (window.__agySeen || 0) + 1);
      return { status: a.status, open: at >= 0 && !last.text.endsWith('done.'), el: m?.__seen || null, shown: !!m?.textContent.includes('word19 done.') };
    })()`);
    if (s.open) { open++; if (s.status !== 'busy') idle++; }
    if (s.el && el && s.el !== el) swaps++;
    if (s.el) el = s.el;
    if (s.shown) break;
    await sleep(100);
  }
  assert.ok(open > 10, `the turn was watched while open (${open} looks)`);
  assert.ok(await ui(`[...document.querySelectorAll('#message-list .message.assistant')].some((x) => x.textContent.includes('word19 done.'))`), 'the whole streamed reply shows');
  assert.equal(idle, 0, 'never reads as idle mid-turn');
  assert.equal(swaps, 0, 'the streamed reply is never rebuilt as a new element');
  await until(() => ui(`!${row}?.querySelector('.status-dot.busy')`), 'idle once the reply is done', 15000);
  console.log('PASS a turn with a tool call and a streamed reply stays working and grows in place');
  if (process.env.AGY_SHOT) { await sleep(800); fs.writeFileSync(process.env.AGY_SHOT, (await win.webContents.capturePage()).toPNG()); }
})().catch((e) => { console.error(e); failed = true; }).finally(() => app.exit(failed ? 1 : 0));
