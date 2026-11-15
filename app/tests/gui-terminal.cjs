// Real Electron test for terminals inside the GUI and the T3-style new session screen. A stand-in "claude" records
// what reaches its terminal. ⌘N opens "What should we do in <project>?", Enter starts the agent with that message;
// the Terminal tab lays the session's own terminal over the page, and ⌘J opens a shell drawer under the chat.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-terminal.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-terminal-')));
const project = path.join(fixture, 'rocket'), state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), typed = path.join(fixture, 'typed.txt');
for (const d of [project, state, bin]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
process.stdout.write('stand-in claude ready\\r\\n> ');
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', (d) => { fs.appendFileSync(${JSON.stringify(typed)}, d.toString()); process.stdout.write(d.toString().replace(/\\r/g, '\\r\\n')); });
setInterval(() => {}, 1 << 30);
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [project], skipLogin: true, profiles: { claude: { command: `exec ${path.join(bin, 'claude')}`, label: 'Claude' }, shell: { command: '', label: 'Shell' } } }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win, gui, failed = false;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check().catch(() => false)) return; await sleep(120); }
  throw new Error(`Timed out: ${label}`);
}
const ui = (code) => gui.executeJavaScript(code, true);
const native = (code) => win.webContents.executeJavaScript(code, true);
const key = (k, extra = '') => ui(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', metaKey: true, bubbles: true, cancelable: true ${extra} }))`);
const type = async (text) => { for (const ch of text) { win.webContents.sendInputEvent({ type: 'char', keyCode: ch === '\r' ? '\u000d' : ch }); await sleep(15); } };
// where the docked terminals are, in the window, and the page's empty boxes they should cover
const docks = () => native(`[...document.querySelectorAll('#gui-docks .gui-dock')].map((d) => { const r = d.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, text: d.querySelector('.xterm-rows')?.textContent || '' }; })`);
const hostRect = async (id) => {
  const frame = await native(`(() => { const r = document.querySelector('#workspace-frame').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
  const r = await ui(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  return { x: frame.x + r.x, y: frame.y + r.y, w: r.w, h: r.h };
};
const near = (a, b) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2 && Math.abs(a.w - b.w) < 2 && Math.abs(a.h - b.h) < 2;

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show(); win.focus();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => ui(`!!document.body.classList.contains('desktop') && !!document.querySelector('#project-list .project-head, #project-list [data-project-key], #project-list section')`), 'GUI with the project');

  // ⌘N: the new session screen names the project; its name opens the project picker
  await key('n');
  await until(() => ui(`!document.getElementById('new-view').hidden`), 'the new session screen');
  assert.match(await ui(`document.getElementById('new-title').textContent.replace(document.querySelector('.new-badge').textContent, '')`), /What should we do in\s*rocket\s*\?/);
  await until(() => ui(`document.activeElement.id === 'new-input' && document.hasFocus()`), 'the first message box has the focus');
  await ui(`document.getElementById('new-project').click()`);
  const picks = await ui(`[...document.querySelectorAll('.pop-menu button')].map((b) => b.textContent.trim())`);
  assert.ok(picks.includes('rocket') && picks.includes('Add a project…'), picks.join(' | '));
  await ui(`document.querySelector('.pop-menu button').click()`);
  assert.match(await ui(`document.getElementById('new-agent').textContent`), /Claude/);
  if (process.env.TERMINAL_SHOT) fs.writeFileSync(process.env.TERMINAL_SHOT.replace(/\.png$/, '-new.png'), (await win.webContents.capturePage()).toPNG());

  // Enter starts the agent and its first message reaches it
  await ui(`(() => { const t = document.getElementById('new-input'); t.value = 'build the launch pad'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  await until(() => ui(`!document.getElementById('thread-view').hidden && document.querySelector('.crumb-title')?.textContent === 'claude'`), 'the session opens in the GUI');
  await until(async () => fs.existsSync(typed) && fs.readFileSync(typed, 'utf8').includes('build the launch pad'), 'the first message reached the agent');
  console.log('PASS new session: ⌘N asks what to do in the project, Enter starts the agent with that message');

  // the Terminal tab: the agent's own terminal sits exactly over the page's box and takes keys
  await until(() => ui(`!document.getElementById('terminal-tab').hidden`), 'a Terminal tab for an owned session');
  await ui(`document.getElementById('terminal-tab').click()`);
  await until(async () => { const d = await docks(); return d.length === 1 && near(d[0], await hostRect('term-host')); }, 'the agent terminal docked over the Terminal tab');
  assert.equal(await ui(`document.querySelector('.composer-region').hidden`), true);
  await until(async () => (await docks())[0].text.includes('stand-in claude ready'), 'the terminal shows the agent');
  await type('zq');
  await until(async () => fs.readFileSync(typed, 'utf8').includes('zq'), 'keys typed in the docked terminal reach the agent');
  console.log('PASS terminal tab: the session\'s real terminal shows in the GUI and takes keys');

  const rows = await ui(`document.querySelectorAll('.session-row').length`);
  // ⌘J: a shell drawer under it, in the session's folder, kept out of the sidebar
  await key('j');
  await until(async () => (await docks()).length === 2, 'the drawer terminal docked');
  await until(async () => near((await docks()).find((d) => d.y > 300 && d.h < 400) || {}, await hostRect('drawer-host')), 'the drawer terminal over its box');
  await type('echo drawer-$((40+2))\r');
  await until(async () => (await docks()).some((d) => d.text.includes('drawer-42')), 'the drawer shell runs commands');
  assert.equal(await ui(`document.querySelectorAll('.session-row').length`), rows, 'the drawer shell is not listed as a session');
  if (process.env.TERMINAL_SHOT) fs.writeFileSync(process.env.TERMINAL_SHOT, (await win.webContents.capturePage()).toPNG());

  // back to the conversation: the agent terminal leaves, the drawer stays; ⌘J again closes it
  await ui(`document.getElementById('conversation-tab').click()`);
  await until(async () => (await docks()).length === 1, 'only the drawer remains docked');
  assert.equal(await ui(`document.querySelector('.composer-region').hidden`), false);
  await key('j');
  await until(async () => (await docks()).length === 0, 'the drawer closes');
  // a dialog over the page hides a docked terminal instead of covering it
  await ui(`document.getElementById('terminal-tab').click()`);
  await until(async () => (await docks()).length === 1, 'docked again');
  await key('k');
  await until(async () => (await docks()).length === 0, 'search hides the terminal');
  console.log('PASS terminal drawer: ⌘J opens a working shell under the chat, out of the session list, and closes it');
  await ui(`document.querySelector('#search-dialog').close()`);

  // Tidy up: defaults are a day to Idle, 3 days to Archived, a week to close; a change is saved
  await ui(`document.getElementById('group-by').click()`);
  await ui(`[...document.querySelectorAll('.pop-menu button')].find((b) => b.textContent.includes('Tidy up')).click()`);
  await until(() => ui(`!!document.getElementById('tidy-idle')`), 'the Tidy up dialog');
  const picked = await ui(`['tidy-idle', 'tidy-archive', 'tidy-close'].map((id) => document.getElementById(id).selectedOptions[0].textContent)`);
  assert.deepEqual(picked, ['1 day', '3 days', '1 week']);
  await ui(`document.getElementById('tidy-close').value = '0'; document.getElementById('action-form').requestSubmit()`);
  await until(() => ui(`JSON.parse(localStorage.getItem('synapse-tidy')).close === 0`), 'the setting is saved');
  console.log('PASS tidy up: done, archive and close times can be changed or turned off');
  assert.deepEqual(errors.filter((e) => !/Content-Security-Policy|net::ERR/.test(e)), []);
})().catch(async (e) => {
  failed = true; console.error(e); console.error('page errors:', errors);
  if (win) fs.writeFileSync('/tmp/gui-terminal.failed.png', (await win.webContents.capturePage()).toPNG());
}).finally(() => { app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit(); });
