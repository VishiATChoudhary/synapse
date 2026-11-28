// Process and transcript discovery runs off the HTTP thread, including on large workspaces.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { FILES, readJSON, gitLocate, listAgents, readAgentMessages, projectOf, projectOfAgent, transcriptFile, transcriptTouched, colorOf, unwrapPaste } from './lib.mjs';

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function discoverProjects() {
  const groups = new Map();
  const c = readJSON(FILES.app, {});
  for (const ws of (c.workspaces || [])) {
    if (!fs.existsSync(ws)) continue;
    const p = projectOf(ws);
    let g = groups.get(p.key);
    if (!g) { g = { key: p.key, label: p.label, path: p.key.startsWith('project:') ? ws : p.key, color: colorOf(p.key), worktrees: [] }; groups.set(p.key, g); }
    const branch = gitLocate(ws)?.branch || ''; // read from .git/HEAD: this runs every second for every workspace
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
const ownWords = (text) => typeof text === 'string' && text.trim() && !/^\s*(<|#\s*AGENTS\.md|\[Request interrupted|Caveat:|Synapse: messages from other agents)/.test(text);
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
      const agents = listAgents().map((agent) => {
        let lastActivity = agent.updatedAt || agent.startedAt || 0;
        let preview = '', title = '', model = '';
        try {
          const file = transcriptFile(agent);
          const mtime = agent.format === 'demo' ? lastActivity : file && (transcriptTouched(agent) || fs.statSync(file).mtimeMs); // a SQLite store writes its -wal first
          if (mtime) {
            if (previews.get(agent.id)?.mtime !== mtime) {
              const { messages } = readAgentMessages(agent, null, { tailBytes: 120_000, minMessages: 1 });
              const said = Math.max(0, ...messages.map((m) => Date.parse(m.ts) || 0));
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
              previews.get(agent.id).said = said;
            }
            // last use is the last message in the conversation. Not the file's time (Claude rewrites the transcript
            // when a session is resumed) and not a hook's updatedAt (it moves when Synapse restores the session on a
            // restart): both reset every agent's idle and archive clock. updatedAt counts only while it works or asks.
            if (agent.format !== 'demo') {
              const active = ['busy', 'waiting', 'needs_input'].includes(agent.status);
              lastActivity = Math.max(previews.get(agent.id)?.said || mtime, active ? agent.updatedAt || 0 : 0);
            }
            preview = previews.get(agent.id)?.preview || ''; title = agent.title || previews.get(agent.id)?.title || ''; model = previews.get(agent.id)?.model || '';
          }
        } catch { /* A session may exit while its transcript is being scanned. */ }
        const project = projectOfAgent(agent), wt = project.worktree;
        return { ...agent, project: project.label, projectKey: project.key, color: colorOf(project.key), projectAuto: project.autoLabel, frameKey: wt ? `${project.key}#${wt.path}` : project.key, frame: wt ? `${project.label} / ${wt.name}` : project.label, frameSub: wt?.name || null, worktreePath: wt?.path || (project.key.startsWith('project:') ? agent.cwd : project.key), worktreeName: wt?.name || 'Main checkout', worktreeHome: !wt, lastActivity, preview, title, model, modelName: model ? modelName(model) : '' };
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
