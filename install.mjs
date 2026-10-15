#!/usr/bin/env node
// Wires Synapse into every agent CLI: MCP server, Claude hook, and the skill.
// Idempotent. Each config file is backed up once to <file>.bak-synapse before the first change.
//   node install.mjs            install
//   node install.mjs --dry-run  show what would change
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const HOME = os.homedir();
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const NODE = process.execPath;
const MCP = path.join(ROOT, 'mcp.mjs');
const HOOK = `"${NODE}" "${path.join(ROOT, 'hook.mjs')}"`;
const DRY = process.argv.includes('--dry-run');
const report = [];

function backup(file) {
  if (fs.existsSync(file) && !fs.existsSync(`${file}.bak-synapse`)) fs.copyFileSync(file, `${file}.bak-synapse`);
}

function editJSON(label, file, mutate) {
  let data = {};
  if (fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { report.push(`skip  ${label}: ${file} is not plain JSON (comments?), add the synapse MCP server by hand`); return; }
  }
  const before = JSON.stringify(data);
  mutate(data);
  if (JSON.stringify(data) === before) return report.push(`ok    ${label}: already configured`);
  if (!DRY) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backup(file);
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  report.push(`added ${label}: ${file}`);
}

const stdio = { command: NODE, args: [MCP] };

// Claude Code: MCP server (user scope), prompt hook, skill
// (via the CLI: ~/.claude.json is rewritten constantly by running sessions)
{
  const has = spawnSync('claude', ['mcp', 'get', 'synapse'], { encoding: 'utf8' });
  if (has.status === 0 && has.stdout.includes(MCP)) report.push('ok    claude mcp: already configured');
  else if (has.error) report.push('skip  claude mcp: claude CLI not found');
  else {
    if (!DRY) {
      if (has.status === 0) spawnSync('claude', ['mcp', 'remove', '-s', 'user', 'synapse']);
      const r = spawnSync('claude', ['mcp', 'add', '-s', 'user', 'synapse', '--', NODE, MCP], { encoding: 'utf8' });
      if (r.status !== 0) { report.push(`fail  claude mcp: ${(r.stderr || r.stdout).trim()}`); }
    }
    report.push('added claude mcp: user scope');
  }
}
// Prompt + session-start hook, same script for Claude Code and Codex (same hook protocol)
function addHooks(d, events) {
  d.hooks ||= {};
  for (const ev of events) {
    const groups = (d.hooks[ev] ||= []);
    // drop older synapse hook entries (e.g. a different node path), then add the current one
    for (const g of groups) g.hooks = (g.hooks || []).filter((h) => !String(h.command).includes('synapse/hook.mjs') || h.command === HOOK);
    d.hooks[ev] = groups.filter((g) => g.hooks.length);
    if (!d.hooks[ev].some((g) => g.hooks.some((h) => h.command === HOOK))) {
      d.hooks[ev].push({ hooks: [{ type: 'command', command: HOOK, timeout: 5 }] });
    }
  }
}
editJSON('claude hooks', path.join(HOME, '.claude', 'settings.json'), (d) => addHooks(d, ['UserPromptSubmit', 'SessionStart']));
editJSON('codex hooks', path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'hooks.json'), (d) => addHooks(d, ['UserPromptSubmit', 'SessionStart']));

// Codex: TOML, append a table if missing
{
  const file = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'config.toml');
  const toml = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^\[mcp_servers\.synapse\]/m.test(toml)) report.push('ok    codex mcp: already configured');
  else {
    if (!DRY) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      backup(file);
      fs.appendFileSync(file, `\n[mcp_servers.synapse]\ncommand = ${JSON.stringify(NODE)}\nargs = [${JSON.stringify(MCP)}]\n`);
    }
    report.push(`added codex mcp: ${file}`);
  }
}

editJSON('gemini mcp', path.join(HOME, '.gemini', 'settings.json'), (d) => { (d.mcpServers ||= {}).synapse = stdio; });
editJSON('cursor mcp', path.join(HOME, '.cursor', 'mcp.json'), (d) => { (d.mcpServers ||= {}).synapse = stdio; });
editJSON('copilot mcp', path.join(HOME, '.copilot', 'mcp-config.json'), (d) => {
  (d.mcpServers ||= {}).synapse = { type: 'local', ...stdio, tools: ['*'] };
});
editJSON('amp mcp', path.join(HOME, '.config', 'amp', 'settings.json'), (d) => { (d['amp.mcpServers'] ||= {}).synapse = stdio; });
editJSON('opencode mcp', path.join(HOME, '.config', 'opencode', 'opencode.json'), (d) => {
  (d.mcp ||= {}).synapse = { type: 'local', command: [NODE, MCP], enabled: true };
});

// `synapse` launcher, so the skill and hook messages never depend on where the repo lives
{
  const bin = path.join(process.env.SYNAPSE_HOME || path.join(HOME, '.synapse'), 'bin', 'synapse');
  const script = `#!/bin/sh\nexec "${NODE}" "${path.join(ROOT, 'cli.mjs')}" "$@"\n`;
  const current = fs.existsSync(bin) ? fs.readFileSync(bin, 'utf8') : '';
  if (current === script) report.push(`ok    launcher: ${bin}`);
  else {
    if (!DRY) { fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, script, { mode: 0o755 }); }
    report.push(`added launcher: ${bin} (add ~/.synapse/bin to PATH to type \`synapse\`)`);
  }
}

// Skill: symlink so the repo stays the source of truth
for (const dir of [path.join(HOME, '.claude', 'skills'), path.join(HOME, '.codex', 'skills')]) {
  if (!fs.existsSync(path.dirname(dir))) continue;
  const link = path.join(dir, 'synapse'), target = path.join(ROOT, 'skill');
  let current = null;
  try { current = fs.readlinkSync(link); } catch {}
  if (current === target) { report.push(`ok    skill: ${link}`); continue; }
  if (fs.existsSync(link) && current === null) { report.push(`skip  skill: ${link} exists and is not a symlink`); continue; }
  if (!DRY) { fs.mkdirSync(dir, { recursive: true }); if (current) fs.unlinkSync(link); fs.symlinkSync(target, link); }
  report.push(`added skill: ${link}`);
}

console.log(report.join('\n'));
console.log(`\n${DRY ? 'Dry run, nothing written.' : 'Done.'} Running agents pick up the MCP server after a restart.`);
