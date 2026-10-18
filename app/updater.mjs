// Self-updates for the packaged app. Synapse is ad-hoc signed (no Apple Developer ID), so Squirrel/electron-updater
// cannot verify it; this does the same job with our own key:
//   latest.json on the GitHub release  ->  { version, url, sha256, size, dmg, notes, sig }
//   sig is an Ed25519 signature (the private key never leaves the release machine) over the fields that matter,
//   the zip must hash to sha256, and the app inside must say it is that version and pass `codesign --verify`.
// The new Synapse.app is unpacked next to the running one and swapped in by a small script once the app quits,
// so an update never replaces files under a running process. No Electron imports: tests drive it directly.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

export const MANIFEST_URL = 'https://github.com/VishiATChoudhary/synapse/releases/latest/download/latest.json';
export const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEArFJ8W63lJCnEodLVz0JCo27Yn0/+rpOkNf6Q1fPnSJc=
-----END PUBLIC KEY-----
`;
const MAX_ZIP = 1024 * 1024 * 1024;

// what the signature covers, one field per line so nothing can be shifted between fields
export const signedText = (m) => ['synapse-update', m.version, m.url, m.sha256, m.size].join('\n');
export function signManifest(m, privateKeyPem) {
  return { ...m, sig: crypto.sign(null, Buffer.from(signedText(m)), crypto.createPrivateKey(privateKeyPem)).toString('base64') };
}
export function verifyManifest(m, publicKeyPem = PUBLIC_KEY) {
  if (!m || typeof m !== 'object') throw new Error('update manifest is not JSON');
  for (const k of ['version', 'url', 'sha256', 'sig']) if (typeof m[k] !== 'string' || !m[k]) throw new Error(`update manifest has no ${k}`);
  if (!Number.isInteger(m.size) || m.size <= 0 || m.size > MAX_ZIP) throw new Error('update manifest has a bad size');
  if (!/^\d+\.\d+\.\d+$/.test(m.version) || !/^[0-9a-f]{64}$/.test(m.sha256) || !/^https?:\/\//.test(m.url)) throw new Error('update manifest is malformed');
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(signedText(m)), crypto.createPublicKey(publicKeyPem), Buffer.from(m.sig, 'base64')); } catch {}
  if (!ok) throw new Error('update signature does not match: not installing it');
  return m;
}

export function newer(a, b) { // is version a newer than b
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// /Applications/Synapse.app when packaged, else null (running from source: nothing to update)
export function bundleOf(execPath) {
  const m = String(execPath).match(/^(.*?\.app)\/Contents\/MacOS\/[^/]+$/);
  return m ? m[1] : null;
}
const writable = (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };
export const canReplace = (bundle) => !!bundle && writable(path.dirname(bundle)) && writable(bundle);
const plistVersion = (app) => execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();

export function createUpdater({ currentVersion, bundle, manifestUrl = MANIFEST_URL, publicKey = PUBLIC_KEY, onState = () => {}, log = () => {} }) {
  let state = { state: 'idle', current: currentVersion };
  const set = (s) => { state = { current: currentVersion, ...s }; onState(state); return state; };
  const stageDir = bundle ? path.join(path.dirname(bundle), '.synapse-update') : null;
  let busy = null;

  async function fetchManifest() {
    const r = await fetch(`${manifestUrl}${manifestUrl.includes('?') ? '&' : '?'}t=${Date.now()}`, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'cache-control': 'no-cache' } });
    if (r.status === 404) return null; // no release yet
    if (!r.ok) throw new Error(`update check answered ${r.status}`);
    return verifyManifest(await r.json(), publicKey);
  }

  async function download(m) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    const zip = path.join(stageDir, 'Synapse.zip');
    const r = await fetch(m.url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
    if (!r.ok || !r.body) throw new Error(`update download answered ${r.status}`);
    const hash = crypto.createHash('sha256');
    let got = 0, last = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        got += chunk.length;
        if (got > m.size) return cb(new Error('update download is bigger than announced'));
        hash.update(chunk);
        if (Date.now() - last > 500) { last = Date.now(); set({ state: 'downloading', version: m.version, notes: m.notes || '', progress: got / m.size }); }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(r.body), meter, fs.createWriteStream(zip));
    if (got !== m.size || hash.digest('hex') !== m.sha256) throw new Error('update download does not match its checksum');
    // unpack and check what came out before it can go anywhere near the real app
    execFileSync('/usr/bin/ditto', ['-x', '-k', zip, stageDir]);
    fs.rmSync(zip, { force: true });
    const app = path.join(stageDir, 'Synapse.app');
    if (!fs.existsSync(path.join(app, 'Contents', 'Info.plist'))) throw new Error('update has no Synapse.app inside');
    if (plistVersion(app) !== m.version) throw new Error(`update says ${plistVersion(app)}, expected ${m.version}`);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', app], { stdio: 'ignore' });
    try { execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app], { stdio: 'ignore' }); } catch {}
    return app;
  }

  async function check() {
    if (busy) return busy;
    busy = (async () => {
      if (state.state === 'ready') return state;
      try {
        set({ state: 'checking' });
        const m = await fetchManifest();
        if (!m || !newer(m.version, currentVersion)) return set({ state: 'idle', checkedAt: Date.now() });
        // can't swap the app in place (running from a read-only spot, or from source): point at the download instead
        if (!canReplace(bundle)) return set({ state: 'manual', version: m.version, notes: m.notes || '', dmg: m.dmg || m.url });
        set({ state: 'downloading', version: m.version, notes: m.notes || '', progress: 0 });
        const app = await download(m);
        log(`update ${m.version} staged at ${app}`);
        return set({ state: 'ready', version: m.version, notes: m.notes || '', staged: app });
      } catch (e) {
        log(`update failed: ${e.message}`);
        if (stageDir) fs.rmSync(stageDir, { recursive: true, force: true });
        return set({ state: 'error', error: e.message });
      } finally { busy = null; }
    })();
    return busy;
  }

  // Hand over to a detached script: it waits for this process to exit, swaps the bundles (putting the old one back if
  // anything fails), cleans up and optionally reopens the app. Returns false when there is nothing staged.
  function install({ relaunch, pid = process.pid, open = '/usr/bin/open' }) {
    if (state.state !== 'ready' || !fs.existsSync(state.staged)) return false;
    const script = [
      'pid="$1"; cur="$2"; new="$3"; stage="$4"; relaunch="$5"; open="$6"',
      'n=0; while kill -0 "$pid" 2>/dev/null && [ $n -lt 600 ]; do sleep 0.1; n=$((n+1)); done',
      'old="$stage/previous.app"; rm -rf "$old"',
      'if mv "$cur" "$old"; then',
      '  if mv "$new" "$cur"; then rm -rf "$old"; else mv "$old" "$cur"; fi',
      'fi',
      'rm -rf "$stage"',
      '[ "$relaunch" = 1 ] && "$open" "$cur"',
      'exit 0',
    ].join('\n');
    const child = spawn('/bin/sh', ['-c', script, 'synapse-update', String(pid), bundle, state.staged, stageDir, relaunch ? '1' : '0', open], { detached: true, stdio: 'ignore' });
    child.unref();
    set({ ...state, state: 'installing' });
    return true;
  }

  return { check, install, get state() { return state; } };
}
