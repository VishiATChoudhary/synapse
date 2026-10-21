#!/usr/bin/env node
// Build, sign and publish a release that installed apps pick up by themselves (see app/updater.mjs).
//   node scripts/release.mjs --notes "what changed"          build, then publish v<package.json version> on GitHub
//   node scripts/release.mjs --skip-build --dry-run           sign what is in dist/ and stop before publishing
//   node scripts/release.mjs --no-win                         Mac only (otherwise the Windows installer ships in the same release)
// The update key comes from SYNAPSE_UPDATE_KEY (Ed25519 private key, PEM). Without it, nothing is signed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signManifest, verifyManifest, windowsEntry } from '../app/updater.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'VishiATChoudhary/synapse';
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const run = (cmd, a, o = {}) => execFileSync(cmd, a, { cwd: ROOT, stdio: 'inherit', ...o });

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const tag = `v${version}`;
const key = process.env.SYNAPSE_UPDATE_KEY;
if (!key) throw new Error('SYNAPSE_UPDATE_KEY is not set: run with `vault exec SYNAPSE_UPDATE_KEY -- node scripts/release.mjs ...`');
const notes = opt('--notes') || '';

const withWin = !flag('--no-win');
if (!flag('--skip-build')) {
  run('npm', ['run', 'app:build']);
  if (withWin) run('node', ['scripts/build-app.mjs', '--win']);
}
const app = path.join(ROOT, 'dist', 'mac-arm64', 'Synapse.app');
const built = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
if (built !== version) throw new Error(`dist has ${built}, package.json says ${version}: build again`);

const out = path.join(ROOT, 'dist', 'release');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const dmg = path.join(out, 'Synapse-arm64.dmg'), zip = path.join(out, 'Synapse-arm64.zip');
fs.copyFileSync(path.join(ROOT, 'dist', `Synapse-${version}-arm64.dmg`), dmg);
run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]); // ditto keeps the bundle's symlinks and signature intact

const bytes = fs.readFileSync(zip);
const download = `https://github.com/${REPO}/releases/download/${tag}`;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// Windows: the NSIS installer, with an entry of its own signed the same way (Macs ignore it)
let win;
const setup = path.join(out, 'Synapse-Setup-x64.exe');
if (withWin) {
  const built = path.join(ROOT, 'dist', `Synapse-Setup-${version}.exe`);
  if (!fs.existsSync(built)) throw new Error(`no ${path.relative(ROOT, built)}: build it with \`node scripts/build-app.mjs --win\`, or pass --no-win`);
  fs.copyFileSync(built, setup);
  const exe = fs.readFileSync(setup);
  win = signManifest({ version, url: `${download}/Synapse-Setup-x64.exe`, sha256: sha(exe), size: exe.length }, key);
  delete win.version; // the top-level version is the one it was signed with
}
const manifest = signManifest({
  version, url: `${download}/Synapse-arm64.zip`, sha256: sha(bytes), size: bytes.length,
  dmg: `${download}/Synapse-arm64.dmg`, notes, date: new Date().toISOString(), ...(win ? { win } : {}),
}, key);
verifyManifest(manifest); // the key matches the public key the app ships with
if (win) windowsEntry(manifest);
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(manifest, null, 2));
console.log(`signed ${tag}: ${(bytes.length / 1e6).toFixed(1)} MB zip, sha256 ${manifest.sha256.slice(0, 12)}…`);

if (flag('--dry-run')) { console.log(`dry run: assets in ${out}`); process.exit(0); }
const notarized = spawnSync('/usr/sbin/spctl', ['-a', '-t', 'exec', app]).status === 0; // scripts/build-app.mjs already refused anything else when a Developer ID exists
const gatekeeper = notarized ? 'Signed and notarized with Apple.' : 'The app is not notarized yet: the first time, right-click Synapse in Applications and choose Open.';
const windows = withWin ? '\n\nWindows (x64): Synapse-Setup-x64.exe. Not code-signed yet, so SmartScreen asks the first time: More info, then Run anyway. Installed copies update themselves.' : '';
const body = `${notes ? `${notes}\n\n` : ''}Apple Silicon. Installed copies from 0.3.1 on update themselves. ${gatekeeper}${windows}\n\nGet started: https://app.heysynapse.dev/signup`;
run('gh', ['release', 'create', tag, '-R', REPO, '--title', `Synapse ${version}`, '--notes', body, dmg, zip, ...(withWin ? [setup] : []), path.join(out, 'latest.json')]);
