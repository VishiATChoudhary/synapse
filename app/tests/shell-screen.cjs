// A shell tab keeps a headless copy of its screen for the phone: the app's real terminal, read as the phone reads it.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-shell-screen-')));
const state = path.join(fixture, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, wakeAgents: false, profiles: { shell: { command: '', label: 'Shell' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_CLAUDE_HOME: path.join(fixture, 'claude'), SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh', ZDOTDIR: fixture });
fs.writeFileSync(path.join(fixture, '.zshrc'), "PS1='$ '\n");
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(150); } };

(async () => {
  const main = await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  const { screenText } = await import(pathToFileURL(path.join(root, 'app/phone.mjs')));
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100);
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  const before = new Set(main.phoneHost.shells().map((s) => s.pty));
  const { id } = await win.webContents.executeJavaScript(`synapse.pty.spawn({ cwd: ${JSON.stringify(fixture)}, kind: 'shell', cols: 90, rows: 20 })`);
  const host = main.phoneHost;
  const sh = await until('the shell is listed', () => host.shells().find((s) => s.pty === id && !before.has(s.pty)));
  assert.equal(sh.cwd, fixture);
  assert.equal(sh.running, null, 'nothing runs in front at the prompt');
  host.write(id, 'echo phone-$((40+2))\r');
  await until('the output is on the headless screen', () => screenText(host.screenOf(id))?.lines.includes('phone-42'));
  host.write(id, 'sleep 5\r');
  await until('a running command shows', () => /sleep 5/.test(host.shells().find((s) => s.pty === id)?.running || ''));
  host.write(id, '\x03');
  await until('back at the prompt', () => host.shells().find((s) => s.pty === id)?.running === null);
  await win.webContents.executeJavaScript(`synapse.pty.resize(${JSON.stringify(id)}, 60, 10)`);
  assert.equal(host.screenOf(id).cols, 60, 'the screen copy follows a resize');
  console.log('shell-screen: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
