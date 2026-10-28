import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-codex-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin'), profile = path.join(home, 'custom-codex');
  fs.mkdirSync(bin); fs.mkdirSync(profile);
  for (const command of ['ps', 'lsof']) {
    fs.writeFileSync(path.join(home, command), '');
    fs.writeFileSync(path.join(bin, command), `#!/bin/sh\n/bin/cat "$SYNAPSE_TEST_HOME/${command}"\n`, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: bin, SYNAPSE_TEST_HOME: home, CODEX_HOME: profile,
    SYNAPSE_HOME: path.join(home, 'state'), SYNAPSE_DEMO: '', SYNAPSE_AGENT: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '' };
  const run = (file, { args = [], input = '', extraEnv = {}, code = '' } = {}) => {
    const url = new URL(`../${file}`, import.meta.url);
    const source = `import os from 'node:os'; os.homedir = () => process.env.SYNAPSE_TEST_HOME;
      process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(url))}, ...${JSON.stringify(args)}];
      ${code || `await import(${JSON.stringify(url.href)});`}`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...env, ...extraEnv }, cwd: home, input, encoding: 'utf8', timeout: 10_000,
    });
  };
  const ok = (file, options) => {
    const result = run(file, options);
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout;
  };
  return { home, profile, env, run, ok };
}

test('Codex setup installs discoverable skills and preserves global guidance across reruns', (t) => {
  const f = fixture(t);
  const agents = path.join(f.profile, 'AGENTS.md');
  const config = path.join(f.profile, 'config.toml');
  const hooks = path.join(f.profile, 'hooks.json');
  const personal = '# Personal instructions\nKeep my conventions.';
  fs.writeFileSync(agents, personal);
  fs.writeFileSync(config, '[mcp_servers.other]\ncommand = "custom"\n');
  const userHook = { hooks: [{ type: 'command', command: 'my-own-hook' }] };
  fs.writeFileSync(hooks, JSON.stringify({ hooks: { SessionStart: [userHook] } }));

  f.ok('install.mjs', { args: ['--dry-run'] });
  assert.equal(fs.readFileSync(agents, 'utf8'), personal);
  assert.equal(fs.existsSync(path.join(f.home, '.agents')), false);
  assert.equal(fs.existsSync(`${agents}.bak-synapse`), false);

  f.ok('install.mjs');
  for (const skills of [path.join(f.home, '.agents/skills'), path.join(f.profile, 'skills')]) {
    assert.equal(fs.readlinkSync(path.join(skills, 'synapse')), fileURLToPath(new URL('../skill', import.meta.url)));
  }
  const installed = fs.readFileSync(agents, 'utf8');
  assert.ok(installed.startsWith(personal + '\n'));
  assert.ok(installed.includes('<!-- synapse:start -->'));
  assert.equal(fs.readFileSync(`${agents}.bak-synapse`, 'utf8'), personal);
  const installedHooks = JSON.parse(fs.readFileSync(hooks, 'utf8')).hooks;
  assert.deepEqual(installedHooks.SessionStart[0], userHook);
  assert.equal(installedHooks.SubagentStart[0].hooks[0].type, 'command');
  assert.ok(fs.readFileSync(config, 'utf8').startsWith('[mcp_servers.other]\ncommand = "custom"\n'));
  f.ok('install.mjs');
  assert.equal(fs.readFileSync(agents, 'utf8'), installed);
  assert.equal(JSON.parse(fs.readFileSync(hooks, 'utf8')).hooks.SubagentStart.length, 1);

  const override = path.join(f.profile, 'AGENTS.override.md');
  fs.writeFileSync(override, 'Temporary personal instructions.');
  f.ok('install.mjs');
  assert.ok(fs.readFileSync(override, 'utf8').startsWith('Temporary personal instructions.\n'));
  assert.ok(fs.readFileSync(override, 'utf8').includes('<!-- synapse:start -->'));
  assert.equal(fs.readFileSync(agents, 'utf8'), installed);
});

test('Codex thread identity works through a shared daemon for CLI, MCP, and hooks', (t) => {
  const f = fixture(t), now = new Date();
  const [day, month, date, year, time] = now.toString().split(' ');
  const start = `${day} ${month} ${date} ${time} ${year}`;
  const threadA = '01a00000-0000-7000-8000-000000000001', threadB = '01a00000-0000-7000-8000-000000000002';
  const cwdA = path.join(f.home, 'project-a'), cwdB = path.join(f.home, 'project-b');
  const processes = `41000 1 0.0 ${start} codex\n42000 1 0.0 ${start} codex\n`;
  fs.writeFileSync(path.join(f.home, 'ps'), processes);
  fs.writeFileSync(path.join(f.home, 'lsof'), `p41000\nn${cwdA}\np42000\nn${cwdB}\n`);
  const sessions = path.join(f.profile, 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(sessions, { recursive: true });
  for (const [id, cwd] of [[threadA, cwdA], [threadB, cwdB]]) {
    fs.writeFileSync(path.join(sessions, `rollout-${now.toISOString()}-${id}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n');
  }
  const extraEnv = { CODEX_THREAD_ID: threadB };
  const peers = JSON.parse(f.ok('cli.mjs', { args: ['peers', '--all'], extraEnv }));
  assert.equal(peers.me.id, 'codex-42000');
  const response = JSON.parse(f.ok('mcp.mjs', { extraEnv, input: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'synapse_peers', arguments: {} },
  }) + '\n' }));
  assert.equal(JSON.parse(response.result.content[0].text).me.id, 'codex-42000');
  const hook = JSON.parse(f.ok('hook.mjs', { extraEnv,
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: threadA }),
  }));
  assert.ok(hook.hookSpecificOutput.additionalContext.includes('Your Synapse agent id is codex-41000.'));
  const lib = new URL('../lib.mjs', import.meta.url).href;
  f.ok('lib.mjs', { extraEnv, code: `
    import assert from 'node:assert/strict';
    const { agentForProcess } = await import(${JSON.stringify(lib)});
    assert.equal(agentForProcess(41000).id, 'codex-42000');
    process.env.CODEX_THREAD_ID = '';
    assert.equal(agentForProcess(41000).id, 'codex-41000');
    process.env.SYNAPSE_AGENT = 'missing';
    assert.equal(agentForProcess(41000), null);
  ` });
  // Two processes claiming the same rollout must not silently pick an identity.
  fs.appendFileSync(path.join(f.home, 'ps'), `43000 1 0.0 ${start} codex\n`);
  fs.appendFileSync(path.join(f.home, 'lsof'), `p43000\nn${cwdB}\n`);
  assert.equal(f.run('cli.mjs', { args: ['peers'], extraEnv }).status, 1);
});

test('new unlinked sessions and subagents receive model-visible Synapse instructions', (t) => {
  const f = fixture(t);
  for (const event of ['SessionStart', 'SubagentStart']) {
    const response = JSON.parse(f.ok('hook.mjs', {
      input: JSON.stringify({ hook_event_name: event, session_id: 'not-yet-discovered' }),
    }));
    assert.equal(response.hookSpecificOutput.hookEventName, event);
    assert.ok(response.hookSpecificOutput.additionalContext.includes('~/.agents/skills/synapse/SKILL.md'));
    assert.ok(response.hookSpecificOutput.additionalContext.includes('SYNAPSE_AGENT'));
    assert.equal(response.systemMessage, undefined);
  }
});
