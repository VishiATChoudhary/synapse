// Real Electron test: the New session screen lists the models for Claude, Codex and OpenCode, and the agent starts
// on the one picked (claude --model, codex -m, OpenCode on a private server with the model in its config).
// Run: SYNAPSE_APP_PORT=<free port> ./node_modules/.bin/electron tests/gui-models.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-models-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), home = path.join(fixture, 'home'), log = path.join(fixture, 'started');
for (const d of [state, bin, path.join(home, '.codex'), path.join(home, '.config', 'opencode')]) fs.mkdirSync(d, { recursive: true });
// stand-ins: note how they were started, then wait like an agent at its prompt
const agent = (name, extra = '') => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${extra}printf '%s|%s|%s\\n' ${name} "$*" "$OPENCODE_CONFIG_CONTENT" >> ${JSON.stringify(log)}\nexec cat\n`, { mode: 0o755 });
agent('claude'); agent('codex');
agent('agy', `if [ "$1" = models ]; then printf 'Fetching available models...\\ngemini-4-neon\\tGemini 4 Neon\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\n'; exit 0; fi\n`);
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
profiles.antigravity = { command: path.join(bin, 'agy'), label: 'antigravity' };
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

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1400, height: 950 }); win.show();
  await until(() => win.webContents.mainFrame.frames.some((f) => f.url.includes('?desktop=1')), 'GUI frame');
  await until(() => ui(`typeof document.getElementById('new-model') === 'object'`), 'GUI ready');

  let r = await newSession('claude', 'Sonnet 5.5');
  assert.deepEqual(r.items, ['Default (Opus 5.5)', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'Fable 5.2']);
  assert.equal(r.line[0], 'claude'); assert.match(r.line[1], /--model sonnet/);
  console.log('PASS claude: picked Sonnet, started with --model sonnet');

  r = await newSession('codex', 'GPT A');
  assert.deepEqual(r.items, ['Default (gpt-b)', 'GPT A', 'GPT B'], 'hidden models left out, in their order');
  assert.equal(r.line[0], 'codex'); assert.match(r.line[1], /-m gpt-a/);
  console.log('PASS codex: lists its models, started with -m gpt-a');

  r = await newSession('opencode', 'big-pickle');
  assert.deepEqual(r.items, ['Default (down/endpoint)', 'opencode', 'big-pickle', 'anthropic', 'claude-sonnet-5-5']);
  assert.equal(r.line[0], 'opencode'); assert.match(r.line[1], /--standalone/);
  assert.equal(JSON.parse(r.line[2]).model, 'opencode/big-pickle');
  console.log('PASS opencode: lists models by provider, started on a private server with the model');

  r = await newSession('antigravity', 'Gemini 4 Neon');
  assert.deepEqual(r.items, ['Default model', 'Gemini 4 Neon', 'Gemini 3.8 Flash (Low)'], 'agy models: id<tab>name lines, its progress line left out');
  assert.equal(r.line[0], 'agy'); assert.match(r.line[1], /--model gemini-4-neon/);
  console.log('PASS antigravity: lists agy models, started with --model gemini-4-neon');

  // the pick is remembered per agent; back to Default starts the agent as configured
  r = await newSession('claude', null);
  assert.equal(r.line[1], '', 'default: no model flag');
  console.log('PASS default: no model flag');
})().catch((e) => { failed = true; console.error(e); }).finally(() => { fs.rmSync(fixture, { recursive: true, force: true }); app.exit(failed ? 1 : 0); });
