// Process and transcript discovery runs off the HTTP thread, including on large workspaces.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { FILES, readJSON, listAgents, readAgentMessages, projectOf, projectOfAgent, transcriptFile, colorOf, unwrapPaste } from './lib.mjs';
import { all as waitingAll } from './waiting.mjs';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function discoverProjects() {
  const groups = new Map();
  const c = readJSON(FILES.app, {});
  for (const ws of (c.workspaces || [])) {
    if (!fs.existsSync(ws)) continue;
    const p = projectOf(ws);
    let g = groups.get(p.key);
    if (!g) { g = { key: p.key, label: p.label, path: p.key.startsWith('project:') ? ws : p.key, color: colorOf(p.key), worktrees: [] }; groups.set(p.key, g); }
    let branch = '';
    try { branch = git(ws, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch {}
    let real = ws;
    try { real = fs.realpathSync(ws); } catch {}
    g.worktrees.push({ path: ws, branch, name: c.worktreeNames?.[ws] || path.basename(ws), home: ws === g.path || real === g.path, // the repo's own folder, not a worktree
      protected: (c.protected || []).includes(ws) });
  }
  // the order they were dragged into in the sidebar, then the rest by name
  const order = c.projectOrder || [];
  // a repo's own folder used to be keyed project:<name>; an order saved then still counts
  const rank = (g) => { let i = order.indexOf(g.key); if (i < 0) i = order.indexOf(`project:${path.basename(g.key)}`); return i < 0 ? Infinity : i; };
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

// A session's title, like a chat app's thread name: Claude Code's own aiTitle (its newest), else the first
// thing you asked. Read from the transcript's tail and head only, so a large transcript costs the same.
function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(length); const n = fs.readSync(fd, buf, 0, length, start); return buf.toString('utf8', 0, n); }
  finally { fs.closeSync(fd); }
}
const clip = (text) => {
  const line = String(text).replace(/\s+/g, ' ').trim();
  if (line.length <= 64) return line;
  const cut = line.slice(0, 64); const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
};
const ownWords = (text) => typeof text === 'string' && text.trim() && !/^\s*(<|#\s*AGENTS\.md|\[Request interrupted|Caveat:)/.test(text);
// the model a session runs, from its newest transcript entry: claude-opus-5-5 reads "Opus 5.5"
export function modelName(id) {
  const m = String(id || '').match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  return String(id || '').replace(/^gpt-/i, 'GPT-').slice(0, 40);
}
export function transcriptModel(file) {
  const size = fs.statSync(file).size;
  const tail = readSlice(file, Math.max(0, size - 256_000), Math.min(size, 256_000));
  const said = [...tail.matchAll(/"model":"((?:claude|gpt|o\d)[\w.-]{0,40})"/g)].at(-1);
  // /model in Claude Code logs "Set model to `Sonnet 5.5`" right away; its next reply would only say so later
  const set = [...tail.matchAll(/Set model to (?:\\?["`])?([^`"\\<\n]{1,40}?)(?:\\?["`]|\s+and\b|<)/g)].at(-1);
  if (set && (!said || set.index > said.index)) { const name = set[1].trim(); return name.match(/\(([^)]+)\)/)?.[1] || name; }
  return said ? said[1] : '';
}
// What a Claude Code session still waits on in the background: commands it ran in the background and monitors that
// have not reported back yet (a task notification ends each), and a scheduled wake-up (/loop) that is still ahead.
// Tasks from before this process started died with the old one.
export function transcriptWatching(file, startedAt = 0, now = Date.now()) {
  const size = fs.statSync(file).size;
  const tail = readSlice(file, Math.max(0, size - 2_000_000), Math.min(size, 2_000_000));
  const uses = new Map(), tasks = new Map();
  let wake = null;
  for (const line of tail.split('\n')) {
    if (!/run_in_background|"Monitor"|backgroundTaskId|"taskId"|task-notification|ScheduleWakeup|"TaskStop"/.test(line)) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const at = Date.parse(o.timestamp || '') || 0;
    const content = o.message?.content;
    if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== 'tool_use') continue;
        const input = b.input || {};
        if (input.run_in_background || b.name === 'Monitor') uses.set(b.id, String(input.description || input.command || b.name).replace(/\s+/g, ' ').slice(0, 120));
        if (b.name === 'ScheduleWakeup') wake = input.stop ? null : { at: at + Number(input.delaySeconds || 0) * 1000, reason: String(input.reason || '').slice(0, 160) };
        if (b.name === 'TaskStop') { const id = input.task_id || input.taskId || input.id; if (id) tasks.delete(String(id)); }
      }
    }
    if (o.type === 'user') {
      const r = o.toolUseResult, id = r && typeof r === 'object' ? (r.backgroundTaskId || r.taskId || r.task_id) : null;
      const use = Array.isArray(content) ? content.find((b) => b?.type === 'tool_result')?.tool_use_id : null;
      if (id && use && uses.has(use) && at >= startedAt - 5000) tasks.set(String(id), { label: uses.get(use), since: at });
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => b?.text || '').join('\n') : '';
      for (const m of text.matchAll(/<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g)) if (m[2].trim() !== 'running') tasks.delete(m[1].trim());
      // the wake-up came (its prompt arrives as a user turn)
      if (wake && at >= wake.at - 1000 && typeof content === 'string') wake = null;
    }
  }
  return { background: [...tasks.values()].sort((a, b) => a.since - b.since), wake: wake && wake.at > now - 60_000 ? wake : null };
}
export function transcriptTitle(file) {
  const size = fs.statSync(file).size;
  const tail = readSlice(file, Math.max(0, size - 512_000), Math.min(size, 512_000));
  const titles = [...tail.matchAll(/"aiTitle":"((?:[^"\\]|\\.){1,200})"/g)];
  if (titles.length) { try { return clip(JSON.parse(`"${titles.at(-1)[1]}"`)); } catch {} }
  const head = readSlice(file, 0, Math.min(size, 256_000));
  for (const line of head.split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.aiTitle) return clip(o.aiTitle);
    let text = null;
    if (o.type === 'user' && !o.isMeta) {
      const c = o.message?.content;
      text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x?.type === 'text')?.text : null;
    } else if (o.type === 'response_item' && o.payload?.role === 'user') {
      text = o.payload.content?.map((x) => x?.text).find(ownWords);
    } else if (o.type === 'event_msg' && o.payload?.type === 'user_message') text = o.payload.message;
    if (text) text = unwrapPaste(text).trim();
    if (ownWords(text)) return clip(text);
  }
  return '';
}

if (!isMainThread) {
  const previews = new Map();
  parentPort.on('message', () => {
    try {
      let waits = {}; try { waits = waitingAll(); } catch {}
      const agents = listAgents().map((agent) => {
        let lastActivity = agent.updatedAt || agent.startedAt || 0;
        let preview = '', title = '', model = '', watch = null;
        try {
          const file = transcriptFile(agent);
          const mtime = agent.format === 'demo' ? lastActivity : file && fs.statSync(file).mtimeMs;
          if (mtime) {
            lastActivity = Math.max(lastActivity, mtime);
            if (previews.get(agent.id)?.mtime !== mtime) {
              const { messages } = readAgentMessages(agent, null, { tailBytes: 120_000, minMessages: 1 });
              const last = [...messages].reverse().find((message) => !message.tool);
              const preview = last?.text
                .replace(/```[\s\S]*?(?:```|$)/g, ' Code snippet. ')
                .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/gm, '')
                .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                .replace(/(\*\*|__|`)/g, '')
                .replace(/\*([^*\n]+)\*/g, '$1')
                .replace(/\s+/g, ' ').trim().slice(0, 180) || '';
              let title = previews.get(agent.id)?.title || '';
              if (agent.format !== 'demo' && (!title || Date.now() - (previews.get(agent.id)?.titledAt || 0) > 60_000)) {
                try { title = transcriptTitle(file); } catch {}
                previews.set(agent.id, { mtime, preview, title, titledAt: Date.now() });
              } else previews.set(agent.id, { ...previews.get(agent.id), mtime, preview, title });
              let model = ''; try { model = transcriptModel(file); } catch {}
              previews.get(agent.id).model = model;
              let watch = null; try { if (agent.kind === 'claude' && agent.format !== 'demo') watch = transcriptWatching(file, agent.startedAt || 0); } catch {}
              previews.get(agent.id).watch = watch;
            }
            preview = previews.get(agent.id)?.preview || ''; title = agent.title || previews.get(agent.id)?.title || ''; model = previews.get(agent.id)?.model || ''; watch = previews.get(agent.id)?.watch || null;
          }
        } catch { /* A session may exit while its transcript is being scanned. */ }
        const project = projectOfAgent(agent), wt = project.worktree;
        return { ...agent, project: project.label, projectKey: project.key, color: colorOf(project.key), projectAuto: project.autoLabel, frameKey: wt ? `${project.key}#${wt.path}` : project.key, frame: wt ? `${project.label} / ${wt.name}` : project.label, frameSub: wt?.name || null, worktreePath: wt?.path || (project.key.startsWith('project:') ? agent.cwd : project.key), worktreeName: wt?.name || 'Main checkout', worktreeHome: !wt, lastActivity, preview, title, model, modelName: model ? modelName(model) : '', background: watch?.background || [], wake: watch?.wake || null, waiting: waits[agent.id] || null };
      });
      const live = new Set(agents.map((agent) => agent.id));
      for (const id of previews.keys()) if (!live.has(id)) previews.delete(id);
      parentPort.postMessage({ agents, projects: workerData?.projects ? discoverProjects() : [] });
    } catch (error) { parentPort.postMessage({ error: error.message }); }
  });
}

export function createDiscovery(options = {}) {
  const worker = new Worker(new URL(import.meta.url), { workerData: options });
  let agents = [], projects = [], pending = null, resolve, reject;
  worker.on('message', (result) => {
    pending = null;
    if (result.error) reject(new Error(result.error));
    else { agents = result.agents; projects = result.projects; resolve(agents); }
  });
  worker.on('error', (error) => { pending = null; reject?.(error); });
  return {
    get agents() { return agents; },
    get projects() { return projects; },
    refresh() {
      if (!pending) {
        pending = new Promise((yes, no) => { resolve = yes; reject = no; });
        worker.postMessage('scan');
      }
      return pending;
    },
    close() { return worker.terminate(); },
  };
}
