#!/usr/bin/env node
// Build, sign and publish a release that installed apps pick up by themselves (see app/updater.mjs).
//   node scripts/release.mjs --notes "what changed"          build, then publish v<package.json version> on GitHub
//   node scripts/release.mjs --skip-build --dry-run           sign what is in dist/ and stop before publishing
// The update key comes from SYNAPSE_UPDATE_KEY (Ed25519 private key, PEM). Without it, nothing is signed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { signManifest, verifyManifest } from '../app/updater.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
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

if (!flag('--skip-build')) run('npm', ['run', 'app:build']);
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
const manifest = signManifest({
  version, url: `${download}/Synapse-arm64.zip`, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
  dmg: `${download}/Synapse-arm64.dmg`, notes, date: new Date().toISOString(),
}, key);
verifyManifest(manifest); // the key matches the public key the app ships with
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(manifest, null, 2));
console.log(`signed ${tag}: ${(bytes.length / 1e6).toFixed(1)} MB zip, sha256 ${manifest.sha256.slice(0, 12)}…`);

if (flag('--dry-run')) { console.log(`dry run: assets in ${out}`); process.exit(0); }
const body = `${notes ? `${notes}\n\n` : ''}Apple Silicon. Installed copies from 0.3.1 on update themselves. The app is not notarized yet: the first time, right-click Synapse in Applications and choose Open.\n\nGet started: https://app.heysynapse.dev/signup`;
run('gh', ['release', 'create', tag, '-R', REPO, '--title', `Synapse ${version}`, '--notes', body, dmg, zip, path.join(out, 'latest.json')]);
