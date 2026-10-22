const electron = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

if (typeof electron === 'string') {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-restore-'));
  const state = path.join(fixture, 'state'); fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'app.json'), JSON.stringify({ workspaces: [fixture], autoSymlink: false, skipLogin: true, profiles: { shell: { command: 'cat', label: 'Shell' } } }));
  fs.writeFileSync(path.join(state, 'sessions.json'), JSON.stringify({ version: 1, slots: [
    { worktree: fixture, top: 0, focused: false, sessions: [{ key: 'other', kind: 'shell', title: 'Other', parent: null }] },
    { worktree: fixture, top: 0, focused: true, sessions: [{ key: 'parent', kind: 'shell', title: 'Parent', parent: null }, { key: 'child', kind: 'shell', title: 'Child', parent: 0 }] },
  ] }));
  let code = 0;
  for (const phase of ['save', 'restore']) {
    const r = spawnSync(electron, [__filename], { env: { ...process.env, SYNAPSE_RESTORE_FIXTURE: fixture, SYNAPSE_RESTORE_PHASE: phase }, stdio: 'inherit' });
    if (r.status !== 0) { code = r.status || 1; break; }
  }
  fs.rmSync(fixture, { recursive: true, force: true }); process.exit(code);
}

const { app, BrowserWindow } = electron;
const fixture = process.env.SYNAPSE_RESTORE_FIXTURE;
assert.ok(fixture);
Object.assign(process.env, { SYNAPSE_HOME: path.join(fixture, 'state'), SYNAPSE_DEMO: '1', SYNAPSE_DESKTOP_VIEW: 'gui', SHELL: '/bin/sh' });
app.setPath('userData', path.join(fixture, 'electron'));
process.chdir(fixture);
let win, frame, failed = false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 400; i++) { if (await fn()) return; await wait(40); }
  throw new Error(`Timed out: ${label}`);
}
const ui = (s) => frame.executeJavaScript(s, true);
(async () => {
  await import(pathToFileURL(path.resolve(__dirname, '../main.mjs')));
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return win; }, 'window');
  await until(() => { frame = win.webContents.mainFrame.frames.find((f) => f.url.includes('?desktop=1')); return frame; }, 'GUI');
  const phase = process.env.SYNAPSE_RESTORE_PHASE;
  await until(() => ui(`document.querySelectorAll('[data-agent^="desktop-"]').length === ${phase === 'save' ? 3 : 2}`), 'restored sessions');
  if (phase === 'save') {
    await ui(`document.querySelector('[data-agent="desktop-child"]').click(); document.querySelector('#message-input').value = 'Draft across a restart'; document.querySelector('#message-input').dispatchEvent(new Event('input', { bubbles: true }));`);
    await until(() => JSON.parse(fs.readFileSync(path.join(fixture, 'state', 'sessions.json'))).slots[1].top === 1, 'selected fork saved');
    await ui(`document.querySelector('[data-agent="desktop-other"]').click(); document.querySelector('#session-menu').click(); document.querySelector('[data-session-action="close"]').click();`);
    await until(() => ui(`!document.querySelector('[data-agent="desktop-other"]')`), 'earlier session removed');
    await ui(`document.querySelector('[data-agent="desktop-child"]').click();`);
    await until(() => JSON.parse(fs.readFileSync(path.join(fixture, 'state', 'sessions.json'))).slots.length === 1, 'updated session order saved');
    await wait(600);
  } else {
    await until(() => ui(`document.querySelector('[data-agent="desktop-child"]').getAttribute('aria-current') === 'page'`), 'selected fork restored');
    assert.equal(await ui(`document.querySelector('#message-input').value`), 'Draft across a restart');
    const saved = JSON.parse(fs.readFileSync(path.join(fixture, 'state', 'sessions.json')));
    assert.equal(saved.slots.length, 1);
    assert.equal(saved.slots[0].sessions[1].parent, 0);
  }
  console.log(`PASS ${phase}: sessions, selected fork, and GUI draft survive restart without duplicate sessions`);
})().catch((e) => { failed = true; console.error(e); }).finally(() => {
  app.once('will-quit', () => app.exit(failed ? 1 : 0)); app.quit();
});
