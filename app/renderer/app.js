// Renderer: owns the slot model (project → worktree → slot → stack of sessions), draws the
// sidebar, the deck of cards, the terminals and the fan-out tree. PTYs live in the main process.
import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---------------------------------------------------------------- model

const M = {
  projects: [],   // from main: { key, label, path, color, worktrees: [{ path, branch, name }] }
  agents: {},     // ptyId -> { synapseId, name, kind, status }
  unread: {},     // synapseId -> count
  profiles: {},
  slots: [],      // { id, worktree, sessions: [Session], path: [sessionId] }
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
}

function statusOf(x) {
  if (x.exited) return 'exited';
  if (x.kind === 'shell') return 'shell';
  const a = M.agents[x.pty];
  if (!a) return 'idle';
  return a.status === 'busy' || a.status === 'working' || a.status === 'running' ? 'working' : a.status === 'waiting' || a.status === 'needs_input' ? 'waiting' : 'idle';
}

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

async function makeSession(s, { kind, title, question = null, parent = null, spawn }) {
  const wrap = el('div', 'term');
  $('#stage').appendChild(wrap);
  const term = new Terminal({
    fontFamily: "'Fragment Mono', Menlo, monospace", fontSize: 13, lineHeight: 1.25, cursorBlink: true, cursorStyle: 'bar',
    allowProposedApi: true, scrollback: 5000, theme: termTheme(), macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(wrap);
  // app shortcuts pass through; the macOS editing keys xterm drops or mis-sends become their readline
  // bytes (⌘⌫ clears the line, ⌘← / ⌘→ jump to its ends); everything else goes to the pty as is
  term.attachCustomKeyEventHandler((e) => {
    if (!e.metaKey || e.type !== 'keydown') return true;
    if (APP_KEYS.has(keyName(e))) return false;
    const bytes = !e.shiftKey && !e.altKey && !e.ctrlKey && META_EDIT[e.key];
    if (!bytes) return true;
    e.preventDefault(); term.input(bytes); return false;
  });
  fit.fit();
  const { id: pty } = await spawn(term.cols, term.rows);
  const x = { id: nextId++, pty, kind, title, question, parent, exited: false, term, fit, el: wrap };
  term.onData(sforkFilter(() => x));
  term.onResize(({ cols, rows }) => synapse.pty.resize(pty, cols, rows));
  s.sessions.push(x);
  focusPath(s, x.id);
  return x;
}

synapse.pty.onData(({ id, data }) => { for (const s of M.slots) for (const x of s.sessions) if (x.pty === id) x.term.write(data); });
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
      else if (/^[^\x00-\x1f\x7f]+$/.test(t)) line += t;
      // keys that move the cursor make the line unknowable; terminal reports (focus, cursor position,
      // device attributes) also arrive here and are ignored
      else if (EDIT_KEY.test(t)) line = null;
    }
    synapse.pty.write(x.pty, d);
  };
}

async function newSlot(worktreePath, kind) {
  const prof = M.profiles[kind] || { command: kind };
  const s = { id: nextId++, worktree: worktreePath, sessions: [], path: [] };
  M.slots.push(s);
  M.focused = s.id;
  const name = worktreeOf(worktreePath)?.worktree.name || worktreePath.split('/').pop();
  try {
    await makeSession(s, { kind, title: name, spawn: (cols, rows) => synapse.pty.spawn({ cwd: worktreePath, kind, command: prof.command, cols, rows }) });
  } catch (e) { M.slots = M.slots.filter((x) => x !== s); toast(e.message, true); }
  render();
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
      kind: parent.kind, title: question, question, parent: parent.id,
      spawn: (cols, rows) => synapse.fork.spawn({ parentPty: parent.pty, question, requestId, cols, rows }),
    });
    child.injected = false;
    toast(`⑂ forked: ${question}`);
  } catch (e) { toast(e.message, true); }
  render();
}

function closeSession(s, id) {
  const doomed = [id];
  for (let i = 0; i < doomed.length; i++) doomed.push(...children(s, doomed[i]).map((x) => x.id));
  const parent = sess(s, id)?.parent;
  for (const d of doomed) { const x = sess(s, d); if (!x) continue; if (!x.exited) synapse.pty.kill(x.pty); x.term.dispose(); x.el.remove(); }
  s.sessions = s.sessions.filter((x) => !doomed.includes(x.id));
  if (parent != null) focusPath(s, parent);
  else { M.slots = M.slots.filter((x) => x !== s); if (M.focused === s.id) M.focused = M.slots[0]?.id ?? null; }
  render();
}

function pop() {
  const s = focusedSlot();
  if (!s || s.path.length < 2) return toast('nothing to pop');
  const t = top(s);
  if (!t.exited && statusOf(t) === 'working') return confirm(`"${t.title}" is still working. Close it?`, () => closeSession(s, t.id));
  closeSession(s, t.id);
  toast('popped · parent on top');
}

function moveFocus(delta) {
  const ids = orderedSlots().map((s) => s.id);
  if (!ids.length) return;
  const i = ids.indexOf(M.focused);
  M.focused = ids[(i + delta + ids.length) % ids.length];
  render();
}

function orderedSlots() {
  const out = [];
  for (const p of M.projects) for (const w of p.worktrees) for (const s of M.slots) if (s.worktree === w.path) out.push(s);
  for (const s of M.slots) if (!out.includes(s)) out.push(s);
  return out;
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
      b.title = `${M.profiles[k].command || '$SHELL -l'}${i < 9 ? `  ·  ⌘N then ${i + 1}` : ''}`;
      b.onclick = () => { const wt = focusedSlot()?.worktree || M.projects[0]?.worktrees[0]?.path; if (wt) newSlot(wt, k); else toast('add a workspace first', true); };
      return b;
    }));
  }
}

function render() {
  renderLaunch();
  renderTree();
  renderDeck();
  renderStage();
  renderBar();
}

function renderTree() {
  const tree = $('#tree');
  tree.replaceChildren();
  const cur = focusedSlot();
  let n = 0;
  for (const p of M.projects) {
    const box = el('div', 'proj' + (M.open.has(p.key) ? '' : ' closed'));
    const head = el('div', 'proj-head');
    const sw = el('span', 'swatch'); sw.style.background = p.color;
    const live = M.slots.filter((s) => p.worktrees.some((w) => w.path === s.worktree)).length;
    head.append(sw, el('span', 'proj-name', p.label), el('span', 'proj-count', String(live || p.worktrees.length)));
    const add = el('button', 'proj-add', '+'); add.title = 'new worktree';
    add.onclick = (e) => { e.stopPropagation(); promptWorktree(p); };
    head.appendChild(add);
    head.onclick = () => { if (M.open.has(p.key)) M.open.delete(p.key); else M.open.add(p.key); render(); };
    box.appendChild(head);
    if (M.open.has(p.key)) {
      for (const w of p.worktrees) {
        const wt = el('div', 'wt');
        const wh = el('div', 'wt-head' + (cur?.worktree === w.path ? ' cur' : ''));
        const wn = el('span', 'wt-name', w.name); wn.title = `${w.path}\n${w.branch}`;
        wh.append(el('span', '', '⎇'), wn);
        if (w.branch && w.branch !== w.name) wn.textContent = `${w.name} · ${w.branch}`;
        const wa = el('button', 'wt-add', '+'); wa.title = 'new session here';
        wa.onclick = (e) => { e.stopPropagation(); pickProfile(w.path); };
        wh.appendChild(wa);
        wh.onclick = () => { const first = M.slots.find((s) => s.worktree === w.path); if (first) { M.focused = first.id; render(); } else pickProfile(w.path); };
        wt.appendChild(wh);
        for (const s of M.slots.filter((s) => s.worktree === w.path)) {
          n++;
          const t = top(s);
          const row = el('div', 'slot' + (s.id === M.focused ? ' focused' : ''));
          row.append(el('span', 'dot ' + (t ? statusOf(t) : 'exited')), logo(t?.kind), el('span', 'slot-title', t ? (s.path.length > 1 ? t.title : t.title) : 'gone'));
          const a = t && M.agents[t.pty];
          const unread = a && M.unread[a.synapseId];
          if (unread) row.appendChild(el('span', 'slot-unread', `✉${unread}`));
          if (s.path.length > 1) row.appendChild(el('span', 'slot-depth', `⑂${s.path.length}`));
          row.appendChild(el('span', 'slot-kind', t?.kind || ''));
          row.title = `⌘${n}`;
          row.onclick = () => { M.focused = s.id; render(); };
          wt.appendChild(row);
        }
        box.appendChild(wt);
      }
    }
    tree.appendChild(box);
  }
}

function renderDeck() {
  const deck = $('#deck');
  deck.replaceChildren();
  const s = focusedSlot();
  if (!s) return;
  s.path.forEach((id, i) => {
    const x = sess(s, id);
    const c = el('div', 'card' + (i === s.path.length - 1 ? ' top' : ''));
    c.append(el('span', 'dot ' + statusOf(x)), logo(x.kind), el('span', 'label', i === 0 ? x.title : x.question || x.title));
    if (i > 0) c.prepend(el('span', 'q', '⑂'));
    c.onclick = () => { focusPath(s, id); render(); };
    deck.appendChild(c);
  });
  if (s.sessions.length > 1) deck.appendChild(el('span', 'deck-tag', `⑂ ${s.sessions.length} in tree · hover ⌘E`));
}

let shownSession = null;
function renderStage() {
  const s = focusedSlot();
  const t = top(s);
  $('#empty').hidden = !!t;
  $('#stage').classList.toggle('exited', !!t?.exited);
  for (const sl of M.slots) for (const x of sl.sessions) x.el.classList.toggle('visible', x === t);
  // grab focus only when a different session comes to the front, so the 1 s state refresh never steals it from a dialog
  const changed = t !== shownSession; shownSession = t;
  if (t) requestAnimationFrame(() => { t.fit.fit(); if (changed && $('#modal').hidden && !fanOpen && !canvasOpen) t.term.focus(); });
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
  const label = (x) => (x.parent == null ? x.title : x.question || x.title);
  const width = (x) => {
    if (w.has(x.id)) return w.get(x.id);
    const own = measure(label(x));
    const kids = children(s, x.id);
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
    for (const k of children(s, x.id)) { place(k, cx, depth + 1); cx += width(k) + GAP_X; }
  };
  const r = root(s);
  if (r) place(r, 0, 0);
  const totalW = r ? width(r) : 0;
  const totalH = nodes.reduce((a, n) => Math.max(a, n.top + CARD_H), 0);
  return { nodes, totalW, totalH };
}

function openFan() {
  const s = focusedSlot();
  if (!s || fanOpen) return;
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
  const deckRects = new Map([...$('#deck').querySelectorAll('.card')].map((c, i) => [s.path[i], c.getBoundingClientRect()]));
  const fanRect = inner.getBoundingClientRect();
  for (const n of nodes) {
    const x = n.x;
    const onPath = s.path.includes(x.id);
    const c = el('div', 'fcard' + (onPath ? ' on-path' : '') + (x.id === s.path[s.path.length - 1] ? ' top' : '') + (x.injected ? ' injected' : ''));
    c.style.left = `${ox + n.left}px`; c.style.top = `${oy + n.top}px`; c.style.width = `${n.w}px`;
    const q = el('div', 'fq'); q.append(el('span', 'dot ' + statusOf(x)), el('span', '', n.label));
    c.append(q, el('div', 'fm', x.parent == null ? `${x.kind} · root` : `${x.kind} · ${statusOf(x)}`));
    if (x.parent == null) c.appendChild(el('span', 'tab', 'parent'));
    else if (x.id === s.path[s.path.length - 1]) c.appendChild(el('span', 'tab', 'on top'));
    const fx = el('button', 'fx', '×'); fx.title = 'close this branch';
    fx.onclick = (e) => { e.stopPropagation(); if (x.parent == null) return toast('close the root with ⌘W'); closeSession(s, x.id); closeFan(); openFan(); };
    c.appendChild(fx);
    c.onclick = () => { focusPath(s, x.id); closeFan(); render(); };
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

// hover the deck for 300 ms to fan out
let hoverTimer = null;
$('#deck').addEventListener('mouseenter', () => { if (M.noHover || (focusedSlot()?.sessions.length || 0) < 2) return; $('#deck').classList.add('hover-arm'); hoverTimer = setTimeout(openFan, 300); });
$('#deck').addEventListener('mouseleave', () => { $('#deck').classList.remove('hover-arm'); clearTimeout(hoverTimer); });

// ---------------------------------------------------------------- modals

function modal(title, build) {
  const m = $('#modal'), body = $('#modal-body');
  $('#modal-title').textContent = title;
  body.replaceChildren();
  build(body, () => { m.hidden = true; top(focusedSlot())?.term.focus(); });
  m.hidden = false;
  const inp = body.querySelector('input'); if (inp) inp.focus();
}
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) { $('#modal').hidden = true; } });

function promptText(title, hint, placeholder, onOk) {
  modal(title, (body, close) => {
    const inp = el('input'); inp.placeholder = placeholder;
    body.append(inp, el('div', 'hint', hint));
    inp.onkeydown = (e) => { if (e.key === 'Enter' && inp.value.trim()) { close(); onOk(inp.value.trim()); } if (e.key === 'Escape') close(); };
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
function promptWorktree(project) {
  promptText('new worktree', `git worktree add -b <name> ~/.synapse/worktrees/${project.label}/<name>`, 'branch name', async (name) => {
    try { const dir = await synapse.worktree.add({ repo: project.path, name }); toast(`worktree ${name} ready`); await refresh(); newSlot(dir, 'shell'); }
    catch (e) { toast(e.message, true); }
  });
}
function promptFork() {
  const t = top(focusedSlot());
  if (!t) return toast('no session to fork', true);
  promptText('⑂ fork', `a child of "${t.title}" with its full context. Nothing flows back unless you send it.`, 'what do you want to dig into?', (q) => fork(q));
}
// Add a workspace three ways: clone a repo, open a folder, or start a new repo from a name.
const WS_MODES = {
  library: { label: 'library', hint: '~/.synapse/workspaces · ● already in the sidebar · ↑↓ enter', placeholder: '' },
  clone: { label: 'clone', hint: 'git clone into ~/.synapse/workspaces/<repo>', placeholder: 'https://github.com/owner/repo  or  git@github.com:owner/repo.git' },
  open: { label: 'open folder', hint: 'a repo, a worktree or any folder. Enter adds a typed path.', placeholder: '~/code/repo' },
  new: { label: 'new', hint: 'git init ~/.synapse/workspaces/<name> with an empty first commit', placeholder: 'name' },
};
let onCloneLine = null;
synapse.project.onCloneProgress((line) => onCloneLine?.(line));
// "+ workspace": the library (everything in ~/.synapse/workspaces) first when it has entries, else clone
async function promptProject(mode) {
  const home = M.home || '';
  let lib = [];
  try { lib = await synapse.project.library(); } catch {}
  mode ||= lib.length ? 'library' : 'clone';
  let focusList = null;
  modal('add workspace', (body, close) => {
    const seg = el('div', 'seg');
    const list = el('div', 'lib');
    const inp = el('input');
    const hint = el('div', 'hint');
    const row = el('div', 'row');
    const browse = el('button', 'btn', 'choose folder…');
    const go = el('button', 'btn sig');
    let busy = false, sel = 0;
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
      if (first) { M.focused = first.id; render(); } else pickProfile(w.path);
    };
    const renderLib = () => {
      list.replaceChildren();
      if (!lib.length) return list.appendChild(el('div', 'hint', 'nothing here yet. clone or create a repo, or add a folder: it gets linked here'));
      lib.forEach((w, i) => {
        const o = el('div', 'opt' + (i === sel ? ' sel' : ''));
        const shown = home && w.path.startsWith(home) ? `~${w.path.slice(home.length)}` : w.path;
        o.append(el('span', 'n', w.added ? '●' : ''), el('span', 'k', w.name), el('span', 'c', shown));
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
      inp.hidden = row.hidden = isLib; list.hidden = !isLib;
      inp.value = ''; inp.placeholder = WS_MODES[m].placeholder; hint.textContent = WS_MODES[m].hint; hint.classList.remove('err');
      go.textContent = { clone: 'clone', open: 'add', new: 'create' }[m] || '';
      browse.hidden = m !== 'open';
      if (isLib) { sel = 0; renderLib(); list.focus(); } else inp.focus();
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
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape' && !busy) { onCloneLine = null; close(); }
      if (e.key === 'Tab' && !busy) { e.preventDefault(); cycle(e.shiftKey); }
    };
    list.tabIndex = 0;
    list.onkeydown = (e) => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && lib.length) { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : lib.length - 1)) % lib.length; renderLib(); }
      if (e.key === 'Enter' && lib[sel]) pick(lib[sel]);
      if (e.key === 'Escape' && !busy) { onCloneLine = null; close(); }
      if (e.key === 'Tab' && !busy) { e.preventDefault(); cycle(e.shiftKey); }
    };
    row.append(browse, go);
    body.append(seg, list, inp, hint, row);
    set(mode);
    focusList = () => list.focus();
  });
  if (mode === 'library') focusList?.(); // the modal was hidden while set() ran, so focus again now
}

// ---------------------------------------------------------------- settings
async function openSettings() {
  let s = {};
  try { s = await synapse.settings.get(); } catch {}
  modal('settings', (body, close) => {
    const themeRow = el('div', 'opt set'), themeVal = el('span', 'c');
    const showTheme = () => (themeVal.textContent = document.documentElement.dataset.theme === 'night' ? 'night' : 'signal');
    themeRow.append(el('span', 'n', '◐'), el('span', 'k', 'theme'), themeVal); showTheme();
    themeRow.onclick = () => { toggleTheme(); showTheme(); };
    const linkRow = el('label', 'opt set'), cb = el('input');
    cb.type = 'checkbox'; cb.checked = !!s.autoSymlink;
    linkRow.append(cb, el('span', 'k', 'link workspaces'), el('span', 'c', 'symlink workspaces added from elsewhere into ~/.synapse/workspaces, so the library can bring them back'));
    cb.onchange = async () => {
      try { await synapse.settings.set({ autoSymlink: cb.checked }); toast(cb.checked ? 'new workspaces get linked into ~/.synapse/workspaces' : 'workspaces are no longer linked · existing links stay'); }
      catch (e) { cb.checked = !cb.checked; toast(e.message, true); }
    };
    body.append(el('div', 'hint', '~/.synapse/app.json · esc closes'), themeRow, linkRow);
    body.tabIndex = 0; body.onkeydown = (e) => { if (e.key === 'Escape') close(); };
  });
}

let toastTimer = null;
function toast(text, sig = false) {
  const t = $('#toast'); t.textContent = text; t.className = 'toast' + (sig ? ' sig' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------------------------------------------------------------- keys

const keyName = (e) => (e.shiftKey ? 'shift+' : '') + e.key.toLowerCase();
const APP_KEYS = new Set(['t', 'n', 'shift+n', 'shift+f', 'e', 'w', '[', ']', 'shift+backspace', '1', '2', '3', '4', '5', '6', '7', '8', '9', ',']);
// ⌘ + editing key -> what a macOS terminal sends for it (iTerm's natural editing, Ghostty's defaults)
const META_EDIT = { Backspace: '\x15', ArrowLeft: '\x01', ArrowRight: '\x05' };
window.addEventListener('keydown', (e) => {
  if (!$('#modal').hidden) return;
  if (fanOpen && e.key === 'Escape') return closeFan();
  if (fanOpen && e.key === 'Backspace') { const s = focusedSlot(); const t = top(s); if (t?.parent != null) { closeSession(s, t.id); closeFan(); openFan(); } return; }
  if (!e.metaKey) return;
  const k = keyName(e);
  if (!APP_KEYS.has(k)) return;
  e.preventDefault();
  const s = focusedSlot();
  switch (k) {
    case 't': { const wt = s?.worktree || M.projects[0]?.worktrees[0]?.path; if (wt) newSlot(wt, 'shell'); break; }
    case 'n': { const wt = s?.worktree || M.projects[0]?.worktrees[0]?.path; if (wt) pickProfile(wt); break; }
    case 'shift+n': { const p = s ? worktreeOf(s.worktree)?.project : M.projects[0]; if (p) promptWorktree(p); break; }
    case 'shift+f': promptFork(); break;
    case 'e': fanOpen ? closeFan() : openFan(); break;
    case 'shift+backspace': pop(); break;
    case 'w': { const t = top(s); if (!t) break; if (!t.exited && statusOf(t) === 'working') confirm(`"${t.title}" is still working. Close it?`, () => closeSession(s, t.id)); else closeSession(s, t.id); break; }
    case '[': moveFocus(-1); break;
    case ']': moveFocus(1); break;
    case ',': openSettings(); break;
    default: { const n = Number(k); const o = orderedSlots(); if (o[n - 1]) { M.focused = o[n - 1].id; render(); } }
  }
});

// The Synapse canvas (links, messages, every agent on the machine) as an overlay over the terminals.
let canvasOpen = false;
async function toggleCanvas() {
  if (!canvasOpen) {
    const f = $('#canvas-frame');
    if (!f.src) {
      $('#canvas').hidden = false; $('#canvas').classList.add('loading');
      try { f.src = await synapse.canvas(); } catch (e) { $('#canvas').hidden = true; return toast(e.message, true); }
      finally { $('#canvas').classList.remove('loading'); }
    }
  }
  canvasOpen = !canvasOpen;
  $('#canvas').hidden = !canvasOpen;
  $('#btn-canvas').classList.toggle('on', canvasOpen);
  if (canvasOpen) $('#canvas-frame').focus(); else top(focusedSlot())?.term.focus();
}
$('#btn-canvas').onclick = toggleCanvas;

// ⌘-click on a node in the canvas: bring that agent's session to the front, wherever it sits in a fork tree
addEventListener('message', (ev) => {
  if (ev.source !== $('#canvas-frame').contentWindow || ev.data?.type !== 'synapse:open') return;
  const { id, name, pid } = ev.data;
  const ptyId = Object.keys(M.agents).find((k) => M.agents[k].synapseId === id);
  for (const s of M.slots) {
    const x = ptyId && s.sessions.find((y) => y.pty === ptyId);
    if (!x) continue;
    M.focused = s.id; focusPath(s, x.id);
    const wt = worktreeOf(s.worktree); if (wt) M.open.add(wt.project.key);
    if (canvasOpen) toggleCanvas();
    render();
    return;
  }
  toast(`${name || id} runs outside this app${pid ? ` (pid ${pid})` : ''}`, true);
});
synapse.onCanvasToggle(toggleCanvas);

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'night' ? 'signal' : 'night';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('synapse-mode', next);
  for (const sl of M.slots) for (const x of sl.sessions) x.term.options.theme = termTheme();
}

$('#theme').onclick = toggleTheme;
$('#settings').onclick = openSettings;
$('#btn-fork').onclick = promptFork;
$('#add-project').onclick = () => promptProject();
window.addEventListener('resize', () => { const t = top(focusedSlot()); if (t) t.fit.fit(); });

// ---------------------------------------------------------------- state

async function refresh() { apply(await synapse.state()); }
function apply(st) {
  M.projects = st.projects; M.agents = st.agents; M.unread = st.unread; M.profiles = st.profiles; M.edges = st.edges; M.demo = st.demo;
  for (const p of M.projects) if (p.worktrees.some((w) => M.slots.some((s) => s.worktree === w.path))) M.open.add(p.key);
  render();
}
synapse.onState(apply);
synapse.fork.onRequest(({ requestId, parentPty, question }) => fork(question, { requestId, parentPty }));

// ---------------------------------------------------------------- boot

(async () => {
  const flags = await synapse.flags();
  M.home = flags.home || '';
  M.noHover = !!flags.shot && flags.shot !== 'fan'; // screenshots: the real mouse must not open the fork tree
  await refresh();
  // first run: the checkout we were started from is the sample workspace
  if (!M.projects.length) { try { await synapse.project.add(flags.cwd); await refresh(); } catch {} }
  const here = M.projects.flatMap((p) => p.worktrees).find((w) => flags.cwd.startsWith(w.path)) || M.projects[0]?.worktrees[0];
  if (here) { M.open.add(worktreeOf(here.path)?.project.key); await newSlot(here.path, 'shell'); }
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
