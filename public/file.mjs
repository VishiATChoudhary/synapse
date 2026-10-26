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
addEventListener('message', (ev) => {
  if (ev.source !== parent) return;
  if (ev.data?.type === 'synapse:theme') setTheme(ev.data.theme);
  if (ev.data?.type === 'synapse:file-wide') { wide = !!ev.data.wide; drawBar(); }
});

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
mode = isMd() && !from ? 'preview' : 'edit';

function facts() {
  warn = false;
  if (f.error) return '';
  const n = isText() ? `${text.split('\n').length} lines` : f.type === 'dir' ? `${f.entries.length} items` : size(f.size);
  return [n, `edited ${ago(f.mtime)}`, f.truncated && 'first 1 MB, read only'].filter(Boolean).join(' · ');
}

function drawBar() {
  const back = document.referrer.startsWith(`${location.origin}/file`);
  const name = f.error ? target.split('/').pop() || target : f.name + (f.type === 'dir' ? '/' : '');
  $('bar').innerHTML = `${back ? '<button data-act="back" title="Back">←</button>' : ''}`
    + `<button class="name" data-act="copy" title="${escapeHtml(f.path || target)}  ·  click to copy the path">${escapeHtml(name)}${dirty ? ' ●' : ''}</button>`
    + `<span class="state${warn ? ' warn' : ''}">${escapeHtml(state)}</span>`
    + (conflict ? '<button data-act="reload" title="Load the version on disk, dropping your edits">Reload</button><button data-act="overwrite" title="Save your version over it">Keep mine</button>' : '')
    + (isMd() ? `<button data-act="mode">${mode === 'edit' ? 'Preview' : 'Edit'}</button>` : '')
    + (pdf.tools ? Object.keys(PDF_TOOLS).map((t) => `<button data-tool="${t}" aria-pressed="${pdf.tool === t}" title="${PDF_TOOLS[t].title}">${t}</button>`).join('') : '')
    + (f.error ? '' : '<button data-act="open" title="Open in its own app">Open ↗</button>')
    + `<button data-act="wide" title="${wide ? 'Back beside the terminal' : 'Fill the window'}">${wide ? '⇥' : '⇤'}</button>`
    + '<button data-act="close" title="Close  esc">✕</button>';
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
  else if (mode === 'preview') main.innerHTML = `<div class="md md-view">${renderMarkdown(text)}</div>`;
  else { main.className = 'full'; mountEditor(); }
  drawBar();
}

// pdfs draw with pdf.js: just the pages, fit to the pane's width (⌘+ / ⌘- or pinch to zoom). Highlight, Draw and
// Text add annotations; they, and filled-in form fields, save into the pdf itself like text edits do.
const PDF_TOOLS = { Highlight: { type: 'HIGHLIGHT', title: 'Select text to highlight it' }, Draw: { type: 'INK', title: 'Draw on the page' }, Text: { type: 'FREETEXT', title: 'Click to add text' } };
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
  pdf.viewer.annotationEditorMode = { mode: pdf.tool ? AnnotationEditorType[PDF_TOOLS[pdf.tool].type] : AnnotationEditorType.NONE };
  drawBar();
}
function pdfZoom(factor) {
  if (!pdf.viewer) return;
  pdf.zoomed = true;
  pdf.viewer.currentScale = Math.min(8, Math.max(0.25, pdf.viewer.currentScale * factor));
}
new ResizeObserver(() => { if (pdf.viewer?.pagesCount && !pdf.zoomed) pdf.viewer.currentScaleValue = 'page-width'; }).observe($('main'));
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
    ? pdf.doc.saveDocument().then((bytes) => api(`/api/file/bytes?${new URLSearchParams({ path: f.path, mtime, ...(force ? { force: '1' } : {}) })}`, { method: 'POST', body: bytes }))
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
  pdf.doc?.destroy(); pdf.doc = pdf.viewer = null; pdf.tools = false;
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
  if (ev.key === 'Escape') close();
  if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
  if (pdf.viewer && (ev.metaKey || ev.ctrlKey) && ['=', '+', '-', '0'].includes(ev.key)) {
    ev.preventDefault();
    if (ev.key === '0') { pdf.zoomed = false; pdf.viewer.currentScaleValue = 'page-width'; } else pdfZoom(ev.key === '-' ? 1 / 1.15 : 1.15);
  }
});
document.addEventListener('click', async (ev) => {
  const a = ev.target.closest('a[href^="http"]');
  if (a) { ev.preventDefault(); window.open(a.href); return; }
  const tool = ev.target.closest('[data-tool]')?.dataset.tool;
  if (tool) return pdfTool(tool);
  const act = ev.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') close();
  else if (act === 'back') { await save(); history.back(); }
  else if (act === 'copy') navigator.clipboard.writeText(f.path || target).then(() => { state = 'path copied'; drawBar(); });
  else if (act === 'mode') { mode = mode === 'edit' ? 'preview' : 'edit'; draw(); }
  else if (act === 'wide') { wide = !wide; parent.postMessage({ type: 'synapse:file-wide', wide }, '*'); drawBar(); }
  else if (act === 'reload') reload();
  else if (act === 'overwrite') save(true);
  else if (act === 'open') api('/api/file/open', { method: 'POST', body: JSON.stringify({ path: f.path }) }).catch(() => {});
});

state = facts();
draw();
