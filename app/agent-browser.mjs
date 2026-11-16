// The agent browser: a browser inside Synapse that agents drive (MCP synapse_browser) and you watch, next to the
// agent's chat or popped out into its own window. Each agent has its own tabs; all of them share one signed-in
// profile (persist:synapse-browser), so you sign in once and agents use the session without ever seeing a password.
// Agents reach it over a local HTTP endpoint (127.0.0.1, random port, a token in ~/.synapse/agent-browser.json,
// readable by you only). Before an agent first opens a site, you allow it (once, always, or deny) in the panel.
// You can take over at any time: the agent's actions wait until you hand it back.
import { BrowserWindow, WebContentsView, session as electronSession, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PARTITION = 'persist:synapse-browser';
const TOOLBAR = 44; // the popped window's own bar above the page
const ASK_FOR = 120_000; // how long an agent waits for you to allow a site

export function createAgentBrowser({ dataDir, getWin, agentName, root, vault = null, packaged = true }) {
  const FILE = path.join(dataDir, 'agent-browser.json');
  const SITES = path.join(dataDir, 'agent-browser-sites.json');
  const LOGINS = path.join(dataDir, 'agent-browser-logins.json');
  const TABS = path.join(dataDir, 'agent-browser-tabs.json'); // agent id -> its open pages, for the prompt hook // site -> vault logins agents may always use there
  const token = crypto.randomBytes(24).toString('hex');
  const agents = new Map(); // agent id -> { tabs: [{ id, view }], active, popped, paused, bounds, allowed:Set }
  const asks = new Map(); // ask id -> { agent, origin, resolve }
  let shown = null; // the agent whose tab is in the main window's panel
  let server = null;

  const readSites = () => { try { return new Set(JSON.parse(fs.readFileSync(SITES, 'utf8'))); } catch { return new Set(); } };
  const saveSites = (s) => fs.writeFileSync(SITES, JSON.stringify([...s], null, 2), { mode: 0o600 });
  const readLogins = () => { try { return JSON.parse(fs.readFileSync(LOGINS, 'utf8')); } catch { return {}; } };
  const loginsHere = (url) => { try { return vault ? vault.loginsFor(url) : []; } catch { return []; } };
  const originOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; } };
  const local = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.localhost|[^/]+\.test)(:\d+)?$/.test(origin || '');

  const ses = () => electronSession.fromPartition(PARTITION);
  const entry = (id) => {
    if (!agents.has(id)) agents.set(id, { tabs: [], active: null, popped: null, paused: false, bounds: null, allowed: new Set(), logins: new Set() });
    return agents.get(id);
  };
  const tabOf = (a) => a.tabs.find((t) => t.id === a.active) || a.tabs.at(-1) || null;

  // ------------------------------------------------------------ what the GUI sees
  function snapshot() {
    const out = {};
    for (const [id, a] of agents) {
      out[id] = {
        tabs: a.tabs.map((t) => ({ id: t.id, title: t.view.webContents.getTitle() || t.view.webContents.getURL() || 'New tab', url: t.view.webContents.getURL(), loading: t.view.webContents.isLoading() })),
        active: tabOf(a)?.id || null, popped: !!a.popped, paused: a.paused, driving: !!a.driving && Date.now() - a.driving < 4000,
        logins: tabOf(a) ? loginsHere(tabOf(a).view.webContents.getURL()).map((l) => l.user) : [],
        canBack: !!tabOf(a)?.view.webContents.navigationHistory.canGoBack(), canForward: !!tabOf(a)?.view.webContents.navigationHistory.canGoForward(),
      };
    }
    return { agents: out, asks: [...asks.entries()].map(([id, q]) => ({ id, agent: q.agent, name: agentName(q.agent), origin: q.origin, kind: q.kind, user: q.user || null })) };
  }
  let pushTimer = null, lastTabs = '';
  const push = () => {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      const s = snapshot();
      getWin()?.webContents.send('agent-browser:state', s);
      // which pages each agent has open, so its next prompt can say so (hook.mjs)
      const open = Object.fromEntries(Object.entries(s.agents).map(([id, b]) => [id, b.tabs.filter((t) => originOf(t.url)).map((t) => ({ title: t.title, url: t.url, active: t.id === b.active }))]).filter(([, tabs]) => tabs.length));
      const text = JSON.stringify(open);
      if (text !== lastTabs) { lastTabs = text; try { fs.writeFileSync(TABS, text, { mode: 0o600 }); } catch {} }
      for (const [id, a] of agents) if (a.popped && !a.popped.isDestroyed()) a.popped.webContents.send('agent-browser:state', { ...s.agents[id], name: agentName(id) });
    }, 60);
  };

  // ------------------------------------------------------------ tabs and placement
  function newTab(id, url = 'about:blank') {
    const a = entry(id);
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    view.setBackgroundColor('#ffffff');
    const tab = { id: crypto.randomBytes(4).toString('hex'), view };
    const wc = view.webContents;
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(ev, push);
    // a link that opens a new window opens a new tab of the same agent
    wc.setWindowOpenHandler(({ url: u }) => { if (originOf(u)) newTab(id, u); return { action: 'deny' }; });
    a.tabs.push(tab); a.active = tab.id;
    if (url !== 'about:blank') wc.loadURL(url).catch(() => {});
    place();
    return tab;
  }
  function closeTab(id, tabId) {
    const a = agents.get(id); if (!a) return;
    const t = a.tabs.find((x) => x.id === tabId); if (!t) return;
    detach(t.view);
    t.view.webContents.close();
    a.tabs = a.tabs.filter((x) => x !== t);
    if (a.active === t.id) a.active = a.tabs.at(-1)?.id || null;
    if (!a.tabs.length && a.popped) { const w = a.popped; a.popped = null; if (!w.isDestroyed()) w.close(); }
    place();
  }
  const parentOf = (view) => [getWin(), ...[...agents.values()].map((a) => a.popped)].find((w) => w && !w.isDestroyed() && w.contentView.children.includes(view));
  const detach = (view) => { const p = parentOf(view); if (p) p.contentView.removeChildView(view); };

  // put every view where it belongs: the shown agent's active tab over the panel, a popped agent's in its window,
  // the rest nowhere (they keep running)
  function place() {
    const win = getWin();
    for (const [id, a] of agents) {
      const active = tabOf(a);
      for (const t of a.tabs) {
        let host = null, bounds = null;
        if (t === active && a.popped && !a.popped.isDestroyed()) {
          host = a.popped; const [w, h] = a.popped.getContentSize(); bounds = { x: 0, y: TOOLBAR, width: w, height: Math.max(0, h - TOOLBAR) };
        } else if (t === active && id === shown && a.bounds && win) { host = win; bounds = a.bounds; }
        const p = parentOf(t.view);
        if (p && p !== host) p.contentView.removeChildView(t.view);
        if (host) { if (!host.contentView.children.includes(t.view)) host.contentView.addChildView(t.view); t.view.setBounds(bounds); }
      }
    }
    push();
  }

  // the panel tells where its browser area is (window coordinates), or null when it is hidden
  function setBounds(id, bounds) {
    const ok = bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width > 20 && bounds.height > 20;
    if (shown && shown !== id && agents.get(shown)) agents.get(shown).bounds = null;
    shown = ok ? id : (shown === id ? null : shown);
    if (id) { const a = entry(id); a.bounds = ok ? { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) } : null; }
    place();
  }

  function pop(id) {
    const a = entry(id);
    if (!a.tabs.length) newTab(id);
    if (a.popped && !a.popped.isDestroyed()) { a.popped.show(); a.popped.focus(); return; }
    const main = getWin(), mb = main?.getBounds();
    const w = new BrowserWindow({
      width: 1180, height: 820, minWidth: 480, minHeight: 360, title: `${agentName(id)} · browser`,
      ...(mb ? { x: mb.x + 60, y: mb.y + 60 } : {}),
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', trafficLightPosition: { x: 14, y: 15 },
      backgroundColor: '#ffffff',
      webPreferences: { preload: path.join(root, 'browser-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    a.popped = w;
    w.loadFile(path.join(root, 'renderer', 'browser.html'), { query: { agent: id } });
    w.on('resize', place);
    w.webContents.on('did-finish-load', () => { place(); push(); });
    // closing the window docks the browser back into the agent's panel
    w.on('close', () => { if (a.popped === w) { for (const t of a.tabs) if (w.contentView.children.includes(t.view)) w.contentView.removeChildView(t.view); a.popped = null; } });
    w.on('closed', () => { place(); getWin()?.webContents.send('agent-browser:docked', { agent: id }); });
    place();
  }
  function dock(id) {
    const a = agents.get(id);
    if (a?.popped && !a.popped.isDestroyed()) a.popped.close();
    getWin()?.show(); getWin()?.focus();
  }

  // ------------------------------------------------------------ what you do
  async function user(id, action, args = {}) {
    const a = entry(id), t = tabOf(a), wc = t?.view.webContents;
    switch (action) {
      case 'go': {
        let url = String(args.url || '').trim();
        if (!url) return;
        if (!/^[a-z]+:\/\//i.test(url)) url = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)|^localhost(:\d+)?/.test(url) ? `https://${url}` : `https://duckduckgo.com/?q=${encodeURIComponent(url)}`;
        if (/^localhost|^127\./.test(url.replace(/^https:\/\//, ''))) url = url.replace(/^https:/, 'http:');
        // what you open yourself counts as allowed for this agent
        const o = originOf(url); if (o) a.allowed.add(o);
        if (!wc) newTab(id, url); else await wc.loadURL(url).catch(() => {});
        break;
      }
      case 'back': wc?.navigationHistory.goBack(); break;
      case 'forward': wc?.navigationHistory.goForward(); break;
      case 'reload': wc?.reload(); break;
      case 'new-tab': newTab(id); break;
      case 'close-tab': closeTab(id, args.tab); break;
      case 'select-tab': if (a.tabs.some((x) => x.id === args.tab)) { a.active = args.tab; place(); } break;
      case 'pause': a.paused = true; break;
      case 'resume': a.paused = false; break;
      case 'pop': pop(id); break;
      case 'dock': dock(id); break;
      case 'external': if (wc && originOf(wc.getURL())) shell.openExternal(wc.getURL()); break;
      // you sign in with a vault login yourself (the key button): no question, you asked
      case 'login': {
        if (!wc) throw new Error('Open a page first.');
        const login = pickLogin(wc.getURL(), args.user);
        if (!login) throw new Error('Your vault has no login for this site.');
        await fillLogin(wc, login, true);
        break;
      }
      default: throw new Error(`Unknown browser action ${action}.`);
    }
    push();
  }
  function answer(askId, choice) {
    const q = asks.get(askId); if (!q) return;
    asks.delete(askId);
    if (q.kind === 'login') {
      if (choice === 'always') { const l = readLogins(); l[q.origin] = [...new Set([...(l[q.origin] || []), q.base])]; fs.writeFileSync(LOGINS, JSON.stringify(l, null, 2), { mode: 0o600 }); }
      if (choice === 'always' || choice === 'once') entry(q.agent).logins.add(`${q.origin} ${q.base}`);
    } else {
      if (choice === 'always') { const s = readSites(); s.add(q.origin); saveSites(s); }
      if (choice === 'always' || choice === 'once') entry(q.agent).allowed.add(q.origin);
    }
    q.resolve(choice === 'always' || choice === 'once');
    push();
  }

  // ------------------------------------------------------------ what agents do
  const allowedFor = (id, origin) => !origin || local(origin) || entry(id).allowed.has(origin) || readSites().has(origin);
  function ask(id, origin, login = null) {
    if (!login && allowedFor(id, origin)) return Promise.resolve(true);
    if (login && (entry(id).logins.has(`${origin} ${login.base}`) || (readLogins()[origin] || []).includes(login.base))) return Promise.resolve(true);
    const kind = login ? 'login' : 'site';
    const existing = [...asks.values()].find((q) => q.agent === id && q.origin === origin && q.kind === kind);
    if (existing) return existing.promise;
    const askId = crypto.randomBytes(4).toString('hex');
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    asks.set(askId, { agent: id, origin, resolve, promise, kind, ...(login ? { base: login.base, user: login.user } : {}) });
    getWin()?.webContents.send('agent-browser:ask', { id: askId, agent: id, name: agentName(id), origin, kind });
    setTimeout(() => { if (asks.has(askId)) { asks.delete(askId); resolve(null); push(); } }, ASK_FOR);
    push();
    return promise;
  }
  const settle = (wc, ms = 400) => new Promise((r) => {
    const done = () => { clearTimeout(t); wc.off('did-stop-loading', done); setTimeout(r, 150); };
    const t = setTimeout(() => { wc.off('did-stop-loading', done); r(); }, wc.isLoading() ? 15000 : ms);
    if (wc.isLoading()) wc.once('did-stop-loading', done);
  });
  // a dot where the agent clicks, so you can follow it
  const cursor = (wc, x, y) => wc.executeJavaScript(`(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;z-index:2147483647;left:${x - 9}px;top:${y - 9}px;width:18px;height:18px;border-radius:50%;background:rgba(234,108,47,.35);border:2px solid #ea6c2f;pointer-events:none;transition:opacity .6s .5s,transform .3s;transform:scale(1.6)'; document.documentElement.appendChild(d); requestAnimationFrame(() => { d.style.transform = 'scale(1)'; d.style.opacity = '0'; }); setTimeout(() => d.remove(), 1400); })()`, true).catch(() => {});

  // the page as an agent reads it: numbered things it can click or type in, then the text
  const READ = `(() => {
    let n = 0; const lines = [];
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
    document.querySelectorAll('[data-sref]').forEach((e) => e.removeAttribute('data-sref'));
    for (const e of document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=checkbox], [role=menuitem], [contenteditable=""], [contenteditable=true], summary')) {
      if (!vis(e) || n >= 300) continue;
      const ref = ++n; e.setAttribute('data-sref', ref);
      const tag = e.tagName.toLowerCase(), role = e.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (e.type || 'text') : tag);
      const secret = e.type === 'password' || e.__sSecret;
      const name = (e.getAttribute('aria-label') || e.innerText || (secret ? '' : e.value) || e.placeholder || e.title || e.name || e.getAttribute('href') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      const extra = tag === 'input' && secret ? (e.value ? ' (filled)' : '') : tag === 'input' || tag === 'textarea' ? (e.value ? ' value="' + String(e.value).slice(0, 40) + '"' : '') + (e.placeholder ? ' placeholder="' + e.placeholder.slice(0, 40) + '"' : '') : tag === 'select' ? ' value="' + (e.selectedOptions[0]?.text || '') + '"' : '';
      lines.push('[' + ref + '] ' + role + ' "' + name + '"' + extra + (e.checked ? ' checked' : '') + (e.disabled ? ' disabled' : ''));
    }
    const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
    return { title: document.title, url: location.href, elements: lines.join('\\n'), text: text.slice(0, 6000) + (text.length > 6000 ? '\\n… (' + (text.length - 6000) + ' more characters; scroll or use find)' : '') };
  })()`;
  const where = (ref) => `(() => { const e = document.querySelector('[data-sref="${Number(ref)}"]'); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: e.tagName.toLowerCase() }; })()`;

  // the agent's mouse and keys go in through the DevTools protocol: real input events, without taking keyboard
  // focus from whatever you are typing in
  const cdp = async (wc, method, params) => {
    if (!wc.debugger.isAttached()) { try { wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {} }
    return wc.debugger.sendCommand(method, params);
  };
  const KEYS = { Enter: [13, '\r'], Tab: [9, ''], Escape: [27, ''], Backspace: [8, ''], Delete: [46, ''], ArrowUp: [38, ''], ArrowDown: [40, ''], ArrowLeft: [37, ''], ArrowRight: [39, ''], Home: [36, ''], End: [35, ''], PageUp: [33, ''], PageDown: [34, ''], Space: [32, ' '] };
  async function key(wc, name) {
    const [code, text] = KEYS[name] || [name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0, name.length === 1 ? name : ''];
    const k = name === 'Space' ? ' ' : name;
    await cdp(wc, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, windowsVirtualKeyCode: code, text: text || undefined });
    await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: code });
  }
  // a real click where the element is (sites trust it); if it did not reach the element (the view was just placed,
  // something covers it), the element is clicked in the page instead
  async function press(wc, ref, p) {
    const sel = `document.querySelector('[data-sref="${Number(ref)}"]')`;
    await wc.executeJavaScript(`(() => { const e = ${sel}; if (e) { e.__sHit = false; e.addEventListener('click', () => { e.__sHit = true; }, { once: true, capture: true }); } })()`, true);
    cursor(wc, p.x, p.y);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp(wc, 'Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 80));
    await wc.executeJavaScript(`(() => { const e = ${sel}; if (e && !e.__sHit) { e.focus?.(); e.click(); } })()`, true).catch(() => {});
  }
  // a vault login into the page: the username and password fields of its sign-in form (or the one there is, on a
  // two-step sign-in), typed in like keys, then Enter. The values go from the Keychain to the page, nowhere else.
  const FIELDS = `(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && !e.disabled && !e.readOnly; };
    document.querySelectorAll('[data-sfill]').forEach((e) => e.removeAttribute('data-sfill'));
    const pw = [...document.querySelectorAll('input[type=password]')].find((e) => vis(e) && e.autocomplete !== 'new-password') || null;
    const scope = pw?.form || document;
    const user = [...scope.querySelectorAll('input[autocomplete~=username], input[type=email], input[name*=user i], input[name*=email i], input[name*=login i], input[id*=user i], input[id*=email i], input[type=text], input:not([type])')].find((e) => vis(e) && e !== pw) || null;
    if (pw) pw.setAttribute('data-sfill', 'p');
    if (user) user.setAttribute('data-sfill', 'u');
    return { user: !!user, userValue: user ? user.value : '', pw: !!pw };
  })()`;
  async function fillLogin(wc, login, submit = true) {
    const f = await wc.executeJavaScript(FIELDS, true);
    if (!f.user && !f.pw) throw new Error('No sign-in form on this page. Open the sign-in page first.');
    const cred = await vault.secret(login.base, { packaged });
    const username = cred.username || login.user;
    const put = async (mark, value) => {
      await wc.executeJavaScript(`(() => { const e = document.querySelector('[data-sfill="${mark}"]'); if (!e) return; e.focus(); e.select?.(); })()`, true);
      await cdp(wc, 'Input.insertText', { text: value });
      // a field that did not take the keys: set it the way frameworks notice (the value stays inside the page)
      await wc.executeJavaScript(`((v) => { const e = document.querySelector('[data-sfill="${mark}"]'); if (!e || e.value === v) return; const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value')?.set; set ? set.call(e, v) : (e.value = v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })(${JSON.stringify(value)})`, true);
    };
    if (f.user && f.userValue !== username) await put('u', username);
    if (f.pw) {
      await put('p', cred.password);
      // the field stays secret even if a "show password" switch makes it plain text
      await wc.executeJavaScript(`(() => { const e = document.querySelector('[data-sfill="p"]'); if (e) e.__sSecret = true; })()`, true).catch(() => {});
    }
    if (submit) {
      // Enter on the last field; a form with no submit button does not send on Enter, so send it
      await wc.executeJavaScript(`(() => { const e = document.querySelector('[data-sfill="${f.pw ? 'p' : 'u'}"]'); e?.focus(); return !!e; })()`, true).catch(() => {});
      await key(wc, 'Enter');
      await new Promise((r) => setTimeout(r, 150));
      await wc.executeJavaScript(`(() => { const e = document.querySelector('[data-sfill]'); const form = e?.form; if (form && form.isConnected && !form.querySelector('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]')) form.requestSubmit(); })()`, true).catch(() => {});
    }
    await wc.executeJavaScript(`document.querySelectorAll('[data-sfill]').forEach((e) => e.removeAttribute('data-sfill'))`, true).catch(() => {});
    return { filled: f.pw ? (f.user ? 'username and password' : 'password') : 'username (the password comes on the next step: call login again there)' };
  }
  const pickLogin = (url, user) => {
    const all = loginsHere(url);
    if (!all.length) return null;
    return (user ? all.find((l) => l.user.toLowerCase() === String(user).toLowerCase()) : null) || (all.length === 1 || !user ? all[0] : null);
  };

  async function agentAct(id, action, args = {}) {
    const a = entry(id);
    if (a.paused) throw new Error('The user has taken over the browser. Wait for them to hand it back, then try again (action "status" shows when).');
    a.driving = Date.now(); push();
    setTimeout(push, 4100);
    let t = tabOf(a);
    if (action === 'status') return { paused: a.paused, tabs: a.tabs.map((x) => ({ tab: x.id, url: x.view.webContents.getURL(), title: x.view.webContents.getTitle(), active: x === t })) };
    if (action === 'tabs') return agentAct(id, 'status');
    if (action === 'open' || action === 'new_tab') {
      const url = String(args.url || '').trim();
      const origin = originOf(url);
      if (!origin) throw new Error('Give a full http(s) URL.');
      const ok = await ask(id, origin);
      if (ok === null) throw new Error(`The user has not answered whether you may use ${origin} yet. Ask them in chat to allow it in Synapse's browser panel, then try again.`);
      if (!ok) throw new Error(`The user did not allow ${origin}.`);
      if (!t || action === 'new_tab') t = newTab(id, url);
      else await t.view.webContents.loadURL(url).catch(() => {});
      await settle(t.view.webContents, 800);
      return read(t);
    }
    if (!t) throw new Error('No page is open. Use action "open" with a url first.');
    const wc = t.view.webContents;
    // after any action, a page on a site you have not allowed is not read back
    const guard = async () => { const o = originOf(wc.getURL()); if (o && !allowedFor(id, o)) { const ok = await ask(id, o); if (!ok) { wc.navigationHistory.goBack(); throw new Error(`The page moved to ${o}, which the user has not allowed.`); } } };
    switch (action) {
      case 'read': await guard(); return read(t);
      case 'screenshot': {
        await guard();
        // a filled password shown as text is blacked out for the picture
        const hid = await wc.executeJavaScript(`(() => { let n = 0; for (const e of document.querySelectorAll('input')) if (e.__sSecret && e.type !== 'password') { e.__sStyle = e.style.webkitTextSecurity; e.style.webkitTextSecurity = 'disc'; n++; } return n; })()`, true).catch(() => 0);
        const img = await wc.capturePage();
        if (hid) await wc.executeJavaScript(`document.querySelectorAll('input').forEach((e) => { if ('__sStyle' in e) { e.style.webkitTextSecurity = e.__sStyle; delete e.__sStyle; } })`, true).catch(() => {}); return { image: img.toJPEG(70).toString('base64'), mime: 'image/jpeg', url: wc.getURL() }; }
      case 'click': {
        const p = await wc.executeJavaScript(where(args.ref), true);
        if (!p) throw new Error(`No element [${args.ref}] on the page. Read the page again: its numbers change.`);
        await press(wc, args.ref, p);
        await settle(wc); await guard(); return read(t);
      }
      case 'type': {
        if (args.ref != null) {
          const p = await wc.executeJavaScript(where(args.ref), true);
          if (!p) throw new Error(`No element [${args.ref}] on the page. Read the page again: its numbers change.`);
          await press(wc, args.ref, p);
          if (args.replace !== false) await wc.executeJavaScript(`(() => { const e = document.querySelector('[data-sref="${Number(args.ref)}"]'); if (e && 'value' in e) { e.select?.(); } })()`, true);
        }
        const text = String(args.text ?? '');
        await cdp(wc, 'Input.insertText', { text });
        // a field that did not take it (an odd editor): set its value the way frameworks notice
        if (args.ref != null) await wc.executeJavaScript(`(() => { const e = document.querySelector('[data-sref="${Number(args.ref)}"]'); const t = ${JSON.stringify(text)}; if (!e || !('value' in e) || String(e.value).includes(t)) return; const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value')?.set; set ? set.call(e, t) : (e.value = t); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`, true).catch(() => {});
        if (args.submit) await key(wc, 'Enter');
        await settle(wc); await guard(); return read(t);
      }
      case 'press': {
        const name = String(args.key || '');
        if (!name) throw new Error('Name a key, like Enter, Tab, Escape, ArrowDown.');
        await key(wc, name);
        await settle(wc); await guard(); return read(t);
      }
      case 'scroll': {
        const [w, h] = [t.view.getBounds().width || 800, t.view.getBounds().height || 600];
        await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(w / 2), y: Math.round(h / 2), deltaX: 0, deltaY: (args.direction === 'up' ? -1 : 1) * Math.round(h * 0.8) });
        await settle(wc, 300); return read(t);
      }
      case 'back': wc.navigationHistory.goBack(); await settle(wc); await guard(); return read(t);
      case 'forward': wc.navigationHistory.goForward(); await settle(wc); await guard(); return read(t);
      case 'logins': return { site: originOf(wc.getURL()), logins: loginsHere(wc.getURL()).map((l) => l.user), note: 'Use action "login" (with user, if there are several) to sign in; you never see the password.' };
      case 'login': {
        if (!vault?.available()) throw new Error('The user has no vault set up (vault login set SITE USER), so there are no saved logins.');
        const origin = originOf(wc.getURL());
        if (!origin) throw new Error('Open the site\'s sign-in page first.');
        await guard();
        const login = pickLogin(wc.getURL(), args.user);
        if (!login) throw new Error(loginsHere(wc.getURL()).length ? `Several logins fit; pass user (one of: ${loginsHere(wc.getURL()).map((l) => l.user).join(', ')}).` : `The user's vault has no login for ${new URL(origin).hostname}. Ask them to add one (vault login set ${new URL(origin).hostname} USER) or to sign in themselves in the browser panel.`);
        const ok = await ask(id, origin, login);
        if (ok === null) throw new Error('The user has not answered whether you may sign in yet. Ask them in chat to allow it in Synapse\'s browser panel.');
        if (!ok) throw new Error('The user did not allow signing in.');
        const done = await fillLogin(wc, login, args.submit !== false);
        await settle(wc, 600);
        return { signedInAs: login.user, ...done, page: await read(t) };
      }
      case 'select_tab': { if (!a.tabs.some((x) => x.id === args.tab)) throw new Error('No such tab. Action "tabs" lists them.'); a.active = args.tab; place(); return read(tabOf(a)); }
      case 'close_tab': closeTab(id, args.tab || t.id); return agentAct(id, 'status');
      default: throw new Error(`Unknown action "${action}". Use open, read, click, type, press, scroll, back, forward, screenshot, login, logins, new_tab, tabs, select_tab, close_tab, status.`);
    }
  }
  const read = async (t) => ({ tab: t.id, ...(await t.view.webContents.executeJavaScript(READ, true).catch((e) => ({ url: t.view.webContents.getURL(), error: e.message }))) });

  // ------------------------------------------------------------ the local endpoint
  function start() {
    server = http.createServer(async (req, res) => {
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method !== 'POST' || req.url !== '/act' || req.headers.authorization !== `Bearer ${token}`) return send(403, { error: 'Not allowed.' });
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e6) return send(413, { error: 'Too big.' }); }
      try {
        const { agent, action, args } = JSON.parse(raw || '{}');
        if (!agent || typeof agent !== 'string') return send(400, { error: 'Synapse could not tell which agent you are.' });
        send(200, { value: await agentAct(agent, String(action || ''), args || {}) });
      } catch (e) { send(200, { error: e.message }); }
    });
    server.listen(0, '127.0.0.1', () => {
      fs.writeFileSync(FILE, JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600 });
      fs.chmodSync(FILE, 0o600);
    });
    ses().setPermissionRequestHandler((_wc, permission, cb) => cb(['clipboard-sanitized-write', 'fullscreen'].includes(permission)));
  }
  function stop() { try { server?.close(); } catch {} try { fs.unlinkSync(TABS); } catch {} try { const f = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (f.pid === process.pid) fs.unlinkSync(FILE); } catch {} }

  return { start, stop, setBounds, user, answer, snapshot, pop, dock, agentAct };
}
