// Synapse desktop: Electron main process.
// Owns the PTYs, reads Synapse state from ~/.synapse through lib.mjs, watches fork requests
// filed by the prompt hook, and pushes everything to the renderer over IPC.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import pty from 'node-pty';
import { DATA, FILES, readJSON, writeJSON, listAgents, projectOf, colorOf, linked } from '../lib.mjs';

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
  if (c.autoSymlink === undefined) { c.autoSymlink = true; dirty = true; }
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
    let real = ws;
    try { real = fs.realpathSync(ws); } catch {}
    g.worktrees.push({ path: ws, branch, name: path.basename(ws), home: ws === g.path || real === g.path }); // the repo's own folder, not a worktree
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// Repos Synapse makes for you (cloned or created from a name) live here, and workspaces added from
// elsewhere get a symlink here, so the library tab of "+ workspace" can bring any of them back.
const WS_HOME = path.join(DATA, 'workspaces');

function addWorkspace(p) {
  let dir = path.resolve(p.replace(/^~/, os.homedir()));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${p} is not a folder`);
  try { dir = git(dir, ['rev-parse', '--show-toplevel']); } catch {} // a plain folder is fine too, it just cannot have worktrees
  const c = config();
  if (!c.workspaces.includes(dir)) { c.workspaces.push(dir); writeJSON(FILES.app, c); }
  try { linkIntoLibrary(dir); } catch {}
  return dir;
}

// Symlink a workspace into WS_HOME: a repo under its name, a worktree as <repo>@<folder>, with -2, -3
// when the name points elsewhere. One link per target: an older link to the same place is renamed.
// Returns the link, or null when nothing was made. Off with "autoSymlink": false (settings, ⌘,).
function linkIntoLibrary(dir) {
  if (!config().autoSymlink || (dir + '/').startsWith(WS_HOME + '/') || dir === os.homedir()) return null;
  fs.mkdirSync(WS_HOME, { recursive: true });
  const base = libraryName(dir);
  const links = libraryLinks();
  for (let i = 1; i < 100; i++) {
    const link = path.join(WS_HOME, i === 1 ? base : `${base}-${i}`);
    if (links.get(link) === dir) return link; // already there
    if (links.has(link) || fs.existsSync(link)) continue; // a link to somewhere else, or a real folder
    const old = [...links].find(([, target]) => target === dir)?.[0];
    if (old) fs.renameSync(old, link); else fs.symlinkSync(dir, link);
    return link;
  }
  return null;
}
// every symlink in WS_HOME and where it points
function libraryLinks() {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(WS_HOME); } catch {}
  for (const n of names) {
    const p = path.join(WS_HOME, n);
    try { if (fs.lstatSync(p).isSymbolicLink()) out.set(p, path.resolve(WS_HOME, fs.readlinkSync(p))); } catch {}
  }
  return out;
}
function libraryName(dir) {
  try {
    const repo = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).replace(/\/\.git\/?$/, '');
    if (repo !== dir) return `${path.basename(repo)}@${path.basename(dir)}`;
  } catch {}
  return path.basename(dir);
}

// Where workspaces already live on this machine: Superset's repos and worktrees, Synapse's own
// worktrees, the workspaces in app.json, the folders agents run in, and the repos those belong to.
const SUPERSET_HOME = process.env.SUPERSET_HOME || path.join(os.homedir(), '.superset');
function knownWorkspaces() {
  const seen = new Set();
  const sub = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const p = path.join(dir, n);
      try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
      if (depth) sub(p, depth - 1); else seen.add(p);
    }
  };
  sub(path.join(SUPERSET_HOME, 'projects'), 0);
  sub(path.join(SUPERSET_HOME, 'worktrees'), 1);
  sub(path.join(DATA, 'worktrees'), 1);
  for (const ws of config().workspaces) seen.add(ws);
  try { for (const a of listAgents()) if (a.cwd) seen.add(a.cwd); } catch {}
  const out = new Set();
  for (const p of seen) {
    try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
    let top = p;
    try { top = git(p, ['rev-parse', '--show-toplevel']); } catch {}
    out.add(top);
    try {
      const repo = git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir']).replace(/\/\.git\/?$/, '');
      if (repo !== top && fs.existsSync(repo)) out.add(repo);
    } catch {}
  }
  out.delete(os.homedir());
  return [...out];
}

// Link everything known into the library. Runs a second after start, when the library tab opens
// (at most once a minute) and when the setting is switched on.
let lastScan = 0;
function scanLibrary(force) {
  if (!config().autoSymlink || (!force && Date.now() - lastScan < 60_000)) return;
  lastScan = Date.now();
  for (const ws of knownWorkspaces()) try { linkIntoLibrary(ws); } catch {}
}
setTimeout(() => scanLibrary(true), 1000);
// What the library tab lists: every folder in WS_HOME, links resolved, dangling ones skipped.
function library() {
  scanLibrary();
  let names = [];
  try { names = fs.readdirSync(WS_HOME); } catch { return []; }
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const added = new Set(config().workspaces.map(real));
  const out = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith('.')) continue;
    const entry = path.join(WS_HOME, name);
    let target;
    try { target = fs.realpathSync(entry); if (!fs.statSync(target).isDirectory()) continue; } catch { continue; }
    out.push({ name, path: target, link: target !== real(entry) || fs.lstatSync(entry).isSymbolicLink(), added: added.has(target) });
  }
  return out;
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

// Variables that tie a process to the session that launched it. If the app was started from inside an agent
// (Claude Code, Superset, ...), passing these on makes every agent here think it is that session's child:
// Claude then stops saving its transcript and never shows up in Synapse.
const INHERITED = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PLUGIN_DATA|AI_AGENT|CODEX_COMPANION_.*|SUPERSET_.*|SYNAPSE_AGENT|SYNAPSE_FORK_.*)$/;
function cleanEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED.test(k)));
  // Superset's PATH wrappers report to Superset; agents started here should run as themselves
  if (env.PATH) env.PATH = env.PATH.split(':').filter((p) => !p.includes('/.superset/bin')).join(':');
  return env;
}

function spawnPty({ cwd, kind, command, cols = 120, rows = 36, extraEnv = {} }) {
  const id = String(nextPty++);
  const env = {
    ...cleanEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'synapse', LANG: process.env.LANG || 'en_US.UTF-8',
    SYNAPSE_APP: '1', SYNAPSE_SESSION: id, ...extraEnv,
  };
  // exec so the pty's pid is the agent's own pid, which is how Synapse identifies it
  const args = command ? ['-lc', `exec ${command}`] : ['-l'];
  const p = pty.spawn(SHELL, args, { name: 'xterm-256color', cols, rows, cwd, env });
  ptys.set(id, { p, cwd, kind, pid: p.pid });
  p.onData((data) => win?.webContents.send('pty:data', { id, data }));
  p.onExit(({ exitCode }) => { ptys.delete(id); if (!quitting) win?.webContents.send('pty:exit', { id, code: exitCode }); });
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
    // a session with no turns yet has no transcript, so there is nothing to inherit: start fresh with the question
    case 'claude': return agent.transcript && fs.existsSync(agent.transcript)
      ? `claude ${flags} --resume ${agent.synapseId} --fork-session ${q}` : `claude ${flags} ${q}`;
    case 'codex': {
      const m = /rollout-.*-([0-9a-f-]{36})\.jsonl$/.exec(agent.transcript || '');
      return m ? `codex ${flags} fork ${m[1]} ${q}` : `codex ${flags} ${q}`; // no transcript yet: nothing to inherit
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

// ---------------------------------------------------------------- synapse canvas

// The canvas is Synapse's own web UI, served by this checkout's server on a port of its own: a server started
// from another checkout would serve a canvas that does not know how to talk to the app.
const CANVAS_PORT = Number(process.env.SYNAPSE_APP_PORT || 4757);
let canvasProc = null;
const canvasUp = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: CANVAS_PORT, path: '/', timeout: 800 }, (r) => { r.resume(); resolve(r.statusCode < 500); });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});
async function ensureCanvas() {
  if (await canvasUp()) return `http://127.0.0.1:${CANVAS_PORT}/`;
  if (!canvasProc) {
    canvasProc = spawn(process.execPath, [path.join(ROOT, '..', 'server.mjs')], {
      env: { ...cleanEnv(), ELECTRON_RUN_AS_NODE: '1', PORT: String(CANVAS_PORT), NO_OPEN: '1' }, stdio: 'ignore',
    });
    canvasProc.on('exit', () => { canvasProc = null; });
  }
  for (let i = 0; i < 30; i++) { if (await canvasUp()) return `http://127.0.0.1:${CANVAS_PORT}/`; await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('the Synapse canvas server did not start');
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
  // ⌘G toggles the canvas even while focus is inside it (the canvas is a separate page, its keys never reach ours)
  win.webContents.on('before-input-event', (e, i) => {
    // ⌘Tab belongs to macOS (the app switcher never lets it through), so the node view also toggles on ⌃Tab
    const g = i.meta && !i.shift && !i.alt && i.key.toLowerCase() === 'g';
    const tab = i.control && !i.meta && !i.alt && i.key === 'Tab';
    if (i.type === 'keyDown' && (g || tab)) { e.preventDefault(); win.webContents.send('canvas:toggle'); }
  });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  createWindow();
  setInterval(() => { if (win) { win.webContents.send('state', state()); pumpForks(); } }, 1000);
  if (process.env.SYNAPSE_SHOT) {
    setTimeout(async () => {
      win.show(); win.focus();
      if (process.env.SYNAPSE_DEBUG) console.log('[bar]', await win.webContents.executeJavaScript(`document.querySelector('#bar-left').textContent + ' | deck: ' + [...document.querySelectorAll('#deck .card')].map((c) => c.textContent).join(' > ')`));
      if (process.env.SYNAPSE_DEBUG) console.log('[focus]', await win.webContents.executeJavaScript('document.activeElement.outerHTML.slice(0, 120)'));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.SYNAPSE_SHOT, img.toPNG());
      app.quit();
    }, Number(process.env.SYNAPSE_SHOT_DELAY || 3500));
  }
});
app.on('window-all-closed', () => app.quit());
// Kill every session's whole process group (agent wrappers spawn helpers that outlive a plain SIGHUP), then exit
// without Node's handle cleanup: node-pty's exit-watcher threads otherwise block shutdown forever.
// Kill every session's whole process group (agent wrappers spawn helpers that outlive a plain SIGHUP) and quit
// only once node-pty has seen them all exit: its exit-watcher threads otherwise block or crash Node's shutdown.
let quitting = false;
app.on('before-quit', (e) => {
  try { canvasProc?.kill(); } catch {}
  if (quitting || !ptys.size) return;
  e.preventDefault();
  quitting = true;
  for (const [, t] of ptys) { try { process.kill(-t.pid, 'SIGKILL'); } catch {} try { t.p.kill('SIGKILL'); } catch {} }
  const started = Date.now();
  const wait = setInterval(() => { if (!ptys.size || Date.now() - started > 2000) { clearInterval(wait); app.quit(); } }, 30);
});

// ---------------------------------------------------------------- ipc

const handle = (ch, fn) => ipcMain.handle(ch, async (_e, a) => { try { return { ok: true, value: await fn(a || {}) }; } catch (e) { return { ok: false, error: e.message }; } });
handle('state', () => state());
handle('flags', () => ({ demo: DEMO, shot: process.env.SYNAPSE_SHOT_VIEW || '', steps: JSON.parse(process.env.SYNAPSE_SHOT_STEPS || '[]'), cwd: process.cwd(), home: os.homedir() }));
handle('pty:spawn', (a) => spawnPty(a));
handle('pty:write', ({ id, data }) => { ptys.get(id)?.p.write(data); });
handle('pty:resize', ({ id, cols, rows }) => { try { ptys.get(id)?.p.resize(cols, rows); } catch {} });
handle('pty:kill', ({ id }) => { ptys.get(id)?.p.kill(); });
handle('fork:spawn', (a) => spawnFork(a));
handle('canvas', () => ensureCanvas());
handle('project:add', ({ path: p }) => addWorkspace(p));
handle('project:create', ({ name }) => createWorkspace(name));
handle('project:clone', ({ url, name }) => cloneWorkspace(url, name));
handle('project:pick', () => pickFolder());
handle('project:library', () => library());
handle('settings:get', () => ({ autoSymlink: !!config().autoSymlink }));
handle('settings:set', (patch) => { const c = config(); if ('autoSymlink' in patch) c.autoSymlink = !!patch.autoSymlink; writeJSON(FILES.app, c); if (c.autoSymlink) scanLibrary(true); return { autoSymlink: !!c.autoSymlink }; });
handle('worktree:add', ({ repo, name, base }) => addWorktree(repo, name, base));
handle('worktree:remove', ({ repo, dir, force }) => removeWorktree(repo, dir, force));
handle('project:remove', ({ path: p }) => { const c = config(); c.workspaces = c.workspaces.filter((w) => w !== p); writeJSON(FILES.app, c); });
// how many uncommitted changes a folder has (0 when it is not a repo); the renderer asks before anything destructive
handle('git:dirty', ({ cwd }) => { try { return git(cwd, ['status', '--porcelain']).split('\n').filter(Boolean).length; } catch { return 0; } });
// end an agent the app did not start; only pids Synapse knows as agents, never anything else
handle('agent:kill', ({ pid }) => {
  pid = Number(pid);
  if (!listAgents().some((a) => a.pid === pid)) throw new Error('that is not a running agent');
  process.kill(pid, 'SIGTERM');
});
handle('synapse', ({ args, as }) => execFileSync(process.execPath.includes('Electron') ? 'node' : process.execPath, [path.join(ROOT, '..', 'cli.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, SYNAPSE_AGENT: as || '' }, timeout: 8000 }));
handle('linked', ({ a, b }) => linked(readJSON(FILES.edges, []), a, b));
