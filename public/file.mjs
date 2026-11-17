// The file viewer and editor the desktop app opens beside a terminal when a path in it is ⌘-clicked.
// /file?path=src/x.ts:12&cwd=/repo&theme=night&wide=1. Text files edit in place and save themselves a moment after
// typing stops (⌘S saves now); a change an agent makes meanwhile is never overwritten without asking.
// Links inside (folders) navigate this page, so Back is history.
import { escapeHtml, renderMarkdown } from './workspace.mjs';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const target = q.get('path') || '', cwd = q.get('cwd') || '';
const setTheme = (t) => { if (['night', 'signal'].includes(t)) document.documentElement.dataset.theme = t; };
setTheme(q.get('theme'));
let wide = q.get('wide') === '1';
const embed = q.get('embed') === '1'; // inside the GUI's side panel: it has its own name, Finder and close buttons
document.documentElement.classList.toggle('embed', embed);
addEventListener('message', (ev) => {
  if (ev.source !== parent) return;
  if (ev.data?.type === 'synapse:theme') setTheme(ev.data.theme);
  if (ev.data?.type === 'synapse:file-wide') { wide = !!ev.data.wide; drawBar(); }
});

const FINDER = /Windows/.test(navigator.userAgent) ? 'Explorer' : /Mac/.test(navigator.userAgent) ? 'Finder' : 'the file manager';
const size = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const here = (path) => `/file?${new URLSearchParams({ path, cwd, theme: document.documentElement.dataset.theme, ...(wide ? { wide: '1' } : {}) })}`;
const api = (url, init) => fetch(url, init).then(async (r) => { const v = await r.json().catch(() => ({})); if (!r.ok) throw new Error(v.error || r.statusText); return v; });
const load = (path, base = cwd) => api(`/api/file?${new URLSearchParams({ path, cwd: base })}`).catch((error) => ({ error: error.message }));

const lm = target.match(/(?::(\d+)(?:-(\d+))?(?::\d+)?|#L(\d+)(?:-L?(\d+))?)$/);
const from = lm ? +(lm[1] || lm[3]) : 0, to = lm ? +(lm[2] || lm[4] || from) : 0;

let f = await load(target);
let text = f.text ?? '', mtime = f.mtime || 0, mode = '', state = '', warn = false;
let dirty = false, conflict = false, saving = null, timer = 0;
const isText = () => f.type === 'text', isMd = () => isText() && /^(md|markdown|mdx)$/.test(f.ext);
mode = ['edit', 'preview'].includes(q.get('mode')) && isMd() ? q.get('mode') : isMd() && !from ? 'preview' : 'edit';

function facts() {
  warn = false;
  if (f.error) return '';
  const n = isText() ? `${text.split('\n').length} lines` : f.type === 'dir' ? `${f.entries.length} items` : size(f.size);
  return [n, `edited ${ago(f.mtime)}`, f.truncated && 'first 1 MB, read only'].filter(Boolean).join(' · ');
}

function drawBar() {
  const back = !embed && document.referrer.startsWith(`${location.origin}/file`);
  const name = f.error ? target.split('/').pop() || target : f.name + (f.type === 'dir' ? '/' : '');
  $('bar').innerHTML = `${back ? '<button data-act="back" title="Back">←</button>' : ''}`
    + (embed ? (dirty ? '<span class="dot">●</span>' : '') : `<button class="name" data-act="copy" title="${escapeHtml(f.path || target)}  ·  click to copy the path">${escapeHtml(name)}${dirty ? ' ●' : ''}</button>`)
    + `<span class="state${warn ? ' warn' : ''}">${escapeHtml(state)}</span>`
    + (conflict ? '<button data-act="reload" title="Load the version on disk, dropping your edits">Reload</button><button data-act="overwrite" title="Save your version over it">Keep mine</button>' : '')
    + (isText() ? '<button data-act="smaller" title="Smaller text  ⌘−">A−</button><button data-act="bigger" title="Bigger text  ⌘+">A+</button>' : '')
    + (isMd() ? `<button data-act="mode" title="${mode === 'edit' ? 'Show it formatted (you can edit there too)' : 'Edit the markdown source'}">${mode === 'edit' ? 'Preview' : 'Source'}</button>` : '')
    + (pdf.tools ? Object.keys(PDF_TOOLS).map((t) => `<button data-tool="${t}" aria-pressed="${pdf.tool === t}" title="${PDF_TOOLS[t].title}">${t}</button>`).join('') : '')
    + (f.error || embed ? '' : `<button data-act="reveal" title="Show it in ${FINDER}">${FINDER === 'Finder' ? 'Finder' : 'Folder'}</button><button data-act="open" title="Open in its own app">Open ↗</button>`)
    + (embed ? '' : `<button data-act="wide" title="${wide ? 'Back beside the terminal' : 'Fill the window'}">${wide ? '⇥' : '⇤'}</button>`
    + '<button data-act="close" title="Close  esc">✕</button>');
}

function draw() {
  const main = $('main'), raw = `/api/file/raw?${new URLSearchParams({ path: f.path || '' })}`;
  main.className = '';
  document.title = f.name || target;
  if (f.error) main.innerHTML = `<p class="note">Synapse can't open this file: ${escapeHtml(f.error)}</p>`;
  else if (f.type === 'dir') main.innerHTML = `<div class="dir">${f.entries.map((e) => `<a class="file-link" href="${escapeHtml(here(`${f.path}/${e.name}`))}">${escapeHtml(e.name)}${e.dir ? '/' : ''}</a>`).join('') || '<p class="note">Empty folder.</p>'}</div>`;
  else if (f.type === 'image') main.innerHTML = `<div class="media"><img src="${raw}" alt="${escapeHtml(f.name)}"></div>`;
  else if (f.type === 'video' || f.type === 'audio') main.innerHTML = `<div class="media"><${f.type} src="${raw}" controls></${f.type}></div>`;
  else if (f.type === 'pdf') mountPdf(raw);
  else if (f.type === 'binary') main.innerHTML = '<p class="note">Binary file. Open it in its own app instead.</p>';
  else if (mode === 'preview') mountPreview();
  else { main.className = 'full'; mountEditor(); }
  drawBar(); drawComments();
}

// ---- The preview edits in place. The markdown is cut into blocks (a heading, a paragraph, a list, a fence...);
// each shows as a box of its own, and only a box you change is written back as markdown, so the rest of the file
// stays exactly as it was. ⌘B / ⌘I / ⌘U format, ⌘⌥1-3 make a heading, ⌘⌥0 a paragraph.
let blocks = [], lead = '';
function splitBlocks(src) {
  const lines = src.split('\n'), out = [];
  const fence = (l) => /^\s*```/.test(l), blank = (l) => !l.trim(), single = (l) => /^#{1,6}\s/.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  let i = 0;
  while (i < lines.length) {
    if (blank(lines[i])) { i++; continue; }
    const a = i;
    if (fence(lines[i])) { i++; while (i < lines.length && !fence(lines[i])) i++; }
    else if (!single(lines[i])) while (i + 1 < lines.length && !blank(lines[i + 1]) && !fence(lines[i + 1]) && !single(lines[i + 1])) i++;
    out.push({ a, b: i, kind: fence(lines[a]) ? 'fence' : /^#{1,6}\s/.test(lines[a]) ? 'heading' : 'text' });
    i++;
  }
  lead = lines.slice(0, out[0]?.a ?? lines.length).map((l) => `${l}\n`).join('');
  if (!out.length) lead = src;
  return out.map((x, k) => {
    const next = out[k + 1];
    const gap = next ? `\n${lines.slice(x.b + 1, next.a).map((l) => `${l}\n`).join('')}` : lines.slice(x.b + 1).map((l) => `\n${l}`).join('');
    return { ...x, text: lines.slice(x.a, x.b + 1).join('\n'), gap, last: !next };
  });
}
const inlineHtml = (md) => renderMarkdown(md).replace(/^<p>([\s\S]*)<\/p>$/, '$1');
function blockHtml(b) {
  if (b.kind === 'heading') { const m = b.text.match(/^(#{1,6})\s+(.*)$/); return `<h${m[1].length}>${inlineHtml(m[2])}</h${m[1].length}>`; }
  return renderMarkdown(b.text);
}
function mountPreview() {
  blocks = splitBlocks(text);
  $('main').innerHTML = `<div class="md md-view" contenteditable="${f.truncated ? 'false' : 'true'}" spellcheck="true">${blocks.map((b, i) => `<div class="mdb" data-b="${i}"${b.kind === 'fence' ? ' contenteditable="false"' : ''}>${blockHtml(b)}</div>`).join('')}</div>`;
  const view = $('main').firstChild;
  for (const el of view.children) blocks[+el.dataset.b].html = el.innerHTML;
  view.addEventListener('input', () => { const next = fromPreview(view); if (next !== text) { text = next; edited(); } });
  view.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });
}
// the preview back to markdown: boxes as they were keep their own text, changed ones are written out
function fromPreview(view) {
  const parts = [];
  for (const node of view.childNodes) {
    const b = node.nodeType === 1 && node.dataset.b != null ? blocks[+node.dataset.b] : null;
    if (b && node.innerHTML === b.html) { parts.push({ md: b.text, gap: b.gap, last: b.last }); continue; }
    const md = (node.nodeType === 1 && node.classList.contains('mdb') ? blocksMd(node.childNodes) : blocksMd([node])).replace(/^\n+|\s+$/g, '');
    if (md) parts.push({ md, gap: b && !b.last ? b.gap : '\n\n', last: false });
  }
  const end = blocks.at(-1)?.gap ?? (text.endsWith('\n') ? '\n' : '');
  return (blocks.length ? lead : '') + parts.map((p, i) => p.md + (i === parts.length - 1 ? end : p.last ? '\n\n' : p.gap)).join('');
}
const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE']);
const around = (mark, s) => { if (!s.trim()) return s; const a = s.match(/^\s*/)[0], z = s.match(/\s*$/)[0]; return `${a}${mark}${s.trim()}${mark}${z}`; };
const inl = (n) => [...n.childNodes].map(inlineMd).join('');
function inlineMd(n) {
  if (n.nodeType === 3) return n.data.replace(/\u00a0/g, ' ');
  if (n.nodeType !== 1) return '';
  const t = n.tagName;
  if (t === 'STRONG' || t === 'B') return around('**', inl(n));
  if (t === 'EM' || t === 'I') return around('*', inl(n));
  if (t === 'U') return n.textContent.trim() ? `<u>${inl(n)}</u>` : inl(n);
  if (t === 'S' || t === 'STRIKE' || t === 'DEL') return around('~~', inl(n));
  if (t === 'CODE') return `\`${n.textContent}\``;
  if (t === 'BR') return '\n';
  if (t === 'A') return /^https?:/.test(n.getAttribute('href') || '') && n.textContent !== n.getAttribute('href') ? `[${inl(n)}](${n.getAttribute('href')})` : inl(n);
  if (t === 'SPAN' && n.title && !n.classList.contains('mention')) return `[${inl(n)}](${n.title})`;
  if (t === 'IMG') return `![${n.alt || ''}](${n.getAttribute('src')})`;
  if (BLOCK.has(t)) return `\n${blockMd(n)}\n`;
  return inl(n);
}
function blocksMd(nodes) {
  const out = []; let run = '';
  const flush = () => { if (run.trim()) out.push(run.replace(/^\n+|\n+$/g, '')); run = ''; };
  for (const n of nodes) {
    if (n.nodeType === 1 && BLOCK.has(n.tagName)) { flush(); const md = blockMd(n); if (md.trim()) out.push(md); }
    else run += inlineMd(n);
  }
  flush();
  return out.join('\n\n');
}
function listMd(n, depth = 0) {
  const ordered = n.tagName === 'OL', pad = '  '.repeat(depth);
  return [...n.children].filter((li) => li.tagName === 'LI').map((li, i) => {
    const own = [...li.childNodes].filter((c) => !(c.nodeType === 1 && /^(UL|OL)$/.test(c.tagName)));
    const nested = [...li.children].filter((c) => /^(UL|OL)$/.test(c.tagName)).map((c) => `\n${listMd(c, depth + 1)}`).join('');
    return `${pad}${ordered ? `${i + 1}.` : '-'} ${own.map(inlineMd).join('').trim().replace(/\n/g, ' ')}${nested}`;
  }).join('\n');
}
function blockMd(n) {
  const t = n.tagName;
  if (/^H[1-6]$/.test(t)) return `${'#'.repeat(+t[1])} ${inl(n).replace(/\s*\n\s*/g, ' ').trim()}`;
  if (t === 'UL' || t === 'OL') return listMd(n);
  if (t === 'BLOCKQUOTE') return blocksMd(n.childNodes).split('\n').map((l) => `> ${l}`).join('\n');
  if (t === 'HR') return '---';
  if (t === 'PRE') return `\`\`\`\n${n.textContent.replace(/\n$/, '')}\n\`\`\``;
  if (t === 'TABLE') {
    const rows = [...n.querySelectorAll('tr')].map((r) => [...r.children].map((c) => inl(c).replace(/\n/g, ' ').replace(/\|/g, '\\|').trim()));
    if (!rows.length) return '';
    return [rows[0], rows[0].map(() => '---'), ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n');
  }
  if (t === 'DIV' && n.classList.contains('code-block')) return `\`\`\`${n.querySelector('.code-label span')?.textContent || ''}\n${n.querySelector('code')?.textContent || ''}\n\`\`\``;
  if (t === 'DIV' && n.classList.contains('md-table')) return blockMd(n.querySelector('table'));
  return blocksMd(n.childNodes);
}
// ⌘B / ⌘I / ⌘U in the source: wrap the selection in markdown (again to unwrap)
function wrapSelection(ta, open, close = open) {
  const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e);
  const has = ta.value.slice(s - open.length, s) === open && ta.value.slice(e, e + close.length) === close;
  if (has) { ta.setSelectionRange(s - open.length, e + close.length); document.execCommand('insertText', false, sel); ta.setSelectionRange(s - open.length, e - open.length); }
  else { document.execCommand('insertText', false, open + sel + close); ta.setSelectionRange(s + open.length, e + open.length); }
}

// ---- Text size: A− / A+ and ⌘− / ⌘+ / ⌘0, kept for every file
let zoom = Math.min(2.5, Math.max(0.6, +localStorage.getItem('synapse-file-zoom') || 1));
const applyZoom = () => document.documentElement.style.setProperty('--file-zoom', String(zoom));
function setZoom(z) { zoom = Math.round(Math.min(2.5, Math.max(0.6, z)) * 100) / 100; localStorage.setItem('synapse-file-zoom', String(zoom)); applyZoom(); state = `text ${Math.round(zoom * 100)}%`; warn = false; drawBar(); }
applyZoom();

// ---- Comments: select something, comment on it, then send it to the agent now (↑) or collect a few and send them
// all at once. They are kept per file until sent.
const commentKey = () => `synapse-comments:${f.path || target}`;
let comments = (() => { try { return JSON.parse(localStorage.getItem(commentKey())) || []; } catch { return []; } })();
let commentsOpen = true, pick = null; // pick: the selection being commented on
const saveComments = () => localStorage.setItem(commentKey(), JSON.stringify(comments));
const relPath = () => { const p = f.path || target, root = cwd.replace(/\/+$/, ''); return root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p; };
const where = (c) => c.line ? (c.end && c.end !== c.line ? `lines ${c.line}-${c.end}` : `line ${c.line}`) : '';
function commentText(list) {
  const one = (c) => `${[where(c), c.quote && `on "${c.quote.length > 160 ? `${c.quote.slice(0, 160)}…` : c.quote}"`].filter(Boolean).join(', ')}${c.line || c.quote ? ': ' : ''}${c.text}`;
  return list.length === 1 ? `Comment on ${relPath()}, ${one(list[0])}` : `Comments on ${relPath()}:\n${list.map((c) => `- ${one(c)}`).join('\n')}`;
}
let sending = null;
function sendComments(list) {
  if (!list.length || sending) return;
  if (parent === window) { state = 'open this file from an agent to send comments'; warn = true; drawBar(); return; }
  sending = list.map((c) => c.id);
  parent.postMessage({ type: 'synapse:file-comments', text: commentText(list) }, '*');
  setTimeout(() => { if (sending) { sending = null; state = 'no agent took the comments'; warn = true; drawBar(); } }, 8000);
}
addEventListener('message', (ev) => {
  if (ev.source !== parent || ev.data?.type !== 'synapse:file-comments-result' || !sending) return;
  if (ev.data.ok) { comments = comments.filter((c) => !sending.includes(c.id)); saveComments(); state = 'sent to the agent'; warn = false; }
  else { state = `not sent: ${ev.data.error || 'the agent did not take it'}`; warn = true; }
  sending = null; drawBar(); drawComments();
});
function drawComments() {
  let box = $('comments');
  if (!box) { box = document.createElement('section'); box.id = 'comments'; box.className = 'comments'; document.body.append(box); }
  box.hidden = !comments.length;
  if (!comments.length) return;
  box.innerHTML = `<header><button data-act="fold" class="fold" aria-expanded="${commentsOpen}">${commentsOpen ? '▾' : '▸'} Comments <span>${comments.length}</span></button><button data-act="send-all" class="send-all" title="Send every comment to the agent in one message">Send all ↑</button></header>`
    + (commentsOpen ? `<ol>${comments.map((c) => `<li data-c="${c.id}"><div class="c-body">${c.line || c.quote ? `<p class="c-where">${escapeHtml(where(c))}${c.quote ? ` <q>${escapeHtml(c.quote.length > 90 ? `${c.quote.slice(0, 90)}…` : c.quote)}</q>` : ''}</p>` : ''}<p class="c-text">${escapeHtml(c.text)}</p></div><button data-act="send-one" title="Send this comment to the agent">↑</button><button data-act="drop" title="Delete">✕</button></li>`).join('')}</ol>` : '');
}
// where the selection is: its text, and its lines in the file
function selection() {
  const ta = $('main').querySelector('textarea');
  if (ta && document.activeElement === ta) {
    const a = ta.selectionStart, b = ta.selectionEnd; if (a === b) return null;
    return { quote: ta.value.slice(a, b).trim(), line: ta.value.slice(0, a).split('\n').length, end: ta.value.slice(0, b).split('\n').length };
  }
  const sel = getSelection(); if (!sel.rangeCount || sel.isCollapsed || !$('main').contains(sel.anchorNode)) return null;
  const quote = sel.toString().trim(); if (!quote) return null;
  const boxOf = (n) => (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('.mdb');
  const a = blocks[+boxOf(sel.anchorNode)?.dataset.b], b = blocks[+boxOf(sel.focusNode)?.dataset.b];
  const first = quote.split('\n')[0].trim(), at = text.indexOf(first);
  const line = a ? a.a + 1 + Math.max(0, a.text.split('\n').findIndex((l) => first && l.includes(first.slice(0, 40)))) : at >= 0 ? text.slice(0, at).split('\n').length : 0;
  return { quote, line, end: b && b !== a ? Math.max(line, b.b + 1) : line };
}
const chip = Object.assign(document.createElement('button'), { className: 'comment-chip', textContent: '💬 Comment', hidden: true, title: 'Comment on this for the agent  ⌘⌥M' });
chip.dataset.act = 'comment';
document.body.append(chip);
addEventListener('mouseup', (e) => setTimeout(() => {
  if (e.target.closest('.comments, .comment-pop, .comment-chip, .bar')) return;
  const s = selection();
  chip.hidden = !s || !isText();
  if (s) Object.assign(chip.style, { left: `${Math.min(innerWidth - 120, e.clientX + 8)}px`, top: `${Math.min(innerHeight - 40, e.clientY + 12)}px` });
}));
addEventListener('mousedown', (e) => { if (!e.target.closest('.comment-chip')) chip.hidden = true; });
function openComment(s = selection()) {
  pick = s || { quote: '', line: 0 };
  chip.hidden = true;
  document.querySelector('.comment-pop')?.remove();
  const pop = document.createElement('form'); pop.className = 'comment-pop';
  pop.innerHTML = `${pick.quote ? `<q>${escapeHtml(pick.quote.length > 120 ? `${pick.quote.slice(0, 120)}…` : pick.quote)}</q>` : '<q>The whole file</q>'}<textarea rows="3" placeholder="Comment for the agent…" aria-label="Comment"></textarea><div><button type="button" data-act="cancel-comment">Cancel</button><button type="submit" value="add" title="Collect it, send later  Enter">Add</button><button type="submit" value="send" class="primary" title="Send it to the agent now  ⌘Enter">Send ↑</button></div>`;
  document.body.append(pop);
  const ta = pop.querySelector('textarea'); ta.focus();
  const finish = (now) => {
    const body = ta.value.trim(); if (!body) return;
    const c = { id: Math.random().toString(36).slice(2, 10), ...pick, text: body, at: Date.now() };
    comments.push(c); saveComments(); pop.remove(); commentsOpen = true; drawComments();
    if (now) sendComments([c]);
  };
  pop.addEventListener('submit', (e) => { e.preventDefault(); finish(e.submitter?.value === 'send'); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pop.remove(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(e.metaKey || e.ctrlKey); }
  });
}

// pdfs draw with pdf.js: just the pages, fit to the pane's width (⌘+ / ⌘- or pinch to zoom). Edit retypes the pdf's own
// text; Highlight, Draw and Text add annotations. All of it, and filled-in form fields, saves into the pdf itself.
const PDF_TOOLS = { Edit: { title: "Click the pdf's text to change it" }, Highlight: { type: 'HIGHLIGHT', title: 'Select text to highlight it' }, Draw: { type: 'INK', title: 'Draw on the page' }, Text: { type: 'FREETEXT', title: 'Click to add text' } };
const pdf = { lib: null, viewer: null, doc: null, tool: '', tools: false, zoomed: false };
async function mountPdf(raw) {
  const main = $('main');
  main.className = 'full';
  main.innerHTML = '<div class="pdf-scroll" id="pdf-scroll"><div class="pdfViewer"></div></div>';
  try {
    pdf.lib ||= await import('/pdfjs/build/pdf.mjs');
    globalThis.pdfjsLib = pdf.lib; // pdf_viewer.mjs reads the library from here
    pdf.lib.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';
    const { EventBus, PDFViewer, PDFLinkService } = await import('/pdfjs/web/pdf_viewer.mjs');
    const lib = pdf.lib, eventBus = new EventBus(), linkService = new PDFLinkService({ eventBus });
    pdf.viewer = new PDFViewer({
      container: $('pdf-scroll'), eventBus, linkService, textLayerMode: 1,
      annotationMode: lib.AnnotationMode.ENABLE_FORMS, annotationEditorMode: lib.AnnotationEditorType.NONE,
      annotationEditorHighlightColors: 'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F',
    });
    linkService.setViewer(pdf.viewer);
    pdf.doc = await lib.getDocument({ url: `${raw}&v=${mtime}`, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/', iccUrl: '/pdfjs/iccs/' }).promise;
    eventBus.on('pagesinit', () => { pdf.viewer.currentScaleValue = 'page-width'; });
    pdf.viewer.setDocument(pdf.doc); linkService.setDocument(pdf.doc);
    pdf.doc.annotationStorage.onSetModified = () => { pdf.doc.annotationStorage.resetModified(); edited(); };
    eventBus.on('pagerendered', ({ pageNumber }) => drawEdits(pageNumber)); // a zoom clears the page's own layers
    $('pdf-scroll').addEventListener('click', (e) => { if (pdf.tool === 'Edit' && !e.target.closest('.pdf-edit')) editAt(e); });
    pdf.tools = true; pdf.tool = ''; pdf.zoomed = false;
    drawBar();
  } catch (error) {
    main.className = '';
    main.innerHTML = `<p class="note">Synapse can't show this pdf: ${escapeHtml(error.message)}</p>`;
  }
}
function pdfTool(name) {
  pdf.tool = pdf.tool === name ? '' : name;
  const { AnnotationEditorType } = pdf.lib;
  pdf.viewer.annotationEditorMode = { mode: PDF_TOOLS[pdf.tool]?.type ? AnnotationEditorType[PDF_TOOLS[pdf.tool].type] : AnnotationEditorType.NONE };
  $('pdf-scroll').classList.toggle('editing', pdf.tool === 'Edit');
  drawBar();
}

// Edit: a click on a run of the pdf's text puts it in a box to retype. When the pdf saves, the old words are covered
// in the page's own colour and the new ones written over them in the closest standard font (the old text is still
// underneath, so search and copy can find it). Keyed by page and run, so saving again redoes the same edits.
const edits = new Map(), runs = new Map();
async function editAt(e) {
  const div = e.target.closest('.page'), n = +div?.dataset.pageNumber;
  if (!n) return;
  const view = pdf.viewer.getPageView(n - 1), box = div.getBoundingClientRect();
  const [px, py] = view.viewport.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top);
  if (!runs.has(n)) runs.set(n, view.pdfPage.getTextContent());
  const { items, styles } = await runs.get(n);
  // the last run drawn there is the one on top (an earlier edit covers its original)
  const i = items.findLastIndex((t) => {
    const [a, b, c, d, x, y] = t.transform || [];
    return t.str?.trim() && !b && !c && a > 0 && d > 0 && px >= x && px <= x + t.width && py >= y - d * 0.25 && py <= y + d * 0.95;
  });
  if (i < 0) return;
  const key = `${n}:${i}`;
  if (!edits.has(key)) {
    const t = items[i], [, , , d, x, y] = t.transform, rect = [x - 0.5, y - d * 0.25, x + t.width + 0.5, y + d * 0.95];
    let name = '';
    try { name = view.pdfPage.commonObjs.get(t.fontName)?.name || ''; } catch {}
    const generic = styles[t.fontName]?.fontFamily;
    const family = /courier|mono|consol|menlo/i.test(name) || generic === 'monospace' ? 'Courier'
      : /sans|arial|helvet|grotesk|inter|roboto|calibri|verdana/i.test(name) ? 'Helvetica'
      : /times|serif|roman|georgia|garamond|cambria|minion|palatino/i.test(name) || generic === 'serif' ? 'Times' : 'Helvetica';
    edits.set(key, { page: n, rect, x, y, size: d, family, bold: /bold|black|heavy|semibold/i.test(name), italic: /italic|oblique/i.test(name), ...inks(view, rect), was: t.str, text: t.str });
  }
  drawEdits(n);
  const el = view.div.querySelector(`.pdf-edit[data-key="${key}"]`);
  el.focus();
  const at = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (at && el.contains(at.startContainer)) getSelection().setBaseAndExtent(at.startContainer, at.startOffset, at.startContainer, at.startOffset);
}
// the page's colour and the text's, read off the drawn page: the commonest colour in the run's box, and the one
// furthest from it
function inks(view, rect) {
  try {
    const c = view.canvas, k = c.width / view.viewport.width, [x1, y1, x2, y2] = vrect(view, rect);
    const px = c.getContext('2d').getImageData(Math.min(x1, x2) * k, Math.min(y1, y2) * k, Math.max(1, Math.abs(x2 - x1) * k), Math.max(1, Math.abs(y2 - y1) * k)).data;
    const seen = new Map();
    for (let j = 0; j < px.length; j += 4) { const q = (px[j] >> 4) << 8 | (px[j + 1] >> 4) << 4 | px[j + 2] >> 4; seen.set(q, (seen.get(q) || 0) + 1); }
    const top = [...seen].sort((a, b) => b[1] - a[1])[0][0], bg = [(top >> 8 & 15) * 17, (top >> 4 & 15) * 17, (top & 15) * 17];
    let fg = [0, 0, 0], far = -1;
    for (let j = 0; j < px.length; j += 4) { const dd = Math.abs(px[j] - bg[0]) + Math.abs(px[j + 1] - bg[1]) + Math.abs(px[j + 2] - bg[2]); if (dd > far) { far = dd; fg = [px[j], px[j + 1], px[j + 2]]; } }
    return { bg, fg };
  } catch { return { bg: [255, 255, 255], fg: [0, 0, 0] }; }
}
const vrect = (view, [a, b, c, d]) => [...view.viewport.convertToViewportPoint(a, b), ...view.viewport.convertToViewportPoint(c, d)];
const CSS_FONT = { Helvetica: 'Helvetica, Arial, sans-serif', Times: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace' };
function drawEdits(n) {
  const view = pdf.viewer?.getPageView(n - 1);
  if (!view?.div) return;
  view.div.querySelectorAll('.pdf-edit').forEach((el) => { if (el !== document.activeElement) el.remove(); });
  for (const [key, ed] of edits) {
    if (ed.page !== n || view.div.querySelector(`.pdf-edit[data-key="${key}"]`)) continue;
    const [x1, y1, x2, y2] = vrect(view, ed.rect), el = document.createElement('span');
    el.className = 'pdf-edit'; el.dataset.key = key; el.contentEditable = 'plaintext-only'; el.spellcheck = false; el.textContent = ed.text;
    Object.assign(el.style, {
      left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`, minWidth: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px`,
      lineHeight: `${Math.abs(y2 - y1)}px`, fontSize: `${ed.size * view.viewport.scale}px`, fontFamily: CSS_FONT[ed.family],
      fontWeight: ed.bold ? 'bold' : 'normal', fontStyle: ed.italic ? 'italic' : 'normal', background: `rgb(${ed.bg})`, color: `rgb(${ed.fg})`,
    });
    el.addEventListener('input', () => { ed.text = el.textContent.replace(/\n/g, ' '); edited(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); el.blur(); } });
    el.addEventListener('blur', () => { if (ed.text === ed.was) { edits.delete(key); el.remove(); edited(); } });
    view.div.append(el);
  }
}
const STD = (ed) => (ed.family === 'Times' ? `TimesRoman${ed.bold ? 'Bold' : ''}${ed.italic ? 'Italic' : ''}` : `${ed.family}${ed.bold ? 'Bold' : ''}${ed.italic ? 'Oblique' : ''}`);
// the pdf as pdf.js saves it (annotations, forms), with the text edits drawn in
async function withEdits(bytes) {
  if (!edits.size) return bytes;
  const { PDFDocument, StandardFonts, rgb } = await import('/pdf-lib.mjs');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false }), fonts = {}, colour = (c) => rgb(c[0] / 255, c[1] / 255, c[2] / 255);
  for (const ed of edits.values()) {
    const page = doc.getPage(ed.page - 1), font = fonts[STD(ed)] ||= await doc.embedFont(StandardFonts[STD(ed)]);
    const [x1, y1, x2, y2] = ed.rect;
    page.drawRectangle({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, color: colour(ed.bg) });
    // characters the standard fonts can't write become '?'
    const text = [...ed.text].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
    if (text.trim()) page.drawText(text, { x: ed.x, y: ed.y, size: ed.size, font, color: colour(ed.fg) });
  }
  return doc.save({ useObjectStreams: false });
}
function pdfZoom(factor) {
  if (!pdf.viewer) return;
  pdf.zoomed = true;
  pdf.viewer.currentScale = Math.min(8, Math.max(0.25, pdf.viewer.currentScale * factor));
}
// (a pane hidden behind another tab measures 0 wide: keep the pages as they were)
new ResizeObserver(() => { if (pdf.viewer?.pagesCount && !pdf.zoomed && $('main').clientWidth) pdf.viewer.currentScaleValue = 'page-width'; }).observe($('main'));
addEventListener('wheel', (e) => { if (pdf.viewer && e.ctrlKey) { e.preventDefault(); pdfZoom(Math.exp(-e.deltaY / 200)); } }, { passive: false });

// a textarea with a line gutter; the lines the path named are marked in the gutter and scrolled to, without taking
// the keyboard away from the terminal
function mountEditor() {
  $('main').innerHTML = '<div class="ed"><pre aria-hidden="true"></pre><textarea spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-label="File contents"></textarea></div>';
  const ta = $('main').querySelector('textarea'), gut = $('main').querySelector('pre');
  ta.value = text; ta.readOnly = !!f.truncated;
  const number = () => {
    const n = ta.value.split('\n').length;
    if (+gut.dataset.n === n) return;
    gut.dataset.n = n;
    gut.innerHTML = Array.from({ length: n }, (_, i) => (i + 1 >= from && i + 1 <= to ? `<b style="color:var(--color-accent)">${i + 1}</b>` : i + 1)).join('\n');
  };
  number();
  ta.addEventListener('scroll', () => { gut.scrollTop = ta.scrollTop; });
  ta.addEventListener('input', () => { text = ta.value; number(); edited(); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '\t'); } });
  if (from) {
    const lines = text.split('\n'), start = lines.slice(0, from - 1).join('\n').length + (from > 1 ? 1 : 0);
    ta.setSelectionRange(start, start + (lines.slice(from - 1, to).join('\n').length));
    ta.scrollTop = gut.scrollTop = Math.max(0, (from - 1) * parseFloat(getComputedStyle(ta).lineHeight) - ta.clientHeight / 3);
  }
}

function edited() {
  dirty = true;
  if (!conflict) { state = 'editing'; warn = false; clearTimeout(timer); timer = setTimeout(save, 700); }
  drawBar();
}
async function save(force = false) {
  clearTimeout(timer);
  if (saving) await saving;
  if ((!dirty && !force) || !(isText() || pdf.doc) || f.truncated) return;
  const sent = text;
  if (pdf.doc) dirty = false; // an annotation made while saving marks it dirty again
  const request = pdf.doc
    ? pdf.doc.saveDocument().then(withEdits).then((bytes) => api(`/api/file/bytes?${new URLSearchParams({ path: f.path, mtime, ...(force ? { force: '1' } : {}) })}`, { method: 'POST', body: bytes }))
    : api('/api/file/save', { method: 'POST', body: JSON.stringify({ path: f.path, text: sent, mtime, force }) });
  saving = request
    .then((r) => { mtime = r.mtime; f.mtime = r.mtime; conflict = false; if (!pdf.doc) dirty = text !== sent; state = dirty ? 'editing' : 'saved'; warn = false; if (dirty) timer = setTimeout(save, 700); })
    .catch((e) => { if (pdf.doc) dirty = true; conflict = /changed on disk/.test(e.message); state = conflict ? 'changed on disk since you started editing' : `not saved: ${e.message}`; warn = true; })
    .finally(() => { saving = null; drawBar(); });
  return saving;
}
// the version on disk, keeping where the editor was
async function reload() {
  const ta = $('main').querySelector('textarea'), at = ta && { top: ta.scrollTop, a: ta.selectionStart, b: ta.selectionEnd };
  f = await load(f.path || target);
  pdf.doc?.destroy(); pdf.doc = pdf.viewer = null; pdf.tools = false; edits.clear(); runs.clear();
  text = f.text ?? ''; mtime = f.mtime || 0; dirty = false; conflict = false; state = facts();
  draw();
  const next = $('main').querySelector('textarea');
  if (at && next) { next.scrollTop = at.top; next.setSelectionRange(at.a, at.b); next.dispatchEvent(new Event('scroll')); }
}

// an agent writes the file: show its version, or say so when you have edits of your own
setInterval(async () => {
  if (document.hidden || f.error || f.type === 'dir' || saving || conflict) return;
  const s = await api(`/api/file?${new URLSearchParams({ path: f.path, stat: '1' })}`).catch(() => null);
  if (!s || Math.abs(s.mtime - mtime) <= 1 || saving) return;
  if (dirty) { conflict = true; clearTimeout(timer); state = 'changed on disk since you started editing'; warn = true; drawBar(); return; }
  reload();
}, 2000);
// switching to another file or closing the pane keeps what was typed
addEventListener('pagehide', () => {
  if (!dirty || conflict || !isText()) return; // a pdf saves a moment after each annotation; the last one may be lost here
  fetch('/api/file/save', { method: 'POST', keepalive: true, body: JSON.stringify({ path: f.path, text, mtime }) }).catch(() => {});
});

const close = async () => { await save(); parent.postMessage({ type: 'synapse:file-close' }, '*'); };
addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && document.querySelector('.comment-pop')) return;
  if (ev.key === 'Escape' && !embed) close();
  const mod = ev.metaKey || ev.ctrlKey, k = ev.key.toLowerCase();
  if (mod && !ev.shiftKey && !ev.altKey && k === 's') { ev.preventDefault(); save(); }
  if (mod && ev.altKey && (k === 'm' || ev.code === 'KeyM') && isText()) { ev.preventDefault(); openComment(); return; }
  if (isText() && mod && !ev.altKey && ['=', '+', '-', '0'].includes(ev.key)) { ev.preventDefault(); setZoom(ev.key === '0' ? 1 : zoom * (ev.key === '-' ? 1 / 1.1 : 1.1)); return; }
  // formatting: in the preview the browser's own commands, in the markdown source the markdown marks
  const view = ev.target.closest?.('.md-view[contenteditable="true"]'), ta = isMd() && ev.target.closest?.('.ed textarea');
  if ((view || ta) && mod && !ev.shiftKey) {
    const code = ev.code;
    const fmt = !ev.altKey && { KeyB: ['bold', '**'], KeyI: ['italic', '*'], KeyU: ['underline', '<u>', '</u>'] }[code];
    const head = ev.altKey && { Digit1: 'h1', Digit2: 'h2', Digit3: 'h3', Digit0: 'p' }[code];
    if (fmt) { ev.preventDefault(); if (view) document.execCommand(fmt[0]); else wrapSelection(ta, fmt[1], fmt[2]); return; }
    if (head && view) { ev.preventDefault(); document.execCommand('formatBlock', false, head); return; }
  }
  if (pdf.viewer && (ev.metaKey || ev.ctrlKey) && ['=', '+', '-', '0'].includes(ev.key)) {
    ev.preventDefault();
    if (ev.key === '0') { pdf.zoomed = false; pdf.viewer.currentScaleValue = 'page-width'; } else pdfZoom(ev.key === '-' ? 1 / 1.15 : 1.15);
  }
});
document.addEventListener('click', async (ev) => {
  const a = ev.target.closest('a[href^="http"]');
  if (a && ev.target.closest('.md-view[contenteditable="true"]') && !(ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); return; } // editing: ⌘-click opens
  if (a) { ev.preventDefault(); window.open(a.href); return; }
  const tool = ev.target.closest('[data-tool]')?.dataset.tool;
  if (tool) return pdfTool(tool);
  const act = ev.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') close();
  else if (act === 'back') { await save(); history.back(); }
  else if (act === 'copy') navigator.clipboard.writeText(f.path || target).then(() => { state = 'path copied'; drawBar(); });
  else if (act === 'mode') { mode = mode === 'edit' ? 'preview' : 'edit'; draw(); }
  else if (act === 'smaller' || act === 'bigger') setZoom(zoom * (act === 'smaller' ? 1 / 1.1 : 1.1));
  else if (act === 'comment') openComment();
  else if (act === 'cancel-comment') ev.target.closest('.comment-pop')?.remove();
  else if (act === 'fold') { commentsOpen = !commentsOpen; drawComments(); }
  else if (act === 'send-all') sendComments(comments);
  else if (act === 'send-one') sendComments(comments.filter((c) => c.id === ev.target.closest('[data-c]').dataset.c));
  else if (act === 'drop') { comments = comments.filter((c) => c.id !== ev.target.closest('[data-c]').dataset.c); saveComments(); drawComments(); }
  else if (act === 'wide') { wide = !wide; parent.postMessage({ type: 'synapse:file-wide', wide }, '*'); drawBar(); }
  else if (act === 'reload') reload();
  else if (act === 'overwrite') save(true);
  else if (act === 'reveal') api('/api/file/open', { method: 'POST', body: JSON.stringify({ path: f.path, reveal: true }) }).then(() => { state = `shown in ${FINDER}`; drawBar(); }, (e) => { state = e.message; warn = true; drawBar(); });
  else if (act === 'open') api('/api/file/open', { method: 'POST', body: JSON.stringify({ path: f.path }) }).catch(() => {});
});

state = facts();
draw();
