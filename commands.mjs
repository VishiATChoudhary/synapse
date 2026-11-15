// What you can type after "/" in a session: the agent's built-in commands, your own and the project's commands,
// and every skill it can load (yours, the project's, and those of enabled plugins). Read from disk, cached briefly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code's own commands as its / menu shows them; the settings ones are grouped as Settings
const CLAUDE_BUILTIN = [
  ['add-dir', 'Add another folder this session may work in'],
  ['agents', 'Manage subagents'],
  ['bashes', 'List and manage background shells'],
  ['clear', 'Start over with an empty conversation'],
  ['compact', 'Summarize the conversation to free context'],
  ['context', 'Show what fills the context window'],
  ['cost', 'Show token use and cost for this session'],
  ['doctor', 'Check the installation'],
  ['export', 'Export the conversation'],
  ['help', 'Show help'],
  ['init', 'Write a CLAUDE.md for this project'],
  ['mcp', 'Manage MCP servers'],
  ['plugin', 'Manage plugins'],
  ['pr-comments', 'Show the comments on a pull request'],
  ['release-notes', 'Show what changed in this version'],
  ['resume', 'Resume an earlier conversation'],
  ['review', 'Review a pull request'],
  ['rewind', 'Go back to an earlier point'],
  ['security-review', 'Review the pending changes for security issues'],
  ['status', 'Show version, model and account'],
  ['todos', 'Show the current todo list'],
  ['usage', 'Show plan usage limits'],
  ['config', 'Open settings', 'setting'],
  ['model', 'Choose the model', 'setting'],
  ['permissions', 'Allow or deny tools', 'setting'],
  ['hooks', 'Manage hooks', 'setting'],
  ['memory', 'Edit memory files', 'setting'],
  ['output-style', 'Choose how replies are written', 'setting'],
  ['statusline', 'Set up the status line', 'setting'],
  ['terminal-setup', 'Set up Shift+Enter for new lines', 'setting'],
  ['vim', 'Turn vim keys on or off', 'setting'],
  ['privacy-settings', 'Privacy settings', 'setting'],
  ['login', 'Sign in', 'setting'],
  ['logout', 'Sign out', 'setting'],
];
const CODEX_BUILTIN = [
  ['model', 'Choose the model and reasoning effort'],
  ['approvals', 'Choose what Codex may do without asking'],
  ['review', 'Review the current changes'],
  ['new', 'Start a new conversation'],
  ['init', 'Write an AGENTS.md for this project'],
  ['compact', 'Summarize the conversation to free context'],
  ['diff', 'Show the git diff, including untracked files'],
  ['mention', 'Mention a file'],
  ['status', 'Show the session configuration and token use'],
  ['mcp', 'List configured MCP tools'],
];

// the front matter of a SKILL.md or command file: name and description, folded or quoted values included
export function frontMatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {}, lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      value = parts.join(' ');
    }
    out[kv[1]] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return out;
}
const firstLine = (text) => String(text).replace(/^---[\s\S]*?---/, '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
const clip = (s, n = 160) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const read = (file) => { try { return fs.readFileSync(file, 'utf8').slice(0, 20_000); } catch { return ''; } };
const dirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name); } catch { return []; } };

function skillsIn(dir, source, prefix = '') {
  return dirs(dir).flatMap((name) => {
    const file = path.join(dir, name, 'SKILL.md'), text = read(file);
    if (!text) return [];
    const fm = frontMatter(text);
    return [{ name: `${prefix}${fm.name || name}`, description: clip(fm.description || firstLine(text)), kind: 'skill', source }];
  });
}
function commandsIn(dir, source, prefix = '') {
  const out = [];
  const walk = (d, ns) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name), [...ns, e.name]);
      else if (e.name.endsWith('.md')) {
        const text = read(path.join(d, e.name)), fm = frontMatter(text);
        out.push({ name: `${prefix}${[...ns, e.name.slice(0, -3)].join(':')}`, description: clip(fm.description || firstLine(text)), kind: 'command', source, hint: fm['argument-hint'] || '' });
      }
    }
  };
  walk(dir, []);
  return out;
}
// subagents: a file per agent, mentioned as @agent-<name> in Claude Code
function agentsIn(dir, source, prefix = '') {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; }
  return files.map((f) => { const text = read(path.join(dir, f)), fm = frontMatter(text); return { name: `${prefix}${fm.name || f.slice(0, -3)}`, description: clip(fm.description || firstLine(text)), kind: 'agent', source, sigil: '@agent-' }; });
}
// the newest installed version of each enabled plugin
function pluginRoots(home) {
  let enabled = {};
  try { enabled = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).enabledPlugins || {}; } catch {}
  const cache = path.join(home, '.claude', 'plugins', 'cache'), out = [];
  for (const market of dirs(cache)) for (const plugin of dirs(path.join(cache, market))) {
    if (enabled[`${plugin}@${market}`] === false) continue;
    if (Object.keys(enabled).length && !enabled[`${plugin}@${market}`]) continue;
    const versions = dirs(path.join(cache, market, plugin)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (versions.length) out.push({ plugin, root: path.join(cache, market, plugin, versions.at(-1)) });
  }
  return out;
}

const cache = new Map();
export function slashItems(kind, cwd, home = os.homedir()) {
  const key = `${kind}\0${cwd}\0${home}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.items;
  let items = [];
  if (kind === 'codex') {
    items = [
      ...CODEX_BUILTIN.map(([name, description]) => ({ name, description, kind: 'command', source: 'built-in' })),
      ...commandsIn(path.join(home, '.codex', 'prompts'), 'personal', 'prompts:'),
      ...skillsIn(path.join(home, '.codex', 'skills'), 'personal').map((s) => ({ ...s, sigil: '$' })),
      ...(cwd ? skillsIn(path.join(cwd, '.codex', 'skills'), 'project').map((s) => ({ ...s, sigil: '$' })) : []),
    ];
  } else if (kind === 'claude') {
    items = [
      ...CLAUDE_BUILTIN.map(([name, description, kind = 'command']) => ({ name, description, kind, source: 'built-in' })),
      ...commandsIn(path.join(home, '.claude', 'commands'), 'personal'),
      ...(cwd ? commandsIn(path.join(cwd, '.claude', 'commands'), 'project') : []),
      ...skillsIn(path.join(home, '.claude', 'skills'), 'personal'),
      ...(cwd ? skillsIn(path.join(cwd, '.claude', 'skills'), 'project') : []),
      ...pluginRoots(home).flatMap(({ plugin, root }) => [
        ...commandsIn(path.join(root, 'commands'), plugin, `${plugin}:`),
        ...skillsIn(path.join(root, 'skills'), plugin, `${plugin}:`),
        ...agentsIn(path.join(root, 'agents'), plugin, `${plugin}:`),
      ]),
      ...agentsIn(path.join(home, '.claude', 'agents'), 'personal'),
      ...(cwd ? agentsIn(path.join(cwd, '.claude', 'agents'), 'project') : []),
    ];
  }
  const seen = new Set();
  items = items.filter((i) => i.name && !seen.has(`${i.sigil || '/'}${i.name}`) && seen.add(`${i.sigil || '/'}${i.name}`));
  cache.set(key, { at: Date.now(), items });
  return items;
}
