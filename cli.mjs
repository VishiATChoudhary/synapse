#!/usr/bin/env node
// synapse CLI: lets the agent running this command connect to and talk with other agents.
// Identity comes from the process tree, so it works from any agent's shell tool.
//
//   synapse peers [--all]              who you are linked to (and every live agent with --all)
//   synapse link <agent> [--in|--out]  link with an agent (default: both directions)
//   synapse unlink <agent>
//   synapse read <agent> [--max N]     read an agent's recent conversation (it must share with you)
//   synapse send <agent> <message...>  message a linked agent
//   synapse inbox                      messages sent to you
//   synapse agents                     every live agent
//   synapse rename [agent] <new name>  rename an agent (yourself if no agent given); empty name resets
//   synapse ui                         start the canvas (http://localhost:4747)
import { agentForProcess, listAgents, findAgent, renameAgent } from './lib.mjs';
import * as ops from './ops.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));
const opt = (name, d) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : d; };

function whoami() {
  const forced = process.env.SYNAPSE_AGENT;
  const me = forced ? listAgents().find((a) => a.id === forced || a.name === forced) : agentForProcess(process.ppid);
  if (!me) throw new Error('Could not tell which agent is running this command. Set SYNAPSE_AGENT=<name or id>.');
  return me;
}

try {
  let out;
  switch (cmd) {
    case 'peers': out = ops.peers(whoami(), { all: flags.has('--all') }); break;
    case 'link': out = ops.link(whoami(), args[0], flags.has('--in') ? 'in' : flags.has('--out') ? 'out' : 'both'); break;
    case 'unlink': out = ops.unlink(whoami(), args[0]); break;
    case 'read': out = ops.readContext(whoami(), args[0], Number(opt('--max', 12000))); break;
    case 'send': out = ops.send(whoami(), args[0], args.slice(1).join(' ')); break;
    case 'inbox': out = ops.inbox(whoami()); break;
    case 'ui': await import('./server.mjs'); break;
    case 'rename': {
      // `synapse rename <new name>` renames you; `synapse rename <agent> <new name>` renames that agent
      const target = args.length > 1 ? findAgent(listAgents(), args[0]) : whoami();
      if (!target) throw new Error(`no agent matches "${args[0]}"`);
      out = renameAgent(target, (args.length > 1 ? args.slice(1) : args).join(' '));
      break;
    }
    case 'agents': out = listAgents().map(({ name, id, kind, cwd, status }) => ({ name, id, kind, cwd, status })); break;
    default:
      console.log('usage: synapse ui | peers [--all] | link <agent> [--in|--out] | unlink <agent> | read <agent> | send <agent> <msg> | inbox | agents | rename [agent] <name>');
      process.exit(cmd ? 1 : 0);
  }
  if (cmd === 'ui') { /* server keeps running */ }
  else if (out?.context) console.log(`# ${out.agent.name} (${out.agent.kind}, ${out.agent.cwd})\n\n${out.context}`
    + (out.recentMessagesToYou.length ? `\n\n## Messages it sent you\n${out.recentMessagesToYou.join('\n---\n')}` : ''));
  else console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(`synapse: ${e.message}`);
  process.exit(1);
}
