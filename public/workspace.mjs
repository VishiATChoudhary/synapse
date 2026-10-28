// The workspace uses one event stream. Only the selected conversation is fetched and rendered.
import { createActivityView } from './activity.mjs';
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// A slash command at the start of a message: `/goal`, `//goal` (Claude Code), `/ultrafast` (Codex). Paths such as
// /Users/me are not commands (the token stops at the next space and holds no further slash).
export function slashCommand(value) {
  const m = /^\s*(\/{1,2}[A-Za-z][\w:.-]*)(?=\s|$)/.exec(String(value ?? ''));
  return m ? { command: m[1], rest: String(value).slice(m.index + m[0].length).replace(/^[ \t]+/, '') } : null;
}
// a user message that is a slash command shows the command as a chip, its arguments as text
export function messageBody(text, user, tools = !user) {
  const slash = user && slashCommand(text);
  if (slash) return `<div class="slash-head"><span class="slash-cmd">${escapeHtml(slash.command)}</span></div>${slash.rest ? renderMarkdown(slash.rest) : ''}`;
  if (!tools) return renderMarkdown(text);
  // a reply that also called tools logs each call on its own line; those read as quiet activity rows
  const out = [];
  let prose = [], fence = false;
  const flush = () => { if (prose.length) out.push(renderMarkdown(prose.join('\n'))); prose = []; };
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const tool = !fence && toolSummary(line);
    if (tool) { flush(); out.push(`<div class="tool-line">${toolRow(tool)}</div>`); } else prose.push(line);
  }
  flush();
  return out.join('');
}

// "[Bash: npm test]" is how lib.mjs records a tool call. Name the action in words, keep its target verbatim.
const TOOL_LINE = /^\[([\w.:-]{1,80})(?::\s(.*))?\]$/;
const TOOL_VERBS = [[/^(bash|exec|exec_command|shell|local_shell|run)/i, 'Ran', 'terminal'], [/^(read|view|notebookread)/i, 'Read', 'file'],
  [/^(edit|multiedit|apply_patch|str_replace|notebookedit)/i, 'Edited', 'edit'], [/^(write|create_file)/i, 'Wrote', 'file'],
  [/^(grep|glob|search|find|ls|list)/i, 'Searched', 'search'], [/^(web|fetch|browse)/i, 'Looked up', 'globe']];
export function toolSummary(text) {
  const m = TOOL_LINE.exec(String(text ?? '').trim());
  if (!m) return null;
  const name = m[1].replace(/^mcp__[^_]+__/, ''), hit = TOOL_VERBS.find(([re]) => re.test(name));
  return { verb: hit ? hit[1] : name.replace(/_/g, ' '), icon: hit ? hit[2] : 'tool', what: m[2] || '' };
}
const toolRow = (t) => `${icon(t.icon)}<span class="tool-verb">${escapeHtml(t.verb)}</span>${t.what ? `<code class="tool-what">${escapeHtml(t.what)}</code>` : ''}`;
// "@mara" in a message, not inside an email address
export const MENTION = /(^|[\s(])@([A-Za-z0-9][\w-]{1,23})\b/g;

export function renderMarkdown(value) {
  const blocks = [];
  const hold = (html) => `\u0000${blocks.push(html) - 1}\u0000`;
  const source = String(value ?? '').replace(/[\u0000\u0001]/g, '').replace(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g, (_, language, code) =>
    `\n${hold(`<div class="code-block"><div class="code-label"><span>${escapeHtml(language.trim())}</span><button type="button" data-copy-code>Copy code</button></div><pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre></div>`)}\n`);
  const inline = (text) => {
    const parts = [];
    const keep = (html) => `\u0001${parts.push(html) - 1}\u0001`;
    let result = text.replace(/`([^`]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
    result = result.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, url) => {
      let safe = false;
      try { safe = ['https:', 'http:'].includes(new URL(url).protocol); } catch {}
      return keep(safe ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>` : `<span title="${escapeHtml(url)}">${escapeHtml(label)}</span>`);
    });
    // bare web addresses link too; a trailing full stop or bracket belongs to the sentence
    result = result.replace(/\bhttps?:\/\/[^\s<>"'`\]\u0001]+/g, (raw) => {
      const url = raw.replace(/[.,;:!?)]+$/, '');
      return keep(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`) + raw.slice(url.length);
    });
    return escapeHtml(result)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w_])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(MENTION, '$1<span class="mention">@$2</span>')
      .replace(/\u0001(\d+)\u0001/g, (_, index) => parts[index]);
  };
  const output = [], lines = source.split('\n');
  let paragraph = [], list = null;
  const endParagraph = () => { if (paragraph.length) output.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; };
  const endList = () => { if (list) output.push(`</${list}>`); list = null; };
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    if (/^\u0000\d+\u0000$/.test(line.trim())) { endParagraph(); endList(); output.push(line.trim()); }
    else if (!line.trim()) { endParagraph(); endList(); }
    else if (line.includes('|') && lines[i + 1] && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]) && cells(lines[i + 1]).every((cell) => /^:?-{3,}:?$/.test(cell))) {
      endParagraph(); endList();
      const headings = cells(line);
      let table = `<div class="md-table"><table><thead><tr>${headings.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>`;
      i++;
      while (lines[i + 1]?.includes('|') && lines[i + 1].trim()) table += `<tr>${cells(lines[++i]).map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`;
      output.push(`${table}</tbody></table></div>`);
    } else if ((match = line.match(/^#{1,6}\s+(.*)/))) { endParagraph(); endList(); output.push(`<h3>${inline(match[1])}</h3>`); }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { endParagraph(); endList(); output.push('<hr>'); }
    else if ((match = line.match(/^\s*>\s?(.*)/))) { endParagraph(); endList(); output.push(`<blockquote>${inline(match[1])}</blockquote>`); }
    else if ((match = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)/))) {
      endParagraph();
      const tag = /\d/.test(match[1]) ? 'ol' : 'ul';
      if (list !== tag) { endList(); output.push(`<${tag}>`); list = tag; }
      output.push(`<li>${inline(match[2])}</li>`);
    } else { endList(); paragraph.push(line); }
  }
  endParagraph(); endList();
  return output.join('').replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[index]);
}

// Paths an agent mentions ("lib.mjs:12", "app/main.mjs", "~/notes.md"). Only candidates: the server confirms
// which exist, so version numbers and domains that merely look like paths stay plain text.
const FILE_RE = /(?<![\w/.:@-])~?\/?[\w.@+-]+(?:\/[\w.@+-]+)*\/?(?::\d+(?:[-:]\d+)?|#L\d+(?:-L?\d+)?)?/g;
export function filePaths(text) {
  return [...String(text ?? '').matchAll(FILE_RE)].map((m) => ({ index: m.index, path: m[0].replace(/[.,;:)]+$/, '') }))
    .filter(({ path }) => path.length > 2 && (path.includes('/') || /\.[A-Za-z]\w{0,7}(?::\d|#L|$)/.test(path)) && !/^\/+$/.test(path) && !/^\d+(\.\d+)+$/.test(path));
}

// "@handle" for each of your agents: its name made mention-safe, numbered when names repeat ("claude", "claude-2").
// Friends keep their own handles, so an agent never takes one.
export function agentHandles(agents, taken = []) {
  const used = new Set(taken.map((h) => h.toLowerCase())), out = new Map();
  for (const agent of agents) {
    let base = String(agent.name || agent.kind || 'agent').replace(/[^\w-]+/g, '-').replace(/^[-_]+/, '').slice(0, 20).replace(/[-_]+$/, '') || 'agent';
    if (base.length < 2) base += '-agent';
    let handle = base, n = 2;
    while (used.has(handle.toLowerCase())) handle = `${base}-${n++}`;
    used.add(handle.toLowerCase()); out.set(handle, agent);
  }
  return out;
}

// What @ suggests: friends first, then agents in this project, and once you type, agents anywhere else
export function mentionOptions({ friends = [], agents = new Map(), project = '', query = '' }) {
  const q = query.toLowerCase(), starts = (...values) => !q || values.some((v) => String(v || '').toLowerCase().startsWith(q));
  const contains = (...values) => values.some((v) => String(v || '').toLowerCase().includes(q));
  const friendHits = friends.filter((p) => starts(p.handle, p.name)).map((p) => ({ type: 'friend', handle: p.handle, friend: p }));
  const here = [], elsewhere = [];
  for (const [handle, agent] of agents) {
    const local = !!project && agent.projectKey === project;
    if (local && (starts(handle, agent.name) || (q && contains(handle, agent.name)))) here.push({ type: 'agent', handle, agent, local });
    else if (!local && q && contains(handle, agent.name, agent.project)) elsewhere.push({ type: 'agent', handle, agent, local });
  }
  const recent = (a, b) => (b.agent.lastActivity || 0) - (a.agent.lastActivity || 0);
  return [...friendHits.slice(0, 4), ...here.sort(recent).slice(0, 5), ...elsewhere.sort(recent).slice(0, 5)];
}

// Your earlier prompts to an agent, oldest first: what Up in the composer steps back through
export function promptHistory(data) {
  const sent = [...(data?.messages || []).filter((m) => m.role === 'user').map((m) => ({ text: m.text, time: Date.parse(m.ts) || 0 })),
    ...(data?.chat || []).filter((m) => m.from === 'synapse-user').map((m) => ({ text: m.text, time: m.t || 0 }))];
  const out = [];
  for (const { text } of sent.sort((a, b) => a.time - b.time)) { const t = String(text || '').trim(); if (t && out.at(-1) !== t) out.push(t); }
  return out;
}

function wordScore(word, value) {
  const text = String(value || '').toLowerCase(), at = text.indexOf(word);
  if (at >= 0) return 100 - Math.min(at, 40) + (at === 0 ? 30 : 0);
  let found = 0, score = 0, previous = -2;
  for (let i = 0; i < text.length && found < word.length; i++) {
    if (text[i] === word[found]) { score += i === previous + 1 ? 5 : 1; previous = i; found++; }
  }
  return found === word.length ? score : -1;
}

export function searchSessions(agents, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return agents.map((agent) => {
    const scores = words.map((word) => Math.max(...['name', 'project', 'kind', 'cwd'].map((key) => wordScore(word, agent[key]))));
    return { agent, score: scores.includes(-1) ? -1 : scores.reduce((sum, score) => sum + score, 0) };
  }).filter((hit) => hit.score >= 0).sort((a, b) => b.score - a.score || (b.agent.lastActivity || 0) - (a.agent.lastActivity || 0)).map((hit) => hit.agent);
}

export function sessionTree(agents) {
  const ids = new Set(agents.map((a) => a.id)), children = new Map(), seen = new Set();
  const parent = (a) => a.parent === undefined ? a.forkOf : a.parent;
  for (const agent of agents) {
    const key = parent(agent);
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(agent);
  }
  const visit = (agent) => {
    seen.add(agent.id);
    return { agent, children: (children.get(agent.id) || []).filter((a) => !seen.has(a.id)).map(visit) };
  };
  const roots = agents.filter((a) => !ids.has(parent(a)) || parent(a) === a.id).map(visit);
  // A stale parent or malformed cycle must not hide a running session.
  for (const agent of agents) if (!seen.has(agent.id)) roots.push(visit(agent));
  return roots;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.7" cy="10.7" r="6.7"/><path d="m16 16 4.5 4.5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  network: '<rect x="9" y="2" width="6" height="6" rx="1.5"/><rect x="2" y="16" width="6" height="6" rx="1.5"/><rect x="16" y="16" width="6" height="6" rx="1.5"/><path d="M12 8v4M5 16v-4h14v4"/>',
  canvas: '<circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="13" cy="19" r="2.5"/><path d="m7.5 6 9-1M6.5 8l5 8.5M18 7.5l-4 9"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m0-5h6a6 6 0 0 0 6-4"/>',
  home: '<path d="m3 10 9-7 9 7v10H3V10Zm6 10v-7h6v7"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'panel-left': '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18"/>',
  'panel-right': '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M15 3v18"/>',
  external: '<path d="M14 3h7v7M21 3l-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  monitor: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  moon: '<path d="M20.5 13a8.5 8.5 0 0 1-9.5-9.5A8.5 8.5 0 1 0 20.5 13Z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.8 1c-.7 1.1-2.3 1.3-2.3 3M12 17h.01"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3Zm-3 3 5 5"/>',
  'arrow-right': '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  'arrow-left': '<path d="M20 12H4m6-6-6 6 6 6"/>',
  'arrow-up': '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  'arrow-down': '<path d="M12 4v16m-6-6 6 6 6-6"/>',
  'arrows': '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  unlink: '<path d="m3 3 18 18M10.5 13.5l3-3M8 16l-1 1a3.5 3.5 0 0 1-5-5l3-3m11-1 1-1a3.5 3.5 0 0 1 5 5l-3 3"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  message: '<path d="M21 11a9 9 0 0 1-9 9 10 10 0 0 1-4-1l-5 2 1.5-5A9 9 0 1 1 21 11Z"/>',
  tool: '<path d="M14 6a5 5 0 0 0-6 6l-5 5a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-4 2-2-2 2-4Z"/>',
  compose: '<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.4 3.6a2 2 0 0 1 2.9 2.9L13 14.8l-3.6.9.9-3.6 8.1-8.5Z"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  'folder-plus': '<path d="M3 7V5a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M12 10v6m-3-3h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5M13 15h4"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.message}</svg>`;
const KIND_NAMES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'OpenCode', 'cursor-agent': 'Cursor', amp: 'Amp', copilot: 'Copilot CLI', superset: 'Superset', shell: 'Shell' };
const KIND_INITIALS = { claude: 'Cl', codex: 'Cx', gemini: 'G', opencode: 'Oc', 'cursor-agent': 'Cu', amp: 'A', copilot: 'Co', superset: 'S', shell: '>_' };
const kindName = (agent) => KIND_NAMES[agent.kind] || agent.kind;
const avatar = (agent) => `<span class="agent-avatar" title="${escapeHtml(kindName(agent))}" aria-hidden="true">${escapeHtml(KIND_INITIALS[agent.kind] || agent.kind?.slice(0, 2) || 'A')}</span>`;
const activityLabel = (agent) => agent.status === 'busy' ? 'Working' : ['waiting', 'needs_input'].includes(agent.status) ? 'Needs input' : agent.status === 'exited' ? 'Exited' : 'Idle';
const status = (agent) => `<span class="status-dot ${agent.status === 'busy' ? 'busy' : ''}" aria-hidden="true"></span>`;
const relativeTime = (time) => {
  const seconds = Math.max(0, (Date.now() - Number(time || Date.now())) / 1000);
  return seconds < 60 ? 'now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
};
const hash = (text) => { let value = 0; for (let i = 0; i < text.length; i++) value = ((value << 5) - value + text.charCodeAt(i)) | 0; return value.toString(36); };

function initialize() {
  const embedded = parent !== window && new URLSearchParams(location.search).get('desktop') === '1';
  const paneKey = embedded ? new URLSearchParams(location.search).get('pane') : null;
  const parentOrigin = paneKey ? location.origin : 'null';
  if (paneKey) document.body.classList.add('pane-mode');
  // Windows has no ⌘: the shortcuts here take Ctrl, so the labels say so (Alt for ⌥)
  if (/Windows/.test(navigator.userAgent)) {
    const relabel = (root) => root.querySelectorAll?.('kbd').forEach((k) => { k.textContent = k.textContent.replace(/⌘ \/ Ctrl/g, 'Ctrl').replace(/⌘/g, 'Ctrl').replace(/⌥/g, 'Alt'); });
    relabel(document);
    new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach(relabel))).observe(document.body, { childList: true, subtree: true });
  }
  let desktop = null, rawState = { agents: [], edges: [], messageRevision: 0 }, desktopActive = true;
  const paneFrames = new Map();
  let splitActive = false, reportedView = '';
  const requests = new Map();
  function desktopCall(action, args = {}) {
    if (!embedded) return Promise.reject(new Error('Open the Synapse desktop app to use this action.'));
    const request = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(request); reject(new Error('The desktop app did not respond. Try again.')); }, 30000);
      requests.set(request, { resolve, reject, timer });
      parent.postMessage({ type: 'synapse:desktop-call', request, action, args }, '*');
    });
  }
  function mergeDesktop(next) {
    if (!desktop) return next;
    const existing = new Map(next.agents.map((a) => [a.id, a]));
    const aliases = new Map(desktop.sessions.filter((s) => s.backendId).map((s) => [s.backendId, s.id]));
    const owned = desktop.sessions.map((s) => {
      const original = existing.get(s.backendId);
      return { ...original, ...s, owned: true, lastActivity: Math.max(s.lastActivity || 0, original?.lastActivity || 0), preview: original?.preview || (s.exited ? 'Session ended' : 'Ready for your next prompt') };
    });
    return { ...next, agents: [...owned, ...next.agents.filter((a) => !aliases.has(a.id))],
      edges: next.edges.map((e) => ({ ...e, from: aliases.get(e.from) || e.from, to: aliases.get(e.to) || e.to })) };
  }
  addEventListener('message', (event) => {
    const pane = [...paneFrames.values()].find((frame) => frame.contentWindow === event.source);
    if (pane && event.origin === location.origin) {
      const message = event.data;
      const owns = (id) => desktop?.sessions.some((s) => s.id === id && s.pane === pane.dataset.paneKey);
      if (message?.type === 'synapse:desktop-bootstrap') {
        const preferences = Object.fromEntries(['synapse-mode', 'synapse-selected', 'synapse-sidebar', 'synapse-inspector', 'synapse-drafts', 'synapse-collapsed'].map((key) => [key, getStorage(key, null)]));
        pane.contentWindow.postMessage({ type: 'synapse:desktop-bootstrap', preferences }, location.origin);
      }
      if (message?.type === 'synapse:desktop-ready') sendPaneState(pane);
      if (message?.type === 'synapse:pane-draft' && owns(message.id) && typeof message.text === 'string' && message.text.length <= 12000) {
        drafts[message.id] = message.text;
        clearTimeout(draftTimer); draftTimer = setTimeout(persistDraft, 250);
      }
      if (message?.type === 'synapse:pane-focus' && view === 'session' && selectedId !== pane.dataset.agentId) navigate('session', pane.dataset.agentId);
      if (message?.type === 'synapse:pane-navigate' && byId.has(message.id)) navigate('session', message.id);
      if (message?.type === 'synapse:pane-command') {
        if (message.command === 'sidebar') setSidebar(!sidebarOpen);
        if (message.command === 'search') openSearch();
        if (message.command === 'canvas') navigate(view === 'canvas' ? 'session' : 'canvas', selectedId);
      }
      if (message?.type === 'synapse:pane-recent' && owns(message.id)) {
        recentCache.set(message.id, message.cached); if (inspectorOpen) renderInspector();
      }
      if (message?.type === 'synapse:desktop-call' && typeof message.request === 'string') {
        desktopCall(message.action, message.args).then(
          (value) => pane.contentWindow?.postMessage({ type: 'synapse:desktop-reply', request: message.request, value }, location.origin),
          (error) => pane.contentWindow?.postMessage({ type: 'synapse:desktop-reply', request: message.request, error: error.message }, location.origin),
        );
      }
      return;
    }
    const canvas = document.getElementById('gui-canvas');
    if (canvas.src && event.source === canvas.contentWindow && event.origin === location.origin) {
      const message = event.data, r = canvas.getBoundingClientRect();
      if (message?.type === 'synapse:ready') { canvasLive = true; updateCanvasTheme(); for (const action of canvasActions.splice(0)) sendCanvas(action); if (embedded) desktopCall('canvas-ready').catch((e) => toast(e.message)); }
      if (message?.type === 'synapse:menu' && embedded) desktopCall('canvas-menu', { ...message, x: r.left + message.x, y: r.top + message.y }).catch((e) => toast(e.message));
      if (message?.type === 'synapse:settings') desktopCall('settings').catch((e) => toast(e.message));
      if (message?.type === 'synapse:close') navigate(byId.has(selectedId) ? 'session' : 'overview', selectedId);
      if (message?.type === 'synapse:forward') history.forward();
      if (message?.type === 'synapse:switch' && embedded) desktopCall('switch-session', { key: message.key }).catch((e) => toast(e.message));
      if (message?.type === 'synapse:open') {
        const agent = state.agents.find((a) => a.id === message.id || a.backendId === message.id);
        if (agent) navigate('session', agent.id);
      }
      return;
    }
    if (!embedded || event.source !== parent || event.origin !== parentOrigin) return;
    const message = event.data;
    if (paneKey && message?.type === 'synapse:pane-state') {
      const changed = selectedId !== message.id;
      if (changed) { persistDraft(); recentController?.abort(); recentTarget = null; recentRequest++; tab = 'conversation'; limit = 60; }
      desktop = message.desktop; selectedId = message.id; view = 'session';
      drafts = { ...drafts, ...message.drafts };
      if (changed) { $('message-input').value = drafts[selectedId] || ''; resizeComposer(); }
      document.body.classList.add('desktop');
      document.documentElement.dataset.theme = message.desktop.theme;
      applyState(message.state); updateConnection(message.connected);
      return;
    }
    if (message?.type === 'synapse:desktop-reply') {
      const pending = requests.get(message.request); if (!pending) return;
      clearTimeout(pending.timer); requests.delete(message.request);
      message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.value);
    }
    if (message?.type === 'synapse:desktop-state') {
      const previous = desktop?.active;
      const followSelection = !selectedId || selectedId === previous;
      desktop = message.state;
      document.body.classList.add('desktop');
      const theme = desktop.theme;
      if (['night', 'signal'].includes(theme)) document.documentElement.dataset.theme = theme;
      updateThemeButton();
      if (desktopActive) {
        const follow = view === 'session' && followSelection && desktop.active && desktop.active !== previous && desktop.sessions.some((s) => s.id === desktop.active);
        if (follow) { persistDraft(); selectedId = desktop.active; $('message-input').value = drafts[selectedId] || ''; }
        applyState(rawState);
        if (follow) navigate('session', desktop.active);
      }
    }
    if (message?.type === 'synapse:friends-changed') { if (friends) loadFriends().then(() => { renderFriendsList(); composerPaint?.(); }, () => {}); return; }
    if (message?.type === 'synapse:desktop-visibility') {
      desktopActive = message.visible;
      if (!desktopActive) persistDraft();
      if (desktopActive) applyState(rawState);
    }
    if (message?.type === 'synapse:desktop-navigate') navigate(message.view === 'back' || (message.toggle && view === message.view) ? byId.has(selectedId) ? 'session' : 'overview' : message.view, message.id || selectedId);
    if (message?.type === 'synapse:activity-progress') activityView.progress(message.progress);
    if (message?.type === 'synapse:canvas-action') sendCanvas(message.action);
  });
  const $ = (id) => document.getElementById(id);
  const activityView = createActivityView($('activity-view'), {
    get: () => desktopCall('activity:get'),
    board: Object.fromEntries(['get', 'join', 'leave'].map((action) => [action, () => desktopCall(`board:${action}`)])),
  });
  let canvasLive = false;
  const canvasActions = [];
  function sendCanvas(action) {
    if (canvasLive) $('gui-canvas').contentWindow.postMessage({ type: 'synapse:do', ...action }, location.origin);
    else {
      if (['session-visibility', 'thread'].includes(action.action)) {
        const old = canvasActions.findIndex((a) => a.action === action.action); if (old >= 0) canvasActions.splice(old, 1);
      }
      canvasActions.push(action); if (canvasActions.length > 30) canvasActions.shift();
    }
  }
  function updateCanvasTheme() { if (canvasLive) $('gui-canvas').contentWindow.postMessage({ type: 'synapse:theme', theme: document.documentElement.dataset.theme }, location.origin); }
  const populateIcons = (root) => root.querySelectorAll('[data-icon]').forEach((element) => { element.innerHTML = icon(element.dataset.icon); });
  populateIcons(document);
  const getStorage = (key, fallback = '') => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const setStorage = (key, value) => {
    try { localStorage.setItem(key, value); } catch {}
    if (embedded) desktopCall('preference', { key, value }).catch((error) => toast(`Could not save workspace preferences: ${error.message}`));
  };
  const narrow = matchMedia('(max-width: 899px)');
  const wide = matchMedia('(min-width: 1280px)');
  let state = { agents: [], edges: [], messageRevision: 0, demo: false }, byId = new Map(), ready = false, connected = false;
  let view = 'session', selectedId = getStorage('synapse-selected') || null, tab = 'conversation', filter = 'all';
  let sidebarOpen = !narrow.matches && getStorage('synapse-sidebar', 'open') === 'open';
  let inspectorOpen = wide.matches && getStorage('synapse-inspector', 'open') === 'open';
  let drafts;
  try { drafts = JSON.parse(getStorage('synapse-drafts', '{}')); if (!drafts || typeof drafts !== 'object') drafts = {}; } catch { drafts = {}; }
  const projectElements = new Map(), worktreeElements = new Map(), sessionElements = new Map(), recentCache = new Map();
  let sidebarDrag = null;
  let storedCollapsed;
  try { storedCollapsed = JSON.parse(getStorage('synapse-collapsed', '[]')); } catch {}
  const collapsed = new Set(Array.isArray(storedCollapsed) ? storedCollapsed : []);
  let sending = false, recentController, recentRequest = 0, recentTarget, recentDirty = false, limit = 60;
  let source, stateFrame = 0, pendingState, toastTimer, draftTimer, flowTimer;
  let composerPaint = null; // set once the composer's highlighting exists; drafts loaded before then repaint on input
  let modalSubmit = null, modalVersion = 0, searchHits = [], searchIndex = 0, renderedMessages = new Map();
  let overviewSignature = '', connectionsSignature = '', inspectorSignature = '';

  function readRoute() {
    const route = location.hash.slice(1);
    if (['overview', 'connections', 'activity', 'canvas'].includes(route)) view = route;
    else if (route.startsWith('agent=')) { view = 'session'; selectedId = new URLSearchParams(route).get('agent'); }
  }
  readRoute();
  if (selectedId) $('message-input').value = drafts[selectedId] || '';

  function syncChildren(parent, desired) {
    let current = parent.firstChild;
    for (const element of desired) {
      if (current === element) current = current.nextSibling;
      else parent.insertBefore(element, current);
    }
    while (current) { const next = current.nextSibling; current.remove(); current = next; }
  }

  function persistDraft() {
    if (paneKey) { if (selectedId) parent.postMessage({ type: 'synapse:pane-draft', id: selectedId, text: $('message-input').value }, location.origin); return; }
    if (selectedId && view === 'session' && !splitActive) drafts[selectedId] = $('message-input').value;
    const entries = Object.entries(drafts).filter(([, text]) => text).slice(-50);
    setStorage('synapse-drafts', JSON.stringify(Object.fromEntries(entries)));
  }

  function setSidebar(open, persist = true) {
    sidebarOpen = open;
    $('workspace').dataset.sidebar = open ? 'open' : 'closed';
    $('sidebar-toggle').setAttribute('aria-expanded', String(open));
    $('sidebar').inert = !open;
    $('main').inert = narrow.matches && open;
    if (persist && !narrow.matches) setStorage('synapse-sidebar', open ? 'open' : 'closed');
  }

  function syncInspector() {
    const visible = inspectorOpen && view === 'session' && !!byId.get(selectedId);
    if (!visible) inspectorFile = null;
    $('inspector').hidden = !visible;
    $('workspace').dataset.inspector = visible ? 'open' : 'closed';
    $('context-toggle').setAttribute('aria-expanded', String(visible));
    if (visible) renderInspector();
  }

  function toast(message, undo) {
    clearTimeout(toastTimer);
    $('toast-text').textContent = message;
    $('toast-action').hidden = !undo;
    $('toast-action').onclick = undo ? async () => { $('toast').hidden = true; try { await undo(); } catch (error) { toast(error.message); } } : null;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, undo ? 9000 : 4000);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'The request failed. Try again.'), { status: response.status });
    return result;
  }

  async function reloadState() {
    const next = await api('/api/state');
    applyState(next);
  }

  function projectGroups() {
    const groups = new Map((desktop?.projects || []).map((p) => [p.key, {
      key: p.key, name: p.label, managed: true, agents: [], worktrees: p.worktrees.map((w) => ({ ...w, managed: true, agents: [] })),
    }]));
    for (const agent of state.agents) {
      if (!groups.has(agent.projectKey)) groups.set(agent.projectKey, { key: agent.projectKey, name: agent.project, agents: [], worktrees: [] });
      const group = groups.get(agent.projectKey);
      group.agents.push(agent);
      const cwd = (agent.worktreePath || agent.cwd || '').replaceAll('\\', '/');
      let worktree = group.worktrees.find((w) => cwd === w.path.replaceAll('\\', '/'))
        || [...group.worktrees].sort((a, b) => b.path.length - a.path.length).find((w) => cwd.startsWith(w.path.replaceAll('\\', '/').replace(/\/$/, '') + '/'));
      if (!worktree) {
        worktree = { path: agent.worktreePath || agent.cwd, name: agent.worktreeName || agent.frameSub || agent.cwd?.split(/[\\/]/).pop() || group.name, home: agent.worktreeHome, agents: [] };
        group.worktrees.push(worktree);
      }
      worktree.agents.push(agent);
    }
    const order = new Map((desktop?.projects || []).map((p, i) => [p.key, i]));
    return [...groups.values()].sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity) || a.name.localeCompare(b.name));
  }

  function sortHandle(item, handle, kind, id, enabled) {
    if (enabled) {
      item.dataset.sortKind = kind; item.dataset.sortId = id;
      handle.dataset.sortHandle = '';
      handle.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    } else {
      delete item.dataset.sortKind; delete item.dataset.sortId; delete handle.dataset.sortHandle;
      handle.removeAttribute('aria-keyshortcuts');
    }
  }

  function renderSidebar() {
    if (sidebarDrag || paneKey) return;
    const groups = projectGroups(), desired = [], live = new Set(), liveWorktrees = new Set();
    const sessionNode = ({ agent, children }, depth = 0) => {
      live.add(agent.id);
      let node = sessionElements.get(agent.id);
      if (!node) {
        node = document.createElement('div'); node.className = 'session-node';
        node.innerHTML = '<button type="button" class="session-row"><span class="session-kind" aria-hidden="true"></span><span class="session-name"></span><span class="session-meta"><span class="status-dot" aria-hidden="true"></span><span class="session-time"></span></span></button><div class="session-children"></div>';
        node.firstElementChild.dataset.agent = agent.id;
        sessionElements.set(agent.id, node);
      }
      const row = node.firstElementChild;
      const dot = row.querySelector('.status-dot');
      dot.classList.toggle('busy', agent.status === 'busy');
      dot.classList.toggle('done', agent.status === 'done');
      dot.classList.toggle('waiting', ['waiting', 'needs_input'].includes(agent.status));
      row.querySelector('.session-name').textContent = agent.name;
      row.querySelector('.session-kind').textContent = KIND_INITIALS[agent.kind] || agent.kind?.slice(0, 2) || '';
      row.querySelector('.session-kind').dataset.kind = agent.kind || '';
      // a running agent shows that it works; a resting one shows how long ago it last did
      row.querySelector('.session-time').textContent = agent.status === 'busy' || agent.exited ? '' : relativeTime(agent.lastActivity);
      row.title = `${agent.name} · ${kindName(agent)} · ${activityLabel(agent)}${agent.owned ? ' · Drag to reorder' : ''}`;
      node.dataset.depth = depth;
      sortHandle(node, row, 'session', agent.id, agent.owned);
      if (view === 'session' && selectedId === agent.id) row.setAttribute('aria-current', 'page'); else row.removeAttribute('aria-current');
      syncChildren(node.lastElementChild, children.map((child) => sessionNode(child, depth + 1)));
      node.lastElementChild.hidden = !children.length;
      return node;
    };
    for (const group of groups) {
      let section = projectElements.get(group.key);
      if (!section) {
        section = document.createElement('section'); section.className = 'project-group'; section.dataset.projectKey = group.key;
        section.innerHTML = `<div class="project-heading"><button class="project-button" type="button"><span class="project-chevron">${icon('chevron-down')}</span>${icon('folder')}<span class="project-name"></span><span class="count"></span></button><button class="project-add desktop-only" type="button" aria-label="Add worktree" title="Add worktree">${icon('plus')}</button></div><div class="project-worktrees"></div>`;
        section.querySelector('.project-button').dataset.project = group.key;
        section.querySelector('.project-add').dataset.createWorktree = group.key;
        projectElements.set(group.key, section);
      }
      const button = section.querySelector('.project-button');
      button.querySelector('.project-name').textContent = group.name;
      button.querySelector('.count').textContent = group.agents.length;
      button.title = group.managed ? `${group.name} · Drag to reorder` : group.name;
      section.querySelector('.project-add').hidden = !group.managed;
      sortHandle(section, button, 'project', group.key, group.managed);
      button.setAttribute('aria-expanded', String(!collapsed.has(group.key)));
      section.lastElementChild.hidden = collapsed.has(group.key);
      const worktrees = group.worktrees.map((worktree) => {
        const key = `worktree:${worktree.path}`;
        liveWorktrees.add(key);
        let node = worktreeElements.get(key);
        if (!node) {
          node = document.createElement('section'); node.className = 'worktree-group'; node.dataset.worktreePath = worktree.path;
          node.innerHTML = `<div class="worktree-heading"><button class="worktree-button" type="button"><span class="worktree-chevron">${icon('chevron-down')}</span><span class="worktree-icon"></span><span class="worktree-name"></span><span class="count"></span></button><button class="worktree-add project-add desktop-only" type="button" aria-label="New session in this worktree" title="New session in this worktree">${icon('plus')}</button></div><div class="worktree-sessions"></div>`;
          node.querySelector('.worktree-button').dataset.worktreeToggle = key;
          node.querySelector('.worktree-add').dataset.newSessionCwd = worktree.path;
          worktreeElements.set(key, node);
        }
        const head = node.querySelector('.worktree-button');
        head.querySelector('.worktree-icon').innerHTML = icon(worktree.home ? 'home' : 'branch');
        head.querySelector('.worktree-name').textContent = worktree.home ? worktree.branch || worktree.name : worktree.branch && worktree.branch !== worktree.name ? `${worktree.name} · ${worktree.branch}` : worktree.name;
        head.querySelector('.count').textContent = worktree.agents.length;
        head.title = `${worktree.path}${worktree.branch ? ` · ${worktree.branch}` : ''}${worktree.managed ? ' · Drag to reorder' : ''}`;
        head.setAttribute('aria-expanded', String(!collapsed.has(key)));
        node.querySelector('.worktree-add').hidden = !worktree.managed;
        sortHandle(node, head, 'worktree', worktree.path, worktree.managed);
        node.lastElementChild.hidden = collapsed.has(key);
        syncChildren(node.lastElementChild, sessionTree(worktree.agents).map((entry) => sessionNode(entry)));
        return node;
      });
      syncChildren(section.lastElementChild, worktrees); desired.push(section);
    }
    for (const [id, node] of sessionElements) if (!live.has(id)) { node.remove(); sessionElements.delete(id); }
    for (const [key, node] of worktreeElements) if (!liveWorktrees.has(key)) { node.remove(); worktreeElements.delete(key); }
    for (const [key, section] of projectElements) if (!groups.some((group) => group.key === key)) { section.remove(); projectElements.delete(key); }
    if (!groups.length) {
      const empty = document.createElement('p'); empty.className = 'sidebar-placeholder';
      empty.textContent = ready ? 'Your projects will appear here.' : 'Finding your sessions…'; desired.push(empty);
    }
    syncChildren($('project-list'), desired);
    $('project-count').textContent = groups.length || '';
    $('connection-count').textContent = state.edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to)).length;
    document.querySelectorAll('[data-view]').forEach((button) => {
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
  }

  const sortableSiblings = (item) => [...item.parentElement.children].filter((node) => node.dataset.sortKind === item.dataset.sortKind);
  async function reorderSidebar(item, target, side) {
    const name = item.firstElementChild.textContent.trim(), other = target.firstElementChild.textContent.trim();
    desktop = await desktopCall('reorder', { kind: item.dataset.sortKind, from: item.dataset.sortId, to: target.dataset.sortId, side });
    $('sidebar-order-status').textContent = `Moved ${name} ${side} ${other}.`;
  }
  $('project-list').addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-sort-handle]'), item = handle?.closest('[data-sort-kind]');
    if (!item || event.button !== 0 || sidebarDrag) return;
    const list = $('project-list'), x0 = event.clientX, y0 = event.clientY;
    let lifted = false, ended = false, frame, items, rects, from, to, step, scroll0;
    let point = { x: x0, y: y0 }, previousY = null;
    sidebarDrag = item;
    handle.setPointerCapture(event.pointerId);
    const follow = () => {
      const dy = point.y - y0 + list.scrollTop - scroll0;
      if (dy === previousY) return;
      previousY = dy; to = from;
      item.style.transform = `translateY(${dy}px)`;
      items.forEach((node, index) => {
        if (index === from) return;
        const middle = (rects[index].top + rects[index].bottom) / 2;
        const shift = index > from && rects[from].bottom + dy > middle ? -step : index < from && rects[from].top + dy < middle ? step : 0;
        if (shift < 0) to = Math.max(to, index);
        if (shift > 0) to = Math.min(to, index);
        const transform = shift ? `translateY(${shift}px)` : '';
        if (node.style.transform !== transform) node.style.transform = transform;
      });
    };
    const tick = () => {
      if (!lifted || ended) return;
      const r = list.getBoundingClientRect();
      if (point.x >= r.left && point.x <= r.right) {
        const dy = point.y < r.top + 32 ? -Math.min(12, (r.top + 32 - point.y) / 3)
          : point.y > r.bottom - 32 ? Math.min(12, (point.y - r.bottom + 32) / 3) : 0;
        if (dy) list.scrollTop += dy;
      }
      follow(); frame = requestAnimationFrame(tick);
    };
    const move = (e) => {
      if (e.pointerId !== event.pointerId) return;
      point = { x: e.clientX, y: e.clientY };
      if (!lifted && Math.hypot(point.x - x0, point.y - y0) < 5) return;
      e.preventDefault();
      if (!lifted) {
        lifted = true; document.body.classList.add('sidebar-sorting');
        items = sortableSiblings(item); from = to = items.indexOf(item); scroll0 = list.scrollTop;
        rects = items.map((node) => node.getBoundingClientRect());
        const gap = from < items.length - 1 ? rects[from + 1].top - rects[from].bottom : from ? rects[from].top - rects[from - 1].bottom : 0;
        step = rects[from].height + gap;
        item.classList.add('sidebar-lifted');
        for (const node of items) if (node !== item) node.classList.add('sidebar-yielding');
        tick();
      }
    };
    const end = async (cancel = false, waitForRelease = false) => {
      if (ended) return;
      ended = true; cancelAnimationFrame(frame);
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', abort);
      removeEventListener('keydown', escape, true); removeEventListener('blur', abort); removeEventListener('resize', abort);
      if (!waitForRelease && handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      try {
        if (lifted) {
          const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
          addEventListener('click', swallow, { once: true, capture: true });
          if (waitForRelease) {
            let finished = false;
            const release = () => {
              if (finished) return; finished = true;
              removeEventListener('pointerup', release, true); removeEventListener('blur', release);
              handle.removeEventListener('lostpointercapture', release);
              if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
              setTimeout(() => removeEventListener('click', swallow, true), 0);
            };
            addEventListener('pointerup', release, { once: true, capture: true }); addEventListener('blur', release, { once: true });
            handle.addEventListener('lostpointercapture', release, { once: true });
          } else setTimeout(() => removeEventListener('click', swallow, true), 0);
          const r = list.getBoundingClientRect();
          const inside = point.x >= r.left && point.x <= r.right && point.y >= r.top - 8 && point.y <= r.bottom + 8;
          const offset = !cancel && inside && to > from ? rects[to].bottom - rects[from].bottom : !cancel && inside && to < from ? rects[to].top - rects[from].top : 0;
          item.classList.add('sidebar-settling'); item.style.transform = `translateY(${offset}px)`;
          if (!matchMedia('(prefers-reduced-motion: reduce)').matches) await new Promise((resolve) => setTimeout(resolve, 150));
          if (!cancel && inside && to !== from) await reorderSidebar(item, items[to], to > from ? 'after' : 'before');
        }
      } catch (error) { toast(error.message); }
      finally {
        for (const node of items || []) { node.style.removeProperty('transform'); node.classList.remove('sidebar-lifted', 'sidebar-yielding', 'sidebar-settling'); }
        document.body.classList.remove('sidebar-sorting'); sidebarDrag = null; applyState(rawState);
      }
    };
    const up = (e) => {
      if (e.pointerId !== event.pointerId) return;
      point = { x: e.clientX, y: e.clientY };
      if (lifted) follow();
      end();
    };
    const abort = () => end(true);
    const escape = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); end(true, true); } };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', abort);
    addEventListener('keydown', escape, true); addEventListener('blur', abort); addEventListener('resize', abort);
  });
  $('project-list').addEventListener('keydown', async (event) => {
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || sidebarDrag) return;
    const handle = event.target.closest('[data-sort-handle]'), item = handle?.closest('[data-sort-kind]');
    if (!item) return;
    const siblings = sortableSiblings(item), to = siblings.indexOf(item) + (event.key === 'ArrowUp' ? -1 : 1);
    if (!siblings[to]) return;
    event.preventDefault(); event.stopPropagation();
    try { await reorderSidebar(item, siblings[to], event.key === 'ArrowUp' ? 'before' : 'after'); applyState(rawState); handle.focus(); }
    catch (error) { toast(error.message); }
  });

  function navigate(nextView, id = null, push = true) {
    if (paneKey && nextView === 'session' && id !== selectedId) { persistDraft(); parent.postMessage({ type: 'synapse:pane-navigate', id }, location.origin); return; }
    persistDraft();
    recentController?.abort(); recentTarget = null; recentRequest++;
    view = nextView; selectedId = nextView === 'session' ? id : selectedId;
    tab = 'conversation'; limit = 60;
    if (nextView === 'session') {
      setStorage('synapse-selected', id);
      $('message-input').value = drafts[id] || '';
    }
    if (push) {
      const route = nextView === 'session' ? `agent=${encodeURIComponent(id)}` : nextView;
      if (location.hash !== `#${route}`) history.pushState({ view: nextView, id: selectedId }, '', `#${route}`);
    }
    if (narrow.matches) setSidebar(false, false);
    renderSidebar(); renderMain(true); resizeComposer();
    if (nextView === 'session' && byId.get(id)?.owned) desktopCall('select', { id }).catch((e) => toast(e.message));
  }

  function emptyState(title, description, action = '', actionLabel = '', symbol = 'message') {
    return `<div class="empty-state"><span data-icon="${symbol}">${icon(symbol)}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p>${action ? `<button class="button secondary" data-action="${action}">${escapeHtml(actionLabel)}</button>` : ''}</div>`;
  }

  function sendPaneState(frame) {
    if (desktop) frame.contentWindow?.postMessage({ type: 'synapse:pane-state', desktop, state: rawState, drafts, connected, id: frame.dataset.agentId }, location.origin);
  }

  function renderSplits(isSession) {
    if (paneKey) return false;
    const layout = desktop?.layout;
    if (!isSession) { $('split-view').hidden = true; return false; }
    if (!layout?.direction) {
      for (const frame of paneFrames.values()) frame.remove();
      paneFrames.clear(); $('split-view').replaceChildren(); $('split-view').hidden = true;
      return false;
    }
    const ids = (node) => !node ? [] : node.id ? [node.id] : [...ids(node.first), ...ids(node.second)];
    if (!ids(layout).includes(selectedId)) { $('split-view').hidden = true; return false; }
    const live = new Set();
    const build = (node, host) => {
      if (!node) return;
      if (node.id) {
        live.add(node.key);
        let frame = paneFrames.get(node.key);
        if (!frame) {
          frame = document.createElement('iframe'); frame.className = 'split-pane'; frame.title = 'Session conversation';
          frame.dataset.paneKey = node.key;
          frame.src = `/?desktop=1&pane=${encodeURIComponent(node.key)}#agent=${encodeURIComponent(node.id)}`;
          paneFrames.set(node.key, frame);
        }
        frame.dataset.agentId = node.id;
        frame.classList.toggle('active-pane', node.id === selectedId);
        if (frame.parentElement !== host) host.appendChild(frame);
        for (const child of [...host.children]) if (child !== frame) child.remove();
        sendPaneState(frame);
      } else {
        let group = host.firstElementChild;
        if (!group?.classList.contains('split-group')) { group = document.createElement('div'); group.className = 'split-group'; host.prepend(group); }
        group.dataset.direction = node.direction;
        while (group.children.length < 2) group.appendChild(document.createElement('div'));
        build(node.first, group.children[0]); build(node.second, group.children[1]);
        for (const child of [...host.children]) if (child !== group) child.remove();
      }
    };
    build(layout, $('split-view'));
    for (const [key, frame] of paneFrames) if (!live.has(key)) { frame.remove(); paneFrames.delete(key); }
    $('split-view').hidden = false;
    return true;
  }

  function renderMain(reset = false) {
    const agent = byId.get(selectedId), isSession = view === 'session' && agent;
    if (!paneKey && !splitActive && isSession && desktop?.layout?.direction && !$('thread-view').hidden) persistDraft();
    const split = splitActive = renderSplits(isSession && agent.owned);
    if (embedded && !paneKey && reportedView !== view) { reportedView = view; desktopCall('view', { view }).catch((e) => toast(e.message)); }
    $('thread-view').hidden = !isSession || split;
    $('overview-view').hidden = view !== 'overview';
    $('connections-view').hidden = view !== 'connections';
    $('activity-view').hidden = view !== 'activity';
    $('canvas-view').hidden = view !== 'canvas';
    $('session-actions').hidden = !isSession;
    if (isSession) {
      const breadcrumbs = `<span class="crumb-title">${escapeHtml(agent.name)}</span><span class="crumb-project">${escapeHtml(agent.project)}</span>`;
      if ($('breadcrumbs').innerHTML !== breadcrumbs) $('breadcrumbs').innerHTML = breadcrumbs;
      $('session-status').innerHTML = `${status(agent)}${activityLabel(agent)}`;
      $('provider-label').innerHTML = `${avatar(agent)}<span>${escapeHtml(kindName(agent))}</span>`;
      $('provider-label').title = `${agent.name} runs ${kindName(agent)} in ${agent.cwd || agent.project}`;
      if (embedded) {
        for (const id of ['open-terminal', 'fork-session', 'session-menu']) $(id).hidden = !agent.owned;
        $('fork-session').disabled = !['claude', 'codex'].includes(agent.kind) && !state.demo;
      }
      $('delivery-note').textContent = agent.owned ? 'Sent directly to this session. Open Terminal mode for interactive prompts and approvals.' : 'Delivered on the agent’s next prompt or inbox check.';
      $('conversation-tab').setAttribute('aria-selected', String(tab === 'conversation'));
      $('messages-tab').setAttribute('aria-selected', String(tab === 'messages'));
      $('conversation-tab').tabIndex = tab === 'conversation' ? 0 : -1;
      $('messages-tab').tabIndex = tab === 'messages' ? 0 : -1;
      $('thread-scroll').setAttribute('aria-labelledby', tab === 'messages' ? 'messages-tab' : 'conversation-tab');
      if (reset) { $('message-input').value = drafts[selectedId] || ''; $('send-error').hidden = true; }
      if (!split) { updateComposer(); renderTimeline(reset); loadRecent(); }
      document.title = `${agent.name} · Synapse`;
    } else {
      const title = view === 'activity' ? 'Activity' : view === 'canvas' ? 'Canvas' : view === 'connections' ? 'Connections' : 'Your workspace';
      $('breadcrumbs').textContent = title;
      document.title = `${title} · Synapse`;
      if (view === 'canvas') { if (!$('gui-canvas').src) $('gui-canvas').src = '/canvas'; }
      else if (view === 'activity') activityView.refresh();
      else if (view === 'connections') renderConnections(); else renderOverview();
    }
    syncInspector();
  }

  function renderOverview() {
    const signature = JSON.stringify([filter, state.agents.map((agent) => [agent.id, agent.name, agent.status, agent.preview, agent.lastActivity]), Math.floor(Date.now() / 60000)]);
    if (overviewSignature === signature) return;
    overviewSignature = signature;
    const busy = state.agents.filter((agent) => agent.status === 'busy').length;
    const groups = projectGroups();
    $('overview-summary').textContent = state.agents.length ? `${state.agents.length} live ${state.agents.length === 1 ? 'session' : 'sessions'} across ${groups.length} ${groups.length === 1 ? 'project' : 'projects'}. All on your machine.` : 'Bring your coding agents together, one project at a time.';
    $('all-count').textContent = state.agents.length; $('busy-count').textContent = busy;
    document.querySelectorAll('[data-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.filter === filter)));
    const html = groups.map((group) => {
      const agents = group.agents.filter((agent) => filter === 'all' || (filter === 'busy' ? agent.status === 'busy' : agent.status !== 'busy'));
      if (!agents.length) return '';
      return `<section class="overview-project"><h2>${icon('folder')}${escapeHtml(group.name)}<span class="count">${agents.length}</span></h2>${agents.map((agent) => `<button class="overview-row" data-agent="${escapeHtml(agent.id)}">${avatar(agent)}<span class="overview-session"><strong>${escapeHtml(agent.name)}</strong><span>${escapeHtml(agent.preview || `${kindName(agent)} session`)}</span></span><span class="overview-meta"><span class="status-label">${status(agent)}${activityLabel(agent)}</span><time>${relativeTime(agent.lastActivity)}</time></span></button>`).join('')}</section>`;
    }).join('');
    $('overview-list').innerHTML = html || (state.agents.length ? emptyState('Nothing in this view', `No ${filter === 'busy' ? 'working' : 'idle'} sessions right now. Your other sessions are still in the sidebar.`, 'show-all', 'Show all sessions', 'grid') : emptyState('Your next project starts here', 'Open a coding agent in any project. It will appear here, ready to connect with the rest of your workspace.', 'connect', 'Connect an agent', 'network'));
  }

  function relations(id) {
    const peers = new Map();
    for (const edge of state.edges) {
      const other = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
      if (!other || !byId.has(other)) continue;
      if (!peers.has(other)) peers.set(other, { agent: byId.get(other), reads: false, shares: false, edges: [] });
      const peer = peers.get(other); peer.reads ||= edge.to === id; peer.shares ||= edge.from === id; peer.edges.push(edge);
    }
    return [...peers.values()];
  }

  // Paths in a reply become links once the server confirms them; they open in the right-hand pane
  const fileSeen = new Map(); // cwd + path -> exists
  async function linkFiles(elements, cwd) {
    const nodes = [];
    for (const element of elements) {
      const walk = document.createTreeWalker(element.querySelector('.message-body') || element, NodeFilter.SHOW_TEXT,
        { acceptNode: (n) => n.parentElement.closest('a, pre, .file-link, .slash-cmd, .mention') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      while (walk.nextNode()) nodes.push(walk.currentNode);
    }
    const hits = nodes.map((n) => filePaths(n.data));
    const unknown = [...new Set(hits.flat().map((h) => h.path))].filter((t) => !fileSeen.has(cwd + '\0' + t));
    if (unknown.length) {
      const found = await api('/api/files/exists', { method: 'POST', body: JSON.stringify({ cwd, paths: unknown }) }).catch(() => null);
      if (!found) return;
      for (const t of unknown) fileSeen.set(cwd + '\0' + t, !!found[t]);
    }
    nodes.forEach((n, k) => {
      const ms = hits[k].filter((h) => fileSeen.get(cwd + '\0' + h.path));
      if (!ms.length || !n.isConnected) return;
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const m of ms) {
        frag.append(n.data.slice(at, m.index));
        const link = document.createElement('button');
        link.type = 'button'; link.className = 'file-link'; link.dataset.file = m.path; link.dataset.cwd = cwd || ''; link.textContent = m.path; link.title = `Open ${m.path}`;
        frag.append(link); at = m.index + m.path.length;
      }
      frag.append(n.data.slice(at));
      n.replaceWith(frag);
    });
  }

  let inspectorFile = null, fileRequest = 0; // { agent, path, cwd, mode, stack }
  const fileSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
  function openFile(path, cwd, { back = false } = {}) {
    if (!byId.get(selectedId)) return;
    const stack = back ? inspectorFile.stack : [...(inspectorFile?.agent === selectedId ? inspectorFile.stack : []), { path, cwd }];
    inspectorFile = { agent: selectedId, path, cwd, mode: null, stack };
    inspectorOpen = true; syncInspector();
  }
  async function renderFile() {
    const pane = $('inspector'), file = inspectorFile, request = ++fileRequest;
    pane.classList.add('file-mode');
    const lineMatch = String(file.path).match(/(?::(\d+)(?:-(\d+))?(?::\d+)?|#L(\d+)(?:-L?(\d+))?)$/);
    const from = lineMatch ? +(lineMatch[1] || lineMatch[3]) : 0, to = lineMatch ? +(lineMatch[2] || lineMatch[4] || from) : 0;
    let f;
    try { f = await api(`/api/file?${new URLSearchParams({ path: file.path, cwd: file.cwd || '' })}`); }
    catch (error) { f = { error: error.message }; }
    if (request !== fileRequest || inspectorFile !== file) return;
    const head = (title, sub, tools = '') => `<div class="inspector-heading file-heading">${file.stack.length > 1 ? `<button class="icon-button" data-file-act="back" aria-label="Back" title="Back">${icon('arrow-left')}</button>` : ''}<div class="file-title"><h2>${escapeHtml(title)}</h2>${sub ? `<span>${escapeHtml(sub)}</span>` : ''}</div><button class="text-button" data-file-act="details">Details</button><button class="icon-button" data-action="close-inspector" aria-label="Close file" title="Close">${icon('x')}</button></div>${tools}`;
    if (f.error) { pane.innerHTML = head(file.path.split('/').pop(), file.path) + `<p class="inspector-note">Synapse can't open this file: ${escapeHtml(f.error)}</p>`; return; }
    const raw = `/api/file/raw?${new URLSearchParams({ path: f.path })}`;
    const isMd = f.type === 'text' && /^(md|markdown|mdx)$/.test(f.ext);
    const mode = file.mode || (isMd && !from ? 'rendered' : 'source');
    const lines = f.type === 'text' ? f.text.split('\n') : [];
    const facts = [f.type === 'dir' ? `${f.entries.length} items` : f.type === 'text' ? `${lines.length} lines` : f.ext || f.type, f.type !== 'dir' && fileSize(f.size), `edited ${relativeTime(f.mtime)} ago`, f.truncated && 'first 1 MB'].filter(Boolean);
    const tools = `<div class="file-tools"><span>${facts.map(escapeHtml).join(' · ')}</span>${isMd ? `<button class="text-button" data-file-act="mode">${mode === 'rendered' ? 'Source' : 'Preview'}</button>` : ''}<button class="text-button" data-file-act="open">Open</button><button class="text-button" data-file-act="reveal">Show in Finder</button><button class="text-button" data-file-act="copy">Copy path</button></div>`;
    let body;
    if (f.type === 'dir') body = `<div class="file-dir">${f.entries.map((e) => `<button type="button" class="file-link" data-file="${escapeHtml(`${f.path}/${e.name}`)}">${escapeHtml(e.name)}${e.dir ? '/' : ''}</button>`).join('') || '<p class="inspector-note">Empty folder.</p>'}</div>`;
    else if (f.type === 'image') body = `<div class="file-media"><img src="${raw}" alt="${escapeHtml(f.name)}"></div>`;
    else if (f.type === 'video' || f.type === 'audio') body = `<div class="file-media"><${f.type} src="${raw}" controls></${f.type}></div>`;
    else if (f.type === 'pdf') body = `<iframe class="file-pdf" src="${raw}" title="${escapeHtml(f.name)}"></iframe>`;
    else if (f.type === 'binary') body = `<p class="inspector-note">Binary file. Open it in its own app instead.</p>`;
    else if (mode === 'rendered') body = `<div class="file-md md">${renderMarkdown(f.text)}</div>`;
    else body = `<div class="file-source">${lines.slice(0, 20000).map((l, i) => `<div class="file-line${i + 1 >= from && i + 1 <= to ? ' hit' : ''}"><span>${i + 1}</span><code>${escapeHtml(l) || ' '}</code></div>`).join('')}</div>`;
    const dir = f.type === 'dir' ? f.path : f.path.replace(/\/[^/]*$/, '');
    const root = (file.cwd || '').replace(/\/+$/, ''), inside = root && (dir === root || dir.startsWith(`${root}/`));
    pane.innerHTML = head(f.name + (f.type === 'dir' ? '/' : ''), inside ? `${root.split('/').pop()}${dir.slice(root.length)}/` : dir.replace(/^\/Users\/[^/]+/, '~'), tools) + body;
    pane.dataset.filePath = f.path;
    const hit = pane.querySelector('.file-line.hit');
    if (hit) hit.scrollIntoView({ block: 'center' });
    else pane.scrollTop = 0;
  }
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-file]');
    if (link) { event.preventDefault(); openFile(link.dataset.file, link.dataset.cwd || inspectorFile?.cwd || byId.get(selectedId)?.cwd); return; }
    const act = event.target.closest('[data-file-act]')?.dataset.fileAct;
    if (!act || !inspectorFile) return;
    const path = $('inspector').dataset.filePath;
    if (act === 'details') { inspectorFile = null; syncInspector(); }
    else if (act === 'back') { inspectorFile.stack.pop(); const prev = inspectorFile.stack.at(-1); openFile(prev.path, prev.cwd, { back: true }); }
    else if (act === 'mode') { inspectorFile.mode = event.target.textContent === 'Source' ? 'source' : 'rendered'; renderInspector(); }
    else if (act === 'copy') navigator.clipboard.writeText(path).then(() => toast('Path copied.'), () => toast(path));
    else if (path) api('/api/file/open', { method: 'POST', body: JSON.stringify({ path, reveal: act === 'reveal' }) }).catch((error) => toast(error.message));
  });

  function renderInspector() {
    const agent = byId.get(selectedId); if (!agent) return;
    if (inspectorFile?.agent === selectedId) {
      const key = `file:${JSON.stringify([inspectorFile.path, inspectorFile.mode, inspectorFile.stack.length])}`;
      if (key !== inspectorSignature) { inspectorSignature = key; renderFile(); }
      return;
    }
    inspectorFile = null; $('inspector').classList.remove('file-mode'); delete $('inspector').dataset.filePath;
    const peers = relations(agent.id), chat = recentCache.get(agent.id)?.data.chat || [];
    const signature = JSON.stringify([agent.id, agent.name, agent.status, agent.lastActivity, peers, chat.slice(-3), Math.floor(Date.now() / 60000)]);
    if (signature === inspectorSignature) return;
    inspectorSignature = signature;
    $('inspector').innerHTML = `<div class="inspector-heading"><h2>Session details</h2><button class="icon-button" data-action="close-inspector" aria-label="Close session details">${icon('x')}</button></div>
      <section class="inspector-section"><div class="session-summary">${avatar(agent)}<div><strong>${escapeHtml(agent.name)}</strong><span class="session-provider">${escapeHtml(kindName(agent))}</span></div></div><div class="detail-row"><span>Status</span><span class="status-label">${status(agent)}${activityLabel(agent)}</span></div><div class="detail-row"><span>Last activity</span><span>${relativeTime(agent.lastActivity) === 'now' ? 'Just now' : `${relativeTime(agent.lastActivity)} ago`}</span></div><div class="folder-path">${icon('folder')}<span>${escapeHtml(agent.cwd)}</span></div></section>
      <section class="inspector-section"><div class="inspector-title-row"><h3 class="inspector-label">Connected agents</h3><span class="count">${peers.length}</span></div>${peers.map((peer) => `<div class="connection-row">${avatar(peer.agent)}<button class="connection-info" data-agent="${escapeHtml(peer.agent.id)}"><strong>${escapeHtml(peer.agent.name)}</strong><span>${icon(peer.reads && peer.shares ? 'arrows' : peer.reads ? 'arrow-left' : 'arrow-right')}${peer.reads && peer.shares ? 'Two-way context' : peer.reads ? 'Reads context from' : 'Shares context with'}</span></button><button class="icon-button unlink-button" data-remove-links="${peer.edges.map((edge) => escapeHtml(edge.id)).join(',')}" aria-label="Disconnect ${escapeHtml(peer.agent.name)}" title="Disconnect">${icon('unlink')}</button></div>`).join('')}<button class="add-context" data-action="add-connection">${icon('plus')}Add connection</button><p class="inspector-note">Linked agents can share context and message each other across tools.</p></section>
      <section class="inspector-section"><h3 class="inspector-label">Recent messages</h3>${chat.slice(-3).reverse().map((message) => `<div class="recent-note"><strong>${icon('message')}${escapeHtml(message.fromName === 'You' ? 'You' : message.fromName)}</strong><p>${escapeHtml(message.text)}</p></div>`).join('') || '<p class="inspector-note">Messages between agents will appear here.</p>'}${chat.length ? '<button class="text-button" data-action="show-messages">View messages ' + icon('arrow-right') + '</button>' : ''}</section>`;
  }

  // Friends under Connections: what waits on you (accept picks which of your agents), what waits on them, and
  // what is shared already. Loaded from the desktop app; redrawn when its requests change.
  async function renderFriendsList(reload = false) {
    const box = $('friends-list'); if (!box || view !== 'connections') return;
    if (!embedded) { box.innerHTML = ''; return; }
    try { if (reload || !friends) await loadFriends(); } catch (error) { box.innerHTML = `<p class="inspector-note">${escapeHtml(error.message)}</p>`; return; }
    if (!friends.signedIn) { box.innerHTML = `<div class="friends-heading"><h2>Friends</h2></div><div class="connections-explainer">${icon('network')}Sign in to share agents with people you trust and ask for theirs.<button class="button secondary" data-action="friends-sign-in">Sign in</button></div>`; return; }
    const name = (x) => escapeHtml(x?.name || x?.handle || 'Someone');
    const ag = (a) => a ? `<strong>${escapeHtml(a.name || '?')}</strong> <small>${escapeHtml(a.kind || 'agent')}${a.project ? ` · ${escapeHtml(a.project)}` : ''}</small>` : 'an agent';
    const mine = (pick, multi) => `<select class="field friend-pick" aria-label="Which of your agents">${friends.agents.map((a) => `<option value="${escapeHtml(a.id)}"${a.id === pick ? ' selected' : ''}>${escapeHtml(a.name)} · ${escapeHtml(kindName(a))}</option>`).join('')}${multi && friends.agents.length > 1 ? '<option value="*">All live agents</option>' : ''}</select>`;
    const incoming = friends.incoming.map((r) => `<div class="friend-card" data-request="${escapeHtml(r.id)}" data-kind="${r.kind}"><p>${r.kind === 'offer' ? `${name(r.from)} wants to give you access to ${ag(r.agent)}, ${r.mode === 'talk' ? 'read and ask' : 'read only'}.` : `${name(r.from)} asks for one of your agents, into ${ag(r.agent)}.`}${r.target || r.note ? `<span class="friend-note">${escapeHtml([r.target && `For: ${r.target}`, r.note].filter(Boolean).join(' · '))}</span>` : ''}</p>
      <div class="friend-actions">${friends.agents.length ? `<label>${r.kind === 'offer' ? 'Into' : 'Share'} ${mine(r.kind === 'offer' ? mineId(selectedId) : r.best || mineId(selectedId), r.kind !== 'offer')}</label>` : '<span class="inspector-note">Start an agent to accept.</span>'}${r.kind === 'ask' ? '<label class="friend-talk"><input type="checkbox" checked> Let their agent ask questions</label>' : ''}<button class="button secondary" data-friend-deny="${escapeHtml(r.id)}">Decline</button><button class="button" data-friend-accept="${escapeHtml(r.id)}"${friends.agents.length ? '' : ' disabled'}>Accept</button></div></div>`).join('');
    const outgoing = friends.outgoing.map((r) => `<div class="friend-card wait"><p>${r.kind === 'offer' ? `You invited ${name(r.to)} to ${ag(r.agent)}.` : `You asked ${name(r.to)} for ${escapeHtml(r.target || 'an agent')}, into ${ag(r.agent)}.`} <span class="friend-note">Waiting for them to accept.</span></p><div class="friend-actions"><button class="button secondary" data-friend-cancel="${escapeHtml(r.id)}">Withdraw</button></div></div>`).join('');
    const links = friends.links.map((l) => `<div class="friend-card shared"><p>${l.direction === 'in' ? `${escapeHtml(l.owner || 'A friend')}'s <strong>${escapeHtml(l.agent?.name || 'agent')}</strong> ${icon('arrow-right')} your <strong>${escapeHtml(l.local?.name || 'agent')}</strong>` : `Your <strong>${escapeHtml(l.local?.name || 'agent')}</strong> ${icon('arrow-right')} ${escapeHtml(l.owner || 'a friend')}'s <strong>${escapeHtml(l.agent?.name || 'agent')}</strong>`} <span class="friend-note">${l.mode === 'talk' ? 'read and ask' : 'read only'}</span></p></div>`).join('');
    box.innerHTML = `<div class="friends-heading"><h2>Friends</h2><button class="button secondary" data-action="friend-connection">${icon('plus')}Share or ask</button></div>
      ${incoming ? `<h3 class="friends-sub">Waiting for you</h3>${incoming}` : ''}${outgoing ? `<h3 class="friends-sub">Waiting for them</h3>${outgoing}` : ''}
      ${links ? `<h3 class="friends-sub">Shared</h3>${links}` : ''}${incoming || outgoing || links ? '' : `<p class="inspector-note">Nothing shared with friends yet. Share one of your agents, or ask a friend for one of theirs.</p>`}`;
  }
  async function answerFriend(button, kind) {
    const card = button.closest('.friend-card'), id = button.dataset.friendAccept || button.dataset.friendDeny || button.dataset.friendCancel;
    button.disabled = true;
    try {
      if (kind === 'cancel') await desktopCall('friend-cancel', { id });
      else if (kind === 'deny') await desktopCall('friend-deny', { id });
      else if (card.dataset.kind === 'offer') await desktopCall('friend-accept-offer', { id, receiver: card.querySelector('.friend-pick').value });
      else {
        const pick = card.querySelector('.friend-pick').value;
        await desktopCall('friend-accept', { id, agents: pick === '*' ? friends.agents.map((a) => a.id) : [pick], talk: card.querySelector('.friend-talk input')?.checked !== false });
      }
      toast(kind === 'cancel' ? 'Withdrawn.' : kind === 'deny' ? 'Declined.' : 'Accepted. Their agent is connected.');
      renderFriendsList(true);
    } catch (error) { toast(error.message); if (button.isConnected) button.disabled = false; }
  }

  function renderConnections() {
    renderFriendsList();
    const liveEdges = state.edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to));
    const signature = JSON.stringify([liveEdges, state.agents.map((agent) => [agent.id, agent.name])]);
    if (signature === connectionsSignature) return;
    connectionsSignature = signature;
    const pairs = new Map();
    for (const edge of liveEdges) {
      const key = [edge.from, edge.to].sort().join(':');
      if (!pairs.has(key)) pairs.set(key, { from: byId.get(edge.from), to: byId.get(edge.to), edges: [] });
      pairs.get(key).edges.push(edge);
    }
    $('new-connection').disabled = false; // a friend connection needs only one agent
    $('connections-list').innerHTML = pairs.size ? `<div class="connections-explainer">${icon('network')}An arrow points toward the agent receiving context. Two arrows share it both ways.</div>${[...pairs.values()].map((pair) => `<div class="connection-card"><button class="connection-endpoint" data-agent="${escapeHtml(pair.from.id)}">${avatar(pair.from)}<span><strong>${escapeHtml(pair.from.name)}</strong><small>${escapeHtml(kindName(pair.from))}</small></span></button><span class="connection-arrow" aria-label="${pair.edges.length > 1 ? 'Two-way context' : 'Shares context with'}">${icon(pair.edges.length > 1 ? 'arrows' : 'arrow-right')}</span><button class="connection-endpoint" data-agent="${escapeHtml(pair.to.id)}">${avatar(pair.to)}<span><strong>${escapeHtml(pair.to.name)}</strong><small>${escapeHtml(kindName(pair.to))}</small></span></button><button class="icon-button" data-remove-links="${pair.edges.map((edge) => escapeHtml(edge.id)).join(',')}" aria-label="Remove connection between ${escapeHtml(pair.from.name)} and ${escapeHtml(pair.to.name)}" title="Remove connection">${icon('unlink')}</button></div>`).join('')}` : emptyState('Give your agents a little context', 'Connect two live sessions to let them read each other’s work and exchange messages.', state.agents.length > 1 ? 'add-connection' : 'connect', state.agents.length > 1 ? 'Add connection' : 'Connect an agent', 'network');
  }

  function messageRecords(data) {
    const conversation = (data.messages || []).map((message, index) => ({ ...message, type: 'transcript', time: new Date(message.ts).getTime() || 0, key: `transcript-${message.ts}-${index}-${hash(message.text)}` }));
    const messages = (data.chat || []).map((message) => ({ ...message, type: 'shared', time: message.t, key: message.id || `shared-${message.t}-${hash(message.text)}`, human: message.from === 'synapse-user' }));
    return (tab === 'messages' ? messages : [...conversation, ...messages.filter((message) => message.human)]).sort((a, b) => a.time - b.time);
  }

  function renderTimeline(reset = false) {
    const agent = byId.get(selectedId), cached = recentCache.get(selectedId), list = $('message-list'), scroller = $('thread-scroll');
    if (!agent) return;
    if (!cached) {
      list.innerHTML = '<div class="thread-loading"><span class="spinner" aria-hidden="true"></span>Loading conversation…</div>';
      list.dataset.signature = ''; scroller.setAttribute('aria-busy', 'true'); return;
    }
    scroller.setAttribute('aria-busy', 'false');
    const data = cached.data, records = messageRecords(data);
    if (tab === 'conversation' && typeof data.terminal === 'string') {
      const signature = selectedId + ':' + hash(data.terminal);
      if (list.dataset.signature !== signature || reset) {
        const bottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
        list.dataset.signature = signature;
        list.innerHTML = `<div class="terminal-transcript-heading"><span>Live terminal output</span><button class="text-button" data-action="desktop-terminal">Open Terminal ${icon('external')}</button></div><pre class="terminal-transcript">${escapeHtml(data.terminal || 'Session starting…')}</pre>`;
        if (bottom || reset) scroller.scrollTop = scroller.scrollHeight;
      }
      $('message-count').textContent = '0';
      return;
    }
    $('message-count').textContent = data.chat?.length || 0;
    $('messages-tab').setAttribute('aria-label', `Messages (${data.chat?.length || 0})`);
    const signature = JSON.stringify([selectedId, tab, limit, records.map((record) => [record.key, record.delivered]), data.hasMore, agent.name]);
    if (list.dataset.signature === signature && !reset) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90, previousTop = scroller.scrollTop;
    list.dataset.signature = signature;
    renderedMessages = new Map(records.map((record) => [record.key, record]));
    if (!records.length) {
      list.innerHTML = tab === 'messages' ? emptyState('The conversation starts with a connection', 'Messages sent here and between linked agents appear in this view.', 'add-connection', 'Connect an agent', 'message') : emptyState('This session is ready to connect', agent.transcript ? 'Waiting for the first conversation entry. You can connect another agent or leave a message below.' : 'A readable transcript isn’t available for this agent yet. You can still share context and send messages.', 'add-connection', 'Add connection', 'message');
      $('jump-latest').hidden = true; return;
    }
    const existing = new Map([...list.querySelectorAll('[data-message-key]')].map((element) => [element.dataset.messageKey, element]));
    const desired = [];
    const date = records.find((record) => record.time)?.time;
    let dateHeader = list.querySelector('.thread-date');
    if (!dateHeader) { dateHeader = document.createElement('p'); dateHeader.className = 'thread-date'; }
    dateHeader.textContent = date && new Date(date).toDateString() !== new Date().toDateString() ? new Date(date).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : 'Today';
    desired.push(dateHeader);
    if (tab === 'conversation' && data.hasMore && limit < 200) {
      const load = document.createElement('button'); load.className = 'text-button'; load.dataset.action = 'load-older'; load.textContent = 'Load earlier messages'; desired.push(load);
    }
    const fresh = [];
    for (const message of records) {
      const user = message.role === 'user' || message.human, tool = message.tool;
      const messageSignature = `${message.key}:${message.delivered}:${agent.name}`;
      let element = existing.get(message.key);
      if (!element) { element = document.createElement(tool ? 'details' : 'article'); element.dataset.messageKey = message.key; }
      if (element.dataset.signature !== messageSignature) {
        element.dataset.signature = messageSignature;
        fresh.push(element);
        const time = message.time ? new Date(message.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        if (tool) {
          // one quiet line per tool call; opening it shows the full call when the line had to clip it
          const t = toolSummary(message.text) || { verb: 'Used a tool', icon: 'tool', what: message.text.replace(/^\[|\]$/g, '') };
          element.className = 'tool-message';
          element.innerHTML = `<summary>${toolRow(t)}${icon('chevron-right')}</summary><pre>${escapeHtml(message.text.replace(/^\[|\]$/g, ''))}</pre>`;
        } else {
          const peer = message.type === 'shared' && !message.human;
          element.className = `message ${user ? 'user' : peer ? 'peer' : 'assistant'}`;
          const sender = peer ? byId.get(message.from) || { kind: '' } : agent;
          const delivery = message.human ? `<span class="queued-label">${icon(message.delivered ? 'check' : 'clock')}${message.delivered ? 'Picked up by agent' : 'Queued for next prompt'}</span>` : '';
          // replies read as plain prose under your prompt; only agent-to-agent notes say who wrote them
          element.innerHTML = `${peer ? `<header class="message-head">${avatar(sender)}<span>${escapeHtml(message.fromName)}</span>${icon('arrow-right')}<span>${escapeHtml(message.toName)}</span>${time ? `<time>${time}</time>` : ''}</header>` : ''}<div class="message-body md">${messageBody(message.text, user, message.type === 'transcript')}</div><footer class="message-foot">${delivery}${!peer && time ? `<time>${time}</time>` : ''}<button class="icon-button" data-copy-message aria-label="Copy message" title="Copy message">${icon('copy')}</button></footer>`;
        }
      }
      desired.push(element);
    }
    syncChildren(list, desired);
    if (fresh.length) linkFiles(fresh, agent.cwd);
    if (reset || nearBottom) { scroller.scrollTop = scroller.scrollHeight; $('jump-latest').hidden = true; }
    else { scroller.scrollTop = previousTop; $('jump-latest').hidden = false; }
  }

  async function loadRecent(force = false) {
    const agent = byId.get(selectedId); if (view !== 'session' || !agent || (!paneKey && paneFrames.size && !$('split-view').hidden)) return;
    const cached = recentCache.get(agent.id), revision = state.messageRevision, activity = agent.lastActivity;
    if (!force && cached?.activity === activity && cached?.revision === revision && cached?.limit === limit && cached?.backend === agent.backendId && cached?.transcript === agent.transcript) return; // a new session's transcript is found after it starts
    if (recentTarget === agent.id) { recentDirty = true; return; }
    recentController?.abort(); recentController = new AbortController();
    const request = ++recentRequest, id = agent.id, requestedLimit = limit;
    recentTarget = id; recentDirty = false;
    try {
      const data = agent.owned && !agent.backendId
        ? await desktopCall('output', { id })
        : await api(`/api/agents/${encodeURIComponent(agent.backendId || id)}/recent?limit=${requestedLimit}`, { signal: recentController.signal });
      if (agent.owned && !data.messages?.length && !data.chat?.length) Object.assign(data, await desktopCall('output', { id }));
      recentCache.delete(id); recentCache.set(id, { data, activity, revision, limit: requestedLimit, backend: agent.backendId, transcript: agent.transcript });
      if (paneKey) parent.postMessage({ type: 'synapse:pane-recent', id, cached: recentCache.get(id) }, location.origin);
      if (recentCache.size > 30) recentCache.delete(recentCache.keys().next().value);
      if (request === recentRequest && selectedId === id && view === 'session') { renderTimeline(); renderInspector(); }
    } catch (error) {
      if (error.name !== 'AbortError' && request === recentRequest && selectedId === id) {
        $('thread-scroll').setAttribute('aria-busy', 'false');
        if (!cached) $('message-list').innerHTML = emptyState('Conversation unavailable', error.message, 'retry-conversation', 'Try again', 'message');
        else toast(error.message);
      }
    } finally {
      if (request === recentRequest) {
        recentTarget = null;
        if (recentDirty) { recentDirty = false; loadRecent(); }
      }
    }
  }

  function updateComposer() {
    const agent = byId.get(selectedId);
    $('message-input').placeholder = agent ? `Message ${agent.name}…` : 'Message your agent…';
    $('message-input').setAttribute('aria-label', agent ? `Message ${agent.name}` : 'Message this agent');
    composerPaint?.();
    $('send-message').disabled = !agent || agent.exited || !connected || sending || !$('message-input').value.trim();
    $('composer').setAttribute('aria-busy', String(sending));
    $('send-message').innerHTML = sending ? '<span class="spinner" aria-hidden="true"></span>' : icon('arrow-up');
  }

  function resizeComposer() {
    const input = $('message-input'); input.style.height = 'auto'; input.style.height = `${Math.max(44, Math.min(input.scrollHeight, 200))}px`;
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (sending || !connected || !byId.has(selectedId)) return;
    const id = selectedId, text = $('message-input').value.trim(), original = $('message-input').value;
    if (!text) return;
    sending = true; updateComposer(); $('send-error').hidden = true;
    try {
      const agent = byId.get(id), tagged = [...taggedAgents(text).values()].filter((a) => (!a.owned || a.backendId) && (!agent.owned || agent.backendId)); // a session Synapse has not matched to its agent yet can't be linked
      if (tagged.length) {
        const linked = new Set(relations(id).filter((p) => p.reads && p.shares).map((p) => p.agent.id));
        for (const other of tagged.filter((a) => !linked.has(a.id))) { await createEdge(other.id, id); await createEdge(id, other.id); }
        if (tagged.some((a) => !linked.has(a.id))) await reloadState();
      }
      if (agent.owned) await desktopCall('submit', { id, text });
      else await api(`/api/agents/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
      if (selectedId === id && $('message-input').value === original) { $('message-input').value = ''; drafts[id] = ''; persistDraft(); resizeComposer(); }
      else { drafts[id] = drafts[id] === original ? '' : drafts[id]; }
      recentCache.delete(id);
      if (selectedId === id) { await loadRecent(true); $('thread-scroll').scrollTop = $('thread-scroll').scrollHeight; }
      toast(byId.get(id)?.owned ? 'Prompt sent to your session.' : 'Message queued. The agent will pick it up on its next prompt or inbox check.');
    } catch (error) {
      if (selectedId === id) { $('send-error').textContent = error.message; $('send-error').hidden = false; $('message-input').setAttribute('aria-invalid', 'true'); }
      else toast(error.message);
    } finally { sending = false; updateComposer(); }
  }

  function openModal(title, content, submitLabel, submit) {
    modalVersion++;
    $('dialog-title').textContent = title; $('dialog-content').innerHTML = content;
    $('dialog-submit').textContent = submitLabel || 'Done'; $('dialog-submit').disabled = false;
    $('cancel-dialog').hidden = !submit; $('dialog-error').hidden = true;
    modalSubmit = submit || null;
    if (!$('action-dialog').open) $('action-dialog').showModal();
    const field = $('dialog-content').querySelector('input, select') || $('dialog-content').querySelector('button[aria-pressed="true"], button');
    if (field) field.focus();
  }

  function connectAgent(cwd) {
    if (embedded && desktop) {
      const worktrees = desktop.projects.flatMap((p) => p.worktrees.map((w) => ({ ...w, project: p.label })));
      if (!worktrees.length) { desktopCall('add-project').catch((e) => toast(e.message)); return; }
      const options = worktrees.map((w) => `<option value="${escapeHtml(w.path)}">${escapeHtml(w.project)} · ${escapeHtml(w.branch || w.name)}</option>`).join('');
      const profiles = Object.entries(desktop.profiles).map(([k, p]) => `<option value="${escapeHtml(k)}">${escapeHtml(p.label || k)}</option>`).join('');
      openModal('New session', `<p class="dialog-copy">Start an agent or shell in one of your projects. It stays running when you switch views.</p><label class="field-label" for="session-folder">Project / worktree</label><select class="field" id="session-folder">${options}</select><label class="field-label" for="agent-kind">Agent</label><select class="field" id="agent-kind">${profiles}</select><p class="field-hint">Uses the CLI installed on this Mac and its existing sign-in. Commands can be edited in Settings.</p>`, 'Start session', async () => {
        const result = await desktopCall('new-session', { cwd: $('session-folder').value, kind: $('agent-kind').value });
        desktop = await desktopCall('state'); applyState(rawState); navigate('session', result.id);
      });
      const current = byId.get(selectedId);
      const folder = typeof cwd === 'string' ? cwd : current?.cwd;
      if (worktrees.some((w) => w.path === folder)) $('session-folder').value = folder;
      if (Object.hasOwn(desktop.profiles, 'codex')) $('agent-kind').value = 'codex';
      return;
    }
    openModal('Connect an agent', `<p class="dialog-copy">Start a coding agent in your project. Synapse discovers running sessions on this machine automatically.</p><label class="field-label" for="agent-kind">Agent</label><select class="field" id="agent-kind"><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini CLI</option><option value="opencode">OpenCode</option><option value="amp">Amp</option><option value="copilot">Copilot CLI</option></select><div class="command-preview"><code id="launch-command">codex</code><button class="button secondary" type="button" id="copy-launch">Copy</button></div><p class="field-hint">Run this command in your project’s terminal. To enable messaging and shared context, run <code>node install.mjs</code> in your Synapse folder, then restart the agent.</p>`, 'Done');
    $('agent-kind').onchange = () => { $('launch-command').textContent = $('agent-kind').value; $('copy-launch').textContent = 'Copy'; };
    $('copy-launch').onclick = async () => { if (await copyText($('launch-command').textContent)) $('copy-launch').textContent = 'Copied'; };
  }

  // Add connection: link two of my agents, share one of mine with a friend (they accept and pick which of theirs
  // receives it), or ask a friend for one of theirs (they accept and pick which to share). Friends live in the
  // desktop app, so the last two need it and a signed-in account.
  let friends = null, connectionMode = 'mine', connectionTicket = 0;
  const loadFriends = async () => (friends = embedded ? await desktopCall('friends') : { signedIn: false, unavailable: true });
  const mineId = (id) => byId.get(id)?.backendId || id;
  const connectionTabs = () => `<div class="segmented-control connection-tabs" role="group" aria-label="Kind of connection">${[['mine', 'My agents'], ['share', 'Share with a friend'], ['ask', 'Ask a friend']].map(([k, label]) => `<button type="button" data-conn-tab="${k}" aria-pressed="${k === connectionMode}">${label}</button>`).join('')}</div>`;
  async function addConnection(mode) {
    if (typeof mode === 'string') connectionMode = mode;
    const ticket = ++connectionTicket; // only the latest open draws, and only while the dialog is still up
    if (connectionMode === 'mine') return addLocalConnection();
    openModal('Add connection', `${connectionTabs()}<p class="dialog-copy">Loading your friends…</p>`, 'Done');
    try { await loadFriends(); } catch (error) { friends = { signedIn: false, error: error.message }; }
    if (ticket === connectionTicket && $('action-dialog').open) renderFriendConnection();
  }
  function friendOptions() {
    return friends.people.filter((p) => p.trustsYou && !p.pending && p.handle).map((p) => `<option value="${escapeHtml(p.handle)}">${escapeHtml(p.name)} · @${escapeHtml(p.handle)}</option>`).join('');
  }
  function agentOptions() {
    return friends.agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} · ${escapeHtml(kindName(a))}${a.project ? ` · ${escapeHtml(a.project)}` : ''}</option>`).join('');
  }
  function renderFriendConnection() {
    const share = connectionMode === 'share';
    if (!friends?.signedIn) {
      const why = friends?.unavailable ? 'Friends live in the Synapse desktop app. Open this workspace there to share agents with people you trust.' : friends?.error || 'Sign in to share agents with people you trust and ask for theirs.';
      openModal('Add connection', `${connectionTabs()}<p class="dialog-copy">${escapeHtml(why)}</p>${friends?.unavailable ? '' : '<button class="button" type="button" data-action="friends-sign-in">Sign in</button>'}`, 'Done');
      return;
    }
    const people = friendOptions();
    if (!people || !friends.agents.length) {
      const why = !friends.agents.length ? 'Start an agent first. It is the one you share, or the one that receives theirs.' : friends.people.length ? 'None of your trusted people has added you back yet. Once they do, you can share agents with each other.' : 'Add someone you trust first: their email or @handle in Friends (top right of Terminal view) or Settings.';
      openModal('Add connection', `${connectionTabs()}<p class="dialog-copy">${escapeHtml(why)}</p>`, 'Done');
      return;
    }
    if (share) {
      openModal('Add connection', `${connectionTabs()}<p class="dialog-copy">Give a friend access to one of your agents. They accept and choose which of their agents receives it.</p>
        <label class="field-label" for="friend-agent">Your agent</label><select class="field" id="friend-agent">${agentOptions()}</select>
        <label class="field-label" for="friend-who">Friend</label><select class="field" id="friend-who">${people}</select>
        <label class="field-label" for="friend-mode">Access</label><select class="field" id="friend-mode"><option value="talk">Read and ask questions</option><option value="sync">Read only</option></select>
        <p class="field-hint">${friends.canOffer ? 'Questions are answered by a copy of your agent with no tools. Nobody can type into your agent.' : escapeHtml(friends.offersLater)}</p>`, 'Send invite', async () => {
        await desktopCall('friend-offer', { to: $('friend-who').value, agent: $('friend-agent').value, mode: $('friend-mode').value });
        toast('Invite sent. It connects once they accept.'); renderFriendsList(true);
      });
      if (!friends.canOffer) $('dialog-submit').disabled = true;
    } else {
      openModal('Add connection', `${connectionTabs()}<p class="dialog-copy">Ask a friend for one of their agents. They accept and choose which one to share with you.</p>
        <label class="field-label" for="friend-who">Friend</label><select class="field" id="friend-who">${people}</select>
        <label class="field-label" for="friend-agent">Into your agent</label><select class="field" id="friend-agent">${agentOptions()}</select>
        <label class="field-label" for="friend-what">What you need <span class="optional">optional</span></label><input class="field" id="friend-what" maxlength="120" autocomplete="off" placeholder="e.g. their api-auth agent, the payments work">`, 'Send request', async () => {
        await desktopCall('friend-ask', { to: $('friend-who').value, agent: $('friend-agent').value, target: $('friend-what').value });
        toast('Request sent. You can read their agent once they accept.'); renderFriendsList(true);
      });
    }
    const current = mineId(selectedId);
    if (friends.agents.some((a) => a.id === current)) $('friend-agent').value = current;
  }
  function addLocalConnection() {
    const linkable = state.agents.filter((a) => !a.owned || a.backendId);
    if (linkable.length < 2) {
      openModal('Add connection', `${connectionTabs()}<p class="dialog-copy">Start a second coding agent, then connect the two sessions here to share context. Or share with a friend.</p>`, 'Done'); return;
    }
    const options = (omit) => linkable.filter((agent) => agent.id !== omit).map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)} · ${escapeHtml(kindName(agent))}</option>`).join('');
    const initial = linkable.some((a) => a.id === selectedId) ? selectedId : linkable[0].id;
    openModal('Add connection', `${connectionTabs()}<p class="dialog-copy">Choose which sessions share context. Linked agents can also message each other.</p><label class="field-label" for="link-from">Agent</label><select class="field" id="link-from">${options()}</select><label class="field-label" for="link-to">Connect with</label><select class="field" id="link-to">${options(initial)}</select><label class="field-label" for="link-direction">Share context</label><select class="field" id="link-direction"><option value="both">Both ways</option><option value="out">First agent → second agent</option><option value="in">Second agent → first agent</option></select>`, 'Connect agents', async () => {
      const from = $('link-from').value, to = $('link-to').value, direction = $('link-direction').value;
      if (from === to || !byId.has(from) || !byId.has(to)) throw new Error('Choose two different live agents.');
      if (direction !== 'in') await createEdge(from, to);
      if (direction !== 'out') await createEdge(to, from);
      await reloadState(); toast('Agents connected. Context will arrive on their next prompt.');
    });
    $('link-from').value = initial;
    $('link-from').onchange = () => { const previous = $('link-to').value; $('link-to').innerHTML = options($('link-from').value); if (previous !== $('link-from').value) $('link-to').value = previous; };
  }

  async function createEdge(from, to) {
    from = byId.get(from)?.backendId || from; to = byId.get(to)?.backendId || to;
    try { await api('/api/edges', { method: 'POST', body: JSON.stringify({ from, to }) }); }
    catch (error) { if (error.status !== 409) throw error; }
  }

  async function removeLinks(ids, button) {
    const edges = state.edges.filter((edge) => ids.includes(edge.id));
    if (button) button.disabled = true;
    try {
      for (const edge of edges) await api(`/api/edges/${encodeURIComponent(edge.id)}`, { method: 'DELETE' });
      await reloadState();
      toast('Connection removed.', async () => { for (const edge of edges) await createEdge(edge.from, edge.to); await reloadState(); toast('Connection restored.'); });
    } catch (error) { toast(error.message); }
    finally { if (button?.isConnected) button.disabled = false; }
  }

  function renameAgent() {
    const agent = byId.get(selectedId); if (!agent) return;
    openModal('Rename session', `<label class="field-label" for="session-name">Session name</label><input class="field" id="session-name" maxlength="48" value="${escapeHtml(agent.name)}" autocomplete="off"><p class="field-hint">Leave this empty to restore its automatic name.</p>`, 'Save name', async () => {
      if (agent.owned) { await desktopCall('rename', { id: agent.id, name: $('session-name').value }); desktop = await desktopCall('state'); }
      else await api(`/api/agents/${encodeURIComponent(agent.id)}/name`, { method: 'POST', body: JSON.stringify({ name: $('session-name').value }) });
      await reloadState();
    });
    $('session-name').select();
  }

  function showHelp() {
    if (embedded) { openModal('Your desktop workspace', '<p class="dialog-copy">Projects contain worktrees, sessions, and their forks. Drag siblings to reorder them. GUI and Terminal share the same running sessions; Activity, Canvas, splits, and fork trees stay in the mode you choose.</p><div class="shortcut-row"><span>Find a session</span><kbd>⌘ K</kbd></div><div class="shortcut-row"><span>New session</span><kbd>⌘ N</kbd></div><div class="shortcut-row"><span>Split conversation</span><kbd>⌘ D</kbd></div><div class="shortcut-row"><span>Reorder a focused row</span><kbd>⌥ ↑ / ↓</kbd></div><div class="shortcut-row"><span>Settings</span><kbd>⌘ ,</kbd></div><p class="field-hint">Open Terminal explicitly for CLI sign-in and interactive approvals. Claude Code and Codex support native conversation forks after their first prompt.</p>', 'Got it'); return; }
    openModal('A little space for your agents', '<p class="dialog-copy">Follow conversations across coding tools, connect sessions to share context, and leave messages without switching terminals. Everything stays on this machine.</p><div class="shortcut-row"><span>Find a session</span><kbd>⌘ / Ctrl K</kbd></div><div class="shortcut-row"><span>Search from anywhere</span><kbd>/</kbd></div><div class="shortcut-row"><span>Send a message</span><kbd>Enter</kbd></div><div class="shortcut-row"><span>Add a new line</span><kbd>Shift Enter</kbd></div><div class="shortcut-row"><span>Close a panel or dialog</span><kbd>Esc</kbd></div><p class="field-hint">Messages are queued until the agent’s next prompt or inbox check. Synapse does not start or interrupt a running agent.</p>', 'Got it');
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch { toast('Clipboard unavailable. Select the text and copy it with your keyboard.'); return false; }
  }

  function renderSearch() {
    searchHits = searchSessions(state.agents, $('search-input').value).slice(0, 30);
    searchIndex = Math.max(0, Math.min(searchIndex, searchHits.length - 1));
    $('search-results').innerHTML = searchHits.map((agent, index) => `<button type="button" class="search-result" id="search-result-${index}" data-search-agent="${escapeHtml(agent.id)}" role="option" aria-selected="${index === searchIndex}" tabindex="-1">${avatar(agent)}<span class="result-info"><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.project)} · ${escapeHtml(kindName(agent))}</small></span>${status(agent)}${icon('arrow-right')}</button>`).join('') || `<p class="search-empty">${state.agents.length ? 'No sessions match this search.' : 'No live sessions yet. Connect an agent to get started.'}</p>`;
    $('search-count').textContent = `${searchHits.length} ${searchHits.length === 1 ? 'session' : 'sessions'}`;
    if (searchHits.length) $('search-input').setAttribute('aria-activedescendant', `search-result-${searchIndex}`); else $('search-input').removeAttribute('aria-activedescendant');
    $('search-results').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function openSearch() {
    if ($('action-dialog').open) return;
    $('search-input').value = ''; searchIndex = 0; renderSearch();
    if (!$('search-dialog').open) $('search-dialog').showModal();
    $('search-input').focus();
  }

  function updateConnection(isConnected) {
    const changed = connected !== isConnected;
    connected = isConnected;
    $('connection-banner').hidden = isConnected;
    $('connection-dot').classList.toggle('offline', !isConnected);
    $('local-status').textContent = isConnected ? `${state.agents.length} ${state.agents.length === 1 ? 'session' : 'sessions'} connected` : ready ? 'Reconnecting…' : 'Connecting…';
    updateComposer();
    if (changed) for (const frame of paneFrames.values()) sendPaneState(frame);
  }

  function applyState(next) {
    rawState = next;
    if (!desktopActive || (embedded && !desktop)) return;
    next = mergeDesktop(next);
    state = next; byId = new Map(next.agents.map((agent) => [agent.id, agent]));
    const first = !ready; ready = true;
    if (view === 'session' && !byId.has(selectedId)) {
      if (first && !selectedId && next.agents.length) {
        selectedId = next.agents.find((agent) => agent.transcript)?.id || next.agents[0].id;
        $('message-input').value = drafts[selectedId] || '';
      } else { persistDraft(); view = 'overview'; }
    }
    if (first) history.replaceState({ view, id: selectedId }, '', location.href);
    $('demo-banner').hidden = !state.demo;
    if (embedded) {
      $('connect-agent').querySelector('span:nth-child(2)').textContent = 'New session';
      document.querySelectorAll('[data-action="connect"]').forEach((b) => { b.innerHTML = icon('plus') + 'New session'; });
    }
    updateConnection(true); renderSidebar(); renderMain(first);
    if ($('search-dialog').open) renderSearch();
  }

  function connectEvents() {
    if (paneKey) return;
    source?.close();
    source = new EventSource('/api/events');
    source.onopen = () => updateConnection(true);
    source.onerror = () => updateConnection(false);
    source.addEventListener('state', (event) => {
      try { pendingState = JSON.parse(event.data); }
      catch { return; }
      if (!stateFrame) stateFrame = requestAnimationFrame(() => { stateFrame = 0; applyState(pendingState); });
    });
    source.addEventListener('flow', (event) => {
      let flow; try { flow = JSON.parse(event.data); } catch { return; }
      if (flow.type === 'message' && [flow.from, flow.to].includes(selectedId)) {
        clearTimeout(flowTimer); flowTimer = setTimeout(() => loadRecent(true), 100);
      }
    });
  }

  // The composer marks what it understands: a slash command at the start (it runs as a command in sessions
  // opened in Synapse, and arrives as plain text through the inbox otherwise) and @friends. A mirror behind the
  // textarea carries the highlights, so the text you type stays the textarea's own.
  const mirror = document.createElement('div');
  mirror.className = 'composer-mirror'; mirror.setAttribute('aria-hidden', 'true');
  $('message-input').before(mirror);
  const mentionBox = document.createElement('div');
  mentionBox.className = 'mention-pop'; mentionBox.id = 'mention-pop'; mentionBox.setAttribute('role', 'listbox'); mentionBox.hidden = true;
  const mentionBar = document.createElement('div');
  mentionBar.className = 'mention-bar'; mentionBar.id = 'mention-bar'; mentionBar.hidden = true;
  $('composer').before(mentionBar, mentionBox);
  let mentionHits = [], mentionIndex = 0, mentionAt = -1, friendsAt = 0;
  const asked = new Set(); // friend handles asked from this composer, so the bar says so
  const knownFriends = () => (friends?.signedIn ? friends.people.filter((p) => p.handle && p.trustsYou && !p.pending) : []);
  async function freshFriends() {
    if (!embedded || Date.now() - friendsAt < 30000) return;
    friendsAt = Date.now();
    try { await loadFriends(); } catch { friendsAt = 0; }
  }
  // your other live agents, by @handle; friends' handles come first so they never clash
  const myAgents = () => agentHandles(state.agents.filter((a) => a.id !== selectedId && a.status !== 'exited' && a.kind !== 'shell').sort((a, b) => String(a.id).localeCompare(String(b.id))), knownFriends().map((p) => p.handle));
  const projectOf = (agent) => agent?.project || (agent?.cwd || '').split('/').filter(Boolean).pop() || '';
  // which of their agents already reach this one, and whether one of theirs works on this project
  function friendContext(p) {
    const agent = byId.get(selectedId), project = projectOf(agent);
    const theirs = (friends?.links || []).filter((l) => l.direction === 'in' && (l.owner === p.name || l.owner === p.handle));
    const here = theirs.find((l) => l.local?.id === mineId(selectedId));
    return { project, here, related: !here && theirs.find((l) => project && l.agent?.name && l.agent.name.toLowerCase().includes(project.toLowerCase())) };
  }
  function paintMirror() {
    const text = $('message-input').value, slash = slashCommand(text);
    let html = escapeHtml(text);
    if (slash) { const at = text.indexOf(slash.command); html = escapeHtml(text.slice(0, at)) + `<mark class="slash">${escapeHtml(slash.command)}</mark>` + escapeHtml(text.slice(at + slash.command.length)); }
    const handles = new Set(knownFriends().map((p) => p.handle.toLowerCase())), mine = new Set([...myAgents().keys()].map((h) => h.toLowerCase()));
    mirror.innerHTML = html.replace(MENTION, (all, pre, h) => handles.has(h.toLowerCase()) ? `${pre}<mark class="mention">@${h}</mark>` : mine.has(h.toLowerCase()) ? `${pre}<mark class="mention agent">@${h}</mark>` : all) + '\n';
    const input = $('message-input'), style = getComputedStyle(input);
    Object.assign(mirror.style, { top: `${input.offsetTop}px`, left: `${input.offsetLeft}px`, width: `${input.clientWidth}px`, height: `${input.clientHeight}px`, font: style.font, letterSpacing: style.letterSpacing, padding: style.padding });
    mirror.scrollTop = input.scrollTop;
    const agent = byId.get(selectedId);
    $('composer').classList.toggle('has-command', !!slash);
    const channel = $('composer').querySelector('.composer-channel');
    // without a command it says how the text reaches the agent (it used to always claim "Via Synapse")
    if (channel) channel.innerHTML = slash ? `<span class="slash-cmd">${escapeHtml(slash.command)}</span>${agent?.owned ? `Runs as a ${escapeHtml(kindName(agent))} command` : 'Sent as text: commands run in sessions opened in Synapse'}` : agent?.owned ? `${icon('monitor')}Live session` : `${icon('network')}Via Synapse`;
  }
  // the agents of yours tagged in a message; sending connects each of them with this agent both ways
  function taggedAgents(text) {
    const mine = myAgents(), out = new Map();
    for (const m of String(text).matchAll(MENTION)) {
      const hit = [...mine].find(([h]) => h.toLowerCase() === m[2].toLowerCase());
      if (hit) out.set(hit[0], hit[1]);
    }
    return out;
  }
  function paintMentionBar() {
    const text = $('message-input').value, seen = new Set(), rows = [];
    const peers = new Set(relations(selectedId).filter((p) => p.reads && p.shares).map((p) => p.agent.id));
    for (const [handle, agent] of taggedAgents(text)) {
      rows.push(`<div class="mention-row"><span class="mention agent">@${escapeHtml(handle)}</span><span class="mention-text">${peers.has(agent.id) ? `<strong>${escapeHtml(agent.name)}</strong> is connected: this agent can read its work and message it.` : `Sending connects <strong>${escapeHtml(agent.name)}</strong>${agent.project ? ` (${escapeHtml(agent.project)})` : ''} with this agent, so they can read each other's work and message.`}</span></div>`);
    }
    for (const m of text.matchAll(MENTION)) {
      const p = knownFriends().find((x) => x.handle.toLowerCase() === m[2].toLowerCase());
      if (!p || seen.has(p.handle)) continue;
      seen.add(p.handle);
      const { project, here, related } = friendContext(p);
      rows.push(`<div class="mention-row"><span class="mention">@${escapeHtml(p.handle)}</span><span class="mention-text">${here ? `${escapeHtml(p.name)}'s <strong>${escapeHtml(here.agent?.name || 'agent')}</strong> already shares with this agent.` : asked.has(p.handle) ? `Asked ${escapeHtml(p.name)} for access. Waiting for them to accept.` : `${related ? `${escapeHtml(p.name)} has <strong>${escapeHtml(related.agent.name)}</strong>, which looks related. ` : ''}Ask ${escapeHtml(p.name)} for access to an agent${project ? ` on ${escapeHtml(project)}` : ''}?`}</span>${here || asked.has(p.handle) ? '' : `<button class="button secondary" type="button" data-mention-ask="${escapeHtml(p.handle)}">Request access</button>`}</div>`);
    }
    mentionBar.innerHTML = rows.join(''); mentionBar.hidden = !rows.length;
  }
  function mentionQuery() {
    const input = $('message-input'), before = input.value.slice(0, input.selectionStart);
    const m = /(^|[\s(])@([\w-]{0,24})$/.exec(before);
    return m ? { at: before.length - m[2].length - 1, q: m[2].toLowerCase() } : null;
  }
  function paintMentionPop() {
    const hit = mentionQuery();
    if (!hit) { mentionBox.hidden = true; mentionAt = -1; return; }
    mentionAt = hit.at;
    const rank = (p) => { const c = friendContext(p); return c.here ? 0 : c.related ? 1 : 2; };
    const self = byId.get(selectedId);
    mentionHits = mentionOptions({ friends: [...knownFriends()].sort((a, b) => rank(a) - rank(b)), agents: myAgents(), project: self?.projectKey, query: hit.q });
    if (!mentionHits.length) { mentionBox.hidden = true; return; }
    mentionIndex = Math.min(mentionIndex, mentionHits.length - 1);
    const heads = { friend: 'Friends', here: 'Agents in this project', elsewhere: 'Other agents' };
    let last = '';
    mentionBox.innerHTML = mentionHits.map((o, i) => {
      const group = o.type === 'friend' ? 'friend' : o.local ? 'here' : 'elsewhere';
      const head = group !== last ? `<p class="mention-head">${heads[group]}</p>` : '';
      last = group;
      const option = (name, extra) => `${head}<button type="button" class="mention-option" role="option" aria-selected="${i === mentionIndex}" data-mention-pick="${escapeHtml(o.handle)}"><strong>${escapeHtml(name)}</strong><span>@${escapeHtml(o.handle)}</span><small>${extra}</small></button>`;
      if (o.type === 'agent') return option(o.agent.name, `${escapeHtml(kindName(o.agent))}${o.local ? '' : ` · ${escapeHtml(o.agent.project || '')}`} · ${activityLabel(o.agent).toLowerCase()}`);
      const c = friendContext(o.friend);
      return option(o.friend.name, c.here ? `shares ${escapeHtml(c.here.agent?.name || 'an agent')} here` : c.related ? `has ${escapeHtml(c.related.agent.name)}` : c.project ? `ask for an agent on ${escapeHtml(c.project)}` : 'ask for an agent');
    }).join('') + (hit.q ? '' : '<p class="mention-foot">Type a name to search all your agents</p>');
    mentionBox.hidden = false;
  }
  function pickMention(handle) {
    const input = $('message-input'), end = input.selectionStart;
    if (mentionAt < 0) return;
    input.value = `${input.value.slice(0, mentionAt)}@${handle} ${input.value.slice(end)}`;
    const caret = mentionAt + handle.length + 2;
    input.setSelectionRange(caret, caret); input.focus();
    mentionBox.hidden = true; mentionAt = -1;
    input.dispatchEvent(new Event('input'));
  }
  async function askMention(handle, button) {
    const agent = byId.get(selectedId), project = projectOf(agent);
    if (button) button.disabled = true;
    try {
      await desktopCall('friend-ask', { to: handle, agent: mineId(selectedId), target: project ? `an agent on ${project}` : '' });
      asked.add(handle); toast('Request sent. You can read their agent once they accept.'); paintMentionBar();
    } catch (error) { toast(error.message); if (button?.isConnected) button.disabled = false; }
  }
  const paintComposer = () => { paintMirror(); paintMentionBar(); paintMentionPop(); };
  composerPaint = () => { paintMirror(); paintMentionBar(); };
  $('message-input').addEventListener('input', () => { if ($('message-input').value.includes('@')) freshFriends().then(paintComposer); paintComposer(); });
  $('message-input').addEventListener('scroll', () => { mirror.scrollTop = $('message-input').scrollTop; });
  $('message-input').addEventListener('click', paintMentionPop);
  $('message-input').addEventListener('blur', () => setTimeout(() => { if (!mentionBox.contains(document.activeElement)) mentionBox.hidden = true; }, 120));
  mentionBox.addEventListener('mousedown', (event) => event.preventDefault()); // keep the caret in the textarea
  document.addEventListener('click', (event) => {
    const pick = event.target.closest('[data-mention-pick]'), ask = event.target.closest('[data-mention-ask]');
    if (pick) pickMention(pick.dataset.mentionPick);
    if (ask) askMention(ask.dataset.mentionAsk, ask);
  });
  $('message-input').addEventListener('keydown', (event) => {
    if (mentionBox.hidden || !mentionHits.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopImmediatePropagation(); mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : mentionHits.length - 1)) % mentionHits.length; paintMentionPop(); }
    else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); pickMention(mentionHits[mentionIndex].handle); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); mentionBox.hidden = true; }
  });

  // Up on the first line brings back your last prompt, again for the one before; Down returns to what you had typed
  let recall = null; // { agent, index, draft }
  $('message-input').addEventListener('keydown', (event) => {
    if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return;
    const input = $('message-input'), caret = input.selectionStart;
    if (recall && (recall.agent !== selectedId || input.value !== recall.shown)) recall = null;
    const up = event.key === 'ArrowUp';
    if (up ? input.value.slice(0, caret).includes('\n') : input.value.slice(input.selectionEnd).includes('\n')) return;
    if (!up && !recall) return;
    if (up && !recall && input.value.trim()) return; // a draft of your own: Up moves the caret as usual
    const history = promptHistory(recentCache.get(selectedId)?.data);
    if (!history.length) return;
    recall ||= { agent: selectedId, index: history.length, draft: input.value };
    const index = Math.max(0, Math.min(history.length, recall.index + (up ? -1 : 1)));
    if (index === recall.index) { if (up) event.preventDefault(); return; }
    event.preventDefault();
    recall.index = index;
    input.value = index === history.length ? recall.draft : history[index];
    recall.shown = input.value;
    if (index === history.length) recall = null;
    const end = up ? 0 : input.value.length;
    input.setSelectionRange(end, end);
    input.dispatchEvent(new Event('input'));
    if (recall) recall.shown = input.value;
  });
  $('composer').addEventListener('submit', sendMessage);
  $('message-input').addEventListener('input', () => {
    resizeComposer(); updateComposer(); $('send-error').hidden = true; $('message-input').removeAttribute('aria-invalid');
    if (paneKey) persistDraft();
    else { clearTimeout(draftTimer); draftTimer = setTimeout(persistDraft, 250); }
  });
  $('message-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
  });
  $('thread-scroll').addEventListener('scroll', () => { if ($('thread-scroll').scrollHeight - $('thread-scroll').scrollTop - $('thread-scroll').clientHeight < 90) $('jump-latest').hidden = true; }, { passive: true });
  $('jump-latest').onclick = () => { $('thread-scroll').scrollTop = $('thread-scroll').scrollHeight; $('jump-latest').hidden = true; };
  $('sidebar-toggle').onclick = () => { setSidebar(!sidebarOpen); if (narrow.matches && sidebarOpen) $('sidebar-close').focus(); };
  $('sidebar-close').onclick = $('sidebar-scrim').onclick = () => { setSidebar(false); $('sidebar-toggle').focus(); };
  $('context-toggle').onclick = () => { inspectorOpen = !inspectorOpen; setStorage('synapse-inspector', inspectorOpen ? 'open' : 'closed'); syncInspector(); };
  $('connect-agent').onclick = connectAgent;
  const runDesktop = (action, args = {}) => desktopCall(action, args).then(async (result) => {
    if (action === 'new-session' || action === 'split') {
      desktop = action === 'split' ? result : await desktopCall('state');
      applyState(rawState); navigate('session', action === 'split' ? desktop.active : result.id);
    }
    return result;
  }).catch((e) => toast(e.message));
  $('add-project').onclick = () => runDesktop('add-project');
  $('desktop-account').onclick = () => runDesktop('account');
  $('open-terminal').onclick = () => runDesktop('terminal', { id: selectedId });
  function forkSession() {
    const agent = byId.get(selectedId); if (!agent?.owned) return;
    openModal('Fork conversation', `<p class="dialog-copy">Create a child session with this agent’s context. The parent keeps running.</p><label class="field-label" for="fork-question">Explore in the fork</label><textarea class="field" id="fork-question" rows="4" maxlength="12000" required placeholder="What should the fork work on?"></textarea>`, 'Create fork', async () => {
      const result = await desktopCall('fork', { id: agent.id, question: $('fork-question').value });
      desktop = await desktopCall('state'); applyState(rawState); navigate('session', result.id);
    });
  }
  $('fork-session').onclick = forkSession;
  $('session-menu').onclick = () => {
    const agent = byId.get(selectedId); if (!agent?.owned) return;
    openModal('Session actions', `<div class="session-action-list"><button type="button" class="button secondary" data-session-action="fork-tree">View fork tree</button><button type="button" class="button secondary" data-session-action="split">Split side by side</button><button type="button" class="button secondary" data-session-action="split-down">Split top and bottom</button><button type="button" class="button secondary" data-session-action="close">Close session</button></div>`, 'Done');
    $('dialog-content').querySelectorAll('[data-session-action]').forEach((button) => { button.onclick = () => {
      $('action-dialog').close();
      const action = button.dataset.sessionAction;
      runDesktop(action === 'split-down' ? 'split' : action, { id: agent.id, direction: action === 'split-down' ? 'down' : 'right' });
    }; });
  };
  document.querySelector('.canvas-link').addEventListener('click', (event) => { if (embedded) { event.preventDefault(); navigate('canvas'); } });
  document.querySelector('.brand').addEventListener('click', (event) => { if (embedded) { event.preventDefault(); navigate('overview'); } });
  $('project-list').addEventListener('contextmenu', (event) => {
    const button = event.target.closest('[data-project]');
    if (!embedded || !button || !desktop?.projects.some((p) => p.key === button.dataset.project)) return;
    event.preventDefault();
    runDesktop('project-menu', { key: button.dataset.project, x: event.clientX, y: event.clientY });
  });
  $('new-connection').onclick = addConnection;
  $('rename-agent').onclick = renameAgent;
  $('help-button').onclick = $('demo-help').onclick = showHelp;
  $('open-search').onclick = openSearch;
  $('close-search').onclick = () => $('search-dialog').close();
  $('close-dialog').onclick = $('cancel-dialog').onclick = () => $('action-dialog').close();
  $('theme-toggle').onclick = () => {
    const theme = document.documentElement.dataset.theme === 'night' ? 'signal' : 'night';
    document.documentElement.dataset.theme = theme; setStorage('synapse-mode', theme); updateThemeButton();
    if (embedded) runDesktop('theme', { theme });
  };
  function updateThemeButton() {
    const dark = document.documentElement.dataset.theme === 'night';
    $('theme-toggle').innerHTML = icon(dark ? 'sun' : 'moon');
    $('theme-toggle').setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
    updateCanvasTheme();
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    if (!getStorage('synapse-mode')) { document.documentElement.dataset.theme = event.matches ? 'night' : 'signal'; updateThemeButton(); }
  });
  narrow.addEventListener('change', () => setSidebar(!narrow.matches && getStorage('synapse-sidebar', 'open') === 'open', false));
  wide.addEventListener('change', () => { inspectorOpen = wide.matches && getStorage('synapse-inspector', 'open') === 'open'; syncInspector(); });
  $('search-input').addEventListener('input', () => { searchIndex = 0; renderSearch(); });
  $('search-input').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); searchIndex = Math.max(0, Math.min(searchHits.length - 1, searchIndex + (event.key === 'ArrowDown' ? 1 : -1))); renderSearch(); }
    if (event.key === 'Enter' && searchHits[searchIndex]) { event.preventDefault(); $('search-dialog').close(); navigate('session', searchHits[searchIndex].id); }
  });
  $('action-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!modalSubmit) { $('action-dialog').close(); return; }
    const submit = $('dialog-submit'), label = submit.textContent, version = modalVersion;
    if (submit.disabled) return;
    submit.disabled = true; submit.textContent = 'Saving…'; $('dialog-error').hidden = true;
    try { await modalSubmit(); if (version === modalVersion) $('action-dialog').close(); }
    catch (error) { if (version === modalVersion) { $('dialog-error').textContent = error.message; $('dialog-error').hidden = false; } }
    finally { if (version === modalVersion) { submit.disabled = false; submit.textContent = label; } }
  });
  for (const dialog of [$('search-dialog'), $('action-dialog')]) dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.createWorktree) return runDesktop('worktree', { key: button.dataset.createWorktree });
    if (button.dataset.newSessionCwd) return connectAgent(button.dataset.newSessionCwd);
    if (button.dataset.agent) return navigate('session', button.dataset.agent);
    if (button.dataset.view) return navigate(button.dataset.view);
    if (button.dataset.searchAgent) { $('search-dialog').close(); return navigate('session', button.dataset.searchAgent); }
    if (button.dataset.project) {
      const key = button.dataset.project; collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
      setStorage('synapse-collapsed', JSON.stringify([...collapsed])); renderSidebar(); return;
    }
    if (button.dataset.worktreeToggle) {
      const key = button.dataset.worktreeToggle; collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
      setStorage('synapse-collapsed', JSON.stringify([...collapsed])); renderSidebar(); return;
    }
    if (button.dataset.filter) { filter = button.dataset.filter; renderOverview(); return; }
    if (button.dataset.tab) { persistDraft(); tab = button.dataset.tab; renderMain(true); return; }
    if (button.dataset.removeLinks) return removeLinks(button.dataset.removeLinks.split(','), button);
    if (button.dataset.connTab) { connectionMode = button.dataset.connTab; return addConnection(); }
    if (button.dataset.friendAccept) return answerFriend(button, 'accept');
    if (button.dataset.friendDeny) return answerFriend(button, 'deny');
    if (button.dataset.friendCancel) return answerFriend(button, 'cancel');
    if (button.hasAttribute('data-copy-code')) { if (await copyText(button.closest('.code-block').querySelector('code').textContent)) { button.textContent = 'Copied'; setTimeout(() => { if (button.isConnected) button.textContent = 'Copy code'; }, 2000); } return; }
    if (button.hasAttribute('data-copy-message')) { const message = renderedMessages.get(button.closest('[data-message-key]').dataset.messageKey); if (message && await copyText(message.text)) toast('Message copied.'); return; }
    const action = button.dataset.action;
    if (action === 'connect') connectAgent();
    if (action === 'desktop-terminal') runDesktop('terminal', { id: selectedId });
    if (action === 'add-connection') addConnection();
    if (action === 'friend-connection') addConnection('share');
    if (action === 'friends-sign-in') { if ($('action-dialog').open) $('action-dialog').close(); desktopCall('sign-in').catch((e) => toast(e.message)); }
    if (action === 'close-inspector') { inspectorOpen = false; setStorage('synapse-inspector', 'closed'); syncInspector(); $('context-toggle').focus(); }
    if (action === 'show-messages') { persistDraft(); tab = 'messages'; renderMain(true); }
    if (action === 'show-all') { filter = 'all'; renderOverview(); }
    if (action === 'retry-conversation') loadRecent(true);
    if (action === 'load-older') { limit = Math.min(200, limit + 60); loadRecent(true); }
  });
  document.addEventListener('keydown', (event) => {
    const editing = event.target.matches('input, textarea, select, [contenteditable="true"]');
    // the layout's letter, or the physical key where the layout gives no shortcut key (Italian ⌘& is ⌘1, ⌘è is ⌘[)
    const named = event.key.toLowerCase();
    const key = /^[a-z0-9]$/.test(named) || named === 'tab' || named === ',' ? named
      : /^(Key|Digit)/.test(event.code) ? event.code.slice(-1).toLowerCase() : { BracketLeft: '[', BracketRight: ']', Comma: ',' }[event.code] || named;
    const mod = event.metaKey || event.ctrlKey;
    if (paneKey && ((mod && ['b', 'k', 'g'].includes(key)) || (mod && key === 'f' && !event.shiftKey) || (event.ctrlKey && key === 'tab'))) {
      event.preventDefault(); parent.postMessage({ type: 'synapse:pane-command', command: key === 'b' ? 'sidebar' : ['g', 'tab'].includes(key) ? 'canvas' : 'search' }, location.origin); return;
    }
    if (embedded && ((event.ctrlKey && !event.metaKey && key === 'tab') || (mod && key === 'g'))) { event.preventDefault(); navigate(view === 'canvas' ? 'session' : 'canvas', selectedId); return; }
    if (embedded && event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && /^[1-9]$/.test(key)) {
      const kind = Object.keys(desktop?.profiles || {}).filter((k) => k !== 'shell')[Number(key) - 1];
      const cwd = byId.get(selectedId)?.cwd || desktop?.projects[0]?.worktrees[0]?.path;
      if (kind && cwd) { event.preventDefault(); runDesktop('new-session', { cwd, kind }); } return;
    }
    if (embedded && (event.metaKey || event.ctrlKey)) {
      if (key === 'n') { event.preventDefault(); if (event.shiftKey) runDesktop('worktree', { key: byId.get(selectedId)?.projectKey || desktop?.projects[0]?.key }); else connectAgent(); return; }
      if (key === 't') { event.preventDefault(); const cwd = byId.get(selectedId)?.cwd || desktop?.projects[0]?.worktrees[0]?.path; if (cwd) runDesktop('new-session', { cwd, kind: 'shell' }); return; }
      if (key === ',') { event.preventDefault(); runDesktop('settings'); return; }
      if (key === 'b') { event.preventDefault(); setSidebar(!sidebarOpen); return; }
      if (key === 'd') { event.preventDefault(); runDesktop('split', { id: selectedId, direction: event.shiftKey ? 'down' : 'right' }); return; }
      if (key === 'e') { event.preventDefault(); runDesktop('fork-tree', { id: selectedId }); return; }
      if (key === 'w') { event.preventDefault(); runDesktop('close', { id: selectedId }); return; }
      if (/^[1-9\[\]]$/.test(key)) { event.preventDefault(); runDesktop('switch-session', { key }); return; }
      if (key === 'f' && event.shiftKey) { event.preventDefault(); forkSession(); return; }
    }
    if ((event.metaKey || event.ctrlKey) && ['k', 'f'].includes(event.key.toLowerCase())) { event.preventDefault(); openSearch(); return; }
    if (event.key === '/' && !editing && !$('action-dialog').open && !$('search-dialog').open) { event.preventDefault(); openSearch(); }
    if (event.key === 'Escape' && !$('action-dialog').open && !$('search-dialog').open) {
      if (view === 'activity' || view === 'canvas') navigate(byId.has(selectedId) ? 'session' : 'overview', selectedId);
      else if (narrow.matches && sidebarOpen) { setSidebar(false, false); $('sidebar-toggle').focus(); }
      else if (inspectorOpen) { inspectorOpen = false; syncInspector(); $('context-toggle').focus(); }
    }
    if (event.target.matches('[role="tab"]') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); persistDraft(); tab = tab === 'conversation' ? 'messages' : 'conversation'; renderMain(true); $(tab === 'conversation' ? 'conversation-tab' : 'messages-tab').focus();
    }
    if (event.key === 'Tab' && narrow.matches && sidebarOpen) {
      const items = [...$('sidebar').querySelectorAll('button, a')].filter((element) => !element.disabled && element.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  addEventListener('popstate', (event) => {
    if (event.state?.view) return navigate(event.state.view, event.state.id, false);
    const previousView = view, previousId = selectedId;
    readRoute();
    const nextView = view, nextId = selectedId;
    view = previousView; selectedId = previousId;
    navigate(nextView, nextId, false);
  });
  addEventListener('beforeunload', persistDraft);
  if (paneKey) document.addEventListener('focusin', () => parent.postMessage({ type: 'synapse:pane-focus' }, location.origin));
  document.addEventListener('visibilitychange', () => { if (document.hidden) { persistDraft(); source?.close(); } else connectEvents(); });
  setInterval(() => { if (!document.hidden && ready) { renderSidebar(); if (view === 'overview') renderOverview(); if (inspectorOpen) renderInspector(); } }, 30000);
  updateThemeButton(); setSidebar(paneKey ? false : sidebarOpen, false); connectEvents();
  if (embedded) parent.postMessage({ type: 'synapse:desktop-ready' }, '*');
}

// other pages (the file viewer) import the helpers above without starting a workspace
if (typeof document !== 'undefined' && document.getElementById('workspace')) {
  // The desktop server uses an available port on each launch. Keep drafts and preferences
  // with the session store, instead of tying them to a temporary HTTP origin.
  if (parent !== window && new URLSearchParams(location.search).get('desktop') === '1') {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { removeEventListener('message', receive); resolve(); }, 15000);
      function receive(event) {
        const origin = new URLSearchParams(location.search).has('pane') ? location.origin : 'null';
        if (event.source !== parent || event.origin !== origin || event.data?.type !== 'synapse:desktop-bootstrap') return;
        clearTimeout(timer); removeEventListener('message', receive);
        const keys = ['synapse-mode', 'synapse-selected', 'synapse-sidebar', 'synapse-inspector', 'synapse-drafts', 'synapse-collapsed'];
        for (const key of keys) {
          try {
            const value = event.data.preferences?.[key];
            if (typeof value === 'string') localStorage.setItem(key, value); else localStorage.removeItem(key);
          } catch {}
        }
        resolve();
      }
      addEventListener('message', receive);
      parent.postMessage({ type: 'synapse:desktop-bootstrap' }, '*');
    });
  }
  initialize();
}
