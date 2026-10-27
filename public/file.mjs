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
