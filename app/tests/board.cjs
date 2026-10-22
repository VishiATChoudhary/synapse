// Real Electron test for the friends board in the activity view, against a real local Synapse Cloud: I trust
// Bob and Bob trusts me, Bob is on the board already. Before joining I see an invitation and that one friend is
// waiting; joining sends my last 7 days and ranks us; the tabs change what we are ranked by; leaving takes me off.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/board.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const guiMode = process.env.SYNAPSE_DESKTOP_VIEW === 'gui';
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-board-')));
const state = path.join(fixture, 'state'), claude = path.join(fixture, 'claude'), codex = path.join(fixture, 'codex');
for (const d of [state, claude, codex, path.join(fixture, 'gh')]) fs.mkdirSync(d, { recursive: true });
// one Claude conversation today with 3 prompts and a reply that used tokens
const now = new Date().toISOString();
fs.mkdirSync(path.join(claude, 'projects', 'p'), { recursive: true });
fs.writeFileSync(path.join(claude, 'projects', 'p', 's.jsonl'), [
  ...[1, 2, 3].map((i) => JSON.stringify({ type: 'user', timestamp: now, message: { role: 'user', content: `prompt ${i}` } })),
  JSON.stringify({ type: 'assistant', timestamp: now, message: { id: 'm1', model: 'claude-x', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 4000, output_tokens: 2000 } } }),
].join('\n') + '\n');
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [], profiles: { shell: { command: 'cat', label: 'Shell' } } }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_DEMO: '1', SYNAPSE_DESKTOP_VIEW: guiMode ? 'gui' : 'terminal', CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, GH_CONFIG_DIR: path.join(fixture, 'gh'), SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'GH_TOKEN' || key === 'GITHUB_TOKEN') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
let win, cloud, gui;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
const js = (code) => (gui || win.webContents).executeJavaScript(code, true);
const api = (token, method, route, body) => fetch(cloud.base + route, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const ranks = () => js(`[...document.querySelectorAll('.act-rank')].map((r) => r.querySelector('.who b').textContent + ' ' + r.querySelector('.n').textContent)`);

(async () => {
  try {
    cloud = await (await import(pathToFileURL(path.join(__dirname, 'cloud-fixture.mjs')))).startCloud();
    process.env.SYNAPSE_CLOUD = cloud.base;
    const me = await cloud.signup('me@example.com', 'Me'), bob = await cloud.signup('bob@example.com', 'Bob Builder');
    await api(me.token, 'POST', '/v1/trusted', { who: '@bob' });
    await api(bob.token, 'POST', '/v1/trusted', { who: '@me' });
    await api(bob.token, 'PUT', '/v1/board', { tokens: 9_000_000, tokensOut: 50_000, prompts: 1, code: 0, activeDays: 6, streak: 12, level: 4, xp: 1200 });
    fs.writeFileSync(path.join(state, 'account.json'), JSON.stringify({ cloud: cloud.base, token: me.token, user: me.user }));

    await import(pathToFileURL(path.join(root, 'app/main.mjs')));
    await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
    win.show();
    if (guiMode) await until(() => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
    const activity = guiMode ? '#desktop-activity' : '#btn-activity';
    await until(() => js(`!!document.querySelector(${JSON.stringify(activity)})`), 'activity navigation');
    await js(`document.querySelector(${JSON.stringify(activity)}).click()`);
    await until(() => js(`!!document.querySelector('.act-board-join')`), 'the board invitation');
    const invite = await js(`document.querySelector('.act-board-join').textContent`);
    assert.match(invite, /1 of them is on the board already/, 'says a friend is waiting');
    assert.equal(await js(`document.querySelectorAll('.act-rank').length`), 0, 'no numbers before joining');

    await js(`document.querySelector('.act-board-join button').click()`);
    await until(async () => (await ranks()).length === 2, 'ranked after joining');
    assert.deepEqual(await ranks(), ['Bob Builder 9M', 'You 6K'], 'by tokens: Bob first');
    const sent = await api(bob.token, 'GET', '/v1/board');
    assert.deepEqual(sent.people.find((p) => !p.me) && { prompts: sent.people.find((p) => !p.me).prompts, tokens: sent.people.find((p) => !p.me).tokens }, { prompts: 3, tokens: 6000 }, 'my last 7 days reached the cloud');
    if (process.env.SYNAPSE_BOARD_SHOT) { await sleep(400); fs.writeFileSync(process.env.SYNAPSE_BOARD_SHOT, (await win.webContents.capturePage()).toPNG()); }

    await js(`[...document.querySelectorAll('.act-board-by button')].find((b) => b.textContent === 'prompts').click()`);
    await until(async () => (await ranks())[0] === 'You 3', 'by prompts: me first');
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'app.json'), 'utf8')).board, true, 'joining is remembered');

    await js(`document.querySelector('.act-board-leave').click()`);
    await until(() => js(`!!document.querySelector('.act-board-join')`), 'back to the invitation');
    assert.equal((await api(bob.token, 'GET', '/v1/board')).people.length, 1, 'leaving took me off the board of Bob');
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#mode-gui').getAttribute('aria-pressed')`, true), String(guiMode), 'Activity keeps the chosen UI mode');
    console.log(`PASS ${guiMode ? 'GUI' : 'Terminal'} friends board: invitation, join sends my week and ranks us, rank by prompts, leave without switching mode`);
    cloud.stop();
    app.exit(0);
  } catch (e) {
    console.error(e);
    cloud?.stop();
    app.exit(1);
  }
})();
