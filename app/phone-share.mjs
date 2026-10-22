// Live links for the phone: a localhost site or a file an agent mentioned, reachable from the phone for a while.
//
// Each share is a Cloudflare quick tunnel (`cloudflared tunnel --url …`, no account) to a port on this Mac, with a
// random https://….trycloudflare.com address. A site tunnels its own port; a file gets a tiny server of its own
// on 127.0.0.1 that answers only under a random token, serving that one file (an HTML page may also load the
// files next to it, never dotfiles or anything above its folder), with Markdown turned into a readable page.
// Anyone holding the link can open it until it expires (15 minutes, extendable) or is stopped; then the tunnel
// and the server go. The tunnels' pids are written down so a crash or quit never leaves one running.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA, readJSON, writeJSON } from '../lib.mjs';

export const TTL = 15 * 60_000;
const MAX_LIVE = 5, MAX_LEFT = 4 * 60 * 60_000, START_TIMEOUT = 40_000;
const PIDS = path.join(DATA, 'shares.json');
const FILE_EXT = /\.(pdf|md|markdown|txt|log|csv|tsv|json|ya?ml|toml|xml|html?|svg|png|jpe?g|gif|webp|mp4|mov|webm)$/i;
const MIME = { pdf: 'application/pdf', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', log: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain', xml: 'application/xml', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', woff2: 'font/woff2', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const mimeOf = (p) => MIME[path.extname(p).slice(1).toLowerCase()] || 'application/octet-stream';
const LOCAL = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

const shares = new Map(); // id -> { id, kind, label, target, url, state, error, expires, started, proc, server }
let onChange = () => {};
export function attach(fn) { onChange = fn; }

// ---------------------------------------------------------------- what can be shared

// localhost URLs and file paths in a text, in order, once each: what the phone offers to open
export function targetsIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s)<>"'`\]]*)?/g)) out.add(m[0].replace(/[.,;:]+$/, ''));
  const bare = String(text || '').replace(/\b[a-z][a-z0-9+.-]*:\/\/(?!\/)\S+/gi, (u) => (u.startsWith('file://') ? u : ' '.repeat(u.length))); // web addresses are not files
  for (const m of bare.matchAll(/(?:file:\/\/)?(?:~\/|\/|\.{1,2}\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.(?:pdf|md|markdown|txt|log|csv|tsv|json|ya?ml|toml|xml|html?|svg|png|jpe?g|gif|webp|mp4|mov|webm)\b/gi)) {
    out.add(m[0]);
  }
  return [...out];
}

export function resolveFile(p, cwd) {
  let file = String(p || '').replace(/^file:\/\//, '');
  if (file.startsWith('~/')) file = path.join(os.homedir(), file.slice(2));
  else if (!path.isAbsolute(file)) file = path.resolve(cwd || os.homedir(), file);
  return file;
}

export function siteOf(target) {
  let u; try { u = new URL(target); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !LOCAL.has(u.hostname) || !u.port) return null;
  return { port: Number(u.port), path: `${u.pathname}${u.search}${u.hash}` };
}

// ---------------------------------------------------------------- the list

const pub = (s) => ({ id: s.id, kind: s.kind, label: s.label, target: s.target, url: s.state === 'live' ? s.url : null, state: s.state, error: s.error || null, expires: s.expires, started: s.started });
export const list = () => [...shares.values()].map(pub).sort((a, b) => b.started - a.started);
const changed = () => { savePids(); onChange(list()); };

function savePids() { writeJSON(PIDS, [...shares.values()].map((s) => s.proc?.pid).filter(Boolean)); }
// tunnels a previous run left behind (a crash, a force quit): stop them before anything else
export function sweep() {
  for (const pid of readJSON(PIDS, [])) {
    const comm = process.platform === 'win32' ? ['tasklist', ['/FI', `PID eq ${Number(pid)}`, '/NH', '/FO', 'CSV']] : ['/bin/ps', ['-p', String(Number(pid)), '-o', 'comm=']];
    try { if (/cloudflared/.test(execFileSync(comm[0], comm[1], { encoding: 'utf8', windowsHide: true }))) process.kill(Number(pid)); } catch {} // gone already, or reused by something else
  }
  writeJSON(PIDS, []);
}

export function extend(id, ms = TTL) {
  const s = shares.get(id);
  if (!s) throw new Error('that link is gone');
  s.expires = Math.min(Date.now() + MAX_LEFT, Math.max(s.expires, Date.now()) + ms);
  arm(s); changed();
  return pub(s);
}

export function stop(id) {
  const s = shares.get(id);
  if (!s) return false;
  shares.delete(id);
  clearTimeout(s.timer);
  try { s.proc?.kill(); } catch {}
  try { s.server?.close(); s.server?.closeAllConnections?.(); } catch {}
  changed();
  return true;
}
export function stopAll() { for (const id of [...shares.keys()]) stop(id); }

function arm(s) {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => stop(s.id), Math.max(0, s.expires - Date.now()));
  s.timer.unref?.();
}

// ---------------------------------------------------------------- starting one

// the same target twice gives the same live link (with its time topped up), not a second tunnel
export async function share(target, { cwd, cloudflared = which('cloudflared'), ready = reachable } = {}) {
  const site = siteOf(target);
  const file = site ? null : resolveFile(target, cwd);
  const key = site ? `site:${site.port}${site.path}` : `file:${file}`;
  const same = [...shares.values()].find((s) => s.key === key && s.state !== 'error');
  if (same) { if (same.state === 'live') extend(same.id, Math.max(0, Date.now() + TTL - same.expires)); return pub(same); }
  if (shares.size >= MAX_LIVE) throw new Error(`${MAX_LIVE} links are live already; stop one first`);
  if (!cloudflared) throw new Error('Synapse on your computer is missing its tunnel helper; update or reinstall Synapse there');
  let port, label, open = '/';
  let server = null;
  if (site) {
    if (!(await listening(site.port))) throw new Error(`nothing is running on localhost:${site.port}`);
    port = site.port; label = `localhost:${site.port}${site.path === '/' ? '' : site.path}`; open = site.path;
  } else {
    if (!FILE_EXT.test(file)) throw new Error('that kind of file cannot be opened on the phone');
    let st; try { st = fs.statSync(file); } catch { throw new Error(`${path.basename(file)} does not exist`); }
    if (!st.isFile()) throw new Error(`${path.basename(file)} is not a file`);
    const token = crypto.randomBytes(16).toString('hex');
    server = await fileServer(file, token);
    port = server.address().port; label = path.basename(file); open = `/${token}/`;
  }
  const s = { id: crypto.randomBytes(6).toString('hex'), key, kind: site ? 'site' : 'file', label, target, url: null, state: 'starting', expires: Date.now() + TTL, started: Date.now(), server };
  shares.set(s.id, s); arm(s); changed();
  try {
    const base = await tunnel(s, cloudflared, port, site ? `localhost:${port}` : null);
    await ready(`${base}${open}`);
    s.url = `${base}${open}`; s.state = 'live';
  } catch (e) {
    s.state = 'error'; s.error = e.message;
    try { s.proc?.kill(); } catch {}
    try { server?.close(); } catch {}
    s.expires = Date.now() + 60_000; arm(s); // the error shows on the phone for a minute
  }
  changed();
  return pub(s);
}

// the copy shipped inside the app first (Contents/Resources), then the one scripts/fetch-cloudflared.mjs put in
// app/vendor when running from source, then one the user installed
const HERE = path.dirname(fileURLToPath(import.meta.url));
function which(name) {
  if (process.platform === 'win32') name += '.exe';
  const shipped = [process.resourcesPath && path.join(process.resourcesPath, name), path.join(HERE, 'vendor', name)];
  return [process.env.SYNAPSE_CLOUDFLARED, ...shipped, ...['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map((d) => path.join(d, name))].find((p) => p && fs.existsSync(p)) || null;
}

// A new trycloudflare name takes a few seconds to exist in DNS. A resolver asked too early answers "no such name"
// and remembers that for many minutes (Google's did, in testing), so a phone that opened the link at once would
// see it broken. So only Cloudflare's own resolver is asked (over HTTPS: nothing cached on the Mac or the phone,
// and it stops saying "no such name" as soon as the name exists), and the link goes to the phone once it resolves.
const READY_WAIT = 30_000;
async function reachable(url) {
  const name = new URL(url).hostname, end = Date.now() + READY_WAIT;
  while (Date.now() < end) {
    const known = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=A`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(3000) })
      .then((x) => x.json()).then((j) => j.Status === 0 && j.Answer?.length > 0, () => false);
    if (known) return;
    await new Promise((res) => setTimeout(res, 800));
  }
}

const listening = (port) => new Promise((resolve) => {
  const c = net.connect({ port, host: '127.0.0.1' });
  const done = (ok) => { c.destroy(); resolve(ok); };
  c.once('connect', () => done(true)); c.once('error', () => done(false)); c.setTimeout(1500, () => done(false));
});

// cloudflared prints its address, then "Registered tunnel connection" once traffic can flow
function tunnel(s, bin, port, hostHeader) {
  return new Promise((resolve, reject) => {
    const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`, ...(hostHeader ? ['--http-host-header', hostHeader] : [])];
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    s.proc = p; savePids();
    let url = null, ready = false, log = '';
    const timer = setTimeout(() => reject(new Error('Cloudflare did not open the tunnel in time; try again')), START_TIMEOUT);
    const read = (b) => {
      log = (log + b).slice(-4000);
      url ||= log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] || null;
      ready ||= /Registered tunnel connection/.test(log);
      if (url && ready) { clearTimeout(timer); resolve(url); }
    };
    p.stdout.on('data', read); p.stderr.on('data', read);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('exit', () => {
      clearTimeout(timer);
      reject(new Error('the tunnel closed'));
      if (shares.get(s.id) === s && s.state === 'live') stop(s.id); // it died while live: the link is gone
    });
  });
}

// ---------------------------------------------------------------- the file server

function fileServer(file, token) {
  const dir = path.dirname(file), name = path.basename(file), html = /\.html?$/i.test(name), md = /\.(md|markdown)$/i.test(name);
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = ''; }
    if (!rel.startsWith(`/${token}/`) || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404).end(); return; }
    rel = rel.slice(token.length + 2);
    if (rel === '' && md) return page(res, name, markdown(fs.readFileSync(file, 'utf8')));
    if (rel === '') rel = name;
    // the file itself; an HTML page also gets its neighbours (stylesheets, images), never dotfiles or the folder above
    const target = path.resolve(dir, rel);
    const ok = rel === name || (html && target.startsWith(dir + path.sep) && !rel.split('/').some((x) => x.startsWith('.')));
    let st = null; try { if (ok) st = fs.statSync(target); } catch {}
    if (!st?.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': mimeOf(target), 'content-length': st.size, 'cache-control': 'no-store', 'content-disposition': `inline; filename="${path.basename(target).replace(/[^\w.@+-]/g, '_')}"` });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server)); });
}

function page(res, title, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.55 -apple-system,system-ui,sans-serif;max-width:760px;margin:0 auto;padding:20px;color:#16130F;background:#F1EFE9}
@media(prefers-color-scheme:dark){body{color:#EDEDEA;background:#0B0B0B}a{color:#FF5A1F}code,pre{background:#1a1a1a!important}th,td{border-color:#333!important}}
h1,h2,h3{line-height:1.2}pre{overflow:auto;padding:12px;background:#e6e3db}code{font:13px ui-monospace,Menlo,monospace;background:#e6e3db;padding:1px 4px}pre code{padding:0;background:none}
blockquote{margin:0;padding-left:14px;border-left:3px solid #FF4400}table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #ccc;padding:4px 8px}img{max-width:100%}a{color:#FF4400}</style>${body}`);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Enough Markdown to read a plan or a report on a phone: headings, lists, quotes, code, tables, emphasis, links.
// Everything is escaped first, so the file cannot put markup or scripts into the page.
export function markdown(src) {
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+|#[^)\s]*)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  const out = [], lines = String(src).replace(/\r/g, '').split('\n');
  let list = null, para = [];
  const flush = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; if (list) { out.push(`</${list}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) { flush(); const code = []; while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]); out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); continue; }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)/))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { flush(); out.push('<hr>'); continue; }
    if ((m = l.match(/^>\s?(.*)/))) { flush(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (/^\|.*\|\s*$/.test(l) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flush(); const row = (r, tag) => `<tr>${r.trim().slice(1, -1).split('|').map((c) => `<${tag}>${inline(c.trim())}</${tag}>`).join('')}</tr>`;
      const rows = [row(l, 'th')]; i++;
      while (/^\|.*\|\s*$/.test(lines[i + 1] || '')) rows.push(row(lines[++i], 'td'));
      out.push(`<table>${rows.join('')}</table>`); continue;
    }
    if ((m = l.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)/))) {
      const tag = m[1] ? 'ul' : 'ol';
      if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
      if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${inline(m[3].replace(/^\[ \]\s/, '☐ ').replace(/^\[x\]\s/i, '☑ '))}</li>`); continue;
    }
    if (!l.trim()) { flush(); continue; }
    if (list) { out.push(`</${list}>`); list = null; }
    para.push(l.trim());
  }
  flush();
  return out.join('\n');
}
