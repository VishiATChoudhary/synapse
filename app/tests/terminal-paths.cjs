// Real Electron test for paths in a terminal. A stand-in agent prints the kind of lines Claude Code and Codex show.
// Paths that exist in the session's folder become links; ⌘-click opens the file beside the terminal at its line,
// a plain click does not, and missing paths and version numbers stay plain text.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/terminal-paths.cjs
const electron = require('electron');
const { app, BrowserWindow } = electron;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-term-paths-')));
const state = path.join(fixture, 'state');
fs.mkdirSync(state); fs.mkdirSync(path.join(fixture, 'src'));
fs.writeFileSync(path.join(fixture, 'notes.md'), '# Notes\nsecond line\nthird line\n');
fs.writeFileSync(path.join(fixture, 'src', 'app.js'), 'console.log(1);\n');
const say = "printf '⏺ Update(src/app.js)\\n• Edited notes.md:2 (+1 -0), not v1.2.3 or src/missing.js\\n'; exec sleep 600";
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { shell: { command: say, label: 'Shell' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO' || key === 'SYNAPSE_FAKE_REQUESTS') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.race([Promise.resolve().then(check), sleep(5000).then(() => false)]).catch(() => false)) return; await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const shot = async (name) => { if (process.env.PATHS_SHOTS) fs.writeFileSync(path.join(process.env.PATHS_SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
const fileFrame = () => win.webContents.mainFrame.frames.find((f) => f.url.includes('/file?'));
// the middle of some text on screen, found in xterm's rows
const spot = (text) => js(`(() => {
  const term = document.querySelector('.term.visible .xterm-rows');
  for (const row of term.children) {
    const i = row.textContent.indexOf(${JSON.stringify(text)});
    if (i < 0) continue;
    // xterm draws a row as spans of text: find the one holding the middle character and measure it
    let at = i + Math.floor(${text.length} / 2);
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (at >= n.data.length) { at -= n.data.length; continue; }
      const range = document.createRange(); range.setStart(n, at); range.setEnd(n, at + 1);
      const r = range.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
  }
  return null;
})()`);
async function click(text, modifiers = []) {
  const at = await spot(text);
  assert.ok(at, `${text} on screen`);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...at, modifiers });
  await sleep(400); // xterm asks for links on hover
  win.webContents.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1, modifiers });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1, modifiers });
}
const hovered = () => js(`!!document.querySelector('.term.visible .xterm-screen').classList.contains('xterm-cursor-pointer')`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show(); win.focus();
  await until(() => js(`!!document.querySelector('#launch .launch-item')`), 'the launcher');
  await js(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Shell').click()`);
  await until(async () => !!(await spot('notes.md:2')), 'the output on screen');

  // a missing path and a version number are no links
  for (const plain of ['missing.js', '1.2.3']) {
    const at = await spot(plain);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...at });
    await sleep(500);
    assert.equal(await hovered(), false, `${plain} is plain text`);
  }

  // a plain click on a path selects nothing new and opens nothing
  await click('notes.md:2');
  await until(hovered, 'notes.md:2 is a link');
  await sleep(300);
  assert.equal(await js(`document.querySelector('#file-pane').hidden`), true);

  // ⌘-click opens it beside the terminal, at its line
  await click('notes.md:2', [process.platform === 'win32' ? 'control' : 'meta']);
  await until(() => js(`!document.querySelector('#file-pane').hidden`), 'the file pane');
  await until(async () => (await fileFrame()?.executeJavaScript(`document.querySelector('.file-line.hit code')?.textContent`)) === 'second line', 'notes.md at line 2', 20000);
  assert.equal(await fileFrame().executeJavaScript(`document.querySelector('.file-title h2').textContent`), 'notes.md');
  await shot('terminal-file');

  // a path inside "Update(...)" works too
  await click('src/app.js', [process.platform === 'win32' ? 'control' : 'meta']);
  await until(async () => (await fileFrame()?.executeJavaScript(`document.querySelector('.file-title h2')?.textContent`)) === 'app.js', 'app.js in the pane');

  // ✕ closes the pane and gives the terminal its width back
  const wide = () => js(`document.querySelector('#stage').getBoundingClientRect().width`);
  const narrow = await wide();
  await fileFrame().executeJavaScript(`document.querySelector('[data-act="close"]').click()`);
  await until(() => js(`document.querySelector('#file-pane').hidden`), 'pane closed');
  assert.ok((await wide()) > narrow);

  assert.deepEqual(errors, []);
  console.log('terminal paths: ok');
  app.exit(0);
})().catch(async (e) => { console.error(e); await shot('failure').catch(() => {}); app.exit(1); });
