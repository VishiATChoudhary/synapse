// Process and transcript discovery runs off the HTTP thread, including on large workspaces.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { FILES, readJSON, listAgents, readAgentMessages, projectOf, projectOfAgent, transcriptFile, colorOf } from './lib.mjs';

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
    g.worktrees.push({ path: ws, branch, name: c.worktreeNames?.[ws] || path.basename(ws), home: ws === g.path || real === g.path }); // the repo's own folder, not a worktree
  }
  // the order they were dragged into in the sidebar, then the rest by name
  const order = c.projectOrder || [];
  // a repo's own folder used to be keyed project:<name>; an order saved then still counts
  const rank = (g) => { let i = order.indexOf(g.key); if (i < 0) i = order.indexOf(`project:${path.basename(g.key)}`); return i < 0 ? Infinity : i; };
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

if (!isMainThread) {
  const previews = new Map();
  parentPort.on('message', () => {
    try {
      const agents = listAgents().map((agent) => {
        let lastActivity = agent.updatedAt || agent.startedAt || 0;
        let preview = '';
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
              previews.set(agent.id, { mtime, preview });
            }
            preview = previews.get(agent.id)?.preview || '';
          }
        } catch { /* A session may exit while its transcript is being scanned. */ }
        const project = projectOfAgent(agent), wt = project.worktree;
        return { ...agent, project: project.label, projectKey: project.key, color: colorOf(project.key), projectAuto: project.autoLabel, frameKey: wt ? `${project.key}#${wt.path}` : project.key, frame: wt ? `${project.label} / ${wt.name}` : project.label, frameSub: wt?.name || null, worktreePath: wt?.path || (project.key.startsWith('project:') ? agent.cwd : project.key), worktreeName: wt?.name || 'Main checkout', worktreeHome: !wt, lastActivity, preview };
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
