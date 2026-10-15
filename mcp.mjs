#!/usr/bin/env node
// Synapse MCP server (stdio, JSON-RPC 2.0, no dependencies). Works with any MCP-capable agent:
// Claude Code, Codex, Amp, OpenCode, Copilot CLI, Gemini CLI.
import readline from 'node:readline';
import { agentForProcess } from './lib.mjs';
import * as ops from './ops.mjs';

const INSTRUCTIONS = `Synapse connects you to other coding agents running on this machine (Claude, Codex, Gemini, ...).
The user links agents on the Synapse canvas, or you can link yourself with synapse_link.
- Call synapse_inbox at the start of each task and after finishing a step: other agents may have messaged you.
- Use synapse_peers to see who you are linked to, synapse_read to read a linked agent's recent work,
  and synapse_send to ask or tell a linked agent something.`;

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
];

let me = null;
const self = () => {
  if (!me) me = agentForProcess(process.ppid);
  if (!me) throw new Error('Synapse could not identify this agent from the process tree.');
  return me;
};

const write = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
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
        const out = tool.run(self(), params.arguments || {});
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
