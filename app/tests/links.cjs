// Real Electron test for links in the GUI. Two stand-in "codex" agents (node scripts by that name) write a Codex
// rollout whose reply names files and a web page. Paths that exist become links that open the file in the
// right-hand pane at the named line; a web link goes to the default browser (shell.openExternal, stubbed here).
// In the composer, @ lists your other agents (this project first) and sending connects the tagged one both ways.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/links.cjs
const electron = require('electron');
const { app, BrowserWindow } = electron;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-links-ui-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), codexHome = path.join(fixture, 'codex');
fs.mkdirSync(state); fs.mkdirSync(bin); fs.mkdirSync(path.join(fixture, 'src'));
fs.writeFileSync(path.join(fixture, 'notes.md'), '# Notes\nsecond line\nthird line\n');
fs.writeFileSync(path.join(fixture, 'src', 'app.js'), 'console.log(1);\n');
fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const pad = (n) => String(n).padStart(2, '0'), d = new Date(), id = String(process.pid).padStart(12, '0');
const dir = path.join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
const file = path.join(dir, \`rollout-\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}T\${pad(d.getHours())}-\${pad(d.getMinutes())}-\${pad(d.getSeconds())}-0199aaaa-bbbb-7ccc-8ddd-\${id}.jsonl\`);
const line = (o) => fs.appendFileSync(file, JSON.stringify(o) + '\\n');
fs.mkdirSync(dir, { recursive: true });
line({ type: 'session_meta', payload: { cwd: process.cwd() } });
line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what changed?' }] } });
line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Updated notes.md:2 and \`src/app.js\`, not v1.2.3. Docs: https://example.com/guide.' }] } });
line({ type: 'event_msg', payload: { type: 'task_complete' } });
setInterval(() => {}, 1 << 30);
`);
fs.chmodSync(path.join(bin, 'codex'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { shell: { command: 'cat', label: 'Shell' }, codex: { command: `exec ${path.join(bin, 'codex')}`, label: 'Codex' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, CODEX_HOME: codexHome, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO' || key === 'SYNAPSE_FAKE_REQUESTS') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
const opened = [];
electron.shell.openExternal = async (url) => { opened.push(url); };
let win, gui;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.race([Promise.resolve().then(check), sleep(5000).then(() => false)]).catch(() => false)) return; await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const ui = (code) => gui.executeJavaScript(code, true);
const shot = async (name) => { if (process.env.LINKS_SHOTS) fs.writeFileSync(path.join(process.env.LINKS_SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show();
  await until(() => js(`!!document.querySelector('#launch .launch-item')`), 'the launcher');
  for (let i = 0; i < 2; i++) {
    await js(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Codex').click()`);
    await sleep(1500);
  }

  // the GUI, through Settings > view
  await js(`document.querySelector('#settings').click()`);
  await until(() => js(`!!document.querySelector('#modal .view-seg')`), 'view in settings');
  await js(`document.querySelector('#modal .view-seg [data-view="gui"]').click()`);
  await until(() => js(`!document.querySelector('#desktop-workspace').hidden`), 'the GUI is shown');
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame', 30000);
  const desk = () => ui(`new Promise((ok) => { const request = 'state-' + Math.random(); addEventListener('message', (e) => { if (e.data?.request === request) ok(e.data.value?.sessions || []); }); parent.postMessage({ type: 'synapse:desktop-call', request, action: 'state', args: {} }, '*'); setTimeout(() => ok([]), 3000); })`);
  await until(async () => (await desk()).filter((x) => x.kind === 'codex' && x.backendId).length === 2, 'both codex sessions found their transcripts', 30000);
  const codex = (await desk()).filter((x) => x.kind === 'codex').map((x) => x.id);
  await until(() => ui(`!!document.querySelector('#sidebar [data-agent="${codex[0]}"]')`), 'the codex in the sidebar');
  await ui(`document.querySelector('#sidebar [data-agent="${codex[0]}"]').click()`);

  // paths that exist become links, the version number does not; the web address is a link
  await until(() => ui(`document.querySelectorAll('.message-body .file-link').length >= 2`), 'file links in the reply', 20000);
  assert.deepEqual(await ui(`[...document.querySelectorAll('.message-body .file-link')].map((l) => l.dataset.file)`), ['notes.md:2', 'src/app.js']);
  assert.doesNotMatch(await ui(`[...document.querySelectorAll('.message-body .file-link')].map((l) => l.textContent).join()`), /1\.2\.3/);
  assert.equal(await ui(`document.querySelector('.message-body a[href="https://example.com/guide"]').target`), '_blank');

  // a file opens in the right-hand pane at its line
  await ui(`document.querySelector('.message-body .file-link').click()`);
  await until(() => ui(`!document.querySelector('#inspector').hidden && document.querySelector('#inspector').classList.contains('file-mode') && !!document.querySelector('.file-line.hit')`), 'notes.md in the pane');
  assert.equal(await ui(`document.querySelector('.file-title h2').textContent`), 'notes.md');
  assert.equal(await ui(`document.querySelector('.file-line.hit code').textContent`), 'second line');
  await shot('file-pane');
  await ui(`document.querySelectorAll('.message-body .file-link')[1].click()`);
  await until(() => ui(`document.querySelector('.file-title h2')?.textContent === 'app.js'`), 'app.js in the pane');
  await ui(`document.querySelector('[data-file-act="back"]').click()`);
  await until(() => ui(`document.querySelector('.file-title h2')?.textContent === 'notes.md'`), 'back to notes.md');
  await ui(`document.querySelector('[data-file-act="details"]').click()`);
  await until(() => ui(`/Session details/.test(document.querySelector('#inspector').textContent)`), 'back to the session details');

  // a web link goes to the default browser
  await ui(`document.querySelector('.message-body a[href="https://example.com/guide"]').click()`);
  await until(async () => opened.includes('https://example.com/guide'), 'opened in the browser');

  // Up in an empty composer brings back the last prompt, Down goes back to the empty draft
  const key = (k) => ui(`document.querySelector('#message-input').dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true, cancelable: true }))`);
  await ui(`(() => { const i = document.querySelector('#message-input'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
  await key('ArrowUp');
  assert.equal(await ui(`document.querySelector('#message-input').value`), 'what changed?');
  await key('ArrowDown');
  assert.equal(await ui(`document.querySelector('#message-input').value`), '');

  // @ lists the other codex in this project; sending connects the two
  await ui(`(() => { const i = document.querySelector('#message-input'); i.focus(); i.value = 'ask @'; i.setSelectionRange(5, 5); i.dispatchEvent(new Event('input')); })()`);
  await until(() => ui(`!document.querySelector('#mention-pop').hidden`), 'agents to tag');
  assert.match(await ui(`document.querySelector('#mention-pop').textContent`), /Agents in this project/);
  await shot('mention-pop');
  await ui(`document.querySelector('#message-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  const value = await ui(`document.querySelector('#message-input').value`);
  assert.match(value, /^ask @[\w-]+ $/, 'Enter picks the agent');
  assert.equal(await ui(`document.querySelector('.composer-mirror mark.mention.agent')?.textContent`), value.trim().slice(4));
  await until(() => ui(`/Sending connects/.test(document.querySelector('#mention-bar').textContent)`), 'the bar says sending connects them');
  const edges = () => ui(`fetch('/api/state').then((r) => r.json()).then((s) => s.edges.length)`);
  assert.equal(await edges(), 0);
  await ui(`(() => { const i = document.querySelector('#message-input'); i.value = '${value}look at this'; i.dispatchEvent(new Event('input')); document.querySelector('#composer').requestSubmit(); })()`);
  await until(async () => (await edges()) === 2, 'tagging connected both ways');
  await until(() => ui(`/is connected/.test(document.querySelector('#mention-bar').textContent) || document.querySelector('#mention-bar').hidden`), 'the bar updates');

  assert.deepEqual(errors, []);
  console.log('links: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
