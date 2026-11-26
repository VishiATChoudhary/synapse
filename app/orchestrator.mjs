// The orchestrator: one agent (any kind: Claude, Codex, Gemini, ...) pinned at the top of the sidebar that sees
// every session and can start sessions, prompt them, open and close worktrees. It is an ordinary session started in
// its own folder (~/.synapse/orchestrator), whose instruction files tell it the job. Its tools are the synapse_orch_*
// MCP tools (mcp.mjs); they reach the app through a local endpoint whose port and token live in
// ~/.synapse/orchestrator.json, together with the id of the one agent allowed to use them.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const GUIDE = `# Synapse orchestrator

You are the user's orchestrator inside the Synapse app. You sit pinned at the top of their session list. You do not
write code yourself: you keep track of every coding session the user runs and act on them for the user.

Your tools (Synapse MCP server):
- synapse_orch_sessions: every open project, its worktrees, and every session with its status (working, waiting,
  idle, exited), agent kind, project, worktree and last activity. Call it first for any question about the work.
- synapse_orch_read: the recent conversation of one session (by id or name), to answer what it is doing, what it
  decided, whether it is stuck or done.
- synapse_orch_start: start a new session (claude, codex, gemini, ...) in a project or worktree, optionally with a
  first prompt and model.
- synapse_orch_prompt: send a message to a running session, as if the user typed it.
- synapse_orch_close: close a session.
- synapse_orch_worktree_open: open a worktree in a project: a new branch (from a base branch) or an existing one;
  optionally start a session in it right away.
- synapse_orch_worktree_close: delete a worktree. Uncommitted work is committed to its branch first (when safe
  deletion is on), its sessions close, and the folder is removed.

How to work:
- Answer questions about the sessions from what the tools return; read a session before you describe its work.
- Be brief. Name sessions by their name and project.
- Starting, prompting and opening are fine when the user asks. Before closing a session that is working or deleting
  a worktree, say what will happen and get the user's yes, unless they already said exactly that.
- Never work on the user's code in this folder; start or prompt a session to do the work.
`;

export function createOrchestrator({ dataDir, getWin }) {
  const FILE = path.join(dataDir, 'orchestrator.json');
  const DIR = path.join(dataDir, 'orchestrator');
  const token = crypto.randomBytes(24).toString('hex');
  const pending = new Map();
  let server = null, port = 0, agent = null;

  const save = () => {
    if (!port) return;
    fs.writeFileSync(FILE, JSON.stringify({ port, token, pid: process.pid, agent }), { mode: 0o600 });
    try { fs.chmodSync(FILE, 0o600); } catch {}
  };

  // the folder it runs in, with the job written where each agent looks (Claude: CLAUDE.md, Gemini: GEMINI.md,
  // Codex, OpenCode, Amp, Copilot, Cursor: AGENTS.md)
  function folder() {
    fs.mkdirSync(DIR, { recursive: true });
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
      const f = path.join(DIR, name);
      let now = null; try { now = fs.readFileSync(f, 'utf8'); } catch {}
      if (now !== GUIDE) fs.writeFileSync(f, GUIDE);
    }
    return DIR;
  }

  // the renderer runs the action (it owns the sessions); this waits for its answer
  function ask(from, action, args) {
    const w = getWin();
    if (!w || w.isDestroyed()) return Promise.reject(new Error('The Synapse window is closed.'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Synapse did not answer in time.')); }, 120_000);
      pending.set(id, { resolve, reject, timer });
      w.webContents.send('orchestrator:call', { id, agent: from, action, args });
    });
  }
  function reply({ id, value, error }) {
    const p = pending.get(id); if (!p) return;
    clearTimeout(p.timer); pending.delete(id);
    error ? p.reject(new Error(String(error))) : p.resolve(value);
  }

  function start() {
    server = http.createServer(async (req, res) => {
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method !== 'POST' || req.url !== '/act' || req.headers.authorization !== `Bearer ${token}`) return send(403, { error: 'Not allowed.' });
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e6) return send(413, { error: 'Too big.' }); }
      try {
        const { agent: from, action, args } = JSON.parse(raw || '{}');
        if (!agent) return send(200, { error: 'The orchestrator is off. The user turns it on in Synapse (Settings > Agents > Orchestrator).' });
        if (from !== agent) return send(200, { error: 'Only the Synapse orchestrator can use this tool.' });
        send(200, { value: await ask(from, String(action || ''), args || {}) });
      } catch (e) { send(200, { error: e.message }); }
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; save(); });
  }
  function stop() {
    try { server?.close(); } catch {}
    try { const f = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (f.pid === process.pid) fs.unlinkSync(FILE); } catch {}
  }
  // which agent is the orchestrator now (its Synapse id), or null when it is off
  function setAgent(id) { const next = typeof id === 'string' && id ? id.slice(0, 200) : null; if (next !== agent) { agent = next; save(); } }

  return { start, stop, folder, reply, setAgent };
}
