// Shell tabs on the phone, end to end without a phone or a window: a real local Synapse Cloud, the app's bridge
// (app/phone.mjs), a real zsh in a pty with the headless screen copy the app keeps, and the phone's protocol code.
//   node app/tests/phone-shell.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startCloud } from './cloud-fixture.mjs';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-phone-shell-'));
process.env.SYNAPSE_HOME = home;
process.env.SYNAPSE_DEMO = '1';
const cloud = await startCloud();
process.env.SYNAPSE_CLOUD = cloud.base;
const owner = await cloud.signup('owner@example.com', 'Owner');
fs.writeFileSync(path.join(home, 'account.json'), JSON.stringify({ cloud: cloud.base, token: owner.token, user: owner.user }));

const phone = await import('../phone.mjs');
const link = await import('../../mobile/src/link.js');
const { listAgents } = await import('../../lib.mjs');

// one shell tab, as the app runs it: a pty, and a headless copy of its screen
const cwd = fs.realpathSync(home);
const p = pty.spawn('/bin/zsh', ['-f'], { cols: 80, rows: 12, cwd, env: { ...process.env, PS1: '$ ', TERM: 'xterm-256color' } });
const screen = new Terminal({ cols: 80, rows: 12, scrollback: 1000, allowProposedApi: true });
p.onData((d) => screen.write(d));
const agentWrites = [];
phone.start({
  projects: () => [{ key: cwd, label: 'proj', color: '#2F5BEA', worktrees: [{ path: cwd, name: 'proj', branch: 'main', home: true }] }],
  kinds: () => ['claude'],
  ptyOf: () => '9',
  write: (id, data) => (id === '3' ? p.write(data) : agentWrites.push({ id, data })),
  submit: () => {},
  spawn: () => {},
  changed: () => {},
  shells: () => [{ pty: '3', cwd, title: 'build shell', at: Date.now(), running: null }],
  screenOf: (id) => (id === '3' ? screen : null),
});

const until = async (what, fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 150)); }
};
const inbox = [];
const me = await link.signIn(cloud.base, { email: 'owner@example.com', password: 'correct horse' }, 'Test iPhone');
const [mac] = await until('the Mac registers', async () => { const l = await link.computers(me); return l.length && l; });
const c = link.connect(me, mac);
await c.send({ t: 'hello' });
await until('the Mac asks first', async () => { inbox.push(...await c.poll()); return inbox.some((m) => m.t === 'waiting'); });
phone.allow((await phone.devices()).list[0].id);
inbox.length = 0;
await c.send({ t: 'hello' });
const st = await until('state', async () => { inbox.push(...await c.poll()); return inbox.find((m) => m.t === 'state'); });

// the shell tab is listed with the agents, in its project
const sh = st.agents.find((a) => a.id === 'sh-3');
assert.ok(sh, 'the shell tab is on the phone');
assert.equal(sh.kind, 'shell'); assert.equal(sh.name, 'build shell'); assert.equal(sh.inApp, true); assert.equal(sh.project.label, path.basename(cwd));

// watching it sends its screen; a command typed on the phone runs and its output comes back
await c.send({ t: 'watch', id: 'sh-3' });
const lastScreen = () => [...inbox].reverse().find((m) => m.t === 'screen' && m.id === 'sh-3');
await until('the screen arrives', async () => { inbox.push(...await c.poll()); return lastScreen(); });
await c.send({ t: 'send', id: 'sh-3', text: 'echo "from the$((1+1)) phone"' });
const out = await until('the command output', async () => { inbox.push(...await c.poll()); const s = lastScreen(); return s?.lines.some((l) => l === 'from the2 phone') && s; });
assert.ok(out.lines.some((l) => l.includes('echo "from the$((1+1)) phone"')), 'the typed command shows on the screen');
assert.equal(out.lines.at(out.cursor.y), '$ ', 'the cursor sits on the new prompt');

// keys: Ctrl-C stops a running command; unknown keys are refused
await c.send({ t: 'send', id: 'sh-3', text: 'sleep 30; echo not-stopped' });
await new Promise((r) => setTimeout(r, 600));
await c.send({ t: 'keys', id: 'sh-3', keys: ['ctrl-c'] });
await c.send({ t: 'send', id: 'sh-3', text: 'echo after-stop' });
await until('Ctrl-C stopped the sleep', async () => { inbox.push(...await c.poll()); return lastScreen()?.lines.includes('after-stop'); });
assert.ok(!lastScreen().lines.includes('not-stopped'));
inbox.length = 0;
await c.send({ t: 'keys', id: 'sh-3', keys: ['ctrl-c', 'rm -rf'], req: 'k1' });
const err = await until('unknown keys refused', async () => { inbox.push(...await c.poll()); return inbox.find((m) => m.t === 'error' && m.req === 'k1'); });
assert.match(err.error, /unknown key/);

// the same keys reach an agent's terminal (arrows and Enter to pick an option)
const api = listAgents().find((a) => a.name === 'api-auth');
await c.send({ t: 'keys', id: api.id, keys: ['down', 'enter'] });
await until('keys reach the agent', () => agentWrites.some((w) => w.id === '9' && w.data === '\x1b[B\r'));

// a closed shell answers as closed
await c.send({ t: 'send', id: 'sh-99', text: 'ls', req: 's2' });
const gone = await until('closed shell', async () => { inbox.push(...await c.poll()); return inbox.find((m) => m.t === 'error' && m.req === 's2'); });
assert.match(gone.error, /closed/);

console.log('phone-shell: ok');
p.kill();
await cloud.stop?.();
process.exit(0);
