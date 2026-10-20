// The activity view's numbers, per local day over the last 53 weeks: GitHub contributions (through the gh CLI,
// when it is signed in), commits you made in your workspaces, and the prompts you typed to Claude and Codex.
// Transcripts run to gigabytes, so each file's day counts are cached by size and mtime and only changed files are read.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const WINDOW = 371 * 86400_000; // 53 weeks, what the heatmap shows
const pad = (n) => String(n).padStart(2, '0');
export const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const bump = (days, ms, n = 1) => { if (Number.isFinite(ms)) { const k = dayOf(ms); days[k] = (days[k] || 0) + n; } };

function* walk(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith('.jsonl')) yield p;
  }
}

// One prompt per line you typed: Claude's user lines that are not tool results, meta, subagents or command echoes;
// Codex's user messages (every version writes these; older ones also add user_message events, which would count
// twice). Cheap string checks first, JSON only for the lines that may count.
export function promptAt(kind, line) {
  if (kind === 'claude') {
    if (!line.includes('"type":"user"') || line.includes('"tool_result"') || line.includes('"isMeta":true') || line.includes('"isSidechain":true')) return null;
    let e; try { e = JSON.parse(line); } catch { return null; }
    if (e.type !== 'user') return null;
    const c = e.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('') : '';
    if (!text.trim() || text.trimStart().startsWith('<')) return null;
    return Date.parse(e.timestamp);
  }
  if (!line.includes('"role":"user"') || !line.startsWith('{"timestamp"') || line.includes('"type":"compacted"')) return null;
  let e; try { e = JSON.parse(line); } catch { return null; }
  const p = e.payload;
  if (e.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user') return null;
  const text = (p.content || []).filter((b) => b?.type === 'input_text').map((b) => b.text).join('').trimStart();
  return text && !text.startsWith('<') && !text.startsWith('# AGENTS.md') ? Date.parse(e.timestamp) : null;
}

// One file's prompts and tokens. Claude keys both by id: a forked session copies its parent's lines into a new
// file, and a reply's usage repeats on each of its lines, so the totals count each id once across all files.
// Codex reports a running total per session; each step's growth is that step's tokens. "all" is every token the
// model read or wrote (cache reads included), "out" what it wrote.
async function countFile(kind, file, since) {
  const r = { prompts: {}, msgs: {}, days: {}, tokens: {}, models: {} };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let model = 'codex', prev = { all: 0, out: 0 };
  for await (const line of rl) {
    const at = promptAt(kind, line);
    if (at >= since) {
      const id = kind === 'claude' && line.match(/"uuid":"([^"]+)"/)?.[1];
      if (id) r.prompts[id] = dayOf(at); else bump(r.days, at);
      continue;
    }
    if (kind === 'claude') {
      if (!line.includes('"usage"') || !line.includes('"type":"assistant"')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const m = e.message, u = m?.usage, ts = Date.parse(e.timestamp);
      if (e.type !== 'assistant' || !u || !m.id || !(ts >= since) || m.model === '<synthetic>') continue;
      const out = u.output_tokens || 0;
      r.msgs[m.id] = [dayOf(ts), (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + out, out, m.model || 'claude'];
    } else if (line.includes('"turn_context"')) {
      try { const e = JSON.parse(line); if (e.type === 'turn_context' && e.payload?.model) model = e.payload.model; } catch {}
    } else if (line.includes('"token_count"')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      const t = e.payload?.info?.total_token_usage; if (e.payload?.type !== 'token_count' || !t) continue;
      const all = t.total_tokens || 0, out = (t.output_tokens || 0);
      const d = { all: Math.max(0, all - prev.all), out: Math.max(0, out - prev.out) }; prev = { all, out };
      const ts = Date.parse(e.timestamp);
      if (!(ts >= since) || !d.all) continue;
      const k = dayOf(ts), day = (r.tokens[k] ||= { all: 0, out: 0 });
      day.all += d.all; day.out += d.out;
      r.models[model] = (r.models[model] || 0) + d.all;
    }
  }
  return r;
}

const CACHE_VERSION = 2;
async function transcripts({ homes, cache, since, onProgress }) {
  const files = [];
  for (const [kind, dir] of Object.entries(homes)) for (const f of walk(dir)) files.push([kind, f]);
  const prompts = { claude: {}, codex: {} }, tokens = {}, models = {}, seen = {}, ids = new Set();
  const addTokens = (day, all, out, model) => {
    const t = (tokens[day] ||= { all: 0, out: 0 }); t.all += all; t.out += out;
    models[model] = (models[model] || 0) + all;
  };
  let done = 0;
  for (const [kind, f] of files) {
    done++;
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs < since) continue;
    let hit = cache[f];
    if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) {
      try { hit = { size: st.size, mtimeMs: st.mtimeMs, ...(await countFile(kind, f, since)) }; } catch { continue; }
      cache[f] = hit;
      if (onProgress && done % 25 === 0) onProgress({ done, total: files.length });
    }
    seen[f] = hit;
    const p = prompts[kind];
    for (const [d, n] of Object.entries(hit.days)) p[d] = (p[d] || 0) + n;
    for (const [id, d] of Object.entries(hit.prompts)) if (!ids.has(id)) { ids.add(id); p[d] = (p[d] || 0) + 1; }
    for (const [id, [d, all, out, model]] of Object.entries(hit.msgs)) if (!ids.has(id)) { ids.add(id); addTokens(d, all, out, model); }
    for (const [d, t] of Object.entries(hit.tokens)) addTokens(d, t.all, t.out, null);
    for (const [model, n] of Object.entries(hit.models)) models[model] = (models[model] || 0) + n;
  }
  delete models.null;
  return { prompts, tokens, models, cache: seen, files: files.length };
}

// Commits in the workspaces' repos by any of your git emails, each commit once however many worktrees share it.
async function commits({ repos, since }) {
  const run = (cwd, args) => exec('git', ['-C', cwd, ...args], { timeout: 20000, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.trim(), () => '');
  const emails = new Set([(await run(os.homedir(), ['config', '--global', 'user.email'])).toLowerCase()].filter(Boolean));
  const common = new Map();
  for (const r of repos) {
    const dir = await run(r, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (dir && !common.has(dir)) common.set(dir, r);
    const mine = (await run(r, ['config', 'user.email'])).toLowerCase(); if (mine) emails.add(mine);
  }
  const days = {}, hashes = new Set();
  for (const r of common.values()) {
    const log = await run(r, ['log', '--all', '--no-merges', `--since=${new Date(since).toISOString()}`, '--format=%H%x09%ae%x09%at']);
    for (const l of log.split('\n')) {
      const [h, email, at] = l.split('\t');
      if (!h || hashes.has(h) || !emails.has((email || '').toLowerCase())) continue;
      hashes.add(h); bump(days, Number(at) * 1000);
    }
  }
  return days;
}

const QUERY = 'query{viewer{login contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}';
async function github(env) {
  try {
    const { stdout } = await exec('gh', ['api', 'graphql', '-f', `query=${QUERY}`], { timeout: 20000, env: { ...env, GH_PROMPT_DISABLED: '1' } });
    const v = JSON.parse(stdout).data.viewer, days = {};
    for (const w of v.contributionsCollection.contributionCalendar.weeks) for (const d of w.contributionDays) if (d.contributionCount) days[d.date] = d.contributionCount;
    return { login: v.login, days };
  } catch { return null; }
}

// Everything the view draws. One scan at a time: a second open while one runs waits for the same result.
let running = null;
export function collect(opts) { return (running ||= scan(opts).finally(() => { running = null; })); }
async function scan({ repos = [], cacheFile, homes = defaultHomes(), env = process.env, now = Date.now(), onProgress, gh = github }) {
  const since = now - WINDOW;
  let cache = {}; try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c.version === CACHE_VERSION) cache = c.files || {}; } catch {}
  const [t, c, g] = await Promise.all([transcripts({ homes, cache, since, onProgress }), commits({ repos, since }), gh(env)]);
  try { fs.writeFileSync(cacheFile, JSON.stringify({ version: CACHE_VERSION, files: t.cache })); } catch {}
  const data = { github: g, commits: c, prompts: t.prompts, tokens: t.tokens, models: t.models, files: t.files };
  return { ...data, ...summarize(data, now) };
}

export function defaultHomes() {
  return { claude: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'), codex: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions') };
}

// The game: a day counts once anything happened in it; code is worth more than a prompt, and every thousand
// tokens your agents wrote is worth a point.
export const levelAt = (xp) => Math.floor(Math.sqrt(xp / 100)) + 1;
export function summarize({ github, commits, prompts, tokens = {}, models = {} }, now = Date.now()) {
  const code = github ? github.days : commits;
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
  const active = (d) => (code[d] || 0) + (commits[d] || 0) + (prompts.claude[d] || 0) + (prompts.codex[d] || 0) > 0;
  const today = dayOf(now), day = (i) => dayOf(now - i * 86400_000);
  let streak = 0;
  for (let i = active(today) ? 0 : 1; active(day(i)); i++) streak++;
  let longest = 0, run = 0;
  for (let i = 370; i >= 0; i--) { run = active(day(i)) ? run + 1 : 0; longest = Math.max(longest, run); }
  const codeTotal = sum(code), promptTotal = sum(prompts.claude) + sum(prompts.codex);
  const tok = Object.values(tokens), tokAll = tok.reduce((a, t) => a + t.all, 0), tokOut = tok.reduce((a, t) => a + t.out, 0);
  const xp = codeTotal * 10 + promptTotal * 2 + Math.floor(tokOut / 1000), level = levelAt(xp);
  const promptDays = new Set([...Object.keys(prompts.claude), ...Object.keys(prompts.codex)]);
  const busiest = Math.max(0, ...[...promptDays].map((d) => (prompts.claude[d] || 0) + (prompts.codex[d] || 0)));
  const badges = [
    ['streak7', 'On a roll', 'active 7 days in a row', longest >= 7],
    ['streak30', 'Unstoppable', 'active 30 days in a row', longest >= 30],
    ['code100', 'Centurion', `100 ${github ? 'contributions' : 'commits'} this year`, codeTotal >= 100],
    ['prompt1k', 'Prompt smith', '1,000 prompts to your agents', promptTotal >= 1000],
    ['prompt10k', 'Agent whisperer', '10,000 prompts to your agents', promptTotal >= 10000],
    ['bigday', 'Big day', '100 prompts in one day', busiest >= 100],
    ['duo', 'Pair of agents', 'Claude and Codex on the same day', Object.keys(prompts.claude).some((d) => prompts.codex[d])],
    ['tok1b', 'Billion club', 'a billion tokens through your agents', tokAll >= 1e9],
    ['tokday', 'Furnace', '100 million tokens in one day', tok.some((t) => t.all >= 1e8)],
    ['out1m', 'Ghostwriter', 'your agents wrote a million tokens', tokOut >= 1e6],
    ['polyglot', 'Polyglot', 'five different models', Object.keys(models).length >= 5],
    ['streak100', 'Centennial', 'active 100 days in a row', longest >= 100],
    ['code10k', 'Machine', `10,000 ${github ? 'contributions' : 'commits'} this year`, codeTotal >= 10000],
    ['prompt25k', 'Conductor', '25,000 prompts to your agents', promptTotal >= 25000],
    ['tok25b', 'Singularity', '25 billion tokens through your agents', tokAll >= 25e9],
  ].map(([id, name, what, got]) => ({ id, name, what, got }));
  return {
    today, streak, longest, xp, level, levelFrom: 100 * (level - 1) ** 2, levelTo: 100 * level ** 2, badges,
    totals: { code: codeTotal, claude: sum(prompts.claude), codex: sum(prompts.codex), todayCode: code[today] || 0, todayPrompts: (prompts.claude[today] || 0) + (prompts.codex[today] || 0), tokens: tokAll, tokensOut: tokOut, todayTokens: tokens[today]?.all || 0 },
    models: Object.entries(models).sort((x, y) => y[1] - x[1]).map(([name, n]) => ({ name, tokens: n })),
  };
}
