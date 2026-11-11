// A workspace's browser: Chrome's profiles with their Claude in Chrome deviceId and Codex extension, the choice per
// workspace (all its worktrees), and what the prompt hook tells Claude and Codex agents working there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-browsers-')));
const home = path.join(tmp, 'home'), chrome = path.join(tmp, 'chrome');
process.env.SYNAPSE_HOME = home; process.env.SYNAPSE_CHROME_DIR = chrome;
fs.mkdirSync(home, { recursive: true });

// Chrome: a work profile with both extensions (its deviceId squeezed the way LevelDB block compression leaves it),
// a personal one with Claude only (plain), and one with neither
const CLAUDE = 'fcoeoabgfenejglbffodgkkbkcdhcgfn', CODEX = 'hehggadaopoacecdllhhajmbjkdcmajg';
const keep = (dir, ext, text) => { const d = path.join(chrome, dir, 'Local Extension Settings', ext); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '000003.log'), Buffer.from(text, 'latin1')); };
const profile = (dir, exts, store) => {
  for (const e of exts) fs.mkdirSync(path.join(chrome, dir, 'Extensions', e, '1.0'), { recursive: true });
  if (store) keep(dir, CLAUDE, store);
};
fs.mkdirSync(chrome, { recursive: true });
fs.writeFileSync(path.join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: {
  'Profile 13': { name: 'acme.dev', user_name: 'me@acme.dev' }, Default: { name: 'Me', user_name: 'me@gmail.com' }, 'Profile 4': { name: 'old' },
} } }));
profile('Profile 13', [CLAUDE, CODEX], 'xxbridgeDefaultDisplayName\x01N\rIHMacbook"\x08\x0e&viceId\x01\t\r\x1a\xa9I3b08340e-b9ce-4fd1-8d54-6e24b85bae83"\x02&\x04');
profile('Default', [CLAUDE], 'deviceId"16fc3b6a-9340-45ba-bfc3-dfef41e8b4ad"');
profile('Profile 4', [], null);
// Codex's extension keeps the id agent.browsers.list() reports as metadata.extensionInstanceId (as on a real Mac)
keep('Profile 13', CODEX, 'codexToolbarStateTelemetryId&"a7212ba0-f3e7-4bec-b94b-91f6f41005dc"\x01extensionInstanceId&"7f7ccb83-b5f3-4164-abb9-941bdec88cc0"');

// a repo with a worktree: one workspace
const repo = path.join(tmp, 'acme'), wt = path.join(tmp, 'acme-feature'), other = path.join(tmp, 'other');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
for (const d of [repo, other]) { fs.mkdirSync(d); git(d, 'init', '-q'); git(d, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'x'); }
git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);

const b = await import('../browsers.mjs');
const hook = (cwd, extra = {}) => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'hook.mjs')], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd, prompt: 'hi', ...extra }), env: { ...process.env } }).toString();
  return out.trim() ? JSON.parse(out).hookSpecificOutput?.additionalContext || '' : '';
};

test('profiles come with their Claude deviceId and Codex extension', () => {
  const all = b.chromeProfiles();
  const by = Object.fromEntries(all.map((p) => [p.dir, p]));
  assert.equal(by['Profile 13'].claude.device, '3b08340e-b9ce-4fd1-8d54-6e24b85bae83', 'read through LevelDB compression');
  assert.equal(by['Profile 13'].codex.instance, '7f7ccb83-b5f3-4164-abb9-941bdec88cc0', 'not the telemetry id next to it');
  assert.equal(by.Default.claude.device, '16fc3b6a-9340-45ba-bfc3-dfef41e8b4ad');
  assert.equal(by.Default.codex, null);
  assert.equal(by['Profile 4'].claude, null);
});

test('a workspace names its profile; every worktree follows, other repos do not', () => {
  assert.equal(b.browserFor(repo), null, 'agents choose by default');
  b.setBrowser(wt, 'me@acme.dev'); // by email, from a worktree
  assert.equal(b.browserFor(repo).dir, 'Profile 13');
  assert.equal(b.browserFor(wt).name, 'acme.dev');
  assert.equal(b.browserFor(other), null);
  assert.deepEqual(b.browserEnv(wt), { CODEX_CHROMIUM_PREFERENCES_PATH: path.join(chrome, 'Profile 13', 'Preferences') });
  assert.throws(() => b.setBrowser(repo, 'nope'), /no Chrome profile "nope"/);
});

test('the hook tells Claude which deviceId to select and Codex which extensionInstanceId', () => {
  const claude = hook(wt);
  assert.match(claude, /<workspace-browser>/);
  assert.match(claude, /Chrome profile "acme.dev" \(me@acme.dev\)/);
  assert.match(claude, /select_browser with deviceId "3b08340e-b9ce-4fd1-8d54-6e24b85bae83"/);
  assert.match(claude, /--profile-directory="Profile 13"/, 'how to open it when it is not connected');
  const codex = hook(wt, { transcript_path: path.join(os.homedir(), '.codex', 'sessions', 'x.jsonl') });
  assert.match(codex, /metadata\.extensionInstanceId is "7f7ccb83-b5f3-4164-abb9-941bdec88cc0"/);
  assert.match(codex, /agent\.browsers\.get/);
  assert.doesNotMatch(codex, /select_browser/);
  assert.equal(hook(other), '', 'nothing for a workspace without a choice');
});

test('a profile without the extension says what to do; off goes back to the agents choosing', () => {
  b.setBrowser(repo, 'old');
  assert.match(hook(repo), /Claude extension is not installed in that profile/);
  assert.match(hook(repo, { transcript_path: '/u/.codex/sessions/x.jsonl' }), /not installed in that profile yet/);
  b.setBrowser(repo, null);
  assert.equal(b.browserFor(wt), null);
  assert.equal(hook(wt), '');
});
