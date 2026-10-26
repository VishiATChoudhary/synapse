// Real Electron test for paths in a terminal. A stand-in agent prints the kind of lines Claude Code and Codex show.
// Paths that exist in the session's folder become links; ⌘-click opens the file beside the terminal at its line,
// a plain click does not, and missing paths and version numbers stay plain text. Text files edit and save themselves
// (an agent's change is never overwritten silently); the pane resizes and fills the window; pdfs show just their pages
// and drawing on one saves into the file.
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
// a one-page pdf that says "Hello Synapse"
{
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 44 >>\nstream\nBT /F1 24 Tf 40 100 Td (Hello Synapse) Tj ET\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const at = [];
  objs.forEach((o, i) => { at.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(path.join(fixture, 'doc.pdf'), pdf);
  if (process.env.PATHS_PDF) fs.copyFileSync(process.env.PATHS_PDF, path.join(fixture, 'doc.pdf'));
}
const say = "printf '⏺ Update(src/app.js)\\n• Edited notes.md:2 (+1 -0), not v1.2.3 or src/missing.js\\nWrote doc.pdf\\n'; exec sleep 600";
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { shell: { command: say, label: 'Shell' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'terminal', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO' || key === 'SYNAPSE_FAKE_REQUESTS') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
// pdf.js draws pages when they are on screen: keep painting while other windows cover this one
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
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
  const fx = (code) => fileFrame().executeJavaScript(code);
  // a path with a line opens the editor there: the line is selected and marked, the terminal keeps the keyboard
  await until(async () => (await fileFrame()?.executeJavaScript(`document.querySelector('.ed pre b')?.textContent`)) === '2', 'notes.md at line 2', 20000);
  assert.equal(await fx(`document.querySelector('.bar .name').textContent`), 'notes.md');
  assert.equal(await fx(`(() => { const t = document.querySelector('textarea'); return t.value.slice(t.selectionStart, t.selectionEnd); })()`), 'second line');
  assert.equal(await fx(`document.hasFocus()`), false);
  await shot('terminal-file');

  // typing saves by itself
  const type = (value) => fx(`(() => { const t = document.querySelector('textarea'); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new Event('input')); })()`);
  const notes = path.join(fixture, 'notes.md'), disk = () => fs.readFileSync(notes, 'utf8');
  await type('# Notes\nsecond line, edited\nthird line\n');
  await until(() => disk().includes('edited'), 'the edit saved');
  await until(() => fx(`document.querySelector('.bar .state').textContent === 'saved'`), 'says saved');

  // an agent writes the file: the editor shows its version
  await sleep(50); fs.writeFileSync(notes, '# Notes\nfrom the agent\n');
  await until(() => fx(`document.querySelector('textarea').value.includes('from the agent')`), 'reloaded from disk', 8000);

  // edits of your own and a change on disk: nothing is overwritten until you choose
  await type('# Notes\nmine\n');
  fs.writeFileSync(notes, '# Notes\nagent again\n');
  await until(() => fx(`!!document.querySelector('[data-act="overwrite"]')`), 'asks which version wins', 8000);
  assert.equal(disk(), '# Notes\nagent again\n');
  await fx(`document.querySelector('[data-act="overwrite"]').click()`);
  await until(() => disk() === '# Notes\nmine\n', 'kept mine');

  // markdown also previews
  await fx(`document.querySelector('[data-act="mode"]').click()`);
  await until(() => fx(`!!document.querySelector('.md-view h3')`), 'markdown preview');
  assert.equal(await fx(`document.querySelector('[data-act="mode"]').textContent`), 'Edit');

  // the left edge resizes the pane, and the width is kept
  const paneWidth = () => js(`Math.round(document.querySelector('#file-pane').getBoundingClientRect().width)`);
  const grip = await js(`(() => { const r = document.querySelector('#file-grip').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 200) }; })()`);
  const before = await paneWidth();
  win.webContents.sendInputEvent({ type: 'mouseDown', ...grip, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 5; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: grip.x - i * 30, y: grip.y, modifiers: ['leftButtonDown'] }); await sleep(30); }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: grip.x - 150, y: grip.y, button: 'left', clickCount: 1 });
  await until(async () => Math.abs((await paneWidth()) - before - 150) <= 2, 'pane 150px wider');
  assert.equal(+(await js(`localStorage.getItem('synapse-file-width')`)), await paneWidth());

  // fill: the pane covers the terminals, and goes back
  await fx(`document.querySelector('[data-act="wide"]').click()`);
  await until(async () => (await paneWidth()) === (await js(`Math.round(document.querySelector('.work').getBoundingClientRect().width)`)), 'pane fills the window');
  await shot('wide');
  await fx(`document.querySelector('[data-act="wide"]').click()`);
  await until(async () => (await paneWidth()) < (await js(`Math.round(document.querySelector('.work').getBoundingClientRect().width)`)), 'pane back beside');

  // a pdf shows just its pages (pdf.js, no viewer toolbar), and drawing on one saves into the file
  const doc = path.join(fixture, 'doc.pdf'), pdfBefore = fs.readFileSync(doc);
  await click('doc.pdf', [process.platform === 'win32' ? 'control' : 'meta']);
  await until(async () => !!(await fileFrame()?.executeJavaScript(`!!document.querySelector('.pdfViewer .page canvas')`)), 'the pdf page drawn', 20000);
  await sleep(500);
  await shot('pdf');
  await fx(`document.querySelector('[data-tool="Draw"]').click()`);
  await until(() => fx(`document.querySelector('[data-tool="Draw"]').getAttribute('aria-pressed') === 'true'`), 'draw tool on');
  // Electron's synthetic mouse input does not reach the viewer's own process, so the stroke is dispatched inside it
  await fx(`(async () => {
    const layer = document.querySelector('.annotationEditorLayer'), r = layer.getBoundingClientRect();
    const at = (x, y) => ({ clientX: r.left + r.width * x, clientY: r.top + Math.min(r.height, 400) * y, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 });
    layer.dispatchEvent(new PointerEvent('pointerdown', at(0.3, 0.3)));
    for (let i = 1; i <= 10; i++) { window.dispatchEvent(new PointerEvent('pointermove', at(0.3 + i * 0.03, 0.3 + i * 0.02))); document.elementFromPoint(at(0.3 + i * 0.03, 0.3 + i * 0.02).clientX, at(0.3 + i * 0.03, 0.3 + i * 0.02).clientY)?.dispatchEvent(new PointerEvent('pointermove', at(0.3 + i * 0.03, 0.3 + i * 0.02))); await new Promise((ok) => setTimeout(ok, 20)); }
    window.dispatchEvent(new PointerEvent('pointerup', { ...at(0.6, 0.5), buttons: 0 }));
  })()`);
  await fx(`document.querySelector('[data-tool="Draw"]').click()`); // leaving the tool commits the stroke
  await until(() => !fs.readFileSync(doc).equals(pdfBefore) && /\/Ink/.test(fs.readFileSync(doc, 'latin1')), 'the drawing saved into the pdf', 15000);
  assert.equal(fs.readFileSync(doc, 'latin1').slice(0, 5), '%PDF-');
  await sleep(800);
  await shot('pdf-drawn');

  // a path inside "Update(...)" works too
  await click('src/app.js', [process.platform === 'win32' ? 'control' : 'meta']);
  await until(async () => (await fileFrame()?.executeJavaScript(`document.querySelector('.bar .name')?.textContent`)) === 'app.js', 'app.js in the pane');

  // ✕ closes the pane and gives the terminal its width back
  const wide = () => js(`document.querySelector('#stage').getBoundingClientRect().width`);
  const narrow = await wide();
  await fileFrame().executeJavaScript(`document.querySelector('[data-act="close"]').click()`);
  await until(() => js(`document.querySelector('#file-pane').hidden`), 'pane closed');
  assert.ok((await wide()) > narrow);

  assert.deepEqual(errors, []);
  console.log('terminal paths: ok');
  app.exit(0);
})().catch(async (e) => { console.error(e, errors); await shot('failure').catch(() => {}); app.exit(1); });
