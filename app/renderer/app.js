// Renderer: owns the slot model (project → worktree → slot → stack of sessions), draws the
// sidebar, the deck of cards, the terminals and the fan-out tree. PTYs live in the main process.
import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';

const $ = (s) => document.querySelector(s);
// Windows has no ⌘: the app's shortcuts are Ctrl+Shift+key there (Alt adds what ⇧ adds on a Mac), and every
// title and hint written with Mac glyphs is rewritten to say so (winKeys below)
const WIN = navigator.userAgent.includes('Windows');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// Small inline SVGs inherit the current theme and need no image dependency.
function gitIcon(kind) {
  const paths = {
    branch: '<circle cx="5" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><circle cx="15" cy="4" r="2"/><path d="M5 6v8m10-8c0 5-10 2-10 8"/>',
    worktree: '<path d="M3 4h5l2 3h7v10H3zM7 11h6m-3-3v6"/>',
    remote: '<path d="M5 14a4 4 0 0 1 0-8 5 5 0 0 1 9-1 4.5 4.5 0 0 1 1 9M10 10v8m-3-3 3 3 3-3"/>',
    OPEN: '<circle cx="5" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><circle cx="15" cy="16" r="2"/><path d="M5 6v8m10 0V8c0-3-3-4-5-4m2-2-2 2 2 2"/>',
    CLOSED: '<circle cx="5" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><path d="M5 6v8m7-10 5 5m0-5-5 5m2 3v4"/>',
    MERGED: '<circle cx="5" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><circle cx="15" cy="4" r="2"/><path d="M5 6v8m0-7c0 5 10 2 10-1"/>',
    trash: '<path d="M3 5h14M8 5V2h4v3M5 5l1 13h8l1-13M8 8v7m4-7v7"/>',
  };
  const icon = el('span', 'git-icon');
  icon.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind] || paths.branch}</svg>`;
  return icon;
}
const prStatuses = new Map();
function prBadge(pr) {
  const badge = gitIcon(pr.state);
  badge.classList.add('pr-status', pr.state.toLowerCase());
  badge.title = `PR #${pr.number} · ${pr.state.toLowerCase()}`;
  badge.setAttribute('role', 'img'); badge.setAttribute('aria-label', badge.title);
  return badge;
}

// ---------------------------------------------------------------- model

const M = {
  projects: [],   // from main: { key, label, path, color, worktrees: [{ path, branch, name }] }
  agents: {},     // ptyId -> { synapseId, name, kind, status }
  unread: {},     // synapseId -> count
  talks: [],      // open agent talk conversations, both sides: { id, role, peerName, peerHandle, target, targetName, ... }
  profiles: {},
  slots: [],      // { id, worktree, sessions: [Session], path: [sessionId] }
  collapsed: new Set(), // hidden child branches; sessions keep running
  layouts: [],    // split trees: slot id leaves, or { direction, first, second }
  focused: null,  // slot id
  open: new Set(),// collapsed projects are not in here
  demo: false,
};
let nextId = 1;
// Session: { id, pty, kind, title, question, parent, status, exited, term, fit, el }

const slot = (id) => M.slots.find((s) => s.id === id);
const focusedSlot = () => slot(M.focused);
const sess = (s, id) => s.sessions.find((x) => x.id === id);
const children = (s, id) => s.sessions.filter((x) => x.parent === id);
const top = (s) => s && sess(s, s.path[s.path.length - 1]);
const root = (s) => s.sessions.find((x) => x.parent == null);
const worktreeOf = (p) => { for (const pr of M.projects) for (const w of pr.worktrees) if (w.path === p) return { project: pr, worktree: w }; return null; };

function focusPath(s, id) {
  const path = [];
  for (let cur = id; cur != null; cur = sess(s, cur)?.parent) path.unshift(cur);
  s.path = path;
  for (const id of path) M.collapsed.delete(id);
}

function selectSession(s, id = top(s)?.id) {
  M.focused = s.id;
  if (id != null) focusPath(s, id);
  closeCanvas();
  render();
  if (!workspaceOpen && $('#modal').hidden && !fanOpen) top(s)?.term.focus();
}

function statusOf(x) {
  if (x.exited) return 'exited';
  if (x.kind === 'shell') return 'shell';
  const a = M.agents[x.pty];
  if (!a) return 'idle';
  const st = agentWorking(a) ? 'working' : a.status === 'waiting' || a.status === 'needs_input' ? 'waiting' : 'idle';
  // an agent that has worked and gone quiet is done: its square lights green until it starts again
  return st === 'idle' && x.ran ? 'done' : st;
}
const agentWorking = (a) => a.status === 'busy' || a.status === 'working' || a.status === 'running';

// ---------------------------------------------------------------- terminals

const termTheme = () => {
  const night = document.documentElement.dataset.theme === 'night';
  const css = getComputedStyle(document.documentElement);
  return {
    background: css.getPropertyValue('--term-bg').trim(), foreground: css.getPropertyValue('--ink').trim(),
    cursor: css.getPropertyValue('--sig').trim(), cursorAccent: css.getPropertyValue('--term-bg').trim(),
    selectionBackground: night ? 'rgba(255,90,31,.35)' : 'rgba(255,68,0,.22)',
    black: night ? '#2a2a2a' : '#16130F', red: '#D64545', green: '#2F8F5B', yellow: '#B8860B', blue: '#2F5BEA', magenta: '#B0306A', cyan: '#1D9BB0', white: night ? '#EDEDEA' : '#6B6B6B',
    brightBlack: '#8A867E', brightRed: '#FF5A5A', brightGreen: '#3DB874', brightYellow: '#E3A600', brightBlue: '#5B84FF', brightMagenta: '#E5458F', brightCyan: '#39B6CC', brightWhite: night ? '#FFFFFF' : '#16130F',
  };
};

async function makeSession(s, { kind, title, question = null, parent = null, key = null, spawn }) {
  const wrap = el('div', 'term');
  $('#stage').appendChild(wrap);
  const term = new Terminal({
    fontFamily: "'Fragment Mono', Menlo, monospace", fontSize: 13, lineHeight: 1.25, cursorBlink: true, cursorStyle: 'bar',
    allowProposedApi: true, scrollback: 5000, theme: termTheme(), macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // measure while shown: a hidden element makes fit() fall back to 80x24, and the pty would start at that size
  const wasVisible = wrap.classList.contains('visible');
  wrap.classList.add('visible');
  term.open(wrap);
  // app shortcuts pass through; the macOS editing keys xterm drops or mis-sends become their readline
  // bytes (⌘⌫ clears the line, ⌘← / ⌘→ jump to its ends); everything else goes to the pty as is
  term.attachCustomKeyEventHandler((e) => {
    // Shells keep Enter; agents receive the enhanced-keyboard newline sequence.
    if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey && !e.isComposing) {
      e.preventDefault(); term.input(kind === 'shell' ? '\r' : '\x1b[13;2u'); return false;
    }
    if (e.type === 'keydown' && agentKey(e)) return false; // ⌃1-9 launch agents, never reach the pty
    if (WIN && e.type === 'keydown' && e.ctrlKey && !e.altKey) { // Windows terminal habits: Ctrl+V pastes, Ctrl+Shift+C/V copy and paste
      if (!e.shiftKey && e.code === 'KeyV') return false; // the browser's paste event reaches xterm
      if (e.shiftKey && e.code === 'KeyC') { e.preventDefault(); const sel = term.getSelection(); if (sel) navigator.clipboard.writeText(sel); return false; }
      if (e.shiftKey && e.code === 'KeyV') { e.preventDefault(); navigator.clipboard.readText().then((t) => t && term.paste(t)); return false; }
      if (!e.shiftKey && e.code === 'KeyC' && term.hasSelection()) { e.preventDefault(); navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
    }
    if (!appMod(e) || e.type !== 'keydown') return true;
    if (APP_KEYS.has(keyName(e))) return false;
    const bytes = (WIN ? !e.altKey : !e.shiftKey && !e.altKey && !e.ctrlKey) && META_EDIT[e.key];
    if (!bytes) return true;
    e.preventDefault(); term.input(bytes); return false;
  });
  fit.fit();
  if (!wasVisible) wrap.classList.remove('visible'); // renderStage() decides what is shown
  let pty, pid;
  try { ({ id: pty, pid } = await spawn(term.cols, term.rows)); }
  catch (error) { term.dispose(); wrap.remove(); throw error; }
  synapse.pty.resize(pty, term.cols, term.rows); // whatever the spawner defaulted to, the pty and the view agree from the first frame
  const x = { id: nextId++, key: /^[\w-]{1,80}$/.test(key || '') ? key : crypto.randomUUID(), pty, pid, updatedAt: Date.now(), kind, title, question, parent, exited: false, term, fit, el: wrap };
  wrap.addEventListener('pointerdown', () => { if (M.focused !== s.id) selectSession(s, x.id); });
  wrap.addEventListener('focusin', () => { if (M.focused !== s.id) selectSession(s, x.id); });
  term.onData(sforkFilter(() => x));
  term.onResize(({ cols, rows }) => synapse.pty.resize(pty, cols, rows));
  s.sessions.push(x);
  focusPath(s, x.id);
  return x;
}

synapse.pty.onData(({ id, data }) => { for (const s of M.slots) for (const x of s.sessions) if (x.pty === id) { x.updatedAt = Date.now(); x.term.write(data); } });
synapse.pty.onExit(({ id, code }) => {
  for (const s of M.slots) for (const x of s.sessions) if (x.pty === id) { x.exited = true; x.term.write(`\r\n\x1b[2m[exited ${code}]\x1b[0m\r\n`); }
  render();
});

// ---------------------------------------------------------------- actions

// `/sfork <question>` typed into any agent. The app sees every keystroke, so it catches the line itself,
// erases it with backspaces (every TUI understands those) and forks: no hook needed, works for all agents.
const SFORK = /^\/sfork\s+(\S[\s\S]*)$/;
const EDIT_KEY = /^(\x1b(\[|O)[ABCDHF]|\x1b\[[0-9;]*[ABCDHF~]|\x1b[bfdBF\x7f]|[\t\x01\x02\x05\x06\x0b\x0e\x10\x19])$/;
function sforkFilter(get) {
  let line = ''; // typed since the last Enter; null once cursor keys or control input make it unknowable
  return (d) => {
    const x = get();
    if (d === '\r') {
      const m = line !== null && x.kind !== 'shell' && SFORK.exec(line.trim());
      const typed = line; line = '';
      if (m) { synapse.pty.write(x.pty, '\x7f'.repeat(typed.length)); fork(m[1].trim(), { parentPty: x.pty }); return; }
    } else if (line !== null) {
      const t = d.replace(/\x1b\[20[01]~/g, ''); // bracketed paste markers
      if (t === '\x7f' || t === '\b') line = line.slice(0, -1);
      else if (t === '\x15' || t === '\x03') line = '';
      else if (t === '\x17') line = line.replace(/\S+\s*$/, '');
      else if (t === '\x1b\r' || t === '\x1b[13;2u') line = null; // multiline input cannot be tracked by /sfork
      else if (/^[^\x00-\x1f\x7f]+$/.test(t)) line += t;
      // keys that move the cursor make the line unknowable; terminal reports (focus, cursor position,
      // device attributes) also arrive here and are ignored
      else if (EDIT_KEY.test(t)) line = null;
    }
    synapse.pty.write(x.pty, d);
  };
}

async function newSlot(worktreePath, kind, split = null, phoneReq = null) {
  closeCanvas();
  const prof = M.profiles[kind] || { command: kind };
  const s = { id: nextId++, worktree: worktreePath, sessions: [], path: [] };
  const previous = M.focused;
  M.slots.push(s);
  M.focused = s.id;
  const home = worktreeOf(worktreePath); if (home) M.open.add(home.project.key); // a new session unfolds its project, once
  try {
    await makeSession(s, { kind, title: kind, spawn: (cols, rows) => synapse.pty.spawn({ cwd: worktreePath, kind, command: split ? '' : prof.command, cols, rows, phoneReq }) });
    if (split && slot(split.target)) {
      const insert = (node) => typeof node === 'number'
        ? node === split.target ? { direction: split.direction, first: node, second: s.id } : node
        : { ...node, first: insert(node.first), second: insert(node.second) };
      // A state refresh may have rendered the pending slot as a standalone pane.
      M.layouts = M.layouts.filter((node) => node !== s.id).map(insert);
    }
  } catch (e) { M.slots = M.slots.filter((x) => x !== s); if (M.focused === s.id) M.focused = slot(previous)?.id ?? M.slots[0]?.id ?? null; toast(e.message, true); }
  render();
}

function splitShell(direction) {
  const s = focusedSlot();
  const wt = s?.worktree || M.projects[0]?.worktrees[0]?.path;
  if (!wt) return toast('add a workspace first', true);
  if (fanOpen) closeFan();
  newSlot(wt, 'shell', s ? { target: s.id, direction } : null);
}

function paneIds(node) {
  return typeof node === 'number' ? [node] : [...paneIds(node.first), ...paneIds(node.second)];
}

function toggleSidebar() {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  localStorage.setItem('synapse-sidebar-collapsed', String(collapsed));
  $('#toggle-sidebar').setAttribute('aria-expanded', String(!collapsed));
}

// a fork's tab is named after its question: its first line, cut at a word to fit an agent's name (48)
function forkTitle(question) {
  const line = question.split('\n').find((l) => l.trim())?.replace(/\s+/g, ' ').trim() || 'fork';
  if (line.length <= 48) return line;
  const cut = line.slice(0, 47).replace(/\s+\S*$/, '');
  return `${cut.length > 20 ? cut : line.slice(0, 47)}…`;
}

async function fork(question, { requestId = null, parentPty = null } = {}) {
  const s = parentPty ? M.slots.find((x) => x.sessions.some((y) => y.pty === parentPty)) : focusedSlot();
  if (!s) return toast('no session to fork', true);
  const parent = parentPty ? s.sessions.find((y) => y.pty === parentPty) : top(s);
  if (!parent) return;
  if (parent.kind === 'shell' && !M.demo) return toast('shells have no transcript to fork', true);
  if (parentPty) M.focused = s.id;
  try {
    const child = await makeSession(s, {
      kind: parent.kind, title: forkTitle(question), question, parent: parent.id,
      spawn: (cols, rows) => synapse.fork.spawn({ parentPty: parent.pty, question, requestId, cols, rows }),
    });
    child.injected = false;
    child.named = false; // the agent takes the tab's name once it registers with synapse
    selectSession(s, child.id);
    toast(M.autoSendFork ? `⑂ forked: ${child.title}` : `⑂ forked: ${child.title} · press ↵ in the child to send`);
  } catch (e) { toast(e.message, true); }
  render();
}

function sessionBranch(s, id) {
  const doomed = [id];
  for (let i = 0; i < doomed.length; i++) doomed.push(...children(s, doomed[i]).map((x) => x.id));
  return doomed;
}

function requestCloseSession(s, id) {
  const x = sess(s, id);
  if (!x) return;
  const branch = sessionBranch(s, id);
  const working = branch.some((sid) => statusOf(sess(s, sid)) === 'working');
  if (branch.length > 1 || working) {
    const detail = branch.length > 1 ? ` and its ${branch.length - 1} fork${branch.length > 2 ? 's' : ''}` : '';
    return confirm(`Close "${x.title}"${detail}?${working ? ' An agent is still working.' : ''}`, () => closeSession(s, id));
  }
  closeSession(s, id);
}

function closeSession(s, id) {
  const doomed = sessionBranch(s, id);
  const parent = sess(s, id)?.parent;
  for (const d of doomed) { M.collapsed.delete(d); const x = sess(s, d); if (!x) continue; if (!x.exited) synapse.pty.kill(x.pty); x.term.dispose(); x.el.remove(); }
  s.sessions = s.sessions.filter((x) => !doomed.includes(x.id));
  if (parent != null) focusPath(s, parent);
  else {
    const layout = M.layouts.find((node) => paneIds(node).includes(s.id));
    M.slots = M.slots.filter((x) => x !== s);
    if (M.focused === s.id) M.focused = (layout && paneIds(layout).find((id) => slot(id))) ?? M.slots[0]?.id ?? null;
  }
  if (fanOpen) closeFan();
  render();
  if (!canvasOpen && $('#modal').hidden) top(focusedSlot())?.term.focus();
}

function pop() {
  const s = focusedSlot();
  if (!s || s.path.length < 2) return toast('nothing to pop');
  const t = top(s);
  requestCloseSession(s, t.id);
}

function moveFocus(delta) {
  const ids = orderedSlots().map((s) => s.id);
  if (!ids.length) return;
  const i = ids.indexOf(M.focused);
  selectSession(slot(ids[(i + delta + ids.length) % ids.length]));
}

function switchSession(key) {
  if (key === '[' || key === ']') moveFocus(key === '[' ? -1 : 1);
  else { const s = orderedSlots()[Number(key) - 1]; if (s) selectSession(s); }
}

function orderedSlots() {
  const out = [];
  for (const p of M.projects) for (const w of p.worktrees) for (const s of M.slots) if (s.worktree === w.path) out.push(s);
  for (const s of M.slots) if (!out.includes(s)) out.push(s);
  return out;
}

// ---------------------------------------------------------------- persistence

// Open sessions survive a restart: every slot's live sessions, their fork tree and the agent id to resume
// each from go to ~/.synapse/sessions.json, and boot reopens them. Exited sessions are left out; their
// children hang from the nearest live ancestor instead. Off until the restore has run, so a half-built
// model never overwrites the file, and off in demo and screenshot runs.
let persist = false, lastSaved = '', saveTimer = null;
function snapshot() {
  const slots = [];
  for (const s of orderedSlots()) {
    const index = new Map(), sessions = [];
    for (const x of s.sessions) {
      if (x.exited) continue;
      let p = x.parent;
      while (p != null && !index.has(p)) p = sess(s, p)?.parent;
      index.set(x.id, sessions.length);
      sessions.push({ key: x.key, kind: x.kind, title: x.title, question: x.question, parent: p == null ? null : index.get(p), resume: x.resume || null });
    }
    if (!sessions.length) continue;
    const t = [...s.path].reverse().find((id) => index.has(id));
    slots.push({ worktree: s.worktree, top: t == null ? sessions.length - 1 : index.get(t), focused: s.id === M.focused, sessions });
  }
  return { version: 1, slots };
}
function scheduleSave() {
  if (!persist) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const json = JSON.stringify(snapshot());
    if (json === lastSaved) return;
    lastSaved = json;
    synapse.sessions.save(JSON.parse(json)).catch(() => { lastSaved = ''; });
  }, 400);
}

// Rebuild the saved slots. Returns how many came back.
async function restoreSessions(saved) {
  let focus = null;
  for (const sv of saved?.slots || []) {
    if (!worktreeOf(sv.worktree)) continue; // its workspace was removed
    const s = { id: nextId++, worktree: sv.worktree, sessions: [], path: [] };
    M.slots.push(s);
    const ids = [];
    for (const [i, x] of sv.sessions.entries()) {
      const parent = x.parent == null ? null : ids[x.parent] ?? null;
      try {
        const made = await makeSession(s, {
          kind: x.kind, title: x.title, question: x.question, parent, key: x.key,
          spawn: (cols, rows) => synapse.pty.restore({ cwd: sv.worktree, kind: x.kind, resume: x.resume, cols, rows }),
        });
        made.resume = x.resume;
        ids[i] = made.id;
      } catch { ids[i] = parent; } // a session that cannot come back hands its children to its parent
    }
    if (!s.sessions.length) { M.slots = M.slots.filter((y) => y !== s); continue; }
    focusPath(s, ids[sv.top] ?? s.sessions[s.sessions.length - 1].id);
    M.open.add(worktreeOf(sv.worktree).project.key);
    if (sv.focused || focus == null) focus = s.id;
  }
  if (focus != null) M.focused = focus;
  return M.slots.length;
}

// ---------------------------------------------------------------- render

// Agent logos live in renderer/logos/<profile>.svg. Colour ones are images, monochrome ones a mask so they follow the theme.
const LOGOS = { claude: 'color', codex: 'mono', gemini: 'color', opencode: 'mono', 'cursor-agent': 'mono', copilot: 'mono', amp: 'color', shell: 'mono' };
function logo(kind) {
  const how = LOGOS[kind];
  if (!how) return el('span', 'logo none', (kind || '?')[0].toUpperCase());
  if (how === 'color') { const i = el('img', 'logo'); i.src = `logos/${kind}.svg`; i.alt = ''; return i; }
  const m = el('span', 'logo mono'); m.style.setProperty('--logo', `url(logos/${kind}.svg)`); return m;
}
const profileOrder = () => Object.keys(M.profiles).sort((a, b) => (a === 'shell') - (b === 'shell'));

// the launcher strip under the top bar: one click starts that agent in the focused worktree
function renderLaunch() {
  const bar = $('#launch');
  const keys = profileOrder();
  if (bar.dataset.keys !== keys.join()) {
    bar.dataset.keys = keys.join();
    bar.replaceChildren(...keys.map((k, i) => {
      const b = el('button', 'launch-item');
      b.append(logo(k), el('span', '', k === 'shell' ? 'Shell' : (M.profiles[k].label || k).replace(/ (Code|CLI|Agent)$/, '')));
      const n = agentProfiles().indexOf(k);
      b.title = `${M.profiles[k].command || '$SHELL -l'}${k === 'shell' ? '  ·  ⌘T' : n >= 0 && n < 9 ? `  ·  ⌃${n + 1}` : ''}`;
      b.onclick = () => { const wt = focusedSlot()?.worktree || M.projects[0]?.worktrees[0]?.path; if (wt) newSlot(wt, k); else toast('add a workspace first', true); };
      return b;
    }));
  }
}

function render() {
  if (!workspaceOpen) {
    renderLaunch();
    renderShareBar();
    // Keep the live input (and an outside click target) intact through state refreshes.
    if (!nameEdit && !namePointer) { renderTree(); renderDeck(); }
    renderBar();
  }
  renderStage();
  scheduleSave();
  syncCanvasBranches();
  syncWorkspace();
}

// ---------------------------------------------------------------- drag to rearrange

// Workspaces (project boxes), their worktrees and agent rows reorder by dragging. An agent stays in its own folder, since
// its process runs there. The picked-up item follows the pointer and its neighbours slide out of its way;
// nothing moves in the model until it is let go. The tree redraws every second from state, which would
// pull the row out from under the pointer, so it holds still while a drag is on.
let drag = null; // the lifted item while a drag is on ('pressed' until the pointer moves)
// a workspace's tab sits above its box (and a collapsed box is only a rule), so the tab counts as its top
function extent(node) {
  const r = node.getBoundingClientRect(), head = node.querySelector(':scope > .proj-head')?.getBoundingClientRect();
  return { top: head ? Math.min(head.top, r.top) : r.top, bottom: r.bottom };
}
function lift(item, sel) {
  const items = [...item.parentElement.children].filter((n) => n.matches(sel));
  const from = items.indexOf(item), rs = items.map(extent), me = rs[from];
  const gap = from < items.length - 1 ? rs[from + 1].top - me.bottom : from > 0 ? me.top - rs[from - 1].bottom : 0;
  const step = me.bottom - me.top + gap; // how far a neighbour slides to make room
  item.classList.add('lifted'); document.body.classList.add('sorting');
  for (const n of items) if (n !== item) n.classList.add('yielding');
  let to = from;
  return {
    follow(dy) {
      item.style.transform = `translateY(${dy}px)`;
      // a neighbour yields once the lifted item's leading edge passes its middle, so a tall open
      // workspace does not leap over small folded ones
      to = from;
      items.forEach((n, k) => {
        const m = (rs[k].top + rs[k].bottom) / 2;
        const shift = k > from && me.bottom + dy > m ? -step : k < from && me.top + dy < m ? step : 0;
        if (shift < 0) to = Math.max(to, k);
        if (shift > 0) to = Math.min(to, k);
        if (n !== item) n.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    },
    // glide into the gap, then hand the move to the model and redraw from it
    drop(onDrop) {
      const off = to > from ? rs[to].bottom - me.bottom : to < from ? rs[to].top - me.top : 0;
      item.classList.add('settling'); item.style.transform = `translateY(${off}px)`;
      setTimeout(() => {
        document.body.classList.remove('sorting');
        drag = null;
        if (to !== from) onDrop(items[to], to > from ? 'after' : 'before');
        render();
      }, 170);
    },
    cancel() { this.follow(0); this.drop(() => {}); },
  };
}
function sortable(handle, item, sel, onDrop) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag || e.target.closest('button, input')) return;
    const x0 = e.clientX, y0 = e.clientY;
    let d = null;
    drag = 'pressed'; // a redraw between press and move would take the row away before it is lifted
    const move = (e) => {
      if (!d && Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
      d ||= drag = lift(item, sel);
      d.follow(e.clientY - y0);
    };
    const end = (e) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end); removeEventListener('keydown', esc, true);
      if (!d) { drag = null; return; }
      // the release would also land as a click (select, fold): swallow it
      const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, true), 0);
      if (e.type === 'pointerup') d.drop(onDrop); else d.cancel();
    };
    const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(e); } };
    addEventListener('pointermove', move); addEventListener('pointerup', end);
    addEventListener('pointercancel', end); addEventListener('keydown', esc, true);
  });
}
function moveItem(list, item, target, side) {
  if (item === target) return list;
  const out = list.filter((x) => x !== item);
  out.splice(out.indexOf(target) + (side === 'after' ? 1 : 0), 0, item);
  return out;
}
function moveWorktree(key, from, to, side) {
  // state refreshes replace M.projects while a drag is on: move it in the current one
  const p = M.projects.find((x) => x.key === key);
  if (!p) return;
  p.worktrees = moveItem(p.worktrees, p.worktrees.find((w) => w.path === from), p.worktrees.find((w) => w.path === to), side);
  synapse.worktree.order(p.worktrees.map((w) => w.path)).catch((e) => toast(e.message, true));
}
// folding a workspace slides its worktrees shut (or open) instead of snapping; the tree holds still meanwhile
let folding = false;
const FOLD = { duration: 220, easing: 'cubic-bezier(.2, .7, .3, 1)' };
function foldProject(key) {
  if (folding) return;
  const find = () => $('#tree').querySelector(`:scope > .proj[data-key="${CSS.escape(key)}"]`);
  const box = find(), from = box?.getBoundingClientRect().height;
  const slide = (node, a, b, done) => {
    folding = true;
    node.style.clipPath = 'inset(-40px -40px 0 -40px)'; // the tab above the box stays visible
    node.animate([{ height: `${a}px` }, { height: `${b}px` }], FOLD).onfinish = () => { folding = false; done(); };
  };
  if (M.open.has(key)) {
    if (!box) { M.open.delete(key); return render(); }
    slide(box, from, 1, () => { M.open.delete(key); render(); });
  } else {
    M.open.add(key); render();
    const next = find();
    if (next && box) slide(next, from, next.getBoundingClientRect().height, render);
  }
}
function moveProject(key, targetKey, side) {
  const by = (k) => M.projects.find((p) => p.key === k);
  M.projects = moveItem(M.projects, by(key), by(targetKey), side);
  synapse.project.order(M.projects.map((p) => p.key)).catch((e) => toast(e.message, true));
}

let nameClick = null, nameEdit = null, namePointer = false;
function editableName(node, key, kind, value, save, select, deferSelection = false) {
  node.classList.add('editable-name'); node.tabIndex = 0;
  node.title = `${node.title ? node.title + '\n' : ''}Double-click to rename · F2`;
  const rename = () => { clearTimeout(nameClick?.timer); nameClick = null; editName(node, kind, value, save); };
  node.onclick = (e) => {
    e.stopPropagation();
    // Selection and polling rebuild these elements. Track the logical name across redraws.
    const twice = nameClick?.key === key && performance.now() - nameClick.at < 500 && Math.hypot(e.clientX - nameClick.x, e.clientY - nameClick.y) < 8;
    clearTimeout(nameClick?.timer);
    nameClick = null;
    if (twice) return rename();
    const click = nameClick = { key, at: performance.now(), x: e.clientX, y: e.clientY };
    // A picker or collapsed project would cover/move the name before its second click.
    if (deferSelection) click.timer = setTimeout(() => { if (nameClick === click) nameClick = null; select(); }, 500);
    else select();
  };
  node.ondblclick = (e) => { e.preventDefault(); e.stopPropagation(); };
  node.onkeydown = (e) => {
    if (e.key === 'F2') { e.preventDefault(); e.stopPropagation(); rename(); }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); select(); }
  };
}
addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.editable-name')) { clearTimeout(nameClick?.timer); nameClick = null; }
  if (nameEdit && e.target !== nameEdit.input) namePointer = true;
}, true);

// A blur can save before mouseup. Redraw only after the outside click has landed.
const releaseNamePointer = () => { if (namePointer) { namePointer = false; render(); } };
addEventListener('click', releaseNamePointer);
addEventListener('pointerup', () => setTimeout(releaseNamePointer, 0));
addEventListener('pointercancel', releaseNamePointer);

function editName(node, kind, value, save) {
  if (nameEdit) return;
  const input = el('input', 'name-input');
  input.value = value; input.maxLength = 48;
  input.setAttribute('aria-label', `New ${kind} name`);
  input.title = 'Enter to save · Escape to cancel · Leave empty to reset';
  node.style.width = `${Math.max(node.getBoundingClientRect().width, 90)}px`;
  node.onclick = node.ondblclick = (e) => e.stopPropagation();
  node.onkeydown = null; node.tabIndex = -1;
  node.replaceChildren(input);
  const edit = nameEdit = { input };
  let busy = false;
  const finish = (keyboard) => {
    const focusTerminal = keyboard && document.activeElement === input;
    nameEdit = null;
    input.onblur = null;
    node.textContent = input.value || value;
    render();
    if (focusTerminal && !canvasOpen && !fanOpen && $('#modal').hidden) top(focusedSlot())?.term.focus();
  };
  const commit = async (keyboard = false) => {
    if (busy || nameEdit !== edit) return;
    busy = input.readOnly = true;
    try {
      const name = input.value.replace(/[\u0000-\u001f]/g, '').trim();
      if (name !== value) await save(name);
      finish(keyboard);
    } catch (e) {
      busy = input.readOnly = false;
      input.setAttribute('aria-invalid', 'true'); input.title = e.message;
      toast(e.message, true); input.focus();
    }
  };
  input.onblur = () => commit();
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); if (!busy) { input.value = value; finish(true); } }
  };
  input.focus(); input.select();
}

function tabCloseButton(s, x) {
  const b = el('button', 'tab-close', '×'); b.type = 'button';
  b.title = `Close ${x.title}`; b.setAttribute('aria-label', b.title);
  b.onclick = (e) => { e.stopPropagation(); requestCloseSession(s, x.id); };
  b.ondblclick = (e) => e.stopPropagation();
  return b;
}

// a tab with a Synapse agent in it renames the agent too, so the node view shows the same name
async function renameTab(x, name) {
  const out = M.agents[x.pty] && !x.exited ? await synapse.agent.rename(x.pty, name) : null;
  if (out && M.agents[x.pty]) M.agents[x.pty].name = out.name;
  x.title = out?.name || name || x.kind;
  render();
}

// the canvas shows a fork under its question too; a name another agent has gets a number
async function nameForkAgent(x) {
  for (let i = 1; i < 10; i++) {
    try { return await renameTab(x, i === 1 ? x.title : `${x.title} ${i}`); } catch {}
  }
}

// a session named after its folder would repeat the checkout row above it: say what runs in it instead
const slotTitle = (s, t, w) => (!t ? 'gone' : t.title === w.name && s.path.length < 2 ? (M.profiles[t.kind]?.label || t.kind) : t.title);
function renderTree() {
  const tree = $('#tree');
  if (drag || folding) return;
  tree.replaceChildren();
  const cur = focusedSlot();
  const asking = askingTalks(), placed = new Set();
  let n = 0;
  for (const p of M.projects) {
    const box = el('div', 'proj' + (M.open.has(p.key) ? '' : ' closed')); box.dataset.key = p.key;
    const head = el('div', 'proj-head');
    const sw = el('span', 'swatch'); sw.style.background = p.color;
    const live = M.slots.filter((s) => p.worktrees.some((w) => w.path === s.worktree)).length;
    const pn = el('span', 'proj-name', p.label);
    const toggleProject = () => foldProject(p.key);
    editableName(pn, `project:${p.key}`, 'workspace', p.label, async (name) => { await synapse.project.rename(p.key, name); await refresh(); }, toggleProject, true);
    head.append(sw, pn, el('span', 'proj-count', String(live || p.worktrees.length)));
    const add = el('button', 'proj-add', '+'); add.title = 'open branch or worktree'; add.setAttribute('aria-label', add.title);
    add.onclick = (e) => { e.stopPropagation(); promptWorktree(p); };
    head.appendChild(add);
    head.onclick = toggleProject;
    sortable(head, box, '.proj', (t, side) => moveProject(p.key, t.dataset.key, side));
    box.appendChild(head);
    if (M.open.has(p.key)) {
      for (const w of p.worktrees) {
        const wt = el('div', 'wt'); wt.dataset.path = w.path;
        const wh = el('div', 'wt-head' + (cur?.worktree === w.path ? ' cur' : ''));
        // the repo's own folder shows as ⌂ + branch; a worktree as ⎇ + folder (· branch when they differ)
        const home = w.home;
        const label = home ? (w.branch || w.name) : w.branch && w.branch !== w.name ? `${w.name} · ${w.branch}` : w.name;
        const wn = el('span', 'wt-name', label); wn.title = `${w.path}\n${w.branch}`;
        wh.append(home ? el('span', 'wt-glyph', '⌂') : gitIcon('worktree'), wn);
        const pr = prStatuses.get(w.path); if (pr) wh.appendChild(prBadge(pr));
        if (!home) wh.appendChild(deleteWorktreeButton(p, w));
        const first = M.slots.find((s) => s.worktree === w.path);
        const selectWorktree = () => { if (first) selectSession(first); else pickProfile(w.path); };
        editableName(wn, `worktree:${w.path}`, 'worktree', w.name, async (name) => { await synapse.worktree.rename(w.path, name); await refresh(); }, selectWorktree, !first);
        const wa = el('button', 'wt-add', '+'); wa.title = 'new session here';
        wa.onclick = (e) => { e.stopPropagation(); pickProfile(w.path); };
        wh.appendChild(wa);
        wh.onclick = selectWorktree;
        sortable(wh, wt, '.wt', (t, side) => moveWorktree(p.key, w.path, t.dataset.path, side));
        wt.appendChild(wh);
        for (const s of M.slots.filter((s) => s.worktree === w.path)) {
          n++;
          const t = top(s);
          const row = el('div', 'slot' + (s.id === M.focused ? ' focused' : '')); row.dataset.slot = s.id;
          const tn = el('span', 'slot-title', slotTitle(s, t, w));
          if (t) editableName(tn, `tab:${t.id}`, 'tab', t.title, (name) => renameTab(t, name), () => selectSession(s));
          row.append(el('span', 'dot ' + (t ? statusOf(t) : 'exited')), logo(t?.kind), tn);
          const a = t && M.agents[t.pty];
          const unread = a && M.unread[a.synapseId];
          if (unread) row.appendChild(el('span', 'slot-unread', `✉${unread}`));
          if (s.path.length > 1) row.appendChild(el('span', 'slot-depth', `⑂${s.path.length}`));
          if (t && t.title !== t.kind) row.appendChild(el('span', 'slot-kind', t.kind));
          if (t) row.appendChild(tabCloseButton(s, t));
          row.title = `⌘${n}`;
          row.onclick = () => selectSession(s);
          sortable(row, row, '.slot', (t, side) => { M.slots = moveItem(M.slots, s, slot(Number(t.dataset.slot)), side); });
          wt.appendChild(row);
          // a friend's agent asking one of this slot's agents: a row per open conversation under it
          const ids = new Set(s.sessions.map((x) => M.agents[x.pty]?.synapseId).filter(Boolean));
          for (const c of asking) if (ids.has(c.target) && !placed.has(c.id)) { placed.add(c.id); wt.appendChild(extRow(c)); }
        }
        box.appendChild(wt);
      }
    }
    tree.appendChild(box);
  }
  // asked agents that run outside the app (or are closed: a fork answers from the transcript) get a box of their own
  const rest = asking.filter((c) => !placed.has(c.id));
  if (rest.length) {
    const box = el('div', 'ext-box'), head = el('div', 'proj-head'), wt = el('div', 'wt');
    head.append(el('span', 'swatch ext-swatch'), el('span', 'proj-name', 'agent talk'), el('span', 'proj-count', String(rest.length)));
    const byTarget = new Map();
    for (const c of rest) { if (!byTarget.has(c.target)) byTarget.set(c.target, []); byTarget.get(c.target).push(c); }
    for (const list of byTarget.values()) {
      const of = el('div', 'slot ext-of');
      of.append(el('span', 'dot idle'), el('span', 'slot-title', list[0].targetName || 'agent'), el('span', 'slot-kind', 'outside the app'));
      of.title = 'This agent is not open in the app. Its answers come from a fork of its conversation.';
      wt.append(of, ...list.map(extRow));
    }
    box.append(head, wt);
    tree.appendChild(box);
  }
}

// open conversations where a friend's agent asks one of mine
const askingTalks = () => (M.talks || []).filter((c) => c.role === 'owner');
const peerHandle = (c) => (c.peerHandle ? `@${c.peerHandle}` : c.peerName || 'a friend');
const TALK_LIVE = { answering: 'answering', queued: 'queued' };
function extRow(c) {
  const row = el('div', 'ext' + (c.live === 'answering' ? ' busy' : '')); row.dataset.conv = c.id;
  row.append(avatar({ name: c.peerName, handle: c.peerHandle }, 'av ext-av'), el('span', 'badge ext-badge', `asked by ${peerHandle(c)}`));
  if (TALK_LIVE[c.live]) row.append(el('span', 'slot-kind', TALK_LIVE[c.live]));
  row.title = `${c.peerName || peerHandle(c)}'s ${c.askerName || 'agent'} asks your ${c.targetName || 'agent'} · ${c.asked} question${c.asked === 1 ? '' : 's'}\nclick to open the conversation`;
  row.onclick = (e) => { e.stopPropagation(); openTalk(c.id); };
  return row;
}

// All visible branches stay in the tab strip. Hover never opens or replaces it.
function visibleSessions(s, parent = null) {
  return children(s, parent).flatMap((x) => M.collapsed.has(x.id) ? [] : [x, ...visibleSessions(s, x.id)]);
}

function expandChildrenButton(s, x) {
  const hidden = children(s, x.id).filter((child) => M.collapsed.has(child.id));
  if (!hidden.length) return null;
  const b = el('button', 'expand-children', `+${hidden.length}`);
  b.title = b.ariaLabel = `Expand children of ${x.title}`;
  b.onclick = (e) => { e.stopPropagation(); setChildrenCollapsed(s, hidden, false); };
  return b;
}

function renderDeck() {
  const deck = $('#deck'), scroll = deck.scrollLeft;
  deck.replaceChildren();
  const s = focusedSlot();
  if (!s) return;
  for (const x of visibleSessions(s)) {
    const c = el('div', 'card' + (x === top(s) ? ' top' : ''));
    c.dataset.session = x.id;
    const tn = el('span', 'label', x.title !== x.kind ? x.title : x.question || x.title);
    tn.title = x.question || x.title;
    editableName(tn, `tab:${x.id}`, 'tab', x.title, (name) => renameTab(x, name), () => selectSession(s, x.id));
    c.appendChild(el('span', 'dot ' + statusOf(x)));
    if (x.parent == null) c.appendChild(logo(x.kind));
    c.appendChild(tn);
    c.title = x.question || x.kind;
    const expand = expandChildrenButton(s, x);
    if (expand) c.appendChild(expand);
    c.appendChild(tabCloseButton(s, x));
    if (x.parent != null) c.prepend(el('span', 'q', '⑂'));
    c.onclick = () => selectSession(s, x.id);
    c.oncontextmenu = (e) => sessionContextMenu(e, s, x);
    deck.appendChild(c);
  }
  deck.scrollLeft = scroll;
  const active = String(top(s)?.id);
  if (deck.dataset.active !== active) deck.querySelector('.card.top')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  deck.dataset.active = active;
}

function setChildrenCollapsed(s, targets, collapsed) {
  for (const x of targets) {
    if (collapsed) M.collapsed.add(x.id);
    else for (const id of sessionBranch(s, x.id)) M.collapsed.delete(id);
  }
  if (collapsed) for (const x of targets) {
    const child = M.agents[x.pty]?.synapseId, parent = M.agents[sess(s, x.parent)?.pty]?.synapseId;
    if (child && parent) linkToParent(child, parent, x.title);
  }
  // If the current session was hidden, return to the nearest visible ancestor.
  const visible = new Set(visibleSessions(s).map((x) => x.id));
  const current = [...s.path].reverse().find((id) => visible.has(id));
  if (current != null) focusPath(s, current);
  render();
  if (fanOpen) openFan(true);
  else if (!canvasOpen && $('#modal').hidden) top(focusedSlot())?.term.focus();
}

// collapsing a child links it to its parent on demand: the parent can read it, nothing is pushed into its prompt
async function linkToParent(child, parent, name) {
  try { if (await synapse.fork.link(child, parent)) toast(`⇠ the parent can read "${name}" when it needs to`); }
  catch (e) { toast(e.message, true); }
}

function sessionActions(s, x) {
  const kids = children(s, x.id);
  const items = [{ label: 'Fork child', run: () => promptFork(s, x) }];
  if (kids.some((k) => !M.collapsed.has(k.id))) items.push({ label: 'Collapse all children', run: () => setChildrenCollapsed(s, kids, true) });
  if (kids.some((k) => M.collapsed.has(k.id))) items.push({ label: 'Expand all children', run: () => setChildrenCollapsed(s, kids, false) });
  for (const child of kids) {
    const hidden = M.collapsed.has(child.id);
    items.push({ label: `${hidden ? 'Expand' : 'Collapse'} child: ${child.question || child.title}`, run: () => setChildrenCollapsed(s, [child], !hidden) });
  }
  if (x.parent != null) items.push({ label: 'Collapse this child', run: () => setChildrenCollapsed(s, [x], true) });
  return items;
}

function sessionContextMenu(e, s, x) {
  e.preventDefault(); e.stopPropagation();
  contextMenu([...sessionActions(s, x), '-', { label: 'Close branch', danger: true, run: () => requestCloseSession(s, x.id) }], e.clientX, e.clientY);
}

function syncCanvasBranches() {
  const hidden = [];
  for (const s of M.slots) {
    const visible = new Set(visibleSessions(s).map((x) => x.id));
    for (const x of s.sessions) if (!visible.has(x.id) && M.agents[x.pty]) hidden.push(M.agents[x.pty].synapseId);
  }
  tellCanvas({ action: 'session-visibility', hidden });
}

let shownSession = null;
function renderStage() {
  const prune = (node) => {
    if (typeof node === 'number') return slot(node) ? node : null;
    const first = prune(node.first), second = prune(node.second);
    return first == null ? second : second == null ? first : { ...node, first, second };
  };
  M.layouts = M.layouts.map(prune).filter((node) => node != null);
  const known = new Set(M.layouts.flatMap(paneIds));
  for (const sl of M.slots) if (!known.has(sl.id)) M.layouts.push(sl.id);
  const s = focusedSlot();
  const t = top(s);
  const layout = M.layouts.find((node) => paneIds(node).includes(s?.id));
  const visible = [];
  $('#empty').hidden = !!t;
  $('#stage').classList.toggle('exited', !!t?.exited);
  $('#stage').classList.toggle('split', layout != null && typeof layout !== 'number');
  for (const sl of M.slots) for (const x of sl.sessions) {
    x.el.classList.remove('visible');
    x.el.classList.toggle('active', x === t);
  }
  const place = (node, left = 0, upper = 0, width = 100, height = 100) => {
    if (typeof node === 'number') {
      const x = top(slot(node));
      if (!x) return;
      Object.assign(x.el.style, { left: `${left}%`, top: `${upper}%`, width: `${width}%`, height: `${height}%` });
      x.el.classList.add('visible'); visible.push(x);
    } else if (node.direction === 'right') {
      place(node.first, left, upper, width / 2, height);
      place(node.second, left + width / 2, upper, width / 2, height);
    } else {
      place(node.first, left, upper, width, height / 2);
      place(node.second, left, upper + height / 2, width, height / 2);
    }
  };
  if (layout != null) place(layout);
  // grab focus only when a different session comes to the front, so the 1 s state refresh never steals it from a dialog
  const changed = t !== shownSession; shownSession = t;
  if (t) requestAnimationFrame(() => { for (const x of visible) if (x.el.isConnected) x.fit.fit(); if (!workspaceOpen && changed && top(focusedSlot()) === t && t.el.isConnected && !nameEdit && $('#modal').hidden && !fanOpen && !canvasOpen) t.term.focus(); });
}

function renderBar() {
  const s = focusedSlot();
  const t = top(s);
  const a = t && M.agents[t.pty];
  const left = [];
  if (a) {
    const ins = M.edges?.filter((e) => e.to === a.synapseId).map((e) => e.fromName) || [];
    const outs = M.edges?.filter((e) => e.from === a.synapseId).map((e) => e.toName) || [];
    left.push(`◉ ${a.name}`);
    if (ins.length) left.push(`⇠ ${ins.join(', ')}`);
    if (outs.length) left.push(`⇢ ${outs.join(', ')}`);
    if (M.unread[a.synapseId]) left.push(`<span class="sig">✉ ${M.unread[a.synapseId]} unread</span>`);
  } else if (t) left.push(t.kind === 'shell' ? '$ shell' : `${t.kind} · not registered with synapse yet`);
  $('#bar-left').innerHTML = left.join('   ·   ');
  $('#bar-right').textContent = t && t.kind !== 'shell' ? 'type /sfork <question> to fork without touching this context' : '';
}

// ---------------------------------------------------------------- fan-out

const CARD_W_PAD = 60, CARD_H = 56, GAP_X = 32, GAP_Y = 64;
let fanOpen = false;

function measure(label) {
  const c = document.createElement('canvas').getContext('2d');
  c.font = '13px Geist, system-ui';
  return Math.min(300, Math.ceil(c.measureText(label).width)) + CARD_W_PAD;
}

function layoutTree(s) {
  const w = new Map();
  const label = (x) => x.title;
  const width = (x) => {
    if (w.has(x.id)) return w.get(x.id);
    const own = measure(label(x));
    const kids = children(s, x.id).filter((k) => !M.collapsed.has(k.id));
    const kw = kids.reduce((a, k) => a + width(k), 0) + GAP_X * Math.max(0, kids.length - 1);
    const v = Math.max(own, kw);
    w.set(x.id, v);
    return v;
  };
  const nodes = [];
  const place = (x, x0, depth) => {
    const span = width(x);
    const own = measure(label(x));
    nodes.push({ x, left: x0 + (span - own) / 2, top: depth * (CARD_H + GAP_Y), w: own, label: label(x) });
    let cx = x0;
    for (const k of children(s, x.id).filter((k) => !M.collapsed.has(k.id))) { place(k, cx, depth + 1); cx += width(k) + GAP_X; }
  };
  const r = root(s);
  if (r) place(r, 0, 0);
  const totalW = r ? width(r) : 0;
  const totalH = nodes.reduce((a, n) => Math.max(a, n.top + CARD_H), 0);
  return { nodes, totalW, totalH };
}

function openFan(refresh = false) {
  const s = focusedSlot();
  if (!s || (fanOpen && !refresh)) return;
  fanOpen = true;
  const fan = $('#fan'), inner = $('#fan-inner');
  fan.hidden = false;
  inner.replaceChildren();
  const { nodes, totalW, totalH } = layoutTree(s);
  const ox = Math.max(32, (inner.clientWidth - totalW) / 2), oy = Math.max(96, (inner.clientHeight - totalH) / 2);
  const wt = worktreeOf(s.worktree);
  $('#fan-meta').textContent = `${wt ? `${wt.project.label} / ${wt.worktree.name}` : ''}  ·  ${s.sessions.length} sessions  ·  depth ${s.path.length}`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  inner.appendChild(svg);
  const deckRects = new Map([...$('#deck').querySelectorAll('.card')].map((c, i) => [Number(c.dataset.session), c.getBoundingClientRect()]));
  const fanRect = inner.getBoundingClientRect();
  for (const n of nodes) {
    const x = n.x;
    const onPath = s.path.includes(x.id);
    const c = el('div', 'fcard' + (onPath ? ' on-path' : '') + (x.id === s.path[s.path.length - 1] ? ' top' : '') + (x.injected ? ' injected' : ''));
    c.style.left = `${ox + n.left}px`; c.style.top = `${oy + n.top}px`; c.style.width = `${n.w}px`;
    const q = el('div', 'fq'); q.append(el('span', 'dot ' + statusOf(x)), el('span', '', n.label));
    c.append(q, el('div', 'fm', x.parent == null ? `${x.kind} · root` : x.question || `${x.kind} · ${statusOf(x)}`));
    c.title = x.question || x.kind;
    c.dataset.session = x.id;
    c.oncontextmenu = (e) => sessionContextMenu(e, s, x);
    const expand = expandChildrenButton(s, x);
    if (expand) q.appendChild(expand);
    if (x.parent == null) c.appendChild(el('span', 'tab', 'parent'));
    else if (x.id === s.path[s.path.length - 1]) c.appendChild(el('span', 'tab', 'on top'));
    const fx = el('button', 'fx', '×'); fx.title = 'close this branch';
    fx.onclick = (e) => { e.stopPropagation(); requestCloseSession(s, x.id); };
    c.appendChild(fx);
    c.onclick = () => { closeFan(); selectSession(s, x.id); };
    // FLIP: cards on the deck fly from the deck, others grow out of their parent
    const from = deckRects.get(x.id) || (x.parent != null && nodes.find((m) => m.x.id === x.parent) && null);
    if (from) {
      c.style.transition = 'none';
      c.style.transform = `translate(${from.left - fanRect.left - (ox + n.left)}px, ${from.top - fanRect.top - (oy + n.top)}px) scale(.7)`;
    } else if (x.parent != null) {
      const p = nodes.find((m) => m.x.id === x.parent);
      c.style.transition = 'none';
      c.style.transform = `translate(${p.left - n.left}px, ${p.top - n.top}px) scale(.6)`; c.style.opacity = '0';
    }
    inner.appendChild(c);
    requestAnimationFrame(() => requestAnimationFrame(() => { c.style.transition = ''; c.style.transform = ''; c.style.opacity = ''; }));
  }
  // connectors
  for (const n of nodes) {
    if (n.x.parent == null) continue;
    const p = nodes.find((m) => m.x.id === n.x.parent);
    const x1 = ox + p.left + p.w / 2, y1 = oy + p.top + CARD_H, x2 = ox + n.left + n.w / 2, y2 = oy + n.top;
    const mid = y1 + (y2 - y1) / 2;
    const onPath = s.path.includes(n.x.id) && s.path.includes(p.x.id);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${x1},${y1} V${mid} H${x2} V${y2 - (n.x.parent != null && x2 !== x1 ? 0 : 0)}`);
    if (onPath) path.classList.add('on-path');
    svg.appendChild(path);
    if (onPath) {
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', x2 - 4); r.setAttribute('y', y2 - 4); r.setAttribute('width', 8); r.setAttribute('height', 8); r.classList.add('end');
      svg.appendChild(r);
    }
  }
}
function closeFan() { fanOpen = false; $('#fan').hidden = true; top(focusedSlot())?.term.focus(); }
$('#fan-esc').onclick = closeFan;
$('#fan').addEventListener('click', (e) => { if (e.target === $('#fan') || e.target === $('#fan-inner')) closeFan(); });


// ---------------------------------------------------------------- modals

function modal(title, build) {
  const m = $('#modal'), body = $('#modal-body');
  $('#modal-title').textContent = title;
  m.querySelector('.modal-card').dataset.kind = title;
  body.replaceChildren();
  body.onkeydown = null;
  build(body, () => { m.hidden = true; if (workspaceOpen) workspaceFrame.focus(); else top(focusedSlot())?.term.focus(); });
  m.hidden = false;
  const inp = body.querySelector('input, textarea'); if (inp) inp.focus();
}
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) { $('#modal').hidden = true; } });

// multiline: a textarea that grows with its text; Enter submits, ⇧Enter is a newline
function promptText(title, hint, placeholder, onOk, { multiline = false } = {}) {
  modal(title, (body, close) => {
    const inp = el(multiline ? 'textarea' : 'input'); inp.placeholder = placeholder;
    if (multiline) { inp.rows = 1; inp.oninput = () => { inp.style.height = 'auto'; inp.style.height = `${inp.scrollHeight + 1}px`; }; }
    body.append(inp, el('div', 'hint', hint));
    inp.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (inp.value.trim()) { close(); onOk(inp.value.trim()); } }
      if (e.key === 'Escape') close();
    };
  });
}
function confirm(text, onOk, { danger = 'Close' } = {}) {
  modal('sure?', (body, close) => {
    body.append(el('div', 'hint', text));
    const row = el('div', 'row');
    const no = el('button', 'btn', 'Keep'); no.onclick = close;
    const yes = el('button', 'btn danger', danger); yes.onclick = () => { close(); onOk(); };
    row.append(no, yes); body.appendChild(row);
    body.onkeydown = (e) => { if (e.key === 'Enter') { close(); onOk(); } if (e.key === 'Escape') close(); };
    yes.focus();
  });
}
function pickProfile(worktreePath) {
  modal('new session', (body, close) => {
    const wt = worktreeOf(worktreePath);
    body.appendChild(el('div', 'hint', `in ${wt ? `${wt.project.label} / ${wt.worktree.name}` : worktreePath} · 1-9 to launch · profiles live in ~/.synapse/app.json`));
    // agents first (1 claude, 2 codex, ...), the plain shell last; a digit launches straight away
    const keys = profileOrder();
    let sel = 0;
    const opts = keys.map((k, i) => {
      const o = el('div', 'opt' + (i === sel ? ' sel' : ''));
      o.append(el('span', 'n', i < 9 ? String(i + 1) : ''), logo(k), el('span', 'k', M.profiles[k].label || k), el('span', 'c', M.profiles[k].command || '$SHELL -l'));
      o.onclick = () => { close(); newSlot(worktreePath, k); };
      body.appendChild(o);
      return o;
    });
    body.tabIndex = 0; body.focus();
    body.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { opts[sel].classList.remove('sel'); sel = (sel + (e.key === 'ArrowDown' ? 1 : keys.length - 1)) % keys.length; opts[sel].classList.add('sel'); }
      if (e.key === 'Enter') { close(); newSlot(worktreePath, keys[sel]); }
      if (/^[1-9]$/.test(e.key) && !e.metaKey && keys[e.key - 1]) { close(); newSlot(worktreePath, keys[e.key - 1]); }
      if (e.key === 'Escape') close();
    };
  });
}
function deleteWorktreeButton(project, w, after) {
  const button = el('button', 'wt-delete');
  button.appendChild(gitIcon('trash'));
  button.title = `Delete worktree ${w.label || w.name || w.branch}`;
  button.setAttribute('aria-label', button.title);
  button.disabled = !!w.locked || !!w.missing;
  if (w.locked) button.title = 'Worktree is locked';
  button.onclick = (e) => {
    e.stopPropagation();
    const sessions = M.slots.filter(s => s.worktree === w.path);
    confirm(`Delete the checkout at ${w.path}? The Git branch is kept. Uncommitted changes prevent deletion.${sessions.length ? ' Sessions in this checkout will close.' : ''}`, async () => {
      try {
        await synapse.worktree.remove({ repo: project.path, dir: w.path });
        for (const s of sessions) closeSession(s, root(s).id);
        prStatuses.delete(w.path);
        await refresh(); toast('Worktree deleted; branch kept.');
        if (after) after();
      } catch (e) { toast(e.message, true); }
    }, { danger: 'Delete worktree' });
  };
  return button;
}

// letters, digits and . _ - /, never two dots or slashes in a row, no leading - . or /
const branchName = (v) => v.replace(/\s+/g, '-').replace(/[^\w./-]/g, '').replace(/\.{2,}/g, '.').replace(/\/{2,}/g, '/').replace(/^[-./]+/, '');
function promptWorktree(project) {
  modal('open branch or worktree', (body, close) => {
    const seg = el('div', 'seg'), inp = el('input'), list = el('div', 'lib branch-list');
    const hint = el('div', 'hint'), row = el('div', 'row');
    const fetch = el('button', 'btn', 'fetch remotes'), go = el('button', 'btn sig', 'create branch');
    inp.setAttribute('aria-label', 'Search branches and worktrees');
    let mode = 'existing', choices = [], matches = [], sel = 0, busy = false, generation = 0;
    const alive = () => body.contains(inp) && !$('#modal').hidden;
    const fail = (e) => { hint.textContent = e.message; hint.classList.add('err'); };
    const pick = async (choice) => {
      if (busy || choice?.missing) return;
      busy = true; go.disabled = fetch.disabled = inp.disabled = true;
      try {
        const dir = choice ? await synapse.worktree.open({ repo: project.path, choice }) : await synapse.worktree.add({ repo: project.path, name: inp.value.trim() });
        if (choice?.pr) prStatuses.set(dir, choice.pr);
        if (alive()) close(); await refresh(); M.open.add(project.key);
        const first = M.slots.find(s => s.worktree === dir);
        if (first) selectSession(first); else await newSlot(dir, 'shell');
      } catch (e) { fail(e); }
      finally { busy = false; go.disabled = fetch.disabled = inp.disabled = false; }
    };
    const draw = () => {
      list.replaceChildren();
      const query = inp.value.trim().toLowerCase();
      matches = choices.filter(w => [w.name, w.label, w.path].some(v => v?.toLowerCase().includes(query)));
      sel = Math.min(sel, Math.max(0, matches.length - 1));
      if (!matches.length) list.appendChild(el('div', 'hint', 'No matching branches or worktrees.'));
      matches.forEach((w, i) => {
        const option = el('div', 'branch-option' + (i === sel ? ' sel' : ''));
        const open = el('button', 'opt branch-open'); open.disabled = !!w.missing;
        const type = w.kind === 'worktree' ? (w.home ? 'repository' : 'worktree') : w.kind;
        open.append(gitIcon(w.kind), el('span', 'k', w.label), el('span', 'c', `${type}${w.added ? ' · open' : ''}${w.locked ? ' · locked' : ''}${w.missing ? ' · missing' : ''}`));
        open.title = w.path || w.ref;
        if (w.pr) open.appendChild(prBadge(w.pr));
        open.onclick = () => pick(w);
        option.appendChild(open);
        if (w.kind === 'worktree' && !w.home) option.appendChild(deleteWorktreeButton(project, w, () => promptWorktree(project)));
        list.appendChild(option);
      });
    };
    const load = async () => {
      const request = ++generation;
      try {
        const loaded = await synapse.worktree.list(project.path);
        if (!alive() || request !== generation) return;
        choices = loaded; draw();
        if (mode === 'existing') { hint.textContent = '↑↓ Enter to open · fetch remotes to update remote branches'; hint.classList.remove('err'); }
        const result = await synapse.worktree.prs(project.path, loaded);
        if (!alive() || request !== generation) return;
        choices.forEach((w, i) => { w.pr = result.statuses[i]; if (w.path) prStatuses.set(w.path, w.pr); });
        draw(); render();
        if (result.error && mode === 'existing') hint.textContent = result.error;
      } catch (e) { if (alive()) fail(e); }
    };
    const set = (value) => {
      if (busy) return;
      mode = value; inp.value = ''; sel = 0;
      for (const b of seg.children) b.classList.toggle('on', b.dataset.mode === mode);
      list.hidden = fetch.hidden = mode !== 'existing'; go.hidden = mode !== 'new';
      inp.placeholder = mode === 'existing' ? 'Search local, remote, and worktrees…' : 'New branch name';
      inp.setAttribute('aria-label', mode === 'existing' ? 'Search branches and worktrees' : 'New branch name');
      hint.textContent = mode === 'existing' ? '↑↓ Enter to open · fetch remotes to update remote branches' : 'Create a branch and worktree from the current HEAD.';
      hint.classList.remove('err'); draw(); inp.focus();
    };
    for (const [value, label] of [['existing', 'existing'], ['new', 'new branch']]) {
      const b = el('button', '', label); b.dataset.mode = value; b.onclick = () => set(value); seg.appendChild(b);
    }
    fetch.onclick = async () => {
      if (busy) return;
      busy = true; fetch.disabled = true; hint.textContent = 'Fetching remotes…';
      try { await synapse.worktree.fetch(project.path); await load(); } catch (e) { fail(e); }
      finally { busy = false; fetch.disabled = false; }
    };
    go.onclick = () => { if (inp.value.trim()) pick(); };
    inp.oninput = () => {
      // a new branch name takes only what git accepts: a space becomes -, anything else is dropped as it is typed
      if (mode === 'new') {
        const at = inp.selectionStart, clean = branchName(inp.value);
        if (clean !== inp.value) { const cut = inp.value.length - clean.length; inp.value = clean; inp.selectionStart = inp.selectionEnd = Math.max(0, at - cut); }
      }
      sel = 0; draw();
    };
    inp.onkeydown = (e) => {
      if (busy) return;
      if (mode === 'existing' && ['ArrowDown', 'ArrowUp'].includes(e.key) && matches.length) {
        e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
        draw(); list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
      }
      if (e.key === 'Enter') { e.preventDefault(); if (mode === 'new') go.click(); else if (matches[sel]) pick(matches[sel]); }
      if (e.key === 'Escape') close();
    };
    row.append(fetch, go); body.append(seg, inp, list, hint, row); set(mode);
    hint.textContent = 'Loading branches and worktrees…';
    // modal() makes the dialog visible after this callback.
    queueMicrotask(load);
  });
}
function promptFork(s = focusedSlot(), t = top(s)) {
  if (!t) return toast('no session to fork', true);
  const send = M.autoSendFork ? 'it is sent right away' : 'it waits in the child\'s prompt for you to send';
  promptText('⑂ fork', `a child of "${t.title}" with its full context · ${send} · ⇧↵ newline`, 'what do you want to dig into?', (q) => { if (fanOpen) closeFan(); fork(q, { parentPty: t.pty }); }, { multiline: true });
}
// Add a workspace by cloning, opening a folder, creating a repo, or choosing from the library.
const WS_MODES = {
  clone: { label: 'clone', hint: 'git clone into ~/.synapse/workspaces/<repo>', placeholder: 'https://github.com/owner/repo  or  git@github.com:owner/repo.git' },
  open: { label: 'open folder', hint: 'a repo, a worktree or any folder. Enter adds a typed path.', placeholder: '~/code/repo' },
  new: { label: 'new', hint: 'git init ~/.synapse/workspaces/<name> with an empty first commit', placeholder: 'name' },
  library: { label: 'library', hint: '~/.synapse/workspaces · ● already in the sidebar · ↑↓ enter', placeholder: 'Search library by name or path…' },
};
let onCloneLine = null;
synapse.project.onCloneProgress((line) => onCloneLine?.(line));
// "+ workspace": select the library when it has entries, else clone.
async function promptProject(mode) {
  const home = M.home || '';
  let lib = [];
  try { lib = await synapse.project.library(); } catch {}
  mode ||= lib.length ? 'library' : 'clone';
  modal('add workspace', (body, close) => {
    const seg = el('div', 'seg');
    const list = el('div', 'lib');
    const inp = el('input');
    const hint = el('div', 'hint');
    const row = el('div', 'row');
    const browse = el('button', 'btn', 'choose folder…');
    const go = el('button', 'btn sig');
    let busy = false, sel = 0, matches = lib;
    const done = async (dir) => {
      onCloneLine = null; close(); await refresh();
      const wt = worktreeOf(dir); if (wt) M.open.add(wt.project.key);
      toast(`workspace ${dir.split('/').pop()} added`); newSlot(dir, 'shell');
    };
    // a library entry: add it, or go to it if it is already in the sidebar
    const pick = async (w) => {
      if (busy) return;
      if (!w.added) {
        busy = true;
        try { await done(await synapse.project.add(w.path)); } catch (e) { busy = false; hint.textContent = e.message; hint.classList.add('err'); }
        return;
      }
      close();
      const wt = worktreeOf(w.path); if (wt) M.open.add(wt.project.key);
      const first = M.slots.find((x) => x.worktree === w.path);
      if (first) selectSession(first); else pickProfile(w.path);
    };
    const renderLib = () => {
      list.replaceChildren();
      const query = inp.value.trim().toLowerCase();
      matches = lib.filter((w) => [w.label, w.name, w.path].some((v) => v?.toLowerCase().includes(query)));
      if (!matches.length) return list.appendChild(el('div', 'hint', lib.length ? 'No matching workspaces.' : 'nothing here yet. clone or create a repo, or add a folder: it gets linked here'));
      matches.forEach((w, i) => {
        const o = el('div', 'opt' + (i === sel ? ' sel' : ''));
        const shown = home && w.path.startsWith(home) ? `~${w.path.slice(home.length)}` : w.path;
        o.append(el('span', 'n', w.added ? '●' : ''), el('span', 'k', w.label || w.name), el('span', 'c', shown));
        o.title = w.added ? 'already in the sidebar: click to go there' : w.path;
        o.onclick = () => pick(w);
        list.appendChild(o);
      });
    };
    const cycle = (back) => { const ks = Object.keys(WS_MODES); set(ks[(ks.indexOf(mode) + (back ? ks.length - 1 : 1)) % ks.length]); };
    const set = (m) => {
      mode = m;
      for (const b of seg.children) b.classList.toggle('on', b.dataset.m === m);
      const isLib = m === 'library';
      row.hidden = isLib; list.hidden = !isLib;
      inp.type = isLib ? 'search' : 'text';
      inp.setAttribute('aria-label', isLib ? 'Search library' : WS_MODES[m].label);
      inp.value = ''; inp.placeholder = WS_MODES[m].placeholder; hint.textContent = WS_MODES[m].hint; hint.classList.remove('err');
      go.textContent = { clone: 'clone', open: 'add', new: 'create' }[m] || '';
      browse.hidden = m !== 'open';
      if (isLib) { sel = 0; renderLib(); }
      inp.focus();
    };
    for (const m of Object.keys(WS_MODES)) {
      const b = el('button', '', WS_MODES[m].label); b.dataset.m = m;
      b.onclick = () => !busy && set(m);
      seg.appendChild(b);
    }
    onCloneLine = (line) => { if (busy) hint.textContent = line; };
    const submit = async () => {
      const v = inp.value.trim();
      if (busy || !v) return;
      busy = true; go.disabled = inp.disabled = true;
      hint.classList.remove('err'); if (mode === 'clone') hint.textContent = 'cloning…';
      try { await done(await (mode === 'clone' ? synapse.project.clone(v) : mode === 'new' ? synapse.project.create(v) : synapse.project.add(v))); }
      catch (e) { busy = false; go.disabled = inp.disabled = false; hint.textContent = e.message; hint.classList.add('err'); inp.focus(); }
    };
    browse.onclick = async () => {
      try { const dir = await synapse.project.pick(); if (dir) await done(dir); } catch (e) { hint.textContent = e.message; hint.classList.add('err'); }
    };
    go.onclick = submit;
    inp.oninput = () => { if (mode === 'library') { sel = 0; renderLib(); list.scrollTop = 0; } };
    list.tabIndex = 0;
    inp.onkeydown = list.onkeydown = (e) => {
      if (mode === 'library') {
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && matches.length) {
          e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
          renderLib(); list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
        }
        if (e.key === 'Enter' && matches[sel]) { e.preventDefault(); pick(matches[sel]); }
      } else if (e.key === 'Enter') submit();
      if (e.key === 'Escape' && !busy) { onCloneLine = null; close(); }
      if (e.key === 'Tab' && !busy) { e.preventDefault(); cycle(e.shiftKey); }
    };
    row.append(browse, go);
    body.append(seg, inp, list, hint, row);
    set(mode);
  });
}

// ---------------------------------------------------------------- right-click menus
// items: { label, run, danger, sub: [items] } or '-' for a rule. Escape, a click elsewhere or losing focus closes it.
let menuEl = null;
function closeMenu() { menuEl?.remove(); menuEl = null; }
function contextMenu(items, x, y) {
  closeMenu();
  const m = el('div', 'menu'); menuEl = m;
  const rows = [];
  const build = (box, list, depth) => {
    for (const it of list) {
      if (it === '-') { box.appendChild(el('div', 'menu-rule')); continue; }
      const row = el('div', 'menu-item' + (it.danger ? ' danger' : '') + (it.sub ? ' has-sub' : ''));
      row.appendChild(el('span', 'menu-label', it.label));
      if (it.sub) { const sub = el('div', 'menu menu-sub'); build(sub, it.sub, depth + 1); row.appendChild(sub); }
      else row.onclick = (e) => { e.stopPropagation(); closeMenu(); it.run(); };
      if (!depth) rows.push({ row, it });
      box.appendChild(row);
    }
  };
  build(m, items, 0);
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(0, Math.min(x, innerWidth - r.width - 8))}px`;
  m.style.top = `${Math.max(0, Math.min(y, innerHeight - r.height - 8))}px`;
  let sel = -1;
  const select = (i) => { rows[sel]?.row.classList.remove('sel'); sel = (i + rows.length) % rows.length; rows[sel].row.classList.add('sel'); };
  m.tabIndex = -1; m.focus();
  m.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') select(sel + 1);
    if (e.key === 'ArrowUp') select(sel - 1);
    if (e.key === 'Enter' && rows[sel] && !rows[sel].it.sub) { closeMenu(); rows[sel].it.run(); }
    if (e.key === 'Escape') closeMenu();
  };
}
addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
addEventListener('keydown', (e) => { if (menuEl && e.key === 'Escape') { e.stopImmediatePropagation(); closeMenu(); } }, true);
addEventListener('blur', closeMenu);

// destructive actions ask first; uncommitted changes in the folder make the question louder
const tilde = (p) => (M.home && p.startsWith(M.home) ? `~${p.slice(M.home.length)}` : p);
async function confirmDirty(cwd, question, action, onOk) {
  let dirty = 0;
  try { dirty = await synapse.git.dirty(cwd); } catch {}
  const text = dirty ? `${dirty} uncommitted change${dirty === 1 ? '' : 's'} in ${tilde(cwd)}. ${question}` : question;
  confirm(text, onOk, { danger: dirty ? `${action} anyway` : action });
}
const slotsIn = (paths) => M.slots.filter((s) => paths.includes(s.worktree));
const closeSlots = (slots) => { for (const s of slots) { const r = root(s); if (r) closeSession(s, r.id); } };
// one session stack, with everything forked from it
function closeSlotAsk(s) {
  const t = top(s); if (!t) return;
  const working = !t.exited && statusOf(t) === 'working';
  confirmDirty(s.worktree, `Close "${t.title}"${working ? ', it is still working' : ''}?`, 'Close', () => closeSession(s, root(s).id));
}
// a checkout: git worktree remove, forced only after the uncommitted-changes question was answered
function removeWorktreeAsk(project, w) {
  const open = slotsIn([w.path]);
  confirmDirty(w.path, `Delete worktree ${w.name}${open.length ? ` and close ${open.length} session${open.length === 1 ? '' : 's'} in it` : ''}? The folder is removed.`, 'Delete', async () => {
    try { await synapse.worktree.remove({ repo: project.path, dir: w.path, force: true }); closeSlots(open); toast(`worktree ${w.name} removed`); }
    catch (e) { toast(e.message, true); }
    await refresh();
  });
}
// forget a checkout (or a whole project): app.json only, files and library links stay
async function removeFromSidebar(paths, label) {
  const open = slotsIn(paths);
  const go = async () => {
    closeSlots(open);
    for (const p of paths) { try { await synapse.project.remove(p); } catch (e) { toast(e.message, true); } }
    toast(`${label} removed from the sidebar · still in the library`);
    await refresh();
  };
  if (open.length) confirm(`${open.length} session${open.length === 1 ? '' : 's'} run in ${label}. Close them and remove it from the sidebar?`, go, { danger: 'Remove' });
  else go();
}
// an agent that may or may not be one of ours: ours close the normal way, others get SIGTERM by pid
function killAgentAsk(a) {
  const ptyId = Object.keys(M.agents).find((k) => M.agents[k].synapseId === a.id);
  const mine = ptyId && M.slots.find((s) => s.sessions.some((x) => x.pty === ptyId));
  if (mine) return closeSlotAsk(mine);
  if (!a.pid) return toast(`${a.name} has no pid to kill`, true);
  confirmDirty(a.cwd || '', `Kill ${a.name} (pid ${a.pid})? It runs outside this app.`, 'Kill', async () => {
    try { await synapse.agent.kill(a.pid); toast(`sent SIGTERM to ${a.name}`); } catch (e) { toast(e.message, true); }
  });
}
const agentMenu = (worktreePath) => profileOrder().map((k) => ({ label: M.profiles[k].label || k, run: () => newSlot(worktreePath, k) }));
// the sidebar: project tab, checkout row, session row, or the empty pane
$('.side').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const slotRow = e.target.closest('.slot'), wtRow = e.target.closest('.wt'), projBox = e.target.closest('.proj');
  const p = projBox && M.projects.find((x) => x.key === projBox.dataset.key);
  const w = p && wtRow && p.worktrees.find((x) => x.path === wtRow.dataset.path);
  const s = slotRow && slot(Number(slotRow.dataset.slot));
  const items = [];
  if (s && w) {
    if (top(s)) items.push(...sessionActions(s, top(s)));
    items.push('-', { label: 'Close session', danger: true, run: () => closeSlotAsk(s) });
  } else if (w) {
    items.push({ label: 'New agent', sub: agentMenu(w.path) }, { label: 'New worktree', run: () => promptWorktree(p) }, '-');
    if (!(w.home ?? w.path === p.path)) items.push({ label: 'Remove worktree', danger: true, run: () => removeWorktreeAsk(p, w) });
    items.push({ label: 'Remove from sidebar', run: () => removeFromSidebar([w.path], w.name) });
  } else if (p) {
    const first = p.worktrees[0]?.path;
    if (first) items.push({ label: 'New agent', sub: agentMenu(first) });
    items.push({ label: 'New worktree', run: () => promptWorktree(p) }, '-', { label: 'Remove from sidebar', run: () => removeFromSidebar(p.worktrees.map((x) => x.path), p.label) });
  } else {
    items.push({ label: 'New workspace', run: () => promptProject() });
  }
  contextMenu(items, e.clientX, e.clientY);
});

// ---------------------------------------------------------------- settings
const SHORTCUTS = [
  ['layout', [['⌘B', 'toggle sidebar'], ['⌘D', 'split side by side'], ['⇧⌘D', 'split top and bottom']]],
  ['app', [['right-click', 'menu: agents, worktrees, remove, kill'], ['⌘T', 'shell'], ['⌃1 ⌃2 …', 'claude, codex, …'], ['⌘N', 'agent picker'], ['⇧⌘N', 'worktree'], ['⇧⌘F', 'fork'], ['⌘E', 'fork tree'], ['⌘W', 'close session'], ['⇧⌘⌫', 'pop fork'], ['⌘[ ⌘]', 'switch session'], ['⌘1-9', 'nth session'], ['⌃Tab ⌘G', 'node view'], ['⌘,', 'settings']]],
  ['terminal', [['⌘⌫', 'clear line'], ['⌘← ⌘→', 'line start / end'], ['⌥⌫', 'delete word']]],
  ['node view', [['⌘F /', 'search'], ['drag ring', 'link'], ['drag', 'move agent or project'], ['dbl-click', 'rename'], ['⌘-click', 'open its session'], ['scroll', 'zoom'], ['F', 'fit'], ['A', 'arrange'], ['⌫', 'unlink'], ['esc', 'back to terminals']]],
];
// the gear in the node view asks for the same modal
addEventListener('message', (ev) => {
  if (ev.source !== $('#canvas-frame').contentWindow) return;
  if (ev.data?.type === 'synapse:ready') { canvasLive = true; sendTheme(); syncCanvasBranches(); if (pendingThread) { tellCanvas({ action: 'thread', conv: pendingThread }); pendingThread = null; } }
  if (ev.data?.type === 'synapse:settings' && $('#modal').hidden) openSettings();
  if (ev.data?.type === 'synapse:menu' && $('#modal').hidden) canvasMenu(ev.data);
});
// a conversation's thread opens in the node view's side panel: told now if the page is up, else once it says ready
let canvasLive = false, pendingThread = null;
function openTalk(id) {
  if (!$('#modal').hidden) $('#modal').hidden = true;
  closePop();
  openCanvas();
  if (canvasLive) tellCanvas({ action: 'thread', conv: id }); else pendingThread = id;
}
synapse.talks.onOpen(openTalk);
// right-click in the node view: the canvas reports what was hit, the menu is ours
const tellCanvas = (d) => $('#canvas-frame').contentWindow?.postMessage({ type: 'synapse:do', ...d }, '*');
// start an agent in a folder that may not be in the sidebar yet: add it first, so the session has a row
async function agentIn(cwd, kind) {
  try { const dir = await synapse.project.add(cwd); await refresh(); const wt = worktreeOf(dir); if (wt) M.open.add(wt.project.key); if (kind) newSlot(dir, kind); else toast(`${dir.split('/').pop()} added to the sidebar`); }
  catch (e) { toast(e.message, true); }
}
const agentMenuIn = (cwd) => profileOrder().map((k) => ({ label: M.profiles[k].label || k, run: () => agentIn(cwd, k) }));
function canvasMenu({ hit, agent, group, x, y }) {
  const r = $('#canvas-frame').getBoundingClientRect();
  const items = [];
  if (hit === 'node' && agent) {
    const ptyId = Object.keys(M.agents).find((k) => M.agents[k].synapseId === agent.id);
    const mine = ptyId && M.slots.find((s) => s.sessions.some((z) => z.pty === ptyId));
    if (mine) items.push(...sessionActions(mine, mine.sessions.find((q) => q.pty === ptyId)), '-', { label: 'Open session', run: () => { const z = mine.sessions.find((q) => q.pty === ptyId); M.focused = mine.id; focusPath(mine, z.id); if (canvasOpen) toggleCanvas(); render(); } });
    if (!mine) {
      const kids = agent.children || [];
      const collapse = (k) => { tellCanvas({ action: 'collapse-branch', id: k.id }); linkToParent(k.id, agent.id, k.name); };
      if (kids.some((k) => !k.hidden)) items.push({ label: 'Collapse all children', run: () => kids.filter((k) => !k.hidden).forEach(collapse) });
      if (kids.some((k) => k.hidden)) items.push({ label: 'Expand all children', run: () => tellCanvas({ action: 'expand-children', id: agent.id }) });
      for (const child of kids) items.push({ label: `${child.hidden ? 'Expand' : 'Collapse'} child: ${child.name}`, run: () => child.hidden ? tellCanvas({ action: 'expand-branch', id: child.id }) : collapse(child) });
      if (agent.parentId) items.push({ label: 'Collapse this child', run: () => { tellCanvas({ action: 'collapse-branch', id: agent.id }); linkToParent(agent.id, agent.parentId, agent.name); } });
    }
    if (agent.cwd) items.push({ label: 'New agent in this folder', sub: agentMenuIn(agent.cwd) });
    items.push({ label: 'Rename', run: () => tellCanvas({ action: 'rename', id: agent.id }) }, { label: 'Unlink all', run: () => tellCanvas({ action: 'unlink', id: agent.id }) }, '-');
    items.push({ label: mine ? 'Close session' : 'Kill agent', danger: true, run: () => killAgentAsk(agent) });
  } else if (hit === 'group' && group) {
    const p = M.projects.find((q) => q.key === (group.project || group.key));
    // a worktree's frame starts agents in that worktree, the repo's frame in its first checkout
    const inside = (w) => group.cwd === w.path || group.cwd?.startsWith(`${w.path}/`);
    const own = p?.worktrees.filter(inside).sort((x, y) => y.path.length - x.path.length)[0];
    const cwd = (own || p?.worktrees[0])?.path || group.cwd;
    if (cwd) items.push({ label: `New agent in ${group.label}`, sub: agentMenuIn(cwd) });
    if (p) items.push({ label: 'New worktree', run: () => promptWorktree(p) });
    items.push({ label: 'Rename project', run: () => tellCanvas({ action: 'rename-project', key: group.key }) }, '-');
    if (p) items.push({ label: 'Remove from sidebar', run: () => removeFromSidebar(p.worktrees.map((q) => q.path), p.label) });
    else if (group.cwd) items.push({ label: 'Add to sidebar', run: () => agentIn(group.cwd, null) });
  } else {
    items.push({ label: 'New workspace', run: () => promptProject() }, '-', { label: 'Arrange', run: () => tellCanvas({ action: 'arrange' }) }, { label: 'Fit', run: () => tellCanvas({ action: 'fit' }) });
  }
  if (items.length) contextMenu(items, r.left + x, r.top + y);
}
async function openSettings() {
  let s = {};
  try { s = await synapse.settings.get(); } catch {}
  modal('settings', (body, close) => {
    const setup = el('div', 'opt set'), setupButton = el('button', 'btn', 'Set up');
    const setupReport = el('pre', 'setup-report'); setupReport.hidden = true;
    setup.append(el('span', 'k', 'Agent integrations'), el('span', 'c', 'Add Synapse tools and prompt hooks to your agent settings. Existing files are backed up.'), setupButton);
    setupButton.onclick = async () => {
      setupButton.disabled = true; setupButton.textContent = 'Setting up…';
      try { setupReport.textContent = await synapse.integrations.install(); setupReport.hidden = false; setupButton.textContent = 'Set up again'; }
      catch (e) { setupReport.textContent = e.message; setupReport.hidden = false; setupButton.textContent = 'Try again'; }
      finally { setupButton.disabled = false; }
    };
    body.append(setup, setupReport);
    const themeRow = el('div', 'opt set'), themeBtn = el('button', 'btn');
    const showTheme = () => (themeBtn.textContent = document.documentElement.dataset.theme === 'night' ? '◐ night' : '◐ signal');
    themeRow.append(el('span', 'k', 'theme'), el('span', 'c', 'signal is light, night is dark'), themeBtn); showTheme();
    themeBtn.onclick = () => { toggleTheme(); showTheme(); };
    const linkRow = el('label', 'opt set'), cb = el('input');
    cb.type = 'checkbox'; cb.checked = !!s.autoSymlink;
    linkRow.append(cb, el('span', 'k', 'link workspaces'), el('span', 'c', 'symlink workspaces added from elsewhere into ~/.synapse/workspaces, so the library can bring them back'));
    cb.onchange = async () => {
      try { await synapse.settings.set({ autoSymlink: cb.checked }); toast(cb.checked ? 'new workspaces get linked into ~/.synapse/workspaces' : 'workspaces are no longer linked · existing links stay'); }
      catch (e) { cb.checked = !cb.checked; toast(e.message, true); }
    };
    const forkRow = el('label', 'opt set'), fcb = el('input');
    fcb.type = 'checkbox'; fcb.checked = !!s.autoSendFork;
    forkRow.append(fcb, el('span', 'k', 'send forks'), el('span', 'c', 'send a fork\'s question right away, instead of leaving it in the child\'s prompt for you to send'));
    fcb.onchange = async () => {
      try { M.autoSendFork = (await synapse.settings.set({ autoSendFork: fcb.checked })).autoSendFork; toast(fcb.checked ? 'forks send their question right away' : 'a fork\'s question waits in its prompt for you'); }
      catch (e) { fcb.checked = !fcb.checked; toast(e.message, true); }
    };
    const doneRow = el('label', 'opt set'), dcb = el('input');
    dcb.type = 'checkbox'; dcb.checked = s.notifyDone !== false;
    doneRow.append(dcb, el('span', 'k', 'notify when done'), el('span', 'c', 'a notification when an agent finishes while Synapse is in the background, a toast when you are looking at another one'));
    dcb.onchange = async () => {
      try { dcb.checked = (await synapse.settings.set({ notifyDone: dcb.checked })).notifyDone; toast(dcb.checked ? 'agents tell you when they are done' : 'no notifications when agents finish'); }
      catch (e) { dcb.checked = !dcb.checked; toast(e.message, true); }
    };
    const loginRow = el('label', 'opt set'), lcb = el('input');
    lcb.type = 'checkbox'; lcb.checked = !!s.openAtLogin;
    loginRow.append(lcb, el('span', 'k', 'Open Synapse at login'), el('span', 'c', 'so friends\' questions get answered while you work'));
    lcb.onchange = async () => {
      try { lcb.checked = (await synapse.settings.set({ openAtLogin: lcb.checked })).openAtLogin; toast(lcb.checked ? 'Synapse opens at login' : 'Synapse no longer opens at login'); }
      catch (e) { lcb.checked = !lcb.checked; toast(e.message, true); }
    };
    const updRow = el('div', 'opt set'), updVal = el('span', 'c'), updBtn = el('button', 'btn', 'check now');
    const showUpd = (u) => {
      const at = `version ${u.current || '?'}`;
      updVal.textContent = !u.enabled ? `${at} · ${u.current?.includes('-') ? 'preview build, install updates manually' : 'running from source, updates come with git pull'}`
        : u.state === 'checking' ? `${at} · checking…`
        : u.state === 'error' ? `${at} · last check failed: ${u.error}`
        : ['downloading', 'ready', 'manual', 'installing'].includes(u.state) ? `${at} · ${u.version} available`
        : `${at} · up to date`;
      updBtn.hidden = !u.enabled;
    };
    updRow.append(el('span', 'k', 'updates'), updVal, updBtn);
    synapse.update.get().then(showUpd, () => {});
    updBtn.onclick = async () => { updBtn.disabled = true; updVal.textContent = 'checking…'; try { showUpd(await synapse.update.check()); } catch (e) { toast(e.message, true); } updBtn.disabled = false; };
    const tourRow = el('div', 'opt set'), tourBtn = el('button', 'btn', 'replay');
    tourRow.append(el('span', 'k', 'tour'), el('span', 'c', 'the five steps a new install starts with'), tourBtn);
    tourBtn.onclick = () => { close(); showOnboarding(false); };
    body.append(el('div', 'hint', '~/.synapse/app.json · esc closes'), themeRow, linkRow, forkRow, doneRow, loginRow, updRow, tourRow);
    const commands = el('div', 'agent-commands'), commandInputs = new Map();
    for (const [kind, profile] of Object.entries(s.profiles || {})) {
      const row = el('label', 'opt set'), input = el('input');
      input.value = profile.command; input.spellcheck = false; input.setAttribute('aria-label', `${profile.label || kind} command`);
      row.append(el('span', 'k', profile.label || kind), input); commands.append(row); commandInputs.set(kind, input);
    }
    const saveCommands = el('button', 'btn', 'Save commands');
    saveCommands.onclick = async () => {
      saveCommands.disabled = true;
      try { const result = await synapse.settings.set({ profiles: Object.fromEntries([...commandInputs].map(([kind, input]) => [kind, { command: input.value }])) }); M.profiles = result.profiles; render(); toast('Commands saved. New sessions use these commands.'); }
      catch (e) { toast(e.message, true); }
      finally { saveCommands.disabled = false; }
    };
    commands.append(saveCommands); body.append(el('div', 'sub', 'Agent commands'), commands);
    const phones = el('div', 'phones');
    body.append(el('div', 'sub', 'phone'), phones);
    drawPhones(phones);
    const people = el('div', 'people');
    body.append(el('div', 'sub', 'trusted people'), people);
    drawPeople(people);
    const perHour = el('input'), model = el('select'), used = el('span', 'c');
    perHour.type = 'number'; perHour.min = 1; perHour.max = 600; perHour.value = s.talkPerHour ?? 60;
    perHour.onchange = async () => {
      try { perHour.value = (await synapse.settings.set({ talkPerHour: perHour.value })).talkPerHour; toast(`friends' agents may ask ${perHour.value} an hour each`); }
      catch (e) { toast(e.message, true); }
    };
    for (const [v, label] of [['agent', 'the agent\'s own'], ['opus', 'opus'], ['sonnet', 'sonnet'], ['haiku', 'haiku']]) { const o = el('option', '', label); o.value = v; model.appendChild(o); }
    model.value = s.talkModel || 'agent';
    model.onchange = async () => {
      try { model.value = (await synapse.settings.set({ talkModel: model.value })).talkModel; toast(`answers use ${model.value === 'agent' ? 'the agent\'s own model' : model.value}`); }
      catch (e) { toast(e.message, true); }
    };
    const limitRow = el('label', 'opt set'), modelRow = el('label', 'opt set'), usedRow = el('div', 'opt set');
    limitRow.append(el('span', 'k', 'questions an hour'), perHour, el('span', 'c', 'most a friend\'s agents may ask yours each hour'));
    modelRow.append(el('span', 'k', 'answer model'), model, el('span', 'c', 'answers spend your Claude usage'));
    usedRow.append(el('span', 'k', 'answers given'), used);
    used.textContent = '…';
    synapse.settings.usage().then((u) => {
      used.textContent = `${u.today} today · ${u.week} this week` + (u.byPeer.length ? ` · ${u.byPeer.map((p) => `${p.name} ${p.today}`).join(', ')}` : '');
    }, () => { used.textContent = 'unavailable'; });
    body.append(el('div', 'sub', 'agent talk'), limitRow, modelRow, usedRow);
    const hist = el('div', 'talk-hist');
    body.append(el('div', 'sub', 'conversations'), hist);
    drawTalkHistory(hist);
    for (const [title, keys] of SHORTCUTS) {
      const box = el('div', 'keys');
      for (const [k, what] of keys) { const row = el('span'); row.append(el('kbd', '', k), what); box.appendChild(row); }
      body.append(el('div', 'sub', title), box);
    }
    body.tabIndex = 0; body.onkeydown = (e) => { if (e.key === 'Escape') close(); };
  });
  // not the hourly limit field: settings open to read, not to type
  $('#modal-body').focus();
}

// One suggestion, the first time a link goes to talk: only the user's Turn on changes the login item.
synapse.onLoginSuggest(() => {
  if ($('#login-suggest')) return;
  const box = el('div', 'toast login-suggest'), yes = el('button', 'btn sig', 'Turn on'), no = el('button', 'btn', 'Not now');
  box.id = 'login-suggest';
  const done = () => box.remove();
  yes.onclick = async () => { try { await synapse.settings.set({ openAtLogin: true }); toast('Synapse opens at login'); } catch (e) { toast(e.message, true); } done(); };
  no.onclick = done;
  box.append(el('span', '', 'Answer questions even when Synapse is closed? Open at login'), yes, no);
  document.body.appendChild(box);
});

let toastTimer = null;
function toast(text, sig = false, onClick = null) {
  const t = $('#toast'); t.textContent = text; t.className = 'toast' + (sig ? ' sig' : '') + (onClick ? ' act' : ''); t.hidden = false;
  t.onclick = onClick && (() => { t.hidden = true; onClick(); });
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), onClick ? 6000 : 2600);
}

// ---------------------------------------------------------------- keys

const appMod = (e) => (WIN ? e.ctrlKey && e.shiftKey && !e.metaKey : e.metaKey);
// on Windows Shift is part of the modifier, so e.key is the shifted character: name the physical key instead
const winKey = (e) => (/^(Key|Digit)/.test(e.code) ? e.code.slice(-1).toLowerCase() : { BracketLeft: '[', BracketRight: ']', Comma: ',' }[e.code] || e.key.toLowerCase());
const keyName = (e) => (WIN ? (e.altKey ? 'shift+' : '') + winKey(e) : (e.shiftKey ? 'shift+' : '') + e.key.toLowerCase());
// ⌃1 ⌃2 … start the nth agent (claude, codex, …; the shell is not in this list) in the focused worktree
const agentProfiles = () => profileOrder().filter((k) => k !== 'shell');
const agentKey = (e) => (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key) ? agentProfiles()[e.key - 1] : null);
const APP_KEYS = new Set(['b', 'd', 'shift+d', 't', 'n', 'shift+n', 'shift+f', 'e', 'w', '[', ']', 'shift+backspace', '1', '2', '3', '4', '5', '6', '7', '8', '9', ',']);
// ⌘ + editing key -> what a macOS terminal sends for it (iTerm's natural editing, Ghostty's defaults)
const META_EDIT = { Backspace: '\x15', ArrowLeft: '\x01', ArrowRight: '\x05' };
window.addEventListener('keydown', (e) => {
  if (nameEdit || e.key !== 'Escape' || !canvasOpen || !$('#modal').hidden) return;
  e.preventDefault(); e.stopImmediatePropagation();
  closeCanvas();
}, true);
window.addEventListener('keydown', (e) => {
  if (!$('#modal').hidden || !$('#login').hidden) return;
  if (fanOpen && e.key === 'Escape') return closeFan();
  if (fanOpen && e.key === 'Backspace') { const s = focusedSlot(); const t = top(s); if (t?.parent != null) requestCloseSession(s, t.id); return; }
  const agent = agentKey(e);
  if (agent) { e.preventDefault(); const wt = focusedSlot()?.worktree || M.projects[0]?.worktrees[0]?.path; if (wt) newSlot(wt, agent); else toast('add a workspace first', true); return; }
  if (!appMod(e)) return;
  const k = keyName(e);
  if (!APP_KEYS.has(k)) return;
  e.preventDefault();
  const s = focusedSlot();
  switch (k) {
    case 'b': toggleSidebar(); break;
    case 'd': splitShell('right'); break;
    case 'shift+d': splitShell('down'); break;
    case 't': { const wt = s?.worktree || M.projects[0]?.worktrees[0]?.path; if (wt) newSlot(wt, 'shell'); break; }
    case 'n': { const wt = s?.worktree || M.projects[0]?.worktrees[0]?.path; if (wt) pickProfile(wt); break; }
    case 'shift+n': { const p = s ? worktreeOf(s.worktree)?.project : M.projects[0]; if (p) promptWorktree(p); break; }
    case 'shift+f': promptFork(); break;
    case 'e': fanOpen ? closeFan() : openFan(); break;
    case 'shift+backspace': pop(); break;
    case 'w': { const t = top(s); if (t) requestCloseSession(s, t.id); break; }
    case '[': case ']': switchSession(k); break;
    case ',': openSettings(); break;
    default: switchSession(k);
  }
});

// The Synapse canvas (links, messages, every agent on the machine) as an overlay over the terminals.
let canvasOpen = false;
let canvasReady = null, canvasVersion = 0;
let canvasBackPending = false, reopenCanvas = false;
history.replaceState({ ...history.state, synapseView: 'terminal' }, '');

function showCanvas(open) {
  if (open && activityOpen) showActivity(false);
  canvasOpen = open;
  $('#canvas').hidden = !open;
  $('#btn-canvas').classList.toggle('on', open);
  $('#btn-canvas').setAttribute('aria-pressed', String(open));
  if (!open) {
    $('#canvas').classList.remove('loading');
    if ($('#modal').hidden && !fanOpen) top(focusedSlot())?.term.focus();
  }
}

async function openCanvas() {
  // history.back() is asynchronous: finish removing the old entry before pushing another.
  if (canvasBackPending) { reopenCanvas = true; return; }
  if (canvasOpen) return;
  if (fanOpen) closeFan();
  if (history.state?.synapseView !== 'canvas') history.pushState({ ...history.state, synapseView: 'canvas' }, '');
  showCanvas(true);
  const version = ++canvasVersion;
  const f = $('#canvas-frame');
  if (!f.src) $('#canvas').classList.add('loading');
  try {
    canvasReady ||= synapse.canvas().then((url) => { f.src = new URL('canvas', url).href; }).catch((e) => { canvasReady = null; throw e; });
    await canvasReady;
    if (version === canvasVersion && canvasOpen && $('#modal').hidden) f.focus();
  } catch (e) {
    if (version === canvasVersion && canvasOpen) { closeCanvas(); toast(e.message, true); }
  } finally {
    if (version === canvasVersion) $('#canvas').classList.remove('loading');
  }
}

function closeCanvas(fromHistory = false) {
  reopenCanvas = false;
  if (!canvasOpen) return;
  ++canvasVersion;
  showCanvas(false);
  if (!fromHistory && !canvasBackPending && history.state?.synapseView === 'canvas') {
    canvasBackPending = true;
    history.back();
  }
}

function toggleCanvas() { if (workspaceOpen) showWorkspace(false); if (canvasOpen || reopenCanvas) closeCanvas(); else openCanvas(); }
addEventListener('popstate', () => {
  const reopen = reopenCanvas;
  canvasBackPending = false; reopenCanvas = false;
  if (reopen || history.state?.synapseView === 'canvas') openCanvas();
  else closeCanvas(true);
});
$('#btn-canvas').onclick = toggleCanvas;

// ---------------------------------------------------------------- activity
// Your year at a glance: GitHub contributions and prompts to your agents as heatmaps, with a streak, a level and badges.
let activityOpen = false, activityAt = 0;
function showActivity(open) {
  activityOpen = open;
  $('#activity').hidden = !open;
  $('#btn-activity').classList.toggle('on', open);
  $('#btn-activity').setAttribute('aria-pressed', String(open));
  if (open) { if (canvasOpen) closeCanvas(); $('#activity').focus(); drawActivity(); }
  else if ($('#modal').hidden && !fanOpen) top(focusedSlot())?.term.focus();
}
$('#btn-activity').onclick = () => showActivity(!activityOpen);
$('#activity').onkeydown = (e) => { if (e.key === 'Escape') showActivity(false); };
synapse.activity.onProgress(({ done, total }) => { const p = $('#activity .act-loading'); if (p) p.textContent = `counting your year · ${done} of ${total} conversations`; });

const fmt = (n) => n.toLocaleString('en-US');
const compact = (n) => n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// 53 weeks of days, Sunday on top, like GitHub's; four shades split at the busiest tenth of active days
function heatmap(days, unit) {
  const wrap = el('div', 'act-map'), months = el('div', 'act-months'), grid = el('div', 'act-grid');
  const end = new Date(); end.setHours(12, 0, 0, 0);
  const start = new Date(end); start.setDate(start.getDate() - 52 * 7 - end.getDay());
  const vals = Object.values(days).filter(Boolean).sort((x, y) => x - y);
  const hi = vals[Math.floor(vals.length * 0.9)] || 1;
  let col = 0, lastMonth = -1;
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0) {
      if (d.getMonth() !== lastMonth && col < 51) { const m = el('span', '', d.toLocaleDateString('en-US', { month: 'short' })); m.style.gridArea = `1 / ${col + 1} / 2 / span 3`; months.appendChild(m); lastMonth = d.getMonth(); }
      col++;
    }
    const n = days[dayKey(d)] || 0, cell = el('i', `l${n ? Math.min(4, Math.ceil((4 * n) / hi)) : 0}`);
    cell.title = `${n ? fmt(n) : 'no'} ${n === 1 ? unit.replace(/s$/, '') : unit} · ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
    grid.appendChild(cell);
  }
  const legend = el('div', 'act-legend');
  legend.append(el('span', '', 'less'), ...[0, 1, 2, 3, 4].map((l) => el('i', `l${l}`)), el('span', '', 'more'));
  wrap.append(months, grid, legend);
  return wrap;
}

async function drawActivity() {
  const box = $('#activity');
  if (box.dataset.ready && Date.now() - activityAt < 60_000) return;
  if (!box.dataset.ready) box.replaceChildren(el('div', 'act-loading', 'counting your year…'));
  let a;
  try { a = await synapse.activity.get(); } catch (e) { if (!box.dataset.ready) box.replaceChildren(el('div', 'act-loading', e.message)); return; }
  activityAt = Date.now(); box.dataset.ready = '1';
  const page = el('div', 'act-page');
  const head = el('div', 'act-head'), lvl = el('div', 'act-level'), bar = el('div', 'act-xp'), fill = el('span');
  fill.style.width = `${Math.round((100 * (a.xp - a.levelFrom)) / (a.levelTo - a.levelFrom))}%`;
  bar.appendChild(fill);
  lvl.append(el('div', 'act-lvl', `level ${a.level}`), bar, el('div', 'act-cap', `${fmt(a.xp)} XP · ${fmt(a.levelTo - a.xp)} to level ${a.level + 1}`));
  head.append(el('div', 'act-title', 'Activity'), lvl);
  const tiles = el('div', 'act-tiles');
  const tile = (n, label, hot) => { const t = el('div', 'act-tile' + (hot ? ' hot' : '')); t.append(el('b', '', n), el('span', '', label)); return t; };
  const codeWord = a.github ? 'contributions' : 'commits';
  tiles.append(
    tile(fmt(a.streak), 'day streak', a.streak > 0),
    tile(fmt(a.longest), 'best streak'),
    tile(fmt(a.totals.code), codeWord),
    tile(fmt(a.totals.claude + a.totals.codex), 'prompts'),
    tile(compact(a.totals.tokens), 'tokens'),
    tile(compact(a.totals.todayTokens), 'tokens today'),
  );
  const section = (title, sub, map) => { const s = el('div', 'act-sec'), h = el('div', 'act-sec-head'); h.append(el('span', 'act-sec-t', title), el('span', 'act-sec-s', sub)); s.append(h, map); return s; };
  const agents = {};
  for (const k of ['claude', 'codex']) for (const [d, n] of Object.entries(a.prompts[k])) agents[d] = (agents[d] || 0) + n;
  const code = a.github
    ? section(`GitHub · @${a.github.login}`, `${fmt(a.totals.code)} contributions in the last year`, heatmap(a.github.days, 'contributions'))
    : section('Commits', `${fmt(a.totals.code)} in your workspaces · sign in to the gh CLI to see GitHub here`, heatmap(a.commits, 'commits'));
  const tokenDays = Object.fromEntries(Object.entries(a.tokens).map(([d, t]) => [d, t.all]));
  const models = el('div', 'act-models'), top = a.models[0]?.tokens || 1;
  for (const m of a.models.slice(0, 8)) {
    const row = el('div', 'act-model'), bar = el('span', 'bar'), fill = el('i');
    fill.style.width = `${Math.max(1, (100 * m.tokens) / top)}%`; bar.appendChild(fill);
    row.append(el('span', 'name', m.name), bar, el('span', 'n', compact(m.tokens)));
    models.appendChild(row);
  }
  const tokens = section('Tokens', `${compact(a.totals.tokens)} read and written · ${compact(a.totals.tokensOut)} written by your agents`, heatmap(tokenDays, 'tokens'));
  if (a.models.length) tokens.appendChild(models);
  const badges = el('div', 'act-badges');
  for (const b of a.badges) { const c = el('div', 'act-badge' + (b.got ? ' got' : '')); c.append(el('b', '', b.name), el('span', '', b.what)); badges.appendChild(c); }
  const friends = section('Friends this week', 'the last 7 days, next to the people you trust', el('div', 'act-board'));
  drawBoard(friends.querySelector('.act-board'));
  page.append(head, tiles, friends, code,
    section('Agents', `${fmt(a.totals.claude)} prompts to Claude · ${fmt(a.totals.codex)} to Codex`, heatmap(agents, 'prompts')),
    tokens,
    section('Badges', `${a.badges.filter((b) => b.got).length} of ${a.badges.length}`, badges),
    el('div', 'act-foot', 'counted on this Mac from your repos and agent conversations · esc closes'));
  box.replaceChildren(page);
}
// the friends board: you and the people you trust both ways who joined, ranked by one number at a time
let boardBy = 'tokens';
const BOARD_BY = [['tokens', 'tokens', compact], ['prompts', 'prompts', fmt], ['activeDays', 'active days', fmt], ['streak', 'streak', fmt]];
async function drawBoard(box, act) {
  let b;
  try { b = await (act ? synapse.board[act]() : synapse.board.get()); } catch (e) { box.replaceChildren(el('div', 'act-board-note', e.message)); return; }
  const note = (text, button, onClick) => {
    const n = el('div', 'act-board-join');
    n.append(el('p', '', text));
    if (button) { const go = el('button', 'btn sig', button); go.onclick = async () => { go.disabled = true; go.textContent = 'counting…'; await drawBoard(box, onClick); }; n.appendChild(go); }
    box.replaceChildren(n);
  };
  if (!b.signedIn) return note('Sign in to Synapse (settings) to compete with the people you trust.');
  if (!b.joined) return note(`See how your week compares with the people you trust. Joining shows them your last 7 days: tokens, prompts, commits, active days and streak.${b.waiting ? ` ${b.waiting} of them ${b.waiting === 1 ? 'is' : 'are'} on the board already.` : ''}`, 'join the board', 'join');
  const [key, , show] = BOARD_BY.find((x) => x[0] === boardBy);
  const people = [...b.people].sort((x, y) => (y[key] || 0) - (x[key] || 0));
  const top = Math.max(1, people[0]?.[key] || 0);
  const tabs = el('div', 'act-board-by');
  for (const [k, label] of BOARD_BY) { const t = el('button', k === boardBy ? 'on' : '', label); t.onclick = () => { boardBy = k; drawBoard(box); }; tabs.appendChild(t); }
  const list = el('div', 'act-board-list');
  people.forEach((p, i) => {
    const row = el('div', 'act-rank' + (p.me ? ' me' : '') + (i === 0 && people.length > 1 ? ' first' : ''));
    const who = el('div', 'who');
    who.append(el('b', '', p.me ? 'You' : p.name || p.handle), el('span', '', p.handle ? `@${p.handle}` : ''));
    const bar = el('span', 'bar'), fill = el('i');
    fill.style.width = `${Math.max(1.5, (100 * (p[key] || 0)) / top)}%`; bar.appendChild(fill);
    row.append(el('span', 'pos', String(i + 1)), who, bar, el('span', 'n', show(p[key] || 0)));
    list.appendChild(row);
  });
  const foot = el('div', 'act-board-foot');
  if (people.length === 1) foot.appendChild(el('span', '', 'Nobody you trust has joined yet. When they do, they show up here.'));
  const leave = el('button', 'act-board-leave', 'leave the board');
  leave.onclick = () => drawBoard(box, 'leave');
  foot.appendChild(leave);
  box.replaceChildren(tabs, list, foot);
}

for (const type of ['mouseup', 'auxclick']) addEventListener(type, (ev) => {
  if (ev.button !== 3 && ev.button !== 4) return;
  ev.preventDefault(); ev.stopImmediatePropagation();
  if (type === 'mouseup') { if (ev.button === 3) closeCanvas(); else if (!canvasOpen && !canvasBackPending) history.forward(); }
}, true);

// ⌘-click on a node in the canvas: bring that agent's session to the front, wherever it sits in a fork tree
addEventListener('message', (ev) => {
  const f = $('#canvas-frame');
  if (!f.src || ev.source !== f.contentWindow || ev.origin !== new URL(f.src).origin) return;
  if (ev.data?.type === 'synapse:close') { if ($('#modal').hidden) closeCanvas(); return; }
  if (ev.data?.type === 'synapse:forward') { if (!canvasOpen && !canvasBackPending) history.forward(); return; }
  if (ev.data?.type === 'synapse:switch') { if ($('#modal').hidden && /^[1-9\[\]]$/.test(ev.data.key)) switchSession(ev.data.key); return; }
  if (ev.data?.type !== 'synapse:open') return;
  const { id, name, pid } = ev.data;
  const ptyId = Object.keys(M.agents).find((k) => M.agents[k].synapseId === id);
  for (const s of M.slots) {
    const x = ptyId && s.sessions.find((y) => y.pty === ptyId);
    if (!x) continue;
    const wt = worktreeOf(s.worktree); if (wt) M.open.add(wt.project.key);
    selectSession(s, x.id);
    return;
  }
  toast(`${name || id} runs outside this app${pid ? ` (pid ${pid})` : ''}`, true);
});
synapse.onCanvasToggle(toggleCanvas);
synapse.onCanvasBack(() => closeCanvas());

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'night' ? 'signal' : 'night';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('synapse-mode', next);
  for (const sl of M.slots) for (const x of sl.sessions) x.term.options.theme = termTheme();
  sendTheme();
}
// the node view runs on another origin and cannot read our choice: tell it when it loads and whenever it changes
const sendTheme = () => $('#canvas-frame').contentWindow?.postMessage({ type: 'synapse:theme', theme: document.documentElement.dataset.theme }, '*');
$('#canvas-frame').addEventListener('load', sendTheme);

$('#theme').onclick = toggleTheme;
$('#settings').onclick = openSettings;
$('#btn-fork').onclick = () => promptFork();
$('#add-project').onclick = () => promptProject();
new ResizeObserver(() => {
  for (const s of M.slots) for (const x of s.sessions) if (x.el.classList.contains('visible')) x.fit.fit();
}).observe($('#stage'));
$('#toggle-sidebar').onclick = toggleSidebar;
$('#split-right').onclick = () => splitShell('right');
$('#split-down').onclick = () => splitShell('down');
if (localStorage.getItem('synapse-sidebar-collapsed') === 'true') toggleSidebar();

// ---------------------------------------------------------------- state

let prRefreshAt = 0, prRefreshing = false;
async function refreshPullRequests() {
  if (prRefreshing || Date.now() - prRefreshAt < 60000) return;
  prRefreshing = true; prRefreshAt = Date.now();
  try {
    for (const p of M.projects) {
      const { statuses } = await synapse.worktree.prs(p.path, p.worktrees);
      p.worktrees.forEach((w, i) => prStatuses.set(w.path, statuses[i]));
    }
    render();
  } catch {} finally { prRefreshing = false; }
}
async function refresh() { apply(await synapse.state()); }
function apply(st) {
  M.projects = st.projects; M.agents = st.agents; M.unread = st.unread; M.profiles = st.profiles; M.edges = st.edges; M.demo = st.demo; M.autoSendFork = !!st.autoSendFork;
  const talks = JSON.stringify([st.talks || [], st.talkRequests || []]);
  if (talks !== M.talksSig) { M.talksSig = talks; M.talks = st.talks || []; M.talkRequests = st.talkRequests || []; renderDot(); }
  // remember which agent each session runs while it is alive: that id is what a restart resumes. A resumed
  // agent that has not written its transcript yet must not wipe the id it was resumed from.
  for (const sl of M.slots) for (const x of sl.sessions) {
    const a = M.agents[x.pty];
    if (a?.synapseId && (a.transcript || !x.resume)) x.resume = { synapseId: a.synapseId, transcript: a.transcript || null };
    if (a && agentWorking(a)) x.ran = true; // noted here, not on draw, so a folded workspace's agents count too
    if (a) watchTurn(x, a);
    if (a && x.named === false) { x.named = true; nameForkAgent(x); }
  }
  refreshPullRequests();
  render();
}
synapse.onState(apply);

// An agent that finishes a turn while you look elsewhere says so: a toast when Synapse is in front, a
// notification when it is not. A turn has to have run a few seconds and then stayed quiet for two checks, so
// the pause between two steps of one turn is not a finish.
const TURN_MIN = 5000;
function watchTurn(x, a) {
  if (agentWorking(a)) { x.turnSince ||= Date.now(); x.quiet = 0; return; }
  if (!x.turnSince || ++x.quiet < 2) return;
  const long = Date.now() - x.turnSince;
  x.turnSince = 0;
  if (long < TURN_MIN || x.exited) return;
  const s = M.slots.find((sl) => sl.sessions.includes(x));
  const looking = document.hasFocus() && !canvasOpen && $('#modal').hidden && s && focusedSlot() === s && top(s) === x;
  if (looking) return;
  // a tab still called just "codex" says little with three of them open; the agent's name says which
  const name = x.title && x.title !== x.kind ? x.title : a.name || x.title;
  if (document.hasFocus()) toast(`✓ ${name} is done · open`, false, () => openTurn(x.pty));
  else synapse.notify.done({ pty: x.pty, title: name, took: long });
}
function openTurn(pty) {
  const s = M.slots.find((sl) => sl.sessions.some((x) => x.pty === pty));
  if (!s) return;
  M.focused = s.id; focusPath(s, s.sessions.find((x) => x.pty === pty).id);
  if (canvasOpen) toggleCanvas();
  render();
  top(s)?.term.focus();
}
synapse.notify.onOpen(openTurn);
synapse.fork.onRequest(({ requestId, parentPty, question }) => fork(question, { requestId, parentPty }));

// ---------------------------------------------------------------- account, trusted people, synapse requests

// Signed in through Synapse Cloud, agents can ask trusted people for context. Their requests arrive as a
// blinking circle on "synapse" at the top right; accepted links turn it green, hovering lists them.
// People who added you as trusted, and you have not trusted back, blink it too.
const ACC = { user: null, feed: { incoming: [], outgoing: [], links: [], incomingTrust: [] }, sticky: false, agents: [], choice: {}, talk: {} };
const pendingRequests = () => (ACC.feed.incoming || []).filter((r) => r.status === 'pending');
const pendingTrust = () => ACC.feed.incomingTrust || [];
const pendingTalk = () => M.talkRequests || []; // a friend's agent wants to ask one of mine that is shared read only
const personName = (p) => p?.name || (p?.handle ? `@${p.handle}` : p?.email) || 'someone';
const initials = (u) => (u?.name || u?.handle || u?.email || '?').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
function avatar(u, cls = 'av') {
  const a = el('span', cls);
  if (u?.avatar) { const img = el('img'); img.src = u.avatar; img.alt = ''; img.onerror = () => { img.remove(); a.textContent = initials(u); }; a.appendChild(img); }
  else a.textContent = initials(u);
  return a;
}
const unwrapUser = (r) => r?.user || r || null;

function renderMe() {
  const b = $('#me');
  b.replaceChildren();
  if (ACC.user) { b.append(avatar(ACC.user), el('span', 'me-name', ACC.user.handle ? `@${ACC.user.handle}` : personName(ACC.user))); b.title = 'account'; b.onclick = openAccount; }
  else { b.textContent = 'sign in'; b.title = 'sign in to share agents with people you trust'; b.onclick = () => showLogin(); }
}

function renderDot() {
  const dot = $('#syn-dot'), p = pendingRequests().length, t = pendingTrust().length, q = pendingTalk().length, links = (ACC.feed.links || []).length, talks = (M.talks || []).length;
  dot.hidden = !p && !t && !q && !links && !talks;
  dot.className = p || t || q ? 'blink' : links || talks ? 'live' : '';
  $('#btn-canvas .glyph').hidden = !dot.hidden;
  dot.setAttribute('aria-label', p ? `${p} synapse request${p > 1 ? 's' : ''}` : t ? `${t} ${t > 1 ? 'people' : 'person'} added you` : q ? `${q} agent${q > 1 ? 's' : ''} asking to ask questions` : links ? `${links} synapsed external agent${links > 1 ? 's' : ''}` : `${talks} open conversation${talks > 1 ? 's' : ''}`);
  if (dot.hidden) closePop(); else if (!$('#syn-pop').hidden) renderPop();
}

// the popover: pending requests to answer, then every external agent synapsed with ours
let popTimer = null;
function openPop(sticky) {
  clearTimeout(popTimer);
  if ($('#syn-dot').hidden) return;
  if (sticky) ACC.sticky = true;
  const pop = $('#syn-pop');
  if (pop.hidden) {
    pop.hidden = false;
    renderPop();
    if (pendingRequests().length) synapse.requests.agents().then((a) => { ACC.agents = a; renderPop(); }).catch(() => {});
  }
}
function closePop() { clearTimeout(popTimer); ACC.sticky = false; $('#syn-pop').hidden = true; }
const closePopSoon = () => { if (ACC.sticky) return; clearTimeout(popTimer); popTimer = setTimeout(closePop, 250); };

// which of my agents fits a request best: words of its target, note and project against name and project
function bestAgent(r) {
  const words = `${r.target || ''} ${r.note || ''} ${r.agent?.project || ''}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  let best = ACC.agents[0]?.id || '', top = 0;
  for (const a of ACC.agents) {
    const hay = `${a.name} ${a.project} ${a.kind}`.toLowerCase();
    const score = words.filter((w) => hay.includes(w)).length;
    if (score > top) { top = score; best = a.id; }
  }
  return best;
}

// "@x added you": Trust back adds them to my trusted people, Ignore tells the cloud to stop asking.
// Used in the popover and in settings; `done` redraws whatever holds the row.
function trustRow(p, done) {
  const box = el('div', 'req trust-in');
  const who = el('div', 'req-who');
  who.append(avatar(p), el('b', '', p.handle ? `@${p.handle}` : personName(p)), el('span', '', ' added you'));
  if (p.handle && p.name) who.append(el('span', 'h', p.name));
  box.append(who, el('div', 'req-what', 'Trust them back to let your agents ask each other for context.'));
  const row = el('div', 'req-row'), no = el('button', 'btn', 'Ignore'), yes = el('button', 'btn sig', 'Trust back');
  const act = async (fn, msg) => {
    no.disabled = yes.disabled = true;
    try { await fn(); toast(msg); done?.(); } catch (e) { toast(e.message, true); no.disabled = yes.disabled = false; }
  };
  no.onclick = () => act(() => synapse.people.ignore(p.id), `ignored ${personName(p)}`);
  yes.onclick = () => act(() => synapse.people.trustBack(p.id, p.handle), `${personName(p)} is trusted`);
  row.append(el('span', 'req-gap'), no, yes);
  box.append(row);
  return box;
}

// "@x's agent wants to ask <my agent>": Allow switches that share to talk, Not now keeps it read only for a day.
function talkRequestRow(r) {
  const box = el('div', 'req talk-req');
  const who = el('div', 'req-who'), handle = r.peerHandle ? `@${r.peerHandle}` : r.peerName || 'a friend';
  who.append(avatar({ name: r.peerName, handle: r.peerHandle }), el('b', '', `${handle}'s agent`), el('span', '', ' wants to ask'), el('span', 'ag', r.targetName || 'your agent'));
  box.append(who, el('div', 'req-what', `${r.askerName || 'Their agent'} reads ${r.targetName || 'it'} already. Allow it to ask questions too; a copy without tools answers.`));
  const row = el('div', 'req-row'), no = el('button', 'btn', 'Not now'), yes = el('button', 'btn sig', 'Allow');
  const act = async (fn, msg) => {
    no.disabled = yes.disabled = true;
    try { await fn(); toast(msg); } catch (e) { toast(e.message, true); no.disabled = yes.disabled = false; }
  };
  no.onclick = () => act(() => synapse.talkRequests.dismiss(r.id), 'not now');
  yes.onclick = () => act(() => synapse.talkRequests.allow(r.id), `${handle}'s agent can ask ${r.targetName || 'it'}`);
  row.append(el('span', 'req-gap'), no, yes);
  box.append(row);
  return box;
}

// ---------------------------------------------------------------- friends and share
// Top right, under fork. Friends lists the trusted people and what flows between you, with anything waiting on you
// on top. Share offers the open agent to one of them, read only or read and ask; they pick which of their agents
// receives it, and once they accept, this Mac links the two.
const openAgent = () => { const s = top(focusedSlot()), a = s && M.agents[s.pty]; return a?.synapseId ? { id: a.synapseId, name: a.name, kind: a.kind } : null; };
const offersIn = () => (ACC.feed.incoming || []).filter((r) => r.kind === 'offer' && r.status === 'pending');
const offersOut = (p) => (ACC.feed.outgoing || []).filter((r) => r.kind === 'offer' && r.status === 'pending' && (r.to?.handle ? r.to.handle === p.handle : r.to?.name === p.name));
let people = [], peopleAt = 0;
async function loadPeople(force = false) {
  if (!ACC.user) { people = []; return people; }
  if (!force && Date.now() - peopleAt < 15_000) return people;
  try { const r = await synapse.people.list(); people = Array.isArray(r) ? r : r?.trusted || []; peopleAt = Date.now(); } catch {}
  return people;
}
function renderShareBar() {
  const a = openAgent(), b = $('#btn-share'), n = offersIn().length + pendingTrust().length, c = $('#friends-count');
  b.classList.toggle('off', !a);
  b.title = a ? `share ${a.name} with a friend` : 'open an agent to share it with a friend';
  c.hidden = !n; c.textContent = n ? String(n) : '';
}

// "Mara shares api-auth with you": it goes into the agent of mine picked here. In the friends list and the circle.
function offerRow(r, done) {
  const box = el('div', 'req offer-in');
  const who = el('div', 'req-who');
  who.append(avatar(r.from), el('b', '', personName(r.from)));
  if (r.from?.handle && r.from?.name) who.append(el('span', 'h', `@${r.from.handle}`));
  const what = el('div', 'req-what');
  what.append('shares ', el('span', 'ag', `${r.agent?.kind || 'agent'} · ${r.agent?.name || '?'}`), ` with you, ${r.mode === 'talk' ? 'read and ask' : 'read only'}`);
  box.append(who, what, el('div', 'req-note', 'Pick which of your agents gets it: that one can read it' + (r.mode === 'talk' ? ' and ask it questions.' : '.')));
  const pick = el('select', 'req-pick');
  pick.setAttribute('aria-label', 'which of your agents gets it');
  if (!ACC.agents.length) { const o = el('option', '', 'start an agent to receive it'); o.value = ''; pick.append(o); pick.disabled = true; }
  else for (const a of ACC.agents) { const o = el('option', '', `${a.kind} · ${a.name}${a.project ? `  (${a.project})` : ''}`); o.value = a.id; pick.append(o); }
  const open = openAgent(); // the agent on screen is the likely one to receive it
  pick.value = ACC.choice[r.id] || (open && ACC.agents.some((a) => a.id === open.id) ? open.id : pick.value);
  pick.onchange = () => { ACC.choice[r.id] = pick.value; };
  const row = el('div', 'req-row'), no = el('button', 'btn', 'Not now'), yes = el('button', 'btn sig', 'Accept');
  yes.disabled = !ACC.agents.length;
  no.onclick = async () => { no.disabled = yes.disabled = true; try { await synapse.requests.deny(r.id); toast(`declined ${personName(r.from)}'s ${r.agent?.name || 'agent'}`); done?.(); } catch (e) { toast(e.message, true); no.disabled = yes.disabled = false; } };
  yes.onclick = async () => {
    no.disabled = yes.disabled = true;
    try { await synapse.requests.acceptOffer(r.id, pick.value); toast(`${personName(r.from)}'s ${r.agent?.name || 'agent'} now shares with your ${ACC.agents.find((a) => a.id === pick.value)?.name || 'agent'}`); done?.(); }
    catch (e) { toast(e.message, true); no.disabled = yes.disabled = false; }
  };
  row.append(pick, no, yes);
  box.append(row);
  return box;
}

async function openFriends() {
  const pop = $('#friends-pop');
  pop.hidden = false;
  renderFriends();
  const r = $('#btn-friends').getBoundingClientRect(), w = pop.offsetWidth || 380;
  pop.style.top = `${Math.round(r.bottom + 6)}px`;
  pop.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, r.right - w)))}px`;
  await Promise.all([loadPeople(true), synapse.requests.agents().then((a) => { ACC.agents = a; }).catch(() => {})]);
  if (!pop.hidden) renderFriends();
}
const closeFriends = () => { $('#friends-pop').hidden = true; };
$('#btn-friends').onclick = (e) => { e.stopPropagation(); if ($('#friends-pop').hidden) openFriends(); else closeFriends(); };
$('#btn-share').onclick = () => openShare();
addEventListener('mousedown', (e) => { if (!$('#friends-pop').hidden && !e.target.closest('#friends-pop, #btn-friends')) closeFriends(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#friends-pop').hidden) closeFriends(); });

function renderFriends() {
  const pop = $('#friends-pop');
  pop.replaceChildren();
  if (!ACC.user) {
    pop.append(el('div', 'pop-sec', 'friends'), el('div', 'friends-empty', 'Sign in to share agents with people you trust, and see what they share with you.'));
    const b = el('button', 'btn sig friends-cta', 'sign in');
    b.onclick = () => { closeFriends(); showLogin(); };
    pop.append(b);
    return;
  }
  const offers = offersIn(), trusts = pendingTrust();
  if (offers.length) { pop.append(el('div', 'pop-sec', `shared with you · ${offers.length}`)); for (const r of offers) pop.append(offerRow(r, renderFriends)); }
  if (trusts.length) { pop.append(el('div', 'pop-sec', `added you · ${trusts.length}`)); for (const p of trusts) pop.append(trustRow(p, () => { loadPeople(true).then(renderFriends); })); }
  pop.append(el('div', 'pop-sec', `trusted people · ${people.length}`));
  if (!people.length) pop.append(el('div', 'friends-empty', 'Nobody yet. Add someone by email or @handle; once they add you back, you can share agents with each other.'));
  const open = openAgent();
  for (const p of people) {
    const links = linksOf(p), out = links.filter((l) => l.direction === 'out'), inn = links.filter((l) => l.direction === 'in');
    const row = el('div', 'friend'), head = el('div', 'friend-head');
    head.append(avatar(p), el('b', '', p.name || p.handle || p.email || '?'), el('span', 'h', p.handle ? `@${p.handle}` : ''));
    const share = el('button', 'btn', 'share');
    share.disabled = !p.trustsYou || !!p.pending;
    share.title = p.pending ? 'they have not joined Synapse yet' : !p.trustsYou ? 'they have not added you back yet' : open ? `offer ${open.name} to ${p.name || p.handle}` : 'pick which agent to share';
    share.onclick = () => { closeFriends(); openShare(p); };
    head.append(share);
    const meta = el('div', 'friend-meta', p.pending ? 'invited, not on Synapse yet' : !p.trustsYou ? 'has not added you back yet' : out.length || inn.length ? `sees ${out.length} of your agents · you see ${inn.length} of theirs` : 'nothing shared yet');
    row.append(head, meta);
    for (const l of out) row.append(el('div', 'friend-flow', `your ${l.local?.name || 'agent'} → their ${l.agent?.name || 'agent'} · ${l.mode === 'talk' ? 'read and ask' : 'read only'}`));
    for (const l of inn) row.append(el('div', 'friend-flow in', `their ${l.agent?.name || 'agent'} → your ${l.local?.name || 'agent'} · ${l.mode === 'talk' ? 'read and ask' : 'read only'}`));
    for (const o of offersOut(p)) row.append(el('div', 'friend-flow wait', `offered ${o.agent?.name || 'an agent'} · waiting for them to accept`));
    pop.append(row);
  }
  const add = el('div', 'people-add'), inp = el('input'), go = el('button', 'btn', 'add');
  inp.placeholder = 'add someone: email or @handle'; inp.spellcheck = false;
  const submit = async () => {
    const who = inp.value.trim(); if (!who) return;
    go.disabled = true;
    try { await synapse.people.add(who); inp.value = ''; toast(`${who} is trusted · they can add you back`); await loadPeople(true); renderFriends(); }
    catch (e) { toast(e.message, true); go.disabled = false; }
  };
  go.onclick = submit;
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.stopPropagation(); submit(); } };
  add.append(inp, go);
  const more = el('button', 'friends-link', 'manage in settings');
  more.onclick = () => { closeFriends(); openSettings(); };
  pop.append(add, more);
}

// Share the open agent: pick a friend who trusts you back and how (read only or read and ask), then offer it.
async function openShare(preset) {
  if (!ACC.user) return showLogin();
  const a = openAgent();
  if (!a) return toast('open the agent you want to share first', true);
  await loadPeople(true);
  const ok = people.filter((p) => p.trustsYou && !p.pending && p.handle);
  let pick = ok.find((p) => p.handle === preset?.handle)?.handle || ok[0]?.handle, mode = 'talk';
  modal(`share ${a.name}`, (body, close) => {
    if (!ok.length) {
      body.append(el('div', 'share-empty', people.length ? 'None of your trusted people has added you back yet. Once they do, you can share with them.' : 'Add someone you trust first: friends, at the top right.'));
      const row = el('div', 'row'), b = el('button', 'btn sig', 'open friends');
      b.onclick = () => { close(); openFriends(); };
      row.append(b); body.append(row);
      return;
    }
    body.append(el('div', 'hint', 'with'));
    const list = el('div', 'share-people');
    const draw = () => list.replaceChildren(...ok.map((p) => {
      const r = el('button', `share-person${p.handle === pick ? ' on' : ''}`), already = linksOf(p).find((l) => l.direction === 'out' && l.local?.id === a.id);
      r.append(avatar(p), el('b', '', p.name || p.handle), el('span', 'h', `@${p.handle}`), el('span', 'note', already ? `sees it · ${already.mode === 'talk' ? 'read and ask' : 'read only'}` : offersOut(p).some((o) => o.agent?.id === a.id) ? 'offered · waiting' : ''));
      r.onclick = () => { pick = p.handle; draw(); };
      return r;
    }));
    draw();
    const seg = el('div', 'seg'), explain = el('div', 'hint share-explain');
    const say = () => { explain.textContent = mode === 'talk' ? 'Their agent can read this one and ask it questions; a copy with no tools answers. Nobody can type into your agent.' : 'Their agent can read what this one is doing. Nothing else.'; };
    for (const [v, label] of [['sync', 'read only'], ['talk', 'read and ask']]) {
      const b = el('button', v === mode ? 'on' : '', label);
      b.onclick = () => { mode = v; [...seg.children].forEach((x) => x.classList.toggle('on', x === b)); say(); };
      seg.appendChild(b);
    }
    say();
    const row = el('div', 'row'), cancel = el('button', 'btn', 'cancel'), go = el('button', 'btn sig', 'share');
    cancel.onclick = close;
    go.onclick = async () => {
      go.disabled = true;
      const p = ok.find((x) => x.handle === pick);
      try { await synapse.requests.offer(pick, a.id, mode); toast(`offered ${a.name} to ${p?.name || pick} · they pick which of their agents gets it`); close(); }
      catch (e) { toast(e.message, true); go.disabled = false; }
    };
    row.append(cancel, go);
    body.append(list, el('div', 'hint', 'how'), seg, explain, el('div', 'hint share-note', 'They pick which of their agents receives it. Change or stop it any time under friends or Settings.'), row);
    body.tabIndex = 0; body.onkeydown = (e) => { if (e.key === 'Escape') close(); };
  });
  $('#modal-body').focus();
}

function renderPop() {
  const pop = $('#syn-pop'), dot = $('#syn-dot');
  pop.replaceChildren();
  const reqs = pendingRequests(), links = ACC.feed.links || [], trusts = pendingTrust(), asks = pendingTalk();
  if (trusts.length) {
    pop.append(el('div', 'pop-sec', `added you · ${trusts.length}`));
    for (const p of trusts) pop.append(trustRow(p));
  }
  if (asks.length) {
    pop.append(el('div', 'pop-sec', `wants to ask · ${asks.length}`));
    for (const r of asks) pop.append(talkRequestRow(r));
  }
  if (reqs.length) {
    pop.append(el('div', 'pop-sec', `requests · ${reqs.length}`));
    for (const r of reqs) {
      if (r.kind === 'offer') { pop.append(offerRow(r)); continue; }
      const box = el('div', 'req');
      const who = el('div', 'req-who');
      who.append(avatar(r.from), el('b', '', personName(r.from)));
      if (r.from?.handle && r.from?.name) who.append(el('span', 'h', `@${r.from.handle}`));
      const what = el('div', 'req-what');
      what.append('wants your context for ', el('span', 'ag', `${r.agent?.kind || 'agent'} · ${r.agent?.name || '?'}`));
      if (r.agent?.project) what.append(` in ${r.agent.project}`);
      box.append(who, what);
      if (r.target || r.note) box.append(el('div', 'req-note', [r.target && `asks for: ${r.target}`, r.note].filter(Boolean).join(' · ')));
      const pick = el('select', 'req-pick');
      pick.setAttribute('aria-label', 'which of your agents to share');
      if (!ACC.agents.length) { const o = el('option', '', 'no live agents on this Mac'); o.value = ''; pick.append(o); pick.disabled = true; }
      else {
        for (const a of ACC.agents) { const o = el('option', '', `${a.kind} · ${a.name}${a.project ? `  (${a.project})` : ''}`); o.value = a.id; pick.append(o); }
        if (ACC.agents.length > 1) { const o = el('option', '', 'all live agents'); o.value = '*'; pick.append(o); }
        pick.value = ACC.choice[r.id] || bestAgent(r);
      }
      pick.onchange = () => { ACC.choice[r.id] = pick.value; };
      // ticked by default: their agent may ask the shared agent questions, not only read it
      const talkBox = el('label', 'req-talk'), tick = el('input');
      tick.type = 'checkbox';
      tick.checked = ACC.talk[r.id] ?? true;
      tick.onchange = () => { ACC.talk[r.id] = tick.checked; };
      talkBox.append(tick, el('span', '', 'Let their agent ask questions too'));
      box.append(talkBox);
      const row = el('div', 'req-row');
      const no = el('button', 'btn', 'Deny'), yes = el('button', 'btn sig', 'Accept');
      yes.disabled = !ACC.agents.length;
      no.onclick = async () => {
        no.disabled = yes.disabled = true;
        try { await synapse.requests.deny(r.id); toast(`denied ${personName(r.from)}`); } catch (e) { toast(e.message, true); no.disabled = yes.disabled = false; }
      };
      yes.onclick = async () => {
        const ids = pick.value === '*' ? ACC.agents.map((a) => a.id) : [pick.value];
        no.disabled = yes.disabled = true;
        try { await synapse.requests.accept(r.id, ids, tick.checked); toast(`synapsed with ${personName(r.from)}`); } catch (e) { toast(e.message, true); no.disabled = yes.disabled = false; }
      };
      row.append(pick, no, yes);
      box.append(row);
      pop.append(box);
    }
  }
  // agent talk: a friend's agent asking mine, or mine asking theirs; a click opens the thread
  const talks = M.talks || [];
  if (talks.length) {
    pop.append(el('div', 'pop-sec', `talking · ${talks.length}`));
    const g = el('div', 'link-group');
    for (const c of talks) {
      const row = el('div', 'link talk-link'), owner = c.role === 'owner';
      const who = el('span', 'ag', peerHandle(c)), theirs = el('span', 'mine', owner ? c.askerName || 'agent' : c.targetName || 'agent'), mine = el('span', 'mine', `your ${owner ? c.targetName || 'agent' : c.askerName || 'agent'}`);
      if (owner) row.append(who, theirs, el('span', 'arr', 'asks'), mine);
      else row.append(mine, el('span', 'arr', 'asks'), who, theirs);
      if (TALK_LIVE[c.live]) row.append(el('span', 'badge', TALK_LIVE[c.live]));
      row.title = owner ? `${c.peerName || peerHandle(c)}'s ${c.askerName || 'agent'} asks your ${c.targetName || 'agent'} questions` : `your ${c.askerName || 'agent'} asks ${c.peerName || peerHandle(c)}'s ${c.targetName || 'agent'} questions`;
      row.onclick = () => openTalk(c.id);
      g.append(row);
    }
    pop.append(g);
  }
  pop.append(el('div', 'pop-sec', `synapsed · ${links.length}`));
  if (!links.length) pop.append(el('div', 'pop-empty', 'no external agents yet'));
  const byOwner = new Map();
  for (const l of links) { const k = l.owner || 'friend'; if (!byOwner.has(k)) byOwner.set(k, []); byOwner.get(k).push(l); }
  for (const [owner, list] of byOwner) {
    const g = el('div', 'link-group');
    g.append(el('div', 'link-owner', owner));
    for (const l of list) {
      const row = el('div', 'link');
      const theirs = el('span', 'ag', `${l.agent?.name || '?'}`), mine = el('span', 'mine', l.local?.name || 'you');
      // in: their agent shares with mine; out: mine shares with theirs
      if (l.direction === 'in') row.append(theirs, el('span', 'arr', '→'), mine);
      else row.append(mine, el('span', 'arr', '→'), theirs);
      row.title = l.direction === 'in' ? `${owner}'s ${l.agent?.name} shares its context with your ${l.local?.name}` : `your ${l.local?.name} shares its context with ${owner}'s ${l.agent?.name}`;
      g.append(row);
    }
    pop.append(g);
  }
  // under the dot, kept inside the window
  const r = dot.getBoundingClientRect(), w = pop.offsetWidth || 360;
  pop.style.top = `${Math.round(r.bottom + 14)}px`;
  pop.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w + 40)))}px`;
}

{
  const dot = $('#syn-dot'), pop = $('#syn-pop');
  dot.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); ACC.sticky && !pop.hidden ? closePop() : openPop(true); });
  dot.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openPop(true); } });
  dot.addEventListener('mouseenter', () => openPop(false));
  dot.addEventListener('mouseleave', closePopSoon);
  pop.addEventListener('mouseenter', () => clearTimeout(popTimer));
  pop.addEventListener('mouseleave', closePopSoon);
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== dot) closePop(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) closePop(); });
}

// ---- sign in

let loginState = { mode: 'signin', startup: false, device: null };
// ---------------------------------------------------------------- onboarding
// Five short steps the first time the app opens: what Synapse is, starting agents, linking them, friends and the
// phone, and the activity tab. Settings replays it. The art is the app's own pieces (agent chips, links, keys).
const chip = (kind, name) => { const c = el('span', 'ob-chip'); c.append(el('b', '', kind), el('span', '', name)); return c; };
const wire = (label = '') => el('span', 'ob-wire', label);
const TOUR = [
  { title: 'Your agents, connected', body: 'Synapse runs Claude, Codex, Gemini and the rest side by side, and lets them read each other and pass messages. Here is how, in five quick steps.',
    art: () => [chip('claude', 'api'), wire(), chip('codex', 'web'), wire(), chip('gemini', 'tests')] },
  { title: 'Start an agent', body: 'Add a workspace (a folder or a repo), then start agents in it. Each gets its own terminal tab, and you can split them side by side.',
    keys: [['⌃1', 'Claude'], ['⌃2', 'Codex'], ['⌘N', 'any agent'], ['⌘T', 'shell'], ['⇧⌘N', 'new worktree'], ['⌘D', 'split']] },
  { title: 'Link them', body: "The node view shows every agent on this Mac. Drag from one agent's ring to another to share its context; linked agents can message each other. Fork an agent to ask a side question without derailing it.",
    art: () => [chip('claude', 'api'), wire('reads'), chip('codex', 'web')], keys: [['⌃Tab', 'node view'], ['drag ring', 'link'], ['⇧⌘F', 'fork']] },
  { title: 'Friends and your phone', body: 'Sign in to share an agent with people you trust, read only or read and ask. The Synapse phone app sees your agents, chats with them, and opens the sites and files they make.',
    art: () => [chip('you', 'api'), wire('read and ask'), chip('mara', 'web'), el('span', 'ob-gap'), chip('phone', 'live link')] },
  { title: 'Keep score', body: 'The activity tab tracks your streak, prompts, tokens and badges, and ranks you against friends who join the board. You can replay this tour any time from Settings.',
    keys: [['▦', 'activity'], ['⌘,', 'settings']] },
];
let tour = { step: 0, first: false };
function showOnboarding(first = false) {
  tour = { step: 0, first };
  $('#onboard').hidden = false;
  drawOnboarding();
  $('#onboard').focus();
}
function endOnboarding(signIn = false) {
  $('#onboard').hidden = true;
  synapse.onboarding.done().catch(() => {});
  if (signIn) showLogin({ startup: tour.first });
  else if (tour.first && !ACC.user) synapse.account.skip().catch(() => {}); // chose not now: the sign-in screen does not come back each launch
  else top(focusedSlot())?.term.focus();
}
function drawOnboarding() {
  const card = $('#onboard-card'), s = TOUR[tour.step], last = tour.step === TOUR.length - 1;
  card.replaceChildren();
  const head = el('div', 'login-head ob-head');
  head.append(el('div', 'wordmark', 'synapse'), el('div', 'login-tag', `${tour.step + 1} of ${TOUR.length}`));
  const skip = el('button', 'login-x', '×'); skip.title = 'skip the tour'; skip.onclick = () => endOnboarding(false); head.append(skip);
  const body = el('div', 'ob-body');
  body.append(el('div', 'ob-title', s.title), el('p', 'ob-text', s.body));
  if (s.art) { const art = el('div', 'ob-art'); art.append(...s.art()); body.appendChild(art); }
  if (s.keys) { const keys = el('div', 'ob-keys'); for (const [k, what] of s.keys) { const r = el('span'); r.append(el('kbd', '', k), what); keys.appendChild(r); } body.appendChild(keys); }
  const foot = el('div', 'ob-foot'), dots = el('div', 'ob-dots');
  TOUR.forEach((_, i) => { const d = el('button', i === tour.step ? 'on' : ''); d.title = `step ${i + 1}`; d.onclick = () => { tour.step = i; drawOnboarding(); }; dots.appendChild(d); });
  const back = el('button', 'btn', 'back'); back.disabled = tour.step === 0; back.onclick = () => { tour.step--; drawOnboarding(); };
  const next = el('button', 'btn sig', last ? (ACC.user ? 'start' : 'sign in') : 'next');
  next.onclick = () => (last ? endOnboarding(!ACC.user) : (tour.step++, drawOnboarding()));
  const actions = el('div', 'ob-actions');
  actions.append(back);
  if (last && !ACC.user) { const later = el('button', 'btn', 'not now'); later.onclick = () => endOnboarding(false); actions.append(later); }
  actions.append(next);
  foot.append(dots, actions);
  card.append(head, body, foot);
  next.focus();
}
$('#onboard').onkeydown = (e) => {
  if (e.key === 'Escape') endOnboarding(false);
  else if (e.key === 'ArrowRight' && tour.step < TOUR.length - 1) { tour.step++; drawOnboarding(); }
  else if (e.key === 'ArrowLeft' && tour.step > 0) { tour.step--; drawOnboarding(); }
};

async function showLogin({ startup = false, mode = 'signin' } = {}) {
  loginState = { mode, startup, device: null };
  $('#login').hidden = false;
  drawLogin();
  let prov = null;
  try { prov = await synapse.account.providers(); } catch {}
  loginState.providers = prov;
  if (!$('#login').hidden && !loginState.device) drawLogin();
}
function hideLogin() { if (loginState.device) synapse.account.cancelDevice().catch(() => {}); loginState.device = null; $('#login').hidden = true; top(focusedSlot())?.term.focus(); }

function drawLogin() {
  const card = $('#login-card'), st = loginState;
  card.replaceChildren();
  const head = el('div', 'login-head');
  head.append(el('div', 'wordmark', 'synapse'), el('div', 'login-tag', 'share agents with people you trust'));
  if (!st.startup) { const x = el('button', 'login-x', '×'); x.title = 'close'; x.onclick = hideLogin; head.append(x); }
  card.append(head);
  if (st.device) {
    const d = el('div', 'device');
    d.append(el('div', 'device-k', `finish signing in with ${st.device.provider} in your browser`), el('div', 'device-code', st.device.userCode || '...'), el('div', 'device-k wait', 'waiting for the browser'));
    const row = el('div', 'row');
    const again = el('button', 'btn', 'open browser again'); again.onclick = () => synapse.account.device(st.device.provider).then((r) => { st.device.userCode = r.userCode; drawLogin(); }).catch((e) => { st.device = null; drawLogin(); $('#login-card .login-err').textContent = e.message; });
    const cancel = el('button', 'btn', 'cancel'); cancel.onclick = () => { synapse.account.cancelDevice().catch(() => {}); st.device = null; drawLogin(); };
    row.append(again, cancel);
    card.append(d, row);
    return;
  }
  const seg = el('div', 'seg');
  for (const [m, label] of [['signin', 'sign in'], ['signup', 'create account']]) {
    const b = el('button', st.mode === m ? 'on' : '', label);
    b.onclick = () => { st.mode = m; drawLogin(); };
    seg.append(b);
  }
  card.append(seg);
  const form = el('form', 'login-form');
  const field = (type, name, placeholder, auto) => { const i = el('input'); i.type = type; i.name = name; i.placeholder = placeholder; i.autocomplete = auto; i.spellcheck = false; form.append(i); return i; };
  const name = st.mode === 'signup' ? field('text', 'name', 'your name', 'name') : null;
  const email = field('email', 'email', 'email', 'email');
  const pass = field('password', 'password', st.mode === 'signup' ? 'password (8+ characters)' : 'password', st.mode === 'signup' ? 'new-password' : 'current-password');
  const err = el('div', 'hint err login-err');
  const go = el('button', 'btn sig login-go', st.mode === 'signup' ? 'create account' : 'sign in');
  go.type = 'submit';
  form.append(err, go);
  const setErr = (t, ok = false) => { err.textContent = t || ''; err.classList.toggle('ok', ok); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!email.value.trim() || !pass.value) return setErr('enter your email and password');
    go.disabled = true; setErr('');
    try {
      const b = { email: email.value.trim(), password: pass.value };
      const u = st.mode === 'signup' ? await synapse.account.signup({ ...b, name: name.value.trim() }) : await synapse.account.login(b);
      ACC.user = unwrapUser(u) || ACC.user; renderMe(); hideLogin();
      toast(st.mode === 'signup' ? 'account created · check your email to verify it' : `signed in as ${personName(ACC.user)}`);
    } catch (e2) { setErr(e2.message); go.disabled = false; }
  };
  card.append(form);
  if (st.mode === 'signin') {
    const forgot = el('button', 'login-link', 'forgot password?');
    forgot.onclick = async () => {
      if (loginState.providers?.mail === false) { setErr('password reset by email is not switched on yet'); return; }
      if (!email.value.trim()) { setErr('enter your email first, then press forgot password'); email.focus(); return; }
      try { await synapse.account.forgot(email.value.trim()); setErr('if that email has an account, a reset link is on its way', true); } catch (e) { setErr(e.message); }
    };
    card.append(forgot);
  }
  const prov = st.providers;
  const list = [['github', 'GitHub'], ['google', 'Google'], ['x', 'X']].filter(([k]) => !prov || prov[k]);
  if (list.length) {
    card.append(el('div', 'login-or', 'or continue with'));
    const row = el('div', 'login-prov');
    for (const [k, label] of list) {
      const b = el('button', 'btn', label);
      b.onclick = async () => {
        b.disabled = true;
        try { const r = await synapse.account.device(k); st.device = { provider: label, userCode: r.userCode }; drawLogin(); }
        catch (e) { b.disabled = false; setErr(e.message); }
      };
      row.append(b);
    }
    card.append(row);
  }
  if (st.startup) {
    const skip = el('button', 'login-link skip', 'continue without an account');
    skip.onclick = async () => { await synapse.account.skip().catch(() => {}); hideLogin(); };
    card.append(skip);
  }
  (name || email).focus();
}
synapse.account.onDevice((d) => {
  if (!loginState.device) return;
  if (d.status === 'approved') { loginState.device = null; hideLogin(); return; }
  loginState.device = null;
  drawLogin();
  const err = $('#login-card .login-err');
  if (err) err.textContent = d.status === 'expired' ? 'the sign-in link expired, try again' : d.error || 'sign-in failed';
});
synapse.account.onChange((u) => {
  const was = ACC.user;
  ACC.user = u; renderMe();
  if (u && !$('#login').hidden) { hideLogin(); if (!was) toast(`signed in as ${personName(u)}`); }
});
synapse.requests.onChange((f) => { ACC.feed = f || ACC.feed; renderDot(); renderShareBar(); if (!$('#friends-pop').hidden) renderFriends(); });
synapse.requests.onOpen(() => openPop(true));

// ---- updates: the packaged app fetches new versions itself (updater.mjs); this only shows where it is
let UPD = {};
function renderUpdate(u) {
  UPD = u || UPD;
  const b = $('#btn-update');
  const v = UPD.version ? ` ${UPD.version}` : '';
  b.hidden = !['downloading', 'ready', 'manual', 'installing'].includes(UPD.state);
  b.disabled = UPD.state === 'downloading' || UPD.state === 'installing';
  b.textContent = UPD.state === 'ready' ? `↻ restart to update${v}`
    : UPD.state === 'manual' ? `update${v} ›`
    : UPD.state === 'installing' ? 'updating…'
    : `downloading${v} ${Math.round((UPD.progress || 0) * 100)}%`;
  b.title = UPD.state === 'manual' ? 'This copy of Synapse cannot replace itself here. Download the new version and drag it into Applications.'
    : UPD.state === 'ready' ? `Synapse${v} is ready. It also installs the next time you quit.${UPD.notes ? '\n\n' + UPD.notes : ''}` : '';
}
$('#btn-update').onclick = async () => {
  try {
    if (UPD.state === 'ready') await synapse.update.install();
    else if (UPD.state === 'manual') await synapse.update.download();
  } catch (e) { toast(e.message, true); }
};
synapse.update.onChange(renderUpdate);
synapse.update.get().then(renderUpdate, () => {});

// ---- account (profile)

async function openAccount() {
  let u = ACC.user;
  try { u = unwrapUser(await synapse.account.me()) || u; ACC.user = u; renderMe(); } catch {}
  if (!u) return showLogin();
  modal('account', (body, close) => {
    const head = el('div', 'acct-head');
    const info = el('div', 'acct-info');
    info.append(el('div', 'acct-name', personName(u)), el('div', 'acct-sub', [u.handle && `@${u.handle}`, u.email].filter(Boolean).join(' · ')));
    const badge = el('span', u.emailVerified ? 'badge ok' : 'badge', u.emailVerified ? 'verified' : 'not verified');
    if (u.email) info.querySelector('.acct-sub').append(' ', badge);
    head.append(avatar(u, 'av big'), info);
    body.append(head);
    if (u.email && !u.emailVerified) {
      const row = el('div', 'opt set'), b = el('button', 'btn', 'resend');
      row.append(el('span', 'k', 'verify email'), el('span', 'c', `we sent a link to ${u.email}`), b);
      b.onclick = async () => { b.disabled = true; try { await synapse.account.resend(); toast('verification email sent'); } catch (e) { toast(e.message, true); b.disabled = false; } };
      body.append(row);
    }
    body.append(el('div', 'sub', 'profile'));
    const field = (label, value, placeholder) => { const r = el('label', 'field'); const i = el('input'); i.value = value || ''; i.placeholder = placeholder; i.spellcheck = false; r.append(el('span', 'fk', label), i); body.append(r); return i; };
    const nm = field('name', u.name, 'your name'), hd = field('handle', u.handle, 'handle'), av = field('avatar', u.avatar, 'https://… image url');
    const perr = el('div', 'hint err');
    const prow = el('div', 'row'), save = el('button', 'btn sig', 'save profile');
    save.onclick = async () => {
      save.disabled = true; perr.textContent = '';
      try { const r = await synapse.account.update({ name: nm.value.trim(), handle: hd.value.trim().replace(/^@/, ''), avatar: av.value.trim() }); ACC.user = unwrapUser(r) || ACC.user; renderMe(); toast('profile saved'); close(); }
      catch (e) { perr.textContent = e.message; save.disabled = false; }
    };
    prow.append(save);
    body.append(perr, prow);
    body.append(el('div', 'sub', u.hasPassword === false ? 'set a password' : 'password'));
    const cur = u.hasPassword === false ? null : field('current', '', 'current password');
    if (cur) cur.type = 'password';
    const np = field('new', '', 'new password (8+ characters)'); np.type = 'password';
    const werr = el('div', 'hint err'), wrow = el('div', 'row'), change = el('button', 'btn', 'change password');
    change.onclick = async () => {
      if (np.value.length < 8) { werr.textContent = 'use at least 8 characters'; return; }
      change.disabled = true; werr.textContent = '';
      try { await synapse.account.password({ current: cur?.value || undefined, password: np.value }); toast('password changed'); if (cur) cur.value = ''; np.value = ''; change.disabled = false; }
      catch (e) { werr.textContent = e.message; change.disabled = false; }
    };
    wrow.append(change);
    body.append(werr, wrow);
    const foot = el('div', 'row');
    const web = el('button', 'btn', 'account settings on the web'), out = el('button', 'btn danger', 'sign out');
    web.onclick = () => synapse.account.openWeb('/settings').catch((e) => toast(e.message, true));
    out.onclick = async () => { try { await synapse.account.logout(); ACC.user = null; ACC.feed = { incoming: [], outgoing: [], links: [], incomingTrust: [] }; renderMe(); renderDot(); close(); toast('signed out'); } catch (e) { toast(e.message, true); } };
    foot.append(web, out);
    body.append(foot);
    body.tabIndex = 0; body.onkeydown = (e) => { if (e.key === 'Escape') close(); };
  });
}

// ---- phone (in settings): the Synapse phone app, signed in to the same account, asks once to use this Mac

let phoneBox = null, phoneDraws = 0;
async function drawPhones(box) {
  phoneBox = box;
  const draw = ++phoneDraws;
  let info = { signedIn: false, list: [] }, failed = null;
  try { info = await synapse.phone.devices(); } catch (e) { failed = e; }
  if (draw !== phoneDraws) return; // a newer draw is on its way
  box.replaceChildren();
  if (failed) box.append(el('div', 'hint err', failed.message));
  if (!info.signedIn) {
    const row = el('div', 'opt set'), b = el('button', 'btn', 'sign in');
    row.append(el('span', 'k', 'not signed in'), el('span', 'c', 'sign in here and in the Synapse phone app with the same account to see, start and message your agents from your phone'), b);
    b.onclick = () => { $('#modal').hidden = true; showLogin(); };
    return box.append(row);
  }
  for (const d of info.list) {
    const row = el('div', 'person');
    const when = d.state === 'asking' ? 'wants to use this Mac'
      : `allowed ${new Date(d.at).toLocaleDateString()} · ${d.seen ? `seen ${new Date(d.seen).toLocaleString()}` : 'not seen yet'}`;
    row.append(el('span', 'k', d.name), el('span', 'c', when));
    if (d.state === 'asking') {
      const yes = el('button', 'btn', 'allow'), no = el('button', 'btn', 'deny');
      yes.onclick = async () => { try { await synapse.phone.allow(d.id); await drawPhones(box); toast(`${d.name} can use this Mac now`); } catch (e) { toast(e.message, true); } };
      no.onclick = async () => { try { await synapse.phone.remove(d.id); await drawPhones(box); toast(`${d.name} was turned away and signed out`); } catch (e) { toast(e.message, true); } };
      row.append(yes, no);
    } else {
      const x = el('button', 'tab-close', '×');
      x.title = `remove ${d.name}: it is signed out and has to ask again`;
      x.onclick = async () => { try { await synapse.phone.remove(d.id); await drawPhones(box); toast(`${d.name} removed`); } catch (e) { toast(e.message, true); } };
      row.append(x);
    }
    box.append(row);
  }
  if (!info.list.length) box.append(el('div', 'hint', `sign in to the Synapse phone app as ${ACC.user?.email || 'this account'}: the phone shows up here to be allowed`));
  // links the phone opened: public for a while through Cloudflare, so they are listed here too and can be stopped
  const live = await synapse.phone.shares().catch(() => []);
  for (const sh of live.filter((x) => x.state !== 'error')) {
    const row = el('div', 'opt set'), stop = el('button', 'btn', 'stop');
    const left = Math.max(0, Math.ceil((sh.expires - Date.now()) / 60000));
    row.append(el('span', 'k', sh.label), el('span', 'c', sh.state === 'live' ? `open to your phone · ${left} min left · anyone with the link can see it` : 'starting…'), stop);
    stop.onclick = async () => { try { await synapse.phone.unshare(sh.id); } catch (e) { toast(e.message, true); } drawPhones(box); };
    box.append(row);
  }
}
let liveShareIds = new Set();
synapse.phone.onChanged(({ asking, shares }) => {
  if (asking) toast(`${asking} wants to use this Mac · allow it in settings`);
  if (shares) {
    for (const sh of shares) if (sh.state === 'live' && !liveShareIds.has(sh.id)) toast(`${sh.label} is open to your phone for ${Math.round((sh.expires - Date.now()) / 60000)} min · stop it in settings`);
    liveShareIds = new Set(shares.filter((x) => x.state === 'live').map((x) => x.id));
  }
  if (phoneBox?.isConnected) drawPhones(phoneBox);
});
synapse.phone.onShow(() => openSettings());
// the phone asked for a new agent: open it like ⌃1 would, in the workspace it picked
synapse.phone.onSpawn(({ req, cwd, kind }) => {
  const wt = worktreeOf(cwd);
  if (wt) M.open.add(wt.project.key);
  newSlot(cwd, kind, null, req);
});

// ---- trusted people (in settings)

async function drawPeople(box) {
  box.replaceChildren();
  if (!ACC.user) {
    const row = el('div', 'opt set'), b = el('button', 'btn', 'sign in');
    row.append(el('span', 'k', 'not signed in'), el('span', 'c', 'sign in to add trusted people: they can ask your agents for context, and you decide on each request'), b);
    b.onclick = () => { $('#modal').hidden = true; showLogin(); };
    box.append(row);
    return;
  }
  const add = el('div', 'people-add'), inp = el('input'), go = el('button', 'btn', 'add');
  inp.placeholder = 'email or @handle'; inp.spellcheck = false;
  const err = el('div', 'hint err');
  const submit = async () => {
    const who = inp.value.trim(); if (!who) return;
    go.disabled = true; err.textContent = '';
    try { await synapse.people.add(who); inp.value = ''; await drawPeople(box); toast(`${who} is trusted`); }
    catch (e) { err.textContent = e.message; go.disabled = false; }
  };
  go.onclick = submit;
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.stopPropagation(); submit(); } };
  add.append(inp, go);
  let list = [];
  try { const r = await synapse.people.list(); list = Array.isArray(r) ? r : r?.trusted || []; }
  catch (e) { box.append(el('div', 'hint err', e.message)); }
  // people who added me and wait for an answer, on top with the same buttons as the popover
  for (const p of pendingTrust()) box.append(trustRow(p, () => drawPeople(box)));
  if (!list.length) box.append(el('div', 'hint', 'nobody yet · your agents can only ask people on this list'));
  if (list.length) box.append(el('div', 'hint access-key', 'read only: their agent reads yours · read and ask: it can also put questions to yours, answered by a copy with no tools · nobody can type instructions into your agents'));
  for (const p of list) {
    const card = el('div', 'person-card'), row = el('div', 'person');
    const meta = el('span', 'c', p.handle ? `@${p.handle}` : p.email && p.name && p.name !== p.email ? p.email : '');
    row.append(avatar(p), el('span', 'k', p.name || p.handle || p.email || '?'), meta);
    if (p.pending) row.append(el('span', 'badge', 'invited'));
    if (p.trustsYou) row.append(el('span', 'badge ok', 'trusts you'));
    const x = el('button', 'tab-close', '×');
    x.title = `remove ${p.name || p.email || p.handle} · ends every share with them`;
    x.onclick = async () => { try { await synapse.people.remove(p.id); await drawPeople(box); } catch (e) { toast(e.message, true); } };
    row.append(x);
    card.append(row, accessOf(p, () => drawPeople(box)));
    box.append(card);
  }
  box.append(add, err);
}

// What a trusted person can reach, the same words as the phone: each of my agents they see, read only or read and
// ask (switchable, or stopped here), and each of theirs I see, which only they can change.
const linksOf = (p) => (ACC.feed.links || []).filter((l) => (p.handle && l.handle === p.handle) || (!l.handle && l.owner && l.owner === p.name));
function accessOf(p, redraw) {
  const box = el('div', 'access'), links = linksOf(p);
  const mine = links.filter((l) => l.direction === 'out'), theirs = links.filter((l) => l.direction === 'in');
  const who = p.name || p.handle || 'they';
  if (!links.length) { box.append(el('div', 'access-none', `nothing shared either way · draw a link to one of ${who}'s agents on the canvas, or ask for one of theirs with a synapse request`)); return box; }
  if (mine.length) {
    const asks = mine.filter((l) => l.mode === 'talk').length;
    box.append(el('div', 'access-h', `${who} sees ${mine.length} of your agents${asks ? ` · can ask ${asks}` : ''}`));
    for (const l of mine) {
      const r = el('div', 'share'), seg = el('div', 'share-mode');
      r.append(el('span', 'mine', `your ${l.local?.name || 'agent'}`), el('span', 'arr', '→'), el('span', 'ag', `their ${l.agent?.name || 'agent'}`), seg);
      for (const [mode, label] of [['sync', 'read only'], ['talk', 'read and ask']]) {
        const b = el('button', l.mode === mode ? 'on' : '', label);
        b.onclick = async () => {
          if (l.mode === mode) return;
          try { ACC.feed.links = await synapse.shares.mode(l.edgeId, mode); toast(mode === 'talk' ? `${who}'s agent can now ask your ${l.local?.name}` : `${who}'s agent can only read your ${l.local?.name} now`); redraw(); }
          catch (e) { toast(e.message, true); }
        };
        seg.appendChild(b);
      }
      const stop = el('button', 'tab-close', '×');
      stop.title = `stop sharing your ${l.local?.name} with ${who}`;
      stop.onclick = async () => { try { ACC.feed.links = await synapse.shares.remove(l.edgeId); toast(`${who} no longer sees your ${l.local?.name}`); redraw(); } catch (e) { toast(e.message, true); } };
      r.appendChild(stop);
      box.appendChild(r);
    }
  }
  if (theirs.length) {
    box.append(el('div', 'access-h', `you see ${theirs.length} of ${who}'s agents`));
    for (const l of theirs) {
      const r = el('div', 'share');
      r.append(el('span', 'ag', `their ${l.agent?.name || 'agent'}`), el('span', 'arr', '→'), el('span', 'mine', `your ${l.local?.name || 'agent'}`), el('span', 'share-tag' + (l.mode === 'talk' ? ' on' : ''), l.mode === 'talk' ? 'read and ask' : 'read only'));
      box.appendChild(r);
    }
  }
  return box;
}

// ---- agent talk history (in settings): the last 30 days, grouped per person, newest first

const TALK_ENDS = { owner: 'you ended it', asker: 'they ended it', idle: 'idle', refused: 'refused', revoked: 'access removed', unavailable: 'agent unavailable', unsupported: 'unsupported', busy: 'busy', error: 'error' };
async function drawTalkHistory(box) {
  box.replaceChildren(el('div', 'hint', 'loading…'));
  let list;
  try { list = await synapse.talks.list(); } catch (e) { box.replaceChildren(el('div', 'hint err', e.message)); return; }
  box.replaceChildren();
  if (!Array.isArray(list) || !list.length) { box.append(el('div', 'hint', 'no conversations in the last 30 days · a friend\'s agent can ask yours once you switch a share to talk')); return; }
  const byPeer = new Map();
  for (const c of [...list].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))) {
    const k = c.peer || c.peerHandle || c.peerName || '?';
    if (!byPeer.has(k)) byPeer.set(k, []);
    byPeer.get(k).push(c);
  }
  for (const convs of byPeer.values()) {
    const c0 = convs[0], head = el('div', 'person');
    head.append(avatar({ name: c0.peerName, handle: c0.peerHandle }), el('span', 'k', c0.peerName || peerHandle(c0)), el('span', 'c', c0.peerHandle ? `@${c0.peerHandle}` : ''));
    box.append(head);
    for (const c of convs) {
      const owner = c.role === 'owner', n = c.turns?.length || 0;
      const row = el('div', 'talk-row' + (c.status === 'open' ? ' open' : ''));
      const what = owner ? `${c.askerName || 'their agent'} asked your ${c.targetName || 'agent'}` : `your ${c.askerName || 'agent'} asked ${c.targetName || 'their agent'}`;
      row.append(el('span', 'k', what), el('span', 'c', `${n} question${n === 1 ? '' : 's'} · ${c.status === 'open' ? 'open' : TALK_ENDS[c.endReason] || 'ended'} · ${ageOf(c.lastAt)}`));
      const q = c.turns?.[n - 1]?.q;
      row.title = q ? `last question: ${String(q).slice(0, 300)}` : '';
      row.onclick = () => openTalk(c.id);
      box.append(row);
    }
  }
}
const ageOf = (t) => { const m = Math.max(0, Math.round((Date.now() - (t || 0)) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };


// The GUI and terminal renderer keep one session model and one PTY per session.
// Only this packaged renderer owns native capabilities; the local page gets an allowlisted bridge.
let workspaceOpen = false, workspaceReady = null, workspaceLive = false, workspaceSignature = '';
const workspaceFrame = $('#workspace-frame');
const workspacePost = (data) => {
  if (workspaceLive && workspaceFrame.src) workspaceFrame.contentWindow.postMessage(data, new URL(workspaceFrame.src).origin);
};
function workspaceState() {
  return {
    projects: M.projects, profiles: M.profiles, theme: document.documentElement.dataset.theme,
    active: top(focusedSlot()) ? `desktop-${top(focusedSlot()).key}` : null,
    sessions: M.slots.flatMap((s) => s.sessions.map((x) => ({
      id: `desktop-${x.key}`, pty: x.pty, pid: x.pid, backendId: M.agents[x.pty]?.synapseId || null,
      name: M.agents[x.pty]?.name || x.title, kind: x.kind, cwd: s.worktree,
      projectKey: worktreeOf(s.worktree)?.project.key || s.worktree,
      project: worktreeOf(s.worktree)?.project.label || s.worktree.split('/').pop(),
      status: x.exited ? 'exited' : statusOf(x) === 'working' ? 'busy' : statusOf(x),
      lastActivity: x.updatedAt, parent: x.parent == null ? null : `desktop-${sess(s, x.parent)?.key}`,
      exited: x.exited,
    }))),
  };
}
function syncWorkspace(force = false) {
  if (!workspaceLive || !workspaceOpen) return;
  const state = workspaceState(), signature = JSON.stringify(state);
  if (!force && signature === workspaceSignature) return;
  workspaceSignature = signature;
  workspacePost({ type: 'synapse:desktop-state', state });
}
function showWorkspace(open) {
  workspaceOpen = open;
  workspacePost({ type: 'synapse:desktop-visibility', visible: open });
  $('#desktop-workspace').hidden = !open;
  document.body.classList.toggle('gui-mode', open);
  $('#mode-gui').setAttribute('aria-pressed', String(open));
  $('#mode-terminal').setAttribute('aria-pressed', String(!open));
  localStorage.setItem('synapse-desktop-view', open ? 'gui' : 'terminal');
  if (open) { closeCanvas(); if (activityOpen) showActivity(false); syncWorkspace(true); }
  else { render(); top(focusedSlot())?.term.focus(); }
}
async function openWorkspace() {
  showWorkspace(true);
  try {
    workspaceReady ||= synapse.canvas().then((url) => { workspaceFrame.src = `${url}?desktop=1`; }).catch((e) => { workspaceReady = null; throw e; });
    await workspaceReady;
  } catch (e) { showWorkspace(false); toast(e.message, true); }
}
const ownSession = (id) => {
  for (const s of M.slots) {
    const x = s.sessions.find((x) => `desktop-${x.key}` === id);
    if (x) return { s, x };
  }
  throw new Error('This session is no longer open.');
};
async function desktopAction(action, args) {
  switch (action) {
    case 'state': return workspaceState();
    case 'preference': return synapse.workspace.save(args.key, args.value);
    case 'new-session': {
      if (!M.projects.some((p) => p.worktrees.some((w) => w.path === args.cwd))) throw new Error('Choose an open project.');
      if (!Object.hasOwn(M.profiles, args.kind)) throw new Error('Choose an installed agent profile.');
      const before = new Set(M.slots.map((s) => s.id));
      await newSlot(args.cwd, args.kind);
      const made = M.slots.find((s) => !before.has(s.id));
      if (!made?.sessions[0]) throw new Error('The session could not start. Check the agent command in Settings.');
      return { id: `desktop-${made.sessions[0].key}` };
    }
    case 'select': { const { s, x } = ownSession(args.id); M.focused = s.id; focusPath(s, x.id); render(); return; }
    case 'terminal': { if (args.id) { const { s, x } = ownSession(args.id); M.focused = s.id; focusPath(s, x.id); } showWorkspace(false); return; }
    case 'submit': { const { x } = ownSession(args.id); if (x.exited) throw new Error('This session has ended.'); return synapse.pty.submit(x.pty, args.text); }
    case 'output': {
      const { x } = ownSession(args.id), buffer = x.term.buffer.active, lines = [];
      for (let i = Math.max(0, buffer.length - 500); i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '');
      return { terminal: lines.join('\n').trimEnd(), messages: [], chat: [], hasMore: buffer.length > 500 };
    }
    case 'rename': {
      const { x } = ownSession(args.id);
      const name = String(args.name || '').trim().slice(0, 48);
      return renameTab(x, name);
    }
    case 'fork': {
      const { s, x } = ownSession(args.id), before = s.sessions.length;
      if (typeof args.question !== 'string' || !args.question.trim() || args.question.length > 12000) throw new Error('Write a question for the fork.');
      if (!M.demo && !['claude', 'codex'].includes(x.kind)) throw new Error('Native conversation forks are supported for Claude Code and Codex.');
      await fork(args.question.trim(), { parentPty: x.pty });
      if (s.sessions.length === before) throw new Error('The agent is not ready to fork yet. Send its first prompt, then try again.');
      return { id: `desktop-${top(s).key}` };
    }
    case 'close': { const { s, x } = ownSession(args.id); requestCloseSession(s, x.id); return; }
    case 'add-project': return promptProject();
    case 'worktree': {
      const p = M.projects.find((p) => p.key === args.key);
      if (!p) throw new Error('Choose an open project.');
      return promptWorktree(p);
    }
    case 'project-menu': {
      const p = M.projects.find((p) => p.key === args.key);
      if (!p) throw new Error('Choose an open project.');
      const rename = (title, current, save) => {
        promptText(title, 'Enter a new name', current, async (name) => { try { await save(name); await refresh(); } catch (e) { toast(e.message, true); } });
        const input = $('#modal-body input'); input.value = current; input.select();
      };
      const worktrees = p.worktrees.map((w) => ({ label: w.name, sub: [
        { label: 'New session', sub: agentMenu(w.path) },
        { label: 'Rename', run: () => rename('Rename worktree', w.name, (name) => synapse.worktree.rename(w.path, name)) },
        ...(!w.home ? [{ label: 'Delete worktree', danger: true, run: () => removeWorktreeAsk(p, w) }] : []),
      ] }));
      contextMenu([
        { label: 'New worktree', run: () => promptWorktree(p) },
        { label: 'Worktrees', sub: worktrees },
        { label: 'Rename project', run: () => rename('Rename project', p.label, (name) => synapse.project.rename(p.key, name)) },
        '-', { label: 'Remove from sidebar', danger: true, run: () => removeFromSidebar(p.worktrees.map((w) => w.path), p.label) },
      ], Math.max(0, Number(args.x) || 0), Math.max(48, (Number(args.y) || 0) + 48));
      return;
    }
    case 'settings': return openSettings();
    case 'account': return openAccount();
    case 'canvas': showWorkspace(false); return openCanvas();
    case 'activity': showWorkspace(false); return showActivity(true);
    case 'fork-tree': { if (args.id) { const { s, x } = ownSession(args.id); M.focused = s.id; focusPath(s, x.id); } showWorkspace(false); return openFan(); }
    case 'split': { if (args.id) { const { s, x } = ownSession(args.id); M.focused = s.id; focusPath(s, x.id); } showWorkspace(false); return splitShell(args.direction === 'down' ? 'down' : 'right'); }
    case 'theme': { if (['night', 'signal'].includes(args.theme)) { document.documentElement.dataset.theme = args.theme; localStorage.setItem('synapse-mode', args.theme); for (const s of M.slots) for (const x of s.sessions) x.term.options.theme = termTheme(); sendTheme(); } return; }
    default: throw new Error('Unknown workspace action.');
  }
}
addEventListener('message', async (event) => {
  if (!workspaceFrame.src || event.source !== workspaceFrame.contentWindow || event.origin !== new URL(workspaceFrame.src).origin) return;
  if (event.data?.type === 'synapse:desktop-bootstrap') {
    const preferences = await synapse.workspace.load().catch(() => ({}));
    event.source.postMessage({ type: 'synapse:desktop-bootstrap', preferences }, event.origin);
    return;
  }
  if (event.data?.type === 'synapse:desktop-ready') { workspaceLive = true; syncWorkspace(true); return; }
  const { type, request, action, args = {} } = event.data || {};
  if (type !== 'synapse:desktop-call' || typeof request !== 'string' || request.length > 80) return;
  try {
    const value = await desktopAction(action, args);
    workspacePost({ type: 'synapse:desktop-reply', request, value });
    if (action !== 'preference') syncWorkspace(true);
  } catch (e) { workspacePost({ type: 'synapse:desktop-reply', request, error: e.message }); }
});
$('#mode-gui').onclick = openWorkspace;
$('#mode-terminal').onclick = () => showWorkspace(false);
$('#desktop-settings').onclick = openSettings;

// ---------------------------------------------------------------- boot

// ---------------------------------------------------------------- Windows: say Ctrl, not ⌘

const winKeys = (t) => t.replace(/⇧⌘/g, 'Ctrl+Shift+Alt+').replace(/⌘/g, 'Ctrl+Shift+').replace(/⌃/g, 'Ctrl+').replace(/⌥/g, 'Alt+')
  .replace(/⇧/g, 'Shift+').replace(/⌫/g, 'Backspace').replace(/\bthis Mac\b/g, 'this PC').replace(/\byour Mac\b/g, 'your PC');
const MAC_GLYPHS = /[⌘⌃⌥⇧⌫]|\b(this|your) Mac\b/;
function winText(root) {
  if (root.nodeType === Node.TEXT_NODE) { if (MAC_GLYPHS.test(root.data) && !root.parentElement?.closest('.xterm')) root.data = winKeys(root.data); return; }
  if (root.nodeType !== Node.ELEMENT_NODE || root.closest('.xterm')) return;
  for (const e of [root, ...root.querySelectorAll('[title], [aria-label]')]) for (const a of ['title', 'aria-label']) { const v = e.getAttribute(a); if (v && MAC_GLYPHS.test(v)) e.setAttribute(a, winKeys(v)); }
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (MAC_GLYPHS.test(n.data) && !n.parentElement?.closest('.xterm')) n.data = winKeys(n.data);
}
if (WIN) {
  document.body.classList.add('win');
  winText(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.target.nodeType === Node.ELEMENT_NODE && m.target.closest('.xterm')) continue;
      if (m.type === 'attributes' || m.type === 'characterData') winText(m.target);
      else m.addedNodes.forEach(winText);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label'] });
}

(async () => {
  const flags = await synapse.flags();
  M.home = flags.home || '';
  await refresh();
  // first run: the checkout we were started from is the sample workspace
  if (!M.projects.length && !flags.packaged && flags.cwd !== '/' && flags.cwd !== flags.home) { try { await synapse.project.add(flags.cwd); await refresh(); } catch {} }
  const here = M.projects.flatMap((p) => p.worktrees).find((w) => flags.cwd.startsWith(w.path)) || M.projects[0]?.worktrees[0];
  const keep = !flags.demo && !flags.shot;
  const restored = keep ? await restoreSessions(await synapse.sessions.load().catch(() => null)) : 0;
  if (!restored && here) { M.open.add(worktreeOf(here.path)?.project.key); await newSlot(here.path, 'shell'); }
  persist = keep;
  render();
  if ((flags.view || localStorage.getItem('synapse-desktop-view') || 'gui') === 'gui') await openWorkspace();
  if (flags.demo && here) {
    // a ready-made tree so the deck and the fan-out can be felt without running an agent
    await fork('why not just <= ?');
    const s = focusedSlot(); focusPath(s, root(s).id);
    await fork('how big is the clock skew in prod?');
    focusPath(s, root(s).id);
    await fork('does refresh really skip validation?');
    await fork('where is the refresh handler?');
    render();
  }
  // signed in? the requests feed and, on a first start, the sign-in screen
  ACC.user = await synapse.account.get().catch(() => null);
  renderMe();
  synapse.requests.list().then((f) => { ACC.feed = f || ACC.feed; renderDot(); }).catch(() => {});
  // a new install gets the tour first, and its last step offers sign-in; everyone else gets sign-in as before
  if ((await synapse.onboarding.get().catch(() => ({}))).show) showOnboarding(true);
  else if (!ACC.user && !flags.shot && !(await synapse.account.skipped().catch(() => true))) showLogin({ startup: true });
  if (flags.shot.startsWith('login')) setTimeout(() => showLogin({ startup: true, mode: flags.shot.split(':')[1] || 'signin' }), 600);
  if (flags.shot === 'account') setTimeout(openAccount, 800);
  if (flags.shot === 'settings') setTimeout(openSettings, 800);
  if (flags.shot === 'requests') setTimeout(() => openPop(true), 1200);
  if (flags.shot === 'links') setTimeout(() => $('#syn-dot').dispatchEvent(new MouseEvent('mouseenter')), 1200);
  if (flags.shot === 'fan') setTimeout(openFan, 800);
  if (flags.shot.startsWith('addws')) setTimeout(() => {
    // addws:<mode>[:<value>] opens the dialog, and with a value submits it (used to try the flows headless)
    const [, m = 'clone', ...v] = flags.shot.split(':');
    promptProject(m);
    if (v.length) { const inp = $('#modal-body input'); inp.value = v.join(':'); inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); }
  }, 800);
  if (flags.shot === 'worktree') setTimeout(() => promptWorktree(M.projects[0]), 800);
  if (flags.shot.endsWith('+light')) { document.documentElement.dataset.theme = 'signal'; flags.shot = flags.shot.slice(0, -6); for (const sl of M.slots) for (const x of sl.sessions) x.term.options.theme = termTheme(); }
    const typeIn = async (text) => { for (const ch of text.replace(/\\n/g, '\r').replace(/\\e/g, '\x1b')) { top(focusedSlot())?.term.input(ch); await new Promise((r) => setTimeout(r, 25)); } };
  // SYNAPSE_SHOT_STEPS='[[ms, "text"], ...]' types into the front session at those times (\n is Enter, \e is Esc)
  for (const [at, text] of flags.steps) setTimeout(() => typeIn(text), at);
  if (flags.shot === 'canvas') setTimeout(toggleCanvas, 800);
  if (flags.shot.startsWith('launch:')) setTimeout(() => $('#launch').children[flags.shot.split(':')[1] - 1]?.click(), 800);
  if (flags.shot.startsWith('picker')) setTimeout(() => {
    // picker[:<digit>] opens the agent picker, and with a digit presses it
    pickProfile(here?.path);
    const d = flags.shot.split(':')[1];
    if (d) $('#modal-body').dispatchEvent(new KeyboardEvent('keydown', { key: d }));
  }, 800);
})();
