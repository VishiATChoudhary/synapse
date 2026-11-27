// Real Electron test: graphics in the chat. A reply with a ```mermaid diagram, an ```svg image, an ```html preview
// (a canvas its own script draws) and a markdown image of a file on disk shows each one drawn, not as code, and
// Code / Preview switch a graphic and its source. (Stand-in "claude" setup shared with gui-teammate.cjs.)
// Run: SYNAPSE_APP_PORT=<free port> ./node_modules/.bin/electron tests/gui-graphics.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-graphics-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), claudeHome = path.join(fixture, 'claude'), ctl = path.join(fixture, 'ctl');
for (const d of [state, bin, ctl, path.join(claudeHome, 'sessions')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
let slot = 0; for (;; slot++) { try { fs.writeFileSync(path.join(${JSON.stringify(ctl)}, 'slot-' + slot), String(process.pid), { flag: 'wx' }); break; } catch {} }
const file = path.join(${JSON.stringify(path.join(claudeHome, 'sessions'))}, process.pid + '.json');
const control = path.join(${JSON.stringify(ctl)}, 'state-' + slot);
let status = '';
const sid = 'tm-' + process.pid, proj = path.join(${JSON.stringify(path.join(claudeHome, 'projects', 'x'))});
fs.mkdirSync(proj, { recursive: true });
const line = (type, content, i) => JSON.stringify({ type, uuid: 'u' + i, timestamp: new Date(Date.now() - 60000 + i * 1000).toISOString(), cwd: process.cwd(), sessionId: sid, message: { role: type, content } });
fs.writeFileSync(path.join(proj, sid + '.jsonl'), [
  line('user', 'Show me how the sync works', 0),
  line('assistant', [{ type: 'text', text: fs.readFileSync(${JSON.stringify(path.join(fixture, 'reply.md'))}, 'utf8') }], 1),
].join('\\n') + '\\n');
const tick = () => {
  let want = 'idle'; try { want = fs.readFileSync(control, 'utf8').trim() || 'busy'; } catch {}
  if (want !== status) { status = want; fs.writeFileSync(file, JSON.stringify({ sessionId: sid, pid: process.pid, cwd: process.cwd(), status, startedAt: Date.now(), updatedAt: Date.now() })); }
  process.stdout.write('agent ' + slot + ' working ' + Date.now() + '\\r\\n');
};
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', (d) => fs.appendFileSync(path.join(${JSON.stringify(ctl)}, 'typed-' + slot), d.toString()));
tick(); setInterval(tick, 250);
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);
const FENCE = '`'.repeat(3);
fs.writeFileSync(path.join(fixture, 'reply.md'), [
  'Here is the flow:', '', FENCE + 'mermaid', 'graph LR', '  Phone-->Relay-->Desktop', FENCE, '',
  'The logo:', '', FENCE + 'svg', '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" rx="8" fill="#3b82f6"/></svg>', FENCE, '',
  'A chart:', '', FENCE + 'html preview', '<canvas id="c" width="300" height="220"></canvas>',
  "<script>const g = document.getElementById('c').getContext('2d'); [40, 90, 60, 150].forEach((v, i) => { g.fillStyle = '#10b981'; g.fillRect(20 + i * 70, 210 - v, 50, v); }); fetch('http://127.0.0.1:1/').catch(() => {});</script>", FENCE, '',
  'The screenshot: ![shot](shot.png)', '', 'And a snippet:', '', FENCE + 'html', '<div class="nav"></div>', FENCE,
].join('\n'));
// a 2x2 png the reply points at
fs.writeFileSync(path.join(fixture, 'shot.png'), require('electron').nativeImage.createFromBitmap(Buffer.alloc(16, 200), { width: 2, height: 2 }).toPNG());

fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { claude: { command: `exec ${path.join(bin, 'claude')}`, label: 'Claude' } } }));
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
const ui = (code) => gui.executeJavaScript(code, true);
const native = (code) => win.webContents.executeJavaScript(code, true);
const pidOf = (slot) => fs.readFileSync(path.join(ctl, `slot-${slot}`), 'utf8').trim();
const set = (slot, status) => fs.writeFileSync(path.join(ctl, `state-${slot}`), status);


(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 1000 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Claude').click()`);
  await until(() => fs.existsSync(path.join(ctl, 'slot-0')), 'agent started');
  await until(async () => { await ui(`document.querySelector('.session-row')?.click()`); return ui(`!document.getElementById('thread-view').hidden && !!document.querySelector('.code-block.graphic')`); }, 'the reply shows', 45000);

  await until(() => ui(`!!document.querySelector('[data-graphic="mermaid"] .graphic-view svg')`), 'the mermaid diagram is drawn');
  assert.match(await ui(`document.querySelector('[data-graphic="mermaid"] .graphic-view svg').textContent`), /Phone[\s\S]*Relay[\s\S]*Desktop/);
  assert.equal(await ui(`document.querySelector('[data-graphic="mermaid"] pre').hidden`), true);
  console.log('PASS a mermaid block draws as a diagram');
  await until(() => ui(`document.querySelector('[data-graphic="svg"] .graphic-view img')?.naturalWidth === 120`), 'the svg shows');
  console.log('PASS an svg block shows as an image');
  await until(() => ui(`document.querySelector('.md-image-file img')?.naturalWidth === 2`), 'the file image loads');
  console.log('PASS a markdown image of a file on disk shows');

  await until(() => ui(`(document.querySelector('[data-graphic="html"]:not([data-code]) iframe.graphic-frame')?.getBoundingClientRect().height || 0) > 220`), 'the html preview sizes to its page');
  const frame = win.webContents.mainFrame.framesInSubtree.find((f) => f.url === 'about:srcdoc');
  assert.ok(frame, 'the preview runs');
  await until(async () => (await frame.executeJavaScript(`(() => { const d = document.getElementById('c').getContext('2d').getImageData(45, 200, 1, 1).data; return d[1] > 150; })()`)), 'its script drew the chart');
  assert.equal(await frame.executeJavaScript(`(() => { try { return !!parent.document; } catch { return false; } })()`), false, 'it cannot reach Synapse');
  console.log('PASS an html preview runs its script in a sandbox, sized to fit');

  const snippet = `document.querySelectorAll('[data-graphic="html"]')[1]`;
  assert.equal(await ui(`${snippet}.querySelector('pre').hidden`), false, 'a plain html snippet opens on its code');
  assert.equal(await ui(`!!${snippet}.querySelector('iframe')`), false);
  await ui(`${snippet}.querySelector('[data-graphic-toggle]').click()`);
  await until(() => ui(`!!${snippet}.querySelector('iframe.graphic-frame') && ${snippet}.querySelector('pre').hidden`), 'Preview shows it');
  await ui(`document.querySelector('[data-graphic="mermaid"] [data-graphic-toggle]').click()`);
  assert.equal(await ui(`document.querySelector('[data-graphic="mermaid"] pre').hidden || document.querySelector('[data-graphic="mermaid"] .graphic-view').hidden === false`), false);
  assert.match(await ui(`document.querySelector('[data-graphic="mermaid"] pre').textContent`), /Phone-->Relay/);
  await ui(`document.querySelector('[data-graphic="mermaid"] [data-graphic-toggle]').click()`);
  console.log('PASS Code and Preview switch a graphic and its source');

  if (process.env.GRAPHICS_SHOT) { await sleep(800); fs.writeFileSync(process.env.GRAPHICS_SHOT, (await win.webContents.capturePage()).toPNG()); }
  assert.deepEqual(errors.filter((e) => !/Autofill|favicon|127\.0\.0\.1:1|Content Security Policy/i.test(e)), []);
  console.log('PASS no errors');
})().catch((e) => { console.error(e); failed = true; }).finally(() => app.exit(failed ? 1 : 0));
