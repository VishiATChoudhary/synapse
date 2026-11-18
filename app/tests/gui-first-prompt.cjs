// Real Electron test: a first prompt from the New session screen never goes into a menu the agent opens before its
// prompt (Codex's "Update available": Enter there ran npm install -g). It waits until the menu is answered, then goes
// to the prompt. Codex is started without its update check.
// Run: SYNAPSE_APP_PORT=<free port> ./node_modules/.bin/electron tests/gui-first-prompt.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-first-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), log = path.join(fixture, 'log');
for (const d of [state, bin]) fs.mkdirSync(d, { recursive: true });
// a stand-in Codex: an update menu first, then its prompt; each line it reads is logged
fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
echo "ARGS:$*" >> ${JSON.stringify(log)}
stty -echo 2>/dev/null
printf '\\033[1m  Update available\\033[0m 0.1 -> 0.2\\r\\n\\r\\n\\033[36m› 1. Update now\\033[0m\\r\\n  2. Skip\\r\\n'
read choice; echo "CHOICE:$choice" >> ${JSON.stringify(log)}
printf '\\033[2J\\033[H› Ask Codex to do anything\\r\\n'
read prompt; echo "PROMPT:$prompt" >> ${JSON.stringify(log)}
exec cat
`, { mode: 0o755 });
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { shell: { command: '', label: 'shell' }, codex: { command: `${path.join(bin, 'codex')} --flag`, label: 'Codex' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/sh', HOME: fixture });
process.chdir(fixture); app.setPath('userData', path.join(fixture, 'electron'));
let win; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 30000) { const d = Date.now() + ms; while (Date.now() < d) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(150); } throw new Error(`Timed out: ${label}`); }
const ui = (code) => { const f = win.webContents.mainFrame.frames.find((x) => x.url.includes('?desktop=1')); return f.executeJavaScript(code, true); };
const lines = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'window'); win.setBounds({ width: 1300, height: 850 }); win.show();
  await until(() => win.webContents.mainFrame.frames.some((f) => f.url.includes('?desktop=1')), 'frame');
  await until(async () => { await ui(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }))`); return ui(`!document.getElementById('new-view').hidden`); }, 'New session screen');
  await ui(`document.getElementById('new-agent').click()`); await sleep(300);
  await ui(`[...document.querySelectorAll('.pop-menu button')].find((b) => b.textContent.trim() === 'Codex').click()`);
  await ui(`document.getElementById('new-input').value = 'hello from synapse'`);
  await ui(`document.getElementById('new-start').click()`);
  await until(() => lines().some((l) => l.startsWith('ARGS:')), 'codex started');
  assert.match(lines().find((l) => l.startsWith('ARGS:')), /^ARGS:-c check_for_update_on_startup=false --flag$/);
  console.log('PASS codex starts without its update check');
  await sleep(10_000); // past the 8 s fallback
  assert.ok(!lines().some((l) => l.startsWith('CHOICE:')), `the prompt went into the menu: ${lines().join(' | ')}`);
  console.log('PASS the first prompt waits while the menu is open');
  await until(() => ui(`/Update available/.test(document.querySelector('.terminal-transcript')?.textContent || '')`), 'the menu shown in the conversation');
  console.log('PASS the conversation shows the terminal while it asks something');
  // you answer the menu (2, Skip): then the prompt goes to the agent's prompt
  const pty = await win.webContents.executeJavaScript(`(async () => { for (let i = 1; i < 10; i++) if (/codex/.test(await synapse.pty.foreground(String(i)).catch(() => ''))) return String(i); return null; })()`);
  assert.ok(pty, 'the codex terminal');
  await win.webContents.executeJavaScript(`synapse.pty.write(${JSON.stringify(pty)}, '2\\r')`);
  await until(() => lines().some((l) => l.startsWith('PROMPT:')), 'prompt delivered', 15000);
  assert.equal(lines().find((l) => l.startsWith('CHOICE:')), 'CHOICE:2');
  assert.match(lines().find((l) => l.startsWith('PROMPT:')), /hello from synapse/);
  console.log('PASS after the menu is answered, the first prompt goes to the prompt');
  await until(() => ui(`/Codex is (ready|working)/.test(document.querySelector('#message-list .empty-state h2')?.textContent || '') && !document.querySelector('.terminal-transcript')`), 'ready state instead of the raw terminal');
  console.log('PASS no conversation yet: a ready state, not the raw terminal');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
