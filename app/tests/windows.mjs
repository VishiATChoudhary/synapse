// Windows smoke test, run on a Windows machine (CI: .github/workflows/windows.yml) with Electron as Node, so
// node-pty loads the same prebuild the app does:
//   set ELECTRON_RUN_AS_NODE=1 && app\node_modules\electron\dist\electron.exe app\tests\windows.mjs
// Starts a fake `codex` the way the app starts agents (cmd.exe in a ConPTY), and checks Synapse finds it through
// the PowerShell process table, in the terminal's folder, matched back to that terminal; and that a PowerShell tab runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

assert.equal(process.platform, 'win32', 'this test is for Windows');
const require = createRequire(new URL('../package.json', import.meta.url));
const pty = require('node-pty');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-win-')));
process.env.SYNAPSE_HOME = path.join(tmp, 'state');
const lib = await import('../../lib.mjs');
// a ConPTY can take over this process's console, and with it stdout: every line also goes to a file the workflow checks
const LOG = process.env.SYNAPSE_TEST_LOG;
const log = (line) => { console.log(line); if (LOG) fs.appendFileSync(LOG, `${line}\n`); };
if (LOG) process.on('exit', (code) => fs.appendFileSync(LOG, `exit ${code}\n`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await check(); if (v) return v; await sleep(250); }
  throw new Error(`Timed out: ${label}`);
}

// a codex on PATH the way npm installs one: a .cmd shim that runs a script with node
const bin = path.join(tmp, 'bin'), work = path.join(tmp, 'project');
fs.mkdirSync(bin); fs.mkdirSync(work);
fs.writeFileSync(path.join(bin, 'codex.js'), 'setInterval(() => {}, 1000); console.log("fake codex up");\n');
fs.writeFileSync(path.join(bin, 'codex.cmd'), `@"${process.env.SYNAPSE_NODE || 'node'}" "%~dp0codex.js" %*\r\n`);
const env = { ...process.env, Path: `${bin};${process.env.Path || process.env.PATH}` };
delete env.PATH; delete env.ELECTRON_RUN_AS_NODE;

const terms = [];
try {
  const p = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'codex --model x'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: work, env, useConpty: true });
  terms.push(p);
  let out = '';
  p.onData((d) => { out += d; });
  lib.writeJSON(lib.FILES.ptys, { [p.pid]: work });
  await until(() => out.includes('fake codex up'), 'the fake codex started');
  log('PASS agent starts in a ConPTY through cmd.exe');

  const agent = await until(() => lib.listAgents().find((a) => a.kind === 'codex'), 'Synapse found the codex');
  assert.equal(agent.cwd, work, 'in the terminal\'s folder');
  assert.equal(agent.hostPid ?? agent.pid, p.pid, 'matched back to the terminal it runs in');
  assert.notEqual(agent.pid, p.pid, 'the agent itself is node, below cmd.exe');
  log(`PASS discovery: ${agent.name} pid ${agent.pid} in terminal ${p.pid}`);

  assert.equal(lib.agentForProcess(agent.pid)?.id, agent.id, 'the MCP server finds its agent by walking up');
  log('PASS agentForProcess');

  const proj = lib.projectOf(process.cwd());
  assert.ok(!proj.key.includes('/') || proj.key.startsWith('project:'), `project key uses Windows paths: ${proj.key}`);
  log(`PASS projectOf: ${proj.key}`);

  const sh = pty.spawn('powershell.exe', ['-NoLogo'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: work, env, useConpty: true });
  terms.push(sh);
  log(`PowerShell started, pid ${sh.pid}`);
  sh.onExit((e) => log(`PowerShell exited ${JSON.stringify(e)}`));
  let shOut = '';
  sh.onData((d) => { shOut += d; });
  await sleep(1500);
  sh.write('Write-Output ("synapse" + "-ok" + (Get-Location).Path)\r');
  await until(() => shOut.includes('synapse-ok'), 'PowerShell answered').catch((e) => { log(JSON.stringify(shOut.slice(-2000))); throw e; });
  // Get-Location may spell the temp folder the 8.3 way (RUNNER~1); the folders under it are the same either way
  const said = shOut.replace(/\x1b\[[0-9;?]*[A-Za-z]|\r?\n/g, '');
  assert.ok(said.toLowerCase().includes(`${path.basename(tmp)}\\project`.toLowerCase()), `in the right folder: ${JSON.stringify(said.slice(said.indexOf('synapse-ok'), said.indexOf('synapse-ok') + 200))}`);
  log('PASS PowerShell tab');
  log('windows suite passed');
} catch (e) {
  log(`FAIL ${e.stack || e}`);
  process.exitCode = 1;
} finally {
  for (const t of terms) try { t.kill(); } catch {}
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.stdout.write('', () => process.exit(process.exitCode || 0)); // node-pty keeps the loop alive; flush first
}
