// Synapse desktop: Electron main process.
// Owns the PTYs, reads Synapse state from ~/.synapse through lib.mjs, watches fork requests
// filed by the prompt hook, and pushes everything to the renderer over IPC.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import pty from 'node-pty';
import { FILES, readJSON, writeJSON, listAgents, projectOf, colorOf, linked } from '../lib.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SHELL = process.env.SHELL || '/bin/zsh';
const DEMO = process.argv.includes('--demo');

// Launch profiles, mirroring Superset's defaults. Editable in ~/.synapse/app.json.
const DEFAULT_PROFILES = {
  shell: { command: '', label: 'shell' },
  claude: { command: 'claude --dangerously-skip-permissions', label: 'Claude Code' },
  codex: { command: 'codex --dangerously-bypass-approvals-and-sandbox', label: 'Codex' },
  gemini: { command: 'gemini --approval-mode=auto_edit', label: 'Gemini CLI' },
  opencode: { command: 'opencode', label: 'OpenCode' },
  'cursor-agent': { command: 'cursor-agent', label: 'Cursor Agent' },
  copilot: { command: 'copilot --allow-tool=write', label: 'Copilot CLI' },
  amp: { command: 'amp', label: 'Amp' },
};

function config() {
  const c = readJSON(FILES.app, {});
  let dirty = false;
  if (!c.profiles) { c.profiles = DEFAULT_PROFILES; dirty = true; }
  if (!c.workspaces) { c.workspaces = []; dirty = true; }
  if (dirty) writeJSON(FILES.app, c);
  return c;
}

// ---------------------------------------------------------------- git

const git = (cwd, args) => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim(); }
  catch (e) { throw new Error((e.stderr || e.message || '').toString().trim()); }
};

// A workspace is a checkout you added (a repo or one of its worktrees). The sidebar groups them by repo.
function projects() {
  const groups = new Map();
  for (const ws of config().workspaces) {
    if (!fs.existsSync(ws)) continue;
    const p = projectOf(ws);
    let g = groups.get(p.key);
    if (!g) { g = { key: p.key, label: p.label, path: p.key.startsWith('project:') ? ws : p.key, color: colorOf(p.key), worktrees: [] }; groups.set(p.key, g); }
    let branch = '';
    try { branch = git(ws, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch {}
    g.worktrees.push({ path: ws, branch, name: path.basename(ws) });
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// Repos Synapse makes for you (cloned or created from a name) live here.
const WS_HOME = path.join(os.homedir(), '.synapse', 'workspaces');

function addWorkspace(p) {
  let dir = path.resolve(p.replace(/^~/, os.homedir()));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${p} is not a folder`);
  try { dir = git(dir, ['rev-parse', '--show-toplevel']); } catch {} // a plain folder is fine too, it just cannot have worktrees
  const c = config();
  if (!c.workspaces.includes(dir)) { c.workspaces.push(dir); writeJSON(FILES.app, c); }
  return dir;
}

const safeName = (n) => {
  const s = String(n || '').trim().replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  if (!s) throw new Error('give it a name');
  return s;
};

// A brand new repo from just a name: ~/.synapse/workspaces/<name>, with one empty commit so worktrees work.
function createWorkspace(name) {
  const dir = path.join(WS_HOME, safeName(name));
  if (fs.existsSync(dir)) throw new Error(`${dir.replace(os.homedir(), '~')} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  const commit = ['commit', '-q', '--allow-empty', '-m', 'Initial commit'];
  try { git(dir, commit); } catch { git(dir, ['-c', 'user.name=Synapse', '-c', 'user.email=synapse@localhost', ...commit]); } // no git identity set
  return addWorkspace(dir);
}

// git clone can take a while, so it runs async and streams its progress lines to the renderer.
function cloneWorkspace(url, name) {
  url = String(url || '').trim();
  if (!url) throw new Error('paste a repo url');
  const dir = path.join(WS_HOME, safeName(name || url.replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/, '')));
  if (fs.existsSync(dir)) throw new Error(`${dir.replace(os.homedir(), '~')} already exists`);
  fs.mkdirSync(WS_HOME, { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['clone', '--progress', url, dir], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let err = '';
    p.stderr.on('data', (d) => {
      err += d;
      const line = String(d).split(/[\r\n]+/).filter(Boolean).pop();
      if (line) win?.webContents.send('clone:progress', line.trim());
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve(addWorkspace(dir));
      fs.rmSync(dir, { recursive: true, force: true });
      reject(new Error(err.trim().split('\n').filter((l) => /fatal|error/i.test(l)).pop() || `git clone exited ${code}`));
    });
  });
}

async function pickFolder() {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Add workspace' });
  return r.canceled ? null : addWorkspace(r.filePaths[0]);
}

function addWorktree(repo, name, base) {
  const dir = path.join(os.homedir(), '.synapse', 'worktrees', path.basename(repo), name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(repo, ['worktree', 'add', '-b', name, dir, base || 'HEAD']);
  addWorkspace(dir);
  return dir;
}

function removeWorktree(repo, dir, force) {
  git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
  const c = config();
  c.workspaces = c.workspaces.filter((w) => w !== dir);
  writeJSON(FILES.app, c);
}

// ---------------------------------------------------------------- ptys

const ptys = new Map(); // id -> { p, cwd, kind, env }
let nextPty = 1;
let win = null;

function spawnPty({ cwd, kind, command, cols = 120, rows = 36, extraEnv = {} }) {
  const id = String(nextPty++);
  const env = {
    ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'synapse', LANG: process.env.LANG || 'en_US.UTF-8',
    SYNAPSE_APP: '1', SYNAPSE_SESSION: id, ...extraEnv,
  };
  // exec so the pty's pid is the agent's own pid, which is how Synapse identifies it
  const args = command ? ['-lc', `exec ${command}`] : ['-l'];
  const p = pty.spawn(SHELL, args, { name: 'xterm-256color', cols, rows, cwd, env });
  ptys.set(id, { p, cwd, kind, pid: p.pid });
  p.onData((data) => win?.webContents.send('pty:data', { id, data }));
  p.onExit(({ exitCode }) => { ptys.delete(id); win?.webContents.send('pty:exit', { id, code: exitCode }); });
  return { id, pid: p.pid };
}

// Which Synapse agent runs in which pty, by pid.
function agentsByPty() {
  const agents = listAgents();
  const out = {};
  for (const [id, t] of ptys) {
    const a = agents.find((x) => x.pid === t.pid);
    if (a) out[id] = { synapseId: a.id, name: a.name, kind: a.kind, status: a.status, transcript: a.transcript };
  }
  return out;
}

function state() {
  const byPty = agentsByPty();
  const edges = readJSON(FILES.edges, []);
  const messages = readJSON(FILES.messages, []);
  const unread = {};
  for (const m of messages) if (!m.delivered) unread[m.to] = (unread[m.to] || 0) + 1;
  return { projects: projects(), agents: byPty, edges, unread, profiles: config().profiles, demo: DEMO };
}

// ---------------------------------------------------------------- forks

// Fork requests come from hook.mjs (`/sfork` typed in a session). Hand them to the renderer,
// which owns the slot model and asks us to spawn the child into the parent's slot.
function pumpForks() {
  const reqs = readJSON(FILES.forks, []);
  const byPty = agentsByPty();
  let changed = false;
  for (const r of reqs) {
    if (r.status !== 'pending') continue;
    if (Date.now() - r.requestedAt > 600_000) { r.status = 'stale'; changed = true; continue; }
    const ptyId = Object.keys(byPty).find((id) => byPty[id].synapseId === r.parent);
    if (!ptyId) continue;
    r.status = 'claimed';
    changed = true;
    win?.webContents.send('fork:request', { requestId: r.id, parentPty: ptyId, question: r.question });
  }
  if (changed) writeJSON(FILES.forks, reqs);
}

// The per-kind fork adapters: how to start a child that inherits the parent's conversation.
function forkCommand(kind, agent, question, profiles) {
  const q = JSON.stringify(question);
  const flags = (profiles[kind]?.command || kind).split(' ').slice(1).join(' ');
  switch (kind) {
    case 'claude': return `claude ${flags} --resume ${agent.synapseId} --fork-session ${q}`;
    case 'codex': {
      const m = /rollout-.*-([0-9a-f-]{36})\.jsonl$/.exec(agent.transcript || '');
      if (!m) throw new Error('could not find the Codex session id');
      return `codex ${flags} fork ${m[1]} ${q}`;
    }
    default: throw new Error(`no fork adapter for ${kind} yet`);
  }
}

function spawnFork({ parentPty, question, requestId }) {
  const t = ptys.get(parentPty);
  if (!t) throw new Error('parent session is gone');
  const agent = agentsByPty()[parentPty];
  let command;
  if (DEMO && !agent) command = ''; // demo: fork a shell into another shell, so the tree can be tried without agents
  else if (!agent) throw new Error('that session is not a known agent (shells cannot fork)');
  else command = forkCommand(agent.kind, agent, question, config().profiles);
  const r = spawnPty({ cwd: t.cwd, kind: t.kind, command, extraEnv: { SYNAPSE_FORK_OF: agent?.synapseId || '', SYNAPSE_FORK_Q: question } });
  if (requestId) {
    const reqs = readJSON(FILES.forks, []);
    const req = reqs.find((x) => x.id === requestId);
    if (req) { req.status = 'spawned'; req.childPty = r.id; writeJSON(FILES.forks, reqs); }
  }
  return r;
}

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 560,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0B0B' : '#F1EFE9',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  if (process.env.SYNAPSE_SHOT || process.env.SYNAPSE_DEBUG) {
    win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning' || process.env.SYNAPSE_DEBUG) console.log(`[renderer] ${e.message}`); });
    win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', d.reason));
  }
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  createWindow();
  setInterval(() => { if (win) { win.webContents.send('state', state()); pumpForks(); } }, 1000);
  if (process.env.SYNAPSE_SHOT) {
    setTimeout(async () => {
      win.show(); win.focus();
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.SYNAPSE_SHOT, img.toPNG());
      app.quit();
    }, Number(process.env.SYNAPSE_SHOT_DELAY || 3500));
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { for (const [, t] of ptys) try { t.p.kill(); } catch {} });

// ---------------------------------------------------------------- ipc

const handle = (ch, fn) => ipcMain.handle(ch, async (_e, a) => { try { return { ok: true, value: await fn(a || {}) }; } catch (e) { return { ok: false, error: e.message }; } });
handle('state', () => state());
handle('flags', () => ({ demo: DEMO, shot: process.env.SYNAPSE_SHOT_VIEW || '', cwd: process.cwd(), home: os.homedir() }));
handle('pty:spawn', (a) => spawnPty(a));
handle('pty:write', ({ id, data }) => { ptys.get(id)?.p.write(data); });
handle('pty:resize', ({ id, cols, rows }) => { try { ptys.get(id)?.p.resize(cols, rows); } catch {} });
handle('pty:kill', ({ id }) => { ptys.get(id)?.p.kill(); });
handle('fork:spawn', (a) => spawnFork(a));
handle('project:add', ({ path: p }) => addWorkspace(p));
handle('project:create', ({ name }) => createWorkspace(name));
handle('project:clone', ({ url, name }) => cloneWorkspace(url, name));
handle('project:pick', () => pickFolder());
handle('worktree:add', ({ repo, name, base }) => addWorktree(repo, name, base));
handle('worktree:remove', ({ repo, dir, force }) => removeWorktree(repo, dir, force));
handle('synapse', ({ args, as }) => execFileSync(process.execPath.includes('Electron') ? 'node' : process.execPath, [path.join(ROOT, '..', 'cli.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, SYNAPSE_AGENT: as || '' }, timeout: 8000 }));
handle('linked', ({ a, b }) => linked(readJSON(FILES.edges, []), a, b));
