#!/usr/bin/env node
// Synapse MCP server (stdio, JSON-RPC 2.0, no dependencies). Works with any MCP-capable agent:
// Claude Code, Codex, Amp, OpenCode, Copilot CLI, Gemini CLI.
import readline from 'node:readline';
import { agentForProcess } from './lib.mjs';
import * as ops from './ops.mjs';
import * as remote from './remote.mjs';
import * as account from './account.mjs';

const INSTRUCTIONS = `Synapse connects you to other coding agents running on this machine (Claude, Codex, Gemini, ...),
and to agents on friends' machines that they share with you (multiplayer; those show an "owner" and can only be read).
The user links agents on the Synapse canvas, or you can link yourself with synapse_link.
- Call synapse_inbox at the start of each task and after finishing a step: other agents may have messaged you.
- Use synapse_peers to see who you are linked to, synapse_read to read a linked agent's recent work,
  and synapse_send to ask or tell a linked agent something.
- To get context from an agent on someone else's machine: synapse_people lists the user's trusted people,
  synapse_request asks one of them to share an agent with you (they accept or deny in their Synapse app),
  synapse_requests shows the answer. Once accepted, read it with synapse_read name@owner.`;

const agentArg = { type: 'string', description: 'Agent name or id (prefix is fine)' };
const TOOLS = [
  { name: 'synapse_peers', description: 'Show which agents you are linked to. Set all=true to list every live agent.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } }, run: (me, a) => ops.peers(me, a) },
  { name: 'synapse_link', description: 'Link yourself with another agent. direction: "in" (it shares with you), "out" (you share with it) or "both" (default).',
    inputSchema: { type: 'object', properties: { agent: agentArg, direction: { type: 'string', enum: ['in', 'out', 'both'] } }, required: ['agent'] },
    run: (me, a) => ops.link(me, a.agent, a.direction) },
  { name: 'synapse_unlink', description: 'Remove links between you and an agent.',
    inputSchema: { type: 'object', properties: { agent: agentArg }, required: ['agent'] }, run: (me, a) => ops.unlink(me, a.agent) },
  { name: 'synapse_read', description: 'Read the recent conversation of an agent that shares context with you.',
    inputSchema: { type: 'object', properties: { agent: agentArg, max_chars: { type: 'number' } }, required: ['agent'] },
    run: (me, a) => ops.readContext(me, a.agent, a.max_chars) },
  { name: 'synapse_send', description: 'Send a message to an agent you are linked with.',
    inputSchema: { type: 'object', properties: { agent: agentArg, message: { type: 'string' } }, required: ['agent', 'message'] },
    run: (me, a) => ops.send(me, a.agent, a.message) },
  { name: 'synapse_inbox', description: 'Fetch messages other agents sent you (each is returned once).',
    inputSchema: { type: 'object', properties: {} }, run: (me) => ops.inbox(me) },
  { name: 'synapse_people', description: "List the user's trusted people (Synapse accounts you can send a synapse request to, once they trust the user back).",
    inputSchema: { type: 'object', properties: {} }, run: () => people() },
  { name: 'synapse_request', description: "Ask a trusted person to share one of their agents' context with you. They accept or deny in their Synapse app.",
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', description: 'Trusted person: handle, @handle, email or name' },
      target: { type: 'string', description: 'Which of their agents, in words (e.g. "the api agent", "auth refactor")' },
      note: { type: 'string', description: 'Why you need it, shown to them' } }, required: ['to'] },
    run: async (me, a) => {
      const r = await account.sendRequest({ to: a.to, agent: me, target: a.target, note: a.note });
      return { request: r.id, to: r.to?.name || r.to?.handle || a.to, status: r.status,
        next: `Sent. Wait for ${r.to?.name || a.to} to accept in their Synapse app (check with synapse_requests). Once accepted, their agent shows up in synapse_peers with an owner and you read it with synapse_read <name>@<owner>.` };
    } },
  { name: 'synapse_requests', description: 'Status of synapse requests you sent and received.',
    inputSchema: { type: 'object', properties: {} }, run: () => account.requests().then(({ incoming, outgoing }) => ({
      outgoing: outgoing.map((r) => ({ id: r.id, to: r.to?.name || r.to?.handle, agent: r.agent?.name, status: r.status, shared: (r.shared || []).map((x) => x.name) })),
      incoming: incoming.map((r) => ({ id: r.id, from: r.from?.name || r.from?.handle, agent: r.agent?.name, target: r.target, status: r.status, note: 'The user accepts or denies this in the Synapse app.' })),
    })) },
];

async function people() {
  const online = new Map(remote.friends().friends.map((f) => [f.name.toLowerCase(), f]));
  return (await account.trusted()).map((p) => {
    const f = online.get(String(p.name || '').toLowerCase()) || online.get(String(p.handle || '').toLowerCase());
    return { handle: p.handle, name: p.name, ...(p.pending ? { pending: 'invited, no account yet' } : {}), connected: !!f, online: !!f?.online, agentsSharedWithYou: f?.sharingWithYou || 0 };
  });
}

let me = null;
const self = () => {
  if (!me) me = agentForProcess(process.ppid);
  if (!me) throw new Error('Synapse could not identify this agent from the process tree.');
  return me;
};

const write = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined) return; // notification
  try {
    if (method === 'initialize') {
      return write({ id, result: {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'synapse', version: '0.2.0' },
        instructions: INSTRUCTIONS,
      } });
    }
    if (method === 'ping') return write({ id, result: {} });
    if (method === 'tools/list') return write({ id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return write({ id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
      try {
        const me = self();
        // a friend's agent: fetch what their machine sent since the last sync before reading it
        if (tool.name === 'synapse_read' && remote.isConnected()) await remote.sync({ timeout: 4000 }).catch(() => {});
        const out = await tool.run(me, params.arguments || {});
        const text = typeof out?.context === 'string'
          ? `# ${out.agent.name} (${out.agent.kind}, ${out.agent.cwd})\n\n${out.context}`
          : JSON.stringify(out, null, 2);
        return write({ id, result: { content: [{ type: 'text', text }] } });
      } catch (e) {
        return write({ id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
      }
    }
    write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    write({ id, error: { code: -32603, message: e.message } });
  }
});
