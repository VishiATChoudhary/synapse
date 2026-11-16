// Real Electron test: every settings page scrolls (mouse wheel) when it is taller than the window, in GUI mode.
// Run: SYNAPSE_APP_PORT=<free port> npx electron tests/settings-scroll.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-settings-scroll-')));
const state = path.join(fixture, 'state'), claudeHome = path.join(fixture, 'claude');
for (const d of [state, path.join(claudeHome, 'sessions')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], skipLogin: true, profiles: { claude: { command: 'claude', label: 'Claude' }, codex: { command: 'codex', label: 'Codex' } } }));
Object.assign(process.env, { SYNAPSE_HOME: state, SYNAPSE_CLAUDE_HOME: claudeHome, SYNAPSE_CLOUD: 'http://127.0.0.1:9', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/zsh' });
for (const key of Object.keys(process.env)) if (key.startsWith('SYNAPSE_SHOT') || key === 'SYNAPSE_DEBUG' || key === 'SYNAPSE_DEMO') delete process.env[key];
process.chdir(fixture);
app.setPath('userData', path.join(fixture, 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await Promise.resolve().then(check).catch(() => false)) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
let failed = false;
(async () => {
  let win;
  await import(pathToFileURL(path.join(root, 'app/main.mjs')));
  await until(async () => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'app window');
  win.setBounds({ width: 1200, height: 760 }); win.show();
  await until(() => win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')), 'GUI frame');
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await until(() => js(`!!document.querySelector('#desktop-settings')`), 'settings button');
  await js(`document.querySelector('#desktop-settings').click()`);
  await until(() => js(`!!document.querySelector('.set-scroll')`), 'settings open');
  const panes = await js(`[...document.querySelectorAll('[data-settings-pane]')].map((b) => b.dataset.settingsPane)`);
  let scrolled = 0;
  for (const pane of panes) {
    await js(`document.querySelector('[data-settings-pane="${pane}"]').click()`);
    await sleep(250);
    const m = await js(`(() => { const s = document.querySelector('.set-scroll'), r = s.getBoundingClientRect(), card = document.querySelector('.modal-card').getBoundingClientRect(); s.scrollTop = 0; return { sh: s.scrollHeight, ch: s.clientHeight, bottom: r.bottom, cardBottom: card.bottom, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    assert.ok(m.bottom <= m.cardBottom + 1, `${pane}: the pane ends inside the window (${m.bottom} > ${m.cardBottom})`);
    if (m.sh <= m.ch + 4) continue; // short page
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(m.x), y: Math.round(m.y), deltaX: 0, deltaY: -400 });
    await until(() => js(`document.querySelector('.set-scroll').scrollTop > 0`), `${pane} scrolls with the wheel`, 3000);
    scrolled++;
  }
  assert.ok(scrolled >= 2, `long pages scrolled: ${scrolled} of ${panes.length}`);
  console.log(`settings-scroll: ok (${scrolled} long pages of ${panes.length})`);
})().catch((e) => { failed = true; console.error(e); }).finally(() => app.exit(failed ? 1 : 0));
