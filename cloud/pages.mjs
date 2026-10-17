// The web pages: sign up, sign in, password reset, email confirmation, device approval, onboarding,
// settings and public profiles. Server-rendered shells; forms talk to the JSON API through /app.js.
// Same system as the app and the landing page: one ink on paper, orange marks live state.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LABELS = { github: 'GitHub', google: 'Google', x: 'X' };
export const providerLabel = (p) => LABELS[p] || p;
const ICONS = {
  github: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"/></svg>',
  google: '<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.33-1.58-5.04-3.7H.96v2.33A9 9 0 0 0 9 18"/><path fill="#FBBC05" d="M3.96 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3 2.33C4.67 5.16 6.66 3.58 9 3.58"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.12z"/></svg>',
};

export const CSS = `
@font-face { font-family: 'Big Shoulders Display'; src: url(/fonts/big-shoulders-display.woff2) format('woff2'); font-weight: 200 500; font-display: swap; }
@font-face { font-family: 'Fragment Mono'; src: url(/fonts/fragment-mono.woff2) format('woff2'); font-weight: 400; font-display: swap; }
@font-face { font-family: 'Geist'; src: url(/fonts/geist.woff2) format('woff2'); font-weight: 400; font-display: swap; }
:root { --paper: #F1EFE9; --ink: #16130F; --sig: #FF4400; --ok: #00A36C; --on-ink: #F1EFE9; }
@media (prefers-color-scheme: dark) { :root { --paper: #0B0B0B; --ink: #EDEDEA; --sig: #FF5A1F; --ok: #2FCB8E; --on-ink: #0B0B0B; } }
:root {
  --ink-2: color-mix(in srgb, var(--ink) 62%, var(--paper)); --ink-3: color-mix(in srgb, var(--ink) 40%, var(--paper));
  --rule: color-mix(in srgb, var(--ink) 18%, var(--paper)); --wash: color-mix(in srgb, var(--ink) 5%, var(--paper));
  --display: 'Big Shoulders Display', 'Arial Narrow', sans-serif; --mono: 'Fragment Mono', ui-monospace, Menlo, monospace; --sans: 'Geist', system-ui, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--paper); color: var(--ink); font: 400 15px/1.55 var(--sans); -webkit-font-smoothing: antialiased; }
::selection { background: var(--ink); color: var(--paper); }
a { color: inherit; text-underline-offset: 3px; }
.top { display: flex; align-items: stretch; height: 52px; border-bottom: 1px solid var(--rule); font: 11px var(--mono); text-transform: uppercase; }
.top > * { display: flex; align-items: center; padding: 0 18px; border-right: 1px solid var(--rule); text-decoration: none; }
.top .brand { gap: 10px; }
.top .brand b { font: 500 26px/1 var(--display); letter-spacing: .02em; text-transform: none; }
.top .sp { flex: 1; border-right: 0; }
.top a.nav:hover { background: var(--wash); }
.top .nav.cta { background: var(--ink); color: var(--paper); border-right: 0; }
.top .me { gap: 9px; }
.av { width: 26px; height: 26px; flex: none; object-fit: cover; background: var(--ink); color: var(--paper); display: inline-grid; place-items: center; font: 11px var(--mono); }
.av.big { width: 88px; height: 88px; font-size: 30px; }
.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); min-height: calc(100vh - 52px); }
.split .poster { background: var(--ink); color: var(--paper); padding: 56px 48px; display: flex; flex-direction: column; justify-content: space-between; }
.poster h1 { font: 400 clamp(64px, 9vw, 132px)/.86 var(--display); margin: 0; letter-spacing: .005em; text-transform: uppercase; }
.poster h1 em { font-style: normal; color: var(--sig); }
.poster p { max-width: 400px; color: color-mix(in srgb, var(--paper) 72%, var(--ink)); margin: 0; }
.poster .lbl { font: 11px var(--mono); text-transform: uppercase; color: color-mix(in srgb, var(--paper) 55%, var(--ink)); }
.pane { padding: 56px 48px; display: flex; flex-direction: column; justify-content: center; }
.form { width: 100%; max-width: 380px; }
.form h2, .page h2 { font: 400 44px/1 var(--display); text-transform: uppercase; margin: 0 0 8px; }
.sub { color: var(--ink-2); margin: 0 0 28px; }
label { display: block; font: 10.5px var(--mono); text-transform: uppercase; color: var(--ink-2); margin: 16px 0 6px; }
input[type=text], input[type=email], input[type=password], input[type=url] { width: 100%; height: 42px; padding: 0 12px; font: 14px var(--sans); color: var(--ink); background: var(--wash); border: 1px solid var(--rule); outline: 0; border-radius: 0; }
input:focus { border-color: var(--ink); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 10px; height: 42px; padding: 0 18px; font: 11.5px var(--mono); text-transform: uppercase; letter-spacing: .04em; color: var(--ink); background: none; border: 1px solid var(--ink); cursor: pointer; text-decoration: none; white-space: nowrap; }
.btn:hover { background: var(--ink); color: var(--paper); }
.btn.solid { background: var(--ink); color: var(--paper); }
.btn.solid:hover { background: var(--sig); border-color: var(--sig); color: #fff; }
.btn.sig { background: var(--sig); border-color: var(--sig); color: #fff; }
.btn.small { height: 30px; padding: 0 10px; font-size: 10.5px; }
.btn.quiet { border-color: var(--rule); }
.btn.danger:hover { background: var(--sig); border-color: var(--sig); color: #fff; }
.btn:disabled { opacity: .45; cursor: default; background: none; color: var(--ink); }
.btn svg { width: 16px; height: 16px; }
.wide { width: 100%; margin-top: 22px; }
.providers { display: grid; gap: 8px; margin-bottom: 8px; }
.or { display: flex; align-items: center; gap: 12px; margin: 22px 0 4px; font: 10.5px var(--mono); text-transform: uppercase; color: var(--ink-3); }
.or::before, .or::after { content: ''; flex: 1; border-top: 1px solid var(--rule); }
.alt { margin-top: 22px; font-size: 13.5px; color: var(--ink-2); }
.row { display: flex; gap: 8px; align-items: center; }
.row > input { flex: 1; }
.msg { margin-top: 14px; font: 12px var(--mono); min-height: 18px; }
.msg.err { color: var(--sig); }
.msg.ok { color: var(--ok); }
.note { padding: 12px 14px; border: 1px solid var(--rule); background: var(--wash); font-size: 13.5px; color: var(--ink-2); margin: 0 0 18px; }
.note.err { border-color: var(--sig); color: var(--sig); }
.page { max-width: 820px; margin: 0 auto; padding: 56px 28px 96px; }
.steps { list-style: none; padding: 0; margin: 36px 0 0; border-top: 1px solid var(--rule); counter-reset: s; }
.steps li { display: grid; grid-template-columns: 56px 1fr; gap: 0 18px; padding: 26px 0; border-bottom: 1px solid var(--rule); counter-increment: s; }
.steps li::before { content: counter(s, decimal-leading-zero); font: 400 40px/1 var(--display); color: var(--ink-3); }
.steps li.done::before { content: '✓'; color: var(--ok); }
.steps li.now::before { color: var(--sig); }
.steps h3 { margin: 4px 0 6px; font: 500 17px/1.3 var(--sans); }
.steps p { margin: 0 0 12px; color: var(--ink-2); font-size: 14px; }
code, .code { font: 12.5px var(--mono); background: var(--wash); border: 1px solid var(--rule); padding: 1px 6px; }
pre.code { padding: 12px 14px; white-space: pre-wrap; margin: 0; }
.devcode { font: 400 64px/1 var(--display); letter-spacing: .08em; margin: 18px 0 24px; }
section.card { border: 1px solid var(--rule); padding: 22px 24px; margin-top: 18px; }
section.card h3 { margin: 0 0 4px; font: 10.5px var(--mono); text-transform: uppercase; color: var(--ink-2); font-weight: 400; }
section.card > p { margin: 0 0 14px; color: var(--ink-2); font-size: 13.5px; }
.list { border-top: 1px solid var(--rule); margin-top: 10px; }
.item { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--rule); font-size: 14px; }
.item .grow { flex: 1; min-width: 0; }
.item .meta { font: 10.5px var(--mono); text-transform: uppercase; color: var(--ink-3); }
.pill { font: 10px var(--mono); text-transform: uppercase; padding: 2px 6px; border: 1px solid var(--rule); color: var(--ink-2); }
.pill.ok { border-color: var(--ok); color: var(--ok); }
.pill.sig { border-color: var(--sig); color: var(--sig); }
.profile { display: flex; gap: 28px; align-items: center; margin-top: 12px; }
.profile h2 { margin: 0; }
.foot { border-top: 1px solid var(--rule); padding: 18px 28px; font: 10.5px var(--mono); text-transform: uppercase; color: var(--ink-3); display: flex; gap: 18px; }
.foot a { text-decoration: none; }
.prose { max-width: 680px; } .prose h3 { margin-top: 28px; } .prose p, .prose li { color: var(--ink-2); }
@media (max-width: 820px) { .split { grid-template-columns: 1fr; } .split .poster { padding: 36px 24px; min-height: 260px; } .pane { padding: 36px 24px; } .top .hide-s { display: none; } }
`;

// One small script for every page: forms with data-api post JSON and follow data-next.
export const JS = `
const $ = (s, r = document) => r.querySelector(s);
const q = new URLSearchParams(location.search);
async function api(path, body, method) {
  const r = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || 'Something went wrong. Try again.');
  return out;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function say(el, text, ok) { el.textContent = text || ''; el.className = 'msg ' + (ok ? 'ok' : 'err'); }
const safeNext = (n) => (n && /^\\/(?!\\/)/.test(n) ? n : null);

for (const form of document.querySelectorAll('form[data-api]')) {
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('.msg', form), btn = $('button[type=submit]', form);
    const data = Object.fromEntries(new FormData(form));
    if (data.confirm !== undefined && data.confirm !== data.password) return say(msg, 'The two passwords are not the same.');
    delete data.confirm;
    if (form.dataset.token) data.token = q.get('token');
    btn.disabled = true; say(msg, '');
    try {
      await api(form.dataset.api, data);
      if (form.dataset.done) { form.innerHTML = '<p class="note">' + form.dataset.done + '</p>'; return; }
      location.href = safeNext(q.get('next')) || form.dataset.next || '/welcome';
    } catch (e) { say(msg, e.message); btn.disabled = false; }
  });
}

// buttons with data-act post to the API, then reload or show a message
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  ev.preventDefault();
  const msg = b.closest('section, .form, li')?.querySelector('.msg');
  if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
  b.disabled = true;
  try {
    const body = b.dataset.body ? JSON.parse(b.dataset.body) : {};
    if (b.dataset.field) body[b.dataset.key] = b.closest('section, .form, li').querySelector(b.dataset.field).value;
    await api(b.dataset.act, body, b.dataset.method);
    if (b.dataset.go) location.href = b.dataset.go;
    else if (b.dataset.done) { if (msg) say(msg, b.dataset.done, true); b.disabled = false; }
    else location.reload();
  } catch (e) { if (msg) say(msg, e.message); else alert(e.message); b.disabled = false; }
});

// email confirmation page: confirm on load
if ($('#verify')) {
  api('/v1/auth/verify', { token: q.get('token') })
    .then(() => { $('#verify').innerHTML = '<h2>Email confirmed</h2><p class="sub">Thanks. Friends can now find you by this address.</p><a class="btn solid" href="/welcome">Continue</a>'; })
    .catch((e) => { $('#verify').innerHTML = '<h2>Link expired</h2><p class="sub">' + esc(e.message) + '</p><a class="btn" href="/settings">Send a new one</a>'; });
}

// trusted people (welcome + settings)
async function renderTrusted() {
  const box = $('#trusted'); if (!box) return;
  try {
    const { trusted } = await api('/v1/trusted');
    box.innerHTML = trusted.length ? trusted.map((p) => '<div class="item">' + avatar(p) + '<div class="grow"><b>' + esc(p.name) + '</b> ' +
      (p.handle ? '<a class="meta" href="/u/' + esc(p.handle) + '">@' + esc(p.handle) + '</a>' : '') + '</div>' +
      (p.pending ? '<span class="pill">invited</span>' : p.trustsYou ? '<span class="pill ok">trusts you</span>' : '<span class="pill">one way</span>') +
      '<button class="btn small quiet" data-del="' + esc(p.id) + '" aria-label="Remove ' + esc(p.name) + '">remove</button></div>').join('') : '<p class="item meta">Nobody yet.</p>';
  } catch (e) { box.innerHTML = '<p class="msg err">' + esc(e.message) + '</p>'; }
}
function avatar(p) {
  return p.avatar ? '<img class="av" src="' + esc(p.avatar) + '" alt="">' : '<span class="av">' + esc((p.name || '?').slice(0, 1).toUpperCase()) + '</span>';
}
if ($('#trusted')) {
  renderTrusted();
  $('#trust-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const inp = $('#trust-who'), msg = $('#trust-msg');
    try { const { person } = await api('/v1/trusted', { who: inp.value }); inp.value = ''; say(msg, person.pending ? 'Invite sent to ' + person.email + '.' : 'Added ' + person.name + '.', true); renderTrusted(); }
    catch (e) { say(msg, e.message); }
  });
  $('#trusted').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-del]'); if (!b) return;
    await api('/v1/trusted/' + b.dataset.del, null, 'DELETE').catch((e) => alert(e.message));
    renderTrusted();
  });
}

// settings: profile, sessions and requests are rendered from the API
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
if ($('#settings')) {
  (async () => {
    const { user } = await api('/v1/me');
    $('#p-name').value = user.name; $('#p-handle').value = user.handle; $('#p-avatar').value = user.avatar || '';
    $('#p-email').textContent = user.email || 'no email';
    $('#p-verified').innerHTML = !user.email ? '' : user.emailVerified ? '<span class="pill ok">confirmed</span>' : '<span class="pill sig">not confirmed</span> <button class="btn small" data-act="/v1/auth/resend-verification" data-done="Sent. Check your inbox.">resend</button>';
    $('#pw-current-wrap').hidden = !user.hasPassword;
    $('#pw-title').textContent = user.hasPassword ? 'Change password' : 'Set a password';
    for (const p of ['github', 'google', 'x']) {
      const el = $('#prov-' + p); if (!el) continue;
      const on = user.providers.includes(p);
      el.innerHTML = on ? '<span class="pill ok">connected</span> <button class="btn small quiet" data-act="/v1/me/unlink" data-body=\\'{"provider":"' + p + '"}\\'>disconnect</button>' : '<a class="btn small" href="/auth/' + p + '/start?link=1">connect</a>';
    }
    const { sessions } = await api('/v1/me/sessions');
    $('#sessions').innerHTML = sessions.map((s) => '<div class="item"><div class="grow"><b>' + esc(s.label || s.kind) + '</b> <span class="meta">' + esc(s.kind) + ' · ' + ago(s.lastUsed) + '</span></div>' +
      (s.current ? '<span class="pill">this one</span>' : '<button class="btn small quiet" data-act="/v1/me/sessions/' + esc(s.id) + '" data-method="DELETE">sign out</button>') + '</div>').join('');
    const { incoming, outgoing } = await api('/v1/requests');
    const row = (r, dir) => '<div class="item"><div class="grow">' + (dir === 'in' ? '<b>' + esc(r.from.name) + '</b>\\'s agent <b>' + esc(r.agent.name) + '</b> asked you' : 'Your agent <b>' + esc(r.agent.name) + '</b> asked <b>' + esc(r.to.name) + '</b>') +
      (r.target ? ' <span class="meta">for ' + esc(r.target) + '</span>' : '') + ' <span class="meta">' + ago(r.createdAt) + '</span></div>' +
      '<span class="pill ' + (r.status === 'accepted' ? 'ok' : r.status === 'pending' ? 'sig' : '') + '">' + esc(r.status) + '</span>' +
      (dir === 'in' && r.status === 'pending' ? ' <button class="btn small quiet" data-act="/v1/requests/' + esc(r.id) + '/deny">deny</button>' : '') +
      (dir === 'out' && r.status === 'pending' ? ' <button class="btn small quiet" data-act="/v1/requests/' + esc(r.id) + '/cancel">cancel</button>' : '') + '</div>';
    $('#requests').innerHTML = (incoming.map((r) => row(r, 'in')).join('') + outgoing.map((r) => row(r, 'out')).join('')) || '<p class="item meta">No requests yet.</p>';
    if ($('#requests-note')) $('#requests-note').hidden = !incoming.some((r) => r.status === 'pending');
  })().catch((e) => { $('#settings').insertAdjacentHTML('afterbegin', '<p class="note err">' + esc(e.message) + '</p>'); });
  $('#profile-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await api('/v1/me', { name: $('#p-name').value, handle: $('#p-handle').value, avatar: $('#p-avatar').value }, 'PATCH'); say($('#profile-msg'), 'Saved.', true); }
    catch (e) { say($('#profile-msg'), e.message); }
  });
  $('#pw-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.target));
    if (f.password !== f.confirm) return say($('#pw-msg'), 'The two passwords are not the same.');
    try { await api('/v1/me/password', { current: f.current, password: f.password }); ev.target.reset(); say($('#pw-msg'), 'Password saved. Other devices were signed out.', true); }
    catch (e) { say($('#pw-msg'), e.message); }
  });
  $('#delete-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!confirm('Delete your Synapse account? Your trusted people and requests go with it. This cannot be undone.')) return;
    try { await api('/v1/me', { password: $('#del-pw').value }, 'DELETE'); location.href = '/signup'; }
    catch (e) { say($('#del-msg'), e.message); }
  });
}
if (q.get('error') && $('#err')) { $('#err').textContent = q.get('error'); $('#err').hidden = false; }
`;

// ---------------------------------------------------------------- layout

function layout(ctx, title, body, { bare = false } = {}) {
  const u = ctx.user;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(title)} · Synapse</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%2316130F'/%3E%3Crect x='5' y='17' width='9' height='9' fill='%23F1EFE9'/%3E%3Crect x='18' y='6' width='9' height='9' fill='%23FF4400'/%3E%3Cpath d='M14 19 18 14' stroke='%23F1EFE9' stroke-width='2'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/app.css"></head><body>
<header class="top"><a class="brand" href="${u ? '/welcome' : 'https://heysynapse.vercel.app'}"><b>synapse</b></a><span class="sp"></span>
${u ? `<a class="nav hide-s" href="/welcome">get started</a><a class="nav hide-s" href="/download">download</a><a class="nav me" href="/settings">${avatar(u)}<span class="hide-s">@${esc(u.handle)}</span></a><a class="nav" href="#" data-act="/v1/auth/logout" data-go="/login">sign out</a>`
    : `<a class="nav hide-s" href="/download">download</a><a class="nav" href="/login">sign in</a><a class="nav cta" href="/signup">sign up</a>`}
</header>
${body}
${bare ? '' : `<footer class="foot"><span>synapse</span><a href="/privacy">privacy</a><a href="/terms">terms</a><a href="https://github.com/VishiATChoudhary/synapse">github</a></footer>`}
<script src="/app.js"></script></body></html>`;
}

function avatar(u, big) {
  const cls = big ? 'av big' : 'av';
  return u.avatar ? `<img class="${cls}" src="${esc(u.avatar)}" alt="">` : `<span class="${cls}">${esc((u.name || '?').slice(0, 1).toUpperCase())}</span>`;
}

const poster = (line, sub) => `<aside class="poster"><span class="lbl">every agent, one canvas</span>
<div><h1>${line}</h1></div><p>${sub}</p></aside>`;

function providerButtons(ctx, verb) {
  const next = ctx.q.next ? `?next=${encodeURIComponent(ctx.q.next)}` : '';
  const on = Object.entries(ctx.providers).filter(([, v]) => v).map(([p]) => p);
  if (!on.length) return '';
  return `<div class="providers">${on.map((p) => `<a class="btn" href="/auth/${p}/start${next}">${ICONS[p]}${verb} with ${providerLabel(p)}</a>`).join('')}</div><div class="or">or with email</div>`;
}

// ---------------------------------------------------------------- pages

export function signup(ctx) {
  const next = ctx.q.next ? `?next=${encodeURIComponent(ctx.q.next)}` : '';
  return layout(ctx, 'Create your account', `<main class="split">${poster('Agents that <em>talk</em> to friends', 'Your Claude, Codex and Gemini sessions can read context from the agents of people you trust, once they say yes.')}
<div class="pane"><form class="form" data-api="/v1/auth/signup" data-next="/welcome">
<h2>Create account</h2><p class="sub">${ctx.q.from ? `@${esc(ctx.q.from)} invited you. ` : ''}Free. Takes a minute.</p>
<p class="note err" id="err" hidden></p>
${providerButtons(ctx, 'Sign up')}
<label for="name">Name</label><input id="name" name="name" type="text" autocomplete="name" required maxlength="60">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(ctx.q.email || '')}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
<button class="btn solid wide" type="submit">Create account</button><p class="msg" role="alert"></p>
<p class="alt">Have an account? <a href="/login${next}">Sign in</a>. By signing up you agree to the <a href="/terms">terms</a>.</p>
</form></div></main>`, { bare: true });
}

export function login(ctx) {
  const next = ctx.q.next ? `?next=${encodeURIComponent(ctx.q.next)}` : '';
  return layout(ctx, 'Sign in', `<main class="split">${poster('Welcome <em>back</em>', 'Sign in to see requests from friends and manage the people your agents trust.')}
<div class="pane"><form class="form" data-api="/v1/auth/login" data-next="/welcome">
<h2>Sign in</h2><p class="sub">${ctx.q.next?.startsWith('/device') ? 'Sign in to connect the Synapse app.' : 'Good to see you.'}</p>
<p class="note err" id="err" hidden></p>
${providerButtons(ctx, 'Continue')}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button class="btn solid wide" type="submit">Sign in</button><p class="msg" role="alert"></p>
<p class="alt"><a href="/forgot">Forgot your password?</a> · New here? <a href="/signup${next}">Create an account</a></p>
</form></div></main>`, { bare: true });
}

export function forgot(ctx) {
  return layout(ctx, 'Reset password', `<main class="split">${poster('Locked <em>out</em>?', 'It happens. We email you a link to choose a new password.')}
<div class="pane"><form class="form" data-api="/v1/auth/forgot" data-done="If there is an account for that email, a reset link is on its way. It works for one hour. Check your spam folder too.">
<h2>Forgot password</h2><p class="sub">Type the email you signed up with.</p>
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
<button class="btn solid wide" type="submit">Email me a link</button><p class="msg" role="alert"></p>
<p class="alt"><a href="/login">Back to sign in</a></p></form></div></main>`, { bare: true });
}

export function reset(ctx) {
  return layout(ctx, 'Choose a new password', `<main class="split">${poster('Fresh <em>start</em>', 'Choose a new password. Every device signed in to your account gets signed out.')}
<div class="pane"><form class="form" data-api="/v1/auth/reset" data-token="1" data-done="Password changed. <a href='/login'>Sign in with it</a>.">
<h2>New password</h2><p class="sub">At least 8 characters.</p>
${ctx.q.token ? '' : '<p class="note err">This page needs the link from the email.</p>'}
<label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
<label for="confirm">Same again</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" required>
<button class="btn solid wide" type="submit">Save password</button><p class="msg" role="alert"></p></form></div></main>`, { bare: true });
}

export function verify(ctx) {
  return layout(ctx, 'Confirm email', `<main class="page"><div id="verify"><h2>Confirming…</h2><p class="sub">One moment.</p></div></main>`);
}

export function device(ctx) {
  const d = ctx.device;
  return layout(ctx, 'Connect the app', `<main class="page"><div class="form">
${d ? `<h2>Connect the app</h2><p class="sub">Sign <b>${esc(d.label)}</b> in to your account as <b>@${esc(ctx.user.handle)}</b>? Check the code matches the one in the app.</p>
<div class="devcode">${esc(d.code)}</div>
<div class="row"><button class="btn solid" data-act="/v1/device/approve" data-body='${esc(JSON.stringify({ userCode: d.code }))}' data-go="/device?done=1">Connect</button>
<button class="btn quiet" data-act="/v1/device/approve" data-body='${esc(JSON.stringify({ userCode: d.code, deny: true }))}' data-go="/welcome">Cancel</button></div><p class="msg" role="alert"></p>`
    : ctx.q.done ? `<h2>Connected</h2><p class="sub">Go back to the Synapse app: you are signed in. You can close this tab.</p><a class="btn" href="/welcome">Continue setup</a>`
    : `<h2>Code expired</h2><p class="sub">This sign-in code is no longer valid. Start the sign-in again in the Synapse app.</p><a class="btn" href="/welcome">Continue</a>`}
</div></main>`);
}

export function welcome(ctx) {
  const u = ctx.user;
  const steps = [
    { done: true, title: 'Create your account', body: `You are <b>@${esc(u.handle)}</b>. People can add you by this handle or your email.` },
    { done: !u.email || u.emailVerified, title: 'Confirm your email',
      body: u.email ? `We sent a link to <b>${esc(u.email)}</b>. Confirming lets friends who invited you by email find you.` : 'You signed up without an email. Add one later in settings if you want.',
      act: u.email && !u.emailVerified ? '<section style="border:0;padding:0"><button class="btn small" data-act="/v1/auth/resend-verification" data-done="Sent. Check your inbox.">Send it again</button><p class="msg" role="alert"></p></section>' : '' },
    { done: ctx.hasApp, title: 'Download Synapse for Mac', body: 'Apple Silicon. Open the DMG and drag Synapse into Applications. The first time, right-click Synapse and choose <b>Open</b> (macOS asks once because the app is new).',
      act: `<a class="btn solid" href="/download">Download the DMG</a>` },
    { done: ctx.hasApp, title: 'Sign in inside the app', body: 'Open Synapse. Sign in with the same account: email and password, or GitHub, Google or X (the app opens this browser to confirm).' },
    { done: ctx.trusted.length > 0, title: 'Add the people you trust', body: 'Only people on this list can get requests from your agents. Someone without an account gets an invite by email.',
      act: `<form id="trust-form" class="row"><input id="trust-who" type="text" placeholder="email or @handle" aria-label="Email or handle" required><button class="btn" type="submit">Add</button></form><p class="msg" id="trust-msg" role="alert"></p><div class="list" id="trusted"></div>` },
    { done: false, title: 'Let your agent ask', body: 'In any agent running in Synapse, say what you need. Your friend sees a blinking circle at the top right of their app and accepts or denies. Once accepted, your agent reads their agent\'s context.',
      act: `<pre class="code">use synapse to get context from @friend's api agent</pre>` },
  ];
  const first = steps.findIndex((s) => !s.done);
  return layout(ctx, 'Get started', `<main class="page"><h2>Get started</h2><p class="sub">Six steps. You can come back to this page any time.</p>
<ol class="steps">${steps.map((s, i) => `<li class="${s.done ? 'done' : i === first ? 'now' : ''}"><div><h3>${s.title}</h3><p>${s.body}</p>${s.act || ''}</div></li>`).join('')}</ol></main>`);
}

export function settings(ctx) {
  const prov = ['github', 'google', 'x'].filter((p) => ctx.providers[p] || ctx.user.providers.includes(p));
  return layout(ctx, 'Settings', `<main class="page" id="settings"><h2>Settings</h2><p class="sub">@${esc(ctx.user.handle)} · <a href="/u/${esc(ctx.user.handle)}">public profile</a></p>
${ctx.q.error ? `<p class="note err">${esc(ctx.q.error)}</p>` : ''}${ctx.q.linked ? '<p class="note">Account connected.</p>' : ''}
<section class="card"><h3>Profile</h3><p>How friends see you.</p><form id="profile-form">
<label for="p-name">Name</label><input id="p-name" type="text" maxlength="60" required>
<label for="p-handle">Handle</label><input id="p-handle" type="text" maxlength="24" required pattern="@?[a-zA-Z0-9_\\-]{2,24}">
<label for="p-avatar">Avatar image link</label><input id="p-avatar" type="url" placeholder="https://…">
<button class="btn wide" type="submit" style="width:auto">Save profile</button><p class="msg" id="profile-msg" role="alert"></p></form></section>
<section class="card"><h3>Email</h3><div class="item" style="border:0"><span class="grow" id="p-email"></span><span id="p-verified"></span></div><p class="msg" role="alert"></p></section>
<section class="card" id="requests-card"><h3>Requests</h3><p id="requests-note" hidden>Accept requests in the Synapse app: it asks which of your agents to share.</p><div class="list" id="requests"></div></section>
<section class="card"><h3>Trusted people</h3><p>Only people on this list can get requests from your agents.</p>
<form id="trust-form" class="row"><input id="trust-who" type="text" placeholder="email or @handle" aria-label="Email or handle" required><button class="btn" type="submit">Add</button></form>
<p class="msg" id="trust-msg" role="alert"></p><div class="list" id="trusted"></div></section>
<section class="card"><h3 id="pw-title">Password</h3><form id="pw-form">
<div id="pw-current-wrap"><label for="pw-current">Current password</label><input id="pw-current" name="current" type="password" autocomplete="current-password"></div>
<label for="pw-new">New password</label><input id="pw-new" name="password" type="password" autocomplete="new-password" minlength="8" required>
<label for="pw-confirm">Same again</label><input id="pw-confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" required>
<button class="btn wide" type="submit" style="width:auto">Save password</button><p class="msg" id="pw-msg" role="alert"></p></form></section>
${prov.length ? `<section class="card"><h3>Connected accounts</h3><p>Sign in with any of these.</p><div class="list">${prov.map((p) => `<div class="item"><span class="grow">${providerLabel(p)}</span><span id="prov-${p}"></span></div>`).join('')}</div><p class="msg" role="alert"></p></section>` : ''}
<section class="card"><h3>Signed-in devices</h3><p>The Synapse app, the CLI and browsers.</p><div class="list" id="sessions"></div><p class="msg" role="alert"></p></section>
<section class="card"><h3>Delete account</h3><p>Removes your profile, trusted people and requests.</p><form id="delete-form" class="row">
<input id="del-pw" type="password" placeholder="your password" aria-label="Password" autocomplete="current-password"><button class="btn danger" type="submit">Delete account</button></form><p class="msg" id="del-msg" role="alert"></p></section>
</main>`);
}

export function profile(ctx) {
  const p = ctx.person;
  const joined = new Date(p.createdAt).toLocaleDateString('en', { month: 'long', year: 'numeric' });
  return layout(ctx, `${p.name} (@${p.handle})`, `<main class="page"><div class="profile">${avatar(p, true)}<div>
<h2>${esc(p.name)}</h2><p class="sub" style="margin:4px 0 0">@${esc(p.handle)} · on Synapse since ${esc(joined)}</p></div></div>
<section class="card"><h3>Synapse</h3>
${ctx.self ? `<p>This is your public profile. Share the link so friends can add you: <code>${esc(ctx.base)}/u/${esc(p.handle)}</code></p><a class="btn" href="/settings">Edit profile</a>`
    : ctx.user ? (ctx.trusted ? `<p>${esc(p.name)} is one of your trusted people. Your agents can ask for context from theirs.</p>`
      : `<p>Add ${esc(p.name)} to your trusted people so your agents can ask for context from theirs. They still accept each request.</p><button class="btn solid" data-act="/v1/trusted" data-body='${esc(JSON.stringify({ who: p.handle }))}'>Add to trusted people</button>`)
      : `<p>Sign up to share coding agents with ${esc(p.name)}.</p><a class="btn solid" href="/signup?from=${esc(p.handle)}">Create your account</a>`}
<p class="msg" role="alert"></p></section></main>`);
}

export function message(ctx) {
  return layout(ctx.user !== undefined ? ctx : { ...ctx, user: null }, ctx.title, `<main class="page"><h2>${esc(ctx.title)}</h2><p class="sub">${ctx.body}</p>${ctx.link ? `<a class="btn" href="${esc(ctx.link)}">${esc(ctx.cta)}</a>` : ''}</main>`);
}

export function privacy(ctx) {
  return layout(ctx, 'Privacy', `<main class="page prose"><h2>Privacy</h2>
<p>Synapse runs on your Mac. The cloud only does what sharing between people needs.</p>
<h3>What we store</h3><ul><li>Your account: name, handle, email, avatar link, a scrypt hash of your password, and which sign-in providers you connected.</li>
<li>Your trusted people and the requests between agents (agent names, kinds, projects, the note you wrote).</li>
<li>Signed-in devices (a label and when they were last used).</li></ul>
<h3>Agent context</h3><p>When you accept a request, the context of the agent you chose is sent to your friend's machine through our mailbox. Items are deleted as soon as their machine collects them, and after 24 hours at the latest. We do not read, keep or train on it.</p>
<h3>Deleting</h3><p>Delete your account in settings and everything above goes with it.</p>
<h3>Contact</h3><p>Questions: open an issue on <a href="https://github.com/VishiATChoudhary/synapse">GitHub</a>.</p></main>`);
}

export function terms(ctx) {
  return layout(ctx, 'Terms', `<main class="page prose"><h2>Terms</h2>
<p>Synapse is provided as is, without warranty. Use it for your own work and with people you trust.</p>
<p>You are responsible for what your agents share. Only accept requests from people you know, and only share agents whose context you are allowed to share.</p>
<p>Do not use Synapse to send spam, to break the law or to get around the limits of the service. We may suspend accounts that do.</p>
<p>We may change these terms; the version on this page applies.</p></main>`);
}
