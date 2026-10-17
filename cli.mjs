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
//
// Synapse accounts (trusted people and synapse requests, through Synapse Cloud):
//   synapse login [--email e]          sign in (email and password, or the browser for GitHub, Google, X)
//   synapse signup --email e [--name n]   create an account
//   synapse logout | whoami
//   synapse trust <email|@handle>      add a trusted person (people you can send requests to)
//   synapse untrust <who> | people     remove one | list them
//   synapse request <person> [--target "their api agent"] [--note why]   ask to read one of their agents
//   synapse requests                   requests you sent and received
//   synapse accept <id> [--agents a,b] | deny <id> | cancel <id>
import { agentForProcess, listAgents, localAgents, findAgent, renameAgent, projectOf, renameProject } from './lib.mjs';
import * as ops from './ops.mjs';
import * as remote from './remote.mjs';
import * as account from './account.mjs';

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

// a line from the terminal; hidden for passwords (raw mode, nothing echoed)
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const stdin = process.stdin;
    if (!hidden || !stdin.isTTY) {
      let buf = '';
      const onData = (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { stdin.removeListener('data', onData); stdin.pause(); resolve(buf.slice(0, i).trim()); } };
      stdin.setEncoding('utf8'); stdin.on('data', onData); stdin.resume();
      return;
    }
    let buf = '';
    stdin.setRawMode(true); stdin.setEncoding('utf8'); stdin.resume();
    const onData = (ch) => {
      if (ch === '\u0003') process.exit(130);
      if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.removeListener('data', onData); stdin.pause(); process.stderr.write('\n'); return resolve(buf); }
      if (ch === '\u007f') buf = buf.slice(0, -1); else buf += ch;
    };
    stdin.on('data', onData);
  });
}

// sign in with the browser: GitHub, Google, X or email on the website, approved for this machine
async function deviceLogin() {
  const d = await account.deviceStart();
  console.error(`Open ${d.url} and approve this Mac (code ${d.userCode}).`);
  try { (await import('node:child_process')).execFile('open', [d.url], () => {}); } catch {}
  const end = Date.now() + d.expiresIn * 1000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, (d.interval || 2) * 1000));
    const r = await account.devicePoll(d.deviceCode);
    if (r.status === 'approved') return r;
  }
  throw new Error('the sign-in code expired; run synapse login again');
}

const shortRequest = (r) => ({ id: r.id, status: r.status, from: r.from?.handle, to: r.to?.handle, agent: r.agent?.name, target: r.target || undefined, note: r.note || undefined, shared: r.shared?.length ? r.shared.map((a) => a.name) : undefined });

try {
  let out;
  switch (cmd) {
    case 'login': {
      const email = opt('--email') || (flags.has('--browser') ? '' : await ask('Email (leave empty to sign in with the browser: GitHub, Google, X): '));
      if (!email) { out = await deviceLogin(); break; }
      const password = opt('--password') || process.env.SYNAPSE_PASSWORD || await ask('Password: ', { hidden: true });
      out = await account.login({ email, password });
      break;
    }
    case 'signup': {
      const email = opt('--email') || await ask('Email: ');
      const password = opt('--password') || process.env.SYNAPSE_PASSWORD || await ask('Password (8+ characters): ', { hidden: true });
      out = await account.signup({ email, password, name: opt('--name') });
      break;
    }
    case 'logout': out = await account.logout(); break;
    case 'whoami': {
      if (!account.account()) throw new Error('not signed in (synapse login)');
      out = { ...(await account.me()), cloud: account.cloudUrl() };
      break;
    }
    case 'trust': out = await account.trust(args.join(' ')); break;
    case 'untrust': out = await account.untrust(args.join(' ')); break;
    case 'people': out = await account.trusted(); break;
    case 'request': out = shortRequest(await account.sendRequest({ to: args[0], agent: whoami(), target: opt('--target'), note: opt('--note') })); break;
    case 'requests': {
      const { incoming, outgoing } = await account.requests();
      out = { incoming: incoming.map(shortRequest), outgoing: outgoing.map(shortRequest) };
      break;
    }
    case 'accept': out = shortRequest(await account.accept(args[0], (opt('--agents') || '').split(',').map((x) => x.trim()).filter(Boolean))); break;
    case 'deny': out = shortRequest(await account.deny(args[0])); break;
    case 'cancel': out = shortRequest(await account.cancel(args[0])); break;
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
      console.log('usage: synapse ui | peers [--all] | link <agent> [--in|--out] | unlink <agent> | read <agent> | send <agent> <msg> | inbox | agents | rename [agent] <name> | rename-project <project> <name> | invite | join <code> | friends | unfriend <friend> | sync | login | signup | logout | whoami | trust <who> | untrust <who> | people | request <person> [--target t] [--note n] | requests | accept <id> [--agents a,b] | deny <id> | cancel <id>');
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
