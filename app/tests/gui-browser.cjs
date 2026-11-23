// Real Electron test for the agent browser: an agent opens a site (you allow it in the panel first), reads the
// page, clicks and types; you watch it in the agent's panel, take over and hand back, pop it out into its own
// window and dock it back next to the agent. Signing in with a vault login (a stand-in vault, not the Keychain):
// you approve, the page gets the password, the agent never does.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/gui-browser.cjs
const { app, BrowserWindow } = require('electron');
// a site that is not local, so the agent has to ask for it (it resolves to this machine)
app.commandLine.appendSwitch('host-resolver-rules', 'MAP shop.example 127.0.0.1, MAP news.example 127.0.0.1');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-gui-browser-')));
const state = path.join(fixture, 'state'), bin = path.join(fixture, 'bin'), claudeHome = path.join(fixture, 'claude'), ctl = path.join(fixture, 'ctl');
for (const d of [state, bin, ctl, path.join(claudeHome, 'sessions')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
let slot = 0; for (;; slot++) { try { fs.writeFileSync(path.join(${JSON.stringify(ctl)}, 'slot-' + slot), String(process.pid), { flag: 'wx' }); break; } catch {} }
const file = path.join(${JSON.stringify(path.join(claudeHome, 'sessions'))}, process.pid + '.json');
const control = path.join(${JSON.stringify(ctl)}, 'state-' + slot);
let status = '';
const tick = () => {
  let want = 'busy'; try { want = fs.readFileSync(control, 'utf8').trim() || 'busy'; } catch {}
  if (want !== status) { status = want; fs.writeFileSync(file, JSON.stringify({ sessionId: 'stand-in-' + process.pid, pid: process.pid, cwd: process.cwd(), status, startedAt: Date.now(), updatedAt: Date.now() })); }
  process.stdout.write('agent ' + slot + ' working ' + Date.now() + '\\r\\n');
};
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', (d) => fs.appendFileSync(path.join(${JSON.stringify(ctl)}, 'typed-' + slot), d.toString()));
tick(); setInterval(tick, 250);
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], browserAskSites: true, skipLogin: true, profiles: { claude: { command: `exec ${path.join(bin, 'claude')}`, label: 'Claude' } } }));
fs.writeFileSync(path.join(state, 'workspace-ui.json'), JSON.stringify({ 'synapse-group': 'status' }));
const vaultHome = path.join(fixture, 'vault'); fs.mkdirSync(vaultHome);
fs.writeFileSync(path.join(vaultHome, 'index.json'), JSON.stringify({ SHOP_EXAMPLE_PASSWORD: { type: 'login', site: 'shop.example', user: 'ada@shop.example' }, SHOP_EXAMPLE_USERNAME: { type: 'login', site: 'shop.example', user: 'ada@shop.example' }, OTHER_ORG_PASSWORD: { type: 'login', site: 'other.org', user: 'x' } }));
fs.writeFileSync(path.join(fixture, 'fake-vault.json'), JSON.stringify({ SHOP_EXAMPLE: { username: 'ada@shop.example', password: 'pw-Secret-123' } }));
Object.assign(process.env, { VAULT_HOME: vaultHome, SYNAPSE_VAULT_FAKE: path.join(fixture, 'fake-vault.json'), SYNAPSE_LOGINS_TEST_CRYPTO: '1' });
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
// the GUI frame is looked up on each call (a reload replaces it), and a call to a frame going away gives up
const ui = (code) => { const f = win.webContents.mainFrame.frames.find((x) => x.url.includes('?desktop=1')) || gui; return Promise.race([f.executeJavaScript(code, true), sleep(3000).then(() => { throw new Error('frame did not answer'); })]); };
const native = (code) => win.webContents.executeJavaScript(code, true);
const pidOf = (slot) => fs.readFileSync(path.join(ctl, `slot-${slot}`), 'utf8').trim();
const set = (slot, status) => fs.writeFileSync(path.join(ctl, `state-${slot}`), status);

const typed = () => { try { return fs.readFileSync(path.join(ctl, 'typed-0'), 'utf8'); } catch { return ''; } };
const send = (text) => ui(`(() => { const i = document.querySelector('#message-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); })()`);
const queue = () => ui(`[...document.querySelectorAll('#prompt-queue .queued-text')].map((e) => e.textContent)`);
const key = (k) => ui(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', metaKey: true, bubbles: true }))`);


const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url.startsWith('/closes')) return res.end(`<!doctype html><title>Done</title><p>Signed in, closing</p><script>setTimeout(() => window.close(), 300)</script>`);
  if (req.url.startsWith('/login')) return res.end(`<!doctype html><title>Sign in</title><h1 id="h">Sign in</h1>
    <form onsubmit="event.preventDefault(); window.got = { u: this.email.value, p: this.password.value }; document.getElementById('h').textContent = 'Welcome ' + this.email.value"><input type="email" name="email" autocomplete="username"><input type="password" name="password"></form>`);
  res.end(`<!doctype html><title>Test shop</title><h1 id="h">Welcome</h1>
    <button onclick="document.getElementById('h').textContent = 'Clicked'">Buy now</button>
    <form onsubmit="event.preventDefault(); document.getElementById('h').textContent = 'Searched ' + this.q.value"><input name="q" placeholder="Search"></form>`);
});
const act = async (action, args = {}) => {
  const at = JSON.parse(fs.readFileSync(path.join(state, 'agent-browser.json'), 'utf8'));
  const r = await fetch(`http://127.0.0.1:${at.port}/act`, { method: 'POST', headers: { authorization: `Bearer ${at.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agent: agentKey, action, args }) });
  return r.json();
};
let agentKey;
const views = (w) => w.contentView.children.length;
// click once it is there (the panel redraws now and then)
const tap = (sel) => until(() => ui(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`), `click ${sel}`);
// SHOT_DIR=<dir>: also save what it looks like
const shot = async (w, name) => { if (process.env.SHOT_DIR) { await sleep(700); fs.writeFileSync(path.join(process.env.SHOT_DIR, `browser-${name}.png`), (await w.webContents.capturePage()).toPNG()); } };

(async () => {
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://shop.example:${site.address().port}/`;
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1500, height: 950 }); win.show();
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  await until(async () => { gui = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return gui; }, 'GUI frame');
  await until(() => native(`[...document.querySelectorAll('#launch .launch-item')].some((b) => b.textContent.trim() === 'Claude')`), 'Claude launcher');
  await native(`[...document.querySelectorAll('#launch .launch-item')].find((b) => b.textContent.trim() === 'Claude').click()`);
  await until(() => fs.existsSync(path.join(ctl, 'slot-0')), 'agent started');
  set(0, 'idle');
  await until(() => ui(`!!document.querySelector('#project-list .session-row[data-agent^="desktop-"]') && location.hash.includes('desktop-')`).catch(() => false), 'agent selected', 20000);
  const { listAgents } = await import(pathToFileURL(path.join(root, 'lib.mjs')));
  await until(() => { agentKey = listAgents().find((x) => String(x.pid) === pidOf(0))?.id; return agentKey; }, 'agent id');
  // the app matches its session to the agent's own id (a second or so)
  await until(() => ui(`document.body.dataset.browserAgent`).then((k) => k === agentKey), 'session matched to its agent', 60000);
  assert.ok(fs.existsSync(path.join(state, 'agent-browser.json')), 'the endpoint is written');
  assert.equal(fs.statSync(path.join(state, 'agent-browser.json')).mode & 0o777, 0o600, 'readable by you only');

  // a wrong token is refused
  const at = JSON.parse(fs.readFileSync(path.join(state, 'agent-browser.json'), 'utf8'));
  assert.equal((await fetch(`http://127.0.0.1:${at.port}/act`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })).status, 403);

  // the panel is on Details; an agent opening a page switches it to the Browser tab (on by default)
  await ui(`(() => { const b = document.getElementById('context-toggle'); if (b.getAttribute('aria-expanded') !== 'true') b.click(); })()`);
  await tap('[data-inspector-tab="details"]');
  await until(() => ui(`!!document.querySelector('.watch-section, .inspector-section') && !document.querySelector('.browser-pane')`), 'on Details');
  await act('open', { url: `http://127.0.0.1:${site.address().port}/` }); // local: no question
  await until(() => ui(`!!document.querySelector('.browser-pane')`), 'switched to the Browser tab by itself');
  // turned off in Settings: it stays where it is
  await native(`synapse.settings.set({ showBrowser: false })`);
  await tap('[data-inspector-tab="details"]');
  await until(() => ui(`!document.querySelector('.browser-pane')`), 'back on Details');
  await act('open', { url: `http://127.0.0.1:${site.address().port}/` });
  await sleep(1200);
  assert.equal(await ui(`!!document.querySelector('.browser-pane')`), false, 'stays on Details when turned off');
  await native(`synapse.settings.set({ showBrowser: true })`);
  await tap('[data-inspector-tab="browser"]');
  await until(() => ui(`!!document.querySelector('.browser-pane')`), 'browser tab');

  // the agent opens a site you have not allowed: it waits, the panel asks
  const opening = act('open', { url });
  await until(() => ui(`!!document.querySelector('.browser-ask')`), 'asked to allow the site');
  assert.match(await ui(`document.querySelector('.browser-ask').textContent`), /shop\.example/);
  await shot(win, 'ask');
  await tap('[data-browser-answer="once"]');
  const opened = await opening;
  assert.ok(!opened.error, opened.error);
  assert.equal(opened.value.title, 'Test shop');
  const buy = opened.value.elements.split('\n').find((l) => l.includes('Buy now')), search = opened.value.elements.split('\n').find((l) => l.includes('Search'));
  assert.ok(buy && search, opened.value.elements);

  // you see it: the page sits over the panel's browser area
  await until(() => views(win) === 1, 'page shown in the panel');
  const slot = await ui(`(() => { const r = document.getElementById('browser-slot').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  const vb = win.contentView.children[0].getBounds();
  assert.ok(Math.abs(vb.width - slot.w) <= 2 && Math.abs(vb.height - slot.h) <= 2, `view ${JSON.stringify(vb)} on slot ${JSON.stringify(slot)}`);
  await until(() => ui(`/Test shop/.test(document.querySelector('.browser-tab.on')?.textContent || '')`), 'its tab in the panel');

  // Allow covers the whole browser: another site opens without asking again
  const other = await act('open', { url: `http://news.example:${site.address().port}/` });
  assert.ok(!other.error, other.error);
  assert.equal(await ui(`!!document.querySelector('.browser-ask')`), false, 'no second question');
  await act('open', { url });

  // drag the panel's left edge: it widens, the page follows, the width is kept; Full size takes the chat's room
  const frameAt = await native(`(() => { const r = document.querySelector('#workspace-frame').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
  const grip = await ui(`(() => { const g = document.getElementById('panel-grip'); if (g.hidden) return null; const r = g.getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2 }; })()`);
  assert.ok(grip, 'the panel has a grip');
  const widthBefore = await ui(`document.getElementById('inspector').getBoundingClientRect().width`);
  const gx = Math.round(frameAt.x + grip.x), gy = Math.round(frameAt.y + grip.y);
  // real mouse input through CDP (sendInputEvent does not reach the GUI's own frame)
  const dbg = win.webContents.debugger; if (!dbg.isAttached()) dbg.attach('1.3');
  const mouse = (type, x) => dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y: gy, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await mouse('mousePressed', gx);
  for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', gx - i * 15); await sleep(20); }
  await mouse('mouseReleased', gx - 150);
  dbg.detach();
  await until(async () => (await ui(`document.getElementById('inspector').getBoundingClientRect().width`)) > widthBefore + 120, 'the panel is wider');
  assert.ok(Number(await ui(`localStorage.getItem('synapse-panel-width')`)) > widthBefore + 120, 'the width is kept');
  await until(async () => { const s2 = await ui(`Math.round(document.getElementById('browser-slot').getBoundingClientRect().width)`); return views(win) === 1 && Math.abs(win.contentView.children[0].getBounds().width - s2) <= 2; }, 'the page follows the new width');
  await tap('[data-action="panel-full"]');
  await until(() => ui(`document.getElementById('thread-view').offsetWidth === 0 && document.getElementById('inspector').getBoundingClientRect().width > innerWidth - 400`), 'full size');
  await until(async () => views(win) === 1 && win.contentView.children[0].getBounds().width > 900, 'the page fills it');
  await shot(win, 'full');
  await tap('[data-action="panel-full"]');
  await until(() => ui(`document.getElementById('thread-view').offsetWidth > 0`), 'back to the side');
  await ui(`document.getElementById('panel-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await until(() => ui(`!localStorage.getItem('synapse-panel-width')`), 'double-click resets the width');
  // the prompt hook learns which pages the agent has open
  await until(() => { try { return JSON.parse(fs.readFileSync(path.join(state, 'agent-browser-tabs.json'), 'utf8'))[agentKey]?.[0]?.url === url; } catch { return false; } }, 'open pages written for the hook');

  // click and type by number
  const clicked = await act('click', { ref: Number(buy.match(/\[(\d+)\]/)[1]) });
  assert.match(clicked.value.text, /Clicked/);
  const typed = await act('type', { ref: Number(search.match(/\[(\d+)\]/)[1]), text: 'shoes', submit: true });
  assert.match(typed.value.text, /Searched shoes/);
  const picture = await act('screenshot');
  assert.ok(picture.value.image.length > 1000, 'a screenshot');
  await shot(win, 'panel'); if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, 'browser-page.png'), (await win.contentView.children[0].webContents.capturePage()).toPNG());
  assert.doesNotMatch(await ui(`document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent`), /wants to open/, 'no toast for the agent you are looking at');

  // you take over: the agent waits; you hand back
  await until(() => ui(`!!document.querySelector('[data-browser="pause"]')`), 'take over button');
  await tap('[data-browser="pause"]');
  await until(async () => /taken over/.test((await act('read')).error || ''), 'agent waits while you have it');
  await until(() => ui(`!!document.querySelector('[data-browser="resume"]')`), 'hand back button');
  await tap('[data-browser="resume"]');
  await until(async () => !(await act('read')).error, 'agent can use it again');

  // pop out into its own window, then back to the agent
  await tap('[data-browser="pop"]');
  await until(() => BrowserWindow.getAllWindows().length === 2, 'popped window');
  const popped = BrowserWindow.getAllWindows().find((w) => w !== win);
  await until(() => views(popped) === 1 && views(win) === 0, 'page moved to its window');
  await until(() => ui(`/own window/.test(document.querySelector('.browser-pane').textContent)`), 'panel says where it is');
  await shot(win, 'popped-panel'); await shot(popped, 'popped-window');
  await until(() => popped.webContents.executeJavaScript(`document.getElementById('url').value`).then((v) => v.startsWith('http://shop.example')), 'popped bar shows the address');
  await popped.webContents.executeJavaScript(`document.getElementById('dock').click()`);
  await until(() => BrowserWindow.getAllWindows().length === 1, 'popped window closed');
  await until(() => views(win) === 1, 'docked back in the panel');

  // a sheet over the GUI hides the page; switching to Details hides it too
  await tap('[data-inspector-tab="details"]');
  await until(() => views(win) === 0, 'hidden on Details');
  await tap('[data-inspector-tab="browser"]');
  await until(() => views(win) === 1, 'back on Browser');

  // always allow: a second agent call to the site does not ask
  const again = await act('new_tab', { url });
  assert.ok(!again.error, again.error);
  assert.equal(await ui(`document.querySelectorAll('.browser-tab').length`), 2);

  // sign in with the vault: the agent asks, you approve, the page gets the password, the agent does not
  await act('open', { url: `${url}login` });
  const listed = await act('logins');
  assert.deepEqual(listed.value.logins, ['ada@shop.example']);
  await until(() => ui(`!!document.getElementById('browser-vault')`), 'vault key button for this site');
  const signing = act('login');
  await until(() => ui(`!!document.querySelector('.browser-ask.login')`), 'asked to approve the sign-in');
  assert.match(await ui(`document.querySelector('.browser-ask.login').textContent`), /ada@shop\.example/);
  await shot(win, 'login-ask');
  await tap('.browser-ask.login [data-browser-answer="once"]');
  const signed = await signing;
  assert.ok(!signed.error, signed.error);
  assert.equal(signed.value.signedInAs, 'ada@shop.example');
  assert.match(signed.value.page.text, /Welcome ada@shop\.example/);
  const page = win.contentView.children[0].webContents;
  assert.deepEqual(await page.executeJavaScript('window.got'), { u: 'ada@shop.example', p: 'pw-Secret-123' }, 'the page got the login');
  assert.ok(!JSON.stringify(signed).includes('pw-Secret-123'), 'the agent never sees the password');
  assert.ok(!JSON.stringify(await act('read')).includes('pw-Secret-123'), 'not in what it reads either');
  await page.executeJavaScript(`document.querySelector('input[name=password]').type = 'text'`); // a show-password switch
  assert.ok(!JSON.stringify(await act('read')).includes('pw-Secret-123'), 'still hidden when the field shows as text');
  // a site with no saved login: told so
  await act('open', { url });
  // allowed once for this agent: a second sign-in does not ask again
  await act('open', { url: `${url}login` });
  const again2 = await act('login');
  assert.ok(!again2.error, again2.error);

  // a page that closes itself (a sign-in popup does): its tab goes away and nothing breaks
  const before = (await act('tabs')).value.tabs.length;
  await act('new_tab', { url: `${url}closes` });
  await until(async () => (await act('tabs')).value.tabs.length === before, 'the closed page left the tabs', 15000);
  await sleep(500);
  assert.ok(!(await act('read')).error, 'the browser still works');
  await until(() => ui(`document.querySelectorAll('.browser-tab').length`).then((n) => n === before), 'the panel lost the tab too');
  console.log('PASS a page that closes itself: its tab goes, nothing crashes');

  // a login added in Settings > Logins: listed with the vault's, signs in the same way, never stored or shown in clear
  await native(`document.querySelector('#desktop-settings')?.click()`);
  await until(() => native(`!!document.querySelector('[data-settings-pane="logins"]')`), 'settings open');
  await native(`document.querySelector('[data-settings-pane="logins"]').click()`);
  await until(() => native(`/Vault/.test(document.querySelector('.login-list')?.textContent || '')`), 'the vault login is listed');
  await native(`(() => { const [s, u, p] = document.querySelectorAll('.login-form input'); s.value = 'https://shop.example/login'; u.value = 'grace@shop.example'; p.value = 'pw-Grace-789'; document.querySelector('.login-form').requestSubmit(); })()`);
  await until(() => native(`/grace@shop\.example/.test(document.querySelector('.login-list').textContent)`), 'saved and listed');
  assert.equal(await native(`document.querySelector('.login-form input[type=password]').value`), '', 'the field is cleared');
  const stored = fs.readFileSync(path.join(state, 'logins.json'), 'utf8');
  assert.ok(stored.includes('shop.example') && !stored.includes('pw-Grace-789'), 'stored encrypted');
  if (process.env.SHOT_DIR) { await sleep(400); const d = win.webContents.debugger; d.attach('1.3'); fs.writeFileSync(path.join(process.env.SHOT_DIR, 'browser-logins.png'), Buffer.from((await d.sendCommand('Page.captureScreenshot', { format: 'png' })).data, 'base64')); d.detach(); }
  await native(`document.querySelector('.set-close').click()`);
  assert.deepEqual((await act('logins')).value.logins.sort(), ['ada@shop.example', 'grace@shop.example']);
  await act('open', { url: `${url}login` });
  const grace = act('login', { user: 'grace@shop.example' });
  await until(() => ui(`/grace@shop\\.example/.test(document.querySelector('.browser-ask.login')?.textContent || '')`), 'asked to approve the Settings login');
  await tap('.browser-ask.login [data-browser-answer="once"]');
  const graced = await grace;
  assert.ok(!graced.error, graced.error);
  assert.deepEqual(await page.executeJavaScript('window.got'), { u: 'grace@shop.example', p: 'pw-Grace-789' }, 'the page got the Settings login');
  assert.ok(!JSON.stringify(graced).includes('pw-Grace-789'), 'the agent never sees it');
  // removed from Settings: gone for the agent too
  await native(`document.querySelector('#desktop-settings').click()`);
  await until(() => native(`!!document.querySelector('[data-settings-pane="logins"]')`), 'settings again');
  await native(`document.querySelector('[data-settings-pane="logins"]').click()`);
  await until(() => native(`[...document.querySelectorAll('.login-row')].some((r) => /grace/.test(r.textContent) && r.querySelector('button'))`), 'its Remove button');
  await native(`[...document.querySelectorAll('.login-row')].find((r) => /grace/.test(r.textContent)).querySelector('button').click()`);
  await until(() => native(`!/grace/.test(document.querySelector('.login-list').textContent)`), 'removed');
  await native(`document.querySelector('.set-close').click()`);
  assert.deepEqual((await act('logins')).value.logins, ['ada@shop.example']);

  assert.doesNotMatch(await ui(`document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent`), /Could not save/, 'the panel tab is saved');
  assert.deepEqual(errors.filter((e) => !/favicon|ERR_/.test(e)), []);
  console.log('gui-browser: ok');
})().catch((e) => { failed = true; console.error(e); }).finally(() => { site.close(); app.exit(failed ? 1 : 0); });
