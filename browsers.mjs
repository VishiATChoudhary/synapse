// Which browser a workspace opens. Claude in Chrome and Codex's Chrome plugin each run as an extension inside
// Chrome profiles; with several profiles connected, an agent picks one more or less at random. A workspace can name
// the Chrome profile its agents use (work account for the work repo, and so on), and the prompt hook tells every
// Claude and Codex agent working there which one to select:
//   Claude in Chrome: the profile's extension has a deviceId (in its local storage), which select_browser takes.
//   Codex: agent.browsers.list() entries carry metadata.extensionInstanceId (also in its local storage); Synapse's Codex tabs also get
//   CODEX_CHROMIUM_PREFERENCES_PATH, so the plugin's own scripts (open a window, checks) go to that profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA, readJSON, writeJSON, projectOf } from './lib.mjs';

const FILE = path.join(DATA, 'browsers.json'); // project key -> Chrome profile folder ("Profile 13")
const CLAUDE_EXT = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const CODEX_EXTS = ['hehggadaopoacecdllhhajmbjkdcmajg', 'odlomjlbamekndcpllcnffbgeohgkmjh'];

export const chromeRoot = () => process.env.SYNAPSE_CHROME_DIR || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
    : path.join(os.homedir(), '.config', 'google-chrome'));

// An id an extension keeps in its local storage (LevelDB): Claude's deviceId, Codex's extensionInstanceId.
// The newest file that has one wins.
function storedId(profileDir, ext, key) {
  const dir = path.join(profileDir, 'Local Extension Settings', ext);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.(ldb|log)$/.test(f)).map((f) => path.join(dir, f)); } catch { return null; }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f).toString('latin1'); } catch { continue; }
    // the key's start and the value's quote may be squeezed by LevelDB's prefix and block compression
    const all = [...text.matchAll(new RegExp(key + String.raw`[\s\S]{0,24}?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`, 'g'))];
    if (all.length) return all.at(-1)[1];
  }
  return null;
}

// Chrome's profiles: folder, the name it shows, the account, and which agents' extensions are in it.
export function chromeProfiles(only = null) {
  const root = chromeRoot();
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8')).profile?.info_cache || {}; } catch { return []; }
  return Object.entries(cache).filter(([dir]) => !only || dir === only).map(([dir, p]) => {
    const full = path.join(root, dir);
    const has = (id) => fs.existsSync(path.join(full, 'Extensions', id));
    return {
      dir, name: p.name || dir, email: p.user_name || null,
      claude: has(CLAUDE_EXT) ? { device: storedId(full, CLAUDE_EXT, 'viceId') } : null,
      codex: CODEX_EXTS.some(has) ? { instance: CODEX_EXTS.map((e) => storedId(full, e, 'InstanceId')).find(Boolean) || null } : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

const keyOf = (folder) => projectOf(folder).key;
export const choices = () => readJSON(FILE, {});

// the profile a folder's workspace uses, or null when its agents choose
export function browserFor(folder) {
  if (!folder) return null;
  const dir = choices()[keyOf(folder)];
  if (!dir) return null;
  return chromeProfiles(dir)[0] || { dir, name: dir, email: null, claude: null, codex: null, missing: true };
}

export function setBrowser(folder, dir) {
  const key = keyOf(folder), all = choices();
  if (dir) {
    const p = chromeProfiles().find((x) => x.dir === dir || x.name === dir || x.email === dir);
    if (!p) throw new Error(`no Chrome profile "${dir}"; ${chromeProfiles().map((x) => x.name + (x.email ? ` (${x.email})` : '')).join(', ') || 'Chrome has no profiles here'}`);
    all[key] = p.dir;
  } else delete all[key];
  writeJSON(FILE, all);
  return { workspace: projectOf(folder).label, browser: dir ? browserFor(folder) : null };
}

// how to open that profile's Chrome window (it has to run for its extension to connect)
export function openCommand(p) {
  if (process.platform === 'darwin') return `open -na "Google Chrome" --args --profile-directory="${p.dir}"`;
  if (process.platform === 'win32') return `start chrome --profile-directory="${p.dir}"`;
  return `google-chrome --profile-directory="${p.dir}"`;
}
export function openProfile(p, url) {
  const args = [`--profile-directory=${p.dir}`, ...(url ? [url] : [])];
  const child = process.platform === 'darwin' ? spawn('open', ['-na', 'Google Chrome', '--args', ...args], { detached: true, stdio: 'ignore' })
    : spawn(process.platform === 'win32' ? 'chrome' : 'google-chrome', args, { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
  child.on('error', () => {});
  child.unref();
}

// environment for an agent started in this folder (Codex reads the profile for its Chrome plugin's scripts)
export function browserEnv(folder) {
  const p = browserFor(folder);
  return p && !p.missing ? { CODEX_CHROMIUM_PREFERENCES_PATH: path.join(chromeRoot(), p.dir, 'Preferences') } : {};
}

// what the prompt hook tells an agent working in this folder
export function browserRule(folder, kind = 'claude') {
  const p = browserFor(folder);
  if (!p) return null;
  const who = `Chrome profile "${p.name}"${p.email ? ` (${p.email})` : ''}`;
  const open = `If it is not connected, open it with \`${openCommand(p)}\` and try again.`;
  const lines = [`This workspace (${projectOf(folder).label}) uses the ${who} for anything in a browser. Use no other browser or profile for it.`];
  if (kind === 'codex') {
    lines.push(p.codex?.instance
      ? `With the Chrome browser plugin, pick the entry of agent.browsers.list() whose metadata.extensionInstanceId is "${p.codex.instance}" (that profile) and get it with agent.browsers.get(id); never another one. ${open}`
      : `For the Chrome browser plugin: ${p.codex ? 'its instance id is not known yet' : "Codex's Chrome extension is not installed in that profile yet"}; ask the user to ${p.codex ? 'open Codex in' : 'add it to'} the "${p.name}" Chrome window. ${open}`);
  } else if (p.claude?.device) {
    lines.push(`For Claude in Chrome: before the first browser action in this session, call select_browser with deviceId "${p.claude.device}" (that profile). ` +
      `Do not ask which browser to use and do not use another one. ${open}`);
  } else {
    lines.push(`For Claude in Chrome: ${p.claude ? 'its device id is not known yet' : 'the Claude extension is not installed in that profile'}. ` +
      `Call switch_browser and ask the user to click Connect in the "${p.name}" Chrome window. ${open}`);
  }
  return lines.join('\n');
}
