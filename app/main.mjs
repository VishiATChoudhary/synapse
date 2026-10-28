// Synapse desktop: Electron main process.
// Owns the PTYs, reads Synapse state from ~/.synapse through lib.mjs, watches fork requests
// filed by the prompt hook, and pushes everything to the renderer over IPC.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, screen, shell, systemPreferences } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import pty from 'node-pty';
import { git, listChoices, createWorktree, openWorktree, deleteWorktree, fetchBranches, pullRequests, choicePullRequest } from './worktrees.mjs';
import { DATA, FILES, WIN, readJSON, writeJSON, listAgents, projectOf, colorOf, linked, renameProject, renameAgent, recordFork, readAgentMessages } from '../lib.mjs';
import { createEdge, allowTalkRequest, dismissTalkRequest, setMode, removeEdge } from '../ops.mjs';
import { openRequests, talkPerHour, talkModel, clampPerHour } from '../talk.mjs';
import { isConnected } from '../remote.mjs';
import { createUpdater, bundleOf, MANIFEST_URL } from './updater.mjs';
import * as phone from './phone.mjs';
import { collect as collectActivity, lastWeek } from './activity.mjs';
import { createDiscovery } from '../discovery.mjs';
import * as chats from './history.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
if (process.env.SYNAPSE_USER_DATA) app.setPath('userData', path.resolve(process.env.SYNAPSE_USER_DATA));
// Windows: shell tabs are PowerShell, agents run through cmd.exe so npm's .cmd shims resolve
const SHELL = WIN ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
const DEMO = process.argv.includes('--demo');
const discovery = createDiscovery({ projects: true });
await discovery.refresh();
// A new install has no app.json yet: only this app creates it, so its absence at launch means a first run.
const FIRST_RUN = !fs.existsSync(FILES.app);
// What the app showed once (the intro, the onboarding), in a file nothing else writes. In app.json a settings
// write that read the file just before the intro marked itself could drop the mark, and the intro played again.
const SEEN = path.join(DATA, 'seen.json');
const seen = () => readJSON(SEEN, {});
const markSeen = (key) => writeJSON(SEEN, { ...seen(), [key]: Date.now() });

// Launch profiles, mirroring Superset's defaults. Editable in ~/.synapse/app.json.
const DEFAULT_PROFILES = {
  shell: { command: '', label: 'shell' },
  claude: { command: 'claude', label: 'Claude Code' },
  codex: { command: 'codex', label: 'Codex' },
  gemini: { command: 'gemini', label: 'Gemini CLI' },
  opencode: { command: 'opencode', label: 'OpenCode' },
  'cursor-agent': { command: 'cursor-agent', label: 'Cursor Agent' },
  copilot: { command: 'copilot', label: 'Copilot CLI' },
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

// ---------------------------------------------------------------- open at login
// A friend's questions are only answered while the app runs, so offer to open it at login. Never turned on by
// itself. SYNAPSE_FAKE_LOGIN_ITEMS=<file> keeps the setting in a file so tests never touch this Mac's login items.
const FAKE_LOGIN = process.env.SYNAPSE_DEMO ? process.env.SYNAPSE_FAKE_LOGIN_ITEMS || '' : '';
function loginOpen() {
  if (FAKE_LOGIN) return !!readJSON(FAKE_LOGIN, {}).openAtLogin;
  return !!app.getLoginItemSettings(WIN ? { args: ['--hidden'] } : undefined).openAtLogin;
}
// macOS 13+ (Darwin 22+) registers login items through SMAppService, where Electron ignores openAsHidden and
// wasOpenedAsHidden is always false: the app opens its window at login. Older macOS still honours both.
const modernLogin = process.platform === 'darwin' && parseInt(os.release(), 10) >= 22;
const loginPayload = (on) => (modernLogin ? { openAtLogin: on, type: 'mainAppService' } : WIN ? { openAtLogin: on, args: ['--hidden'] } : { openAtLogin: on, openAsHidden: true });
function setLoginOpen(on) {
  on = !!on;
  if (FAKE_LOGIN) { const f = readJSON(FAKE_LOGIN, {}); (f.calls ||= []).push(loginPayload(on)); f.openAtLogin = on; writeJSON(FAKE_LOGIN, f); }
  else app.setLoginItemSettings(loginPayload(on));
  return loginOpen();
}
// Only older macOS can start hidden (or an explicit --hidden); on 13+ this is false and the window shows.
const startedHidden = () => (FAKE_LOGIN ? !!readJSON(FAKE_LOGIN, {}).startHidden : !!(app.getLoginItemSettings().wasOpenedAsHidden || process.argv.includes('--hidden')));

// The first time a link goes to talk (a talk edge we had not seen), suggest it once. Edges present at launch are
// the baseline, and the remembered flag is only set once the window is visible to show it.
let talkEdgesSeen = null;
function suggestLogin(edges) {
  const talk = edges.filter((e) => e.mode === 'talk').map((e) => e.id);
  if (!talkEdgesSeen) { talkEdgesSeen = new Set(talk); return; }
  const fresh = talk.filter((id) => !talkEdgesSeen.has(id));
  if (!fresh.length || !win || !win.isVisible()) return;
  for (const id of fresh) talkEdgesSeen.add(id);
  const c = config();
  if (c.loginSuggested || loginOpen()) return;
  c.loginSuggested = true; writeJSON(FILES.app, c);
  win.webContents.send('login:suggest');
}

// ---------------------------------------------------------------- git

// A workspace is a checkout you added (a repo or one of its worktrees). The sidebar groups them by repo.
function projects() { return discovery.projects; }

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
  if (WIN) return (shellPath = null); // Windows hands GUI apps the same PATH a terminal gets
  try {
    const out = execFileSync(SHELL, ['-ilc', 'printf "\\0%s\\0" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TERM: 'dumb' } });
    shellPath = out.split('\0')[1] || null;
  } catch { shellPath = null; }
  return shellPath;
}
function cleanEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED.test(k)));
  const seen = new Set();
  const key = WIN ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path' : 'PATH';
  env[key] = [...(userPath() || '').split(path.delimiter), ...(env[key] || '').split(path.delimiter)]
    // Superset's PATH wrappers report to Superset; agents started here should run as themselves
    .filter((p) => p && !p.includes('/.superset/bin') && !seen.has(p) && seen.add(p)).join(path.delimiter);
  return env;
}

function spawnPty({ cwd, kind, command, cols = 120, rows = 36, extraEnv = {} }) {
  const id = String(nextPty++);
  const env = {
    ...cleanEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'synapse', LANG: process.env.LANG || 'en_US.UTF-8',
    SYNAPSE_APP: '1', SYNAPSE_SESSION: id, ...extraEnv,
  };
  // exec so the pty's pid is the agent's own pid, which is how Synapse identifies it. Windows has no exec:
  // the agent is a child of cmd.exe there, matched back to this terminal through ptys.json (lib.mjs hostPid)
  const p = WIN
    ? (command ? pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { name: 'xterm-256color', cols, rows, cwd, env, useConpty: true })
      : pty.spawn(SHELL, ['-NoLogo'], { name: 'xterm-256color', cols, rows, cwd, env, useConpty: true }))
    : pty.spawn(SHELL, command ? ['-lc', `exec ${command}`] : ['-l'], { name: 'xterm-256color', cols, rows, cwd, env });
  ptys.set(id, { p, cwd, kind, pid: p.pid });
  savePtys();
  p.onData((data) => win?.webContents.send('pty:data', { id, data }));
  p.onExit(({ exitCode }) => { ptys.delete(id); savePtys(); if (!quitting) win?.webContents.send('pty:exit', { id, code: exitCode }); });
  return { id, pid: p.pid };
}

// Windows only: which folder each terminal runs in, by pid, for agent discovery there (no lsof to ask)
function savePtys() {
  if (WIN) try { writeJSON(FILES.ptys, Object.fromEntries([...ptys.values()].map((t) => [t.pid, t.cwd]))); } catch {}
}
// the pid of the terminal an agent runs in (on Windows a cmd.exe above the agent, elsewhere the agent itself)
const hostOf = (a) => a.hostPid ?? a.pid;

// Which Synapse agent runs in which pty, by pid.
function agentsByPty() {
  const agents = discovery.agents;
  const out = {};
  for (const [id, t] of ptys) {
    const a = agents.find((x) => hostOf(x) === t.pid);
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
  return { projects: projects(), agents: byPty, edges, unread, talks: openTalks(), talkRequests: openTalkRequests(edges), profiles: config().profiles, autoSendFork: !!config().autoSendFork, demo: DEMO };
}

// ---------------------------------------------------------------- agent talk

// Open conversations, both sides, for the sidebar and the circle: who, which agents and what is happening.
// The texts stay out (the canvas thread and settings fetch them from the canvas server).
function openTalks() {
  const s = readJSON(FILES.talks, {});
  const running = new Set((s.running || []).map((r) => r.conv)), queued = new Set((s.queue || []).map((j) => j.conv));
  return (Array.isArray(s.conversations) ? s.conversations : []).filter((c) => c?.status === 'open' && typeof c.id === 'string').map((c) => ({
    id: c.id, role: c.role, peerName: String(c.peerName || ''), peerHandle: String(c.peerHandle || ''),
    asker: c.asker, askerName: String(c.askerName || ''), target: c.target, targetName: String(c.targetName || ''),
    asked: Array.isArray(c.turns) ? c.turns.length : 0, firstQ: String(c.turns?.[0]?.q || ''), lastAt: c.lastAt || 0,
    live: running.has(c.id) ? 'answering' : queued.has(c.id) ? 'queued' : 'open',
  }));
}

// A friend's agent wants to ask one of mine that is shared read only: Allow / Not now in the circle.
function openTalkRequests(edges) {
  let list = [];
  try { list = openRequests(readJSON(FILES.talks, {}), edges); } catch {}
  return list.filter((r) => typeof r?.id === 'string').map((r) => ({
    id: r.id, peerName: String(r.peerName || ''), peerHandle: String(r.peerHandle || ''), target: r.target,
    targetName: String(r.targetName || ''), askerName: String(r.askerName || ''), at: r.at || 0,
  }));
}
// One notification per request, ever (remembered in app.json), so a restart does not announce it again.
function notifyTalkRequests(list) {
  if (!list.length) return;
  const c = config(), seen = new Set(c.talkRequestsNotified || []);
  const fresh = list.filter((r) => !seen.has(r.id));
  if (!fresh.length) return;
  for (const r of fresh) seen.add(r.id);
  c.talkRequestsNotified = [...seen].slice(-500);
  writeJSON(FILES.app, c);
  if (!Notification.isSupported() || process.env.SYNAPSE_SHOT) return;
  for (const r of fresh) {
    const who = r.peerHandle ? `@${r.peerHandle}` : r.peerName || 'A friend';
    const n = new Notification({ title: 'Synapse', body: `${who}'s agent wants to ask your ${r.targetName || 'agent'} questions. Allow it?` });
    n.on('click', () => { if (!win) return; win.show(); win.focus(); win.webContents.send('requests:open'); });
    n.show();
  }
}

// A notification when a friend's agent asks one of mine its first question. Conversations open at start stay
// quiet, like the requests feed; each one is announced once.
let talksSeen = null;
function notifyTalks(list) {
  const asked = list.filter((c) => c.role === 'owner' && c.asked > 0);
  if (talksSeen && Notification.isSupported() && !process.env.SYNAPSE_SHOT) {
    for (const c of asked) {
      if (talksSeen.has(c.id)) continue;
      const who = c.peerHandle ? `@${c.peerHandle}` : c.peerName || 'A friend';
      const q = c.firstQ.replace(/\s+/g, ' ').trim();
      const n = new Notification({ title: 'Synapse', body: `${who}'s agent asks your ${c.targetName || 'agent'}: ${q.length > 120 ? q.slice(0, 119) + '…' : q}` });
      n.on('click', () => { if (!win) return; win.show(); win.focus(); win.webContents.send('talk:open', c.id); });
      n.show();
    }
  }
  talksSeen ||= new Set();
  for (const c of asked) talksSeen.add(c.id);
}

// Past and open conversations for settings, from the canvas server (it filters to the last 30 days). A request
// from this process sends no Origin, which the server's own-page guard lets through.
async function talkHistory(route = 'api/talks') {
  const base = await ensureCanvas();
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${route}`, { timeout: 5000 }, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (d) => { body += d; });
      r.on('end', () => { try { const v = JSON.parse(body); if (r.statusCode !== 200) throw new Error(v.error || `canvas said ${r.statusCode}`); resolve(v); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('the canvas server did not answer')); });
  });
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
  const q = question ? (WIN ? '"' + question.replace(/"/g, '""') + '"' : "'" + question.replace(/'/g, "'\\''") + "'") : '';
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
    case 'opencode': {
      const m = /#(ses_[a-zA-Z0-9]+)$/.exec(resume?.transcript || '');
      return m && fs.existsSync(resume.transcript.slice(0, -m[0].length)) ? `${base} --session ${m[1]}` : base;
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
// gone quiet, then paste it (bracketed, so newlines stay newlines). Enter is the human's to press,
// unless the prompt came from the phone (send), where nobody is at the keyboard to press it.
function prefill(id, text, send = false) {
  const t = ptys.get(id);
  if (!t || !text) return;
  let quiet = null, seen = false;
  const done = () => { clearTimeout(quiet); clearTimeout(cap); sub.dispose(); if (ptys.get(id) === t) send ? submit(id, text) : t.p.write(`\x1b[200~${text}\x1b[201~`); };
  const sub = t.p.onData(() => { seen = true; clearTimeout(quiet); quiet = setTimeout(done, 900); });
  // an agent that never draws gets the question anyway when it came from the phone: nobody here would retype it
  const cap = setTimeout(() => { if (seen || send) done(); else sub.dispose(); }, send ? 8000 : 20000);
}

// Paste a message into an agent's prompt and send it. Enter comes a moment later: sent together with the
// paste, some TUIs take it as a newline inside the pasted text.
function submit(id, text) {
  const t = ptys.get(id);
  if (!t) return;
  t.p.write(`\x1b[200~${text}\x1b[201~`);
  setTimeout(() => { if (ptys.get(id) === t) t.p.write('\r'); }, 400);
}

// ---------------------------------------------------------------- phone

// The phone's first prompt for an agent it asked for, until the renderer has opened that agent's terminal.
const phonePrompts = new Map();
function startPhone() {
  phone.start({
    projects,
    kinds: () => Object.keys(config().profiles).filter((k) => k !== 'shell'),
    ptyOf: (pid) => { const a = WIN && listAgents().find((x) => x.pid === pid); const host = a ? hostOf(a) : pid; return [...ptys].find(([, t]) => t.pid === host)?.[0] || null; },
    write: (id, data) => ptys.get(id)?.p.write(data),
    submit,
    spawn: ({ req, cwd, kind, prompt }) => {
      if (prompt) phonePrompts.set(req, prompt);
      win?.webContents.send('phone:spawn', { req, cwd, kind });
    },
    changed: (e) => {
      win?.webContents.send('phone:changed', e);
      if (e.asking && Notification.isSupported()) {
        const n = new Notification({ title: 'A phone wants to use this Mac', body: `${e.asking} signed in to your Synapse account. Allow it in Synapse settings.` });
        n.on('click', () => { win?.show(); win?.webContents.send('phone:show'); });
        n.show();
      }
    },
  });
}

// ---------------------------------------------------------------- synapse canvas

// The canvas is Synapse's own web UI, served by this checkout's server on a port of its own: a server started
// from another checkout would serve a canvas that does not know how to talk to the app.
const CANVAS_PORT = Number(process.env.SYNAPSE_APP_PORT || 0);
let canvasProc = null, canvasStart = null;
async function ensureCanvas() {
  if (canvasStart) return canvasStart;
  canvasStart = new Promise((resolve, reject) => {
    canvasProc = spawn(process.execPath, [path.join(ROOT, '..', 'server.mjs')], {
      env: { ...process.env, SYNAPSE_HOME: DATA, ELECTRON_RUN_AS_NODE: '1', PORT: String(CANVAS_PORT), NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { canvasProc?.kill(); reject(new Error('The local Synapse server did not start.')); }, 15000);
    let output = '';
    canvasProc.stdout.on('data', (data) => {
      output += data;
      const port = output.match(/synapse running at http:\/\/localhost:(\d+)/)?.[1];
      if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}/`); }
    });
    canvasProc.stderr.on('data', (data) => { if (process.env.SYNAPSE_DEBUG) console.error(String(data)); });
    canvasProc.on('error', (error) => { clearTimeout(timer); reject(error); });
    canvasProc.on('exit', () => { clearTimeout(timer); canvasProc = null; canvasStart = null; reject(new Error('The local Synapse server stopped.')); });
  }).catch((error) => { canvasStart = null; throw error; });
  return canvasStart;
}
// The canvas server also syncs with friends and answers their agents' questions, so a connected machine (signed
// in, or with friends) runs it from launch, not from the first canvas open. Others start it lazily as before.
const TALK_CHECK = 30_000;
function serveFriends() {
  try { if (!canvasProc && isConnected()) ensureCanvas().catch(() => {}); } catch {}
}

// ---------------------------------------------------------------- window

function createWindow({ show = !startedHidden() } = {}) {
  win = new BrowserWindow({
    show,
    width: 1440, height: 900, minWidth: 900, minHeight: 560,
    ...(WIN ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#E8E6E1' : '#1A1A1A', height: 48 } }
      : { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } }),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0B0B' : '#F1EFE9',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  if (process.env.SYNAPSE_SHOT || process.env.SYNAPSE_DEBUG) {
    win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning' || process.env.SYNAPSE_DEBUG) console.log(`[renderer] ${e.message}`); });
    win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', d.reason));
  }
  // ⌘G toggles the canvas even while focus is inside it (the canvas is a separate page, its keys never reach ours)
  win.webContents.on('before-input-event', (e, i) => {
    // ⌘Tab belongs to macOS (the app switcher never lets it through), so the node view also toggles on ⌃Tab
    const g = (WIN ? i.control && i.shift : i.meta && !i.shift) && !i.alt && i.key.toLowerCase() === 'g';
    const tab = i.control && !i.meta && !i.alt && i.key === 'Tab';
    if (i.type === 'keyDown' && (g || tab)) { e.preventDefault(); win.webContents.send('canvas:toggle'); }
  });
  win.on('closed', () => { win = null; });
  win.on('app-command', (_e, command) => {
    if (command === 'browser-backward') win?.webContents.send('canvas:back');
    if (command === 'browser-forward' && win?.webContents.navigationHistory.canGoForward()) win.webContents.navigationHistory.goForward();
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

// ---------------------------------------------------------------- first launch

// A packaged app opened from the DMG or Downloads offers to move itself to /Applications (macOS relaunches it).
function offerMove() {
  if (!app.isPackaged || process.env.SYNAPSE_HOME || process.platform !== 'darwin' || app.isInApplicationsFolder()) return;
  const response = dialog.showMessageBoxSync({
    type: 'question', buttons: ['Move to Applications', 'Not now'], defaultId: 0, cancelId: 1,
    message: 'Move Synapse to your Applications folder?', detail: 'It keeps Synapse in one place and lets it update itself.',
  });
  if (response !== 0) return;
  try { app.moveToApplicationsFolder(); } catch (e) { dialog.showErrorBox('Could not move Synapse', String(e.message || e)); }
}

// The first time the packaged app opens, intro.html plays over the whole screen (neurons firing into the name, with sound) and the main
// window appears as it fades. SYNAPSE_INTRO=1 plays it on every run, for trying it out from source.
const FORCE_INTRO = process.env.SYNAPSE_INTRO === '1';
function wantsIntro() {
  if (FORCE_INTRO) return true;
  if (!app.isPackaged || process.env.SYNAPSE_HOME || startedHidden() || process.env.SYNAPSE_SHOT) return false;
  if (systemPreferences.getAnimationSettings?.().prefersReducedMotion) return false;
  return !seen().intro && !readJSON(FILES.app, {}).introPlayed;
}
function playIntro() {
  return new Promise((resolve) => {
    const { bounds } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const intro = new BrowserWindow({
      ...bounds, frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, enableLargerThanScreen: true, show: false, backgroundColor: '#00000000',
      webPreferences: { contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    intro.setAlwaysOnTop(true, 'screen-saver'); // above the menu bar and the Dock
    intro.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    intro.setIgnoreMouseEvents(true);
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(guard); if (!intro.isDestroyed()) intro.destroy(); resolve(); };
    const guard = setTimeout(finish, 8000); // the page closes itself at the end; never leave it over the screen
    intro.on('closed', finish);
    intro.once('ready-to-show', () => intro.showInactive());
    if (!FORCE_INTRO) markSeen('intro'); // before it plays: a crash or quit mid-intro still counts as seen
    intro.loadFile(path.join(ROOT, 'renderer', 'intro.html')).catch(finish);
  });
}

app.whenReady().then(() => {
  if (WIN) Menu.setApplicationMenu(null); // its accelerators (Ctrl+W closes the window, Ctrl+R reloads) belong to the terminals
  offerMove();
  if (wantsIntro()) {
    createWindow({ show: false });
    playIntro();
    setTimeout(() => { win?.show(); win?.focus(); }, 2800); // the window rises under the fading intro
  } else createWindow();
  pollRequests(); setInterval(pollRequests, REQUEST_POLL);
  serveFriends(); setInterval(serveFriends, TALK_CHECK);
  startPhone();
  setTimeout(autoSetup, 4000);
  if (UPDATES) { setTimeout(() => updater.check(), UPDATE_DELAY); setInterval(() => updater.check(), UPDATE_EVERY); }
  let refreshing = false;
  setInterval(async () => {
    if (!win || refreshing || quitting) return;
    refreshing = true;
    try { await discovery.refresh(); if (win && !quitting) { const st = state(); win.webContents.send('state', st); notifyTalks(st.talks); notifyTalkRequests(st.talkRequests); suggestLogin(st.edges); pumpForks(); } }
    catch (error) { if (!quitting) console.error('State refresh:', error.message); }
    finally { refreshing = false; }
  }, 1000);
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
app.on('activate', () => { if (win && !win.isVisible()) { win.show(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
// Kill every session's whole process group (agent wrappers spawn helpers that outlive a plain SIGHUP), then exit
// without Node's handle cleanup: node-pty's exit-watcher threads otherwise block shutdown forever.
// Kill every session's whole process group (agent wrappers spawn helpers that outlive a plain SIGHUP) and quit
// only once node-pty has seen them all exit: its exit-watcher threads otherwise block or crash Node's shutdown.
let quitting = false;
app.on('before-quit', (e) => {
  discovery.close();
  phone.stopShares(); // no tunnel outlives the app
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
const UPDATES = (app.isPackaged && !app.getVersion().includes('-')) || !!process.env.SYNAPSE_UPDATE_URL;
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
// SYNAPSE_FAKE_REQUESTS=<file.json> drives the requests feed from a file ({ incoming, outgoing, links, incomingTrust }),
// for screenshots and the circle tests; accept, deny, trust back and ignore edit the file the way the cloud would.
const FAKE = process.env.SYNAPSE_FAKE_REQUESTS || '';
const fake = () => ({ incoming: [], outgoing: [], links: [], incomingTrust: [], ...readJSON(FAKE, {}) });

let feed = { incoming: [], outgoing: [], links: [], incomingTrust: [] };
let notified = null; // ids of incoming requests already announced; null until the first poll so old ones stay quiet
async function pollRequests() {
  let next;
  if (FAKE) next = fake();
  else {
    const a = await acct().catch(() => null);
    if (!a?.account()) next = { incoming: [], outgoing: [], links: [], incomingTrust: [] };
    else {
      let r;
      try { r = await a.requests(); } catch { return; } // offline: keep showing what we had
      let links = [];
      try { links = a.externalLinks(); } catch {}
      const canOffer = (await a.cloudFeatures().catch(() => [])).includes('offers');
      next = { incoming: r.incoming || [], outgoing: r.outgoing || [], links, incomingTrust: r.incomingTrust || [], canOffer, offersLater: canOffer ? '' : a.OFFERS_LATER };
    }
  }
  feed = next;
  const pending = feed.incoming.filter((r) => r.status === 'pending');
  if (notified && Notification.isSupported() && !process.env.SYNAPSE_SHOT) {
    for (const r of pending) {
      if (notified.has(r.id)) continue;
      const who = r.from?.name || r.from?.handle || 'Someone';
      const n = new Notification({ title: 'Synapse', body: r.kind === 'offer' ? `${who} shared ${r.agent?.name || 'an agent'} with you` : `${who} wants to synapse with your agents` });
      n.on('click', () => { if (!win) return; win.show(); win.focus(); win.webContents.send('requests:open'); });
      n.show();
    }
  }
  notified = new Set(pending.map((r) => r.id));
  notifyTrust(feed.incomingTrust || []);
  win?.webContents.send('requests', feed);
}
// A person's access, from settings: how one of my shares with them works (read only or read and ask), or stop it.
// Answers with the fresh links so the card redraws from what is true now. The fake feed edits its file instead.
async function changeShare(id, change) {
  if (FAKE) {
    const f = fake();
    f.links = f.links.flatMap((l) => (l.edgeId !== id ? [l] : change === 'remove' ? [] : [{ ...l, mode: change }]));
    writeJSON(FAKE, f);
  } else if (change === 'remove') removeEdge(id);
  else setMode(id, change);
  await pollRequests();
  return feed.links;
}

// Someone added me as a trusted person: one notification per person, ever (remembered in app.json), not one per poll.
const trustKey = (p) => (p.handle ? `@${p.handle}` : p.userId || p.id || '');
function notifyTrust(list) {
  const c = config(), seen = new Set(c.trustNotified || []);
  const fresh = list.filter((p) => trustKey(p) && !seen.has(trustKey(p)));
  if (!fresh.length) return;
  for (const p of fresh) seen.add(trustKey(p));
  c.trustNotified = [...seen].slice(-500);
  writeJSON(FILES.app, c);
  if (!Notification.isSupported() || process.env.SYNAPSE_SHOT) return;
  for (const p of fresh) {
    const n = new Notification({ title: 'Synapse', body: `${p.handle ? `@${p.handle}` : p.name || 'Someone'} added you as a trusted person. Trust them back?` });
    n.on('click', () => { if (!win) return; win.show(); win.focus(); win.webContents.send('requests:open'); });
    n.show();
  }
}
const accountChanged = async () => { const a = await acct(); win?.webContents.send('account', a.account()?.user || null); pollRequests(); phone.wake(); };

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

const handle = (ch, fn) => ipcMain.handle(ch, async (event, a) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return { ok: false, error: 'Untrusted app frame.' };
  try { return { ok: true, value: await fn(a || {}) }; } catch (e) { return { ok: false, error: e.message }; }
});
handle('state', async () => { await discovery.refresh(); return state(); });
handle('flags', () => ({ demo: DEMO, packaged: app.isPackaged, view: process.env.SYNAPSE_DESKTOP_VIEW || '', shot: process.env.SYNAPSE_SHOT_VIEW || '', steps: JSON.parse(process.env.SYNAPSE_SHOT_STEPS || '[]'), cwd: process.cwd(), home: os.homedir() }));
handle('pty:spawn', (a) => {
  const r = spawnPty(a);
  if (a.phoneReq) { // a terminal the phone asked for: its first prompt goes in once the agent is ready
    phone.spawned(a.phoneReq, r.id);
    prefill(r.id, phonePrompts.get(a.phoneReq), true);
    phonePrompts.delete(a.phoneReq);
  }
  return r;
});
handle('phone:devices', () => phone.devices());
handle('phone:allow', ({ id }) => phone.allow(id));
handle('phone:remove', ({ id }) => phone.remove(id));
handle('phone:shares', () => phone.liveShares());
handle('phone:unshare', ({ id }) => phone.stopShare(id));
handle('pty:write', ({ id, data }) => { ptys.get(id)?.p.write(data); });
handle('pty:submit', ({ id, text }) => {
  if (!ptys.has(id)) throw new Error('This session has ended.');
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw new Error('Write a prompt between 1 and 12,000 characters.');
  submit(id, text);
});
// the program in front in a terminal (zsh, claude, `node .../codex.js`): its command line, from the tty's foreground
// process group. Windows has no such thing to ask: there it is the name node-pty knows
handle('pty:foreground', ({ id }) => {
  const t = ptys.get(id);
  if (!t) return '';
  if (WIN) return t.p.process || '';
  try {
    const pgid = execFileSync('ps', ['-o', 'tpgid=', '-p', String(t.pid)], { encoding: 'utf8', timeout: 2000 }).trim();
    return execFileSync('ps', ['-o', 'args=', '-p', pgid], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch { return t.p.process || ''; }
});
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
const UI_STATE = path.join(DATA, 'workspace-ui.json');
const UI_KEYS = new Set(['synapse-mode', 'synapse-selected', 'synapse-sidebar', 'synapse-inspector', 'synapse-drafts', 'synapse-collapsed']);
handle('workspace:load', () => readJSON(UI_STATE, {}));
handle('workspace:save', ({ key, value }) => {
  if (!UI_KEYS.has(key) || typeof value !== 'string' || value.length > 768 * 1024) throw new Error('Invalid workspace preference.');
  writeJSON(UI_STATE, { ...readJSON(UI_STATE, {}), [key]: value });
});
handle('canvas', () => ensureCanvas());
function setupIntegrations(dry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, '..', 'install.mjs'), ...(dry ? ['--dry-run'] : [])], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: userPath() || process.env.PATH, SYNAPSE_HOME: DATA, ...(process.env.SYNAPSE_USER_HOME ? { HOME: process.env.SYNAPSE_USER_HOME } : {}) }, stdio: ['ignore', 'pipe', 'pipe'], // a test's home stays the home the agent CLIs write to
    });
    let report = '', errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Agent setup timed out. Try again.')); }, 30000);
    child.stdout.on('data', (data) => { report += data; });
    child.stderr.on('data', (data) => { errors += data; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(report) : reject(new Error(errors || report || 'Agent setup failed.')); });
  });
}
// The installed app wires itself into the agent CLIs (MCP server, prompt hook, the synapse skill, the `synapse`
// launcher) on its first launch and again after each update, so nobody has to find "Set up" in Settings. Not from
// the DMG or Downloads (the paths would point into a volume that goes away) and not in dev or tests, unless
// SYNAPSE_AUTO_SETUP=1. It runs again when a new agent CLI shows up. The tunnel helper for the phone ships inside the app, so it needs nothing here.
async function autoSetup() {
  const forced = process.env.SYNAPSE_AUTO_SETUP === '1';
  if (!forced && (!app.isPackaged || process.env.SYNAPSE_HOME || (process.platform === 'darwin' && !app.isInApplicationsFolder()))) return;
  const version = app.getVersion();
  // also when an agent CLI turns up after the last setup (Codex installed a week after Synapse)
  const home = os.homedir(), clis = ['.claude', '.codex', '.gemini', '.cursor', '.copilot', '.config/amp', '.config/opencode'].filter((d) => fs.existsSync(path.join(home, d))).join(' ');
  if (!forced && seen().setup === version && (seen().setupClis ?? clis) === clis) return;
  try {
    const report = await setupIntegrations(false);
    writeJSON(SEEN, { ...seen(), setup: version, setupClis: clis });
    const added = report.split('\n').filter((l) => l.startsWith('added')).length;
    if (added) win?.webContents.send('setup:done', { report, added });
  } catch (e) { console.error('Agent setup:', e.message); }
}
handle('integrations:preview', () => setupIntegrations(true));
handle('integrations:install', () => setupIntegrations(false));
handle('project:add', ({ path: p }) => addWorkspace(p));
handle('project:create', ({ name }) => createWorkspace(name));
handle('project:clone', ({ url, name }) => cloneWorkspace(url, name));
handle('project:pick', () => pickFolder());
handle('project:library', () => library());
// chats from before Synapse (Claude Code, Codex): import links their session folders in, past lists them
handle('history:sources', () => chats.sources());
handle('history:import', ({ kind }) => { const out = chats.importChats(kind); chats.pastChats().catch(() => {}); return out; }); // index it now, so the list opens quick
handle('history:remove', ({ kind }) => chats.removeChats(kind));
handle('history:past', () => chats.pastChats());
handle('project:rename', ({ key, name }) => {
  const all = projects();
  if (!all.some((p) => p.key === key)) throw new Error('workspace is no longer open');
  name = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 48);
  if (name && all.some((p) => p.key !== key && p.label.toLowerCase() === name.toLowerCase())) throw new Error('another workspace already has that name');
  return renameProject(key, name);
});
const settingsOut = (c) => ({ profiles: c.profiles, openAtLogin: loginOpen(), autoSymlink: !!c.autoSymlink, autoSendFork: !!c.autoSendFork, notifyDone: c.notifyDone !== false, doneSound: DONE_SOUNDS.includes(c.doneSound) ? c.doneSound : 'bubbleTap', errorSound: c.errorSound !== false, talkPerHour: talkPerHour(), talkModel: talkModel() });
handle('settings:get', () => settingsOut(config()));
// an agent finished a turn while Synapse was in the background (the renderer decides when): say so, with the
// start of its last reply; a click brings that session to the front
const lastReply = (pty) => {
  const id = agentsByPty()[pty]?.synapseId, a = id && listAgents().find((x) => x.id === id);
  if (!a) return '';
  const said = readAgentMessages(a, null, { tailBytes: 262144 }).messages.filter((m) => m.role === 'assistant' && !m.tool).at(-1)?.text || '';
  const t = said.replace(/\s+/g, ' ').trim();
  return t.length > 140 ? t.slice(0, 139) + '…' : t;
};
const DONE_SOUNDS = ['bubbleTap', 'perk', 'off']; // the renderer plays them (app/renderer/sounds.js), so notifications stay silent
handle('notify:done', ({ pty, title, took }) => {
  if (config().notifyDone === false || !Notification.isSupported() || process.env.SYNAPSE_SHOT) return false;
  const mins = Math.round(took / 60_000);
  let body = '';
  try { body = lastReply(pty); } catch {}
  const n = new Notification({ title: `${title} is done${mins >= 1 ? ` · ${mins} min` : ''}`, body: body || 'Its turn is over. Click to open it.', silent: true });
  n.on('click', () => { if (!win) return; win.show(); win.focus(); win.webContents.send('notify:open', pty); });
  n.show();
  return true;
});
handle('share:mode', ({ id, mode }) => changeShare(id, mode === 'talk' ? 'talk' : 'sync'));
handle('share:remove', ({ id }) => changeShare(id, 'remove'));
// the activity view: GitHub, commits and prompts over the last year; the first count reads every transcript, so it reports progress
const countActivity = () => collectActivity({ repos: config().workspaces, cacheFile: path.join(DATA, 'activity.json'), env: cleanEnv(), onProgress: (p) => win?.webContents.send('activity:progress', p) });
handle('activity:get', async () => {
  const a = await countActivity();
  // on the friends board: send this week's numbers whenever they are counted again
  if (config().board) acct().then((m) => m.account() && m.boardSend(lastWeek(a))).catch(() => {});
  return a;
});
// the friends board in the activity view; joining sends your last 7 days, leaving deletes them on the cloud
handle('board:get', async () => {
  const m = await acct();
  if (!m.account()) return { signedIn: false };
  return { signedIn: true, ...(await m.board()) };
});
handle('board:join', async () => {
  const m = await acct();
  const out = await m.boardSend(lastWeek(await countActivity()));
  const c = config(); c.board = true; writeJSON(FILES.app, c);
  return { signedIn: true, ...out };
});
handle('board:leave', async () => {
  const c = config(); c.board = false; writeJSON(FILES.app, c);
  return { signedIn: true, ...(await (await acct()).boardLeave()) };
});
handle('talk:usage', () => talkHistory('api/talks/usage'));
handle('settings:set', (patch) => {
  const c = config();
  if (patch.profiles) {
    for (const [kind, profile] of Object.entries(patch.profiles)) {
      if (!Object.hasOwn(c.profiles, kind) || typeof profile.command !== 'string' || profile.command.length > 2048 || /\0/.test(profile.command) || (kind !== 'shell' && !profile.command.trim())) throw new Error('Enter a valid command for each agent.');
    }
    for (const [kind, profile] of Object.entries(patch.profiles)) c.profiles[kind] = { ...c.profiles[kind], command: profile.command.trim() };
  }
  if ('autoSymlink' in patch) c.autoSymlink = !!patch.autoSymlink;
  if ('autoSendFork' in patch) c.autoSendFork = !!patch.autoSendFork;
  if ('notifyDone' in patch) c.notifyDone = !!patch.notifyDone;
  if ('doneSound' in patch) c.doneSound = DONE_SOUNDS.includes(patch.doneSound) ? patch.doneSound : 'bubbleTap';
  if ('errorSound' in patch) c.errorSound = !!patch.errorSound;
  if ('openAtLogin' in patch) setLoginOpen(patch.openAtLogin);
  if ('talkPerHour' in patch) c.talkPerHour = clampPerHour(patch.talkPerHour);
  if ('talkModel' in patch) c.talkModel = ['opus', 'sonnet', 'haiku'].includes(patch.talkModel) ? patch.talkModel : 'agent';
  writeJSON(FILES.app, c);
  if ('autoSymlink' in patch && c.autoSymlink) scanLibrary(true);
  return settingsOut(c);
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
// which of the paths a terminal shows exist ("src/x.ts:12", "~/notes.md", "/abs/dir"), resolved against the session's folder
handle('files:exists', ({ cwd, paths }) => Object.fromEntries((Array.isArray(paths) ? paths : []).slice(0, 200).map((raw) => {
  let p = String(raw).replace(/^file:\/\//, '').replace(/(#L\d+(-L?\d+)?|:\d+(:\d+)?(-\d+)?)$/, '');
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  try { fs.statSync(path.resolve(cwd || os.homedir(), p)); return [raw, true]; } catch { return [raw, false]; }
})));
// end an agent the app did not start; only pids Synapse knows as agents, never anything else
handle('agent:kill', ({ pid }) => {
  pid = Number(pid);
  if (!listAgents().some((a) => a.pid === pid)) throw new Error('that is not a running agent');
  process.kill(pid, 'SIGTERM');
});
// a tab renamed in the sidebar renames the Synapse agent in its pty, so the node view shows the same name
handle('agent:rename', ({ pty, name }) => {
  const t = ptys.get(pty);
  const a = t && listAgents().find((x) => hostOf(x) === t.pid);
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
// the first-run onboarding: on a new install only (SYNAPSE_ONBOARDING=1 shows it every run, for trying it out);
// settings can replay it at any time
handle('onboarding:get', () => ({ show: process.env.SYNAPSE_ONBOARDING === '1' || (FIRST_RUN && !seen().onboarding && !process.env.SYNAPSE_SHOT) }));
handle('onboarding:done', () => { markSeen('onboarding'); });
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
handle('people:add', async ({ who }) => { const out = await (await acct()).trust(who); pollRequests(); return out; });
// someone added me: trust them back, or ignore them (the cloud remembers and stops asking)
handle('trust:back', async ({ id, handle: h }) => {
  if (!h) throw new Error('this person has no handle yet, try again in a moment');
  let out = null;
  if (FAKE) { const f = fake(), p = f.incomingTrust.find((x) => x.id === id || x.handle === h); f.incomingTrust = f.incomingTrust.filter((x) => x !== p); (f.people ||= []).push({ id: `p-${id}`, handle: h, name: p?.name || h, trustsYou: true }); writeJSON(FAKE, f); }
  else out = await (await acct()).trust(h);
  await pollRequests();
  return out;
});
handle('trust:ignore', async ({ id }) => {
  if (!id) throw new Error('still loading this person, try again in a moment');
  if (FAKE) { const f = fake(); f.incomingTrust = f.incomingTrust.filter((x) => x.id !== id); (f.dismissed ||= []).push(id); writeJSON(FAKE, f); }
  else await (await acct()).dismissTrust(id);
  await pollRequests();
});
handle('people:remove', async ({ id }) => (await acct()).untrust(id));
handle('requests:list', () => feed);
handle('requests:agents', () => localAgentList());
// accept and deny answer the cloud, then poll at once so the circle changes without waiting for the next tick
async function decide(id, fn, extra = {}) {
  if (FAKE) {
    const f = fake(), r = f.incoming.find((x) => x.id === id);
    if (r) { f.incoming = f.incoming.filter((x) => x !== r); if (fn === 'accept') { f.links.push({ direction: 'out', owner: r.from?.name || r.from?.handle, agent: r.agent, local: { id: 'local', name: 'local' }, edgeId: `fake-${id}` }); (f.accepted ||= []).push({ id, ...extra }); } writeJSON(FAKE, f); }
  }
  await pollRequests();
}
// talk: let their agent ask the shared agents questions too (the accept popover's checkbox, ticked by default)
// Share: the open agent goes to a trusted person as an offer; they pick which of their agents receives it
handle('share:offer', async ({ to, agent, mode }) => {
  const a = listAgents().find((x) => x.id === agent && !x.remote);
  if (!a) throw new Error('open the agent you want to share first');
  let out;
  if (FAKE) {
    const f = fake(), p = (f.people || []).find((x) => x.handle === to || x.id === to);
    out = { id: `o-${Date.now()}`, kind: 'offer', mode: mode === 'talk' ? 'talk' : 'sync', status: 'pending', to: { handle: p?.handle || to, name: p?.name || to }, agent: { id: a.id, name: a.name, kind: a.kind } };
    f.outgoing = [out, ...(f.outgoing || [])];
    writeJSON(FAKE, f);
  } else out = await (await acct()).sendOffer({ to, agent: a, mode });
  await pollRequests();
  return out;
});
// ask a trusted person for one of their agents: it comes into my agent `agent` once they accept and pick one
handle('requests:ask', async ({ to, agent, target, note }) => {
  const a = listAgents().find((x) => x.id === agent && !x.remote);
  if (!a) throw new Error('pick which of your agents should receive it');
  let out;
  if (FAKE) {
    const f = fake(), p = (f.people || []).find((x) => x.handle === to || x.id === to);
    out = { id: `a-${Date.now()}`, kind: 'ask', status: 'pending', to: { handle: p?.handle || to, name: p?.name || to }, agent: { id: a.id, name: a.name, kind: a.kind }, target: target || null, note: note || null };
    f.outgoing = [out, ...(f.outgoing || [])];
    writeJSON(FAKE, f);
  } else out = await (await acct()).sendRequest({ to, agent: a, target: String(target || '').trim() || undefined, note: String(note || '').trim() || undefined });
  await pollRequests();
  return out;
});
// an offer to me: it goes into the agent of mine picked here
handle('requests:acceptOffer', async ({ id, receiver }) => {
  if (FAKE) {
    const f = fake(), r = f.incoming.find((x) => x.id === id), mine = listAgents().find((x) => x.id === receiver);
    if (r) { f.incoming = f.incoming.filter((x) => x !== r); f.links.push({ direction: 'in', owner: r.from?.name, handle: r.from?.handle, mode: r.mode || 'sync', agent: r.agent, local: { id: receiver, name: mine?.name || receiver }, edgeId: `fake-${id}` }); (f.accepted ||= []).push({ id, receiver }); writeJSON(FAKE, f); }
  } else await (await acct()).acceptOffer(id, receiver);
  await pollRequests();
});
handle('requests:accept', async ({ id, agents, talk = true }) => { const out = FAKE ? null : await (await acct()).accept(id, agents, { talk: !!talk }); await decide(id, 'accept', { agents, talk: !!talk }); return out; });
// a friend's agent asked one of mine over a read-only share: Allow switches that share to talk, Not now waits a day
handle('talkreq:allow', ({ id }) => { const out = allowTalkRequest(id); win?.webContents.send('state', state()); return out; });
handle('talkreq:dismiss', ({ id }) => { const out = dismissTalkRequest(id); win?.webContents.send('state', state()); return out; });
handle('requests:deny', async ({ id }) => { const out = FAKE ? null : await (await acct()).deny(id); await decide(id, 'deny'); return out; });
handle('requests:cancel', async ({ id }) => { const out = await (await acct()).cancel(id); await pollRequests(); return out; });
handle('update:get', () => ({ ...updater.state, enabled: UPDATES }));
handle('update:check', async () => ({ ...(await updater.check()), enabled: UPDATES }));
handle('update:install', () => { if (updater.install({ relaunch: true, open: UPDATE_OPEN })) setTimeout(() => app.quit(), 50); });
handle('update:download', () => { const u = updater.state.dmg; if (u) shell.openExternal(u); });
handle('talks:list', () => talkHistory());
handle('links', async () => (FAKE ? fake().links : (await acct()).externalLinks()));
// a collapsed child shares with its parent on demand: the parent can read it, nothing is pushed into its prompt
handle('fork:link', ({ child, parent }) => {
  const agents = listAgents(), from = agents.find((a) => a.id === child), to = agents.find((a) => a.id === parent);
  if (!from || !to) throw new Error('that agent is gone');
  return createEdge(from, to, { onDemand: true }).created;
});
