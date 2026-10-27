// The two desktop modes render the same activity data in separate view containers.
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };

export function createActivityView(box, api) {
  let activityAt = 0, loading = null;
  const fmt = (n) => n.toLocaleString('en-US');
  const compact = (n) => n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  // token efficiency: tokens of code you pushed per token your agents read and wrote, a tiny share, so two significant digits
  const pct = (r) => (r ? (100 * r).toLocaleString('en-US', { maximumSignificantDigits: 2 }) : '0') + '%';
  const efficiency = (p) => (p.tokens ? (p.pushed || 0) / p.tokens : 0);
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // 53 weeks of days, Sunday on top, like GitHub's; four shades split at the busiest tenth of active days
  function heatmap(days, unit) {
    const wrap = el('div', 'act-map'), months = el('div', 'act-months'), grid = el('div', 'act-grid');
    const end = new Date(); end.setHours(12, 0, 0, 0);
    const start = new Date(end); start.setDate(start.getDate() - 52 * 7 - end.getDay());
    const vals = Object.values(days).filter(Boolean).sort((x, y) => x - y);
    const hi = vals[Math.floor(vals.length * 0.9)] || 1;
    let col = 0, lastMonth = -1;
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 0) {
        if (d.getMonth() !== lastMonth && col < 51) { const m = el('span', '', d.toLocaleDateString('en-US', { month: 'short' })); m.style.gridArea = `1 / ${col + 1} / 2 / span 3`; months.appendChild(m); lastMonth = d.getMonth(); }
        col++;
      }
      const n = days[dayKey(d)] || 0, cell = el('i', `l${n ? Math.min(4, Math.ceil((4 * n) / hi)) : 0}`);
      cell.title = `${n ? fmt(n) : 'no'} ${n === 1 ? unit.replace(/s$/, '') : unit} · ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
      grid.appendChild(cell);
    }
    const legend = el('div', 'act-legend');
    legend.append(el('span', '', 'less'), ...[0, 1, 2, 3, 4].map((l) => el('i', `l${l}`)), el('span', '', 'more'));
    wrap.append(months, grid, legend);
    return wrap;
  }

  async function drawActivity() {
    if (box.dataset.ready && Date.now() - activityAt < 60_000) return;
    if (!box.dataset.ready) box.replaceChildren(el('div', 'act-loading', 'counting your year…'));
    let a;
    try { a = await api.get(); } catch (e) { if (!box.dataset.ready) box.replaceChildren(el('div', 'act-loading', e.message)); return; }
    activityAt = Date.now(); box.dataset.ready = '1';
    const page = el('div', 'act-page');
    const head = el('div', 'act-head'), lvl = el('div', 'act-level'), bar = el('div', 'act-xp'), fill = el('span');
    fill.style.width = `${Math.round((100 * (a.xp - a.levelFrom)) / (a.levelTo - a.levelFrom))}%`;
    bar.appendChild(fill);
    lvl.append(el('div', 'act-lvl', `level ${a.level}`), bar, el('div', 'act-cap', `${fmt(a.xp)} XP · ${fmt(a.levelTo - a.xp)} to level ${a.level + 1}`));
    head.append(el('div', 'act-title', 'Activity'), lvl);
    const tiles = el('div', 'act-tiles');
    const tile = (n, label, hot) => { const t = el('div', 'act-tile' + (hot ? ' hot' : '')); t.append(el('b', '', n), el('span', '', label)); return t; };
    const codeWord = a.github ? 'contributions' : 'commits';
    tiles.append(
      tile(fmt(a.streak), 'day streak', a.streak > 0),
      tile(fmt(a.longest), 'best streak'),
      tile(fmt(a.totals.code), codeWord),
      tile(fmt(a.totals.claude + a.totals.codex), 'prompts'),
      tile(compact(a.totals.tokens), 'tokens'),
      tile(compact(a.totals.todayTokens), 'tokens today'),
    );
    const section = (title, sub, map) => { const s = el('div', 'act-sec'), h = el('div', 'act-sec-head'); h.append(el('span', 'act-sec-t', title), el('span', 'act-sec-s', sub)); s.append(h, map); return s; };
    const agents = {};
    for (const k of ['claude', 'codex']) for (const [d, n] of Object.entries(a.prompts[k])) agents[d] = (agents[d] || 0) + n;
    const code = a.github
      ? section(`GitHub · @${a.github.login}`, `${fmt(a.totals.code)} contributions in the last year`, heatmap(a.github.days, 'contributions'))
      : section('Commits', `${fmt(a.totals.code)} in your workspaces · sign in to the gh CLI to see GitHub here`, heatmap(a.commits, 'commits'));
    const tokenDays = Object.fromEntries(Object.entries(a.tokens).map(([d, t]) => [d, t.all]));
    const models = el('div', 'act-models'), top = a.models[0]?.tokens || 1;
    for (const m of a.models.slice(0, 8)) {
      const row = el('div', 'act-model'), bar = el('span', 'bar'), fill = el('i');
      fill.style.width = `${Math.max(1, (100 * m.tokens) / top)}%`; bar.appendChild(fill);
      row.append(el('span', 'name', m.name), bar, el('span', 'n', compact(m.tokens)));
      models.appendChild(row);
    }
    const tokens = section('Tokens', `${compact(a.totals.tokens)} read and written · ${compact(a.totals.tokensOut)} written by your agents · ${compact(a.totals.weekPushed)} pushed in code this week, ${pct(efficiency({ pushed: a.totals.weekPushed, tokens: a.totals.weekTokens }))} efficiency`, heatmap(tokenDays, 'tokens'));
    if (a.models.length) tokens.appendChild(models);
    const badges = el('div', 'act-badges');
    for (const b of a.badges) { const c = el('div', 'act-badge' + (b.got ? ' got' : '')); c.append(el('b', '', b.name), el('span', '', b.what)); badges.appendChild(c); }
    const friends = section('Friends this week', 'the last 7 days, next to the people you trust', el('div', 'act-board'));
    drawBoard(friends.querySelector('.act-board'));
    page.append(head, tiles, friends, code,
      section('Agents', `${fmt(a.totals.claude)} prompts to Claude · ${fmt(a.totals.codex)} to Codex`, heatmap(agents, 'prompts')),
      tokens,
      section('Badges', `${a.badges.filter((b) => b.got).length} of ${a.badges.length}`, badges),
      el('div', 'act-foot', 'counted on this Mac from your repos and agent conversations · esc closes'));
    box.replaceChildren(page);
  }
  // the friends board: you and the people you trust both ways who joined, ranked by one number at a time
  let boardBy = 'tokens';
  const BOARD_BY = [['tokens', 'tokens', compact], ['efficiency', 'efficiency', pct, efficiency], ['prompts', 'prompts', fmt], ['activeDays', 'active days', fmt], ['streak', 'streak', fmt]];
  async function drawBoard(box, act) {
    let b;
    try { b = await (act ? api.board[act]() : api.board.get()); } catch (e) { box.replaceChildren(el('div', 'act-board-note', e.message)); return; }
    const note = (text, button, onClick) => {
      const n = el('div', 'act-board-join');
      n.append(el('p', '', text));
      if (button) { const go = el('button', 'btn sig', button); go.onclick = async () => { go.disabled = true; go.textContent = 'counting…'; await drawBoard(box, onClick); }; n.appendChild(go); }
      box.replaceChildren(n);
    };
    if (!b.signedIn) return note('Sign in to Synapse (settings) to compete with the people you trust.');
    if (!b.joined) return note(`See how your week compares with the people you trust. Joining shows them your last 7 days: tokens, tokens of code pushed, prompts, commits, active days and streak.${b.waiting ? ` ${b.waiting} of them ${b.waiting === 1 ? 'is' : 'are'} on the board already.` : ''}`, 'join the board', 'join');
    const [key, , show, of = (p) => p[key] || 0] = BOARD_BY.find((x) => x[0] === boardBy);
    const people = [...b.people].sort((x, y) => of(y) - of(x));
    const top = of(people[0] || {}) || 1;
    const tabs = el('div', 'act-board-by');
    for (const [k, label] of BOARD_BY) { const t = el('button', k === boardBy ? 'on' : '', label); t.onclick = () => { boardBy = k; drawBoard(box); }; tabs.appendChild(t); }
    const list = el('div', 'act-board-list');
    people.forEach((p, i) => {
      const row = el('div', 'act-rank' + (p.me ? ' me' : '') + (i === 0 && people.length > 1 ? ' first' : ''));
      const who = el('div', 'who');
      who.append(el('b', '', p.me ? 'You' : p.name || p.handle), el('span', '', p.handle ? `@${p.handle}` : ''));
      const bar = el('span', 'bar'), fill = el('i');
      fill.style.width = `${Math.max(1.5, (100 * of(p)) / top)}%`; bar.appendChild(fill);
      row.append(el('span', 'pos', String(i + 1)), who, bar, el('span', 'n', show(of(p))));
      list.appendChild(row);
    });
    const foot = el('div', 'act-board-foot');
    if (people.length === 1) foot.appendChild(el('span', '', 'Nobody you trust has joined yet. When they do, they show up here.'));
    const leave = el('button', 'act-board-leave', 'leave the board');
    leave.onclick = () => drawBoard(box, 'leave');
    foot.appendChild(leave);
    box.replaceChildren(tabs, list, foot);
  }

  return {
    refresh() {
      if (!loading) loading = drawActivity().finally(() => { loading = null; });
      return loading;
    },
    progress({ done, total }) {
      const label = box.querySelector('.act-loading');
      if (label) label.textContent = `counting your year · ${done} of ${total} conversations`;
    },
  };
}
