// The file viewer the desktop app opens beside a terminal when a path in it is ⌘-clicked.
// /file?path=src/x.ts:12&cwd=/repo&theme=night. Links inside (folders, crumbs) navigate this page, so Back is history.
import { escapeHtml, renderMarkdown } from './workspace.mjs';

const q = new URLSearchParams(location.search);
const target = q.get('path') || '', cwd = q.get('cwd') || '';
if (['night', 'signal'].includes(q.get('theme'))) document.documentElement.dataset.theme = q.get('theme');
addEventListener('message', (ev) => { if (ev.source === parent && ev.data?.type === 'synapse:theme' && ['night', 'signal'].includes(ev.data.theme)) document.documentElement.dataset.theme = ev.data.theme; });

const pane = document.getElementById('inspector');
const size = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const here = (path, mode) => `/file?${new URLSearchParams({ path, cwd, theme: document.documentElement.dataset.theme, ...(mode ? { mode } : {}) })}`;
const api = (url, init) => fetch(url, init).then(async (r) => { const v = await r.json().catch(() => ({})); if (!r.ok) throw new Error(v.error || r.statusText); return v; });

const lm = target.match(/(?::(\d+)(?:-(\d+))?(?::\d+)?|#L(\d+)(?:-L?(\d+))?)$/);
const from = lm ? +(lm[1] || lm[3]) : 0, to = lm ? +(lm[2] || lm[4] || from) : 0;
const head = (title, sub, tools = '') => `<div class="inspector-heading file-heading">${document.referrer.startsWith(`${location.origin}/file`) ? '<button class="text-button" data-act="back" title="Back">←</button>' : ''}<div class="file-title"><h2>${escapeHtml(title)}</h2>${sub ? `<span>${escapeHtml(sub)}</span>` : ''}</div><button class="text-button" data-act="close" title="Close  esc">✕</button></div>${tools}`;

let f;
try { f = await api(`/api/file?${new URLSearchParams({ path: target, cwd })}`); }
catch (error) { f = { error: error.message }; }
if (f.error) pane.innerHTML = head(target.split('/').pop() || target, target) + `<p class="inspector-note">Synapse can't open this file: ${escapeHtml(f.error)}</p>`;
else {
  document.title = f.name;
  const raw = `/api/file/raw?${new URLSearchParams({ path: f.path })}`;
  const isMd = f.type === 'text' && /^(md|markdown|mdx)$/.test(f.ext);
  const mode = q.get('mode') || (isMd && !from ? 'rendered' : 'source');
  const lines = f.type === 'text' ? f.text.split('\n') : [];
  const facts = [f.type === 'dir' ? `${f.entries.length} items` : f.type === 'text' ? `${lines.length} lines` : f.ext || f.type, f.type !== 'dir' && size(f.size), `edited ${ago(f.mtime)}`, f.truncated && 'first 1 MB'].filter(Boolean);
  const tools = `<div class="file-tools"><span>${facts.map(escapeHtml).join(' · ')}</span>${isMd ? `<a class="text-button" href="${escapeHtml(here(target, mode === 'rendered' ? 'source' : 'rendered'))}">${mode === 'rendered' ? 'Source' : 'Preview'}</a>` : ''}<button class="text-button" data-act="open">Open</button><button class="text-button" data-act="reveal">Show in Finder</button><button class="text-button" data-act="copy">Copy path</button></div>`;
  let body;
  if (f.type === 'dir') body = `<div class="file-dir">${f.entries.map((e) => `<a class="file-link" href="${escapeHtml(here(`${f.path}/${e.name}`))}">${escapeHtml(e.name)}${e.dir ? '/' : ''}</a>`).join('') || '<p class="inspector-note">Empty folder.</p>'}</div>`;
  else if (f.type === 'image') body = `<div class="file-media"><img src="${raw}" alt="${escapeHtml(f.name)}"></div>`;
  else if (f.type === 'video' || f.type === 'audio') body = `<div class="file-media"><${f.type} src="${raw}" controls></${f.type}></div>`;
  else if (f.type === 'pdf') body = `<iframe class="file-pdf" src="${raw}" title="${escapeHtml(f.name)}"></iframe>`;
  else if (f.type === 'binary') body = '<p class="inspector-note">Binary file. Open it in its own app instead.</p>';
  else if (mode === 'rendered') body = `<div class="file-md md">${renderMarkdown(f.text)}</div>`;
  else body = `<div class="file-source">${lines.slice(0, 20000).map((l, i) => `<div class="file-line${i + 1 >= from && i + 1 <= to ? ' hit' : ''}"><span>${i + 1}</span><code>${escapeHtml(l) || ' '}</code></div>`).join('')}</div>`;
  const dir = f.type === 'dir' ? f.path : f.path.replace(/\/[^/]*$/, '');
  const root = cwd.replace(/\/+$/, ''), inside = root && (dir === root || dir.startsWith(`${root}/`));
  pane.innerHTML = head(f.name + (f.type === 'dir' ? '/' : ''), inside ? `${root.split('/').pop()}${dir.slice(root.length)}/` : dir.replace(/^\/Users\/[^/]+/, '~'), tools) + body;
  pane.querySelector('.file-line.hit')?.scrollIntoView({ block: 'center' });
  pane.dataset.path = f.path;
}

const close = () => parent.postMessage({ type: 'synapse:file-close' }, '*');
addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[href^="http"]');
  if (a) { ev.preventDefault(); window.open(a.href); return; }
  const act = ev.target.closest('[data-act]')?.dataset.act, path = pane.dataset.path;
  if (act === 'close') close();
  else if (act === 'back') history.back();
  else if (act === 'copy') navigator.clipboard.writeText(path);
  else if (act && path) api('/api/file/open', { method: 'POST', body: JSON.stringify({ path, reveal: act === 'reveal' }) }).catch(() => {});
});
