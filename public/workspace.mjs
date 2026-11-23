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
export const MENTION = /(^|[\s(])@([A-Za-z0-9][\w-]{1,31})\b/g;

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
      .replace(/&lt;u&gt;(.+?)&lt;\/u&gt;/g, '<u>$1</u>')
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

// A name as a mention: punctuation becomes dashes, and a long name stops at a word end, not mid-word
// ("What do you think, given…" → "What-do-you-think-given", never "What-do-you-think-gi"). Room is left for "-2" under the 32-character mention.
export function mentionSlug(name, max = 28) {
  const slug = String(name ?? '').replace(/[^\w-]+/g, '-').replace(/[-_]{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max + 1).lastIndexOf('-');
  return (cut >= 6 ? slug.slice(0, cut) : slug.slice(0, max)).replace(/[-_]+$/, '');
}

// "@handle" for each of your agents: its name made mention-safe, numbered when names repeat ("claude", "claude-2").
// Friends keep their own handles, so an agent never takes one.
export function agentHandles(agents, taken = []) {
  const used = new Set(taken.map((h) => h.toLowerCase())), out = new Map();
  for (const agent of agents) {
    let base = mentionSlug(agent.name || agent.kind || 'agent') || 'agent';
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
    if (local && (starts(handle, agent.name, agent.title) || (q && contains(handle, agent.name, agent.title)))) here.push({ type: 'agent', handle, agent, local });
    else if (!local && q && contains(handle, agent.name, agent.title, agent.project)) elsewhere.push({ type: 'agent', handle, agent, local });
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
  let found = 0, score = 0, previous = -2, first = -1;
  for (let i = 0; i < text.length && found < word.length; i++) {
    if (text[i] === word[found]) { if (first < 0) first = i; score += i === previous + 1 ? 5 : 1; previous = i; found++; }
  }
  // an abbreviation (cdx → codex) sits close together; letters scattered across a sentence (c…o…n…n) are noise
  return found === word.length && previous - first < word.length * 3 ? score : -1;
}

export function searchSessions(agents, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return agents.map((agent) => {
    // a worktree's name counts, the main checkout's generic label does not
    const fields = [agent.title, agent.name, agent.project, agent.worktreeHome ? '' : agent.worktreeName, agent.kind, agent.cwd];
    const scores = words.map((word) => Math.max(...fields.map((value) => wordScore(word, value))));
    return { agent, score: scores.includes(-1) ? -1 : scores.reduce((sum, score) => sum + score, 0) };
  }).filter((hit) => hit.score >= 0).sort((a, b) => b.score - a.score || (b.agent.lastActivity || 0) - (a.agent.lastActivity || 0)).map((hit) => hit.agent);
}

// An agent waiting for you in its terminal (Claude's "Do you want to…", Codex's approval) usually shows a numbered
// menu. Read the question and the choices off the screen so the GUI can offer them as buttons.
// What an agent shows when it waits on you, read from its terminal screen: Claude Code's and Codex's permission
// prompts, Claude's questions (one or several, as tabs; single or multi-select, each option with a description,
// "Type something." for your own answer, "Chat about this"), its review screen, and plain menus without numbers
// (the folder trust check). Returns the question with its title and any command, and the options with their keys.
const RULE = /^[\s─━═]{12,}$/, DASHED = /^[\s╌┄┈╍]{12,}$/;
const PROMPT_FOOTER = /(Enter to (select|confirm)|Esc to cancel|to navigate|enter to confirm|esc to cancel)/i;
export function parseApproval(lines) {
  const raw = (lines || []).map((line) => String(line).replace(/\s+$/, ''));
  while (raw.length && !raw.at(-1)) raw.pop(); // the screen's empty rows below the prompt
  const clean = raw.map((line) => line.replace(/^\s*[│┃║|]\s?|\s?[│┃║|]\s*$/g, '').replace(/[╭╮╰╯┌┐└┘├┤]/g, ' ').replace(/\s+$/, ''));
  const isRule = (i) => RULE.test(raw[i]) || /^\s*[╭╰]─+[╮╯]\s*$/.test(raw[i]);
  const NUM = /^(\s*)([❯›>▶]\s*)?(\d+)[.)]\s+(.*)$/;
  let footer = clean.length;
  for (let i = clean.length - 1; i >= Math.max(0, clean.length - 10); i--) if (PROMPT_FOOTER.test(clean[i])) { footer = i; break; }
  // the options: numbered ones, read upwards from the footer, with the indented lines under each as its description
  let last = -1;
  for (let i = footer - 1; i >= 0; i--) { if (NUM.test(clean[i])) { last = i; break; } if (clean[i].trim() && !isRule(i) && footer - i > 6) break; }
  const options = [];
  let first = -1;
  if (last >= 0) {
    const col = (i) => clean[i].match(NUM)[1].length;
    let i = last;
    for (; i >= 0; i--) {
      if (NUM.test(clean[i])) { first = i; continue; }
      if (!clean[i].trim() || isRule(i)) continue;
      // a description sits deeper than the option numbers around it
      const next = clean.slice(i + 1, last + 1).findIndex((l) => NUM.test(l));
      if (next >= 0 && clean[i].search(/\S/) > col(i + 1 + next) + 2) continue;
      break;
    }
    for (let j = first; j <= last; j++) {
      const m = clean[j].match(NUM); if (!m) continue;
      let label = m[4].trim(), checked;
      const box = label.match(/^\[([ ✔✓xX])\]\s*(.*)$/);
      if (box) { checked = box[1] !== ' '; label = box[2]; }
      const desc = [];
      for (let k = j + 1; k <= last && !NUM.test(clean[k]) && !isRule(k); k++) if (clean[k].trim()) desc.push(clean[k].trim());
      // multi-select: "Submit" sits under the last option, as its own row
      const submit = desc.at(-1) === 'Submit' ? desc.pop() : null;
      if (options.some((o) => o.key === m[3])) continue;
      options.push({ key: m[3], label, selected: !!m[2], ...(checked !== undefined ? { checked } : {}), ...(desc.length ? { description: desc.join(' ') } : {}),
        ...(/^Type something\.?$/i.test(label) || (checked === undefined && /^Type something/i.test(label)) ? { input: true } : {}), ...(/^Chat about this$/i.test(label) ? { chat: true } : {}) });
      if (submit) options.submit = true;
    }
  } else {
    // a menu without numbers: the line with the pointer and the lines lined up with it
    const at = clean.slice(0, footer).findLastIndex((l) => /^\s*[❯›]\s+\S/.test(l));
    if (at >= 0) {
      const textCol = clean[at].search(/[❯›]/) + 2;
      first = at; last = at;
      while (first > 0 && clean[first - 1].trim() && clean[first - 1].search(/\S/) === textCol) first--;
      while (last + 1 < footer && clean[last + 1].trim() && clean[last + 1].search(/\S/) === textCol) last++;
      for (let j = first; j <= last; j++) options.push({ key: `nav:${j - at}`, label: clean[j].replace(/^\s*[❯›]?\s*/, ''), selected: j === at });
    }
  }
  const multi = options.some((o) => o.checked !== undefined);
  // the question: what is above the options, back to the rule that opens the prompt
  const top = first >= 0 ? first : footer;
  let from = Math.max(0, top - 16);
  for (let i = top - 1; i >= from; i--) if (isRule(i)) { from = i + 1; break; }
  let title = '', tabs = [], detail = [], text = [], inDetail = false;
  for (let i = from; i < top; i++) {
    const l = clean[i].trim();
    if (DASHED.test(raw[i])) { inDetail = !inDetail; continue; }
    if (!l) continue;
    if (/[☐☒✔]/.test(l) && (/[←→]/.test(l) || !tabs.length) && !text.length) {
      const found = [...l.matchAll(/([☐☒✔])\s+([^☐☒✔←→]+?)(?=\s+[☐☒✔→]|\s*$|\s+→)/g)].map((m) => ({ label: m[2].trim(), done: m[1] !== '☐', submit: m[1] === '✔' }));
      if (found.length > 1 || /[←→]/.test(l)) tabs = found.filter((t) => !t.submit); else title = found[0]?.label || l.replace(/[☐☒✔]/g, '').trim();
      continue;
    }
    if (inDetail) { detail.push(clean[i].replace(/^ /, '')); continue; }
    if (/^Tip:/i.test(l)) continue;
    text.push(l);
  }
  // a permission prompt opens with what it is about ("Bash command"), then says what it does; the question comes last
  if (!title && text.length > 1 && !/[?.:]$/.test(text[0]) && text[0].length < 40) title = text.shift();
  const question = text.join('\n');
  return { title, tabs, question: [question, ...detail].filter(Boolean).join('\n'), text: question, detail: detail.join('\n'), options, multi, submit: !!options.submit, footer: footer < clean.length ? clean[footer].trim() : '' };
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
  todo: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.3 3 7.6 7 9 4-1.4 7-4.7 7-9V6z"/>',
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
  settings: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.6a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.6a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  paperclip: '<path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8-8"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><path d="M16 4.6a3.2 3.2 0 0 1 0 6.3M18 14.3c1.7.7 2.8 2.4 3 4.7"/>',
  sort: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
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
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5M13 15h4"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  maximize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  minimize: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  'pop-out': '<rect x="3" y="7" width="14" height="14" rx="2"/><path d="M10 3h11v11M21 3l-9 9"/>',
  'dock-in': '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M14 3v18M9 9l-3 3 3 3"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-4 4 3 3m-6 0 2 2"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-1.5v-6a1.5 1.5 0 0 1 3 0V12m0-5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.6a6 6 0 0 1-4.6-2.2L3.5 16a1.6 1.6 0 0 1 2.4-2l2.1 1.8"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.message}</svg>`;
const KIND_NAMES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', antigravity: 'Antigravity', opencode: 'OpenCode', 'cursor-agent': 'Cursor', amp: 'Amp', copilot: 'Copilot CLI', superset: 'Superset', shell: 'Shell' };
const KIND_INITIALS = { claude: 'Cl', codex: 'Cx', gemini: 'G', antigravity: 'Ag', opencode: 'Oc', 'cursor-agent': 'Cu', amp: 'A', copilot: 'Co', superset: 'S', shell: '>_' };
const kindName = (agent) => KIND_NAMES[agent.kind] || agent.kind;
// real logos where we have them (app/renderer/logos), initials otherwise
const LOGOS = new Set(['amp', 'claude', 'codex', 'copilot', 'cursor-agent', 'gemini', 'opencode', 'shell']);
const initials = (agent) => (LOGOS.has(agent.kind) ? '' : KIND_INITIALS[agent.kind] || agent.kind?.slice(0, 2) || 'A');
const avatar = (agent) => `<span class="agent-avatar" data-logo="${LOGOS.has(agent.kind) ? escapeHtml(agent.kind) : ''}" title="${escapeHtml(kindName(agent))}" aria-hidden="true">${escapeHtml(initials(agent))}</span>`;
// a project's badge, like T3's: two letters on a tint of its colour
const badgeText = (name) => { const words = String(name || '?').split(/[\s_.-]+/).filter(Boolean); return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase(); };
const hueOf = (text) => { let h = 0; for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const activityLabel = (agent) => agent.status === 'busy' ? 'Working' : ['waiting', 'needs_input'].includes(agent.status) ? 'Needs input' : agent.status === 'exited' ? 'Exited' : 'Idle';
// a spinner drawn again (the state refreshes every second) picks up where a shared clock is, instead of starting
// over, so it turns smoothly however often its row is redrawn
const spinPhase = (period = 900) => `animation-delay:-${Date.now() % period}ms`;
const status = (agent) => agent.status === 'busy' ? `<span class="status-dot busy" style="${spinPhase()}" aria-hidden="true"></span>` : '<span class="status-dot" aria-hidden="true"></span>';
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
  // The desktop window has no title bar in GUI mode: tell it where this page's header strips are, and which
  // parts of them are controls, so it can make the empty parts drag the window.
  let dragFrame = 0, lastDrag = '';
  function reportDragRegions() {
    if (!embedded || paneKey || dragFrame) return;
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      const box = (el) => { const r = el.getBoundingClientRect(); return r.width && r.height ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null; };
      const strips = [...document.querySelectorAll('.brand-row, .topbar')].filter((el) => el.offsetParent);
      const areas = strips.map(box).filter(Boolean);
      const holes = strips.flatMap((el) => [...el.querySelectorAll('button, a, input, select, [role="button"], [tabindex]:not([tabindex="-1"])')])
        .filter((el) => el.offsetParent).map(box).filter(Boolean);
      const next = JSON.stringify({ areas, holes });
      if (next === lastDrag) return;
      lastDrag = next;
      desktopCall('drag-regions', { areas, holes }).catch(() => { lastDrag = ''; });
    });
  }
  if (embedded && !paneKey) {
    const watch = new ResizeObserver(reportDragRegions);
    document.querySelectorAll('.brand-row, .topbar, .sidebar').forEach((el) => watch.observe(el));
    new MutationObserver(reportDragRegions).observe(document.querySelector('.topbar'), { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    new MutationObserver(reportDragRegions).observe(document.getElementById('workspace'), { attributes: true, attributeFilter: ['data-sidebar', 'data-inspector'] });
    addEventListener('resize', reportDragRegions);
  }
  function mergeDesktop(next) {
    if (!desktop) return next;
    const existing = new Map(next.agents.map((a) => [a.id, a]));
    const aliases = new Map(desktop.sessions.filter((s) => s.backendId).map((s) => [s.backendId, s.id]));
    const owned = desktop.sessions.filter((s) => !s.drawer).map((s) => {
      const original = existing.get(s.backendId);
      return { ...original, ...s, owned: true, usedAt: original?.lastActivity || 0, lastActivity: Math.max(s.lastActivity || 0, original?.lastActivity || 0), preview: original?.preview || (s.exited ? 'Session ended' : 'Ready for your next prompt') };
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
        const preferences = Object.fromEntries(['synapse-mode', 'synapse-selected', 'synapse-sidebar', 'synapse-inspector', 'synapse-drafts', 'synapse-collapsed', 'synapse-group', 'synapse-snoozed', 'synapse-done', 'synapse-archived', 'synapse-tidy', 'synapse-kept', 'synapse-queue', 'synapse-update-later', 'synapse-settled', 'synapse-inspector-tab', 'synapse-panel-width'].map((key) => [key, getStorage(key, null)]));
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
    if (message?.type === 'synapse:desktop-chrome' && !paneKey) {
      document.documentElement.style.setProperty('--traffic-inset', `${Math.max(0, Math.min(120, Number(message.inset) || 0))}px`);
      reportDragRegions(); return;
    }
    if (paneKey && message?.type === 'synapse:pane-state') {
      const changed = selectedId !== message.id;
      if (changed) { persistDraft(); recentController?.abort(); recentTarget = null; recentRequest++; tab = defaultTab(state.agents.find((a) => a.id === message.id)); limit = 60; }
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
    if (message?.type === 'synapse:browser-state' && message.state) { if (!paneKey) onBrowserState(message.state, message.ask); return; }
    // the open agent opened a page: show its browser (Settings > Agents > Browser turns this off, in the app)
    if (message?.type === 'synapse:browser-show') {
      const selected = byId.get(selectedId);
      if (!paneKey && selected && browserKey(selected) === message.agent && view === 'session' && (inspectorTab !== 'browser' || !inspectorOpen || $('inspector').hidden)) {
        inspectorTab = 'browser'; setStorage('synapse-inspector-tab', 'browser'); inspectorOpen = true; inspectorFile = null; syncInspector();
      }
      return;
    }
    if (message?.type === 'synapse:browser-cover') { browserCovered = !!message.covered; placeBrowser(); return; }
    // Settings, Cleanup changed how agents are tidied (the app saved it with the other preferences)
    // a worktree was just opened and Settings says to start on the New session screen there (app.js openIn)
    if (message?.type === 'synapse:show-new' && typeof message.cwd === 'string') {
      (async () => { if (!worktreeList().some((w) => w.path === message.cwd)) desktop = await desktopCall('state').catch(() => desktop); showNew(message.cwd); })();
      return;
    }
    if (message?.type === 'synapse:tidy' && message.tidy) { tidy = { ...TIDY_DEFAULT, ...message.tidy }; try { localStorage.setItem('synapse-tidy', JSON.stringify(tidy)); } catch {} renderSidebar(); return; }
    if (message?.type === 'synapse:desktop-state') {
      const previous = desktop?.active;
      const followSelection = !selectedId || selectedId === previous;
      desktop = message.state;
      document.body.classList.add('desktop');
      const theme = desktop.theme;
      if (['night', 'signal'].includes(theme)) { document.documentElement.dataset.theme = theme; themeFileFrame(); }
      updateThemeButton();
      if (desktopActive) {
        const follow = view === 'session' && followSelection && desktop.active && desktop.active !== previous && desktop.sessions.some((s) => s.id === desktop.active);
        if (follow) { persistDraft(); selectedId = desktop.active; $('message-input').value = drafts[selectedId] || ''; }
        applyState(rawState);
        if (follow) navigate('session', desktop.active);
      }
    }
    if (message?.type === 'synapse:friends-changed') { loadFriends().then(() => { renderFriendsList(); renderSidebar(); renderInspector(); composerPaint?.(); }, () => {}); return; }
    if (message?.type === 'synapse:desktop-visibility') {
      desktopActive = message.visible;
      if (!desktopActive) persistDraft();
      if (desktopActive) applyState(rawState);
    }
    if (message?.type === 'synapse:desktop-navigate') navigate(message.view === 'back' || (message.toggle && view === message.view) ? byId.has(selectedId) ? 'session' : 'overview' : message.view, message.id || selectedId);
    if (message?.type === 'synapse:activity-progress') activityView.progress(message.progress);
    if (message?.type === 'synapse:add-project' && !paneKey) { addProject(); return; }
    if (message?.type === 'synapse:clone-progress') { const hint = $('ws-hint'); if (hint && cloning) hint.textContent = message.line; return; }
    if (message?.type === 'synapse:update' && !paneKey) { update = message.update || {}; renderUpdateCard(); return; }
    if (message?.type === 'synapse:desktop-key') {
      if (message.key === 'j') toggleDrawer();
      else if (message.key === 'k') openSearch();
      else if (message.key === 'n' && !message.shift) connectAgent();
      else if (message.key === 't') showNew(null, 'shell');
      else if (message.shift && (message.key === 'w' || message.key === 's')) moveSelection(message.key === 'w' ? -1 : 1);
    }
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
  // the panel's tabs: Details (the session) or Browser (the agent browser, agent-browser.mjs in the app)
  const PANEL_TABS = ['details', 'todos', 'browser'];
  let inspectorTab = PANEL_TABS.includes(getStorage('synapse-inspector-tab', 'details')) ? getStorage('synapse-inspector-tab', 'details') : 'details';
  let browserSettle = 0; // while the panel eases to its new width, the page waits to be placed
  let panelFull = false, panelDragging = false;
  let browserState = { agents: {}, asks: [] }, browserCovered = false, browserPlaced = '', browserSignature = '';
  // files pasted, dropped or attached in the composer, shown as chips (images as thumbnails) until sent (see insertPaths)
  const IMAGE = /\.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/i;
  const attachments = new Map(); // session -> file paths waiting to be sent
  const NEW = '\0new'; // the New session screen's attachments, sent with its first message
  const attachKey = () => (view === 'new' ? NEW : selectedId);
  let drafts;
  try { drafts = JSON.parse(getStorage('synapse-drafts', '{}')); if (!drafts || typeof drafts !== 'object') drafts = {}; } catch { drafts = {}; }
  const projectElements = new Map(), worktreeElements = new Map(), sessionElements = new Map(), recentCache = new Map();
  let sidebarDrag = null;
  let storedCollapsed;
  try { storedCollapsed = JSON.parse(getStorage('synapse-collapsed', '[]')); } catch {}
  const collapsed = new Set(Array.isArray(storedCollapsed) ? storedCollapsed : []);
  const outgoing = new Map(); // session -> prompts just sent, shown at once until the transcript has them
  let sendingSlow = false, olderAnchor = null, loadingOlder = false; // the history above, loaded as you scroll up
  let sending = false, recentController, recentRequest = 0, recentTarget, recentDirty = false, limit = 60;
  let source, stateFrame = 0, stateTimer = 0, pendingState, toastTimer, draftTimer, flowTimer;
  let approvalTimer = null, approvalFor = null, approvalMiss = 0, approvalReading = false, approvalPolling = null; // the options card: its poll, and which agent it is for
  let composerPaint = null; // set once the composer's highlighting exists; drafts loaded before then repaint on input
  let linear = { connected: false }, todoPick = null, todosSignature = '', showDone = false, askLater = 0; // todos
  const seenLive = new Set(), goneSince = new Map(); // agents seen running, and when one stopped being listed
  let modalSubmit = null, modalVersion = 0, searchHits = [], searchIndex = 0, renderedMessages = new Map();
  let overviewSignature = '', connectionsSignature = '', inspectorSignature = '';

  function readRoute() {
    const route = location.hash.slice(1);
    if (['overview', 'connections', 'activity', 'canvas', 'todos', 'rooms'].includes(route)) view = route;
    else if (route === 'new' && embedded) view = 'new';
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

  // the side panels slide (CSS); while they do, a docked terminal follows without re-measuring its rows each frame
  const PANEL_MS = 340;
  let panelsMovingUntil = 0;
  const panelsMoving = () => performance.now() < panelsMovingUntil;
  const panelsMove = () => { panelsMovingUntil = performance.now() + PANEL_MS + 40; };
  function setSidebar(open, persist = true) {
    if (open !== sidebarOpen) panelsMove();
    sidebarOpen = open;
    $('workspace').dataset.sidebar = open ? 'open' : 'closed';
    $('sidebar-toggle').setAttribute('aria-expanded', String(open));
    $('sidebar').inert = !open;
    $('main').inert = narrow.matches && open;
    if (persist && !narrow.matches) setStorage('synapse-sidebar', open ? 'open' : 'closed');
  }

  let inspectorHide = null;
  function syncInspector() {
    const visible = inspectorOpen && view === 'session' && !!byId.get(selectedId);
    if (!visible) inspectorFile = null;
    // it slides in and out: shown before it opens, hidden only once it has slid away
    const pane = $('inspector'), was = $('workspace').dataset.inspector === 'open';
    if (visible !== was) panelsMove();
    clearTimeout(inspectorHide);
    if (visible) {
      if (pane.hidden) { pane.hidden = false; void pane.offsetWidth; } // start from closed, so it slides
    } else if (!pane.hidden) inspectorHide = setTimeout(() => { if ($('workspace').dataset.inspector !== 'open') pane.hidden = true; }, was ? PANEL_MS : 0);
    pane.inert = !visible;
    $('workspace').dataset.inspector = visible ? 'open' : 'closed';
    $('context-toggle').setAttribute('aria-expanded', String(visible));
    $('inspector').classList.toggle('browser-mode', visible && inspectorTab === 'browser' && !inspectorFile);
    if (!visible) panelFull = false;
    $('panel-grip').hidden = !visible || panelFull;
    document.querySelector('.content-area').classList.toggle('panel-full', visible && panelFull);
    applyPanelWidth();
    if (visible) renderInspector();
    placeBrowser();
  }

  // ---- The panel's width: drag its left edge (double-click resets); Full size gives it the whole conversation area
  function applyPanelWidth() {
    const w = Number(getStorage('synapse-panel-width', 0)) || 0, pane = $('inspector');
    if (w) { pane.style.setProperty('--inspector-width', `${w}px`); pane.style.setProperty('--panel-w', `${w}px`); }
    else { pane.style.removeProperty('--inspector-width'); pane.style.removeProperty('--panel-w'); }
  }
  function setPanelFull(on) {
    panelFull = !!on; inspectorSignature = ''; browserSignature = '';
    browserSettle = Date.now() + 360; setTimeout(placeBrowser, 380);
    syncInspector();
  }
  {
    const grip = $('panel-grip');
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault(); grip.setPointerCapture(event.pointerId);
      panelDragging = true; browserCovered = true; placeBrowser(); // the page view would swallow the drag
      document.querySelector('.content-area').classList.add('panel-resizing');
      const area = document.querySelector('.content-area').getBoundingClientRect();
      const move = (e) => {
        const w = Math.round(Math.min(Math.max(area.right - e.clientX, 280), area.width - 320));
        $('inspector').style.setProperty('--inspector-width', `${w}px`); $('inspector').style.setProperty('--panel-w', `${w}px`);
      };
      const up = (e) => {
        grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
        const w = parseInt($('inspector').style.getPropertyValue('--panel-w'), 10);
        if (w) setStorage('synapse-panel-width', String(w));
        panelDragging = false; browserCovered = false;
        document.querySelector('.content-area').classList.remove('panel-resizing');
        placeBrowser();
      };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', () => { setStorage('synapse-panel-width', ''); applyPanelWidth(); setTimeout(placeBrowser, 50); });
  }

  function toast(message, undo, label = 'Undo') {
    clearTimeout(toastTimer);
    $('toast-text').textContent = message;
    $('toast-action').hidden = !undo; $('toast-action').textContent = label;
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

  function projectGroups(local = false) {
    const groups = new Map((desktop?.projects || []).map((p) => [p.key, {
      key: p.key, name: p.label, managed: true, agents: [], worktrees: p.worktrees.map((w) => ({ ...w, managed: true, agents: [] })),
    }]));
    for (const agent of state.agents) {
      if (local && agent.remote) continue; // friends' agents live under People
      if (!groups.has(agent.projectKey)) groups.set(agent.projectKey, { key: agent.projectKey, name: agent.project, agents: [], worktrees: [] });
      const group = groups.get(agent.projectKey);
      group.agents.push(agent);
      const cwd = (agent.worktreePath || agent.cwd || '').replaceAll('\\', '/');
      let worktree = group.worktrees.find((w) => cwd === w.path.replaceAll('\\', '/'))
        || [...group.worktrees].sort((a, b) => b.path.length - a.path.length).find((w) => cwd.startsWith(w.path.replaceAll('\\', '/').replace(/\/$/, '') + '/'));
      const name = agent.worktreeName || agent.frameSub || agent.cwd?.split(/[\\/]/).pop() || group.name;
      // sessions found outside Synapse in the same main checkout share one group, not one each
      worktree ||= agent.worktreeHome ? group.worktrees.find((w) => w.home && !w.managed && w.name === name) : null;
      if (!worktree) {
        worktree = { path: agent.worktreePath || agent.cwd, name, home: agent.worktreeHome, agents: [] };
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

  // what a session is about: its transcript title (Claude's own, or your first prompt), unless you named it
  const titleOf = (agent) => (agent.autoName || !agent.title ? agent.name : agent.title);
  let sidebarQuery = '', groupBy = ['project', 'status', 'recent'].includes(getStorage('synapse-group')) ? getStorage('synapse-group') : 'project';
  const GENERATED = /^(claude|codex|gemini|opencode|cursor-agent|cursor|amp|copilot|shell|agent|pi|kiro)(-\d+)?$/i;
  const readJSON = (key, fallback) => { try { return JSON.parse(getStorage(key, '')) ?? fallback; } catch { return fallback; } };
  // Every agent has a state, like a thread in T3: it needs you, it is working, it finished while you were away
  // (done, until you open it), or it rests. Snoozed agents step aside until their time or until they need you.
  // done keeps the time it finished (older saves kept a list: those count from now)
  const doneSaved = readJSON('synapse-done', {});
  let snoozed = readJSON('synapse-snoozed', {}), archived = readJSON('synapse-archived', {});
  const doneSet = new Map(Array.isArray(doneSaved) ? doneSaved.map((id) => [id, Date.now()]) : Object.entries(doneSaved).filter(([, t]) => Number.isFinite(t)));
  const lastStatus = new Map(), missingSince = new Map(), busySince = new Map(); // busySince: when an agent last turned busy
  const saveMarks = () => { setStorage('synapse-snoozed', JSON.stringify(snoozed)); setStorage('synapse-done', JSON.stringify(Object.fromEntries(doneSet))); setStorage('synapse-archived', JSON.stringify(archived)); setStorage('synapse-kept', JSON.stringify(unarchivedAt)); setStorage('synapse-settled', JSON.stringify(settledAt)); };
  // Tidying up on its own, each step configurable (sidebar filter menu → Tidy up): a finished agent shows Done
  // until it is a day old, then Idle; unused for 3 days it moves to Archived; a week unused it is ended (a session
  // of ours closes, one in your own terminal has its process ended) and its marks are dropped. 0 turns a step off.
  const HOUR = 3_600_000, DAY = 24 * HOUR;
  const TIDY_DEFAULT = { idle: DAY, archive: 3 * DAY, close: 7 * DAY };
  let tidy = { ...TIDY_DEFAULT, ...readJSON('synapse-tidy', {}) };
  // Prompts sent to a session of ours while it works or waits on a question: held here and sent one at a time
  // once it is free, never typed into a busy terminal (where it could land in a permission menu)
  const queued = readJSON('synapse-queue', {}); // session -> [{ id, text, at }]
  const flushing = new Map(); // session -> when its next queued prompt was sent, until it turns busy
  const stoppedAt = new Map(); // session -> when Stop was pressed: its queue holds for a few seconds
  const saveQueue = () => { for (const k of Object.keys(queued)) if (!queued[k]?.length) delete queued[k]; setStorage('synapse-queue', JSON.stringify(queued)); };
  const unarchivedAt = readJSON('synapse-kept', {});
  const settledAt = readJSON('synapse-settled', {}); // settled by hand (the row's ✓), until it works again // unarchived by hand: left alone for another full period
  // last real use: for a session of ours its conversation's time when known (a restart must not count as use)
  const usedAt = (a) => (a.owned ? a.usedAt || a.lastActivity : a.lastActivity) || 0;
  const expiring = new Set(), archivedBusy = new Set(); // archivedBusy: archived by hand while working, stays archived
  const needsYou = (a) => ['waiting', 'needs_input'].includes(a.status);
  function trackStates() {
    let changed = false;
    for (const a of state.agents) {
      const was = lastStatus.get(a.id);
      lastStatus.set(a.id, a.status);
      if (a.status === 'busy' && was !== 'busy' && was !== undefined) busySince.set(a.id, Date.now());
      // working again: back out of Archived and Snoozed (they only stay visible while open, so it would vanish when you switch away)
      if (a.status === 'busy' && was !== 'busy' && snoozed[a.id] !== undefined) { delete snoozed[a.id]; changed = true; }
      // working (or asking you) again: out of Archived, where it would only show while open; unless you archived it
      // while it was already working
      const active = a.status === 'busy' || needsYou(a);
      if (!active) archivedBusy.delete(a.id);
      if (active && archived[a.id] !== undefined && !archivedBusy.has(a.id)) { delete archived[a.id]; unarchivedAt[a.id] = Date.now(); changed = true; }
      // it worked after it was archived (before this rule, or while the app was closed): it is in use again
      if (archived[a.id] && (doneSet.get(a.id) || 0) > archived[a.id]) { delete archived[a.id]; unarchivedAt[a.id] = Date.now(); changed = true; }
      if (a.status === 'busy' || needsYou(a)) flushing.delete(a.id);
      if (queued[a.id]?.length && a.owned && !a.exited && a.status !== 'busy' && !needsYou(a) && !(approvalFor === a.id && !$('approval-card').hidden) && !(Date.now() - (stoppedAt.get(a.id) || 0) < 4000) && (!flushing.has(a.id) || Date.now() - flushing.get(a.id) > 15_000)) sendQueued(a.id);
      if (was === 'busy' && a.status !== 'busy' && !needsYou(a)) { doneSet.set(a.id, Date.now()); changed = true; }
      if (a.status === 'busy' && doneSet.delete(a.id)) changed = true;
      if ((a.status === 'busy' || needsYou(a)) && settledAt[a.id] !== undefined) { delete settledAt[a.id]; changed = true; }
      const finished = doneSet.get(a.id);
      if (finished && tidy.idle && Date.now() - finished > tidy.idle) { doneSet.delete(a.id); changed = true; }
      const busy = a.status === 'busy' || needsYou(a), idleFor = Date.now() - Math.max(usedAt(a), finished || 0, unarchivedAt[a.id] || 0);
      if (!busy && tidy.archive && idleFor > tidy.archive && archived[a.id] === undefined && a.id !== selectedId && usedAt(a)) { archived[a.id] = Date.now(); delete snoozed[a.id]; doneSet.delete(a.id); changed = true; }
      if (!busy && !a.remote && !a.exited && tidy.close && idleFor > tidy.close && usedAt(a) && !expiring.has(a.id) && a.id !== selectedId) {
        expiring.add(a.id);
        // ours: the app closes it; one in your own terminal: its process is ended (the terminal stays)
        const end = a.owned ? (embedded ? desktopCall('expire', { id: a.id }) : Promise.resolve(null))
          : api(`/api/agents/${encodeURIComponent(a.id)}/end`, { method: 'POST' }).then(() => ({ closed: true }));
        end.then((r) => { if (r?.closed) forget(a.id); }).catch(() => {}).finally(() => expiring.delete(a.id));
      }
      const until = snoozed[a.id];
      if (until !== undefined && (needsYou(a) || (until && Date.now() >= until) || (!until && doneSet.has(a.id)))) { delete snoozed[a.id]; changed = true; }
    }
    const live = new Set(state.agents.map((a) => a.id));
    // gone for 10 minutes (not just between two refreshes, or before the app has sent its sessions): forget it
    for (const id of live) missingSince.delete(id);
    for (const id of doneSet.keys()) if (!live.has(id)) {
      if (!missingSince.has(id)) missingSince.set(id, Date.now());
      else if (Date.now() - missingSince.get(id) > 10 * 60_000) { doneSet.delete(id); missingSince.delete(id); changed = true; }
    }
    for (const id of Object.keys(snoozed)) if (!live.has(id) && !String(id).startsWith('desktop-')) { delete snoozed[id]; changed = true; }
    for (const id of Object.keys(archived)) if (!live.has(id) && Date.now() - archived[id] > 7 * 86_400_000) { delete archived[id]; changed = true; }
    for (const id of Object.keys(unarchivedAt)) if (!live.has(id) && Date.now() - unarchivedAt[id] > 30 * DAY) { delete unarchivedAt[id]; changed = true; }
    for (const id of Object.keys(settledAt)) if (!live.has(id) && Date.now() - settledAt[id] > 30 * DAY) { delete settledAt[id]; changed = true; }
    if (changed) saveMarks();
  }
  async function sendQueued(id, item = queued[id]?.[0]) {
    if (!item) return;
    flushing.set(id, Date.now());
    queued[id] = (queued[id] || []).filter((q) => q.id !== item.id); saveQueue(); renderQueue();
    try {
      await desktopCall('submit', { id, text: item.text });
      const stale = recentCache.get(id); if (stale) stale.activity = -1;
      if (selectedId === id) loadRecent(true);
    } catch (e) { queued[id] = [item, ...(queued[id] || [])]; saveQueue(); renderQueue(); flushing.delete(id); toast(e.message); }
  }
  function renderQueue() {
    const list = queued[selectedId] || [], box = $('prompt-queue');
    box.hidden = !list.length || view !== 'session';
    const sig = JSON.stringify([selectedId, list.map((q) => q.id)]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = list.map((q, i) => `<div class="queued-prompt" role="listitem"><span class="queued-tag">${icon('clock')}${i ? `Queued ${i + 1}` : 'Next'}</span><span class="queued-text">${escapeHtml(q.text.replace(/\s+/g, ' '))}</span><button type="button" class="text-button" data-queue-now="${escapeHtml(q.id)}" title="Send it to the session now">Send now</button><button type="button" class="icon-button" data-queue-edit="${escapeHtml(q.id)}" aria-label="Edit queued prompt" title="Edit">${icon('edit')}</button><button type="button" class="icon-button" data-queue-remove="${escapeHtml(q.id)}" aria-label="Remove queued prompt" title="Remove">${icon('x')}</button></div>`).join('');
  }
  $('prompt-queue').addEventListener('click', (event) => {
    const b = event.target.closest('button'); if (!b) return;
    const id = selectedId, list = queued[id] || [];
    const item = list.find((q) => q.id === (b.dataset.queueNow || b.dataset.queueEdit || b.dataset.queueRemove)); if (!item) return;
    if (b.dataset.queueNow) return sendQueued(id, item);
    queued[id] = list.filter((q) => q !== item); saveQueue(); renderQueue();
    if (b.dataset.queueEdit) { const input = $('message-input'); input.value = [item.text, input.value].filter((t) => t.trim()).join('\n'); resizeComposer(); updateComposer(); input.focus(); }
  });
  function settle(id, on) {
    if (on) { settledAt[id] = Date.now(); doneSet.delete(id); delete snoozed[id]; } else delete settledAt[id];
    saveMarks(); renderSidebar();
  }
  $('project-list').addEventListener('click', (event) => {
    const act = event.target.closest('[data-row-act]'); if (!act) return;
    event.preventDefault(); event.stopPropagation();
    const id = act.closest('.session-row')?.dataset.agent; if (!id) return;
    if (act.dataset.rowAct === 'settle') settle(id, settledAt[id] === undefined);
    else archive(id, archived[id] === undefined);
  }, true);
  // a session closed for being unused: its marks, draft and cached conversation go too
  function forget(id) {
    doneSet.delete(id); delete snoozed[id]; delete archived[id]; delete unarchivedAt[id]; delete settledAt[id]; delete queued[id]; saveQueue(); recentCache.delete(id);
    if (drafts[id] !== undefined) { delete drafts[id]; setStorage('synapse-drafts', JSON.stringify(drafts)); }
    saveMarks();
  }
  function tidyDialog() {
    const opt = (value, current, label) => `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`;
    const select = (id, current, choices) => `<select class="field" id="${id}">${choices.map(([v, l]) => opt(v, current, l)).join('')}</select>`;
    const never = [0, 'Never'];
    openModal('Tidy up', `<p class="dialog-copy">How long agents stay where they are before Synapse moves them along. Agents that are working or waiting for you are never touched.</p>
      <label class="field-label" for="tidy-idle">Done turns to Idle after</label>${select('tidy-idle', tidy.idle, [[HOUR, '1 hour'], [6 * HOUR, '6 hours'], [DAY, '1 day'], [3 * DAY, '3 days'], never])}
      <label class="field-label" for="tidy-archive">Unused agents go to Archived after</label>${select('tidy-archive', tidy.archive, [[DAY, '1 day'], [3 * DAY, '3 days'], [7 * DAY, '1 week'], [14 * DAY, '2 weeks'], never])}
      <label class="field-label" for="tidy-close">Idle agents end after</label>${select('tidy-close', tidy.close, [[3 * DAY, '3 days'], [7 * DAY, '1 week'], [14 * DAY, '2 weeks'], [30 * DAY, '30 days'], never])}
      <p class="field-hint">Closing ends the agent's process and clears its marks and draft here. An agent in one of your own terminals is ended there and the terminal stays open. Its conversation stays on disk and can be resumed from Past chats. Friends' agents are never touched.</p>`, 'Save', async () => {
      tidy = { idle: Number($('tidy-idle').value), archive: Number($('tidy-archive').value), close: Number($('tidy-close').value) };
      setStorage('synapse-tidy', JSON.stringify(tidy)); renderSidebar();
    });
  }
  const stateOf = (a) => (needsYou(a) ? 'needs' : a.status === 'busy' ? 'working' : doneSet.has(a.id) ? 'done' : a.exited ? 'ended' : 'idle');
  const isSnoozed = (a) => snoozed[a.id] !== undefined && a.id !== selectedId;
  // Status view sorts by trigger: when each agent entered its current state. Output from a working agent does not
  // reorder anything; a row moves only when its agent starts, stops, finishes or needs you, and then it goes on top.
  const triggered = new Map();
  const statusKey = (a) => (stateOf(a) === 'ended' ? 'idle' : stateOf(a));
  function triggerAt(a) {
    const key = statusKey(a), seen = triggered.get(a.id);
    if (seen?.key === key) return seen.at;
    const at = seen ? Date.now() : (a.lastActivity || 0); // first sighting keeps the order agents had
    triggered.set(a.id, { key, at });
    return at;
  }
  const byTrigger = (x, y) => triggerAt(y.a) - triggerAt(x.a) || String(x.a.id).localeCompare(String(y.a.id));
  // rows slide from where they were to where they are (FLIP); one that moved up glows once
  let foldingNow = false; // a section folding or opening: its rows appear in place, nothing slides
  function flipStart() {
    if (groupBy !== 'status' || foldingNow || matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    const at = new Map();
    // only rows on screen: a folded row measures as top 0 and would seem to come from the top
    for (const [id, node] of sessionElements) if (node.isConnected && node.getClientRects().length) at.set(id, node.getBoundingClientRect().top);
    return at;
  }
  function flipEnd(before) {
    if (!before?.size) return;
    for (const [id, node] of sessionElements) {
      if (!node.isConnected || !node.getClientRects().length) continue;
      if (!before.has(id)) { node.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' }); continue; }
      const dy = before.get(id) - node.getBoundingClientRect().top;
      if (Math.abs(dy) < 2) continue;
      if (dy > 0) node.classList.add('moving-up');
      node.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)' })
        .finished.catch(() => {}).then(() => node.classList.remove('moving-up'));
      if (dy > 0) node.firstElementChild?.animate([{ backgroundColor: 'color-mix(in srgb, var(--color-accent) 24%, transparent)' }, { backgroundColor: 'transparent' }], { duration: 1400, easing: 'ease-out' });
    }
  }
  const isArchived = (a) => archived[a.id] !== undefined && a.id !== selectedId;
  function snooze(id, until) {
    if (until === null) delete snoozed[id]; else snoozed[id] = until;
    saveMarks(); renderSidebar();
    const a = byId.get(id);
    if (until !== null) toast(`Snoozed ${a ? titleOf(a) : 'session'}${until ? ` until ${new Date(until).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ' until it needs you'}`, () => snooze(id, null));
  }
  const tomorrowMorning = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); };
  // Right-click an agent: everything the /synapse skill does (link, message, plan, read, share), plus snooze,
  // archive and the session itself
  function sessionActions(agent) {
    const z = snoozed[agent.id] !== undefined, arch = archived[agent.id] !== undefined;
    const linkable = !agent.owned || agent.backendId, peers = relations(agent.id);
    const others = state.agents.filter((a) => a.id !== agent.id && (!a.owned || a.backendId) && !a.remote);
    const mine = friends?.signedIn && friends.agents.some((a) => a.id === (agent.backendId || agent.id));
    return [
      { label: 'Open', icon: 'arrow-right', run: () => navigate('session', agent.id) },
      { label: 'Rename…', icon: 'edit', run: () => { navigate('session', agent.id); renameAgent(); } },
      ...(linkable ? [
        { heading: 'Synapse' },
        ...(others.length ? [{ label: 'Link to another agent…', icon: 'network', run: () => linkAgent(agent) }] : []),
        ...peers.map((p) => ({ label: `Unlink ${titleOf(p.agent)}`, icon: 'unlink', run: () => removeLinks(p.edges.map((e) => e.id)) })),
        { label: 'Send a message…', icon: 'message', run: () => messageAgent(agent) },
        ...(others.length && !agent.remote ? [{ label: 'Start a plan with…', icon: 'check', run: () => planWith(agent) }] : []),
        { label: 'Read its context', icon: 'panel-right', run: () => { navigate('session', agent.id); inspectorOpen = true; setStorage('synapse-inspector', 'open'); inspectorFile = null; inspectorSignature = ''; syncInspector(); } },
        { label: 'Copy its handle', icon: 'copy', run: () => navigator.clipboard.writeText(agent.remote ? `${agent.name}@${agent.remote.handle || agent.remote.owner}` : agent.name).catch(() => toast(agent.name)) },
      ] : []),
      ...(mine ? [{ heading: 'Friends' }, { label: 'Share with a friend…', icon: 'users', run: () => { friendPreset = { who: null, agent: agent.backendId || agent.id }; addConnection('share'); } }] : []),
      '-',
      ...(z ? [{ label: 'Wake up', icon: 'sun', run: () => snooze(agent.id, null) }] : [
        { label: 'Snooze 1 hour', icon: 'clock', run: () => snooze(agent.id, Date.now() + 3_600_000) },
        { label: 'Snooze until tomorrow', icon: 'clock', run: () => snooze(agent.id, tomorrowMorning()) },
        { label: 'Snooze until it needs me', icon: 'clock', run: () => snooze(agent.id, 0) },
      ]),
      ...(doneSet.has(agent.id) ? [{ label: 'Mark as seen', icon: 'check', run: () => { doneSet.delete(agent.id); saveMarks(); renderSidebar(); } }] : []),
      arch ? { label: 'Unarchive', icon: 'archive', run: () => archive(agent.id, false) } : { label: 'Archive', icon: 'archive', run: () => archive(agent.id, true) },
      ...(agent.owned ? ['-', { label: 'Close session', danger: true, run: () => runDesktop('close', { id: agent.id }) }] : []),
    ];
  }
  function archive(id, on) {
    if (on) { archived[id] = Date.now(); delete snoozed[id]; doneSet.delete(id); const a = byId.get(id); if (a && (a.status === "busy" || needsYou(a))) archivedBusy.add(id); } else { delete archived[id]; unarchivedAt[id] = Date.now(); }
    saveMarks();
    if (on && selectedId === id) { const next = state.agents.find((a) => a.id !== id && !archived[a.id]); navigate(next ? 'session' : 'overview', next?.id || null); }
    renderSidebar();
  }
  const backend = (a) => a.backendId || a.id;
  const agentOptions2 = (omit) => state.agents.filter((a) => a.id !== omit && (!a.owned || a.backendId) && !a.remote)
    .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(titleOf(a))} · ${escapeHtml(a.name)}</option>`).join('');
  function linkAgent(agent) {
    openModal(`Link ${titleOf(agent)}`, `<p class="dialog-copy">Linked agents get each other's context on their next prompt and can message each other.</p>
      <label class="field-label" for="link-other">With</label><select class="field" id="link-other">${agentOptions2(agent.id)}</select>
      <label class="field-label" for="link-way">Context flows</label><select class="field" id="link-way"><option value="both">Both ways</option><option value="out">From ${escapeHtml(agent.name)} to the other</option><option value="in">From the other to ${escapeHtml(agent.name)}</option></select>`, 'Link', async () => {
      const other = $('link-other').value, way = $('link-way').value;
      if (way !== 'in') await createEdge(agent.id, other);
      if (way !== 'out') await createEdge(other, agent.id);
      await reloadState(); toast('Linked. Context arrives on their next prompt.');
    });
  }
  function messageAgent(agent) {
    openModal(`Message ${titleOf(agent)}`, `<label class="field-label" for="agent-note">Message</label><textarea class="field" id="agent-note" rows="4" maxlength="12000" required placeholder="What should ${escapeHtml(agent.name)} know or do?"></textarea><p class="field-hint">${agent.owned ? 'Typed into the session as your next prompt.' : 'Delivered on its next prompt or inbox check.'}</p>`, 'Send', async () => {
      const text = $('agent-note').value.trim(); if (!text) throw new Error('Write a message first.');
      if (agent.owned) await desktopCall('submit', { id: agent.id, text });
      else await api(`/api/agents/${encodeURIComponent(agent.id)}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
      { const stale = recentCache.get(agent.id); if (stale) stale.activity = -1; } 
    });
  }
  function planWith(agent) {
    const choices = state.agents.filter((a) => a.id !== agent.id && (!a.owned || a.backendId) && !a.remote)
      .map((a) => `<label class="plan-pick"><input type="checkbox" value="${escapeHtml(backend(a))}"><span>${escapeHtml(titleOf(a))}</span><small>${escapeHtml(a.name)} · ${escapeHtml(kindName(a))}</small></label>`).join('');
    openModal('Start a plan', `<p class="dialog-copy">${escapeHtml(agent.name)} and the agents you pick get the goal, are linked, and split the work into tasks they claim and finish.</p>
      <label class="field-label" for="plan-goal">Goal</label><textarea class="field" id="plan-goal" rows="3" maxlength="2000" required placeholder="e.g. ship the new checkout behind a flag"></textarea>
      <p class="field-label">With</p><div class="plan-picks">${choices}</div>`, 'Start plan', async () => {
      const with_ = [...document.querySelectorAll('.plan-picks input:checked')].map((i) => i.value);
      if (!with_.length) throw new Error('Pick at least one other agent.');
      await api('/api/plans', { method: 'POST', body: JSON.stringify({ from: backend(agent), agents: with_, goal: $('plan-goal').value }) });
      await reloadState(); toast('Plan started. The others got the goal.');
    });
  }
  const shelves = new Map(), flatSections = new Map();
  let peopleSection = null;
  function shelf(key, label, entries, nodeOf) {
    let el = shelves.get(key);
    if (!el) {
      el = document.createElement('section'); el.className = 'settled-group'; el.dataset.shelf = key;
      el.innerHTML = `<button class="settled-button" type="button" data-settled-toggle="${key}"><span></span><span class="count"></span><span class="settled-chevron">${icon('chevron-down')}</span></button><div class="settled-list"></div>`;
      shelves.set(key, el);
    }
    const open = collapsed.has(`${key}:open`);
    el.querySelector('span').textContent = label;
    el.querySelector('.count').textContent = entries.length;
    el.firstElementChild.setAttribute('aria-expanded', String(open));
    el.lastElementChild.hidden = !open;
    syncChildren(el.lastElementChild, entries.map(nodeOf));
    return el;
  }
  function flatSection(key, label, nodes, count = nodes.length) {
    let el = flatSections.get(key);
    if (!el) {
      el = document.createElement('section'); el.className = 'flat-group'; el.dataset.flat = key;
      el.innerHTML = `<h3 class="flat-heading"><button type="button" class="fold-toggle" data-fold-toggle="flat:${escapeHtml(key)}"><span class="flat-dot"></span><span class="flat-label"></span><span class="count"></span><span class="fold-chevron">${icon('chevron-down')}</span></button></h3><div class="flat-list"></div>`;
      flatSections.set(key, el);
    }
    // a heading folds its section (remembered); the count stays in view
    const closed = collapsed.has(`flat:${key}:closed`);
    el.querySelector('.fold-toggle').setAttribute('aria-expanded', String(!closed));
    el.lastElementChild.hidden = closed;
    el.querySelector('.flat-label').textContent = label;
    el.querySelector('.count').textContent = count;
    syncChildren(el.lastElementChild, nodes);
    return el;
  }

  function renderSidebar() {
    if (sidebarDrag || paneKey) return;
    trackStates();
    for (const a of state.agents) triggerAt(a); // note every state change, even in a group of one
    for (const id of triggered.keys()) if (!byId.has(id)) triggered.delete(id);
    const flip = flipStart();
    const groups = projectGroups(true), desired = [], live = new Set(), liveWorktrees = new Set(), settledRoots = [], snoozedRoots = [];
    // the search box filters the list as you type (fuzzy, like ⌘K); a fork stays under its parent
    const query = sidebarQuery.trim();
    const hits = query ? new Set(searchSessions(state.agents, query).map((a) => a.id)) : null;
    const shown = (entry) => !hits || hits.has(entry.agent.id) || entry.children.some(shown);
    const prune = (entry) => ({ ...entry, children: entry.children.filter(shown).map(prune) });
    // Settled: sessions that ended or rested a day fold into one row at the bottom, so the list shows current work
    const settled = (a) => !hits && (settledAt[a.id] !== undefined || (a.id !== selectedId && !doneSet.has(a.id) && (a.exited || (!['busy', 'waiting', 'needs_input'].includes(a.status) && Date.now() - (a.lastActivity || 0) > 86_400_000))));
    const settledTree = (entry) => settled(entry.agent) && entry.children.every(settledTree);
    const snoozedTree = (entry) => !hits && isSnoozed(entry.agent) && entry.children.every((c) => isSnoozed(c.agent) || settledTree(c));
    const archivedTree = (entry) => !hits && isArchived(entry.agent) && entry.children.every((c) => isArchived(c.agent) || archivedTree(c));
    const archivedRoots = [];
    const sessionNode = ({ agent, children }, depth = 0, place = '') => {
      live.add(agent.id);
      let node = sessionElements.get(agent.id);
      if (!node) {
        node = document.createElement('div'); node.className = 'session-node';
        node.innerHTML = '<button type="button" class="session-row"><span class="session-kind" aria-hidden="true"></span><span class="session-text"><span class="session-name"></span><span class="session-sub"></span></span><span class="session-meta"><span class="state-pill"></span><span class="status-dot" aria-hidden="true"></span><span class="session-time"></span><span class="row-actions"><span class="row-act" role="button" tabindex="-1" data-row-act="settle"></span><span class="row-act" role="button" tabindex="-1" data-row-act="archive"></span></span></span></button><div class="session-children"></div>';
        node.firstElementChild.dataset.agent = agent.id;
        sessionElements.set(agent.id, node);
      }
      const row = node.firstElementChild, st = stateOf(agent);
      row.dataset.state = st;
      const dot = row.querySelector('.status-dot');
      dot.classList.toggle('busy', st === 'working');
      dot.classList.remove('done', 'waiting');
      const pill = row.querySelector('.state-pill');
      pill.className = `state-pill ${st}`;
      pill.innerHTML = st === 'needs' ? 'Needs you' : st === 'done' ? 'Active' : snoozed[agent.id] !== undefined ? `${icon('clock')}` : '';
      const label = titleOf(agent);
      row.querySelector('.session-name').textContent = label;
      // the second line says who: the agent's name, or its tool when the name is just a generated one
      const who = label === agent.name ? '' : GENERATED.test(agent.name || '') ? kindName(agent) : agent.name;
      const shared = (friends?.links || []).some((l) => l.local && (l.local.id === agent.backendId || l.local.id === agent.id));
      // second line: the agent's tool (its logo) and who it is; left: the project's GitHub owner picture
      // the project view is lean: one line per agent, no icons; a second line only when it says something
      const lean = groupBy === 'project' && !place;
      row.classList.toggle('lean', lean);
      const sub = lean ? who : [place, who || kindName(agent)].filter(Boolean).join(' · ');
      const logo = LOGOS.has(agent.kind) && !lean ? agent.kind : '';
      const subHtml = `${shared ? `<span class="shared-mark" title="Shared with a friend">${icon('users')}</span>` : ''}${logo ? `<span class="sub-kind" data-logo="${escapeHtml(logo)}" aria-hidden="true"></span>` : ''}${escapeHtml(sub)}`;
      if (row.dataset.sub !== subHtml) { row.dataset.sub = subHtml; row.querySelector('.session-sub').innerHTML = subHtml; }
      row.classList.add('titled');
      const kindEl = row.querySelector('.session-kind'), orgDir = agent.remote ? '' : agent.worktreePath || agent.cwd || '';
      const org = String(orgDir).startsWith('/') ? avatarSrc(orgDir) : '';
      if (kindEl.dataset.org !== org || kindEl.dataset.kind !== (agent.kind || '')) {
        kindEl.dataset.org = org; kindEl.dataset.kind = agent.kind || '';
        kindEl.classList.toggle('org', !!org);
        kindEl.dataset.logo = org ? '' : logo;
        kindEl.textContent = org ? '' : initials(agent);
        if (org) {
          const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.src = org;
          // no picture for this project: the agent's own logo, as before
          img.onerror = () => { avatarMiss.add(orgDir); kindEl.dataset.org = ''; kindEl.classList.remove('org'); kindEl.dataset.logo = logo; kindEl.textContent = initials(agent); };
          kindEl.append(img);
        }
      }
      // a resting agent shows how long ago it last worked; one with a state shows that instead
      row.querySelector('.session-time').textContent = ['working', 'needs', 'done'].includes(st) || agent.exited ? '' : relativeTime(usedAt(agent));
      // on hover: ✓ settles it (or brings it back), the box archives it (or brings it back)
      const isSettled = settledAt[agent.id] !== undefined, isArch = archived[agent.id] !== undefined;
      const acts = `${isSettled}|${isArch}`;
      if (row.dataset.acts !== acts) {
        row.dataset.acts = acts;
        const [settle, arch] = row.querySelectorAll('.row-act');
        settle.innerHTML = icon(isSettled ? 'arrow-up' : 'check'); settle.title = isSettled ? 'Bring back from Settled' : 'Settle'; settle.setAttribute('aria-label', settle.title);
        arch.innerHTML = icon(isArch ? 'arrow-up' : 'archive'); arch.title = isArch ? 'Unarchive' : 'Archive'; arch.setAttribute('aria-label', arch.title);
        settle.hidden = isArch;
      }
      row.title = `${label}${label === agent.name ? '' : ` · ${agent.name}`} · ${kindName(agent)} · ${activityLabel(agent)}${agent.remote ? ` · ${agent.remote.owner}'s machine` : ''}${agent.owned && groupBy === 'project' ? ' · Drag to reorder' : ''}`;
      node.dataset.depth = depth;
      sortHandle(node, row, 'session', agent.id, agent.owned && groupBy === 'project' && !place);
      if (view === 'session' && selectedId === agent.id) row.setAttribute('aria-current', 'page'); else row.removeAttribute('aria-current');
      syncChildren(node.lastElementChild, children.map((child) => sessionNode(child, depth + 1)));
      node.lastElementChild.hidden = !children.length;
      return node;
    };
    const visibleGroups = groups.filter((g) => !hits || g.agents.some((a) => hits.has(a.id)));
    if (groupBy === 'project') {
      for (const group of groups) {
        let section = projectElements.get(group.key);
        if (!section) {
          section = document.createElement('section'); section.className = 'project-group'; section.dataset.projectKey = group.key;
          section.innerHTML = `<div class="project-heading"><button class="project-button" type="button"><span class="project-badge" aria-hidden="true"></span><span class="project-name"></span><span class="project-chevron">${icon('chevron-down')}</span><span class="count"></span></button><button class="project-add project-session desktop-only" type="button" aria-label="New session" title="New session">${icon('compose')}</button><button class="project-add desktop-only" type="button" aria-label="Add worktree" title="New worktree">${icon('branch')}</button></div><div class="project-worktrees"></div>`;
          section.querySelector('.project-button').dataset.project = group.key;
          section.querySelector('.project-add:not(.project-session)').dataset.createWorktree = group.key;
          projectElements.set(group.key, section);
        }
        const button = section.querySelector('.project-button');
        button.querySelector('.project-name').textContent = group.name;
        const badge = button.querySelector('.project-badge');
        if (badge.dataset.text !== badgeText(group.name)) { badge.dataset.text = badgeText(group.name); badge.textContent = badge.dataset.text; }
        badge.style.setProperty('--badge', projectColor(group));
        const dir = groupDir(group);
        if (badge.dataset.dir !== dir) { badge.dataset.dir = dir; badge.querySelector('img')?.remove(); badge.classList.remove('has-img'); const img = avatarImg(dir, 'badge-img'); if (img) badge.append(img); }
        const home = group.worktrees.find((w) => w.home && w.managed);
        section.querySelector('.project-session').hidden = !home;
        if (home) section.querySelector('.project-session').dataset.newSessionCwd = home.path;
        button.querySelector('.count').textContent = group.agents.length;
        button.title = group.managed ? `${group.name} · Drag to reorder` : group.name;
        section.querySelector('.project-add:not(.project-session)').hidden = !group.managed;
        sortHandle(section, button, 'project', group.key, group.managed);
        // a folded project unfolds while the pointer rests on it (CSS); clicking its name pins it open or folded
        const folded = !hits && collapsed.has(group.key);
        button.setAttribute('aria-expanded', String(!folded));
        section.classList.toggle('folded', folded);
        // one level: every agent of the project, whatever worktree it runs in, in one list (the main checkout first)
        const key = `project:${group.key}`;
        liveWorktrees.add(key);
        let node = worktreeElements.get(key);
        if (!node) {
          node = document.createElement('div'); node.className = 'project-agents';
          node.innerHTML = '<div class="worktree-sessions"></div>';
          worktreeElements.set(key, node);
        }
        const keep = [];
        for (const worktree of group.worktrees) {
          for (const entry of sessionTree(worktree.agents).filter(shown).map(prune)) {
            if (archivedTree(entry)) archivedRoots.push({ entry, place: group.name });
            else if (snoozedTree(entry)) snoozedRoots.push({ entry, place: group.name });
            else if (settledTree(entry)) settledRoots.push({ entry, place: group.name });
            else keep.push({ entry, path: worktree.path });
          }
        }
        // an agent reorders only among those in its own folder, since its process runs there
        syncChildren(node.firstElementChild, keep.map(({ entry, path }) => { const n = sessionNode(entry); n.dataset.sortGroup = path; return n; }));
        syncChildren(section.lastElementChild, [node]);
        section.hidden = !!hits && !keep.length;
        section.classList.toggle('empty', !keep.length);
        desired.push(section);
      }
    } else {
      // every agent on its own row, forks included, by state or by time
      const agents = groups.flatMap((g) => g.agents.map((a) => ({ a, place: g.name }))).filter(({ a }) => !hits || hits.has(a.id));
      const rows = [];
      for (const item of agents) {
        const entry = { agent: item.a, children: [] };
        if (!hits && isArchived(item.a)) archivedRoots.push({ entry, place: item.place });
        else if (!hits && isSnoozed(item.a)) snoozedRoots.push({ entry, place: item.place });
        else if (settled(item.a)) settledRoots.push({ entry, place: item.place });
        else rows.push({ ...item, entry });
      }
      const recent = (x, y) => (y.a.lastActivity || 0) - (x.a.lastActivity || 0);
      if (groupBy === 'status') {
        for (const [key, label] of [['needs', 'Needs you'], ['working', 'Working'], ['done', 'Active'], ['idle', 'Idle']]) {
          const these = rows.filter((r) => statusKey(r.a) === key).sort(byTrigger);
          if (!these.length) continue;
          desired.push(flatSection(key, label, these.map((r) => sessionNode(r.entry, 0, r.place))));
        }
      } else desired.push(flatSection('recent', 'Recent', rows.sort(recent).map((r) => sessionNode(r.entry, 0, r.place))));
      for (const g of groups) for (const w of g.worktrees) liveWorktrees.add(`worktree:${w.path}`);
    }
    // People: the friends you trust, their shared agents, and what waits between you
    const people = peopleNode(sessionNode, hits);
    if (people) desired.push(people);
    const byRecent = (x, y) => (y.entry.agent.lastActivity || 0) - (x.entry.agent.lastActivity || 0);
    if (snoozedRoots.length) desired.push(shelf('snoozed', 'Snoozed', snoozedRoots.sort(byRecent), ({ entry, place }) => sessionNode(entry, 0, place)));
    if (settledRoots.length) desired.push(shelf('settled', 'Settled', settledRoots.sort(byRecent), ({ entry, place }) => sessionNode(entry, 0, place)));
    if (archivedRoots.length) desired.push(shelf('archived', 'Archived', archivedRoots.sort(byRecent), ({ entry, place }) => sessionNode(entry, 0, place)));
    for (const [id, node] of sessionElements) if (!live.has(id)) { node.remove(); sessionElements.delete(id); }
    for (const [key, node] of worktreeElements) if (!liveWorktrees.has(key)) { node.remove(); worktreeElements.delete(key); }
    for (const [key, section] of projectElements) if (!groups.some((group) => group.key === key)) { section.remove(); projectElements.delete(key); }
    if (!groups.length && !people) {
      const empty = document.createElement('p'); empty.className = 'sidebar-placeholder';
      empty.textContent = ready ? 'Your projects will appear here.' : 'Finding your sessions…'; desired.push(empty);
    } else if (hits && !visibleGroups.length && !people?.querySelector('.session-row')) {
      const empty = document.createElement('p'); empty.className = 'sidebar-placeholder'; empty.textContent = `Nothing matches “${query}”.`; desired.push(empty);
    }
    syncChildren($('project-list'), desired);
    flipEnd(flip);
    $('project-list').dataset.group = groupBy;
    $('project-count').textContent = groups.length || '';
    const linkCount = state.edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to)).length;
    $('connection-count').textContent = linkCount; $('connection-count').toggleAttribute('data-zero', !linkCount);
    const waiting = state.agents.filter((a) => needsYou(a)).length;
    document.title = `${waiting ? `(${waiting}) ` : ''}${document.title.replace(/^\(\d+\) /, '')}`;
    document.querySelectorAll('[data-view]').forEach((button) => {
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
  }
  // a project's GitHub owner picture (the org or user), like T3; the letters stay when there is none
  const avatarMiss = new Set();
  const avatarSrc = (dir) => (dir && !avatarMiss.has(dir) ? `/api/avatar?${new URLSearchParams({ dir })}` : '');
  function avatarImg(dir, className) {
    const src = avatarSrc(dir); if (!src) return null;
    const img = document.createElement('img'); img.className = className; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    img.onerror = () => { avatarMiss.add(dir); img.parentElement?.classList.remove('has-img'); img.remove(); };
    img.onload = () => img.parentElement?.classList.add('has-img');
    img.src = src;
    return img;
  }
  const groupDir = (group) => (group.worktrees.find((w) => w.home) || group.worktrees[0])?.path || group.agents[0]?.cwd || '';
  const projectColor = (group) => group.agents.find((a) => a.color)?.color || `oklch(70% 0.13 ${hueOf(group.key)})`;

  // People in the sidebar: each trusted person with their shared agents under them. Click a person to ask for
  // access, share the open agent, or answer what waits on you.
  function peopleNode(sessionNode, hits) {
    if (!embedded || !friends?.signedIn) return null;
    const remote = state.agents.filter((a) => a.remote && (!hits || hits.has(a.id)));
    const list = [...friends.people];
    for (const a of remote) if (!list.some((p) => p.name === a.remote.owner || p.handle === a.remote.handle)) list.push({ name: a.remote.owner, handle: a.remote.handle || null, trustsYou: true });
    if (!list.length && !friends.incoming.length) return null;
    peopleSection ||= Object.assign(document.createElement('section'), { className: 'people-group',
      innerHTML: `<div class="people-heading"><button type="button" class="fold-toggle" data-fold-toggle="people"><span>People</span><span class="count"></span><span class="fold-chevron">${icon('chevron-down')}</span></button><button class="project-add" type="button" data-person-add="1" aria-label="Trust someone new" title="Trust someone new">${icon('plus')}</button></div><div class="people-list"></div>` });
    peopleSection.querySelector('.count').textContent = list.length || '';
    const peopleClosed = collapsed.has('people:closed');
    peopleSection.querySelector('.fold-toggle').setAttribute('aria-expanded', String(!peopleClosed));
    peopleSection.lastElementChild.hidden = peopleClosed;
    const rows = list.map((p) => {
      const mine = remote.filter((a) => a.remote.owner === p.name || (p.handle && a.remote.handle === p.handle));
      const asks = friends.incoming.filter((r) => r.from?.handle === p.handle || r.from?.name === p.name).length;
      const waits = friends.outgoing.filter((r) => r.to?.handle === p.handle || r.to?.name === p.name).length;
      const state = asks ? `${asks} request${asks === 1 ? '' : 's'} for you` : waits ? 'Waiting for them' : p.pending ? 'Invite pending' : !p.trustsYou ? 'Has not added you back' : mine.length ? `${mine.length} agent${mine.length === 1 ? '' : 's'} shared` : 'Trusted';
      const wrap = document.createElement('div'); wrap.className = 'person-node';
      wrap.innerHTML = `<button type="button" class="person-row" data-person="${escapeHtml(p.handle || p.name)}"><span class="person-avatar" style="--badge: oklch(70% 0.12 ${hueOf(p.handle || p.name)})">${escapeHtml(badgeText(p.name))}</span><span class="session-text"><span class="session-name">${escapeHtml(p.name)}</span><span class="session-sub">${escapeHtml(state)}</span></span>${asks ? '<span class="state-pill needs">Ask</span>' : ''}</button><div class="person-agents"></div>`;
      syncChildren(wrap.lastElementChild, mine.map((a) => sessionNode({ agent: a, children: [] }, 0)));
      return wrap;
    });
    syncChildren(peopleSection.lastElementChild, rows);
    return peopleSection;
  }
  function trustSomeone() {
    openModal('Trust someone', '<p class="dialog-copy">Add a person by email or @handle. Once they add you back you can share agents and ask for theirs.</p><label class="field-label" for="trust-who">Email or @handle</label><input class="field" id="trust-who" maxlength="120" autocomplete="off" required placeholder="name@example.com">', 'Add', async () => {
      await desktopCall('people-add', { who: $('trust-who').value.trim() });
      await loadFriends(); renderSidebar(); toast('Added. They can add you back from their Synapse.');
    });
  }
  function groupMenu() {
    const set = (g) => () => { groupBy = g; setStorage('synapse-group', g); renderSidebar(); };
    const mark = (g) => (groupBy === g ? 'check' : '');
    dropdown($('group-by'), [
      { label: 'Group by project', icon: mark('project'), run: set('project') },
      { label: 'Group by status', icon: mark('status'), run: set('status') },
      { label: 'Most recent first', icon: mark('recent'), run: set('recent') },
      '-',
      { label: 'Tidy up…', icon: 'clock', run: () => (embedded ? desktopCall('settings', { pane: 'cleanup' }).catch((e) => toast(e.message)) : tidyDialog()) },
    ]);
  }
  function personMenu(button) {
    const key = button.dataset.person, p = friends?.people.find((x) => x.handle === key || x.name === key) || { name: key, handle: key };
    const agent = byId.get(selectedId), ready = p.trustsYou && !p.pending && p.handle;
    dropdown(button, [
      ...(ready ? [
        { label: `Ask ${p.name} for an agent…`, icon: 'message', run: () => { friendPreset = { who: p.handle, agent: agent?.owned ? mineId(agent.id) : null }; addConnection('ask'); } },
        ...(agent?.owned ? [{ label: `Share "${titleOf(agent)}" with ${p.name}…`, icon: 'users', run: () => { friendPreset = { who: p.handle, agent: mineId(agent.id) }; addConnection('share'); } }] : []),
      ] : [{ label: p.pending ? 'Waiting for them to accept your invite' : `${p.name} has not added you back yet`, icon: 'clock', run: () => {} }]),
      '-',
      { label: 'Requests and shared agents', icon: 'network', run: () => navigate('connections') },
    ]);
  }

  const sortableSiblings = (item) => [...item.parentElement.children].filter((node) => node.dataset.sortKind === item.dataset.sortKind && node.dataset.sortGroup === item.dataset.sortGroup);
  async function reorderSidebar(item, target, side) {
    const name = item.firstElementChild.textContent.trim(), other = target.firstElementChild.textContent.trim();
    desktop = await desktopCall('reorder', { kind: item.dataset.sortKind, from: item.dataset.sortId, to: target.dataset.sortId, side });
    $('sidebar-order-status').textContent = `Moved ${name} ${side} ${other}.`;
  }
  $('project-list').addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-sort-handle]'), item = handle?.closest('[data-sort-kind]');
    if (!item || event.button !== 0 || sidebarDrag || event.target.closest('[data-row-act]')) return; // a row's own icons are clicks, never drags
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

  // Back and forward, like a browser or T3: every view you open is a step (⌘← ⌘→, the mouse's side buttons)
  let navPos = 0, navMax = 0;
  function syncNavArrows() { $('nav-back').disabled = navPos <= 0; $('nav-forward').disabled = navPos >= navMax; }
  $('nav-back').onclick = () => { if (navPos > 0) history.back(); };
  $('nav-forward').onclick = () => { if (navPos < navMax) history.forward(); };
  addEventListener('mouseup', (event) => { if (event.button === 3) { event.preventDefault(); $('nav-back').click(); } if (event.button === 4) { event.preventDefault(); $('nav-forward').click(); } });
  function navigate(nextView, id = null, push = true) {
    if (nextView === 'canvas' && embedded) nextView = 'session'; // the canvas lives in Terminal mode; the GUI is the list
    if (paneKey && nextView === 'session' && id !== selectedId) { persistDraft(); parent.postMessage({ type: 'synapse:pane-navigate', id }, location.origin); return; }
    persistDraft();
    recentController?.abort(); recentTarget = null; recentRequest++;
    // another agent or page: its content eases in instead of snapping
    if (nextView !== view || (nextView === 'session' && id !== selectedId)) {
      const area = document.querySelector('.content-area');
      area.classList.remove('switching'); void area.offsetWidth; area.classList.add('switching');
    }
    view = nextView; selectedId = nextView === 'session' ? id : selectedId;
    tab = defaultTab(byId.get(selectedId)); limit = 60;
    if (nextView === 'session') {
      setStorage('synapse-selected', id);
      $('message-input').value = drafts[id] || '';
    }
    if (push) {
      const route = nextView === 'session' ? `agent=${encodeURIComponent(id)}` : nextView;
      if (location.hash !== `#${route}`) { navPos++; navMax = navPos; history.pushState({ view: nextView, id: selectedId, pos: navPos }, '', `#${route}`); syncNavArrows(); }
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
    $('new-view').hidden = view !== 'new';
    $('overview-view').hidden = view !== 'overview';
    $('connections-view').hidden = view !== 'connections';
    $('activity-view').hidden = view !== 'activity';
    $('todos-view').hidden = view !== 'todos';
    $('rooms-view').hidden = view !== 'rooms';
    $('canvas-view').hidden = view !== 'canvas';
    $('session-actions').hidden = !isSession;
    if (isSession) {
      const breadcrumbs = `<span class="crumb-project">${escapeHtml(agent.project)}</span><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-title">${escapeHtml(titleOf(agent))}</span>`;
      if ($('breadcrumbs').innerHTML !== breadcrumbs) $('breadcrumbs').innerHTML = breadcrumbs;
      const statusKey = `${agent.status}|${activityLabel(agent)}`;
      if ($('session-status').dataset.key !== statusKey) { $('session-status').dataset.key = statusKey; $('session-status').innerHTML = `${status(agent)}${activityLabel(agent)}`; }
      $('provider-label').innerHTML = `${avatar(agent)}<span>${escapeHtml(kindName(agent))}</span>${agent.modelName ? `<span class="model-name">${escapeHtml(agent.modelName)}</span>` : ''}${embedded && agent.owned && agent.kind === 'claude' ? icon('chevron-down') : ''}`;
      $('provider-label').classList.toggle('pickable', !!(embedded && agent.owned && agent.kind === 'claude'));
      $('provider-label').title = `${agent.name} runs ${kindName(agent)} in ${agent.cwd || agent.project}`;
      if (embedded) {
        for (const id of ['open-terminal']) $(id).hidden = !agent.owned;
        $('fork-session').disabled = !['claude', 'codex'].includes(agent.kind) && !state.demo;
      }
      $('delivery-note').textContent = agent.owned ? 'Sent straight to this session; while it works, prompts wait in line and go in order. Its questions show up here.' : 'Delivered on the agent’s next prompt or inbox check.';
      if (tab === 'terminal' && !(embedded && agent.owned)) tab = 'conversation';
      const shell = embedded && agent.owned && agent.kind === 'shell'; // a shell has no conversation: its terminal is the view
      if (shell) tab = 'terminal';
      $('terminal-tab').hidden = !(embedded && agent.owned);
      $('conversation-tab').hidden = $('messages-tab').hidden = shell;
      for (const name of ['conversation', 'messages', 'terminal']) { $(`${name}-tab`).setAttribute('aria-selected', String(tab === name)); $(`${name}-tab`).tabIndex = tab === name ? 0 : -1; }
      $('thread-scroll').setAttribute('aria-labelledby', tab === 'messages' ? 'messages-tab' : 'conversation-tab');
      $('thread-scroll').hidden = tab === 'terminal';
      $('term-host').hidden = tab !== 'terminal';
      $('thread-view').querySelector('.composer-region').hidden = tab === 'terminal';
      if (embedded) { $('open-terminal').hidden = !agent.cwd; $('open-terminal').setAttribute('aria-expanded', String(!$('term-drawer').hidden)); }
      if (drawerCwd && agent.cwd && drawerCwd !== agent.cwd && !$('term-drawer').hidden) openDrawer(true);
      if (reset) { $('message-input').value = drafts[selectedId] || ''; $('send-error').hidden = true; renderAttachments(); }
      renderQueue();
      if (!split && tab !== 'terminal') { updateComposer(); renderTimeline(reset); loadRecent(); }
      document.title = `${titleOf(agent)} · Synapse`;
    } else {
      const title = view === 'new' ? 'New session' : view === 'todos' ? 'Todos' : view === 'rooms' ? 'Rooms' : view === 'activity' ? 'Activity' : view === 'canvas' ? 'Canvas' : view === 'connections' ? 'Connections' : 'Your workspace';
      $('breadcrumbs').textContent = title;
      if (view === 'new') renderNew();
      if (view === 'todos') { renderTodos(); refreshLinear(); }
      if (view === 'rooms') loadRooms(true);
      document.title = `${title} · Synapse`;
      if (view === 'canvas') { if (!$('gui-canvas').src) $('gui-canvas').src = '/canvas'; }
      else if (view === 'activity') activityView.refresh();
      else if (view === 'connections') renderConnections(); else if (view !== 'new') renderOverview();
    }
    syncInspector();
    syncDocks();
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

  let inspectorFile = null, fileRequest = 0, fileShown = ''; // { agent, path, cwd, mode, stack }; what the panel shows now
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
    if (f.error) { fileShown = ''; pane.innerHTML = head(file.path.split('/').pop(), file.path) + `<p class="inspector-note">Synapse can't open this file: ${escapeHtml(f.error)}</p>`; return; }
    // the same file, unchanged on disk, is already showing: leave it (a PDF or video would reload from the start)
    // a text file is the editable pane (/file): it follows changes on disk by itself, so a save is no reason to redraw
    const shown = JSON.stringify([f.path, f.type === 'text' ? 0 : f.mtime, f.type === 'text' ? 0 : f.size, file.mode, file.stack.length]);
    if (shown === fileShown && pane.dataset.filePath === f.path && pane.classList.contains('file-mode')) return;
    fileShown = shown;
    const raw = `/api/file/raw?${new URLSearchParams({ path: f.path, v: String(f.mtime || '') })}`;
    const lines = f.type === 'text' ? f.text.split('\n') : [];
    const facts = [f.type === 'dir' ? `${f.entries.length} items` : f.type === 'text' ? `${lines.length} lines` : f.ext || f.type, f.type !== 'dir' && fileSize(f.size), `edited ${relativeTime(f.mtime)} ago`, f.truncated && 'first 1 MB'].filter(Boolean);
    const tools = `<div class="file-tools"><span>${facts.map(escapeHtml).join(' · ')}</span><button class="text-button" data-file-act="open">Open</button><button class="text-button" data-file-act="reveal">Show in Finder</button><button class="text-button" data-file-act="copy">Copy path</button></div>`;
    let body;
    if (f.type === 'dir') body = `<div class="file-dir">${f.entries.map((e) => `<button type="button" class="file-link" data-file="${escapeHtml(`${f.path}/${e.name}`)}">${escapeHtml(e.name)}${e.dir ? '/' : ''}</button>`).join('') || '<p class="inspector-note">Empty folder.</p>'}</div>`;
    else if (f.type === 'image') body = `<div class="file-media"><img src="${raw}" alt="${escapeHtml(f.name)}"></div>`;
    else if (f.type === 'video' || f.type === 'audio') body = `<div class="file-media"><${f.type} src="${raw}" controls></${f.type}></div>`;
    else if (f.type === 'pdf') body = `<iframe class="file-pdf" src="${raw}" title="${escapeHtml(f.name)}"></iframe>`;
    else if (f.type === 'binary') body = `<p class="inspector-note">Binary file. Open it in its own app instead.</p>`;
    else if (f.type === 'text') body = `<iframe class="file-frame" title="${escapeHtml(f.name)}" src="/file?${new URLSearchParams({ path: file.path, cwd: file.cwd || '', theme: document.documentElement.dataset.theme || '', embed: '1', ...(file.mode ? { mode: file.mode === 'rendered' ? 'preview' : 'edit' } : {}) })}"></iframe>`;
    else body = `<div class="file-source">${lines.slice(0, 20000).map((l, i) => `<div class="file-line${i + 1 >= from && i + 1 <= to ? ' hit' : ''}"><span>${i + 1}</span><code>${escapeHtml(l) || ' '}</code></div>`).join('')}</div>`;
    const dir = f.type === 'dir' ? f.path : f.path.replace(/\/[^/]*$/, '');
    const root = (file.cwd || '').replace(/\/+$/, ''), inside = root && (dir === root || dir.startsWith(`${root}/`));
    pane.innerHTML = head(f.name + (f.type === 'dir' ? '/' : ''), inside ? `${root.split('/').pop()}${dir.slice(root.length)}/` : dir.replace(/^\/Users\/[^/]+/, '~'), tools) + body;
    pane.dataset.filePath = f.path;
    const hit = pane.querySelector('.file-line.hit');
    if (hit) hit.scrollIntoView({ block: 'center' });
    else pane.scrollTop = 0;
  }
  // the file pane follows the app's theme
  function themeFileFrame() { $('inspector').querySelector('iframe.file-frame')?.contentWindow?.postMessage({ type: 'synapse:theme', theme: document.documentElement.dataset.theme }, '*'); }
  // comments written in the file pane go to the agent it is open for, like a message typed in the composer
  // (held in the queue while the agent works or waits on you)
  addEventListener('message', async (event) => {
    const frame = $('inspector').querySelector('iframe.file-frame');
    if (!frame || event.source !== frame.contentWindow || event.data?.type !== 'synapse:file-comments') return;
    const reply = (r) => frame.contentWindow?.postMessage({ type: 'synapse:file-comments-result', ...r }, '*');
    const text = String(event.data.text || '').slice(0, 12000), agent = byId.get(inspectorFile?.agent);
    if (!agent || agent.exited || !text.trim()) return reply({ ok: false, error: agent ? 'this agent has ended' : 'no agent for this file' });
    try {
      const id = agent.id, holding = agent.owned && (agent.status === 'busy' || needsYou(agent) || queued[id]?.length || flushing.has(id));
      if (holding) { queued[id] = [...(queued[id] || []), { id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, at: Date.now() }]; saveQueue(); renderQueue(); }
      else if (agent.owned) await desktopCall('submit', { id, text });
      else await api(`/api/agents/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
      const stale = recentCache.get(id); if (stale) stale.activity = -1;
      if (selectedId === id && !holding) loadRecent(true).catch(() => {});
      reply({ ok: true });
    } catch (error) { reply({ ok: false, error: error.message }); }
  });
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-file]');
    if (link) { event.preventDefault(); openFile(link.dataset.file, link.dataset.cwd || inspectorFile?.cwd || byId.get(selectedId)?.cwd); return; }
    const act = event.target.closest('[data-file-act]')?.dataset.fileAct;
    if (!act || !inspectorFile) return;
    const path = $('inspector').dataset.filePath;
    if (act === 'details') { inspectorFile = null; syncInspector(); }
    else if (act === 'back') { inspectorFile.stack.pop(); const prev = inspectorFile.stack.at(-1); openFile(prev.path, prev.cwd, { back: true }); }
    else if (act === 'mode') { inspectorFile.mode = event.target.textContent === 'Source' ? 'source' : 'rendered'; renderInspector(); }
    else if (act === 'copy') navigator.clipboard.writeText(path).catch(() => toast(path));
    else if (path) api('/api/file/open', { method: 'POST', body: JSON.stringify({ path, reveal: act === 'reveal' }) }).catch((error) => toast(error.message));
  });

  // Changes: what this session's checkout has changed, with commit, push and pull request one click away
  const changeCache = new Map(); let changeTimer = null;
  async function loadChanges(agent, force = false) {
    if (!embedded || !agent?.owned) return null;
    const cached = changeCache.get(agent.id);
    if (!force && cached && (cached.pending || (Date.now() - cached.at < 8000 && cached.activity === agent.lastActivity))) return cached.data;
    const entry = { at: Date.now(), activity: agent.lastActivity, data: cached?.data || null, pending: true };
    changeCache.set(agent.id, entry);
    try { entry.data = await desktopCall('git', { id: agent.id, op: 'changes' }); } catch { entry.data = null; }
    entry.pending = false; entry.at = Date.now();
    if (selectedId === agent.id) { inspectorSignature = ''; if (inspectorOpen) renderInspector(); paintChangesChip(); }
    return entry.data;
  }
  const plusMinus = (a, d) => `<span class="add">+${a}</span> <span class="del">−${d}</span>`;
  function paintChangesChip() {
    const agent = byId.get(selectedId), c = agent && changeCache.get(agent.id)?.data, chip = $('changes-chip');
    const n = c?.git ? c.files.length : 0;
    chip.hidden = !n;
    if (n) chip.innerHTML = `${icon('branch')}<span>${n} file${n === 1 ? '' : 's'}</span> ${plusMinus(c.add, c.del)}`;
    // the branch this session works on, top right: a worktree or the main checkout, and whether it is only local
    const pill = $('branch-pill');
    pill.hidden = !c?.git;
    if (c?.git) {
      const tags = [c.worktree && ['worktree', 'Worktree: its own folder, separate from the main checkout'],
        !c.published && c.remote && c.branch && ['local only', 'Only on this machine: not pushed to the remote yet'],
        !c.remote && ['no remote', 'This repository has no remote'],
        c.published && c.ahead && [`↑${c.ahead}`, `${c.ahead} commit${c.ahead === 1 ? '' : 's'} not pushed`]].filter(Boolean);
      pill.innerHTML = `${icon('branch')}<span class="branch-name">${escapeHtml(c.branch || 'detached HEAD')}</span>${tags.map(([t, tip]) => `<span class="branch-tag${t === 'local only' ? ' local' : ''}" title="${escapeHtml(tip)}">${escapeHtml(t)}</span>`).join('')}`;
      pill.title = `${c.branch || 'Detached HEAD'}${c.worktree ? ' · worktree' : ' · main checkout'}${c.upstream ? ` · tracks ${c.upstream}` : c.published ? ' · on origin' : c.remote ? ' · only local' : ''}\nClick for changes`;
    }
  }
  function changesSection(agent) {
    if (!embedded || !agent.owned) return '';
    const c = changeCache.get(agent.id)?.data;
    if (!c) return `<section class="inspector-section changes"><h3 class="inspector-label">Changes</h3><p class="inspector-note">Reading this checkout…</p></section>`;
    if (!c.git) return '';
    const sync = c.upstream ? `${c.ahead ? `↑${c.ahead}` : ''}${c.behind ? ` ↓${c.behind}` : ''}`.trim() : c.remote ? 'not pushed' : '';
    const files = c.files.slice(0, 14).map((f) => `<button type="button" class="change-file" data-change-file="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}"><span class="change-status s-${escapeHtml(f.status)}">${escapeHtml(f.status)}</span><span class="change-path">${escapeHtml(f.path.split('/').pop())}<small>${escapeHtml(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '')}</small></span>${plusMinus(f.add, f.del)}</button>`).join('');
    return `<section class="inspector-section changes">
      <div class="branch-row">${icon('branch')}<strong>${escapeHtml(c.branch || 'detached HEAD')}</strong>${sync ? `<span class="sync">${escapeHtml(sync)}</span>` : ''}</div>
      ${c.base ? `<div class="detail-row"><span>vs ${escapeHtml(c.base)}</span><span>${plusMinus(c.baseAdd, c.baseDel)}</span></div>` : ''}
      <div class="inspector-title-row"><h3 class="inspector-label">${c.files.length ? `${c.files.length} changed file${c.files.length === 1 ? '' : 's'}` : 'No uncommitted changes'}</h3>${c.files.length ? `<span class="count">${plusMinus(c.add, c.del)}</span>` : ''}</div>
      ${files}${c.files.length > 14 ? `<p class="inspector-note">and ${c.files.length - 14} more</p>` : ''}
      <div class="git-actions">${c.files.length ? `<button type="button" class="button secondary" data-git="commit">${icon('check')}Commit</button>` : ''}${c.remote && c.branch && (c.ahead || !c.upstream) ? `<button type="button" class="button secondary" data-git="push">${icon('arrow-up')}Push</button>` : ''}${c.remote && c.branch && c.upstream && !c.ahead && c.base ? `<button type="button" class="button secondary" data-git="pr">${icon('external')}Pull request</button>` : ''}</div>
    </section>`;
  }
  async function gitAction(op) {
    const agent = byId.get(selectedId); if (!agent?.owned) return;
    const done = async (text) => { toast(text); await loadChanges(agent, true); };
    if (op === 'commit') {
      return openModal('Commit changes', `<label class="field-label" for="commit-message">Message</label><textarea class="field" id="commit-message" rows="3" maxlength="4000" required placeholder="What changed and why"></textarea><p class="field-hint">Commits every change in ${escapeHtml(changeCache.get(agent.id)?.data?.branch || 'this checkout')}. Your Git hooks run as usual.</p>`, 'Commit', async () => {
        const r = await desktopCall('git', { id: agent.id, op: 'commit', message: $('commit-message').value });
        await done(`Committed ${r.commit}`);
      });
    }
    try {
      toast(op === 'push' ? 'Pushing…' : 'Opening pull request…');
      const r = await desktopCall('git', { id: agent.id, op });
      await done(op === 'push' ? `Pushed ${r.branch}` : r.created ? 'Pull request opened' : 'Opened the pull request');
    } catch (e) { toast(e.message); }
  }

  // Approvals in the GUI: an owned session waiting for you shows its question and choices above the composer
  async function paintApproval() {
    const agent = byId.get(selectedId), card = $('approval-card');
    approvalPolling = agent?.id || null;
    // a session that has not registered with Synapse yet (no backend id) may be stopped at a question of its own before
    // it starts (Claude Code: trust this folder?); its screen is watched so that shows here too
    const starting = embedded && agent?.owned && !agent.exited && !agent.backendId && agent.kind && agent.kind !== 'shell' && view === 'session';
    const waiting = starting || (embedded && agent?.owned && !agent.exited && ['waiting', 'needs_input'].includes(agent.status) && view === 'session');
    clearTimeout(approvalTimer);
    if (!waiting) { approvalPolling = null; if (!card.hidden && agent) $('message-input').placeholder = agent.owned ? 'Ask anything. @ agents, / commands' : `Message ${agent.name}…`; card.hidden = true; approvalFor = null; return; }
    let screen;
    if (approvalReading) { approvalTimer = setTimeout(paintApproval, 300); return; } // one screen read at a time (renders call this often); look again after it
    approvalReading = true;
    try { screen = await desktopCall('screen', { id: agent.id }); } catch { card.hidden = true; if (starting) approvalTimer = setTimeout(paintApproval, 700); return; } finally { approvalReading = false; }
    if (selectedId !== agent.id) return;
    const p = parseApproval(screen.lines), sig = JSON.stringify(p);
    // still starting and not asking anything: no card, look again shortly
    // (a screen caught mid-redraw looks empty: the card goes only after two empty looks in a row)
    if (starting && !['waiting', 'needs_input'].includes(agent.status) && !p.options?.length) { if (!card.hidden && approvalFor === agent.id && !approvalMiss++) { approvalTimer = setTimeout(paintApproval, 400); return; } approvalMiss = 0; const shown = !card.hidden; card.hidden = true; approvalFor = null; card.dataset.sig = ''; if (shown) $('message-input').placeholder = 'Ask anything. @ agents, / commands'; approvalTimer = setTimeout(paintApproval, 700); return; }
    // the same prompt as before: leave the card (and anything typed into it) alone
    if (card.dataset.sig === sig && !card.hidden && approvalFor === agent.id) { approvalTimer = setTimeout(paintApproval, 1500); return; }
    approvalMiss = 0;
    card.dataset.sig = sig;
    // the question sits on top of the box you type in, as its first half: who asks, the question, then the answers
    // as a list you can also pick from the keyboard (1-9, or ↑↓ and Enter while the box is empty; Esc cancels)
    const pointer = p.options.findIndex((o) => o.selected);
    const step = p.tabs.length > 1 ? Math.min(p.tabs.length, p.tabs.filter((t) => t.done).length + 1) : 0;
    const steps = step ? `<span class="ask-steps" aria-label="Question ${step} of ${p.tabs.length}">${step}/${p.tabs.length}</span>` : '';
    const permission = !!p.detail || /^(Bash|Edit|Write|Read|Fetch|Web|MCP|Run)/i.test(p.title);
    const option = (o, i) => {
      const key = o.key.startsWith('nav:') ? `data-approval-nav="${Number(o.key.slice(4))}"` : `data-approval-key="${o.key}"`;
      const [label, note] = !o.description && / · /.test(o.label) ? [o.label.split(' · ')[0], o.label.split(' · ').slice(1).join(' · ')] : [o.label, o.description];
      const mark = o.checked !== undefined ? `<span class="ask-box${o.checked ? ' on' : ''}" aria-hidden="true">${icon('check')}</span>` : `<span class="ask-key">${/^\d+$/.test(o.key) ? o.key : i + 1}</span>`;
      return `<button type="button" class="ask-option${i === Math.max(0, pointer) && !p.multi ? ' active' : ''}" ${key}${o.checked !== undefined ? ` aria-pressed="${o.checked}"` : ''} title="${escapeHtml(note ? `${label}: ${note}` : label)}">${mark}<span class="ask-label">${escapeHtml(label)}</span>${note ? `<span class="ask-desc">${escapeHtml(note)}</span>` : ''}</button>`;
    };
    // Claude Code's first question in a new folder, said plainly
    if (p.options.some((o) => /trust this folder/i.test(o.label))) {
      const folder = (screen.lines.join('\n').match(/Accessing workspace:\s*\n?\s*(\S[^\n]*)/) || [])[1]?.trim();
      p.title = ''; p.detail = ''; p.text = `${folder ? `Claude Code wants to read, edit and run files in ${folder}.\n` : ''}Trust this folder?`;
    }
    const choices = p.options.filter((o) => !o.chat && !o.input), own = p.options.find((o) => o.input), chat = p.options.find((o) => o.chat);
    const lines = (p.text || (permission ? 'Allow this?' : '')).split('\n').filter(Boolean);
    const askAt = lines.findLastIndex((l) => /\?$/.test(l)), ask = askAt >= 0 ? lines.slice(askAt).join(' ') : lines.join(' '), lead = askAt > 0 ? lines.slice(0, askAt) : [];
    card.classList.toggle('permission', permission);
    const context = [permission && p.title ? `${p.title}:` : '', ...lead].filter(Boolean).join(' ');
    card.innerHTML = (context ? `<p class="ask-context">${escapeHtml(context)}</p>` : '')
      + (ask ? `<p class="ask-question">${escapeHtml(ask)}${steps}</p>` : '')
      + (p.detail ? `<code class="ask-command" title="${escapeHtml(p.detail)}">${escapeHtml(p.detail)}</code>` : '')
      + (choices.length || own ? `<div class="ask-options" role="listbox" aria-label="Answers">${choices.map(option).join('')}${own ? `<form class="ask-option ask-own" data-approval-input="${own.key}"><span class="ask-key">${own.key}</span><input type="text" maxlength="2000" placeholder="Something else…" aria-label="Your own answer"></form>` : ''}</div>` : '')
      + `<div class="ask-foot">${!p.options.length ? `<button type="button" class="ask-link strong" data-approval-key="enter">Continue</button>` : ''}${p.multi ? `<button type="button" class="ask-link strong" data-approval-key="right">${p.submit ? 'Submit' : 'Next'}</button>` : ''}${chat ? `<button type="button" class="ask-link" data-approval-key="${chat.key}">Chat about it</button>` : ''}<button type="button" class="ask-link" data-action="show-terminal">Terminal</button><button type="button" class="ask-link" data-approval-key="escape">Cancel</button></div>`;
    $('message-input').placeholder = 'Or write a message for after you answer…';
    card.dataset.pointer = String(Math.max(0, pointer));
    card.hidden = false; approvalFor = agent.id;
    approvalTimer = setTimeout(paintApproval, 1500);
  }
  // keys go to the agent's terminal: a number picks (or, in a multi-select, ticks) that option; a menu without
  // numbers is walked with the arrow keys from where its pointer is; your own answer goes in as text, then Enter
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  async function answerApproval(key, { nav, text } = {}) {
    const id = approvalFor; if (!id) return;
    const card = $('approval-card');
    card.classList.add('answering');
    try {
      if (nav !== undefined) {
        const from = Number(card.dataset.pointer) || 0, step = nav > from ? 'down' : 'up';
        for (let i = 0; i < Math.abs(nav - from); i++) { await desktopCall('keys', { id, key: step }); await pause(60); }
        await desktopCall('keys', { id, key: 'enter' });
      } else if (text !== undefined) {
        await desktopCall('keys', { id, key }); await pause(250);
        await desktopCall('keys', { id, text }); await pause(120);
        await desktopCall('keys', { id, key: 'enter' });
      } else await desktopCall('keys', { id, key });
    } catch (e) { toast(e.message); }
    card.dataset.sig = '';
    setTimeout(() => { card.classList.remove('answering'); paintApproval(); }, 350);
  }

  // Sharing: for the open agent, who it is shared with, whose agents it reads, and what is still waiting
  function sharingSection(agent) {
    if (!embedded) return '';
    const head = `<div class="inspector-title-row"><h3 class="inspector-label">People</h3></div>`;
    if (agent.remote) return `<section class="inspector-section sharing">${head}<div class="share-line">${icon('users')}<span><strong>${escapeHtml(agent.remote.owner)}</strong>'s agent, on their machine</span></div><p class="inspector-note">You can read it${agent.remote.mode === 'talk' ? ' and ask it questions' : ''}. Only ${escapeHtml(agent.remote.owner)} can type into it.</p></section>`;
    if (!friends?.signedIn) return friends ? `<section class="inspector-section sharing">${head}<p class="inspector-note">Sign in to share this agent with people you trust.</p><button class="button secondary" data-action="friends-sign-in">Sign in</button></section>` : '';
    const ids = [agent.backendId, agent.id].filter(Boolean), mineOf = (x) => x && ids.includes(x.id);
    const lines = [
      ...friends.links.filter((l) => mineOf(l.local)).map((l) => l.direction === 'out'
        ? `<div class="share-line">${icon('arrow-right')}<span>Shared with <strong>${escapeHtml(l.owner || 'a friend')}</strong> · ${l.mode === 'talk' ? 'read and ask' : 'read only'}</span><span class="share-state on">Connected</span></div>`
        : `<div class="share-line">${icon('arrow-left')}<span>Reads <strong>${escapeHtml(l.owner || 'a friend')}</strong>'s ${escapeHtml(l.agent?.name || 'agent')}</span><span class="share-state on">Connected</span></div>`),
      ...friends.outgoing.filter((r) => mineOf(r.agent)).map((r) => `<div class="share-line">${icon('clock')}<span>${r.kind === 'offer' ? 'Invited' : 'Asked'} <strong>${escapeHtml(r.to?.name || r.to?.handle || 'a friend')}</strong></span><span class="share-state wait">Waiting</span></div>`),
      ...friends.incoming.filter((r) => mineOf(r.agent) || (r.kind === 'ask' && r.best && ids.includes(r.best))).map((r) => `<div class="share-line">${icon('message')}<span><strong>${escapeHtml(r.from?.name || r.from?.handle || 'A friend')}</strong> ${r.kind === 'offer' ? 'offers you an agent' : 'asks for this agent'}</span><button class="text-button" data-view="connections">Answer</button></div>`),
    ];
    return `<section class="inspector-section sharing">${head}${lines.join('') || '<p class="inspector-note">Not shared with anyone yet.</p>'}<div class="git-actions">${agent.owned || friends.agents.some((a) => ids.includes(a.id)) ? `<button type="button" class="button secondary" data-share-open="share">${icon('users')}Share…</button>` : ''}<button type="button" class="button secondary" data-share-open="ask">${icon('message')}Ask a friend…</button></div></section>`;
  }

  // ---------------------------------------------------------------- the agent browser, in the panel
  const browserKey = (agent) => agent?.backendId || agent?.id;
  const browserOf = (agent) => browserState.agents?.[browserKey(agent)] || null;
  const asksOf = (agent) => (browserState.asks || []).filter((q) => q.agent === browserKey(agent));
  // The panel's head (its tabs) stays put while its body changes, so the tab highlight slides from one tab to the
  // next and the new body fades in; the body is all a tab redraws.
  let shownTab = null;
  function inspectorBody(agent) {
    const pane = $('inspector');
    if (!pane.querySelector(':scope > .inspector-tabbar')) {
      pane.innerHTML = `<div class="inspector-heading inspector-tabbar"><div class="inspector-tabs" role="tablist" aria-label="Panel"><span class="tab-glider" aria-hidden="true"></span>${PANEL_TABS.map((t) => `<button role="tab" data-inspector-tab="${t}"><span>${t[0].toUpperCase()}${t.slice(1)}</span><span class="tab-mark"></span></button>`).join('')}</div><button class="icon-button" data-action="panel-full" id="panel-full" aria-label="Full size" title="Full size">${icon('maximize')}</button><button class="icon-button" data-action="close-inspector" aria-label="Close panel" title="Close">${icon('x')}</button></div><div class="inspector-body" id="inspector-body"></div>`;
      shownTab = null;
    }
    const full = $('panel-full'); if (full && full.dataset.on !== String(panelFull)) { full.dataset.on = String(panelFull); full.innerHTML = icon(panelFull ? 'minimize' : 'maximize'); full.title = full.ariaLabel = panelFull ? 'Back to the side' : 'Full size'; }
    const b = browserOf(agent), live = b?.driving && !b.paused, asking = asksOf(agent).length, open = agentTodos(agent).filter((t) => !t.done).length;
    const marks = { details: '', todos: open ? `<span class="tab-count">${open}</span>` : '', browser: asking ? '<span class="tab-badge" title="Waiting for you">1</span>' : live ? '<span class="tab-live" title="The agent is using it"></span>' : '' };
    for (const btn of pane.querySelectorAll('[data-inspector-tab]')) {
      const t = btn.dataset.inspectorTab, mark = btn.querySelector('.tab-mark');
      btn.setAttribute('aria-selected', String(t === inspectorTab));
      if (mark.innerHTML !== marks[t]) mark.innerHTML = marks[t];
    }
    const on = pane.querySelector(`[data-inspector-tab="${inspectorTab}"]`), glider = pane.querySelector('.tab-glider');
    if (on && glider) requestAnimationFrame(() => { glider.style.transform = `translateX(${on.offsetLeft - 2}px)`; glider.style.width = `${on.offsetWidth}px`; glider.classList.toggle('ready', shownTab !== null); });
    const body = $('inspector-body');
    if (shownTab !== inspectorTab) { if (shownTab !== null) { body.classList.remove('tab-in'); void body.offsetWidth; body.classList.add('tab-in'); } shownTab = inspectorTab; }
    return body;
  }
  function renderBrowser(agent) {
    const b = browserOf(agent), asks = asksOf(agent);
    const signature = JSON.stringify([agent.id, b, asks, inspectorTab]);
    const panelBody = inspectorBody(agent);
    if (signature === browserSignature && panelBody.querySelector('.browser-pane')) { placeBrowser(); return; }
    browserSignature = signature; inspectorSignature = '';
    const keep = $('browser-url') && document.activeElement === $('browser-url') ? $('browser-url').value : null;
    const tab = b?.tabs.find((t) => t.id === b.active), url = tab?.url && tab.url !== 'about:blank' ? tab.url : '';
    const tabs = (b?.tabs || []).map((t) => `<div class="browser-tab${t.id === b.active ? ' on' : ''}"><button data-browser="select-tab" data-tab="${escapeHtml(t.id)}" title="${escapeHtml(t.url)}">${t.loading ? `<span class="status-dot busy" style="${spinPhase()}"></span>` : ''}<span>${escapeHtml(t.title || 'New tab')}</span></button><button class="browser-tab-x" data-browser="close-tab" data-tab="${escapeHtml(t.id)}" aria-label="Close tab">${icon('x')}</button></div>`).join('');
    const name = escapeHtml(agent.name);
    const host = (q) => escapeHtml(q.origin.replace(/^https?:\/\//, ''));
    const askText = (q) => q.kind === 'login'
      ? `<p>${icon('key')}<span><strong>${name}</strong> wants to sign in to <strong>${host(q)}</strong> as <strong>${escapeHtml(q.user || '')}</strong> with the login from your vault. Synapse fills it in; ${name} never sees the password.</span></p>`
      : q.kind === 'mic'
        ? `<p><strong>${host(q)}</strong> wants to use your microphone in ${name}'s browser. Allow lets this site hear you until Synapse quits.</p>`
        : `<p><strong>${name}</strong> wants to open <strong>${host(q)}</strong> in your browser, where you may be signed in. Allow in this browser lets it open any site here without asking again, until you close its tabs.</p>`;
    const askLabels = { login: ['Allow a sign-in', 'Always on this site', 'Sign in', ''], mic: ['Allow the microphone', 'Always allow this site', 'Allow', ''], site: ['Allow a site', 'Always allow this site', 'Allow in this browser', 'Any site in this browser, until you close its tabs'] };
    const ask = asks.map((q) => { const [label, always, once, tip] = askLabels[q.kind] || askLabels.site; return `<div class="browser-ask${q.kind === 'login' ? ' login' : ''}" role="alertdialog" aria-label="${label}">${askText(q)}<div class="browser-ask-actions"><button class="button secondary" data-browser-answer="deny" data-ask="${escapeHtml(q.id)}">Deny</button><button class="button secondary" data-browser-answer="always" data-ask="${escapeHtml(q.id)}">${always}</button><button class="button" data-browser-answer="once" data-ask="${escapeHtml(q.id)}" title="${tip}">${once}</button></div></div>`; }).join('');
    const body = !embedded ? `<div class="browser-empty">${icon('globe')}<p>The browser runs in the Synapse app.</p></div>`
      : b?.popped ? `<div class="browser-empty">${icon('pop-out')}<p>${name}'s browser is open in its own window.</p><button class="button secondary" data-browser="dock">${icon('dock-in')}Back to the panel</button></div>`
      : `<div class="browser-slot" id="browser-slot">${b?.tabs.length ? '' : `<div class="browser-empty">${icon('globe')}<p>${name} opens pages here when it uses the browser (the synapse_browser tool). You can watch, or open a page yourself.</p><p class="browser-hint">Sign in to sites here once: agents use your sessions without seeing your passwords.</p></div>`}</div>`;
    const driving = b?.paused ? `<div class="browser-status paused">${icon('hand')}<span>You have the browser. ${name} waits.</span><button class="button" data-browser="resume">Hand back</button></div>`
      : b?.driving ? `<div class="browser-status live"><span class="live-dot"></span><span>${name} is using the browser</span><button class="button secondary" data-browser="pause">Take over</button></div>`
      : b?.tabs.length ? `<div class="browser-status"><span>${name} can use this browser.</span><button class="text-button" data-browser="pause">Take over</button></div>` : '';
    panelBody.innerHTML = `<div class="browser-pane">
      ${tabs || b?.tabs?.length ? `<div class="browser-tabs">${tabs}<button class="icon-button" data-browser="new-tab" aria-label="New tab" title="New tab">${icon('plus')}</button></div>` : ''}
      <div class="browser-bar"><button class="icon-button" data-browser="back" aria-label="Back" title="Back"${b?.canBack ? '' : ' disabled'}>${icon('arrow-left')}</button><button class="icon-button" data-browser="forward" aria-label="Forward" title="Forward"${b?.canForward ? '' : ' disabled'}>${icon('arrow-right')}</button><button class="icon-button" data-browser="reload" aria-label="Reload" title="Reload"${tab ? '' : ' disabled'}>${icon('refresh')}</button>
        <form id="browser-go" class="browser-go"><input id="browser-url" class="field" spellcheck="false" autocomplete="off" placeholder="Search or enter address" aria-label="Address" value="${escapeHtml(keep ?? url)}"></form>
        ${b?.logins?.length ? `<button class="icon-button" id="browser-vault" aria-label="Sign in with your vault" title="Sign in with your vault (${escapeHtml(b.logins.join(', '))})">${icon('key')}</button>` : ''}
        <button class="icon-button" data-browser="${b?.popped ? 'dock' : 'pop'}" aria-label="${b?.popped ? 'Back to the panel' : 'Pop out'}" title="${b?.popped ? 'Back to the panel' : 'Pop out into its own window'}">${icon(b?.popped ? 'dock-in' : 'pop-out')}</button>
        <button class="icon-button" id="browser-more" aria-haspopup="menu" aria-label="Browser data" title="Clear site data or the browser's cache">${icon('more')}</button></div>
      ${ask}${body}${driving}</div>`;
    if (keep !== null) { $('browser-url').focus(); $('browser-url').setSelectionRange(keep.length, keep.length); }
    placeBrowser();
  }
  // where the native browser view goes: over #browser-slot while it shows, nowhere otherwise (a dialog, a menu or
  // another view of this page would sit under it)
  function placeBrowser() {
    if (!embedded || paneKey) return;
    const agent = byId.get(selectedId), slot = $('browser-slot');
    const visible = slot && agent && !$('inspector').hidden && inspectorTab === 'browser' && view === 'session' && !browserCovered && !document.querySelector('dialog[open], .pop-menu, .approval-card:not([hidden]) .ask-menu') && !asksOf(agent).length && document.visibilityState === 'visible' && Date.now() >= browserSettle;
    const r = visible ? slot.getBoundingClientRect() : null;
    const bounds = r && r.width > 40 && r.height > 40 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
    const key = browserKey(agent) || '';
    if (document.body.dataset.browserAgent !== key) document.body.dataset.browserAgent = key; // which agent's browser the panel is for (tests read it)
    const placed = JSON.stringify([key, bounds && Object.values(bounds).map(Math.round)]);
    if (placed === browserPlaced) return;
    const previous = browserPlaced && JSON.parse(browserPlaced)[0];
    browserPlaced = placed;
    if (previous && previous !== key) desktopCall('browser-bounds', { agent: previous, bounds: null }).catch(() => {});
    if (key) desktopCall('browser-bounds', { agent: key, bounds }).catch(() => {});
  }
  function onBrowserState(next, asked) {
    const before = new Set((browserState.asks || []).map((q) => q.id));
    browserState = next;
    const fresh = (next.asks || []).filter((q) => !before.has(q.id));
    // a new question: the selected agent's opens its browser; another agent's gets a toast with a way there. A
    // session the app has only just matched to its agent may not know its id yet, so look again a moment later.
    const decide = (q, last) => {
      if (!(browserState.asks || []).some((x) => x.id === q.id)) return;
      const selected = byId.get(selectedId);
      if (selected && browserKey(selected) === q.agent && view === 'session') { inspectorTab = 'browser'; setStorage('synapse-inspector-tab', 'browser'); inspectorOpen = true; syncInspector(); return; }
      if (!last) return setTimeout(() => decide(q, true), 1500);
      const agent = state.agents.find((a) => browserKey(a) === q.agent && a.id.startsWith('desktop-')) || state.agents.find((a) => browserKey(a) === q.agent);
      toast(q.kind === 'mic' ? `${q.origin.replace(/^https?:\/\//, '')} wants your microphone in ${q.name}'s browser` : `${q.name} wants to ${q.kind === 'login' ? 'sign in to' : 'open'} ${q.origin.replace(/^https?:\/\//, '')} in the browser`, agent ? () => { navigate('session', agent.id); inspectorTab = 'browser'; inspectorOpen = true; syncInspector(); } : null, 'Show');
    };
    for (const q of fresh) decide(q, false);
    if (!$('inspector').hidden && !inspectorFile) renderInspector();
  }
  if (embedded && !paneKey) {
    desktopCall('browser-state').then((s) => s && onBrowserState(s)).catch(() => {});
    new ResizeObserver(() => placeBrowser()).observe(document.body);
    addEventListener('resize', placeBrowser);
    document.addEventListener('visibilitychange', placeBrowser);
    // menus and dialogs come and go without telling us: check now and then (cheap, and only sends on change)
    setInterval(placeBrowser, 400);
  }
  const browserAct = (action, args = {}) => desktopCall('browser-user', { agent: browserKey(byId.get(selectedId)), action, args }).catch((e) => toast(e.message));
  document.addEventListener('click', (event) => {
    const t = event.target.closest('[data-inspector-tab]');
    if (t) { if (t.dataset.inspectorTab === inspectorTab) return; inspectorTab = PANEL_TABS.includes(t.dataset.inspectorTab) ? t.dataset.inspectorTab : 'details'; setStorage('synapse-inspector-tab', inspectorTab); inspectorSignature = ''; browserSignature = ''; browserSettle = Date.now() + 360; syncInspector(); setTimeout(placeBrowser, 380); return; }
    const a = event.target.closest('[data-browser-answer]');
    if (a) { desktopCall('browser-answer', { id: a.dataset.ask, choice: a.dataset.browserAnswer }).catch((e) => toast(e.message)); return; }
    const v = event.target.closest('#browser-vault');
    if (v) {
      const users = browserOf(byId.get(selectedId))?.logins || [];
      if (users.length === 1) browserAct('login', { user: users[0] });
      else dropdown(v, [{ heading: 'Sign in with your vault' }, ...users.map((u) => ({ label: u, icon: 'key', run: () => browserAct('login', { user: u }) }))]);
      return;
    }
    // a sign-in that got stuck: clear the site's data (you are signed out there only), or everything (everywhere)
    const more = event.target.closest('#browser-more');
    if (more) {
      const b = browserOf(byId.get(selectedId)), tab = b?.tabs.find((x) => x.id === b.active);
      let host = ''; try { host = /^https?:/.test(tab?.url || '') ? new URL(tab.url).hostname.replace(/^www\./, '') : ''; } catch {}
      const clearAll = () => dropdown(more, [{ heading: 'Signs you out of every site in this browser' },
        { label: 'Clear all browsing data', icon: 'x', danger: true, run: () => browserAct('clear-all').then((r) => r && toast('Browsing data cleared. You are signed out everywhere.')) },
        { label: 'Cancel', run: () => {} }]);
      dropdown(more, [
        ...(host ? [{ label: `Clear data for ${host}`, hint: 'Cookies, storage and cache. Signs you out of this site only, then reloads.', icon: 'refresh', run: () => browserAct('clear-site').then((r) => r && toast(`Cleared ${r.site}: ${r.cookies} cookie${r.cookies === 1 ? '' : 's'}, storage and cache.`)) }] : []),
        { label: 'Clear all browsing data…', hint: 'Every site. Signs you out everywhere.', icon: 'x', run: () => setTimeout(clearAll, 0) },
      ]);
      return;
    }
    const b = event.target.closest('[data-browser]');
    if (b) browserAct(b.dataset.browser, b.dataset.tab ? { tab: b.dataset.tab } : {});
  });
  document.addEventListener('submit', (event) => {
    if (event.target.id !== 'browser-go') return;
    event.preventDefault();
    const url = $('browser-url').value.trim(); if (!url) return;
    $('browser-url').blur(); browserAct('go', { url });
  });


  // Todos: what is left to do with this agent. They are the same todos as on the Todos page, linked to this agent.
  function renderTodosTab(agent) {
    const mine = agentTodos(agent), open = mine.filter((t) => !t.done), done = mine.filter((t) => t.done);
    const signature = JSON.stringify(['todos', agent.id, todosOf(agent), mine.map((t) => [t.agent?.name, t.linear?.identifier]), inspectorTab]);
    const body = inspectorBody(agent);
    if (signature === inspectorSignature && body.querySelector('.todo-tab')) return;
    const keep = document.activeElement?.closest?.('.todo-tab form') ? document.activeElement.value : null;
    inspectorSignature = signature;
    body.innerHTML = agent.remote ? `<p class="inspector-note">Todos are for agents on this machine.</p>` : `<section class="todo-tab">
      <form class="todo-add mini todo-tab-add" data-todo-add-for="${escapeHtml(agent.id)}" autocomplete="off"><input maxlength="500" placeholder="Add a todo…" aria-label="New todo for this agent"></form>
      ${open.length ? open.map(todoRow).join('') : '<p class="inspector-note todo-empty">Nothing to do yet. What should this agent get done?</p>'}
      ${done.length ? `<details class="todo-done-list"><summary>${done.length} done</summary>${done.map(todoRow).join('')}</details>` : ''}
      <p class="inspector-note todo-where">These also show on the Todos page.</p></section>`;
    if (keep !== null) { const i = body.querySelector('.todo-tab-add input'); i.value = keep; i.focus(); }
  }
  function renderInspector() {
    const agent = byId.get(selectedId); if (!agent) return;
    if (inspectorFile?.agent === selectedId) {
      const key = `file:${JSON.stringify([inspectorFile.path, inspectorFile.mode, inspectorFile.stack.length])}`;
      if (key !== inspectorSignature) { inspectorSignature = key; renderFile(); }
      return;
    }
    inspectorFile = null; fileShown = ''; $('inspector').classList.remove('file-mode'); delete $('inspector').dataset.filePath;
    $('inspector').classList.toggle('browser-mode', inspectorTab === 'browser');
    if (inspectorTab === 'browser') { renderBrowser(agent); return; }
    if (inspectorTab === 'todos') { renderTodosTab(agent); return; }
    browserSignature = '';
    const peers = relations(agent.id), chat = recentCache.get(agent.id)?.data.chat || [];
    loadChanges(agent);
    const signature = JSON.stringify([agent.id, agent.name, agent.status, agent.lastActivity, todosOf(agent), peers, chat.slice(-3), Math.floor(Date.now() / 60000), changeCache.get(agent.id)?.data, friends?.links?.length, friends?.outgoing?.length, friends?.incoming?.length]);
    if (signature === inspectorSignature) return;
    inspectorSignature = signature;
    inspectorBody(agent).innerHTML = `
      <section class="inspector-section"><div class="session-summary">${avatar(agent)}<div><strong>${escapeHtml(agent.name)}</strong><span class="session-provider">${escapeHtml(kindName(agent))}</span></div></div><div class="detail-row"><span>Status</span><span class="status-label">${status(agent)}${activityLabel(agent)}</span></div><div class="detail-row"><span>Last activity</span><span>${relativeTime(agent.lastActivity) === 'now' ? 'Just now' : `${relativeTime(usedAt(agent))} ago`}</span></div><div class="folder-path">${icon('folder')}<span>${escapeHtml(agent.cwd)}</span></div></section>
      ${changesSection(agent)}
      ${sharingSection(agent)}
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
    // keyed by content, not position: loading older entries (or a new one pushing the window) keeps every element
    const seen = new Map();
    const conversation = (data.messages || []).map((message) => {
      const base = `transcript-${message.ts}-${hash(message.text)}`, n = seen.get(base) || 0; seen.set(base, n + 1);
      return { ...message, type: 'transcript', time: new Date(message.ts).getTime() || 0, key: n ? `${base}-${n}` : base };
    });
    const messages = (data.chat || []).map((message) => ({ ...message, type: 'shared', time: message.t, key: message.id || `shared-${message.t}-${hash(message.text)}`, human: message.from === 'synapse-user' }));
    return (tab === 'messages' ? messages : [...conversation, ...messages.filter((message) => message.human)]).sort((a, b) => a.time - b.time);
  }

  function renderTimeline(reset = false) {
    const agent = byId.get(selectedId), cached = recentCache.get(selectedId), list = $('message-list'), scroller = $('thread-scroll');
    if (!agent) return;
    if (!cached) {
      // not loaded yet: the last conversation stays, dimmed, for a moment; only a slow load shows the spinner
      list.dataset.signature = ''; scroller.setAttribute('aria-busy', 'true');
      if (list.dataset.waitingFor === selectedId) return;
      list.dataset.waitingFor = selectedId; list.dataset.shownFor = '';
      const showLoading = () => { list.classList.remove('stale'); list.innerHTML = '<div class="thread-loading"><span class="spinner" aria-hidden="true"></span>Loading conversation…</div>'; };
      if (!list.querySelector('[data-message-key]')) showLoading();
      else { list.classList.add('stale'); const id = selectedId; setTimeout(() => { if (list.dataset.waitingFor === id && !recentCache.has(id)) showLoading(); }, 350); }
      return;
    }
    // a newly opened agent eases in once its conversation is here, at its latest message
    const arriving = list.dataset.shownFor !== selectedId;
    if (arriving) { list.dataset.shownFor = selectedId; list.dataset.waitingFor = ''; list.classList.remove('stale', 'entering'); void list.offsetWidth; list.classList.add('entering'); reset = true; }
    scroller.setAttribute('aria-busy', 'false');
    const data = cached.data, records = messageRecords(data);
    if (tab === 'conversation' && typeof data.terminal === 'string') {
      // Codex with no conversation yet (it writes none before the first prompt) is ready for it: its welcome screen is
      // noise. The terminal shows only while it asks something there (an update or trust question). Other agents
      // land here before Synapse has matched them to their transcript (a resumed Claude, say): their terminal is the
      // only view of the conversation, so it stays
      const asking = /Update available|Update now|Do you trust|trust the (?:files|contents)|Press enter|[›❯>]\s*1\.\s|\(y\/n\)|sign in|log in/i.test(data.terminal);
      const ready = agent.kind === 'codex' && !agent.exited && !asking && data.terminal.trim().length > 0;
      const working = agent.status === 'busy';
      const signature = selectedId + ':' + (ready ? `ready:${working}` : hash(data.terminal));
      if (ready && (list.dataset.signature !== signature || reset)) {
        list.dataset.signature = signature;
        list.innerHTML = working ? emptyState(`${kindName(agent)} is working`, 'The conversation shows here in a moment.', 'show-terminal', 'Show terminal', 'terminal')
          : emptyState(`${kindName(agent)} is ready`, 'Send your first message below.', 'show-terminal', 'Show terminal', 'terminal');
      } else if (!ready && (list.dataset.signature !== signature || reset)) {
        const bottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
        list.dataset.signature = signature;
        list.innerHTML = `<div class="terminal-transcript-heading"><span>Live terminal output</span><button class="text-button" data-action="show-terminal">Show terminal ${icon('terminal')}</button></div><pre class="terminal-transcript">${escapeHtml(data.terminal || 'Session starting…')}</pre>`;
        if (bottom || reset) scroller.scrollTop = scroller.scrollHeight;
      }
      $('message-count').textContent = '0';
      return;
    }
    $('message-count').textContent = data.chat?.length || 0;
    $('messages-tab').setAttribute('aria-label', `Messages (${data.chat?.length || 0})`);
    const signature = JSON.stringify([selectedId, tab, limit, records.map((record) => [record.key, record.delivered]), data.hasMore, agent.name, agent.status, busySince.get(agent.id) || 0, (outgoing.get(agent.id) || []).map((o) => o.key)]); // status: the live line ends when it stops
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
    if (tab === 'conversation' && data.hasMore) {
      const load = document.createElement('button'); load.className = 'text-button'; load.dataset.action = 'load-older'; load.textContent = 'Load earlier messages'; desired.push(load);
    }
    // a prompt shown when it was sent becomes its transcript entry (the same element: nothing blinks)
    const out = (outgoing.get(agent.id) || []).filter((o) => Date.now() - o.at < 60_000);
    const claimed = new Set();
    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    const sentAfter = (o) => records.filter((r) => r.type === 'transcript' && r.role === 'user' && !r.teammate && !claimed.has(r.key) && r.time >= o.at - 3000);
    // its own text first; then (an agent may rewrite a prompt, e.g. pasted images) the first prompt after it was sent
    for (const pass of [(o, r) => norm(r.text) === norm(o.text) || norm(r.text).startsWith(norm(o.text).slice(0, 200)), () => true]) for (const o of [...out]) {
      const hit = sentAfter(o).find((r) => pass(o, r));
      if (!hit) continue;
      claimed.add(hit.key); out.splice(out.indexOf(o), 1);
      const el = existing.get(o.key);
      if (el && !existing.has(hit.key)) { existing.delete(o.key); el.dataset.messageKey = hit.key; existing.set(hit.key, el); }
    }
    if (out.length) outgoing.set(agent.id, out); else outgoing.delete(agent.id);
    const fresh = [], items = [];
    for (const message of records) {
      const user = message.role === 'user' || message.human, tool = message.tool;
      const messageSignature = `${message.key}:${message.delivered}:${agent.name}`;
      let element = existing.get(message.key);
      if (!element) {
        element = document.createElement(tool ? 'details' : 'article'); element.dataset.messageKey = message.key;
        if (!reset) element.dataset.enter = '1'; // new while you watch: it eases in
      }
      if (element.dataset.signature !== messageSignature) {
        element.dataset.signature = messageSignature;
        fresh.push(element);
        const time = message.time ? new Date(message.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        if (tool) {
          // one quiet line per tool call; opening it shows the full call when the line had to clip it
          const t = toolSummary(message.text) || { verb: 'Used a tool', icon: 'tool', what: message.text.replace(/^\[|\]$/g, '') };
          element.className = `tool-message${element.dataset.enter ? ' fresh-in' : ''}`;
          element.innerHTML = `<summary>${toolRow(t)}${icon('chevron-right')}</summary><pre>${escapeHtml(message.text.replace(/^\[|\]$/g, ''))}</pre>`;
        } else {
          const peer = (message.type === 'shared' && !message.human) || !!message.teammate; // teammate: another Claude session (lib.mjs teammateMessage)
          element.className = `message ${user && !message.teammate ? 'user' : peer ? 'peer' : 'assistant'}${element.dataset.enter ? ' fresh-in' : ''}`;
          const sender = message.teammate ? { kind: 'claude', name: message.fromName } : peer ? byId.get(message.from) || { kind: '' } : agent;
          const delivery = message.human ? `<span class="queued-label">${icon(message.delivered ? 'check' : 'clock')}${message.delivered ? 'Picked up by agent' : 'Queued for next prompt'}</span>` : '';
          // replies read as plain prose under your prompt; only agent-to-agent notes say who wrote them
          // images you attached show as thumbnails, not as their paths
          const pics = user && !message.teammate ? sentImages(message.text) : { text: message.text, images: [], files: [] };
          const thumbs = pics.images.length ? `<div class="message-images">${pics.images.map((p) => `<button type="button" data-file="${escapeHtml(p)}" title="${escapeHtml(p)}"><img alt="${escapeHtml(p.split(/[\\/]/).pop())}" loading="lazy" src="/api/file/raw?${new URLSearchParams({ path: p })}"></button>`).join('')}</div>` : '';
          element.innerHTML = `${peer ? `<header class="message-head">${avatar(sender)}<span>${escapeHtml(message.fromName)}</span>${icon('arrow-right')}<span>${escapeHtml(message.teammate ? agent.name : message.toName)}</span>${time ? `<time>${time}</time>` : ''}</header>${message.summary ? `<p class="message-summary">${escapeHtml(message.summary)}</p>` : ''}` : ''}${thumbs}${fileChips(pics.files)}${pics.text.trim() ? `<div class="message-body md">${messageBody(pics.text, user, message.type === 'transcript')}</div>` : ''}<footer class="message-foot">${delivery}${!peer && time ? `<time>${time}</time>` : ''}<button class="icon-button" data-copy-message aria-label="Copy message" title="Copy message">${icon('copy')}</button></footer>`;
        }
      }
      items.push({ message, element });
    }
    const folded = foldWork(items, existing, agent);
    if (out.length) {
      // just sent: your prompt sits at the bottom, with the live line under it
      const live = folded.findIndex((el) => el.dataset.messageKey === 'live:next');
      const tail = live >= 0 ? folded.splice(live, 1) : [];
      folded.push(...out.map((o) => outgoingBubble(o, existing)), ...tail);
    }
    desired.push(...folded);
    syncChildren(list, desired);
    if (fresh.length) linkFiles(fresh, agent.cwd);
    // older entries came in above: keep what you were reading where it was
    const anchorEl = olderAnchor && !reset && Date.now() - olderAnchor.at < 15_000 && records[0]?.key !== olderAnchor.firstKey && list.querySelector(`[data-message-key="${CSS.escape(olderAnchor.key)}"]`);
    if (anchorEl) { scroller.scrollTop = previousTop + anchorEl.getBoundingClientRect().top - olderAnchor.top; olderAnchor = null; }
    else if (reset || nearBottom) { scroller.scrollTop = scroller.scrollHeight; $('jump-latest').hidden = true; }
    else { scroller.scrollTop = previousTop; $('jump-latest').hidden = false; }
  }

  function outgoingBubble(o, existing) {
    let el = existing.get(o.key);
    if (el) return el;
    el = document.createElement('article'); el.className = 'message user sent-now rise'; el.dataset.messageKey = o.key;
    const pics = sentImages(o.text);
    const thumbs = pics.images.length ? `<div class="message-images">${pics.images.map((p) => `<button type="button" data-file="${escapeHtml(p)}" title="${escapeHtml(p)}"><img alt="" src="/api/file/raw?${new URLSearchParams({ path: p })}"></button>`).join('')}</div>` : '';
    el.innerHTML = `${thumbs}${fileChips(pics.files)}${pics.text.trim() ? `<div class="message-body md">${messageBody(pics.text, true, false)}</div>` : ''}<footer class="message-foot"><time>${new Date(o.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></footer>`;
    return el;
  }

  // The whole history, a page at a time: scrolling near the top loads the entries before (as does the button)
  async function loadOlder() {
    const cached = recentCache.get(selectedId);
    if (loadingOlder || !cached?.data?.hasMore || tab !== 'conversation') return;
    loadingOlder = true;
    const scroller = $('thread-scroll');
    // the entry you are reading stays put once the ones before it are in
    const top = scroller.getBoundingClientRect().top, el = [...$('message-list').querySelectorAll(':scope > [data-message-key]')].find((e) => e.getBoundingClientRect().bottom > top);
    olderAnchor = el ? { key: el.dataset.messageKey, top: el.getBoundingClientRect().top, firstKey: messageRecords(cached.data)[0]?.key, at: Date.now() } : null;
    limit = Math.min(5000, Math.max(limit, cached.limit || 0) + 150);
    try { await loadRecent(true); } finally { loadingOlder = false; }
  }
  $('thread-scroll').addEventListener('scroll', () => { if ($('thread-scroll').scrollTop < 400) loadOlder(); }, { passive: true });
  // an entry eases in once: moved later (into a fold, or out of the live line) it does not play again
  $('message-list').addEventListener('animationend', (event) => {
    const el = event.target;
    if (el.classList?.contains('fresh-in') || el.classList?.contains('rise')) { el.classList.remove('fresh-in', 'rise'); delete el.dataset.enter; }
  });

  // Like a chat app's "Worked for 2m": in each finished turn, the tool calls and the agent's notes between them
  // (its running commentary) fold into one row above the final answer. The turn still running is a single live
  // line instead: a shimmer with the step it is on and the time so far; open it to watch every step.
  const openFolds = new Set();
  const duration = (ms) => { const sec = Math.round(ms / 1000); return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor(sec % 3600 / 60)}m`; };
  function foldWork(items, existing, agent) {
    if (tab !== 'conversation') return items.map((item) => item.element);
    const out = [], turns = [];
    let turn = null;
    for (const item of items) {
      const user = item.message.role === 'user' || item.message.human;
      if (user) { out.push(item.element); turn = { start: item.message.time, items: [], at: out.length }; turns.push(turn); continue; }
      if (!turn) { turn = { start: 0, items: [], at: out.length }; turns.push(turn); }
      turn.items.push(item);
    }
    const working = ['busy', 'waiting', 'needs_input'].includes(agent.status);
    const result = [], byAt = new Map(turns.map((t) => [t.at, t]));
    const emit = (t, last) => {
      const answerAt = t.items.findLastIndex((item) => !item.message.tool && item.message.type === 'transcript' && item.message.role !== 'user');
      // the agent turned busy after this turn's last entry, and the turn has its answer: the work belongs to a
      // message not in the transcript yet (just sent). This turn stays as it was and the live line follows it.
      const since = busySince.get(agent.id) || 0, lastTime = t.items.at(-1)?.message.time || t.start || 0;
      const pending = last && working && answerAt >= 0 && since && lastTime && since > lastTime + 1000;
      if (last && working && !pending) { result.push(liveLine(`live:${t.at}`, t.items, t.start)); return; }
      if (pending) { emitFinished(t, answerAt); result.push(liveLine('live:next', [], since)); return; }
      emitFinished(t, answerAt);
    };
    const liveLine = (key, items, start) => {
      let el = existing.get(key);
      if (!el) {
        el = document.createElement('section'); el.className = 'work-fold live'; el.dataset.messageKey = key;
        el.innerHTML = `<button type="button" class="work-summary" data-work-toggle="${escapeHtml(key)}"><span class="work-spinner" aria-hidden="true"></span><span class="work-label"></span><span class="work-time"></span>${icon('chevron-right')}</button><div class="work-body"></div>`;
      }
      const step = items.findLast((item) => item.message.tool);
      const s = step && (toolSummary(step.message.text) || { verb: 'Using a tool', what: '' });
      el.querySelector('.work-label').textContent = ['waiting', 'needs_input'].includes(agent.status) ? 'Waiting for you' : s ? `${s.verb} ${s.what || ''}`.trim() : 'Thinking';
      el.querySelector('.work-time').dataset.since = String(start || '');
      const open = openFolds.has(key);
      el.querySelector('.work-summary').setAttribute('aria-expanded', String(open));
      el.lastElementChild.hidden = !open;
      syncChildren(el.lastElementChild, items.map((item) => item.element));
      return el;
    };
    const emitFinished = (t, answerAt) => {
      const fold = answerAt < 1 ? [] : t.items.slice(0, answerAt);
      if (!fold.length) { result.push(...t.items.map((item) => item.element)); return; }
      const key = `work:${fold[0].message.key}`;
      let el = existing.get(key);
      if (!el) {
        el = document.createElement('section'); el.className = 'work-fold'; el.dataset.messageKey = key;
        el.innerHTML = `<button type="button" class="work-summary" data-work-toggle="${escapeHtml(key)}"><span class="work-label"></span>${icon('chevron-right')}</button><div class="work-body"></div>`;
      }
      const end = t.items[answerAt].message.time, steps = fold.filter((item) => item.message.tool).length;
      el.querySelector('.work-label').textContent = `${t.start && end > t.start ? `Worked for ${duration(end - t.start)}` : 'Worked'} · ${steps} step${steps === 1 ? '' : 's'}`;
      const open = openFolds.has(key);
      el.querySelector('.work-summary').setAttribute('aria-expanded', String(open));
      el.lastElementChild.hidden = !open;
      syncChildren(el.lastElementChild, fold.map((item) => item.element));
      result.push(el, ...t.items.slice(answerAt).map((item) => item.element));
    };
    for (let i = 0; i <= out.length; i++) {
      const t = byAt.get(i);
      if (t) emit(t, t === turns.at(-1));
      if (i < out.length) result.push(out[i]);
    }
    return result;
  }

  // Pointing at an agent loads its conversation, so opening it is instant (and the keys below load the next one)
  const prefetching = new Set();
  async function prefetchRecent(id) {
    const agent = byId.get(id);
    if (!agent || id === selectedId || prefetching.has(id) || agent.remote) return;
    const cached = recentCache.get(id);
    if (cached && cached.activity === agent.lastActivity && cached.revision === state.messageRevision) return;
    prefetching.add(id);
    const activity = agent.lastActivity, revision = state.messageRevision;
    try {
      const data = agent.owned && !agent.backendId ? await desktopCall('output', { id })
        : await api(`/api/agents/${encodeURIComponent(agent.backendId || id)}/recent?limit=60`);
      if (agent.owned && !data.messages?.length && !data.chat?.length) Object.assign(data, await desktopCall('output', { id }));
      if (id !== selectedId || !recentCache.has(id)) recentCache.set(id, { data, activity, revision, limit: 60, backend: agent.backendId, transcript: agent.transcript });
      if (recentCache.size > 30) recentCache.delete(recentCache.keys().next().value);
      if (id === selectedId && view === 'session') renderTimeline();
    } catch {} finally { prefetching.delete(id); }
  }
  let hoverTimer = 0;
  $('project-list').addEventListener('pointerover', (event) => {
    const id = event.target.closest('.session-row')?.dataset.agent;
    clearTimeout(hoverTimer); if (id) hoverTimer = setTimeout(() => prefetchRecent(id), 60);
  });
  // ⌘⇧W / ⌘⇧S: the agent above or below in the list as it is shown (folded sections are skipped)
  function moveSelection(step) {
    const rows = [...$('project-list').querySelectorAll('.session-row')].filter((row) => row.offsetParent && !row.closest('.project-group.folded:not(:hover):not(:has(:focus-visible))'));
    if (!rows.length) return;
    const at = rows.findIndex((row) => row.dataset.agent === selectedId && view === 'session');
    const next = rows[at < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + step))];
    if (!next || (at >= 0 && next === rows[at])) return;
    navigate('session', next.dataset.agent);
    next.scrollIntoView({ block: 'nearest' });
    const after = rows[rows.indexOf(next) + step]; if (after) prefetchRecent(after.dataset.agent);
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
        : await api(`/api/agents/${encodeURIComponent(agent.backendId || id)}/recent?limit=${requestedLimit}`, { signal: recentController.signal })
          // a session of ours the server has just lost track of (restarted, re-registering): show its terminal meanwhile
          .catch((error) => { if (agent.owned && error.status === 404) return desktopCall('output', { id }); throw error; });
      // a conversation already shown never gives way to the raw terminal: an empty or missing answer for a moment
      // (the agent waiting on you, its session being matched again) keeps it, and the next load fills it in
      const had = cached?.data?.messages?.length && cached.transcript === agent.transcript; // (a new transcript, after /clear, may be empty)
      if (had && (typeof data.terminal === 'string' || !data.messages?.length)) return;
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
    $('message-input').placeholder = !$('approval-card').hidden && approvalFor === agent?.id ? 'Or write a message for after you answer…' : agent ? (agent.owned ? 'Ask anything. @ agents, / commands' : `Message ${agent.name}…`) : 'Message your agent…';
    $('attach-files').hidden = !agent?.owned;
    if (agent?.owned) loadChanges(agent).then(paintChangesChip); else { $('changes-chip').hidden = true; $('branch-pill').hidden = true; }
    const waitingNow = agent?.owned && !agent.exited && (['waiting', 'needs_input'].includes(agent.status) || (!agent.backendId && agent.kind && agent.kind !== 'shell'));
    if (waitingNow ? approvalFor !== agent.id && approvalPolling !== agent.id : approvalFor) paintApproval();
    $('message-input').setAttribute('aria-label', agent ? `Message ${agent.name}` : 'Message this agent');
    composerPaint?.();
    // working: Stop interrupts it (Escape, how Claude Code and Codex stop a turn); typing still queues the next prompt
    $('stop-agent').hidden = !(embedded && agent?.owned && !agent.exited && agent.status === 'busy');
    paintSend();
    $('composer').setAttribute('aria-busy', String(sending));
    if ($('send-message').dataset.sending !== String(sendingSlow)) { $('send-message').dataset.sending = String(sendingSlow); $('send-message').innerHTML = sendingSlow ? '<span class="spinner" aria-hidden="true"></span>' : icon('arrow-up'); }
  }

  function paintSend() {
    const agent = byId.get(selectedId), button = $('send-message');
    const on = !!agent && !agent.exited && connected && !sending && !!($('message-input').value.trim() || attachments.get(selectedId)?.length);
    if (button.disabled === on) { button.disabled = !on; if (on) { button.classList.remove('ready'); void button.offsetWidth; button.classList.add('ready'); } }
  }
  function resizeComposer() {
    if (CSS.supports('field-sizing', 'content')) return; // the box grows with its text by itself
    const input = $('message-input'); input.style.height = 'auto'; input.style.height = `${Math.max(44, Math.min(input.scrollHeight, 200))}px`;
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (sending || !connected || !byId.has(selectedId)) return;
    const id = selectedId, images = attachments.get(id) || [], typed = $('message-input').value.trim(), original = $('message-input').value;
    const text = [typed, images.map(quotePath).join(' ')].filter(Boolean).join(' ');
    if (!text) return;
    sending = true; $('send-error').hidden = true;
    const slow = setTimeout(() => { sendingSlow = true; updateComposer(); }, 700); // the button only spins when it is slow
    updateComposer();
    const asking = approvalFor === id && !$('approval-card').hidden; // a question on screen: Enter would answer it
    const agent = byId.get(id), holding = agent.owned && (agent.status === 'busy' || needsYou(agent) || asking || queued[id]?.length || flushing.has(id));
    // sent straight in: the prompt shows in the conversation at once and the box empties; an error puts it back
    const now = agent.owned && !holding ? { key: `out:${Date.now().toString(36)}`, text, at: Date.now() } : null;
    if (now) {
      outgoing.set(id, [...(outgoing.get(id) || []), now]);
      $('message-input').value = ''; drafts[id] = ''; persistDraft(); resizeComposer(); attachments.delete(id); renderAttachments(); updateComposer();
      renderTimeline(); $('thread-scroll').scrollTo({ top: $('thread-scroll').scrollHeight, behavior: 'smooth' });
    }
    try {
      const tagged = [...taggedAgents(text).values()].filter((a) => (!a.owned || a.backendId) && (!agent.owned || agent.backendId)); // a session Synapse has not matched to its agent yet can't be linked
      if (tagged.length) {
        const linked = new Set(relations(id).filter((p) => p.reads && p.shares).map((p) => p.agent.id));
        for (const other of tagged.filter((a) => !linked.has(a.id))) { await createEdge(other.id, id); await createEdge(id, other.id); }
        if (tagged.some((a) => !linked.has(a.id))) await reloadState();
      }
      if (holding) { queued[id] = [...(queued[id] || []), { id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, at: Date.now() }]; saveQueue(); renderQueue(); }
      else if (agent.owned) await desktopCall('submit', { id, text });
      else await api(`/api/agents/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
      if (!now) { // (a prompt shown at once emptied the box when it was sent)
        attachments.delete(id); if (selectedId === id) renderAttachments();
        if (selectedId === id && $('message-input').value === original) { $('message-input').value = ''; drafts[id] = ''; persistDraft(); resizeComposer(); }
        else { drafts[id] = drafts[id] === original ? '' : drafts[id]; }
      }
      // keep showing the conversation while it reloads: dropping it would blank the list and jump to the top
      if (holding) return; // queued: nothing new in the conversation yet
      const stale = recentCache.get(id); if (stale) stale.activity = -1;
      if (selectedId === id) { await loadRecent(true); $('thread-scroll').scrollTo({ top: $('thread-scroll').scrollHeight, behavior: 'smooth' }); }
    } catch (error) {
      if (now) {
        outgoing.set(id, (outgoing.get(id) || []).filter((o) => o !== now));
        if (!$('message-input').value) { $('message-input').value = original; drafts[id] = original; resizeComposer(); }
        if (images.length && !attachments.get(id)?.length) attachments.set(id, images);
        if (selectedId === id) { renderAttachments(); renderTimeline(); }
      }
      if (selectedId === id) { $('send-error').textContent = error.message; $('send-error').hidden = false; $('message-input').setAttribute('aria-invalid', 'true'); }
      else toast(error.message);
    } finally { clearTimeout(slow); sending = sendingSlow = false; updateComposer(); }
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

  // ---- Rooms (rooms.mjs on the server, ~/.synapse/rooms.json): group chats of people and their agents. People add
  // their own Claude and Codex agents; an @mention gets an answer from a read-only copy of that agent.
  let roomsData = { me: null, rooms: [], agents: [], friends: [] }, roomOpen = null, roomShown = null, roomsSig = '', roomSig = '', roomsTimer = null;
  async function loadRooms(reset = false) {
    clearTimeout(roomsTimer);
    if (view !== 'rooms') return;
    try {
      roomsData = await api('/api/rooms');
      if (!roomOpen || !roomsData.rooms.some((r) => r.id === roomOpen)) roomOpen = roomsData.rooms[0]?.id || null;
      roomShown = roomOpen ? await api(`/api/rooms/${encodeURIComponent(roomOpen)}`) : null;
    } catch (e) { if (reset) toast(e.message); }
    renderRooms(reset);
    roomsTimer = setTimeout(() => loadRooms(), document.hidden ? 8000 : 1500);
  }
  const roomAgentLabel = (a, room) => (room.agents.filter((x) => x.name === a.name).length > 1 ? `${a.name}@${a.owner}` : a.name);
  function renderRooms(reset) {
    const sig = JSON.stringify([roomsData.rooms.map((r) => [r.id, r.name, r.count, r.lastAt]), roomOpen]);
    if (sig !== roomsSig || reset) {
      roomsSig = sig;
      $('room-list').innerHTML = roomsData.rooms.length ? roomsData.rooms.map((r) => `<button type="button" class="room-item${r.id === roomOpen ? ' active' : ''}" data-room="${escapeHtml(r.id)}"><strong>${escapeHtml(r.name)}</strong><span>${escapeHtml(r.last ? `${r.last.from}: ${r.last.text}` : `${r.members.length} ${r.members.length === 1 ? 'person' : 'people'}, ${r.agents.length} ${r.agents.length === 1 ? 'agent' : 'agents'}`)}</span></button>`).join('')
        : '<p class="todo-empty">No rooms yet. Make one, add your agents and invite friends.</p>';
    }
    const r = roomShown;
    const rs = JSON.stringify(r && [r.id, r.name, r.members, r.agents, r.messages.length, r.messages.at(-1)?.id, r.answering]);
    if (rs === roomSig && !reset) return;
    roomSig = rs;
    if (!r) { $('room-pane').innerHTML = emptyState('No room open', 'Make a room, then @mention an agent to ask it something.', '', '', 'users'); return; }
    const box = $('room-pane').querySelector('.room-messages');
    const atEnd = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const keep = $('room-input')?.value ?? '';
    const focused = document.activeElement?.id === 'room-input';
    const mine = (a) => a.machine === roomsData.me?.machine;
    const answering = new Set(r.answering || []);
    const who = (m) => m.from.type === 'agent' ? `<span class="agent-avatar" data-logo="${escapeHtml(m.from.kind || '')}" aria-hidden="true">${escapeHtml((m.from.name || '?').slice(0, 2).toUpperCase())}</span>` : m.from.type === 'system' ? '' : `${icon('user')}`;
    const rows = r.messages.map((m) => m.from.type === 'system'
      ? `<div class="room-msg system">${escapeHtml(m.text)}</div>`
      : `<div class="room-msg ${m.from.type}${m.from.machine === roomsData.me?.machine && m.from.type === 'human' ? ' own' : ''}"><div class="room-who">${who(m)}<strong>${escapeHtml(m.from.name)}</strong>${m.from.type === 'agent' ? `<span class="room-tag">agent of ${escapeHtml(m.from.owner || '')}</span>` : ''}<time>${escapeHtml(new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time></div><div class="room-text">${escapeHtml(m.text)}</div></div>`).join('');
    const typing = r.agents.filter((a) => mine(a) && answering.has(a.id)).map((a) => a.name);
    $('room-pane').innerHTML = `<header class="room-head"><div><h2>${escapeHtml(r.name)}</h2><p>${r.members.map((m) => escapeHtml(m.name)).join(', ')}</p></div>
      <div class="room-actions"><button type="button" class="button secondary" data-room-add-agent>${icon('plus')}Add my agent</button>${r.hosted ? `<button type="button" class="button secondary" data-room-add-person>${icon('user')}Add person</button>` : ''}<button type="button" class="icon-button" data-room-leave title="${r.hosted ? 'Close this room for everyone' : 'Leave this room'}" aria-label="${r.hosted ? 'Close room' : 'Leave room'}">${icon('x')}</button></div></header>
      <div class="room-agents">${r.agents.map((a) => `<button type="button" class="room-agent" data-room-mention="${escapeHtml(roomAgentLabel(a, r))}" title="Mention ${escapeHtml(a.name)} (agent of ${escapeHtml(a.owner)})"><span class="agent-avatar" data-logo="${escapeHtml(a.kind)}" aria-hidden="true">${escapeHtml(a.name.slice(0, 2).toUpperCase())}</span>@${escapeHtml(roomAgentLabel(a, r))}${mine(a) ? `<span class="room-x" role="button" data-room-drop="${escapeHtml(a.id)}" title="Take ${escapeHtml(a.name)} out" aria-label="Remove">${icon('x')}</span>` : ''}</button>`).join('') || '<span class="room-hint">No agents yet. Add one of yours; friends add theirs.</span>'}</div>
      <div class="room-messages" aria-live="polite">${rows || '<p class="room-hint">Say hi. Type @ and an agent name to ask it.</p>'}${typing.length ? `<div class="room-msg system">${escapeHtml(typing.join(', '))} ${typing.length === 1 ? 'is' : 'are'} answering…</div>` : ''}</div>
      <form class="room-compose" id="room-compose" autocomplete="off"><textarea id="room-input" rows="1" maxlength="4000" placeholder="Message ${escapeHtml(r.name)}. @mention an agent to ask it"></textarea><button class="button" type="submit">Send</button></form>
      <p class="room-hint">Agents in rooms only read and answer. They have no tools, can not change anything, and secrets are scrubbed from what they say.</p>`;
    $('room-input').value = keep;
    if (focused || reset) $('room-input').focus();
    const nb = $('room-pane').querySelector('.room-messages');
    if (atEnd || reset) nb.scrollTop = nb.scrollHeight;
  }
  async function sendRoom() {
    const input = $('room-input'), text = input.value.trim();
    if (!text || !roomOpen) return;
    input.value = '';
    try { await api(`/api/rooms/${encodeURIComponent(roomOpen)}/messages`, { method: 'POST', body: JSON.stringify({ text }) }); }
    catch (e) { input.value = text; toast(e.message); }
    loadRooms();
  }
  function newRoom() {
    const agents = roomsData.agents || [];
    openModal('New room', `<label class="field-label" for="room-name">Name</label><input class="field" id="room-name" maxlength="60" placeholder="launch prep">
      ${agents.length ? `<fieldset class="room-pick"><legend>Your agents in it (Claude and Codex)</legend>${agents.map((a) => `<label><input type="checkbox" value="${escapeHtml(a.id)}"> ${escapeHtml(a.name)} <span class="room-tag">${escapeHtml(a.kind)}</span></label>`).join('')}</fieldset>` : ''}`, 'Create', async () => {
      const name = $('room-name').value.trim();
      if (!name) throw new Error('Give the room a name.');
      const picked = [...$('dialog-content').querySelectorAll('.room-pick input:checked')].map((x) => x.value);
      const r = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name, agents: picked }) });
      roomOpen = r.id; loadRooms(true);
    });
  }
  function addRoomAgent() {
    const inRoom = new Set((roomShown?.agents || []).filter((a) => a.machine === roomsData.me?.machine).map((a) => a.id));
    const agents = (roomsData.agents || []).filter((a) => !inRoom.has(a.id));
    if (!agents.length) return toast('No Claude or Codex agent of yours to add. Start one first.');
    openModal('Add your agent', `<fieldset class="room-pick"><legend>It answers read only when someone @mentions it</legend>${agents.map((a) => `<label><input type="checkbox" value="${escapeHtml(a.id)}"> ${escapeHtml(a.name)} <span class="room-tag">${escapeHtml(a.kind)}</span></label>`).join('')}</fieldset>`, 'Add', async () => {
      const picked = [...$('dialog-content').querySelectorAll('.room-pick input:checked')].map((x) => x.value);
      for (const id of picked) await api(`/api/rooms/${encodeURIComponent(roomOpen)}/agents`, { method: 'POST', body: JSON.stringify({ agent: id }) });
      loadRooms(true);
    });
  }
  function addRoomPerson() {
    const inRoom = new Set((roomShown?.members || []).map((m) => m.machine));
    const friendsLeft = (roomsData.friends || []).filter((f) => !inRoom.has(f.machine));
    if (!friendsLeft.length) return toast('No friend left to add. Add trusted people in Settings first.');
    openModal('Add a person', `<fieldset class="room-pick"><legend>Friends join straight away and can add their own agents</legend>${friendsLeft.map((f) => `<label><input type="checkbox" value="${escapeHtml(f.machine)}"> ${escapeHtml(f.name)}${f.online ? '' : ' <span class="room-tag">offline</span>'}</label>`).join('')}</fieldset>`, 'Add', async () => {
      const picked = [...$('dialog-content').querySelectorAll('.room-pick input:checked')].map((x) => x.value);
      for (const machine of picked) await api(`/api/rooms/${encodeURIComponent(roomOpen)}/members`, { method: 'POST', body: JSON.stringify({ machine }) });
      loadRooms(true);
    });
  }
  $('room-new').addEventListener('click', () => newRoom());
  $('rooms-view').addEventListener('click', async (event) => {
    const el = event.target.closest('[data-room], [data-room-add-agent], [data-room-add-person], [data-room-leave], [data-room-mention], [data-room-drop]');
    if (!el) return;
    if (el.dataset.room) { roomOpen = el.dataset.room; return loadRooms(true); }
    if (el.dataset.roomDrop) { event.stopPropagation(); try { await api(`/api/rooms/${encodeURIComponent(roomOpen)}/agents/${encodeURIComponent(el.dataset.roomDrop)}`, { method: 'DELETE' }); } catch (e) { toast(e.message); } return loadRooms(true); }
    if (el.dataset.roomMention) { const i = $('room-input'); i.value = `${i.value.replace(/\s*$/, i.value.trim() ? ' ' : '')}@${el.dataset.roomMention} `; i.focus(); return; }
    if ('roomAddAgent' in el.dataset) return addRoomAgent();
    if ('roomAddPerson' in el.dataset) return addRoomPerson();
    if ('roomLeave' in el.dataset) {
      if (!window.confirm(roomShown?.hosted ? 'Close this room for everyone in it?' : 'Leave this room?')) return;
      try { await api(`/api/rooms/${encodeURIComponent(roomOpen)}`, { method: 'DELETE' }); } catch (e) { toast(e.message); }
      roomOpen = null; loadRooms(true);
    }
  });
  $('rooms-view').addEventListener('submit', (event) => { if (event.target.id === 'room-compose') { event.preventDefault(); sendRoom(); } });
  $('rooms-view').addEventListener('keydown', (event) => {
    if (event.target.id === 'room-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendRoom(); }
  });

  // ---- Todos (todos.mjs on the server, in ~/.synapse/todos.json): the user's and their agents' list. A todo can be
  // linked to the agent doing it (by the id the server knows it by); when that agent ends, you are asked whether its
  // open todos are done. With Linear connected, issues assigned to you come in, and ticking one moves it there too.
  function todoList() { return state?.todos || []; }
  function agentOfTodo(t) { return t.agent ? state.agents.find((a) => a.id === t.agent.id || a.backendId === t.agent.id) : null; }
  function agentTodos(agent) { return todoList().filter((t) => t.agent && (t.agent.id === agent.id || t.agent.id === agent.backendId)); }
  function todosOf(agent) { return agentTodos(agent).map((t) => [t.id, t.text, t.done]); } // (a signature)
  function todoRef(a) { return { id: a.backendId || a.id, name: titleOf(a) }; }
  // Start agent: the New session screen opens with the todo as the first message, and the agent it starts gets the todo
  const canStartFromTodo = (t) => embedded && !paneKey && !!desktop && !t.done;
  function startFromTodo(t) { showNew(agentOfTodo(t)?.cwd || null, null, t); }
  const todoCall = (path, method, body) => api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  async function refreshLinear() { try { linear = await api('/api/linear'); } catch {} todosSignature = ''; if (view === 'todos') renderTodos(); }
  function paintTodoCount() {
    const open = todoList().filter((t) => !t.done).length;
    $('todo-count').hidden = !open; $('todo-count').textContent = open > 99 ? '99+' : String(open);
  }
  // a todo; in a group the header already names its agent, elsewhere a quiet line says who has it
  function todoRow(t, { grouped = false } = {}) {
    const a = agentOfTodo(t), id = escapeHtml(t.id);
    const who = grouped ? (t.agent ? '' : `<button type="button" class="todo-assign" data-todo-link="${id}">${icon('user')}<span>Assign</span></button>`)
      : t.agent ? `<button type="button" class="todo-who${a ? '' : ' gone'}" data-todo-agent="${id}" title="${a ? `Open ${escapeHtml(titleOf(a))}` : `${escapeHtml(t.agent.name)} has ended`}">${a ? avatar(a) : icon('user')}<span>${escapeHtml(a ? titleOf(a) : t.agent.name)}</span></button>` : '';
    const lin = t.linear ? `<a class="todo-linear" href="${escapeHtml(t.linear.url)}" target="_blank" rel="noopener" title="Open in Linear">${escapeHtml(t.linear.identifier)}</a>` : '';
    const by = t.by && t.by !== 'you' && t.by !== 'Linear' ? `<span class="todo-by">by ${escapeHtml(t.by)}</span>` : '';
    const start = canStartFromTodo(t) ? `<button type="button" class="todo-start" data-todo-start="${id}" title="Start a new agent on this todo">${icon('play')}<span>Start agent</span></button>` : '';
    return `<div class="todo-row${t.done ? ' done' : ''}" data-todo="${id}"><button type="button" class="todo-check" data-todo-check="${id}" aria-pressed="${t.done}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}">${icon('check')}</button><span class="todo-text">${escapeHtml(t.text)}</span>${by}${lin}${start}${who}<button type="button" class="icon-button todo-more" data-todo-more="${id}" aria-label="More" title="More">${icon('more')}</button></div>`;
  }
  // open todos by who has them: yours first, then each agent's under a header with its name and project
  function todoGroups(open) {
    const groups = new Map([['', { todos: [] }]]);
    for (const t of open) {
      const a = agentOfTodo(t), key = t.agent ? (a?.id || `gone:${t.agent.id}`) : '';
      if (!groups.has(key)) groups.set(key, { agent: a, ref: t.agent, todos: [] });
      groups.get(key).todos.push(t);
    }
    return [...groups.entries()].filter(([, g]) => g.todos.length).map(([key, g]) => {
      const head = !key ? `<div class="todo-group-head mine">${icon('user')}<span class="todo-group-name">Yours</span><span class="count">${g.todos.length}</span></div>`
        : `<button type="button" class="todo-group-head${g.agent ? '' : ' gone'}" ${g.agent ? `data-todo-open="${escapeHtml(g.agent.id)}" title="Open ${escapeHtml(titleOf(g.agent))}"` : `title="${escapeHtml(g.ref.name)} has ended" disabled`}>${g.agent ? avatar(g.agent) : icon('user')}<span class="todo-group-name">${escapeHtml(g.agent ? titleOf(g.agent) : g.ref.name)}</span>${g.agent?.project ? `<span class="todo-group-meta">${escapeHtml(g.agent.project)}</span>` : g.agent ? '' : '<span class="todo-group-meta">ended</span>'}<span class="count">${g.todos.length}</span></button>`;
      return `<section class="todo-group">${head}${g.todos.map((t) => todoRow(t, { grouped: true })).join('')}</section>`;
    }).join('');
  }
  function renderTodos() {
    const all = todoList(), open = all.filter((t) => !t.done).sort((a, b) => b.createdAt - a.createdAt), done = all.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    const sig = JSON.stringify([all, linear, showDone, !!desktop, state.agents.map((a) => [a.id, a.backendId, titleOf(a)])]);
    if (sig === todosSignature) return;
    todosSignature = sig;
    const picked = todoPick && agentOfTodo({ agent: todoPick });
    if (todoPick && !picked) todoPick = null; // the picked agent ended
    $('todo-agent-pick').classList.toggle('on', !!picked);
    $('todo-agent-pick').title = picked ? `New todos go to ${titleOf(picked)}` : 'Give new todos to an agent';
    $('todo-agent-pick').innerHTML = picked ? `${avatar(picked)}<span>${escapeHtml(titleOf(picked))}</span><span class="todo-pick-clear" data-todo-pick-clear role="button" aria-label="Keep new todos for yourself" title="Keep them for yourself">${icon('x')}</span>` : `${icon('user')}<span>Assign</span>`;
    $('linear-box').innerHTML = linear.connected
      ? `<span class="linear-state${linear.error ? ' error' : ''}" title="${escapeHtml(linear.error || (linear.syncedAt ? `Synced ${relativeTime(linear.syncedAt)} ago` : 'Not synced yet'))}"><span class="linear-mark"></span>Linear${linear.name ? ` · ${escapeHtml(linear.name)}` : ''}</span><button type="button" class="button secondary" data-linear="sync">Sync</button><button type="button" class="icon-button" data-linear="menu" aria-label="Linear settings" title="Linear settings">${icon('more')}</button>`
      : `<button type="button" class="button secondary" data-linear="connect"><span class="linear-mark"></span>Connect Linear</button>`;
    $('todo-list').innerHTML = (open.length ? todoGroups(open) : `<p class="todo-empty">Nothing to do. Add a todo above, or ask an agent to note one.</p>`)
      + (done.length ? `<button type="button" class="todo-done-toggle" data-todo-done-toggle aria-expanded="${showDone}">${icon(showDone ? 'chevron-down' : 'chevron-right')}Done <span class="count">${done.length}</span></button>${showDone ? `<div class="todo-done-rows">${done.slice(0, 200).map((t) => todoRow(t)).join('')}</div>` : ''}` : '');
  }
  function todoSection(agent) {
    const mine = todoList().filter((t) => t.agent && (t.agent.id === agent.id || t.agent.id === agent.backendId));
    const open = mine.filter((t) => !t.done), done = mine.length - open.length;
    if (agent.remote) return '';
    return `<section class="inspector-section todo-section"><div class="inspector-title-row"><h3 class="inspector-label">Todos</h3><span class="count">${open.length}</span></div>${open.map(todoRow).join('')}${done ? `<p class="inspector-note">${done} done</p>` : ''}<form class="todo-add mini" data-todo-add-for="${escapeHtml(agent.id)}" autocomplete="off"><input maxlength="500" placeholder="Add a todo for this agent" aria-label="New todo for this agent"></form></section>`;
  }
  async function todoAction(fn) { try { await fn(); } catch (e) { toast(e.message); } }
  function pickAgent(anchor, current, choose) {
    const agents = state.agents.filter((a) => !a.remote && !a.exited && a.kind !== 'shell').sort((x, y) => (y.lastActivity || 0) - (x.lastActivity || 0)).slice(0, 25);
    dropdown(anchor, [{ label: 'Yours (no agent)', icon: 'user', check: !current, run: () => choose(null) }, '-', { heading: 'Give it to' },
      ...agents.map((a) => ({ label: titleOf(a), hint: a.project || kindName(a), avatar: avatar(a), check: !!current && (current === a.id || current === backend(a)), run: () => choose(a) }))]);
  }
  function todoMenu(anchor, t) {
    dropdown(anchor, [
      { label: t.done ? 'Mark not done' : 'Mark done', icon: 'check', run: () => todoAction(() => todoCall(`/api/todos/${t.id}`, 'PATCH', { done: !t.done })) },
      ...(canStartFromTodo(t) ? [{ label: 'Start a new agent on it', icon: 'play', run: () => startFromTodo(t) }] : []),
      { label: 'Edit…', icon: 'edit', run: () => openModal('Edit todo', `<label class="field-label" for="todo-edit">Todo</label><input class="field" id="todo-edit" maxlength="500" value="${escapeHtml(t.text)}">`, 'Save', () => todoCall(`/api/todos/${t.id}`, 'PATCH', { text: $('todo-edit').value })) },
      { label: t.agent ? 'Link to another agent…' : 'Link to an agent…', icon: 'arrows', run: () => pickAgent(anchor, t.agent?.id, (a) => todoAction(() => todoCall(`/api/todos/${t.id}`, 'PATCH', { agent: a ? todoRef(a) : null }))) },
      ...(t.linear ? [{ label: `Open ${t.linear.identifier} in Linear`, icon: 'external', run: () => window.open(t.linear.url, '_blank', 'noopener') }]
        : linear.connected ? [{ label: 'Send to Linear', icon: 'arrow-up', run: () => todoAction(() => todoCall(`/api/todos/${t.id}/linear`, 'POST')) }] : []),
      '-',
      { label: 'Delete', icon: 'x', danger: true, run: () => todoAction(() => todoCall(`/api/todos/${t.id}`, 'DELETE')) },
    ]);
  }
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-todo-pick-clear]')) { event.preventDefault(); todoPick = null; todosSignature = ''; renderTodos(); return; }
    const open = event.target.closest('[data-todo-open]');
    if (open) { event.preventDefault(); navigate('session', open.dataset.todoOpen); return; }
    const el = event.target.closest('[data-todo-check], [data-todo-more], [data-todo-agent], [data-todo-link], [data-todo-start], [data-todo-done-toggle], [data-linear], #todo-agent-pick');
    if (!el) return;
    event.preventDefault();
    const t = todoList().find((x) => x.id === (el.dataset.todoCheck || el.dataset.todoMore || el.dataset.todoAgent || el.dataset.todoLink || el.dataset.todoStart));
    if (el.dataset.todoStart && t) return startFromTodo(t);
    if (el.dataset.todoCheck && t) {
      el.closest('.todo-row')?.classList.toggle('ticking', !t.done);
      return todoAction(() => todoCall(`/api/todos/${t.id}`, 'PATCH', { done: !t.done }));
    }
    if (el.dataset.todoMore && t) return todoMenu(el, t);
    if (el.dataset.todoAgent && t) { const a = agentOfTodo(t); return a ? navigate('session', a.id) : todoMenu(el, t); }
    if (el.dataset.todoLink && t) return pickAgent(el, null, (a) => todoAction(() => todoCall(`/api/todos/${t.id}`, 'PATCH', { agent: a ? todoRef(a) : null })));
    if (el.hasAttribute('data-todo-done-toggle')) { showDone = !showDone; todosSignature = ''; return renderTodos(); }
    if (el.id === 'todo-agent-pick') return pickAgent(el, todoPick?.id, (a) => { todoPick = a ? todoRef(a) : null; todosSignature = ''; renderTodos(); });
    const act = el.dataset.linear;
    if (act === 'connect') return openModal('Connect Linear', `<p class="dialog-copy">Issues assigned to you come in as todos. Ticking one here moves it to done in Linear, and any todo can be sent to Linear.</p><label class="field-label" for="linear-key">Personal API key</label><input class="field" id="linear-key" type="password" autocomplete="off" placeholder="lin_api_…"><p class="field-hint">In Linear: Settings → Security &amp; access → Personal API keys. It is kept on this Mac only, in ~/.synapse.</p>`, 'Connect', async () => { linear = await todoCall('/api/linear', 'PUT', { key: $('linear-key').value }); todosSignature = ''; renderTodos(); });
    if (act === 'sync') return todoAction(async () => { el.disabled = true; try { await todoCall('/api/linear/sync', 'POST'); } finally { el.disabled = false; } await refreshLinear(); });
    if (act === 'menu') return dropdown(el, [
      ...(linear.teams?.length > 1 ? [{ heading: 'New issues go to' }, ...linear.teams.map((team) => ({ label: team.name, icon: team.id === linear.team ? 'check' : '', run: () => todoAction(async () => { linear = await todoCall('/api/linear', 'PATCH', { team: team.id }); todosSignature = ''; renderTodos(); }) })), '-'] : []),
      { label: 'Disconnect Linear', icon: 'unlink', danger: true, run: () => todoAction(async () => { linear = await todoCall('/api/linear', 'DELETE'); todosSignature = ''; renderTodos(); }) },
    ]);
  });
  $('todo-add').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('todo-input'), text = input.value.trim(); if (!text) return;
    input.value = '';
    todoAction(() => todoCall('/api/todos', 'POST', { text, agent: todoPick }));
  });
  document.addEventListener('submit', (event) => {
    const form = event.target.closest?.('[data-todo-add-for]'); if (!form) return;
    event.preventDefault();
    const input = form.querySelector('input'), text = input.value.trim(), a = byId.get(form.dataset.todoAddFor); if (!text || !a) return;
    input.value = '';
    todoAction(() => todoCall('/api/todos', 'POST', { text, agent: todoRef(a) }));
  });
  // An agent with open todos ended (closed, its process quit, or tidied away): are they done? Asked once per todo,
  // for agents seen running in this window (one missing at startup may just not be listed yet), after a grace period
  // (an agent can drop out of the list for a moment while its session is matched).
  const relinking = new Set();
  function askEndedTodos() {
    // linked while the app had not yet matched the session to its agent: move the link to the id agents know it by
    for (const t of todoList()) {
      const a = t.agent && !relinking.has(t.id) && state.agents.find((x) => x.owned && x.id === t.agent.id && x.backendId);
      if (a) { relinking.add(t.id); todoCall(`/api/todos/${t.id}`, 'PATCH', { agent: todoRef(a) }).catch(() => {}).finally(() => relinking.delete(t.id)); }
    }
    const live = new Set();
    for (const a of state.agents) if (!a.exited) { live.add(a.id); if (a.backendId) live.add(a.backendId); }
    for (const id of live) { seenLive.add(id); goneSince.delete(id); }
    const ended = new Map();
    for (const t of todoList()) {
      if (t.done || t.asked || !t.agent || live.has(t.agent.id) || !seenLive.has(t.agent.id)) continue;
      if (!goneSince.has(t.agent.id)) goneSince.set(t.agent.id, Date.now());
      if (Date.now() - goneSince.get(t.agent.id) < 6000) { if (!askLater) askLater = setTimeout(() => { askLater = 0; askEndedTodos(); }, 6500); continue; }
      ended.set(t.agent.id, [...(ended.get(t.agent.id) || []), t]);
    }
    if (!ended.size || $('action-dialog').open) return;
    const [, list] = [...ended][0], name = list[0].agent.name;
    for (const t of list) todoCall(`/api/todos/${t.id}`, 'PATCH', { asked: true }).catch(() => {});
    for (const t of list) t.asked = true; // not asked twice while the change comes back
    openModal(`${name} ended`, `<p class="dialog-copy">It had ${list.length === 1 ? 'an open todo' : `${list.length} open todos`}. Which are done?</p><div class="todo-ask">${list.map((t) => `<label class="todo-ask-row"><input type="checkbox" value="${escapeHtml(t.id)}" checked><span>${escapeHtml(t.text)}</span>${t.linear ? `<small>${escapeHtml(t.linear.identifier)}</small>` : ''}</label>`).join('')}</div><p class="field-hint">Cancel keeps them all open.</p>`, 'Mark done', async () => {
      const ids = [...$('dialog-content').querySelectorAll('.todo-ask input:checked')].map((i) => i.value);
      await Promise.all(ids.map((id) => todoCall(`/api/todos/${id}`, 'PATCH', { done: true })));
    });
  }

  // answering from the keyboard: while the box you type in is empty (or the card has focus), 1-9 picks, ↑↓ move,
  // Enter takes the highlighted answer, Esc cancels
  document.addEventListener('keydown', (event) => {
    const card = $('approval-card');
    if (card.hidden || !approvalFor || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    const inCard = card.contains(document.activeElement), input = $('message-input');
    if (document.activeElement?.closest('.ask-own')) return;
    if (!inCard && !(document.activeElement === input && !input.value) && document.activeElement !== document.body) return;
    const rows = [...card.querySelectorAll('.ask-option')];
    const at = Math.max(0, rows.findIndex((r) => r.classList.contains('active')));
    const move = (to) => { rows[at]?.classList.remove('active'); rows[to]?.classList.add('active'); rows[to]?.scrollIntoView({ block: 'nearest' }); };
    if (/^[1-9]$/.test(event.key)) { const row = rows.find((r) => r.querySelector('.ask-key')?.textContent === event.key) || rows[Number(event.key) - 1]; if (row) { event.preventDefault(); event.stopPropagation(); row.click(); } return; }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows.length) { event.preventDefault(); event.stopPropagation(); move((at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length); return; }
    if (event.key === 'Enter' && !event.shiftKey && rows.length && !inCard) { event.preventDefault(); event.stopPropagation(); rows[at].click(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); answerApproval('escape'); }
  }, true); // before the box's own keys (Enter would send it; a digit would be typed into it)
  $('approval-card').addEventListener('pointermove', (event) => {
    const row = event.target.closest('.ask-option'); if (!row || row.classList.contains('active')) return;
    $('approval-card').querySelector('.ask-option.active')?.classList.remove('active'); row.classList.add('active');
  });
  $('approval-card').addEventListener('submit', (event) => {
    const form = event.target.closest('[data-approval-input]'); if (!form) return;
    event.preventDefault();
    const text = form.querySelector('input').value.trim(); if (!text) return;
    answerApproval(form.dataset.approvalInput, { text });
  });

  // ---- A new version: a banner at the bottom left of the sidebar, until you update
  let update = {};
  function renderUpdateCard() {
    const card = $('update-card'), v = update.version ? ` ${update.version}` : '';
    const shown = ['downloading', 'ready', 'manual', 'installing'].includes(update.state);
    card.hidden = !shown;
    if (!shown) return;
    const pct = Math.round((update.progress || 0) * 100), st = update.state;
    const label = st === 'ready' ? `Synapse${v} is ready` : st === 'manual' ? `Synapse${v} is out` : st === 'installing' ? 'Restarting…' : `Downloading${v}`;
    const end = st === 'ready' ? '<button type="button" class="update-go" data-update-go="1">Restart</button>'
      : st === 'manual' ? '<button type="button" class="update-go" data-update-go="1">Download</button>'
      : st === 'downloading' ? `<span class="update-pct">${pct}%</span>` : '';
    card.dataset.state = st;
    card.innerHTML = `<span class="update-dot" aria-hidden="true"></span><span class="update-label">${escapeHtml(label)}</span>${end}${st === 'downloading' ? `<span class="update-bar" style="width:${pct}%"></span>` : ''}`;
    if (update.notes) card.title = update.notes;
  }
  $('update-card').addEventListener('click', (event) => {
    if (event.target.closest('[data-update-go]')) desktopCall('update').catch((e) => toast(e.message));
  });

  // ---- Add a workspace: one you had before, a clone, a folder, or a new repo. Once it is in, the new session screen
  // opens on it, so you can start an agent there right away.
  const WS_TABS = [
    ['library', 'Your workspaces', 'Search by name or path', 'Open'],
    ['clone', 'Clone', 'https://github.com/owner/repo', 'Clone'],
    ['open', 'Folder', '~/code/repo', 'Add'],
    ['new', 'New', 'my-project', 'Create'],
  ];
  const WS_HINTS = {
    library: 'Workspaces in ~/.synapse/workspaces. The ones in your sidebar are marked.',
    clone: 'Clones into ~/.synapse/workspaces. GitHub, GitLab or any git URL.',
    open: 'Any repo, worktree or folder on this Mac.',
    new: 'Makes ~/.synapse/workspaces/<name> as a new git repo.',
  };
  let wsMode = null, wsLibrary = [], wsHome = '', wsPick = 0, cloning = false;
  async function addProject(mode) {
    if (!embedded) return toast('Add workspaces in the Synapse app.');
    try { const r = await desktopCall('project-library'); wsLibrary = r?.library || []; wsHome = r?.home || ''; } catch { wsLibrary = []; }
    wsMode = mode || (wsLibrary.some((w) => !w.added) ? 'library' : 'clone'); wsPick = 0;
    openModal('Add a workspace', `<div class="ws-add">
      <div class="segmented-control ws-tabs" role="tablist" aria-label="How to add it">${WS_TABS.map(([k, label]) => `<button type="button" role="tab" data-ws-tab="${k}">${label}</button>`).join('')}</div>
      <div class="ws-input"><input class="field" id="ws-value" spellcheck="false" autocomplete="off"><button type="button" class="button secondary" id="ws-browse">${icon('folder-plus')}Choose…</button></div>
      <div class="ws-list" id="ws-list" role="listbox" aria-label="Your workspaces"></div>
      <p class="ws-hint" id="ws-hint"></p>
    </div>`, 'Open', submitWorkspace);
    $('action-dialog').classList.add('ws-dialog');
    $('action-dialog').addEventListener('close', () => $('action-dialog').classList.remove('ws-dialog'), { once: true });
    $('dialog-content').querySelector('.ws-tabs').addEventListener('click', (event) => { const b = event.target.closest('[data-ws-tab]'); if (b && !cloning) setWsMode(b.dataset.wsTab); });
    $('ws-browse').onclick = async () => { try { const r = await desktopCall('project-add', { mode: 'pick' }); if (r?.dir) { $('action-dialog').close(); openWorkspace(r.dir); } } catch (e) { $('dialog-error').textContent = e.message; $('dialog-error').hidden = false; } };
    $('ws-value').addEventListener('input', () => { if (wsMode === 'library') { wsPick = 0; renderWsList(); } });
    $('ws-value').addEventListener('keydown', (event) => {
      if (wsMode !== 'library') return;
      const rows = [...$('ws-list').querySelectorAll('.ws-row')];
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows.length) { event.preventDefault(); wsPick = (wsPick + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length; renderWsList(); }
    });
    $('ws-list').addEventListener('click', (event) => { const row = event.target.closest('.ws-row'); if (!row) return; wsPick = Number(row.dataset.i); $('action-form').requestSubmit(); });
    setWsMode(wsMode);
  }
  function setWsMode(mode) {
    wsMode = mode;
    const [, label, placeholder, submit] = WS_TABS.find(([k]) => k === mode);
    for (const b of document.querySelectorAll('[data-ws-tab]')) { b.setAttribute('aria-pressed', String(b.dataset.wsTab === mode)); b.setAttribute('aria-selected', String(b.dataset.wsTab === mode)); }
    const input = $('ws-value');
    input.value = ''; input.placeholder = placeholder; input.setAttribute('aria-label', label); input.type = mode === 'library' ? 'search' : 'text';
    $('ws-browse').hidden = mode !== 'open';
    $('ws-list').hidden = mode !== 'library';
    $('ws-hint').textContent = WS_HINTS[mode]; $('ws-hint').classList.remove('busy');
    $('dialog-submit').textContent = submit; $('dialog-error').hidden = true;
    if (mode === 'library') { wsPick = 0; renderWsList(); }
    input.focus();
  }
  const wsMatches = () => { const q = ($('ws-value')?.value || '').trim().toLowerCase(); return wsLibrary.filter((w) => [w.label, w.name, w.path].some((v) => v?.toLowerCase().includes(q))); };
  function renderWsList() {
    const list = wsMatches();
    if (wsPick >= list.length) wsPick = 0;
    const short = (p) => wsHome && p.startsWith(wsHome) ? `~${p.slice(wsHome.length)}` : p;
    $('ws-list').innerHTML = list.length ? list.map((w, i) => {
      const name = w.label || w.name;
      return `<button type="button" class="ws-row${i === wsPick ? ' on' : ''}" role="option" aria-selected="${i === wsPick}" data-i="${i}"><span class="ws-badge" style="--badge:oklch(70% 0.13 ${hueOf(w.path)})">${escapeHtml(name.slice(0, 1).toUpperCase())}</span><span class="ws-name">${escapeHtml(name)}</span><span class="ws-path">${escapeHtml(short(w.path))}</span>${w.added ? '<span class="ws-tag">In sidebar</span>' : ''}</button>`;
    }).join('') : `<p class="ws-empty">${wsLibrary.length ? 'No workspace matches.' : 'Nothing here yet. Clone a repo, add a folder or start a new one.'}</p>`;
    $('ws-list').querySelector('.ws-row.on')?.scrollIntoView({ block: 'nearest' });
    $('dialog-submit').disabled = !list.length;
  }
  async function submitWorkspace() {
    if (wsMode === 'library') {
      const w = wsMatches()[wsPick]; if (!w) throw new Error('Pick a workspace.');
      if (!w.added) await desktopCall('project-add', { mode: 'open', value: w.path });
      openWorkspace(w.path); return;
    }
    const value = $('ws-value').value.trim();
    if (wsMode === 'clone') { cloning = true; $('ws-hint').textContent = 'Cloning…'; $('ws-hint').classList.add('busy'); }
    try {
      const r = await desktopCall('project-add', { mode: wsMode, value });
      if (r?.dir) openWorkspace(r.dir);
    } finally { cloning = false; $('ws-hint')?.classList.remove('busy'); }
  }
  // the new session screen on the workspace, once the app has told us about it
  function openWorkspace(dir) {
    const started = Date.now();
    const go = () => {
      if (worktreeList().some((w) => w.path === dir)) return showNew(dir);
      if (Date.now() - started < 4000) setTimeout(go, 100); else toast(`Added ${dir.split('/').pop()}`);
    };
    go();
  }

  // ---- New session, like T3: "What should we do in <project>?" with the project and agent as pickers,
  // and the first message typed right there. Enter starts the agent with that message.
  const newDraft = { cwd: null, kind: getStorage('synapse-new-kind') || null, todo: null };
  const worktreeList = () => (desktop?.projects || []).flatMap((p) => p.worktrees.map((w) => ({ ...w, project: p.label, projectKey: p.key, home: w.path === p.worktrees[0]?.path })));
  // kind: open the screen on that agent (⌘T: a shell), otherwise the last one picked
  // todo: start on that todo (its text is the first message, and the agent started gets it)
  function showNew(cwd, kind = null, todo = null) {
    const list = worktreeList();
    if (!list.length) { addProject(); return; }
    if (todo || newDraft.todo) { newDraft.todo = todo?.id || null; $('new-input').value = todo ? todo.text : ''; }
    const current = byId.get(selectedId);
    const want = cwd || current?.cwd;
    newDraft.cwd = list.find((w) => w.path === want)?.path || list.find((w) => want?.startsWith(`${w.path}/`))?.path || (list.some((w) => w.path === newDraft.cwd) ? newDraft.cwd : list[0].path);
    if (kind && Object.hasOwn(desktop.profiles, kind)) newDraft.kind = kind;
    else if (newDraft.kind === 'shell' || !Object.hasOwn(desktop.profiles, newDraft.kind)) newDraft.kind = getStorage('synapse-new-kind') !== 'shell' && Object.hasOwn(desktop.profiles, getStorage('synapse-new-kind')) ? getStorage('synapse-new-kind') : null;
    if (!Object.hasOwn(desktop.profiles, newDraft.kind)) newDraft.kind = ['claude', 'codex'].find((k) => Object.hasOwn(desktop.profiles, k)) || Object.keys(desktop.profiles)[0];
    navigate('new');
    renderAttachments(); paintMentionBar();
    requestAnimationFrame(() => $('new-input').focus());
  }
  function renderNew() {
    const list = worktreeList(), w = list.find((x) => x.path === newDraft.cwd) || list[0];
    if (!w) return;
    newDraft.cwd = w.path;
    const group = { key: w.projectKey, worktrees: [w], agents: [] };
    const label = `<span class="new-badge" aria-hidden="true" style="--badge:${projectColor(group)}">${escapeHtml(w.project.slice(0, 1).toUpperCase())}</span><span class="new-name">${escapeHtml(w.project)}</span>${icon('chevron-down')}`;
    if ($('new-project').dataset.sig !== w.path) {
      $('new-project').dataset.sig = w.path; $('new-project').innerHTML = label;
      const img = avatarImg(groupDir(group), 'new-logo'); if (img) $('new-project').querySelector('.new-badge').append(img);
    }
    const siblings = list.filter((x) => x.projectKey === w.projectKey);
    $('new-branch').hidden = siblings.length < 2;
    $('new-branch').innerHTML = `${icon('branch')}<span>${escapeHtml(w.home ? 'Main checkout' : w.branch || w.name)}</span>${icon('chevron-down')}`;
    const profile = desktop.profiles[newDraft.kind] || {};
    $('new-agent').innerHTML = `${avatar({ kind: newDraft.kind, name: profile.label || newDraft.kind })}<span>${escapeHtml(profile.label || newDraft.kind)}</span>${icon('chevron-down')}`;
    renderModel();
    $('new-lead').textContent = newDraft.kind === 'shell' ? 'Open a terminal in' : 'What should we do in';
    $('new-input').placeholder = newDraft.kind === 'shell' ? 'Opens a shell in this folder. Type a command to run, or leave empty.' : 'Describe the task. Leave empty to just start the agent.';
    const command = String(profile.command || (newDraft.kind === 'shell' ? 'your shell' : newDraft.kind)).replace(/^exec\s+/, '').replace(/^\S*\//, '');
    $('new-hint').textContent = `Runs ${command} in ${w.path.replace(/^\/Users\/[^/]+/, '~')}`;
    const todo = newDraft.todo && todoList().find((t) => t.id === newDraft.todo);
    if (newDraft.todo && !todo) newDraft.todo = null;
    $('new-todo').hidden = !todo || newDraft.kind === 'shell';
    if (todo) $('new-todo').innerHTML = `${icon('todo')}<span class="new-todo-text">For your todo: ${escapeHtml(todo.text)}</span><button type="button" class="new-todo-clear" aria-label="Start without the todo" title="Start without the todo">${icon('x')}</button>`;
  }
  // The model picker (like T3 Code's): one button in the composer shows the agent, its model and effort; it opens a
  // panel with the agents on a rail, their models in a searchable list (favorites starred), the model's effort
  // levels, and the permission mode at the foot. Choices are remembered per agent; the agent's own default is used
  // until one is picked. The rail replaces the separate agent button.
  const modelLists = new Map();
  const pickedModel = (kind) => getStorage(`synapse-new-model:${kind}`) || '';
  const pickedEffort = (kind) => getStorage(`synapse-new-effort:${kind}`) || '';
  const pickedMode = (kind) => getStorage(`synapse-new-mode:${kind}`) || '';
  const favorites = () => { try { return new Set(JSON.parse(getStorage('synapse-model-favs', '[]'))); } catch { return new Set(); } };
  const PICKER_KINDS = ['claude', 'codex', 'opencode', 'antigravity'];
  function loadModels(kind) {
    if (!PICKER_KINDS.includes(kind)) return Promise.resolve({ models: [] });
    if (!modelLists.has(kind)) modelLists.set(kind, desktopCall('models', { kind }).catch(() => ({ models: [] })).then((r) => { modelLists.set(kind, r); if (newDraft.kind === kind) renderModel(); return r; }));
    return Promise.resolve(modelLists.get(kind));
  }
  const knownModels = (kind) => { const l = modelLists.get(kind); return l && !(l instanceof Promise) ? l : null; };
  // the effort that applies: the one picked, if this model has it; else nothing (the model's own default)
  function effortFor(kind, model) {
    const e = pickedEffort(kind), list = knownModels(kind);
    const m = list?.models.find((x) => x.id === (model ?? pickedModel(kind))) || (!pickedModel(kind) && list?.models[0]);
    return e && m?.efforts?.some((x) => x.id === e) ? e : '';
  }
  function renderModel() {
    const kind = newDraft.kind, profile = desktop.profiles[kind] || {};
    if (PICKER_KINDS.includes(kind) && !modelLists.has(kind)) loadModels(kind);
    const known = knownModels(kind), picked = pickedModel(kind);
    const model = known?.models.find((m) => m.id === picked)?.label || picked || (known?.current ? known.current : 'Default');
    const effort = effortFor(kind), effortLabel = effort && known?.models.find((m) => m.id === picked)?.efforts?.find((e) => e.id === effort)?.label;
    $('new-agent').hidden = true;
    const b = $('new-model'); b.hidden = false; b.classList.add('model-trigger');
    const who = kind === 'shell' ? `<span class="mp-glyph">${icon('terminal')}</span>` : avatar({ kind, name: profile.label || kind });
    b.innerHTML = `${who}<span class="mt-model">${escapeHtml(kind === 'shell' ? 'Shell' : PICKER_KINDS.includes(kind) ? model : profile.label || kind)}</span>${effortLabel ? `<span class="mt-effort">· ${escapeHtml(effortLabel)}</span>` : ''}${icon('chevron-down')}`;
    b.title = `${profile.label || kind}${PICKER_KINDS.includes(kind) ? ` · ${model}` : ''}  ⇧⌘M`;
  }
  function openModelPicker() {
    const anchor = $('new-model');
    if (openMenu?.anchor === anchor) return closeMenu();
    closeMenu();
    const el = document.createElement('div'); el.className = 'model-picker'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Agent and model');
    let kind = newDraft.kind, query = '', active = -1, col = 'list', modeOpen = false; // active -1: on the chosen model
    const kinds = Object.keys(desktop.profiles);
    const choose = (k) => { newDraft.kind = k; if (k !== 'shell') setStorage('synapse-new-kind', k); kind = k; query = ''; active = -1; renderNew(); paint(); };
    const pickModel = (id) => { setStorage(`synapse-new-model:${kind}`, id); renderModel(); };
    const close = () => { closeMenu(); $('new-input').focus(); };
    function rows(list) {
      const favs = favorites(), q = query.toLowerCase().split(/\s+/).filter(Boolean);
      const all = [{ id: '', label: list.current ? `Default (${list.current})` : 'Default', hint: 'What the agent is set to use', efforts: list.models[0]?.efforts, defaultEffort: list.models[0]?.defaultEffort }, ...list.models];
      const hit = (m) => q.every((w) => `${m.label} ${m.id} ${m.hint || ''}`.toLowerCase().includes(w));
      const groups = [];
      const fav = all.filter((m) => m.id && favs.has(`${kind}:${m.id}`) && hit(m));
      if (fav.length) groups.push(['Favorites', fav]);
      if (kind === 'opencode') {
        const by = new Map(); for (const m of all.filter(hit)) { const g = m.id ? m.id.split('/')[0] : 'Default'; if (!by.has(g)) by.set(g, []); by.get(g).push(m); }
        groups.push(...by);
      } else groups.push([desktop.profiles[kind]?.label || kind, all.filter(hit)]);
      return groups;
    }
    function paint() {
      const list = knownModels(kind), profile = desktop.profiles[kind] || {};
      const rail = kinds.map((k) => `<button type="button" class="mp-agent${k === kind ? ' on' : ''}" data-kind="${escapeHtml(k)}" title="${escapeHtml(desktop.profiles[k]?.label || k)}">${k === 'shell' ? `<span class="mp-glyph">${icon('terminal')}</span>` : avatar({ kind: k, name: desktop.profiles[k]?.label || k })}</button>`).join('');
      let middle, efforts = '';
      if (!PICKER_KINDS.includes(kind)) middle = `<div class="mp-empty">${kind === 'shell' ? 'A shell in this folder.' : `${escapeHtml(profile.label || kind)} starts with its own model.`}</div>`;
      else if (!list) { loadModels(kind).then(() => { if (openMenu?.el === el) paint(); }); middle = '<div class="mp-empty">Loading models…</div>'; }
      else {
        const groups = rows(list), flat = groups.flatMap(([, ms]) => ms), picked = pickedModel(kind), favs = favorites();
        if (active < 0) active = Math.max(0, flat.findIndex((m) => m.id === picked));
        active = Math.max(0, Math.min(active, flat.length - 1));
        let i = 0;
        const items = groups.map(([g, ms]) => `<div class="mp-heading">${escapeHtml(g)}</div>${ms.map((m) => `<button type="button" class="mp-model${m.id === picked ? ' on' : ''}${i === active && col === 'list' ? ' hot' : ''}" data-model="${escapeHtml(m.id)}" data-i="${i++}" title="${escapeHtml(m.hint || '')}">${avatar({ kind, name: profile.label || kind })}<span class="mp-name">${escapeHtml(kind === 'opencode' && m.id ? m.id.split('/').slice(1).join('/') : m.label)}</span>${m.id === picked ? icon('check') : ''}${m.id ? `<span class="mp-star${favs.has(`${kind}:${m.id}`) ? ' on' : ''}" data-star="${escapeHtml(m.id)}" title="Favorite">${icon('star')}</span>` : ''}</button>`).join('')}`).join('');
        middle = `<label class="mp-search">${icon('search')}<input type="search" placeholder="Search ${escapeHtml(profile.label || kind)} models…" spellcheck="false" value="${escapeHtml(query)}"></label><div class="mp-list">${items || '<div class="mp-empty">No model matches.</div>'}</div>`;
        const current = list.models.find((m) => m.id === picked) || (!picked && list.models[0]);
        const levels = current?.efforts || [];
        if (levels.length) {
          const chosen = effortFor(kind, picked) || '', def = current.defaultEffort || '';
          efforts = `<div class="mp-effort"><div class="mp-effort-head"><span>Effort</span><span>${escapeHtml(picked ? current.label : 'Default')}</span></div>${levels.map((e, n) => `<button type="button" class="mp-level${(chosen || def) === e.id ? ' on' : ''}" data-effort="${escapeHtml(e.id)}" title="${escapeHtml(e.hint || '')}"><span class="mp-bars">${levels.map((_, b) => `<i class="${b <= n ? 'f' : ''}" style="height:${4 + Math.round(8 * b / Math.max(1, levels.length - 1))}px"></i>`).join('')}</span>${escapeHtml(e.label)}${e.id === def ? '<span class="mp-tag">Default</span>' : ''}</button>`).join('')}</div>`;
        }
      }
      const modes = knownModels(kind)?.modes || [], mode = modes.find((m) => m.id === pickedMode(kind)) || modes[0];
      const foot = modes.length ? `<div class="mp-foot"><span class="mp-foot-label">Permissions</span><button type="button" class="mp-mode" aria-expanded="${modeOpen}">${icon('shield')}<span>${escapeHtml(mode.label)}</span>${icon('chevron-down')}</button>${modeOpen ? `<div class="mp-modes">${modes.map((m) => `<button type="button" class="${m.id === mode.id ? 'on' : ''}" data-mode="${escapeHtml(m.id)}"><span>${escapeHtml(m.label)}<small>${escapeHtml(m.hint)}</small></span>${m.id === mode.id ? icon('check') : ''}</button>`).join('')}</div>` : ''}</div>` : '';
      const typing = document.activeElement?.matches?.('.mp-search input');
      el.innerHTML = `<div class="mp-rail">${rail}</div><div class="mp-models">${middle}</div>${efforts}${foot}`;
      el.classList.toggle('no-effort', !efforts);
      if (typing || col === 'list') { const input = el.querySelector('.mp-search input'); if (input) { input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); } else el.focus({ preventScroll: true }); }
      el.querySelector('.mp-model.hot')?.scrollIntoView({ block: 'nearest' });
    }
    el.tabIndex = -1;
    el.addEventListener('input', (e) => { if (e.target.matches('.mp-search input')) { query = e.target.value; active = 0; paint(); } });
    el.addEventListener('click', (e) => {
      const t = e.target.closest('button, [data-star]'); if (!t) return;
      if (t.dataset.star !== undefined) {
        e.stopPropagation();
        const f = favorites(), key = `${kind}:${t.dataset.star}`; if (f.has(key)) f.delete(key); else f.add(key);
        setStorage('synapse-model-favs', JSON.stringify([...f])); return paint();
      }
      if (t.dataset.kind) return choose(t.dataset.kind);
      if (t.dataset.model !== undefined) { pickModel(t.dataset.model); return close(); }
      if (t.dataset.effort) { setStorage(`synapse-new-effort:${kind}`, t.dataset.effort); renderModel(); return close(); }
      if (t.classList.contains('mp-mode')) { modeOpen = !modeOpen; return paint(); }
      if (t.dataset.mode !== undefined) { setStorage(`synapse-new-mode:${kind}`, t.dataset.mode); modeOpen = false; return paint(); }
    });
    el.addEventListener('keydown', (e) => {
      const flat = [...el.querySelectorAll('.mp-model')];
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (modeOpen) { modeOpen = false; return paint(); } return close(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); const d = e.key === 'ArrowDown' ? 1 : -1;
        if (col === 'rail') { const i = kinds.indexOf(kind); return choose(kinds[(i + d + kinds.length) % kinds.length]); }
        if (col === 'effort') { const ls = [...el.querySelectorAll('.mp-level')], i = ls.findIndex((x) => x.classList.contains('on')); const n = ls[Math.max(0, Math.min(ls.length - 1, i + d))]; if (n) { setStorage(`synapse-new-effort:${kind}`, n.dataset.effort); renderModel(); paint(); } return; }
        active = Math.max(0, Math.min(flat.length - 1, active + d)); return paint();
      }
      if (e.key === 'ArrowLeft' && !(e.target.matches('input') && e.target.selectionStart > 0)) { e.preventDefault(); col = col === 'effort' ? 'list' : 'rail'; el.dataset.col = col; return paint(); }
      if (e.key === 'ArrowRight' && !(e.target.matches('input') && e.target.selectionStart < e.target.value.length)) { e.preventDefault(); col = col === 'rail' ? 'list' : el.querySelector('.mp-effort') ? 'effort' : 'list'; el.dataset.col = col; return paint(); }
      if (e.key === 'Enter') { e.preventDefault(); const hot = el.querySelector('.mp-model.hot'); if (col === 'list' && hot) { pickModel(hot.dataset.model); } return close(); }
    });
    document.body.append(el);
    openMenu = { el, anchor }; anchor.setAttribute('aria-expanded', 'true');
    paint();
    const r = anchor.getBoundingClientRect(), h = el.offsetHeight, w = el.offsetWidth;
    const below = innerHeight - r.bottom - 12;
    el.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, r.left)))}px`;
    if (below >= h || below >= r.top) el.style.top = `${Math.round(r.bottom + 6)}px`; else el.style.bottom = `${Math.round(innerHeight - r.top + 6)}px`;
    el.animate([{ opacity: 0, transform: 'translateY(-4px) scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  }
  $('new-model').onclick = openModelPicker;
  // ⇧⌘M opens it on the New session screen
  addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'm' && e.metaKey && e.shiftKey && view === 'new') { e.preventDefault(); openModelPicker(); } });
  $('new-todo').addEventListener('click', (event) => { if (event.target.closest('.new-todo-clear')) { newDraft.todo = null; renderNew(); $('new-input').focus(); } });
  $('new-project').onclick = () => {
    const seen = new Set();
    const items = worktreeList().filter((w) => w.home && !seen.has(w.projectKey) && seen.add(w.projectKey)).map((w) => ({ label: w.project, icon: w.path === newDraft.cwd || newDraft.cwd?.startsWith(`${w.path}`) ? 'check' : null, run: () => { newDraft.cwd = w.path; renderNew(); $('new-input').focus(); } }));
    dropdown($('new-project'), [...items, '-', { label: 'Add a workspace…', icon: 'plus', run: () => addProject() }], (() => { const r = $('new-project').getBoundingClientRect(); return { x: r.left, y: r.bottom + 6 }; })());
  };
  $('new-branch').onclick = () => {
    const w = worktreeList().find((x) => x.path === newDraft.cwd); if (!w) return;
    const items = worktreeList().filter((x) => x.projectKey === w.projectKey).map((x) => ({ label: x.home ? 'Main checkout' : x.branch || x.name, icon: x.path === w.path ? 'check' : 'branch', run: () => { newDraft.cwd = x.path; renderNew(); $('new-input').focus(); } }));
    dropdown($('new-branch'), [...items, '-', { label: 'New worktree…', icon: 'plus', run: () => runDesktop('worktree', { key: w.projectKey }) }], (() => { const r = $('new-branch').getBoundingClientRect(); return { x: r.left, y: r.bottom + 6 }; })());
  };
  $('new-agent').onclick = () => {
    const items = Object.entries(desktop.profiles).map(([k, p]) => ({ label: p.label || k, icon: k === newDraft.kind ? 'check' : k === 'shell' ? 'terminal' : null, run: () => { newDraft.kind = k; if (k !== 'shell') setStorage('synapse-new-kind', k); renderNew(); $('new-input').focus(); } }));
    dropdown($('new-agent'), items, (() => { const r = $('new-agent').getBoundingClientRect(); return { x: r.left, y: r.bottom + 6 }; })());
  };
  let starting = false;
  async function startNew(event) {
    event?.preventDefault();
    if (starting) return;
    const typed = $('new-input').value.trim(), files = attachments.get(NEW) || [];
    const prompt = [typed, files.map(quotePath).join(' ')].filter(Boolean).join(' ');
    const tagged = newDraft.kind === 'shell' ? [] : [...taggedAgents(typed).values()].filter((a) => !a.owned || a.backendId);
    starting = true; $('new-start').disabled = true; $('new-start').innerHTML = '<span class="spinner" aria-hidden="true"></span>';
    try {
      const shell = newDraft.kind === 'shell';
      const todo = !shell && newDraft.todo && todoList().find((t) => t.id === newDraft.todo);
      const first = todo ? `${prompt || todo.text}\n\n(This is Synapse todo ${todo.id}. When it is done, tick it with synapse_todo_update.)` : prompt;
      const result = await desktopCall('new-session', { cwd: newDraft.cwd, kind: newDraft.kind, prompt: shell ? '' : first, model: shell ? '' : pickedModel(newDraft.kind), effort: shell ? '' : effortFor(newDraft.kind), mode: shell ? '' : pickedMode(newDraft.kind) });
      desktop = await desktopCall('state'); applyState(rawState);
      $('new-input').value = ''; newDraft.todo = null; attachments.delete(NEW); renderAttachments(); paintMentionBar();
      if (tagged.length) connectWhenMatched(result.id, tagged);
      if (todo) { const a = byId.get(result.id); todoAction(() => todoCall(`/api/todos/${todo.id}`, 'PATCH', { agent: a ? todoRef(a) : { id: result.id, name: desktop.profiles[newDraft.kind]?.label || newDraft.kind } })); }
      navigate('session', result.id);
      if (shell && prompt) desktopCall('submit', { id: result.id, text: prompt }).catch(() => {});
    } catch (e) { toast(e.message); }
    finally { starting = false; $('new-start').disabled = false; $('new-start').innerHTML = icon('arrow-up'); }
  }
  $('new-composer').addEventListener('submit', startNew);
  $('new-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && document.getElementById('mention-pop')?.hidden !== false) startNew(event); });

  // ---- Terminals in the GUI. Terminal mode's real terminals are shown in place: the page leaves an empty box
  // (#term-host for a session's Terminal tab, #drawer-host for the ⌘J drawer) and the app lays the terminal over it.
  const defaultTab = (agent) => (embedded && agent?.owned && agent.kind === 'shell' ? 'terminal' : 'conversation');
  let drawerId = null, drawerCwd = null;
  const drawerShells = new Map(); // folder -> the drawer shell there, kept while it runs
  // the drawer slides open and shut; its terminal joins once it is open (a terminal resized every frame stutters)
  let drawerAnim = null, drawerClosing = false;
  function slideDrawer(open) {
    const el = $('term-drawer'), h = el.scrollHeight;
    drawerAnim?.cancel();
    el.style.overflow = 'hidden';
    drawerAnim = el.animate(open ? [{ height: '0px', opacity: 0 }, { height: `${h}px`, opacity: 1 }] : [{ height: `${h}px`, opacity: 1 }, { height: '0px', opacity: 0 }],
      { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    const anim = drawerAnim;
    return anim.finished.then(() => true, () => false).finally(() => { if (drawerAnim === anim) { drawerAnim = null; el.style.overflow = ''; } });
  }
  async function openDrawer(quiet = false) {
    const agent = byId.get(selectedId); if (!embedded || !agent?.cwd) return;
    const cwd = agent.cwd, slide = $('term-drawer').hidden || drawerClosing;
    drawerClosing = false;
    drawerCwd = cwd; $('term-drawer').hidden = false; $('open-terminal').setAttribute('aria-expanded', 'true');
    $('term-drawer-folder').textContent = cwd.replace(/^\/Users\/[^/]+/, '~');
    $('drawer-host').style.height = `${Math.max(120, Math.min(innerHeight - 220, Number(getStorage('synapse-drawer-h')) || 260))}px`;
    const sliding = slide ? slideDrawer(true) : null;
    let id = drawerShells.get(cwd);
    if (!id || !desktop?.sessions.some((s) => s.id === id && !s.exited)) {
      try { id = (await desktopCall('new-session', { cwd, kind: 'shell', drawer: true })).id; drawerShells.set(cwd, id); desktop = await desktopCall('state'); }
      catch (e) { if (!quiet) toast(e.message); toggleDrawer(false); return; }
    }
    if (sliding) await sliding;
    if (drawerCwd !== cwd || drawerClosing) return; // the selection moved on, or it was shut, while it started
    drawerId = id; syncDocks(quiet ? false : 'drawer');
  }
  function toggleDrawer(open = $('term-drawer').hidden || drawerClosing) {
    if (open) return openDrawer();
    drawerId = drawerCwd = null; drawerClosing = true; syncDocks(); // the terminal leaves first, then the drawer slides shut
    $('open-terminal').setAttribute('aria-expanded', 'false');
    slideDrawer(false).then((done) => { if (done && drawerClosing) { drawerClosing = false; $('term-drawer').hidden = true; } });
    if (tab !== 'terminal') $('message-input').focus();
  }
  $('term-drawer-grip').addEventListener('pointerdown', (event) => {
    const host = $('drawer-host'), y0 = event.clientY, h0 = host.offsetHeight;
    const move = (e) => { host.style.height = `${Math.max(120, Math.min(innerHeight - 220, h0 + y0 - e.clientY))}px`; syncDocks(); };
    const up = () => { removeEventListener('pointermove', move); setStorage('synapse-drawer-h', String(host.offsetHeight)); };
    addEventListener('pointermove', move); addEventListener('pointerup', up, { once: true });
  });
  const docked = { main: '', drawer: '' };
  function dockRect(el) {
    if (!el || !el.getClientRects().length || document.querySelector('dialog[open]') || openMenu) return null;
    const r = el.getBoundingClientRect();
    return r.width < 60 || r.height < 40 ? null : { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  function syncDocks(focus = false) {
    if (!embedded || paneKey || !desktop) return;
    const agent = byId.get(selectedId), session = desktopActive && view === 'session' && agent && !splitActive && !$('thread-view').hidden;
    // what floats over the page (the update card, a toast): the docked terminals leave a hole there
    const covers = ['update-card', 'toast'].map((id) => $(id)).filter((el) => el && !el.hidden && el.getClientRects().length)
      .map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
    const want = {
      main: session && agent.owned && tab === 'terminal' ? { id: agent.id, rect: dockRect($('term-host')), covers } : null,
      drawer: session && drawerId && !$('term-drawer').hidden && !drawerAnim ? { id: drawerId, rect: dockRect($('drawer-host')), covers } : null,
    };
    for (const place of ['main', 'drawer']) {
      const w = want[place]?.rect ? { ...want[place], moving: panelsMoving() } : null, sig = w ? JSON.stringify(w) : '';
      if (sig === docked[place] && focus !== place) continue;
      docked[place] = sig;
      desktopCall('dock', { place, id: w?.id || null, rect: w?.rect || null, covers: w?.covers || [], focus: focus === place, moving: !!w?.moving }).catch(() => { docked[place] = ''; });
    }
  }

  function connectAgent(cwd) {
    if (embedded && desktop && !paneKey) return showNew(typeof cwd === 'string' ? cwd : null);
    if (embedded && desktop) {
      const worktrees = desktop.projects.flatMap((p) => p.worktrees.map((w) => ({ ...w, project: p.label })));
      if (!worktrees.length) { addProject(); return; }
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
  let friends = null, connectionMode = 'mine', connectionTicket = 0, friendPreset = null;
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
      const why = !friends.agents.length ? 'Start an agent first. It is the one you share, or the one that receives theirs.' : friends.people.length ? 'None of your trusted people has added you back yet. Once they do, you can share agents with each other.' : 'Add someone you trust first: their email or @handle in Friends or Settings.';
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
    // opened from a person in the sidebar: that person, and the open agent, are already chosen
    if (friendPreset) {
      const { who, agent } = friendPreset; friendPreset = null;
      if (who && $('friend-who')?.querySelector(`option[value="${CSS.escape(who)}"]`)) $('friend-who').value = who;
      if (agent && $('friend-agent')?.querySelector(`option[value="${CSS.escape(agent)}"]`)) $('friend-agent').value = agent;
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

  // ⌘K finds sessions and runs actions, like a command palette: new session in a project, go to a view, settings
  function paletteActions() {
    const agent = view === 'session' ? byId.get(selectedId) : null, out = [];
    const add = (label, iconName, run, hint = '') => out.push({ label, icon: iconName, run, hint, done: /^Go to /.test(label) ? `Opened ${label.slice(6)}` : label === 'Settings' ? 'Opened Settings' : label === 'Switch light / dark' ? 'Theme switched' : /^(Hide|Show) sidebar$/.test(label) ? `Sidebar ${label.startsWith('Hide') ? 'hidden' : 'shown'}` : null });
    add('New session', 'compose', () => connectAgent(), embedded ? '⌘N' : '');
    if (embedded) add('New terminal', 'terminal', () => showNew(null, 'shell'), '⌘T');
    if (embedded) for (const p of desktop?.projects || []) {
      const home = p.worktrees.find((w) => w.home);
      if (home) add(`New session in ${p.label}`, 'compose', () => connectAgent(home.path));
      add(`New worktree in ${p.label}`, 'branch', () => runDesktop('worktree', { key: p.key }));
    }
    if (embedded) add('Add project', 'folder-plus', () => addProject());
    if (agent) {
      add(`Rename "${titleOf(agent)}"`, 'edit', renameAgent);
      if (agent.owned) {
        if (['claude', 'codex'].includes(agent.kind)) add('Fork this conversation', 'branch', forkSession);
        add('Split side by side', 'panel-right', () => runDesktop('split', { id: agent.id, direction: 'right' }), '⌘D');
        add('Close this session', 'x', () => runDesktop('close', { id: agent.id }));
      }
      add('Connect this session to another agent', 'network', () => addConnection());
    }
    add('Go to Overview', 'grid', () => navigate('overview'));
    add('Go to Connections', 'network', () => navigate('connections'));
    add('Go to Rooms', 'users', () => navigate('rooms'));
    add('New room', 'users', () => { navigate('rooms'); newRoom(); });
    if (embedded) add('Go to Activity', 'activity', () => navigate('activity'));
    if (!embedded) add('Go to Canvas', 'canvas', () => (location.href = '/canvas'));
    if (embedded) { add('Settings', 'settings', () => desktopCall('settings').catch((e) => toast(e.message)), '⌘,'); add('Account & sharing', 'user', () => runDesktop('account')); }
    add('Switch light / dark', 'sun', () => $('theme-toggle').click());
    add(sidebarOpen ? 'Hide sidebar' : 'Show sidebar', 'panel-left', () => setSidebar(!sidebarOpen));
    add('Keyboard shortcuts and help', 'help', showHelp);
    return out;
  }
  // ⌘K: the sidebar's search pill grows into the palette (one box: its real left, top, width, height and corners
  // ease from pill to panel), the results stay in place as you type (rows that still match slide to their new
  // place, the rest fade out, new ones blur in one after another), a scope ("Search in" Projects, say) becomes a
  // chip in the field, and on a pick it folds back into the pill, which says what happened before asking again
  let searchScope = null, paletteState = 'closed', pillTimer = null, pillTyping = null;
  const PILL_TEXT = 'Search or jump to…';
  const stillMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SCOPES = { sessions: ['Sessions', 'message'], projects: ['Projects', 'folder'], actions: ['Actions', 'grid'] };
  const projectsForPalette = () => {
    const seen = new Map();
    for (const agent of state.agents) if (agent.project) seen.set(agent.project, (seen.get(agent.project) || 0) + 1);
    return [...seen].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  };
  function searchEntries() {
    const query = $('search-input').value.trim().toLowerCase(), words = query.split(/\s+/).filter(Boolean);
    const score = (label) => (words.length ? words.map((w) => wordScore(w, label)).reduce((a, b) => (a < 0 || b < 0 ? -1 : a + b), 0) : 0);
    const groups = [];
    const scope = searchScope?.kind;
    const pool = scope === 'project' ? state.agents.filter((agent) => agent.project === searchScope.name) : state.agents;
    if (!scope || scope === 'sessions' || scope === 'project') {
      const sessions = searchSessions(pool, query).slice(0, scope ? 40 : query ? 10 : 6);
      if (sessions.length) groups.push(['Sessions', sessions.map((agent) => ({ key: `a:${agent.id}`, agent }))]);
    }
    if (scope === 'projects') {
      const projects = projectsForPalette().map((p) => ({ p, s: score(p.name) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s);
      if (projects.length) groups.push(['Projects', projects.map(({ p }) => ({ key: `p:${p.name}`, project: p }))]);
    }
    if (!scope || scope === 'actions') {
      const actions = paletteActions().map((action) => ({ action, s: score(action.label) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, scope ? 60 : query ? 8 : 5);
      if (actions.length) groups.push(['Actions', actions.map(({ action }) => ({ key: `c:${action.label}`, action }))]);
    }
    if (!scope) {
      const scopes = Object.entries(SCOPES).filter(([, [label]]) => score(label) >= 0 || !words.length).map(([kind, [label, iconName]]) => ({ key: `s:${kind}`, scope: { kind, label, icon: iconName } }));
      if (scopes.length && (!words.length || scopes.length < 3)) groups.push(['Search in', scopes]);
    }
    return { query, groups };
  }
  const hitHtml = (hit, index) => {
    const attrs = `type="button" class="search-result${hit.agent ? '' : ' action-result'}" id="search-result-${index}" data-search-index="${index}" role="option" aria-selected="${index === searchIndex}" tabindex="-1"`;
    if (hit.agent) return `<button ${attrs}>${avatar(hit.agent)}<span class="result-info"><strong>${escapeHtml(titleOf(hit.agent))}</strong><small>${escapeHtml(hit.agent.project)} · ${escapeHtml(titleOf(hit.agent) === hit.agent.name ? kindName(hit.agent) : hit.agent.name)}</small></span>${status(hit.agent)}${icon('arrow-right')}</button>`;
    if (hit.project) return `<button ${attrs}><span class="action-icon">${icon('folder')}</span><span class="result-info"><strong>${escapeHtml(hit.project.name)}</strong></span><kbd>${hit.project.count} session${hit.project.count === 1 ? '' : 's'}</kbd>${icon('arrow-right')}</button>`;
    if (hit.scope) return `<button ${attrs}><span class="action-icon">${icon(hit.scope.icon)}</span><span class="result-info"><strong>${escapeHtml(hit.scope.label)}</strong></span>${icon('arrow-right')}</button>`;
    return `<button ${attrs}><span class="action-icon">${icon(hit.action.icon)}</span><span class="result-info"><strong>${escapeHtml(hit.action.label)}</strong></span>${hit.action.hint ? `<kbd>${escapeHtml(hit.action.hint)}</kbd>` : ''}${icon('arrow-right')}</button>`;
  };
  // background: a state refresh while the palette is open (about once a second). Rows keep their places and the
  // highlighted row stays highlighted; only what a row says changes. Reordering here made the list flash.
  function renderSearch(background = false) {
    const { query, groups } = searchEntries();
    const selectedKey = searchHits[searchIndex]?.key;
    if (background) {
      const was = new Map(searchHits.map((h, i) => [h.key, i]));
      for (const group of groups) group[1] = group[1].map((h, i) => [h, was.has(h.key) ? was.get(h.key) : 1e6 + i]).sort((x, y) => x[1] - y[1]).map(([h]) => h);
    }
    searchHits = groups.flatMap(([, hits]) => hits);
    if (background && selectedKey) { const i = searchHits.findIndex((h) => h.key === selectedKey); if (i >= 0) searchIndex = i; }
    searchIndex = Math.max(0, Math.min(searchIndex, searchHits.length - 1));
    const entries = [];
    let index = 0;
    for (const [label, hits] of groups) {
      entries.push({ key: `h:${label}`, html: `<p class="search-heading">${escapeHtml(label)}</p>` });
      for (const hit of hits) entries.push({ key: hit.key, html: hitHtml(hit, index++), row: true });
    }
    if (!entries.length) entries.push({ key: `empty:${query}`, html: `<p class="search-empty">Nothing matches “${escapeHtml(query)}”.</p>` });
    const list = $('search-results'), motion = !background && !stillMotion() && paletteState === 'open';
    if (background) { // nothing changed: leave the DOM alone
      const rows = [...list.children].filter((e) => !e.classList.contains('leave'));
      if (rows.length === entries.length && rows.every((e, i) => e.dataset.key === entries[i].key && e.dataset.html === entries[i].html)) return;
    }
    const old = new Map([...list.children].filter((e) => !e.classList.contains('leave')).map((e) => [e.dataset.key, e]));
    const before = new Map([...old].map(([key, e]) => [key, e.offsetTop]));
    const keep = new Set(entries.map((x) => x.key));
    for (const [key, e] of old) if (!keep.has(key)) {
      if (!motion) { e.remove(); continue; }
      e.style.top = `${e.offsetTop}px`; e.classList.remove('arrive'); e.classList.add('leave'); e.removeAttribute('id');
      setTimeout(() => e.remove(), 120);
    }
    let arriving = 0;
    const nodes = entries.map((entry) => {
      let e = old.get(entry.key);
      if (e && e.dataset.html !== entry.html) { const t = document.createElement('template'); t.innerHTML = entry.html; const fresh = t.content.firstElementChild; for (const a of [...e.attributes]) if (!['data-key', 'data-html', 'class', 'style'].includes(a.name)) e.removeAttribute(a.name); for (const a of fresh.attributes) if (a.name !== 'class') e.setAttribute(a.name, a.value); e.className = fresh.className; e.innerHTML = fresh.innerHTML; }
      if (!e) {
        const t = document.createElement('template'); t.innerHTML = entry.html; e = t.content.firstElementChild;
        if (motion || paletteState === 'opening') { e.classList.add('arrive'); e.style.setProperty('--d', `${40 + Math.min(arriving++ * 15, 80)}ms`); }
      }
      e.dataset.key = entry.key; e.dataset.html = entry.html;
      return e;
    });
    const leaving = [...list.querySelectorAll(':scope > .leave')];
    list.replaceChildren(...nodes, ...leaving);
    if (motion) for (const e of nodes) {
      const was = before.get(e.dataset.key); if (was == null) continue;
      const delta = was - e.offsetTop;
      if (delta) e.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.9,.3,1)' });
    }
    const n = searchHits.filter((h) => !h.scope).length;
    $('search-count').textContent = `${n} ${n === 1 ? 'result' : 'results'}`;
    if (searchHits.length) $('search-input').setAttribute('aria-activedescendant', `search-result-${searchIndex}`); else $('search-input').removeAttribute('aria-activedescendant');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    fitPalette();
  }
  function paintScope() {
    const chip = $('search-scope');
    chip.hidden = !searchScope;
    if (searchScope) chip.innerHTML = `${icon(searchScope.kind === 'project' ? 'folder' : SCOPES[searchScope.kind][1])}<span>${escapeHtml(searchScope.label)}</span>`;
    $('search-input').placeholder = searchScope ? `Search ${searchScope.kind === 'project' ? 'sessions' : searchScope.label.toLowerCase()}…` : PILL_TEXT;
  }
  function setScope(scope) { searchScope = scope; $('search-input').value = ''; searchIndex = 0; paintScope(); renderSearch(); $('search-input').focus(); }
  function runHit(hit) {
    if (hit.scope) return setScope(hit.scope);
    if (hit.project) return setScope({ kind: 'project', label: hit.project.name, name: hit.project.name });
    if (hit.agent) { closePalette(`Opened ${titleOf(hit.agent)}`); navigate('session', hit.agent.id); return; }
    closePalette(hit.action.done || hit.action.label);
    hit.action.run();
  }
  // where the pill is: the sidebar's, or (sidebar closed) a pill-sized spot at the top of the page
  function pillRect() {
    const pill = $('open-search');
    if (pill.offsetParent) { const r = pill.getBoundingClientRect(); if (r.width) return r; }
    return { left: innerWidth / 2 - 140, top: 52, width: 280, height: 34 };
  }
  function placePalette(rect, radius) {
    const d = $('search-dialog');
    d.style.left = `${rect.left}px`; d.style.top = `${rect.top}px`; d.style.width = `${rect.width}px`;
    if (rect.height != null) d.style.height = `${rect.height}px`;
    d.style.borderRadius = `${radius}px`;
  }
  function fitPalette() {
    if (paletteState !== 'open') return;
    const from = pillRect(), width = Math.min(580, innerWidth - 24);
    const left = Math.max(12, Math.min(from.left, innerWidth - width - 12)), top = Math.max(8, Math.min(from.top, innerHeight * 0.4));
    const height = $('palette-inner').scrollHeight + 2, d = $('search-dialog');
    if (d.classList.contains('shown') && Math.abs(parseFloat(d.style.height) - height) < 1 && parseFloat(d.style.left) === left && parseFloat(d.style.top) === top) return;
    placePalette({ left, top, width, height }, 16);
  }
  function openSearch() {
    if ($('action-dialog').open) return;
    const d = $('search-dialog');
    if (paletteState === 'open' || paletteState === 'opening') { $('search-input').focus(); return; }
    clearTimeout(pillTimer); sayPill(PILL_TEXT, true);
    searchScope = null; paintScope();
    $('search-input').value = ''; searchIndex = 0; $('search-results').replaceChildren();
    const from = pillRect();
    d.classList.remove('shown', 'folding');
    d.classList.add('instant'); placePalette(from, from.height / 2);
    paletteState = 'opening';
    if (!d.open) d.showModal();
    renderSearch();
    $('search-input').focus();
    void d.offsetWidth; d.classList.remove('instant');
    requestAnimationFrame(() => { paletteState = 'open'; d.classList.add('shown'); fitPalette(); });
  }
  function closePalette(outcome = null) {
    const d = $('search-dialog');
    if (paletteState === 'closed' || paletteState === 'closing') return;
    paletteState = 'closing';
    const done = () => { if (paletteState !== 'closing') return; paletteState = 'closed'; if (d.open) d.close(); d.classList.remove('shown', 'folding'); if (outcome) sayPill(outcome); };
    if (stillMotion()) return done();
    d.classList.remove('shown'); // contents blur out first, then the panel folds back into the pill
    setTimeout(() => { const to = pillRect(); d.classList.add('folding'); placePalette(to, to.height / 2); setTimeout(done, 380); }, 90);
  }
  // the pill says what happened, letter by letter, then asks again
  function sayPill(text, now = false) {
    const el = $('pill-text'); clearInterval(pillTyping);
    if (now || stillMotion()) { el.textContent = text; return; }
    const from = el.textContent; let i = 0; const n = Math.max(from.length, text.length);
    pillTyping = setInterval(() => { i += 2; el.textContent = text.slice(0, i) + from.slice(i); if (i >= n) { clearInterval(pillTyping); el.textContent = text; } }, 16);
    $('open-search').classList.toggle('told', text !== PILL_TEXT);
    clearTimeout(pillTimer);
    if (text !== PILL_TEXT) pillTimer = setTimeout(() => sayPill(PILL_TEXT), 1800);
  }

  function updateConnection(isConnected) {
    const changed = connected !== isConnected;
    connected = isConnected;
    $('connection-banner').hidden = isConnected;
    $('connection-dot').classList.toggle('offline', !isConnected);
    $('local-status').parentElement.title = $('local-status').textContent = isConnected ? `${state.agents.length} ${state.agents.length === 1 ? 'session' : 'sessions'} connected` : ready ? 'Reconnecting…' : 'Connecting…';
    updateComposer();
    if (changed) for (const frame of paneFrames.values()) sendPaneState(frame);
  }

  function applyState(next) {
    rawState = next;
    if (!desktopActive || (embedded && !desktop)) return;
    next = mergeDesktop(next);
    state = next; byId = new Map(next.agents.map((agent) => [agent.id, agent]));
    const first = !ready; ready = true;
    // the open agent turned out to be a session of ours (it registered, and the two merged): keep it open
    const merged = view === 'session' && !byId.has(selectedId) && next.agents.find((agent) => agent.owned && agent.backendId === selectedId);
    if (merged) {
      if (drafts[selectedId] && !drafts[merged.id]) drafts[merged.id] = drafts[selectedId];
      selectedId = merged.id; setStorage('synapse-selected', selectedId);
      history.replaceState({ ...(history.state || {}), view: 'session', id: selectedId }, '', `#agent=${encodeURIComponent(selectedId)}`);
    }
    if (view === 'session' && !byId.has(selectedId)) {
      if (first && !selectedId && next.agents.length) {
        selectedId = next.agents.find((agent) => agent.transcript)?.id || next.agents[0].id;
        $('message-input').value = drafts[selectedId] || '';
      } else { persistDraft(); view = 'overview'; }
    }
    if (first) { history.replaceState({ view, id: selectedId, pos: 0 }, '', location.href); syncNavArrows(); }
    $('demo-banner').hidden = !state.demo;
    if (embedded) {
      $('connect-agent').setAttribute('aria-label', 'New session'); $('connect-agent').title = 'New session  ⌘N';
      document.querySelectorAll('[data-action="connect"]').forEach((b) => { b.innerHTML = icon('plus') + 'New session'; });
    }
    updateConnection(true); renderSidebar(); renderMain(first);
    paintTodoCount(); if (!paneKey) askEndedTodos();
    if (first && embedded && !paneKey) { const people = () => loadFriends().then(() => { renderSidebar(); inspectorSignature = ''; if (inspectorOpen) renderInspector(); }, () => {}); people(); setInterval(people, 60_000); }
    if ($('search-dialog').open && paletteState === 'open') renderSearch(true);
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
      // on the next frame; a window behind others gets no frames, so a timer applies it there
      if (!stateFrame) {
        const run = () => { if (!stateFrame) return; cancelAnimationFrame(stateFrame); clearTimeout(stateTimer); stateFrame = 0; applyState(pendingState); };
        stateFrame = requestAnimationFrame(run); stateTimer = setTimeout(run, 250);
      }
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
  // The / menu: the session's commands and skills with what each does, filtered as you type
  const slashBox = document.createElement('div');
  slashBox.className = 'slash-pop'; slashBox.id = 'slash-pop'; slashBox.setAttribute('role', 'listbox'); slashBox.hidden = true;
  let slashHits = [], slashIndex = 0, slashItemsFor = null, slashLoading = null;
  const KIND_ORDER = ['command', 'setting', 'skill', 'agent'];
  async function slashCatalog(agent) {
    const key = `${agent.kind}:${agent.cwd}`;
    if (slashItemsFor?.key === key) return slashItemsFor.items;
    slashLoading ||= api(`/api/commands?${new URLSearchParams({ kind: agent.kind === 'codex' ? 'codex' : 'claude', cwd: agent.cwd || '' })}`).then((r) => { slashItemsFor = { key, items: r.items || [] }; return slashItemsFor.items; }).finally(() => { slashLoading = null; });
    return slashLoading;
  }
  function slashQuery() {
    const input = $('message-input'), text = input.value.slice(0, input.selectionStart);
    // anywhere a word starts: at the beginning, after a space or a new line (not inside a path like /Users/me)
    const m = text.match(/(?:^|\s)([/$])([\w:.-]*)$/);
    return m && { sigil: m[1], q: m[2].toLowerCase() };
  }
  async function updateSlash() {
    const agent = byId.get(selectedId), hit = slashQuery();
    if (!hit || !agent?.owned || !['claude', 'codex'].includes(agent.kind) || (hit.sigil === '$' && agent.kind !== 'codex')) { slashBox.hidden = true; return; }
    const items = await slashCatalog(agent).catch(() => []);
    if (slashQuery()?.q !== hit.q) return;
    const score = (i) => { if (!hit.q) return 1; const n = wordScore(hit.q, i.name); return n >= 0 ? n + 100 : wordScore(hit.q, i.description) >= 0 && hit.q.length > 2 ? 1 : -1; };
    slashHits = items.filter((i) => (hit.sigil === '$' ? i.sigil === '$' : !i.sigil || agent.kind !== 'codex'))
      .map((i) => ({ i, s: score(i) })).filter((x) => x.s >= 0)
      .sort((a, b) => KIND_ORDER.indexOf(a.i.kind) - KIND_ORDER.indexOf(b.i.kind) || b.s - a.s || a.i.name.localeCompare(b.i.name)).slice(0, hit.q ? 60 : 200).map((x) => x.i);
    if (!slashHits.length) { slashBox.innerHTML = `<p class="mention-foot">No command or skill matches “${escapeHtml(hit.q)}”.</p>`; slashBox.hidden = false; return; }
    slashIndex = Math.min(slashIndex, slashHits.length - 1);
    const label = (i) => ({ skill: 'Skills', setting: 'Settings', agent: 'Subagents' })[i.kind] || 'Commands';
    let last = '';
    slashBox.innerHTML = slashHits.map((i, n) => {
      const head = label(i) !== last ? `<p class="mention-head">${label(i)}</p>` : ''; last = label(i);
      return `${head}<button type="button" class="slash-option" role="option" aria-selected="${n === slashIndex}" data-slash-pick="${n}"><span class="slash-name">${escapeHtml(i.sigil || '/')}${escapeHtml(i.name)}${i.hint ? ` <small>${escapeHtml(i.hint)}</small>` : ''}</span><span class="slash-desc">${escapeHtml(i.description || '')}</span>${i.source !== 'built-in' ? `<span class="slash-source">${escapeHtml(i.source)}</span>` : ''}</button>`;
    }).join('');
    slashBox.hidden = false;
    slashBox.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  function pickSlash(n) {
    const item = slashHits[n]; if (!item) return;
    const input = $('message-input'), caret = input.selectionStart, before = input.value.slice(0, caret), start = before.search(/[/$][\w:.-]*$/);
    input.setRangeText(`${item.sigil || '/'}${item.name} `, start, caret, 'end');
    slashBox.hidden = true; input.focus(); input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  $('message-input').addEventListener('keydown', (event) => {
    if (slashBox.hidden || !slashHits.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopImmediatePropagation(); slashIndex = (slashIndex + (event.key === 'ArrowDown' ? 1 : slashHits.length - 1)) % slashHits.length; updateSlash(); }
    else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); pickSlash(slashIndex); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); slashBox.hidden = true; }
  });
  $('message-input').addEventListener('input', () => { slashIndex = 0; updateSlash(); });
  $('message-input').addEventListener('blur', () => setTimeout(() => { if (!slashBox.contains(document.activeElement)) slashBox.hidden = true; }, 150));
  slashBox.addEventListener('pointerdown', (event) => event.preventDefault());
  slashBox.addEventListener('click', (event) => { const b = event.target.closest('[data-slash-pick]'); if (b) pickSlash(Number(b.dataset.slashPick)); });
  const mentionBox = document.createElement('div');
  mentionBox.className = 'mention-pop'; mentionBox.id = 'mention-pop'; mentionBox.setAttribute('role', 'listbox'); mentionBox.hidden = true;
  const mentionBar = document.createElement('div');
  mentionBar.className = 'mention-bar'; mentionBar.id = 'mention-bar'; mentionBar.hidden = true;
  $('composer').before(mentionBar, mentionBox, slashBox);
  let mentionHits = [], mentionIndex = 0, mentionAt = -1, friendsAt = 0;
  const asked = new Set(); // friend handles asked from this composer, so the bar says so
  const knownFriends = () => (friends?.signedIn ? friends.people.filter((p) => p.handle && p.trustsYou && !p.pending) : []);
  async function freshFriends() {
    if (!embedded || Date.now() - friendsAt < 30000) return;
    friendsAt = Date.now();
    try { await loadFriends(); } catch { friendsAt = 0; }
  }
  // your other live agents, by @handle; friends' handles come first so they never clash
  // the composer in use: the New session screen's, or the conversation's
  const onNew = () => view === 'new';
  const activeInput = () => $(onNew() ? 'new-input' : 'message-input');
  // the @ menu and the tag notes sit on whichever composer is in use
  function placeMentions() {
    const form = $(onNew() ? 'new-composer' : 'composer');
    if (mentionBox.nextElementSibling !== form && mentionBox.nextElementSibling?.nextElementSibling !== form) form.before(mentionBar, mentionBox);
  }
  // tagged on the New session screen: once Synapse has matched the new session to its agent, connect them both ways
  async function connectWhenMatched(id, tagged) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !byId.get(id)?.backendId) {
      if (desktop && !desktop.sessions.some((s) => s.id === id && !s.exited)) return; // closed before it was matched
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!byId.get(id)?.backendId) { toast('Could not connect the tagged agents: Synapse has not matched the new session yet.'); return; }
    try { for (const other of tagged) { await createEdge(other.id, id); await createEdge(id, other.id); } await reloadState(); }
    catch (e) { toast(e.message); }
  }
  const myAgents = () => agentHandles(state.agents.filter((a) => (onNew() || a.id !== selectedId) && a.status !== 'exited' && a.kind !== 'shell').sort((a, b) => String(a.id).localeCompare(String(b.id))), knownFriends().map((p) => p.handle));
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
    placeMentions();
    if (onNew()) { // a session not started yet: tagged agents get connected to it once it starts
      mentionBar.innerHTML = [...taggedAgents($('new-input').value)].map(([handle, agent]) => `<div class="mention-row"><span class="mention agent">@${escapeHtml(handle)}</span><span class="mention-text">Starting connects <strong>${escapeHtml(titleOf(agent))}</strong>${agent.project ? ` (${escapeHtml(agent.project)})` : ''} with the new agent, so they can read each other's work and message.</span></div>`).join('');
      mentionBar.hidden = !mentionBar.innerHTML; return;
    }
    const text = $('message-input').value, seen = new Set(), rows = [];
    const peers = new Set(relations(selectedId).filter((p) => p.reads && p.shares).map((p) => p.agent.id));
    for (const [handle, agent] of taggedAgents(text)) {
      rows.push(`<div class="mention-row"><span class="mention agent">@${escapeHtml(handle)}</span><span class="mention-text">${peers.has(agent.id) ? `<strong>${escapeHtml(titleOf(agent))}</strong> is connected: this agent can read its work and message it.` : `Sending connects <strong>${escapeHtml(titleOf(agent))}</strong>${agent.project ? ` (${escapeHtml(agent.project)})` : ''} with this agent, so they can read each other's work and message.`}</span></div>`);
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
    const input = activeInput(), before = input.value.slice(0, input.selectionStart);
    const m = /(^|[\s(])@([\w-]{0,32})$/.exec(before);
    return m ? { at: before.length - m[2].length - 1, q: m[2].toLowerCase() } : null;
  }
  function paintMentionPop() {
    const hit = mentionQuery();
    if (!hit) { mentionBox.hidden = true; mentionAt = -1; return; }
    mentionAt = hit.at;
    placeMentions();
    const rank = (p) => { const c = friendContext(p); return c.here ? 0 : c.related ? 1 : 2; };
    const self = onNew() ? worktreeList().find((w) => w.path === newDraft.cwd) : byId.get(selectedId);
    // friends are asked to share with an agent that exists, so the New session screen offers your own agents only
    mentionHits = mentionOptions({ friends: onNew() ? [] : [...knownFriends()].sort((a, b) => rank(a) - rank(b)), agents: myAgents(), project: self?.projectKey, query: hit.q });
    if (!mentionHits.length) { mentionBox.hidden = true; return; }
    mentionIndex = Math.min(mentionIndex, mentionHits.length - 1);
    const heads = { friend: 'Friends', here: 'Agents in this project', elsewhere: 'Other agents' };
    let last = '';
    mentionBox.innerHTML = mentionHits.map((o, i) => {
      const group = o.type === 'friend' ? 'friend' : o.local ? 'here' : 'elsewhere';
      const head = group !== last ? `<p class="mention-head">${heads[group]}</p>` : '';
      last = group;
      const option = (name, extra) => `${head}<button type="button" class="mention-option" role="option" aria-selected="${i === mentionIndex}" data-mention-pick="${escapeHtml(o.handle)}"><strong>${escapeHtml(name)}</strong><span>@${escapeHtml(o.handle)}</span><small>${extra}</small></button>`;
      if (o.type === 'agent') return option(titleOf(o.agent), `${escapeHtml(titleOf(o.agent) === o.agent.name ? kindName(o.agent) : o.agent.name)}${o.local ? '' : ` · ${escapeHtml(o.agent.project || '')}`} · ${activityLabel(o.agent).toLowerCase()}`);
      const c = friendContext(o.friend);
      return option(o.friend.name, c.here ? `shares ${escapeHtml(c.here.agent?.name || 'an agent')} here` : c.related ? `has ${escapeHtml(c.related.agent.name)}` : c.project ? `ask for an agent on ${escapeHtml(c.project)}` : 'ask for an agent');
    }).join('') + (hit.q ? '' : '<p class="mention-foot">Type a name to search all your agents</p>');
    mentionBox.hidden = false;
  }
  function pickMention(handle) {
    const input = activeInput(), end = input.selectionStart;
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
  let composerFrame = 0;
  $('message-input').addEventListener('input', () => {
    if ($('message-input').value.includes('@')) freshFriends().then(paintComposer);
    if (!composerFrame) composerFrame = requestAnimationFrame(() => { composerFrame = 0; paintComposer(); });
  });
  $('message-input').addEventListener('scroll', () => { mirror.scrollTop = $('message-input').scrollTop; });
  $('message-input').addEventListener('click', paintMentionPop);
  $('new-input').addEventListener('input', () => { paintMentionBar(); paintMentionPop(); });
  $('new-input').addEventListener('click', paintMentionPop);
  for (const id of ['message-input', 'new-input']) $(id).addEventListener('blur', () => setTimeout(() => { if (!mentionBox.contains(document.activeElement)) mentionBox.hidden = true; }, 120));
  mentionBox.addEventListener('mousedown', (event) => event.preventDefault()); // keep the caret in the textarea
  document.addEventListener('click', (event) => {
    const pick = event.target.closest('[data-mention-pick]'), ask = event.target.closest('[data-mention-ask]');
    if (pick) pickMention(pick.dataset.mentionPick);
    if (ask) askMention(ask.dataset.mentionAsk, ask);
  });
  const mentionKeys = (event) => {
    if (mentionBox.hidden || !mentionHits.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopImmediatePropagation(); mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : mentionHits.length - 1)) % mentionHits.length; paintMentionPop(); }
    else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); pickMention(mentionHits[mentionIndex].handle); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); mentionBox.hidden = true; }
  };
  $('message-input').addEventListener('keydown', mentionKeys);
  $('new-input').addEventListener('keydown', mentionKeys);

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
  $('stop-agent').onclick = async () => {
    const id = selectedId; $('stop-agent').disabled = true;
    try { await desktopCall('keys', { id, key: 'escape' }); stoppedAt.set(id, Date.now()); } // prompts already queued wait a few seconds after a stop
    catch (e) { toast(e.message); }
    finally { setTimeout(() => { $('stop-agent').disabled = false; }, 800); }
  };
  // a keystroke does only what it must: the box's size is CSS, the send button's state; the rest waits for the frame
  $('message-input').addEventListener('input', () => {
    resizeComposer(); paintSend(); $('send-error').hidden = true; $('message-input').removeAttribute('aria-invalid');
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
  $('add-project').onclick = () => addProject();
  $('desktop-account').onclick = () => runDesktop('account');
  $('open-terminal').onclick = () => toggleDrawer();
  $('term-drawer-close').onclick = () => toggleDrawer(false);
  function forkSession() {
    const agent = byId.get(selectedId); if (!agent?.owned) return;
    openModal('Fork conversation', `<p class="dialog-copy">Create a child session with this agent’s context. The parent keeps running.</p><label class="field-label" for="fork-question">Explore in the fork</label><textarea class="field" id="fork-question" rows="4" maxlength="12000" required placeholder="What should the fork work on?"></textarea>`, 'Create fork', async () => {
      const result = await desktopCall('fork', { id: agent.id, question: $('fork-question').value });
      desktop = await desktopCall('state'); applyState(rawState); navigate('session', result.id);
    });
  }
  $('fork-session').onclick = forkSession;
  // a small dropdown under a button, like a native menu: arrow keys move, Escape or a click outside closes it
  let openMenu = null;
  function closeMenu() { if (!openMenu) return; openMenu.el.remove(); openMenu.anchor.setAttribute('aria-expanded', 'false'); openMenu = null; }
  function dropdown(anchor, items, at = null, { search = '' } = {}) {
    if (openMenu?.anchor === anchor) return closeMenu();
    closeMenu();
    const el = document.createElement('div'); el.className = 'pop-menu'; el.setAttribute('role', 'menu');
    // a long list gets a search box: typing filters it (headings with nothing left hide too), Enter picks the first
    let find = null;
    if (search) {
      find = Object.assign(document.createElement('input'), { type: 'search', className: 'pop-search', placeholder: search, spellcheck: false });
      find.setAttribute('aria-label', search);
      el.append(find);
    }
    for (const item of items) {
      if (item === '-') { el.append(Object.assign(document.createElement('div'), { className: 'pop-sep' })); continue; }
      if (item.heading) { el.append(Object.assign(document.createElement('div'), { className: 'pop-heading', textContent: item.heading })); continue; }
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.className = item.danger ? 'danger' : '';
      b.innerHTML = `${item.avatar || (item.icon ? icon(item.icon) : '<span class="pop-gap"></span>')}<span>${escapeHtml(item.label)}${item.hint ? `<small class="pop-hint">${escapeHtml(item.hint)}</small>` : ''}</span>${item.check ? icon('check') : ''}${item.keys ? `<kbd>${escapeHtml(item.keys)}</kbd>` : ''}`;
      if (item.avatar) b.classList.add('with-avatar');
      if (item.action) b.dataset.sessionAction = item.action;
      b.onclick = () => { closeMenu(); item.run(); };
      el.append(b);
    }
    document.body.append(el);
    const r = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    const top = at ? at.y : r.bottom + 6, left = at ? at.x : r.right - w;
    el.style.top = `${Math.round(Math.max(8, Math.min(innerHeight - h - 8, top)))}px`;
    el.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - w - 8, left)))}px`;
    anchor.setAttribute('aria-expanded', 'true');
    openMenu = { el, anchor };
    if (find) {
      // it keeps its width while you type, and sits against the button (below it, or above when there is more room
      // there) so it shrinks toward the button as the list narrows instead of covering the composer
      el.style.minWidth = `${w}px`;
      const below = innerHeight - r.bottom - 14, above = r.top - 14;
      if (below >= Math.min(h, 320) || below >= above) { el.style.top = `${Math.round(r.bottom + 6)}px`; el.style.maxHeight = `${below}px`; }
      else { el.style.top = 'auto'; el.style.bottom = `${Math.round(innerHeight - r.top + 6)}px`; el.style.maxHeight = `${above}px`; }
      find.addEventListener('input', () => {
        const q = find.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        let heading = null, shown = 0;
        for (const node of el.children) {
          if (node === find) continue;
          if (node.classList.contains('pop-heading')) { heading = node; node.hidden = true; continue; }
          if (node.classList.contains('pop-sep')) { node.hidden = q.length > 0; continue; }
          const text = `${heading?.textContent || ''} ${node.textContent}`.toLowerCase();
          node.hidden = !q.every((word) => text.includes(word));
          if (!node.hidden) { shown++; if (heading) heading.hidden = false; }
        }
        el.classList.toggle('pop-empty', !shown);
      });
      find.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); [...el.querySelectorAll('button')].find((b) => !b.hidden)?.click(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); [...el.querySelectorAll('button')].find((b) => !b.hidden)?.focus(); }
      });
      find.focus({ preventScroll: true });
    } else el.querySelector('button')?.focus({ preventScroll: true });
    el.addEventListener('keydown', (e) => {
      if (e.target === find) return;
      const all = [...el.querySelectorAll('button')].filter((b) => !b.hidden), i = all.indexOf(document.activeElement);
      if (e.key === 'ArrowUp' && i === 0 && find) { e.preventDefault(); return find.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length].focus(); }
      if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); anchor.focus(); }
    });
  }
  addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.el.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu(); }, true);
  addEventListener('blur', closeMenu);
  $('session-menu').setAttribute('aria-haspopup', 'menu');
  $('session-menu').onclick = () => {
    const agent = byId.get(selectedId); if (!agent) return;
    const desk = (action, args = {}) => () => runDesktop(action, { id: agent.id, ...args });
    const forkable = ['claude', 'codex'].includes(agent.kind) || state.demo;
    dropdown($('session-menu'), [
      { label: 'Rename', icon: 'edit', run: renameAgent },
      ...sessionActions(agent).filter((item) => item !== '-' && !item.heading && /^(Snooze|Wake|Mark|Archive|Unarchive|Link|Send a message|Start a plan)/.test(item.label)),
      ...(agent.owned ? [
        ...(forkable ? [{ label: 'Fork conversation', icon: 'branch', run: forkSession, action: 'fork' }] : []),
        '-',
        { label: 'View fork tree', action: 'fork-tree', run: desk('fork-tree') },
        { label: 'Split side by side', action: 'split', keys: '⌘D', run: desk('split', { direction: 'right' }) },
        { label: 'Split top and bottom', action: 'split-down', keys: '⇧⌘D', run: desk('split', { direction: 'down' }) },
        '-',
        { label: 'Close session', danger: true, action: 'close', run: desk('close') },
      ] : []),
    ]);
  };
  document.querySelector('.canvas-link')?.addEventListener('click', (event) => { if (embedded) { event.preventDefault(); navigate('canvas'); } });
  document.querySelector('.brand').addEventListener('click', (event) => { if (embedded) { event.preventDefault(); navigate('overview'); } });
  $('project-list').addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.session-row'), agent = row && byId.get(row.dataset.agent);
    if (agent) { event.preventDefault(); dropdown(row, sessionActions(agent), { x: event.clientX, y: event.clientY }); }
  });
  $('project-list').addEventListener('contextmenu', (event) => {
    const button = event.target.closest('[data-project]');
    if (!embedded || !button || !desktop?.projects.some((p) => p.key === button.dataset.project)) return;
    event.preventDefault();
    runDesktop('project-menu', { key: button.dataset.project, x: event.clientX, y: event.clientY });
  });
  $('new-connection').onclick = addConnection;
  $('rename-agent').onclick = renameAgent;
  $('help-button').onclick = $('demo-help').onclick = showHelp;
  $('desktop-settings').onclick = () => desktopCall('settings').catch((e) => toast(e.message));
  $('open-search').onclick = openSearch;
  // arrow keys walk the visible session rows; Up from the first returns to the search box
  $('project-list').addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || event.altKey || !event.target.classList?.contains('session-row')) return;
    const rows = [...$('project-list').querySelectorAll('.session-row')].filter((row) => row.offsetParent), i = rows.indexOf(event.target);
    event.preventDefault();
    if (event.key === 'ArrowUp' && i === 0) return $('open-search').focus();
    rows[Math.max(0, Math.min(rows.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
  // the model, for Claude Code: /model sent to the session, as if typed
  $('provider-label').addEventListener('click', () => {
    const agent = byId.get(selectedId); if (!embedded || !agent?.owned || agent.kind !== 'claude') return;
    // the label shows the new model right away; the transcript confirms it (with its version) a moment later
    const pick = (model) => () => desktopCall('model', { id: agent.id, model }).then(() => {
      const name = `${model[0].toUpperCase()}${model.slice(1)}`;
      if (!agent.modelName?.startsWith(name)) { agent.modelName = name; renderMain(); }
    }).catch((e) => toast(e.message));
    loadModels('claude').then((r) => {
      if (selectedId !== agent.id) return;
      const family = (m) => m.label.split(' ')[0];
      dropdown($('provider-label'), [{ heading: 'Switch model' }, ...r.models.map((m) => ({ label: m.label, hint: m.hint, icon: agent.modelName?.startsWith(family(m)) ? 'check' : null, run: pick(m.id) }))]);
    });
  });
  // Files wait above the message, images as thumbnails and the rest as chips with their name (× removes one),
  // and go in as paths when it is sent: Claude Code and Codex read files and images from paths.
  const quotePath = (p) => (/\s/.test(p) ? `"${p}"` : p);
  // the image paths a sent prompt carried (as quotePath wrote them), taken out of its text
  function sentImages(text) {
    const images = [];
    const rest = String(text ?? '').replace(/(^|\s)(?:"((?:\/|~\/|[A-Za-z]:\\)[^"\n]+)"|((?:\/|~\/|[A-Za-z]:\\)\S+))(?=\s|$)/g, (all, lead, quoted, bare) => {
      const p = quoted || bare;
      if (!IMAGE.test(p)) return all;
      if (!images.includes(p)) images.push(p);
      return lead;
    });
    // files you attached go at the end of the prompt, after what you typed: those become chips with their name
    const files = [];
    let body = rest.replace(/[ \t]+$/gm, '');
    for (;;) {
      const m = /(^|\s)(?:"((?:\/|~\/|[A-Za-z]:\\)[^"\n]+)"|((?:\/|~\/|[A-Za-z]:\\)\S+))\s*$/.exec(body);
      const p = m && (m[2] || m[3]);
      if (!p || !/[^\\/]\.[\w]{1,8}$/.test(p) || files.length >= 20) break;
      files.unshift(p); body = body.slice(0, m.index + m[1].length).replace(/\s+$/, '');
    }
    return { text: images.length || files.length ? body : rest, images, files };
  }
  const fileChips = (files) => (files?.length ? `<div class="message-files">${files.map((p) => `<button type="button" class="attach-file" data-file="${escapeHtml(p)}" title="${escapeHtml(p)}">${icon('file')}<span>${escapeHtml(p.split(/[\\/]/).pop())}</span></button>`).join('')}</div>` : '');
  function renderAttachments() {
    const list = attachments.get(attachKey()) || [], row = $(onNew() ? 'new-attach-row' : 'attach-row');
    row.hidden = !list.length;
    row.innerHTML = list.map((p, i) => {
      const name = escapeHtml(p.split(/[\\/]/).pop()), remove = `<button type="button" class="attach-remove" data-attach-remove="${i}" aria-label="Remove ${name}">${icon('x')}</button>`;
      return IMAGE.test(p)
        ? `<figure class="attach-thumb" title="${escapeHtml(p)}"><img alt="${name}" src="/api/file/raw?${new URLSearchParams({ path: p })}">${remove}</figure>`
        : `<figure class="attach-file" title="${escapeHtml(p)}">${icon('file')}<span>${name}</span>${remove}</figure>`;
    }).join('');
    if (!onNew()) updateComposer();
  }
  for (const id of ['attach-row', 'new-attach-row']) $(id).addEventListener('click', (event) => {
    const b = event.target.closest('[data-attach-remove]'); if (!b) return;
    const list = [...(attachments.get(attachKey()) || [])]; list.splice(Number(b.dataset.attachRemove), 1);
    attachments.set(attachKey(), list); renderAttachments(); activeInput().focus();
  });
  function insertPaths(paths) { // files to send with the next message
    if (!paths?.length) return;
    const key = attachKey(), have = attachments.get(key) || [];
    attachments.set(key, [...have, ...paths.filter((p) => !have.includes(p))]);
    renderAttachments(); activeInput().focus();
  }
  $('new-attach').hidden = !embedded;
  $('new-attach').onclick = async () => insertPaths(await desktopCall('attach', { cwd: newDraft.cwd }).catch((e) => { toast(e.message); return []; }));
  $('attach-files').onclick = async () => {
    const agent = byId.get(selectedId); if (!agent?.owned) return;
    insertPaths(await desktopCall('attach', { id: agent.id }).catch((e) => { toast(e.message); return []; }));
  };
  const base64 = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
  async function saveDropped(files) {
    const out = [];
    for (const file of files) {
      if (file.size > 50 * 1024 * 1024) { toast(`${file.name} is over 50 MB.`); continue; }
      out.push((await desktopCall('save-file', { name: file.name, data: await base64(file) })).path);
    }
    return out;
  }
  // paste: files copied in Finder keep their real paths; an image (a screenshot) is saved and pasted as its path
  const pasteFiles = async (event) => {
    const data = event.clipboardData;
    if (!embedded || !data || ![...data.types].includes('Files')) return;
    event.preventDefault();
    try {
      const got = await desktopCall('paste');
      if (got.paths.length) { insertPaths(got.paths); return; }
      insertPaths(await saveDropped([...data.files]));
    } catch (e) { toast(e.message); }
  };
  $('message-input').addEventListener('paste', pasteFiles);
  $('new-input').addEventListener('paste', pasteFiles);
  // drop: files dragged onto the composer are copied where the agent can read them
  for (const target of [$('thread-view'), $('new-view')]) { // each composer sits inside its view: the view is the target
    const box = target.id === 'new-view' ? $('new-compose-wrap') : $('composer');
    target.addEventListener('dragover', (event) => { if (embedded && [...event.dataTransfer.types].includes('Files')) { event.preventDefault(); box.classList.add('dropping'); } });
    target.addEventListener('dragleave', (event) => { if (!target.contains(event.relatedTarget)) box.classList.remove('dropping'); });
    target.addEventListener('drop', async (event) => {
      box.classList.remove('dropping');
      if (!embedded || !event.dataTransfer.files.length) return;
      event.preventDefault();
      try { insertPaths(await saveDropped([...event.dataTransfer.files])); } catch (e) { toast(e.message); }
    });
  }
  $('close-search').onclick = () => closePalette();
  $('close-dialog').onclick = $('cancel-dialog').onclick = () => $('action-dialog').close();
  $('theme-toggle').onclick = () => {
    const theme = document.documentElement.dataset.theme === 'night' ? 'signal' : 'night';
    document.documentElement.dataset.theme = theme; setStorage('synapse-mode', theme); updateThemeButton(); themeFileFrame();
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
    if (event.key === 'Enter' && searchHits[searchIndex]) { event.preventDefault(); runHit(searchHits[searchIndex]); }
    if (event.key === 'Backspace' && !event.target.value && searchScope) { event.preventDefault(); setScope(searchScope.kind === 'project' ? { kind: 'projects', label: 'Projects' } : null); }
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
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog === $('search-dialog') ? closePalette() : dialog.close();
  });
  // Escape folds the palette back; closed some other way, it is simply closed
  $('search-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closePalette(); });
  $('search-dialog').addEventListener('close', () => { paletteState = 'closed'; $('search-dialog').classList.remove('shown', 'folding'); });
  addEventListener('resize', () => fitPalette());
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.createWorktree) return runDesktop('worktree', { key: button.dataset.createWorktree });
    if (button.dataset.newSessionCwd) return connectAgent(button.dataset.newSessionCwd);
    if (button.dataset.agent) return navigate('session', button.dataset.agent);
    if (button.dataset.view) return navigate(button.dataset.view);
    if (button.dataset.searchIndex) { const hit = searchHits[Number(button.dataset.searchIndex)]; if (hit) return runHit(hit); }
    if (button.dataset.project) {
      const key = button.dataset.project; collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
      // folding the one under the pointer: it stays folded until the pointer leaves, then hover unfolds it again
      const section = button.closest('.project-group');
      if (section && collapsed.has(key)) { section.classList.add('hover-off'); section.addEventListener('pointerleave', () => section.classList.remove('hover-off'), { once: true }); }
      setStorage('synapse-collapsed', JSON.stringify([...collapsed])); renderSidebar(); return;
    }
    if (button.dataset.approvalKey) return answerApproval(button.dataset.approvalKey);
    if (button.dataset.approvalNav !== undefined) return answerApproval(null, { nav: Number(button.dataset.approvalNav) });
    if (button.dataset.git) return gitAction(button.dataset.git);
    if (button.dataset.changeFile) { const agent = byId.get(selectedId); return openFile(button.dataset.changeFile, agent?.cwd); }
    if (button.id === 'changes-chip' || button.id === 'branch-pill') { inspectorOpen = true; setStorage('synapse-inspector', 'open'); inspectorFile = null; inspectorSignature = ''; syncInspector(); return; }
    if (button.dataset.workToggle) {
      const key = button.dataset.workToggle, open = !openFolds.has(key);
      open ? openFolds.add(key) : openFolds.delete(key);
      button.setAttribute('aria-expanded', String(open)); button.nextElementSibling.hidden = !open; return;
    }
    if (button.dataset.shareOpen) { const agent = byId.get(selectedId); friendPreset = { who: null, agent: agent ? mineId(agent.id) : null }; return addConnection(button.dataset.shareOpen); }
    if (button.dataset.person) return personMenu(button);
    if (button.dataset.personAdd) return trustSomeone();
    if (button.id === 'group-by') return groupMenu();
    if (button.dataset.foldToggle) {
      const key = `${button.dataset.foldToggle}:closed`;
      const opening = collapsed.delete(key); if (!opening) collapsed.add(key);
      setStorage('synapse-collapsed', JSON.stringify([...collapsed]));
      foldingNow = true; try { renderSidebar(); } finally { foldingNow = false; }
      // the opened list fades in where it is
      const list = button.closest('.flat-group, .people-group')?.querySelector('.flat-list, .people-list');
      if (opening && list && !matchMedia('(prefers-reduced-motion: reduce)').matches) list.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
      return;
    }
    if (button.dataset.settledToggle) {
      const key = `${button.dataset.settledToggle === '1' ? 'settled' : button.dataset.settledToggle}:open`;
      const opening = !collapsed.delete(key); if (opening) collapsed.add(key);
      setStorage('synapse-collapsed', JSON.stringify([...collapsed]));
      foldingNow = true; try { renderSidebar(); } finally { foldingNow = false; }
      const list = button.closest('.settled-group')?.querySelector('.settled-list');
      if (opening && list && !matchMedia('(prefers-reduced-motion: reduce)').matches) list.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
      return;
    }
    if (button.dataset.worktreeToggle) {
      const key = button.dataset.worktreeToggle; collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
      setStorage('synapse-collapsed', JSON.stringify([...collapsed])); renderSidebar(); return;
    }
    if (button.dataset.filter) { filter = button.dataset.filter; renderOverview(); return; }
    if (button.dataset.tab) { persistDraft(); tab = button.dataset.tab; renderMain(true); if (tab === 'terminal') syncDocks('main'); return; }
    if (button.dataset.removeLinks) return removeLinks(button.dataset.removeLinks.split(','), button);
    if (button.dataset.connTab) { connectionMode = button.dataset.connTab; return addConnection(); }
    if (button.dataset.friendAccept) return answerFriend(button, 'accept');
    if (button.dataset.friendDeny) return answerFriend(button, 'deny');
    if (button.dataset.friendCancel) return answerFriend(button, 'cancel');
    if (button.hasAttribute('data-copy-code')) { if (await copyText(button.closest('.code-block').querySelector('code').textContent)) { button.textContent = 'Copied'; setTimeout(() => { if (button.isConnected) button.textContent = 'Copy code'; }, 2000); } return; }
    if (button.hasAttribute('data-copy-message')) { const message = renderedMessages.get(button.closest('[data-message-key]').dataset.messageKey); if (message && await copyText(message.text)) { button.innerHTML = icon('check'); setTimeout(() => { button.innerHTML = icon('copy'); }, 1200); } return; } // the button itself says it worked
    const action = button.dataset.action;
    if (action === 'connect') connectAgent();
    if (action === 'show-terminal') { persistDraft(); tab = 'terminal'; renderMain(true); syncDocks('main'); }
    if (action === 'add-connection') addConnection();
    if (action === 'friend-connection') addConnection('share');
    if (action === 'friends-sign-in') { if ($('action-dialog').open) $('action-dialog').close(); desktopCall('sign-in').catch((e) => toast(e.message)); }
    if (action === 'panel-full') { setPanelFull(!panelFull); return; }
    if (action === 'close-inspector') { inspectorOpen = false; setStorage('synapse-inspector', 'closed'); syncInspector(); $('context-toggle').focus(); }
    if (action === 'show-messages') { persistDraft(); tab = 'messages'; renderMain(true); }
    if (action === 'show-all') { filter = 'all'; renderOverview(); }
    if (action === 'retry-conversation') loadRecent(true);
    if (action === 'load-older') loadOlder();
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
    if (embedded && ((event.ctrlKey && !event.metaKey && key === 'tab') || (mod && key === 'g'))) { event.preventDefault(); return; }
    if (embedded && event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && /^[1-9]$/.test(key)) {
      const kind = Object.keys(desktop?.profiles || {}).filter((k) => k !== 'shell')[Number(key) - 1];
      const cwd = byId.get(selectedId)?.cwd || desktop?.projects[0]?.worktrees[0]?.path;
      if (kind && cwd) { event.preventDefault(); runDesktop('new-session', { cwd, kind }); } return;
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && ['w', 's'].includes(key) && !paneKey) { event.preventDefault(); moveSelection(key === 'w' ? -1 : 1); return; }
    if (embedded && (event.metaKey || event.ctrlKey)) {
      if (key === 'n') { event.preventDefault(); if (event.shiftKey) runDesktop('worktree', { key: byId.get(selectedId)?.projectKey || desktop?.projects[0]?.key }); else connectAgent(); return; }
      if (key === 't') { event.preventDefault(); showNew(null, 'shell'); return; }
      if (key === ',') { event.preventDefault(); runDesktop('settings'); return; }
      if (key === 'j') { event.preventDefault(); toggleDrawer(); return; }
      if (key === 'b') { event.preventDefault(); setSidebar(!sidebarOpen); return; }
      if (key === 'd') { event.preventDefault(); runDesktop('split', { id: selectedId, direction: event.shiftKey ? 'down' : 'right' }); return; }
      if (key === 'e') { event.preventDefault(); runDesktop('fork-tree', { id: selectedId }); return; }
      if (key === 'w') { event.preventDefault(); runDesktop('close', { id: selectedId }); return; }
      if (/^[1-9\[\]]$/.test(key)) { event.preventDefault(); runDesktop('switch-session', { key }); return; }
      if (key === 'f' && event.shiftKey) { event.preventDefault(); forkSession(); return; }
    }
    if (event.metaKey && !event.shiftKey && !event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key) && !editing && !paneKey) {
      event.preventDefault(); $(event.key === 'ArrowLeft' ? 'nav-back' : 'nav-forward').click(); return;
    }
    if ((event.metaKey || event.ctrlKey) && ['k', 'f'].includes(event.key.toLowerCase())) { event.preventDefault(); paletteState === 'open' ? closePalette() : openSearch(); return; }
    if (event.key === '/' && !editing && !$('action-dialog').open && !$('search-dialog').open) { event.preventDefault(); openSearch(); }
    if (event.key === 'Escape' && !$('action-dialog').open && !$('search-dialog').open) {
      if (view === 'activity' || view === 'canvas') navigate(byId.has(selectedId) ? 'session' : 'overview', selectedId);
      else if (narrow.matches && sidebarOpen) { setSidebar(false, false); $('sidebar-toggle').focus(); }
      else if (inspectorOpen) { inspectorOpen = false; syncInspector(); $('context-toggle').focus(); }
    }
    if (event.target.matches('[role="tab"]') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); persistDraft();
      const tabs = ['conversation', 'messages', 'terminal'].filter((name) => !$(`${name}-tab`).hidden);
      tab = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; renderMain(true); $(`${tab}-tab`).focus();
    }
    if (event.key === 'Tab' && narrow.matches && sidebarOpen) {
      const items = [...$('sidebar').querySelectorAll('button, a')].filter((element) => !element.disabled && element.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  addEventListener('popstate', (event) => {
    if (Number.isInteger(event.state?.pos)) { navPos = event.state.pos; syncNavArrows(); }
    // a session closed since: show the overview in its place
    if (event.state?.view === 'session' && !byId.has(event.state.id)) return navigate('overview', null, false);
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
  // the live work line's clock
  setInterval(() => { for (const el of document.querySelectorAll('.work-fold.live .work-time[data-since]')) { const since = Number(el.dataset.since); el.textContent = since ? duration(Math.max(0, Date.now() - since)) : ''; } }, 1000);
  // docked terminals follow the page every frame (a sidebar sliding, a window resizing); only changes are sent
  if (embedded && !paneKey) { const follow = () => { syncDocks(); requestAnimationFrame(follow); }; requestAnimationFrame(follow); }
  // panels slide only once the first layout is drawn (a reload restores them in place)
  setTimeout(() => $('workspace').classList.add('panels-ready'), 600);
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
        const keys = ['synapse-mode', 'synapse-selected', 'synapse-sidebar', 'synapse-inspector', 'synapse-drafts', 'synapse-collapsed', 'synapse-group', 'synapse-snoozed', 'synapse-done', 'synapse-archived', 'synapse-tidy', 'synapse-kept', 'synapse-queue', 'synapse-update-later', 'synapse-settled', 'synapse-inspector-tab', 'synapse-panel-width'];
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
