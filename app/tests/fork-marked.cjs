// Real Electron test: text marked in a session leads the fork's question. Demo mode, so the sessions are
// shells. An OSC 52 copy (what claude sends for its own selection) and an xterm selection (codex) both count.
// Run: npm --prefix app run test:fork-marked
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-fork-marked-'));
const state = path.join(fixture, 'state'), work = path.join(fixture, 'work');
fs.mkdirSync(state); fs.mkdirSync(work);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [work] }));
process.env.SYNAPSE_HOME = state;
process.env.SYNAPSE_DEMO = '1';
process.env.SHELL = '/bin/sh';
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
process.argv.push('--demo');

let win;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(25); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const key = (keyCode, modifiers = []) => { for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode, modifiers }); };
const type = async (text) => { await js(`document.querySelector('.term.visible textarea').focus()`); for (const c of text) win.webContents.sendInputEvent({ type: 'char', keyCode: c }); await sleep(100); key('Return'); };
const forkPrompt = async () => {
  key('F', ['meta', 'shift']);
  await until(() => js(`!document.querySelector('#modal').hidden`), 'fork prompt');
  const value = await js(`document.querySelector('#modal textarea').value`);
  await js(`document.querySelector('#modal textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  return value;
};

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.show(); win.focus();
  await until(() => js(`document.querySelectorAll('.term').length === 5`), 'demo tree');
  await sleep(500);

  // nothing marked: an empty prompt
  assert.equal(await forkPrompt(), '');

  // an OSC 52 copy, as claude sends it
  await type(`printf '\\033]52;c;%s\\007' $(printf 'line one\\nline two' | base64)`);
  await sleep(300);
  assert.equal(await forkPrompt(), '> line one\n> line two\n\n');

  // a sent prompt forgets it
  await type('true');
  await sleep(300);
  assert.equal(await forkPrompt(), '');

  // an xterm selection, as in codex: drag across the printed word
  await type('echo MARKME');
  await sleep(300);
  const box = await js(`(() => { const r = [...document.querySelectorAll('.term.visible .xterm-rows > div')].find((d) => d.textContent.trim() === 'MARKME').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + r.height / 2) }; })()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x + 1, y: box.y, button: 'left', clickCount: 1 });
  for (let dx = 10; dx <= 60; dx += 10) win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x + dx, y: box.y, button: 'left' });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x + 60, y: box.y, button: 'left', clickCount: 1 });
  await sleep(200);
  const marked = await forkPrompt();
  assert.match(marked, /^> MARK/, `selection quoted, got ${JSON.stringify(marked)}`);

  console.log('PASS fork marked');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
