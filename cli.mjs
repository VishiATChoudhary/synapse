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
//   synapse rename-project <project> <new name>  rename a project (frame on the canvas); empty name resets
//   synapse ui                         start the canvas (http://localhost:4747)
//
// Multiplayer (agents on a friend's machine):
//   synapse invite [--name me]         print an invite code for a friend
//   synapse join <code> [--name me]    accept a friend's invite
//   synapse friends                    who you are connected with, and whether they are online
//   synapse unfriend <friend>          disconnect from a friend
//   synapse sync                       exchange with friends now (the canvas does this every few seconds)
import { agentForProcess, listAgents, localAgents, findAgent, renameAgent, projectOf, renameProject } from './lib.mjs';
import * as ops from './ops.mjs';
import * as remote from './remote.mjs';

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
    case 'read': {
      const me = whoami();
      if (remote.isConnected()) await remote.sync({ timeout: 4000 }).catch(() => {});
      out = ops.readContext(me, args[0], Number(opt('--max', 12000)));
      break;
    }
    case 'invite': out = await remote.invite({ name: opt('--name') }); break;
    case 'join': out = await remote.join(args[0], { name: opt('--name') }); break;
    case 'friends': out = remote.friends(); break;
    case 'unfriend': out = remote.unfriend(args.join(' ')); break;
    case 'sync': out = await remote.sync(); break;
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
    case 'rename-project': {
      // `synapse rename-project <project> <new name>`: <project> is its current name (case-insensitive)
      const live = new Map(localAgents().map((a) => { const p = projectOf(a.cwd); return [p.key, p]; }));
      const want = String(args[0] || '').toLowerCase();
      const hit = [...live.values()].filter((p) => p.label.toLowerCase() === want || p.autoLabel.toLowerCase() === want);
      if (hit.length !== 1) throw new Error(hit.length ? `"${args[0]}" matches several projects` : `no project is called "${args[0]}"`);
      out = renameProject(hit[0].key, args.slice(1).join(' '));
      break;
    }
    case 'agents': out = listAgents().map(({ name, id, kind, cwd, status }) => ({ name, id, kind, cwd, status })); break;
    default:
      console.log('usage: synapse ui | peers [--all] | link <agent> [--in|--out] | unlink <agent> | read <agent> | send <agent> <msg> | inbox | agents | rename [agent] <name> | rename-project <project> <name> | invite | join <code> | friends | unfriend <friend> | sync');
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
