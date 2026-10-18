// Synapse desktop: Electron main process.
// Owns the PTYs, reads Synapse state from ~/.synapse through lib.mjs, watches fork requests
// filed by the prompt hook, and pushes everything to the renderer over IPC.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import pty from 'node-pty';
import { git, listChoices, createWorktree, openWorktree, deleteWorktree, fetchBranches, pullRequests, choicePullRequest } from './worktrees.mjs';
import { DATA, FILES, readJSON, writeJSON, listAgents, projectOf, colorOf, linked, renameProject, renameAgent, recordFork } from '../lib.mjs';
import { createEdge } from '../ops.mjs';
import { createUpdater, bundleOf, MANIFEST_URL } from './updater.mjs';

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
  if (c.autoSendFork === undefined) { c.autoSendFork = false; dirty = true; }
  if (dirty) writeJSON(FILES.app, c);
  return c;
}

// ---------------------------------------------------------------- git

// A workspace is a checkout you added (a repo or one of its worktrees). The sidebar groups them by repo.
function projects() {
  const groups = new Map();
  const c = config();
  for (const ws of c.workspaces) {
    if (!fs.existsSync(ws)) continue;
    const p = projectOf(ws);
    let g = groups.get(p.key);
    if (!g) { g = { key: p.key, label: p.label, path: p.key.startsWith('project:') ? ws : p.key, color: colorOf(p.key), worktrees: [] }; groups.set(p.key, g); }
    let branch = '';
    try { branch = git(ws, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch {}
    let real = ws;
    try { real = fs.realpathSync(ws); } catch {}
    g.worktrees.push({ path: ws, branch, name: c.worktreeNames?.[ws] || path.basename(ws), home: ws === g.path || real === g.path }); // the repo's own folder, not a worktree
  }
  // the order they were dragged into in the sidebar, then the rest by name
  const order = config().projectOrder || [];
  // a repo's own folder used to be keyed project:<name>; an order saved then still counts
  const rank = (g) => { let i = order.indexOf(g.key); if (i < 0) i = order.indexOf(`project:${path.basename(g.key)}`); return i < 0 ? Infinity : i; };
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

// Repos Synapse makes for you (cloned or created from a name) live here, and workspaces added from
// elsewhere get a symlink here, so the library tab of "+ workspace" can bring any of them back.
const WS_HOME = path.join(DATA, 'workspaces');
const SESSIONS = path.join(DATA, 'sessions.json');

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
  const c = config();
  const added = new Set(c.workspaces.map(real));
  const worktreeNames = Object.fromEntries(Object.entries(c.worktreeNames || {}).map(([p, name]) => [real(p), name]));
  const projectNames = readJSON(FILES.projects, {});
  const out = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith('.')) continue;
    const entry = path.join(WS_HOME, name);
    let target;
    try { target = fs.realpathSync(entry); if (!fs.statSync(target).isDirectory()) continue; } catch { continue; }
    let label = worktreeNames[target] || name;
    if (!worktreeNames[target] && Object.keys(projectNames).length) {
      const p = projectOf(target);
      if (projectNames[p.key]) label = p.key === target || p.key.startsWith('project:') ? p.label : `${p.label}@${path.basename(target)}`;
    }
    out.push({ name, label, path: target, link: target !== real(entry) || fs.lstatSync(entry).isSymbolicLink(), added: added.has(target) });
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
  return addWorkspace(createWorktree(repo, name, base, path.join(DATA, 'worktrees')));
}

function removeWorktree(repo, dir, force = false) {
  deleteWorktree(repo, dir, force);
  const c = config();
  c.workspaces = c.workspaces.filter((w) => w !== dir);
  if (c.worktreeNames) delete c.worktreeNames[dir];
  writeJSON(FILES.app, c);
  for (const [link, target] of libraryLinks()) if (target === dir) { try { fs.unlinkSync(link); } catch {} }
  for (const t of ptys.values()) if (t.cwd === dir || t.cwd.startsWith(dir + path.sep)) { try { t.p.kill(); } catch {} }
}

// ---------------------------------------------------------------- ptys

const ptys = new Map(); // id -> { p, cwd, kind, env }
let nextPty = 1;
let win = null;

// Variables that tie a process to the session that launched it. If the app was started from inside an agent
// (Claude Code, Superset, ...), passing these on makes every agent here think it is that session's child:
// Claude then stops saving its transcript and never shows up in Synapse.
const INHERITED = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PLUGIN_DATA|AI_AGENT|CODEX_COMPANION_.*|SUPERSET_.*|SYNAPSE_AGENT|SYNAPSE_FORK_.*)$/;
// An app started from the Dock has launchd's bare PATH, and the login shell the pty runs never reads
// .zshrc, which is where PATH usually grows (claude's installer adds ~/.local/bin there). Ask an interactive
// login shell once for the PATH a terminal would have had.
let shellPath;
function userPath() {
  if (shellPath !== undefined) return shellPath;
  try {
    const out = execFileSync(SHELL, ['-ilc', 'printf "\\0%s\\0" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TERM: 'dumb' } });
    shellPath = out.split('\0')[1] || null;
  } catch { shellPath = null; }
  return shellPath;
}
function cleanEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED.test(k)));
  const seen = new Set();
  env.PATH = [...(userPath() || '').split(':'), ...(env.PATH || '').split(':')]
    // Superset's PATH wrappers report to Superset; agents started here should run as themselves
    .filter((p) => p && !p.includes('/.superset/bin') && !seen.has(p) && seen.add(p)).join(':');
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
  return { projects: projects(), agents: byPty, edges, unread, profiles: config().profiles, autoSendFork: !!config().autoSendFork, demo: DEMO };
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
// Without a question the child starts idle and the question is typed into its prompt for the human to send.
function forkCommand(kind, agent, question, profiles) {
  const q = question ? JSON.stringify(question) : '';
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

// The per-kind resume adapters: how to bring a session back after the app restarts. Without an id to
// resume (an agent that never took a turn, or a kind with no adapter yet) it starts fresh in the same place.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function resumeCommand(kind, resume, profiles) {
  const base = profiles[kind]?.command ?? kind;
  const flags = base.split(' ').slice(1).join(' ');
  switch (kind) {
    case 'claude': return UUID.test(resume?.synapseId || '') && resume.transcript && fs.existsSync(resume.transcript)
      ? `claude ${flags} --resume ${resume.synapseId}` : base;
    case 'codex': {
      const m = /rollout-.*-([0-9a-f-]{36})\.jsonl$/.exec(resume?.transcript || '');
      return m && UUID.test(m[1]) ? `codex ${flags} resume ${m[1]}` : base;
    }
    default: return base;
  }
}

function spawnFork({ parentPty, question, requestId, cols, rows }) {
  const t = ptys.get(parentPty);
  if (!t) throw new Error('parent session is gone');
  const agent = agentsByPty()[parentPty];
  let command;
  if (DEMO && !agent) command = ''; // demo: fork a shell into another shell, so the tree can be tried without agents
  else if (!agent) throw new Error('that session is not a known agent (shells cannot fork)');
  else command = forkCommand(agent.kind, agent, config().autoSendFork ? question : '', config().profiles);
  const r = spawnPty({ cwd: t.cwd, kind: t.kind, command, cols, rows, extraEnv: { SYNAPSE_FORK_OF: agent?.synapseId || '', SYNAPSE_FORK_Q: question } }); // the renderer's size, not the 120x36 default
  if (agent?.synapseId) try { recordFork(r.pid, agent.synapseId, question); } catch {} // the canvas draws the fork tree from this
  if (requestId) {
    const reqs = readJSON(FILES.forks, []);
    const req = reqs.find((x) => x.id === requestId);
    if (req) { req.status = 'spawned'; req.childPty = r.id; writeJSON(FILES.forks, reqs); }
  }
  if (!config().autoSendFork && command) prefill(r.id, question);
  return r;
}

// Type the question into a fresh agent's prompt without sending it: wait until its TUI has drawn and
// gone quiet, then paste it (bracketed, so newlines stay newlines). Enter is the human's to press.
function prefill(id, text) {
  const t = ptys.get(id);
  if (!t || !text) return;
  let quiet = null, seen = false;
  const done = () => { clearTimeout(quiet); clearTimeout(cap); sub.dispose(); if (ptys.get(id) === t) t.p.write(`\x1b[200~${text}\x1b[201~`); };
  const sub = t.p.onData(() => { seen = true; clearTimeout(quiet); quiet = setTimeout(done, 900); });
  const cap = setTimeout(() => { if (seen) done(); else sub.dispose(); }, 20000);
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
  win.on('app-command', (_e, command) => {
    if (command === 'browser-backward') win?.webContents.send('canvas:back');
    if (command === 'browser-forward' && win?.webContents.navigationHistory.canGoForward()) win.webContents.navigationHistory.goForward();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  createWindow();
  pollRequests(); setInterval(pollRequests, REQUEST_POLL);
  if (UPDATES) { setTimeout(() => updater.check(), UPDATE_DELAY); setInterval(() => updater.check(), UPDATE_EVERY); }
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
  if (updater.state.state === 'ready') updater.install({ relaunch: false, open: UPDATE_OPEN }); // swaps in once we are gone
  if (quitting || !ptys.size) return;
  e.preventDefault();
  quitting = true;
  for (const [, t] of ptys) { try { process.kill(-t.pid, 'SIGKILL'); } catch {} try { t.p.kill('SIGKILL'); } catch {} }
  const started = Date.now();
  const wait = setInterval(() => { if (!ptys.size || Date.now() - started > 2000) { clearInterval(wait); app.quit(); } }, 30);
});

// ---------------------------------------------------------------- updates (see updater.mjs)

// Only the packaged app updates itself; SYNAPSE_UPDATE_URL / SYNAPSE_UPDATE_BUNDLE point a test at a fake release.
const UPDATES = app.isPackaged || !!process.env.SYNAPSE_UPDATE_URL;
const UPDATE_DELAY = Number(process.env.SYNAPSE_UPDATE_DELAY || 20_000);
const UPDATE_EVERY = Number(process.env.SYNAPSE_UPDATE_EVERY || 4 * 3600_000);
const UPDATE_OPEN = process.env.SYNAPSE_UPDATE_OPEN || '/usr/bin/open';
const updater = createUpdater({
  currentVersion: app.getVersion(),
  bundle: process.env.SYNAPSE_UPDATE_BUNDLE || (app.isPackaged ? bundleOf(process.execPath) : null),
  manifestUrl: process.env.SYNAPSE_UPDATE_URL || MANIFEST_URL,
  onState: (s) => win?.webContents.send('update', s),
  log: (line) => console.log(`[update] ${line}`),
});

// ---------------------------------------------------------------- account (Synapse Cloud)

// Sign-in, trusted people and synapse requests live in ../account.mjs, shared with the CLI and the MCP
// server through ~/.synapse/account.json. Loaded lazily so a broken cloud never stops the terminals.
let accountMod = null;
const acct = async () => (accountMod ||= await import('../account.mjs'));
const DEVICE_LABEL = `Synapse on ${os.hostname().replace(/\.local$/, '')}`;
const REQUEST_POLL = Number(process.env.SYNAPSE_REQUEST_POLL || 8000);
// SYNAPSE_FAKE_REQUESTS=<file.json> drives the requests feed from a file ({ incoming, outgoing, links }),
// for screenshots and the circle test; accept and deny edit the file the way the cloud would.
const FAKE = process.env.SYNAPSE_FAKE_REQUESTS || '';
const fake = () => ({ incoming: [], outgoing: [], links: [], ...readJSON(FAKE, {}) });

let feed = { incoming: [], outgoing: [], links: [] };
let notified = null; // ids of incoming requests already announced; null until the first poll so old ones stay quiet
async function pollRequests() {
  let next;
  if (FAKE) next = fake();
  else {
    const a = await acct().catch(() => null);
    if (!a?.account()) next = { incoming: [], outgoing: [], links: [] };
    else {
      let r;
      try { r = await a.requests(); } catch { return; } // offline: keep showing what we had
      let links = [];
      try { links = a.externalLinks(); } catch {}
      next = { incoming: r.incoming || [], outgoing: r.outgoing || [], links };
    }
  }
  feed = next;
  const pending = feed.incoming.filter((r) => r.status === 'pending');
  if (notified && Notification.isSupported() && !process.env.SYNAPSE_SHOT) {
    for (const r of pending) {
      if (notified.has(r.id)) continue;
      const n = new Notification({ title: 'Synapse', body: `${r.from?.name || r.from?.handle || 'Someone'} wants to synapse with your agents` });
      n.on('click', () => { if (!win) return; win.show(); win.focus(); win.webContents.send('requests:open'); });
      n.show();
    }
  }
  notified = new Set(pending.map((r) => r.id));
  win?.webContents.send('requests', feed);
}
const accountChanged = async () => { const a = await acct(); win?.webContents.send('account', a.account()?.user || null); pollRequests(); };

// device sign-in (GitHub, Google, X): the browser does the provider dance, we poll until it says yes
let device = null;
async function deviceSignIn(provider) {
  const a = await acct();
  device?.stop();
  const d = await a.deviceStart(DEVICE_LABEL);
  let url = d.url.startsWith('/') ? a.cloudUrl().replace(/\/+$/, '') + d.url : d.url;
  if (provider) url += `${url.includes('?') ? '&' : '?'}via=${encodeURIComponent(provider)}`;
  shell.openExternal(url);
  let timer = null;
  const until = Date.now() + (d.expiresIn || 600) * 1000;
  const me = device = { stop: () => { clearTimeout(timer); if (device === me) device = null; } };
  const tick = async () => {
    if (device !== me) return;
    if (Date.now() > until) { me.stop(); win?.webContents.send('device', { status: 'expired' }); return; }
    try {
      const r = await a.devicePoll(d.deviceCode);
      if (r.status === 'approved') { me.stop(); win?.webContents.send('device', { status: 'approved' }); return accountChanged(); }
    } catch (e) { me.stop(); win?.webContents.send('device', { status: 'failed', error: e.message }); return; }
    timer = setTimeout(tick, (d.interval || 2) * 1000);
  };
  timer = setTimeout(tick, (d.interval || 2) * 1000);
  return { userCode: d.userCode, url };
}

// the live agents on this machine (not only the app's tabs), offered when accepting a request
function localAgentList() {
  return listAgents().filter((a) => !a.remote).map((a) => ({ id: a.id, name: a.name, kind: a.kind, status: a.status, project: projectOf(a.cwd).label }));
}

// ---------------------------------------------------------------- ipc

const handle = (ch, fn) => ipcMain.handle(ch, async (_e, a) => { try { return { ok: true, value: await fn(a || {}) }; } catch (e) { return { ok: false, error: e.message }; } });
handle('state', () => state());
handle('flags', () => ({ demo: DEMO, shot: process.env.SYNAPSE_SHOT_VIEW || '', steps: JSON.parse(process.env.SYNAPSE_SHOT_STEPS || '[]'), cwd: process.cwd(), home: os.homedir() }));
handle('pty:spawn', (a) => spawnPty(a));
handle('pty:write', ({ id, data }) => { ptys.get(id)?.p.write(data); });
handle('pty:resize', ({ id, cols, rows }) => { try { ptys.get(id)?.p.resize(cols, rows); } catch {} });
handle('pty:kill', ({ id }) => { ptys.get(id)?.p.kill(); });
handle('fork:spawn', (a) => spawnFork(a));
handle('pty:restore', ({ cwd, kind, resume, cols, rows }) => {
  if (!fs.existsSync(cwd)) throw new Error(`${cwd} is gone`);
  return spawnPty({ cwd, kind, command: resumeCommand(kind, resume, config().profiles), cols, rows });
});
// the open sessions, so a restart (or a rebuilt app) can bring them back; the renderer owns the shape
handle('sessions:load', () => readJSON(SESSIONS, null));
handle('sessions:save', (data) => writeJSON(SESSIONS, data));
handle('canvas', () => ensureCanvas());
handle('project:add', ({ path: p }) => addWorkspace(p));
handle('project:create', ({ name }) => createWorkspace(name));
handle('project:clone', ({ url, name }) => cloneWorkspace(url, name));
handle('project:pick', () => pickFolder());
handle('project:library', () => library());
handle('project:rename', ({ key, name }) => {
  const all = projects();
  if (!all.some((p) => p.key === key)) throw new Error('workspace is no longer open');
  name = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 48);
  if (name && all.some((p) => p.key !== key && p.label.toLowerCase() === name.toLowerCase())) throw new Error('another workspace already has that name');
  return renameProject(key, name);
});
handle('settings:get', () => ({ autoSymlink: !!config().autoSymlink, autoSendFork: !!config().autoSendFork }));
handle('settings:set', (patch) => {
  const c = config();
  if ('autoSymlink' in patch) c.autoSymlink = !!patch.autoSymlink;
  if ('autoSendFork' in patch) c.autoSendFork = !!patch.autoSendFork;
  writeJSON(FILES.app, c);
  if ('autoSymlink' in patch && c.autoSymlink) scanLibrary(true);
  return { autoSymlink: !!c.autoSymlink, autoSendFork: !!c.autoSendFork };
});
handle('worktree:add', ({ repo, name, base }) => addWorktree(repo, name, base));
handle('worktree:remove', ({ repo, dir, force }) => removeWorktree(repo, dir, force));
handle('project:order', ({ keys }) => { const c = config(); c.projectOrder = keys.filter((k) => typeof k === 'string'); writeJSON(FILES.app, c); });
// a workspace's worktrees show in the order their folders sit in app.json: deal the dragged order into the same places
handle('worktree:order', ({ paths }) => {
  const c = config(), moved = paths.filter((w) => c.workspaces.includes(w));
  c.workspaces.map((w, i) => moved.includes(w) ? i : -1).filter((i) => i >= 0).forEach((i, k) => { c.workspaces[i] = moved[k]; });
  writeJSON(FILES.app, c);
});
handle('project:remove', ({ path: p }) => { const c = config(); c.workspaces = c.workspaces.filter((w) => w !== p); writeJSON(FILES.app, c); });
// how many uncommitted changes a folder has (0 when it is not a repo); the renderer asks before anything destructive
handle('git:dirty', ({ cwd }) => { try { return git(cwd, ['status', '--porcelain']).split('\n').filter(Boolean).length; } catch { return 0; } });
// end an agent the app did not start; only pids Synapse knows as agents, never anything else
handle('agent:kill', ({ pid }) => {
  pid = Number(pid);
  if (!listAgents().some((a) => a.pid === pid)) throw new Error('that is not a running agent');
  process.kill(pid, 'SIGTERM');
});
// a tab renamed in the sidebar renames the Synapse agent in its pty, so the node view shows the same name
handle('agent:rename', ({ pty, name }) => {
  const t = ptys.get(pty);
  const a = t && listAgents().find((x) => x.pid === t.pid);
  if (!a) return null;
  return renameAgent(a, name);
});
handle('worktree:list', ({ repo }) => {
  const c = config();
  return listChoices(repo).map(w => ({ ...w, label: c.worktreeNames?.[w.path] || w.name, added: c.workspaces.includes(w.path) }));
});
handle('worktree:open', ({ repo, choice }) => addWorkspace(openWorktree(repo, choice, path.join(DATA, 'worktrees'))));
handle('worktree:fetch', async ({ repo }) => { await fetchBranches(repo); });
handle('worktree:prs', async ({ repo, choices }) => {
  const { pulls, error } = await pullRequests(repo);
  return { statuses: choices.map(w => choicePullRequest(repo, w, pulls)), error };
});
handle('worktree:rename', ({ path: dir, name }) => {
  const c = config();
  if (!c.workspaces.includes(dir)) throw new Error('worktree is no longer open');
  name = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 48);
  c.worktreeNames ||= {};
  if (name) c.worktreeNames[dir] = name; else delete c.worktreeNames[dir];
  writeJSON(FILES.app, c);
  return { path: dir, name: name || path.basename(dir) };
});
handle('synapse', ({ args, as }) => execFileSync(process.execPath, [path.join(ROOT, '..', 'cli.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SYNAPSE_AGENT: as || '' }, timeout: 8000 }));
handle('linked', ({ a, b }) => linked(readJSON(FILES.edges, []), a, b));
handle('account:get', async () => { if (FAKE) return readJSON(FAKE, {}).account || null; const a = await acct().catch(() => null); return a?.account()?.user || null; });
handle('account:skipped', () => !!config().skipLogin || !!process.env.SYNAPSE_DEMO);
handle('account:skip', () => { const c = config(); c.skipLogin = true; writeJSON(FILES.app, c); });
handle('account:signup', async (b) => { const a = await acct(); const r = await a.signup({ ...b, label: DEVICE_LABEL }); await accountChanged(); return r?.user || a.account()?.user; });
handle('account:login', async (b) => { const a = await acct(); const r = await a.login({ ...b, label: DEVICE_LABEL }); await accountChanged(); return r?.user || a.account()?.user; });
handle('account:logout', async () => { const a = await acct(); device?.stop(); await a.logout(); await accountChanged(); });
handle('account:providers', async () => (await acct()).providers());
handle('account:device', ({ provider }) => deviceSignIn(provider));
handle('account:device-cancel', () => { device?.stop(); });
handle('account:me', async () => (await acct()).me());
handle('account:update', async (patch) => { const a = await acct(); const r = await a.updateMe(patch); await accountChanged(); return r; });
handle('account:password', async (b) => (await acct()).changePassword(b));
handle('account:forgot', async ({ email }) => (await acct()).forgot(email));
handle('account:resend', async () => (await acct()).resendVerification());
handle('account:web', async ({ path: p }) => { if (!String(p || '').startsWith('/')) throw new Error('bad path'); shell.openExternal((await acct()).cloudUrl().replace(/\/+$/, '') + p); });
handle('people:list', async () => (FAKE ? { trusted: fake().people || [] } : (await acct()).trusted()));
handle('people:add', async ({ who }) => (await acct()).trust(who));
handle('people:remove', async ({ id }) => (await acct()).untrust(id));
handle('requests:list', () => feed);
handle('requests:agents', () => localAgentList());
// accept and deny answer the cloud, then poll at once so the circle changes without waiting for the next tick
async function decide(id, fn) {
  if (FAKE) {
    const f = fake(), r = f.incoming.find((x) => x.id === id);
    if (r) { f.incoming = f.incoming.filter((x) => x !== r); if (fn === 'accept') f.links.push({ direction: 'out', owner: r.from?.name || r.from?.handle, agent: r.agent, local: { id: 'local', name: 'local' }, edgeId: `fake-${id}` }); writeJSON(FAKE, f); }
  }
  await pollRequests();
}
handle('requests:accept', async ({ id, agents }) => { const out = FAKE ? null : await (await acct()).accept(id, agents); await decide(id, 'accept'); return out; });
handle('requests:deny', async ({ id }) => { const out = FAKE ? null : await (await acct()).deny(id); await decide(id, 'deny'); return out; });
handle('requests:cancel', async ({ id }) => { const out = await (await acct()).cancel(id); await pollRequests(); return out; });
handle('update:get', () => ({ ...updater.state, enabled: UPDATES }));
handle('update:check', async () => ({ ...(await updater.check()), enabled: UPDATES }));
handle('update:install', () => { if (updater.install({ relaunch: true, open: UPDATE_OPEN })) setTimeout(() => app.quit(), 50); });
handle('update:download', () => { const u = updater.state.dmg; if (u) shell.openExternal(u); });
handle('links', async () => (FAKE ? fake().links : (await acct()).externalLinks()));
// a collapsed child shares with its parent on demand: the parent can read it, nothing is pushed into its prompt
handle('fork:link', ({ child, parent }) => {
  const agents = listAgents(), from = agents.find((a) => a.id === child), to = agents.find((a) => a.id === parent);
  if (!from || !to) throw new Error('that agent is gone');
  return createEdge(from, to, { onDemand: true }).created;
});
