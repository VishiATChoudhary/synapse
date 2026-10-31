// Real Electron test for how the terminals look, ⌘F and the user's own shortcuts. Themes: picking one in Settings
// recolours the app and the terminals and is kept in app.json, a theme of the user's own from app.json is offered
// too, and the font size reaches the terminal. ⌘F finds text in the terminal in front. Shortcuts: one recorded in
// Settings opens an agent tab with its first prompt, another runs a command in the tab in front.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/looks-keys.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-looks-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), proj = path.join(fixture, 'proj');
for (const d of [state, bin, proj]) fs.mkdirSync(d);
const standIn = path.join(bin, 'claude');
fs.writeFileSync(standIn, '#!/bin/sh\necho "agent ready"\nwhile IFS= read -r l; do echo "AGENT GOT: $l"; done\n', { mode: 0o755 });
const mine = { label: 'Mine', dark: true, paper: '#101418', ink: '#E6E1CF', sig: '#FFB454', ansi: Array(16).fill('#888888') };
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [proj], skipLogin: true, wakeAgents: false, themes: { mine },
  profiles: { claude: { command: standIn, label: 'Claude Code' }, shell: { command: "env PS1='ready> ' zsh -fi", label: 'Shell' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_CLAUDE_HOME: path.join(fixture, 'claude'), SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO' || key === 'SYNAPSE_FAKE_REQUESTS') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const press = (init) => js(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, cancelable: true, ...init })}))`);
const screen = () => js(`[...document.querySelectorAll('.term.visible .xterm-rows > div')].map((r) => r.textContent).join('\\n')`);
const cfg = () => JSON.parse(fs.readFileSync(path.join(state, 'app.json'), 'utf8'));
const slots = () => js(`document.querySelectorAll('#tree .slot').length`);
const shot = async (name) => { if (process.env.LOOKS_SHOTS) fs.writeFileSync(path.join(process.env.LOOKS_SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => (win = BrowserWindow.getAllWindows()[0]), 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('#launch .launch-item')`), 'the launcher');
  await js(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Shell').click()`);
  await until(async () => (await screen()).includes('ready>'), 'a shell');
  await js(`document.querySelector('.term.visible .xterm-helper-textarea').focus()`);
  for (const ch of 'echo needle-$((40+2))') win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  await until(async () => (await screen()).includes('needle-42'), 'the output');

  // ⌘F finds it; esc closes the bar
  await press({ key: 'f', code: 'KeyF', metaKey: true });
  await until(() => js(`!!document.querySelector('.term.visible .find:not([hidden]) input')`), 'the find bar');
  await js(`(() => { const i = document.querySelector('.find input'); i.value = 'needle-42'; i.dispatchEvent(new Event('input')); })()`);
  await until(() => js(`/^1\\/1$|^\\d+\\/\\d+$/.test(document.querySelector('.find-count').textContent)`), 'a match counted');
  await js(`(() => { const i = document.querySelector('.find input'); i.value = 'nothing-like-this'; i.dispatchEvent(new Event('input')); })()`);
  await until(() => js(`document.querySelector('.find-count').textContent === 'no matches'`), 'no matches');
  await sleep(400); await shot('find');
  await js(`document.querySelector('.find input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await until(() => js(`document.querySelector('.find').hidden`), 'the bar closed');

  // Settings > appearance: built-in themes and the user's own; Dracula recolours and is kept
  await press({ key: ',', code: 'Comma', metaKey: true });
  await until(() => js(`document.querySelectorAll('.theme-swatch').length >= 14`), 'the themes');
  assert.ok(await js(`[...document.querySelectorAll('.theme-swatch')].some((b) => b.textContent.includes('Mine'))`), 'a theme from app.json is offered');
  await js(`[...document.querySelectorAll('.theme-swatch')].find((b) => b.textContent.includes('Dracula')).click()`);
  await until(() => js(`getComputedStyle(document.documentElement).getPropertyValue('--paper').trim().toUpperCase() === '#282A36'`), 'the app recoloured');
  await until(() => cfg().look?.theme === 'dracula', 'the theme kept in app.json');
  assert.equal(await js(`document.documentElement.dataset.theme`), 'night', 'a dark theme counts as night for the node view');
  await js(`(() => { const i = document.querySelector('.look-ctl input[type=number]'); i.value = 16; i.dispatchEvent(new Event('change')); })()`);
  await until(() => cfg().look?.fontSize === 16, 'the font size kept');
  await until(() => js(`getComputedStyle(document.querySelector('.term.visible .xterm-rows')).fontSize === '16px'`), 'the terminal at 16 px');
  await js(`document.querySelector('.looks').scrollIntoView()`); await sleep(300);
  await shot('appearance');

  // Settings > your shortcuts: record ⌥⌘C to open a Claude tab with a first prompt
  await js(`[...document.querySelectorAll('.my-keys > .btn')].find((b) => b.textContent.includes('add shortcut')).click()`);
  await until(() => js(`!!document.querySelector('.key-rec.recording')`), 'recording');
  await press({ key: 'ç', code: 'KeyC', metaKey: true, altKey: true });
  await until(() => cfg().shortcuts?.[0]?.keys === 'alt+cmd+c', 'the keys kept');
  await js(`(() => { const i = document.querySelector('.my-key .key-detail input'); i.value = 'hello from a shortcut'; i.dispatchEvent(new Event('change')); })()`);
  await until(() => cfg().shortcuts?.[0]?.text === 'hello from a shortcut', 'the first prompt kept');
  assert.equal(cfg().shortcuts[0].kind, 'claude');
  // a second one runs a command in the tab in front
  await js(`[...document.querySelectorAll('.my-keys > .btn')].find((b) => b.textContent.includes('add shortcut')).click()`);
  await until(() => js(`!!document.querySelector('.key-rec.recording')`), 'recording again');
  await press({ key: 'F6', code: 'F6' });
  await until(() => cfg().shortcuts?.[1]?.keys === 'f6', 'F6 kept');
  await js(`(() => { const s = document.querySelectorAll('.my-key')[1].querySelector('select'); s.value = 'run'; s.dispatchEvent(new Event('change')); })()`);
  await until(() => js(`!!document.querySelectorAll('.my-key')[1].querySelector('.key-detail input')`), 'the text field');
  await js(`(() => { const i = document.querySelectorAll('.my-key')[1].querySelector('.key-detail input'); i.value = 'echo ran-$((6*7))'; i.dispatchEvent(new Event('change')); })()`);
  await until(() => cfg().shortcuts?.[1]?.text === 'echo ran-$((6*7))', 'the command kept');
  await js(`document.querySelector('.my-keys').scrollIntoView()`); await sleep(300);
  await shot('shortcuts');
  await js(`document.querySelector('#modal-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await until(() => js(`document.querySelector('#modal').hidden`), 'settings closed');

  await press({ key: 'F6', code: 'F6' });
  await until(async () => (await screen()).includes('ran-42'), 'F6 ran the command in the tab in front');
  const before = await slots();
  await press({ key: 'ç', code: 'KeyC', metaKey: true, altKey: true });
  await until(async () => (await slots()) === before + 1, '⌥⌘C opened an agent tab');
  await until(async () => (await screen()).includes('AGENT GOT: hello from a shortcut'), 'its first prompt sent', 20000);

  // the toolbar switch goes from Dracula to the last light theme and back
  await js(`document.querySelector('#theme').click()`);
  await until(() => js(`document.documentElement.dataset.theme === 'signal'`), 'light');
  await js(`document.querySelector('#theme').click()`);
  await until(() => cfg().look?.theme === 'dracula', 'back to Dracula');

  assert.deepEqual(errors, []);
  console.log('looks and keys: ok');
  app.exit(0);
})().catch(async (e) => { console.error(e, errors, await screen().catch(() => '')); await shot('failure').catch(() => {}); app.exit(1); });
