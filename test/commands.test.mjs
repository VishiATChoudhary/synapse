import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frontMatter, slashItems } from '../commands.mjs';

test('front matter reads names and descriptions, folded and quoted', () => {
  assert.deepEqual(frontMatter('---\nname: brief\ndescription: >\n  Keep it\n  short\n---\n# x'), { name: 'brief', description: 'Keep it short' });
  assert.equal(frontMatter('---\ndescription: "Quoted: yes"\n---').description, 'Quoted: yes');
  assert.deepEqual(frontMatter('# no front matter'), {});
});

test('the / menu lists built-ins, your and the project commands, skills, and enabled plugins only', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-cmd-')), cwd = path.join(home, 'repo');
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put(path.join(home, '.claude/commands/ship.md'), '---\ndescription: Ship it\nargument-hint: [version]\n---\nbody');
  put(path.join(home, '.claude/commands/git/sync.md'), 'Sync the branch with main');
  put(path.join(cwd, '.claude/commands/test.md'), '---\ndescription: Run the tests\n---');
  put(path.join(home, '.claude/skills/brief/SKILL.md'), '---\nname: brief\ndescription: Short answers\n---');
  put(path.join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'good@m': true, 'off@m': false } }));
  put(path.join(home, '.claude/plugins/cache/m/good/1.0.0/skills/old/SKILL.md'), '---\nname: old\n---');
  put(path.join(home, '.claude/plugins/cache/m/good/1.10.0/skills/new/SKILL.md'), '---\nname: new\ndescription: Newest version\n---');
  put(path.join(home, '.claude/plugins/cache/m/off/1.0.0/skills/hidden/SKILL.md'), '---\nname: hidden\n---');
  put(path.join(home, '.codex/skills/railway/SKILL.md'), '---\nname: railway\ndescription: Deploy\n---');
  put(path.join(home, '.claude/agents/reviewer.md'), '---\nname: reviewer\ndescription: Reviews diffs\n---');
  const claude = slashItems('claude', cwd, home), names = claude.map((i) => i.name);
  for (const n of ['clear', 'model', 'ship', 'git:sync', 'test', 'brief', 'good:new']) assert.ok(names.includes(n), n);
  for (const n of ['good:old', 'off:hidden']) assert.ok(!names.includes(n), n);
  assert.equal(claude.find((i) => i.name === 'ship').hint, '[version]');
  assert.equal(claude.find((i) => i.name === 'git:sync').description, 'Sync the branch with main');
  assert.equal(claude.find((i) => i.name === 'test').source, 'project');
  const reviewer = claude.find((i) => i.name === 'reviewer');
  assert.deepEqual([reviewer.kind, reviewer.sigil, reviewer.description], ['agent', '@agent-', 'Reviews diffs']);
  assert.equal(claude.find((i) => i.name === 'config').kind, 'setting');
  const codex = slashItems('codex', cwd, home);
  assert.ok(codex.some((i) => i.name === 'approvals'));
  assert.deepEqual(codex.filter((i) => i.sigil === '$').map((i) => i.name), ['railway']);
  fs.rmSync(home, { recursive: true, force: true });
});
