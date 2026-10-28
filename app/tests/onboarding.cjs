// Real Electron test for the first-run tour: a new install (no app.json yet) opens on it, the arrows and dots move
// through the six steps, "not now" on the last one ends it without the sign-in screen coming back, it is marked
// seen in seen.json (so it does not come back), and settings can replay it.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/onboarding.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-onboarding-')));
const state = path.join(fixture, 'state');
fs.mkdirSync(state); // no app.json: a first run
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_ONBOARDING') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win;
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(50); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => win.webContents.executeJavaScript(code, true);
const title = () => js(`document.querySelector('#onboard .ob-title')?.textContent || ''`);
const key = (k) => js(`document.querySelector('#onboard').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);
const button = (label) => js(`[...document.querySelectorAll('#onboard .ob-actions button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);

(async () => {
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  win.show();
  await until(() => js(`!document.querySelector('#onboard').hidden`), 'the tour opens on a first run');
  assert.equal(await title(), 'Your agents, connected');
  assert.equal(await js(`document.querySelector('#login').hidden`), true, 'the tour comes before the sign-in screen');
  await key('ArrowRight');
  assert.equal(await title(), 'Bring your chats');
  await key('ArrowLeft');
  assert.equal(await title(), 'Your agents, connected');
  await js(`document.querySelectorAll('#onboard .ob-dots button')[5].click()`);
  assert.equal(await title(), 'Keep score');
  assert.deepEqual(await js(`[...document.querySelectorAll('#onboard .ob-actions button')].map((b) => b.textContent)`), ['back', 'not now', 'sign in'], 'the last step offers sign-in');
  await button('not now');
  await until(() => js(`document.querySelector('#onboard').hidden`), 'not now ends the tour');
  assert.equal(await js(`document.querySelector('#login').hidden`), true, 'and does not open the sign-in screen');
  await until(() => fs.existsSync(path.join(state, 'seen.json')) && JSON.parse(fs.readFileSync(path.join(state, 'seen.json'), 'utf8')).onboarding, 'marked seen');
  await until(() => JSON.parse(fs.readFileSync(path.join(state, 'app.json'), 'utf8')).skipLogin === true, 'not now remembers to skip the sign-in screen');
  assert.equal((await js(`synapse.onboarding.get()`)).show, false, 'seen: it does not come back');

  // replay from settings
  await js(`document.querySelector('#settings').click()`);
  await until(() => js(`[...document.querySelectorAll('#modal .opt')].some((r) => /tour/.test(r.textContent))`), 'tour row in settings');
  await js(`[...document.querySelectorAll('#modal .opt')].find((r) => /tour/.test(r.textContent)).querySelector('button').click()`);
  await until(() => js(`!document.querySelector('#onboard').hidden && document.querySelector('#modal').hidden`), 'replay opens the tour and closes settings');
  assert.equal(await title(), 'Your agents, connected', 'from the first step');
  await key('Escape');
  await until(() => js(`document.querySelector('#onboard').hidden`), 'esc closes it');

  assert.deepEqual(errors, []);
  console.log('onboarding: ok');
  app.quit();
})().catch((e) => { console.error(e); app.exit(1); });
