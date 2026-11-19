// Real Electron test: the ⌘K palette grows out of the sidebar's search pill, filters in place, takes a scope as a chip,
// and folds back into the pill, which says what happened. SHOTS=<dir> saves frames of it.
// Run: SYNAPSE_APP_PORT=<free port> ./node_modules/.bin/electron tests/gui-palette.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-palette-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), home = path.join(fixture, 'home'), log = path.join(fixture, 'started');
for (const d of [state, bin, path.join(home, '.codex'), path.join(home, '.config', 'opencode')]) fs.mkdirSync(d, { recursive: true });
// stand-ins: note how they were started, then wait like an agent at its prompt
const agent = (name, extra = '') => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${extra}printf '%s|%s|%s\\n' ${name} "$*" "$OPENCODE_CONFIG_CONTENT" >> ${JSON.stringify(log)}\nexec cat\n`, { mode: 0o755 });
agent('claude'); agent('codex');
agent('opencode', `if [ "$1" = models ]; then printf 'opencode/big-pickle\\nanthropic/claude-sonnet-5-5\\nnot a model line\\n'; exit 0; fi\n`);
fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-b', display_name: 'GPT B', visibility: 'list', priority: 2 },
  { slug: 'gpt-a', display_name: 'GPT A', visibility: 'list', priority: 1, description: 'Fast' },
  { slug: 'hidden-one', display_name: 'Hidden', visibility: 'hide', priority: 0 },
] }));
fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-b"\n');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ model: 'down/endpoint' }));
const profiles = Object.fromEntries(['claude', 'codex', 'opencode'].map((k) => [k, { command: path.join(bin, k), label: k }]));
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { shell: { command: '', label: 'shell' }, ...profiles } }));
Object.assign(process.env, { HOME: home, SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/sh', PATH: `${bin}:${process.env.PATH}` });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO' || key === 'OPENCODE_CONFIG_CONTENT') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win, failed = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const ui = (code) => { const f = win.webContents.mainFrame.frames.find((x) => x.url.includes('?desktop=1')); return Promise.race([f.executeJavaScript(code, true), sleep(3000).then(() => { throw new Error('frame did not answer'); })]); };
const started = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('|')); } catch { return []; } };
const menu = () => ui(`[...document.querySelectorAll('.pop-menu button, .pop-menu .pop-heading')].map((b) => (b.matches('button') ? b.querySelector('span:not(.pop-gap)')?.firstChild?.textContent : b.textContent).trim())`);
const choose = (label) => ui(`[...document.querySelectorAll('.pop-menu button')].find((b) => b.querySelector('span:not(.pop-gap)')?.firstChild?.textContent.trim() === ${JSON.stringify(label)}).click()`);
async function newSession(kind, model) {
  await ui(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }))`);
  await until(() => ui(`!document.getElementById('new-view').hidden`), 'New session screen');
  await ui(`document.getElementById('new-agent').click()`); await choose(kind);
  await until(() => ui(`!document.getElementById('new-model').hidden && !document.getElementById('new-model').textContent.includes('…')`), `model picker for ${kind}`);
  await ui(`document.getElementById('new-model').click()`);
  await until(async () => (await menu()).length > 2, `models for ${kind}`);
  const items = await menu();
  if (model) await choose(model); else await ui(`document.querySelector('.pop-menu button').click()`);
  const before = started().length;
  await ui(`document.getElementById('new-start').click()`);
  await until(() => started().length > before, `${kind} started`);
  return { items, line: started().at(-1) };
}


const shots = process.env.SHOTS; let shotN = 0;
const shot = async (name) => { if (shots) fs.writeFileSync(path.join(shots, `${String(++shotN).padStart(2, '0')}-${name}.png`), (await win.capturePage()).toPNG()); };
const rect = () => ui(`(() => { const r = document.getElementById('search-dialog').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), open: document.getElementById('search-dialog').open }; })()`);
const rows = () => ui(`[...document.querySelectorAll('#search-results > .search-result:not(.leave) strong')].map((s) => s.textContent)`);
(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1300, height: 860 }); win.show();
  await until(() => win.webContents.mainFrame.frames.some((f) => f.url.includes('?desktop=1')), 'GUI frame');
  await until(() => ui(`!!document.getElementById('open-search') && typeof document.getElementById('new-model') === 'object'`), 'GUI ready'); await sleep(1500);
  for (const k of ['claude', 'codex']) {
    await ui(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }))`);
    await until(() => ui(`!document.getElementById('new-view').hidden`), 'New session screen');
    await ui(`document.getElementById('new-agent').click()`);
    await ui(`[...document.querySelectorAll('.pop-menu button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(k)})).click()`);
    await ui(`document.getElementById('new-start').click()`);
    await sleep(1500);
  }
  await until(() => ui(`document.querySelectorAll('.session-row').length >= 2`), 'two sessions');
  await shot('pill');
  assert.equal(await ui(`document.getElementById('pill-text').textContent`), 'Search or jump to…');

  // the pill grows into the palette
  const pill = await ui(`(() => { const r = document.getElementById('open-search').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  await ui(`document.getElementById('open-search').click()`);
  await sleep(60); const early = await rect(); await shot('growing');
  await sleep(600); const grown = await rect(); await shot('open');
  assert.ok(early.open && early.w < grown.w, `it grows (${early.w} → ${grown.w}, pill ${pill.w})`);
  assert.ok(grown.w >= 500 && grown.h > 150, 'a full palette');
  assert.equal(await ui(`document.activeElement.id`), 'search-input', 'the cursor is in the field');
  const all = await rows();
  assert.ok(all.includes('Projects') && all.includes('Sessions'), 'Search in: scopes listed');
  console.log(`PASS the pill grows into the palette (${pill.w}px → ${grown.w}px), cursor in the field`);

  // typing keeps the rows that match, the rest leave
  await ui(`{ const i = document.getElementById('search-input'); i.value = 'set'; i.dispatchEvent(new Event('input')) }`);
  await sleep(40); await shot('typing'); await sleep(400);
  const typed = await rows();
  assert.ok(typed.includes('Settings') && !typed.includes('Projects'), `filtered: ${typed}`);
  const h2 = (await rect()).h; assert.ok(h2 < grown.h, 'the panel shrinks to its results');
  console.log('PASS typing: matches stay, the rest leave, the panel follows its results');

  // a scope becomes a chip; Backspace on an empty field takes it out
  await ui(`{ const i = document.getElementById('search-input'); i.value = ''; i.dispatchEvent(new Event('input')) }`); await sleep(300);
  await ui(`[...document.querySelectorAll('#search-results .search-result')].find((b) => b.textContent.includes('Projects')).click()`);
  await sleep(500); await shot('scope');
  assert.equal(await ui(`document.getElementById('search-scope').hidden`), false);
  assert.match(await ui(`document.getElementById('search-scope').textContent`), /Projects/);
  const projects = await rows(); assert.ok(projects.length >= 1 && !projects.includes('Settings'), `only projects: ${projects}`);
  await ui(`document.getElementById('search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))`);
  await sleep(200);
  assert.equal(await ui(`document.getElementById('search-scope').hidden`), true, 'Backspace takes the chip out');
  console.log('PASS scope: Projects becomes a chip, Backspace takes it out');

  // picking folds it back into the pill, which says what happened
  await ui(`{ const i = document.getElementById('search-input'); i.value = 'overview'; i.dispatchEvent(new Event('input')) }`); await sleep(300);
  await ui(`document.getElementById('search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await sleep(150); await shot('folding');
  await until(async () => !(await rect()).open, 'palette closed');
  await until(() => ui(`document.getElementById('pill-text').textContent === 'Opened Overview'`), 'the pill says what happened', 3000);
  await shot('told');
  await until(() => ui(`document.getElementById('pill-text').textContent === 'Search or jump to…'`), 'then asks again', 5000);
  console.log('PASS pick: folds back, the pill says "Opened Overview", then asks again');

  // ⌘K opens it, Escape closes it
  await ui(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`);
  await until(async () => (await rect()).open, '⌘K opens');
  await sleep(500);
  await ui(`document.getElementById('search-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
  await until(async () => !(await rect()).open, 'Escape closes');
  console.log('PASS ⌘K opens it, Escape folds it away');
})().catch((e) => { failed = true; console.error(e); }).finally(() => { fs.rmSync(fixture, { recursive: true, force: true }); app.exit(failed ? 1 : 0); });
