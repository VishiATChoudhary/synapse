#!/usr/bin/env node
// Wires Synapse into every agent CLI: MCP server, Claude hook, and the skill.
// Idempotent. Each config file is backed up once to <file>.bak-synapse before the first change.
//   node install.mjs            install
//   node install.mjs --dry-run  show what would change
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = process.env.SYNAPSE_USER_HOME || os.homedir();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');
const report = [];
const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
// A desktop install has its own Node runtime. Every agent uses the same small wrapper,
// so an MCP request can never open another GUI and a separate Node install is unnecessary.
const NODE = process.versions.electron
  ? path.join(process.env.SYNAPSE_HOME || path.join(HOME, '.synapse'), 'bin', process.platform === 'win32' ? 'synapse-node.cmd' : 'synapse-node')
  : process.execPath;
if (NODE !== process.execPath) {
  const script = process.platform === 'win32'
    ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`
    : `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(process.execPath)} "$@"\n`;
  if (!DRY) { fs.mkdirSync(path.dirname(NODE), { recursive: true }); fs.writeFileSync(NODE, script, { mode: 0o755 }); }
  report.push(`added bundled runtime: ${NODE}`);
}
const MCP = path.join(ROOT, 'mcp.mjs');
const HOOK = process.platform === 'win32' ? `"${NODE}" "${path.join(ROOT, 'hook.mjs')}"` : `${quote(NODE)} ${quote(path.join(ROOT, 'hook.mjs'))}`;

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
// Only tools that are on this machine (their config folder exists): no ~/.cursor for someone without Cursor.
// Install one later, and the next setup (Settings, or the app's own after an update) wires it in.
const CODEX = process.env.CODEX_HOME || path.join(HOME, '.codex');
function installed(label, dir) {
  if (fs.existsSync(dir)) return true;
  report.push(`skip  ${label}: not installed (${dir} is missing)`);
  return false;
}

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
    for (const g of groups) g.hooks = (g.hooks || []).filter((h) => !(/synapse/i.test(h.command) && /[/\\]hook\.mjs/.test(h.command)) || h.command === HOOK);
    d.hooks[ev] = groups.filter((g) => g.hooks.length);
    if (!d.hooks[ev].some((g) => g.hooks.some((h) => h.command === HOOK))) {
      d.hooks[ev].push({ hooks: [{ type: 'command', command: HOOK, timeout: 5 }] });
    }
  }
}
if (installed('claude hooks', path.join(HOME, '.claude'))) editJSON('claude hooks', path.join(HOME, '.claude', 'settings.json'), (d) => addHooks(d, ['UserPromptSubmit', 'SessionStart']));
if (installed('codex hooks', CODEX)) editJSON('codex hooks', path.join(CODEX, 'hooks.json'), (d) => addHooks(d, ['UserPromptSubmit', 'SessionStart', 'SubagentStart']));

// Codex: TOML, append a table if missing
if (installed('codex mcp', CODEX)) {
  const file = path.join(CODEX, 'config.toml');
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

if (installed('gemini mcp', path.join(HOME, '.gemini'))) editJSON('gemini mcp', path.join(HOME, '.gemini', 'settings.json'), (d) => { (d.mcpServers ||= {}).synapse = stdio; });
if (installed('cursor mcp', path.join(HOME, '.cursor'))) editJSON('cursor mcp', path.join(HOME, '.cursor', 'mcp.json'), (d) => { (d.mcpServers ||= {}).synapse = stdio; });
if (installed('copilot mcp', path.join(HOME, '.copilot'))) editJSON('copilot mcp', path.join(HOME, '.copilot', 'mcp-config.json'), (d) => {
  (d.mcpServers ||= {}).synapse = { type: 'local', ...stdio, tools: ['*'] };
});
if (installed('amp mcp', path.join(HOME, '.config', 'amp'))) editJSON('amp mcp', path.join(HOME, '.config', 'amp', 'settings.json'), (d) => { (d['amp.mcpServers'] ||= {}).synapse = stdio; });
if (installed('opencode mcp', path.join(HOME, '.config', 'opencode'))) editJSON('opencode mcp', path.join(HOME, '.config', 'opencode', 'opencode.json'), (d) => {
  (d.mcp ||= {}).synapse = { type: 'local', command: [NODE, MCP], enabled: true };
});

// `synapse` launcher, so the skill and hook messages never depend on where the repo lives
{
  const bin = path.join(process.env.SYNAPSE_HOME || path.join(HOME, '.synapse'), 'bin', process.platform === 'win32' ? 'synapse.cmd' : 'synapse');
  const script = process.platform === 'win32'
    ? `@echo off\r\ncall "${NODE}" "${path.join(ROOT, 'cli.mjs')}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(NODE)} ${quote(path.join(ROOT, 'cli.mjs'))} "$@"\n`;
  const current = fs.existsSync(bin) ? fs.readFileSync(bin, 'utf8') : '';
  if (current === script) report.push(`ok    launcher: ${bin}`);
  else {
    if (!DRY) { fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, script, { mode: 0o755 }); }
    report.push(`added launcher: ${bin} (add ~/.synapse/bin to PATH to type \`synapse\`)`);
  }
}

// Skill: symlink so the repo stays the source of truth
const skillDirs = [];
if (fs.existsSync(path.join(HOME, '.claude'))) skillDirs.push(path.join(HOME, '.claude', 'skills'));
if (fs.existsSync(CODEX)) skillDirs.push(path.join(HOME, '.agents', 'skills'), path.join(CODEX, 'skills'));
for (const dir of skillDirs) {
  const link = path.join(dir, 'synapse'), target = path.join(ROOT, 'skill');
  let current = null;
  try { current = fs.readlinkSync(link); } catch {}
  if (current === target) { report.push(`ok    skill: ${link}`); continue; }
  if (fs.existsSync(link) && current === null) { report.push(`skip  skill: ${link} exists and is not a symlink`); continue; }
  if (!DRY) { fs.mkdirSync(dir, { recursive: true }); if (current) fs.unlinkSync(link); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  report.push(`added skill: ${link}`);
}

// Skills load on demand; keep a small pointer in the effective global instructions as well.
if (installed('codex guidance', CODEX)) {
  const override = path.join(CODEX, 'AGENTS.override.md');
  const file = fs.existsSync(override) && fs.readFileSync(override, 'utf8').trim()
    ? override : path.join(CODEX, 'AGENTS.md');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const intro = fs.readFileSync(new URL('./skill/bootstrap.md', import.meta.url), 'utf8').trim();
  const block = `<!-- synapse:start -->\n${intro}\n<!-- synapse:end -->`;
  const pattern = /<!-- synapse:start -->[\s\S]*?<!-- synapse:end -->/;
  const after = pattern.test(before) ? before.replace(pattern, block)
    : `${before}${before && !before.endsWith('\n') ? '\n' : ''}${before.trim() ? '\n' : ''}${block}\n`;
  if (after === before) report.push('ok    codex guidance: already configured');
  else {
    if (!DRY) { backup(file); fs.writeFileSync(file, after); }
    report.push(`added codex guidance: ${file}`);
  }
}

console.log(report.join('\n'));
console.log(`\n${DRY ? 'Dry run, nothing written.' : 'Done.'} Running agents pick up the MCP server after a restart.`);
