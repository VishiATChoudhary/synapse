// The workspace uses one event stream. Only the selected conversation is fetched and rendered.
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

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
    return escapeHtml(result)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w_])_(?!\s)(.+?)_(?!\w)/g, '$1<em>$2</em>')
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

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.7" cy="10.7" r="6.7"/><path d="m16 16 4.5 4.5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  network: '<rect x="9" y="2" width="6" height="6" rx="1.5"/><rect x="2" y="16" width="6" height="6" rx="1.5"/><rect x="16" y="16" width="6" height="6" rx="1.5"/><path d="M12 8v4M5 16v-4h14v4"/>',
  canvas: '<circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="13" cy="19" r="2.5"/><path d="m7.5 6 9-1M6.5 8l5 8.5M18 7.5l-4 9"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
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
  let desktop = null, rawState = { agents: [], edges: [], messageRevision: 0 }, desktopActive = true;
  const requests = new Map();
  let nextRequest = 0;
  function desktopCall(action, args = {}) {
    if (!embedded) return Promise.reject(new Error('Open the Synapse desktop app to use this action.'));
    const request = String(++nextRequest);
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
    if (!embedded || event.source !== parent || event.origin !== 'null') return;
    const message = event.data;
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
        applyState(rawState);
        if (followSelection && desktop.active && desktop.active !== previous && byId.has(desktop.active)) navigate('session', desktop.active);
      }
    }
    if (message?.type === 'synapse:desktop-visibility') {
      desktopActive = message.visible;
      if (desktopActive) applyState(rawState);
    }
  });
  const $ = (id) => document.getElementById(id);
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
  const projectElements = new Map(), sessionElements = new Map(), recentCache = new Map();
  let storedCollapsed;
  try { storedCollapsed = JSON.parse(getStorage('synapse-collapsed', '[]')); } catch {}
  const collapsed = new Set(Array.isArray(storedCollapsed) ? storedCollapsed : []);
  let sending = false, recentController, recentRequest = 0, recentTarget, recentDirty = false, limit = 60;
  let source, stateFrame = 0, pendingState, toastTimer, draftTimer, flowTimer;
  let modalSubmit = null, modalVersion = 0, searchHits = [], searchIndex = 0, renderedMessages = new Map();
  let overviewSignature = '', connectionsSignature = '', inspectorSignature = '';

  function readRoute() {
    const route = location.hash.slice(1);
    if (route === 'overview' || route === 'connections') view = route;
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
    if (selectedId) drafts[selectedId] = $('message-input').value;
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
    const groups = new Map((desktop?.projects || []).map((p) => [p.key, { key: p.key, name: p.label, agents: [] }]));
    for (const agent of state.agents) {
      if (!groups.has(agent.projectKey)) groups.set(agent.projectKey, { key: agent.projectKey, name: agent.project, agents: [] });
      groups.get(agent.projectKey).agents.push(agent);
    }
    const order = new Map((desktop?.projects || []).map((p, i) => [p.key, i]));
    return [...groups.values()].sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity) || a.name.localeCompare(b.name));
  }

  function renderSidebar() {
    const groups = projectGroups(), desired = [], live = new Set();
    for (const group of groups) {
      let section = projectElements.get(group.key);
      if (!section) {
        section = document.createElement('section');
        section.className = 'project-group';
        section.innerHTML = `<div class="project-heading"><button class="project-button" type="button"><span class="project-chevron">${icon('chevron-down')}</span>${icon('folder')}<span class="project-name"></span><span class="count"></span></button><button class="project-add desktop-only" type="button" aria-label="Add worktree" title="Add worktree">${icon('plus')}</button></div><div class="project-sessions"></div>`;
        section.querySelector('.project-button').dataset.project = group.key;
        section.querySelector('.project-add').dataset.createWorktree = group.key;
        projectElements.set(group.key, section);
      }
      const button = section.querySelector('.project-button');
      button.querySelector('.project-name').textContent = group.name;
      button.querySelector('.count').textContent = group.agents.length;
      section.querySelector('.project-add').hidden = !desktop?.projects.some((p) => p.key === group.key);
      button.setAttribute('aria-expanded', String(!collapsed.has(group.key)));
      const container = section.lastElementChild;
      container.hidden = collapsed.has(group.key);
      const rows = group.agents.map((agent) => {
        live.add(agent.id);
        let row = sessionElements.get(agent.id);
        if (!row) {
          row = document.createElement('button'); row.type = 'button'; row.className = 'session-row'; row.dataset.agent = agent.id;
          row.innerHTML = '<span class="status-dot" aria-hidden="true"></span><span class="session-name"></span><span class="session-kind" aria-hidden="true"></span>';
          sessionElements.set(agent.id, row);
        }
        row.querySelector('.status-dot').classList.toggle('busy', agent.status === 'busy');
        if (row.querySelector('.session-name').textContent !== agent.name) row.querySelector('.session-name').textContent = agent.name;
        row.querySelector('.session-kind').textContent = KIND_INITIALS[agent.kind] || '';
        row.classList.toggle('fork-session', !!agent.parent);
        row.title = `${agent.name} · ${kindName(agent)} · ${activityLabel(agent)}`;
        if (view === 'session' && selectedId === agent.id) row.setAttribute('aria-current', 'page'); else row.removeAttribute('aria-current');
        return row;
      });
      syncChildren(container, rows); desired.push(section);
    }
    for (const [id, row] of sessionElements) if (!live.has(id)) { row.remove(); sessionElements.delete(id); }
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

  function navigate(nextView, id = null, push = true) {
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

  function renderMain(reset = false) {
    const agent = byId.get(selectedId), isSession = view === 'session' && agent;
    $('thread-view').hidden = !isSession;
    $('overview-view').hidden = view !== 'overview';
    $('connections-view').hidden = view !== 'connections';
    $('session-actions').hidden = !isSession;
    if (isSession) {
      const breadcrumbs = `<span class="crumb-project">${icon('folder')}</span><span class="crumb-project">${escapeHtml(agent.project)}</span><span class="crumb-divider">${icon('chevron-right')}</span><span>${escapeHtml(agent.name)}</span>`;
      if ($('breadcrumbs').innerHTML !== breadcrumbs) $('breadcrumbs').innerHTML = breadcrumbs;
      $('session-status').innerHTML = `${status(agent)}${activityLabel(agent)}`;
      $('provider-label').textContent = kindName(agent);
      if (embedded) {
        for (const id of ['open-terminal', 'fork-session', 'session-menu']) $(id).hidden = !agent.owned;
        $('fork-session').disabled = !['claude', 'codex'].includes(agent.kind) && !state.demo;
      }
      $('delivery-note').textContent = agent.owned ? 'Sent directly to this session. Open Terminal mode for interactive prompts and approvals.' : 'Delivered on the agent’s next prompt or inbox check.';
      document.querySelector('.composer-channel').innerHTML = icon(agent.owned ? 'monitor' : 'network') + (agent.owned ? 'Live session' : 'Via Synapse');
      $('conversation-tab').setAttribute('aria-selected', String(tab === 'conversation'));
      $('messages-tab').setAttribute('aria-selected', String(tab === 'messages'));
      $('conversation-tab').tabIndex = tab === 'conversation' ? 0 : -1;
      $('messages-tab').tabIndex = tab === 'messages' ? 0 : -1;
      $('thread-scroll').setAttribute('aria-labelledby', tab === 'messages' ? 'messages-tab' : 'conversation-tab');
      if (reset) { $('message-input').value = drafts[selectedId] || ''; $('send-error').hidden = true; }
      updateComposer(); renderTimeline(reset); loadRecent();
      document.title = `${agent.name} · Synapse`;
    } else {
      $('breadcrumbs').textContent = view === 'connections' ? 'Connections' : 'Your workspace';
      document.title = `${view === 'connections' ? 'Connections' : 'Your workspace'} · Synapse`;
      if (view === 'connections') renderConnections(); else renderOverview();
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

  function renderInspector() {
    const agent = byId.get(selectedId); if (!agent) return;
    const peers = relations(agent.id), chat = recentCache.get(agent.id)?.data.chat || [];
    const signature = JSON.stringify([agent.id, agent.name, agent.status, agent.lastActivity, peers, chat.slice(-3), Math.floor(Date.now() / 60000)]);
    if (signature === inspectorSignature) return;
    inspectorSignature = signature;
    $('inspector').innerHTML = `<div class="inspector-heading"><h2>Session details</h2><button class="icon-button" data-action="close-inspector" aria-label="Close session details">${icon('x')}</button></div>
      <section class="inspector-section"><div class="session-summary">${avatar(agent)}<div><strong>${escapeHtml(agent.name)}</strong><span class="session-provider">${escapeHtml(kindName(agent))}</span></div></div><div class="detail-row"><span>Status</span><span class="status-label">${status(agent)}${activityLabel(agent)}</span></div><div class="detail-row"><span>Last activity</span><span>${relativeTime(agent.lastActivity) === 'now' ? 'Just now' : `${relativeTime(agent.lastActivity)} ago`}</span></div><div class="folder-path">${icon('folder')}<span>${escapeHtml(agent.cwd)}</span></div></section>
      <section class="inspector-section"><div class="inspector-title-row"><h3 class="inspector-label">Connected agents</h3><span class="count">${peers.length}</span></div>${peers.map((peer) => `<div class="connection-row">${avatar(peer.agent)}<button class="connection-info" data-agent="${escapeHtml(peer.agent.id)}"><strong>${escapeHtml(peer.agent.name)}</strong><span>${icon(peer.reads && peer.shares ? 'arrows' : peer.reads ? 'arrow-left' : 'arrow-right')}${peer.reads && peer.shares ? 'Two-way context' : peer.reads ? 'Reads context from' : 'Shares context with'}</span></button><button class="icon-button unlink-button" data-remove-links="${peer.edges.map((edge) => escapeHtml(edge.id)).join(',')}" aria-label="Disconnect ${escapeHtml(peer.agent.name)}" title="Disconnect">${icon('unlink')}</button></div>`).join('')}<button class="add-context" data-action="add-connection">${icon('plus')}Add connection</button><p class="inspector-note">Linked agents can share context and message each other across tools.</p></section>
      <section class="inspector-section"><h3 class="inspector-label">Recent messages</h3>${chat.slice(-3).reverse().map((message) => `<div class="recent-note"><strong>${icon('message')}${escapeHtml(message.fromName === 'You' ? 'You' : message.fromName)}</strong><p>${escapeHtml(message.text)}</p></div>`).join('') || '<p class="inspector-note">Messages between agents will appear here.</p>'}${chat.length ? '<button class="text-button" data-action="show-messages">View messages ' + icon('arrow-right') + '</button>' : ''}</section>`;
  }

  function renderConnections() {
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
    $('new-connection').disabled = state.agents.length < 2;
    $('connections-list').innerHTML = pairs.size ? `<div class="connections-explainer">${icon('network')}An arrow points toward the agent receiving context. Two arrows share it both ways.</div>${[...pairs.values()].map((pair) => `<div class="connection-card"><button class="connection-endpoint" data-agent="${escapeHtml(pair.from.id)}">${avatar(pair.from)}<span><strong>${escapeHtml(pair.from.name)}</strong><small>${escapeHtml(kindName(pair.from))}</small></span></button><span class="connection-arrow" aria-label="${pair.edges.length > 1 ? 'Two-way context' : 'Shares context with'}">${icon(pair.edges.length > 1 ? 'arrows' : 'arrow-right')}</span><button class="connection-endpoint" data-agent="${escapeHtml(pair.to.id)}">${avatar(pair.to)}<span><strong>${escapeHtml(pair.to.name)}</strong><small>${escapeHtml(kindName(pair.to))}</small></span></button><button class="icon-button" data-remove-links="${pair.edges.map((edge) => escapeHtml(edge.id)).join(',')}" aria-label="Remove connection between ${escapeHtml(pair.from.name)} and ${escapeHtml(pair.to.name)}" title="Remove connection">${icon('unlink')}</button></div>`).join('')}` : emptyState('Give your agents a little context', 'Connect two live sessions to let them read each other’s work and exchange messages.', state.agents.length > 1 ? 'add-connection' : 'connect', state.agents.length > 1 ? 'Add connection' : 'Connect an agent', 'network');
  }

  function messageRecords(data) {
    const conversation = (data.messages || []).map((message, index) => ({ ...message, type: 'transcript', time: Date.parse(message.ts) || 0, key: `transcript-${message.ts}-${index}-${hash(message.text)}` }));
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
    for (const message of records) {
      const user = message.role === 'user' || message.human, tool = message.tool;
      const messageSignature = `${message.key}:${message.delivered}:${agent.name}`;
      let element = existing.get(message.key);
      if (!element) { element = document.createElement(tool ? 'details' : 'article'); element.dataset.messageKey = message.key; }
      if (element.dataset.signature !== messageSignature) {
        element.dataset.signature = messageSignature;
        const time = message.time ? new Date(message.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        if (tool) {
          element.className = 'tool-message';
          element.innerHTML = `<summary>${icon('tool')}<span>${escapeHtml(message.text.replace(/^\[|\]$/g, ''))}</span>${icon('chevron-down')}</summary><pre>${escapeHtml(message.text)}</pre>`;
        } else {
          element.className = `message ${user ? 'user' : message.type === 'shared' ? 'peer' : 'assistant'}`;
          const name = message.type === 'shared' && !message.human ? `${message.fromName} → ${message.toName}` : kindName(agent);
          const delivery = message.human ? `<span class="queued-label">${icon(message.delivered ? 'check' : 'clock')}${message.delivered ? 'Picked up by agent' : 'Queued for next prompt'}</span>` : '';
          element.innerHTML = `${user ? '' : `<header class="message-head">${avatar(agent)}<span>${escapeHtml(name)}</span>${time ? `<time>${time}</time>` : ''}</header>`}<div class="message-body md">${renderMarkdown(message.text)}</div><footer class="message-foot">${delivery}${user && time ? `<time>${time}</time>` : ''}<button class="icon-button" data-copy-message aria-label="Copy message" title="Copy message">${icon('copy')}</button></footer>`;
        }
      }
      desired.push(element);
    }
    syncChildren(list, desired);
    if (reset || nearBottom) { scroller.scrollTop = scroller.scrollHeight; $('jump-latest').hidden = true; }
    else { scroller.scrollTop = previousTop; $('jump-latest').hidden = false; }
  }

  async function loadRecent(force = false) {
    const agent = byId.get(selectedId); if (view !== 'session' || !agent) return;
    const cached = recentCache.get(agent.id), revision = state.messageRevision, activity = agent.lastActivity;
    if (!force && cached?.activity === activity && cached?.revision === revision && cached?.limit === limit) return;
    if (recentTarget === agent.id) { recentDirty = true; return; }
    recentController?.abort(); recentController = new AbortController();
    const request = ++recentRequest, id = agent.id, requestedLimit = limit;
    recentTarget = id; recentDirty = false;
    try {
      const data = agent.owned && !agent.backendId
        ? await desktopCall('output', { id })
        : await api(`/api/agents/${encodeURIComponent(agent.backendId || id)}/recent?limit=${requestedLimit}`, { signal: recentController.signal });
      if (agent.owned && !data.messages?.length && !data.chat?.length) Object.assign(data, await desktopCall('output', { id }));
      recentCache.delete(id); recentCache.set(id, { data, activity, revision, limit: requestedLimit });
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
    $('send-message').disabled = !agent || agent.exited || !connected || sending || !$('message-input').value.trim();
    $('composer').setAttribute('aria-busy', String(sending));
    $('send-message').innerHTML = sending ? '<span class="spinner" aria-hidden="true"></span>' : icon('arrow-up');
  }

  function resizeComposer() {
    const input = $('message-input'); input.style.height = 'auto'; input.style.height = `${Math.max(52, Math.min(input.scrollHeight, 180))}px`;
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (sending || !connected || !byId.has(selectedId)) return;
    const id = selectedId, text = $('message-input').value.trim(), original = $('message-input').value;
    if (!text) return;
    sending = true; updateComposer(); $('send-error').hidden = true;
    try {
      const agent = byId.get(id);
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
    const field = $('dialog-content').querySelector('input, select, button');
    if (field) field.focus();
  }

  function connectAgent() {
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
      if (current && worktrees.some((w) => w.path === current.cwd)) $('session-folder').value = current.cwd;
      if (Object.hasOwn(desktop.profiles, 'codex')) $('agent-kind').value = 'codex';
      return;
    }
    openModal('Connect an agent', `<p class="dialog-copy">Start a coding agent in your project. Synapse discovers running sessions on this machine automatically.</p><label class="field-label" for="agent-kind">Agent</label><select class="field" id="agent-kind"><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini CLI</option><option value="opencode">OpenCode</option><option value="amp">Amp</option><option value="copilot">Copilot CLI</option></select><div class="command-preview"><code id="launch-command">codex</code><button class="button secondary" type="button" id="copy-launch">Copy</button></div><p class="field-hint">Run this command in your project’s terminal. To enable messaging and shared context, run <code>node install.mjs</code> in your Synapse folder, then restart the agent.</p>`, 'Done');
    $('agent-kind').onchange = () => { $('launch-command').textContent = $('agent-kind').value; $('copy-launch').textContent = 'Copy'; };
    $('copy-launch').onclick = async () => { if (await copyText($('launch-command').textContent)) $('copy-launch').textContent = 'Copied'; };
  }

  function addConnection() {
    const linkable = state.agents.filter((a) => !a.owned || a.backendId);
    if (linkable.length < 2) {
      openModal('One more agent makes a connection', '<p class="dialog-copy">Start a second coding agent, then connect the two sessions here to share context.</p>', 'Done'); return;
    }
    const options = (omit) => linkable.filter((agent) => agent.id !== omit).map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)} · ${escapeHtml(kindName(agent))}</option>`).join('');
    const initial = linkable.some((a) => a.id === selectedId) ? selectedId : linkable[0].id;
    openModal('Connect your agents', `<p class="dialog-copy">Choose which sessions share context. Linked agents can also message each other.</p><label class="field-label" for="link-from">Agent</label><select class="field" id="link-from">${options()}</select><label class="field-label" for="link-to">Connect with</label><select class="field" id="link-to">${options(initial)}</select><label class="field-label" for="link-direction">Share context</label><select class="field" id="link-direction"><option value="both">Both ways</option><option value="out">First agent → second agent</option><option value="in">Second agent → first agent</option></select>`, 'Connect agents', async () => {
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
    if (embedded) { openModal('Your desktop workspace', '<p class="dialog-copy">Start sessions, send prompts, connect agents, and manage worktrees here. GUI and Terminal modes share the same running sessions. Use Terminal mode for agent sign-in, interactive approvals, split panes, and the full fork tree.</p><div class="shortcut-row"><span>Find a session</span><kbd>⌘ K</kbd></div><div class="shortcut-row"><span>New session</span><kbd>⌘ N</kbd></div><div class="shortcut-row"><span>Settings</span><kbd>⌘ ,</kbd></div><p class="field-hint">An agent must receive its first prompt before its transcript can be forked. Claude Code and Codex support native forks.</p>', 'Got it'); return; }
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
    connected = isConnected;
    $('connection-banner').hidden = isConnected;
    $('connection-dot').classList.toggle('offline', !isConnected);
    $('local-status').textContent = isConnected ? `${state.agents.length} ${state.agents.length === 1 ? 'session' : 'sessions'} connected` : ready ? 'Reconnecting…' : 'Connecting…';
    updateComposer();
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

  $('composer').addEventListener('submit', sendMessage);
  $('message-input').addEventListener('input', () => {
    resizeComposer(); updateComposer(); $('send-error').hidden = true; $('message-input').removeAttribute('aria-invalid');
    clearTimeout(draftTimer); draftTimer = setTimeout(persistDraft, 250);
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
  const runDesktop = (action, args = {}) => desktopCall(action, args).catch((e) => toast(e.message));
  $('add-project').onclick = () => runDesktop('add-project');
  $('desktop-activity').onclick = () => runDesktop('activity');
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
  document.querySelector('.canvas-link').addEventListener('click', (event) => { if (embedded) { event.preventDefault(); runDesktop('canvas'); } });
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
    if (button.dataset.agent) return navigate('session', button.dataset.agent);
    if (button.dataset.view) return navigate(button.dataset.view);
    if (button.dataset.searchAgent) { $('search-dialog').close(); return navigate('session', button.dataset.searchAgent); }
    if (button.dataset.project) {
      const key = button.dataset.project; collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
      setStorage('synapse-collapsed', JSON.stringify([...collapsed])); renderSidebar(); return;
    }
    if (button.dataset.filter) { filter = button.dataset.filter; renderOverview(); return; }
    if (button.dataset.tab) { persistDraft(); tab = button.dataset.tab; renderMain(true); return; }
    if (button.dataset.removeLinks) return removeLinks(button.dataset.removeLinks.split(','), button);
    if (button.hasAttribute('data-copy-code')) { if (await copyText(button.closest('.code-block').querySelector('code').textContent)) { button.textContent = 'Copied'; setTimeout(() => { if (button.isConnected) button.textContent = 'Copy code'; }, 2000); } return; }
    if (button.hasAttribute('data-copy-message')) { const message = renderedMessages.get(button.closest('[data-message-key]').dataset.messageKey); if (message && await copyText(message.text)) toast('Message copied.'); return; }
    const action = button.dataset.action;
    if (action === 'connect') connectAgent();
    if (action === 'desktop-terminal') runDesktop('terminal', { id: selectedId });
    if (action === 'add-connection') addConnection();
    if (action === 'close-inspector') { inspectorOpen = false; setStorage('synapse-inspector', 'closed'); syncInspector(); $('context-toggle').focus(); }
    if (action === 'show-messages') { persistDraft(); tab = 'messages'; renderMain(true); }
    if (action === 'show-all') { filter = 'all'; renderOverview(); }
    if (action === 'retry-conversation') loadRecent(true);
    if (action === 'load-older') { limit = Math.min(200, limit + 60); loadRecent(true); }
  });
  document.addEventListener('keydown', (event) => {
    const editing = event.target.matches('input, textarea, select, [contenteditable="true"]');
    if (embedded && (event.metaKey || event.ctrlKey)) {
      const key = event.key.toLowerCase();
      if (key === 'n') { event.preventDefault(); connectAgent(); return; }
      if (key === ',') { event.preventDefault(); runDesktop('settings'); return; }
      if (key === 'b') { event.preventDefault(); setSidebar(!sidebarOpen); return; }
      if (key === 'd') { event.preventDefault(); runDesktop('split', { id: selectedId, direction: event.shiftKey ? 'down' : 'right' }); return; }
      if (key === 'f' && event.shiftKey) { event.preventDefault(); forkSession(); return; }
    }
    if ((event.metaKey || event.ctrlKey) && ['k', 'f'].includes(event.key.toLowerCase())) { event.preventDefault(); openSearch(); return; }
    if (event.key === '/' && !editing && !$('action-dialog').open && !$('search-dialog').open) { event.preventDefault(); openSearch(); }
    if (event.key === 'Escape' && !$('action-dialog').open && !$('search-dialog').open) {
      if (narrow.matches && sidebarOpen) { setSidebar(false, false); $('sidebar-toggle').focus(); }
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
  document.addEventListener('visibilitychange', () => { if (document.hidden) { persistDraft(); source?.close(); } else connectEvents(); });
  setInterval(() => { if (!document.hidden && ready) { if (view === 'overview') renderOverview(); if (inspectorOpen) renderInspector(); } }, 30000);
  updateThemeButton(); setSidebar(sidebarOpen, false); connectEvents();
  if (embedded) parent.postMessage({ type: 'synapse:desktop-ready' }, '*');
}

if (typeof document !== 'undefined') {
  // The desktop server uses an available port on each launch. Keep drafts and preferences
  // with the session store, instead of tying them to a temporary HTTP origin.
  if (parent !== window && new URLSearchParams(location.search).get('desktop') === '1') {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { removeEventListener('message', receive); resolve(); }, 15000);
      function receive(event) {
        if (event.source !== parent || event.origin !== 'null' || event.data?.type !== 'synapse:desktop-bootstrap') return;
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
