// Real Electron test for files in the agent's panel: a PDF opened next to a working agent stays loaded (the panel
// redraws as the agent works and its checkout changes, and used to reload the PDF each time); once the file changes
// on disk it loads again.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-file.cjs
const { app, BrowserWindow } = require('electron');
// a site that is not local, so the agent has to ask for it (it resolves to this machine)
app.commandLine.appendSwitch('host-resolver-rules', 'MAP shop.example 127.0.0.1, MAP news.example 127.0.0.1');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-file-')));
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
const vaultHome = path.join(fixture, 'vault'); fs.mkdirSync(vaultHome);
fs.writeFileSync(path.join(vaultHome, 'index.json'), JSON.stringify({ SHOP_EXAMPLE_PASSWORD: { type: 'login', site: 'shop.example', user: 'ada@shop.example' }, SHOP_EXAMPLE_USERNAME: { type: 'login', site: 'shop.example', user: 'ada@shop.example' }, OTHER_ORG_PASSWORD: { type: 'login', site: 'other.org', user: 'x' } }));
fs.writeFileSync(path.join(fixture, 'fake-vault.json'), JSON.stringify({ SHOP_EXAMPLE: { username: 'ada@shop.example', password: 'pw-Secret-123' } }));
Object.assign(process.env, { VAULT_HOME: vaultHome, SYNAPSE_VAULT_FAKE: path.join(fixture, 'fake-vault.json'), SYNAPSE_LOGINS_TEST_CRYPTO: '1' });
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


const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url.startsWith('/login')) return res.end(`<!doctype html><title>Sign in</title><h1 id="h">Sign in</h1>
    <form onsubmit="event.preventDefault(); window.got = { u: this.email.value, p: this.password.value }; document.getElementById('h').textContent = 'Welcome ' + this.email.value"><input type="email" name="email" autocomplete="username"><input type="password" name="password"></form>`);
  res.end(`<!doctype html><title>Test shop</title><h1 id="h">Welcome</h1>
    <button onclick="document.getElementById('h').textContent = 'Clicked'">Buy now</button>
    <form onsubmit="event.preventDefault(); document.getElementById('h').textContent = 'Searched ' + this.q.value"><input name="q" placeholder="Search"></form>`);
});
const act = async (action, args = {}) => {
  const at = JSON.parse(fs.readFileSync(path.join(state, 'agent-browser.json'), 'utf8'));
  const r = await fetch(`http://127.0.0.1:${at.port}/act`, { method: 'POST', headers: { authorization: `Bearer ${at.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agent: agentKey, action, args }) });
  return r.json();
};
let agentKey;
const views = (w) => w.contentView.children.length;
// click once it is there (the panel redraws now and then)
const tap = (sel) => until(() => ui(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`), `click ${sel}`);
// SHOT_DIR=<dir>: also save what it looks like
const shot = async (w, name) => { if (process.env.SHOT_DIR) { await sleep(700); fs.writeFileSync(path.join(process.env.SHOT_DIR, `browser-${name}.png`), (await w.webContents.capturePage()).toPNG()); } };

(async () => {
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://shop.example:${site.address().port}/`;
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1500, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Claude').click()`);
  await until(() => fs.existsSync(path.join(ctl, 'slot-0')), 'agent started');
  set(0, 'idle');
  await until(() => ui(`!!document.querySelector('#project-list .session-row[data-agent^="desktop-"]') && location.hash.includes('desktop-')`).catch(() => false), 'agent selected', 20000);
  const { listAgents } = await import(pathToFileURL(path.join(root, 'lib.mjs')));
  await until(() => { agentKey = listAgents().find((x) => String(x.pid) === pidOf(0))?.id; return agentKey; }, 'agent id');
  // the app matches its session to the agent's own id (a second or so)
  // a PDF opened in the panel while the agent works: the viewer stays put (no reload) until the file changes on disk
  const pdf = path.join(fixture, 'report.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  await ui(`(() => { const a = document.createElement('a'); a.dataset.file = ${JSON.stringify(pdf)}; a.dataset.cwd = ${JSON.stringify(fixture)}; a.id = 'open-pdf'; document.body.append(a); a.click(); })()`);
  await until(() => ui(`!!document.querySelector('#inspector .file-pdf')`), 'the PDF shows');
  await ui(`document.querySelector('#inspector .file-pdf').dataset.mark = 'first'`);
  // the agent keeps working and its checkout changes (what made the panel redraw every few seconds)
  for (let i = 0; i < 12; i++) { fs.writeFileSync(path.join(fixture, `note-${i}.txt`), String(i)); await sleep(1000); }
  assert.equal(await ui(`document.querySelector('#inspector .file-pdf')?.dataset.mark || 'replaced'`), 'first', 'the viewer was not reloaded');
  console.log('PASS PDF: stays loaded while the agent works');
  // the file changes on disk: it shows the new version
  fs.appendFileSync(pdf, '% edited\n'); const later = new Date(Date.now() + 5000); fs.utimesSync(pdf, later, later);
  await ui(`document.getElementById('open-pdf').click()`);
  await until(() => ui(`!!document.querySelector('#inspector .file-pdf') && !document.querySelector('#inspector .file-pdf').dataset.mark`), 'a changed file loads again', 20000);
  console.log('PASS PDF: a changed file loads again');

  // a markdown file in the panel: the preview edits in place (⌘B / ⌘U), only the changed block is rewritten, the text
  // size changes, and comments go to the agent one by one or all at once
  const md = path.join(fixture, 'notes.md'), original = '# Title\n\nSome **bold** text.\n\n* one\n* two\n\nLast para here\n';
  fs.writeFileSync(md, original);
  await ui(`(() => { const a = document.createElement('a'); a.dataset.file = ${JSON.stringify(md)}; a.dataset.cwd = ${JSON.stringify(fixture)}; document.body.append(a); a.click(); a.remove(); })()`);
  await until(() => ui(`!!document.querySelector('#inspector iframe.file-frame')`), 'the markdown opens in the editable pane');
  const pane = () => win.webContents.mainFrame.framesInSubtree.find((f) => f.url.includes('/file?') && f.url.includes('embed=1'));
  const inPane = (code) => Promise.race([pane().executeJavaScript(code, true), sleep(3000).then(() => { throw new Error('pane did not answer'); })]);
  await until(() => pane() && inPane(`!!document.querySelector('.md-view[contenteditable="true"] h1')`), 'the preview is editable');
  const selectWord = (word) => inPane(`(() => { const w = ${JSON.stringify(word)}; const walk = document.createTreeWalker(document.querySelector('.md-view'), NodeFilter.SHOW_TEXT); let n; while ((n = walk.nextNode())) { const i = n.data.indexOf(w); if (i >= 0) { document.querySelector('.md-view').focus(); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + w.length); getSelection().removeAllRanges(); getSelection().addRange(r); return true; } } return false; })()`);
  const press = (code, opts = {}) => inPane(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(code.replace(/^(Key|Digit)/, '').toLowerCase())}, code: ${JSON.stringify(code)}, metaKey: true, altKey: ${!!opts.alt}, bubbles: true, cancelable: true }))`);
  assert.ok(await selectWord('Last'));
  await press('KeyB');
  await until(() => fs.readFileSync(md, 'utf8').includes('**Last** para here'), '⌘B made it bold in the file');
  assert.ok(await selectWord('here'));
  await press('KeyU');
  await until(() => fs.readFileSync(md, 'utf8').includes('<u>here</u>'), '⌘U underlined it');
  const saved = fs.readFileSync(md, 'utf8');
  assert.ok(saved.startsWith('# Title\n\nSome **bold** text.\n\n* one\n* two\n\n'), `untouched blocks stay as they were: ${JSON.stringify(saved)}`);
  assert.ok(saved.endsWith('\n'), 'the final newline stays');
  assert.ok(await selectWord('Title'));
  await press('Digit2', { alt: true });
  await until(() => fs.readFileSync(md, 'utf8').startsWith('## Title\n'), '⌘⌥2 made a level-2 heading');
  await inPane(`document.querySelector('[data-act="bigger"]').click()`);
  assert.equal(await inPane(`getComputedStyle(document.documentElement).getPropertyValue('--file-zoom').trim()`), '1.1', 'A+ made the text bigger');
  await inPane(`document.querySelector('[data-act="smaller"]').click()`);
  console.log('PASS markdown: the preview edits in place, ⌘B / ⌘U / ⌘⌥2, only the changed block rewritten, text size');
  // comments: two collected and sent at once, then one sent straight away
  const comment = async (word, body, how) => {
    assert.ok(await selectWord(word));
    await press('KeyM', { alt: true });
    await until(() => inPane(`!!document.querySelector('.comment-pop textarea')`), 'the comment form');
    await inPane(`(() => { const p = document.querySelector('.comment-pop'); p.querySelector('textarea').value = ${JSON.stringify(body)}; p.requestSubmit(p.querySelector('button[value="${how}"]')); })()`);
  };
  await comment('Some', 'Say more here', 'add');
  await comment('two', 'Add a third item', 'add');
  await until(() => inPane(`document.querySelectorAll('.comments li').length === 2`), 'two comments collected');
  if (process.env.SHOT_DIR) { await sleep(400); fs.writeFileSync(path.join(process.env.SHOT_DIR, 'file-comments.png'), (await win.webContents.capturePage()).toPNG()); }
  const before = typed().length;
  await inPane(`document.querySelector('[data-act="send-all"]').click()`);
  await until(() => { const t = typed().slice(before); return t.includes('Comments on notes.md') && t.includes('Say more here') && t.includes('Add a third item') && t.includes('line 3'); }, 'both comments reached the agent in one message').catch(async (e) => { console.error('typed:', JSON.stringify(typed().slice(before)), 'state:', await inPane(`document.querySelector('.bar .state').textContent`), 'queue:', await queue()); throw e; });
  await until(() => inPane(`document.getElementById('comments').hidden`), 'sent comments leave the list');
  const mid = typed().length;
  await comment('Title', 'Rename this', 'send');
  await until(() => typed().slice(mid).includes('Comment on notes.md, line 1') && typed().slice(mid).includes('Rename this'), 'one comment sent straight away');
  console.log('PASS comments: collected and sent all at once, or one straight away, to the agent');
  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|net::ERR/.test(e)), []);
  console.log('gui-file: ok');
})().catch((e) => { failed = true; console.error(e); }).finally(() => { site.close(); app.exit(failed ? 1 : 0); });
