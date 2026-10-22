// Real Electron test for the sounds and the first-launch setup. Settings > done sound picks Bubble tap (the
// default), Perk or None, and plays the pick; error sound (purr) plays on an error toast and can be turned off.
// Setup runs by itself (SYNAPSE_AUTO_SETUP=1 stands in for the installed app's first launch) into a home of its
// own: the synapse skill, hooks and MCP entries land there, and `claude` is a fake that records what it was asked.
// HOME is the fixture too, so nothing here can touch the real agent configs.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/cues.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-cues-ui-')));
const state = path.join(fixture, 'state'), home = path.join(fixture, 'home'), bin = path.join(fixture, 'bin'), calls = path.join(fixture, 'claude-calls');
for (const d of [state, home, bin, path.join(home, '.claude'), path.join(home, '.codex')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\n[ "$2" = get ] && exit 1\nexit 0\n`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { shell: { command: 'cat', label: 'Shell' } } }));
fs.writeFileSync(path.join(state, 'seen.json'), JSON.stringify({ intro: true, onboarding: true }));
Object.assign(process.env, {
  HOME: home, SYNAPSE_USER_HOME: home, CODEX_HOME: path.join(home, '.codex'), SYNAPSE_HOME: state, SYNAPSE_AUTO_SETUP: '1',
  PATH: `${bin}:/usr/bin:/bin`, SHELL: '/bin/sh', SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'terminal',
});
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || ['SYNAPSE_DEBUG', 'SYNAPSE_DEMO', 'SYNAPSE_FAKE_REQUESTS', 'CLAUDE_CONFIG_DIR'].includes(key)) delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.race([Promise.resolve().then(check), sleep(5000).then(() => false)]).catch(() => false)) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const settings = () => JSON.parse(fs.readFileSync(path.join(state, 'app.json'), 'utf8'));
// every oscillator the page starts, by its first frequency: 480 Hz is Bubble tap, 330 Hz Perk, 92 Hz purr
const heard = () => js(`window.__tones.splice(0)`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  await until(() => js(`!!document.querySelector('#settings')`), 'the app');
  await js(`window.__toasts = []; new MutationObserver(() => window.__toasts.push(document.querySelector('#toast').textContent)).observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true }); true`);
  await js(`window.__tones = []; const make = AudioContext.prototype.createOscillator; AudioContext.prototype.createOscillator = function () { const o = make.call(this); const set = o.frequency.setValueAtTime.bind(o.frequency); let first = true; o.frequency.setValueAtTime = (v, t) => { if (first) { window.__tones.push(Math.round(v)); first = false; } return set(v, t); }; return o; }; true`);

  // first launch: the setup ran by itself into the fixture's home
  const skill = path.join(home, '.claude', 'skills', 'synapse');
  await until(() => fs.existsSync(skill), 'the synapse skill installed', 40000);
  assert.equal(fs.realpathSync(skill), fs.realpathSync(path.join(root, 'skill')));
  assert.ok(fs.existsSync(path.join(home, '.codex', 'skills', 'synapse')), 'and for Codex');
  assert.match(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), /hook\.mjs/, 'the Claude hook');
  assert.match(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /\[mcp_servers\.synapse\]/, 'the Codex MCP server');
  await until(() => fs.existsSync(calls) && /mcp add -s user synapse/.test(fs.readFileSync(calls, 'utf8')), 'claude mcp add');
  await until(() => JSON.parse(fs.readFileSync(path.join(state, 'seen.json'), 'utf8')).setup, 'setup remembered for this version');
  await until(() => js(`window.__toasts.some((t) => /set up in your agents/.test(t))`), 'the app says it set up');

  // Settings: done sound
  await js(`document.querySelector('#settings').click()`);
  await until(() => js(`!!document.querySelector('#modal .sound-seg')`), 'done sound in settings');
  assert.deepEqual(await js(`[...document.querySelectorAll('#modal .sound-seg button')].map((b) => b.textContent)`), ['Bubble tap', 'Perk', 'None']);
  assert.equal(await js(`document.querySelector('#modal .sound-seg .on').textContent`), 'Bubble tap', 'Bubble tap by default');
  await heard();
  await js(`document.querySelector('#modal .sound-seg [data-sound="perk"]').click()`);
  await until(() => settings().doneSound === 'perk', 'perk saved');
  await until(async () => (await js(`window.__tones.includes(330)`)), 'perk plays when picked');
  assert.equal(await js(`document.querySelector('#modal .sound-seg .on').textContent`), 'Perk');
  await sleep(200);
  await js(`document.querySelector('#modal .sound-seg [data-sound="bubbleTap"]').click()`);
  await until(async () => (await js(`window.__tones.includes(480)`)), 'bubble tap plays when picked');

  // error sound: a failing action purrs; off, it stays quiet
  await heard(); await sleep(200);
  const errRow = `[...document.querySelectorAll('#modal .opt')].find((o) => o.textContent.startsWith('error sound'))`;
  assert.equal(await js(`${errRow}.querySelector('input').checked`), true, 'error sound on by default');
  await js(`(() => { const i = ${errRow}.querySelector('input'); i.click(); })()`);
  await until(() => settings().errorSound === false, 'error sound off saved');
  await js(`(() => { const i = ${errRow}.querySelector('input'); i.click(); })()`);
  await until(() => settings().errorSound === true, 'error sound back on');
  await until(async () => (await js(`window.__tones.includes(92)`)), 'turning it on plays the purr');

  assert.deepEqual(errors, []);
  console.log('cues: ok');
  app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
