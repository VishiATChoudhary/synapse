#!/usr/bin/env node
// Build dist/mac-arm64/Synapse.app and dist/Synapse-<version>-arm64.dmg.
//   node scripts/build-app.mjs             sign with the Developer ID in the keychain and notarize (what releases need)
//   node scripts/build-app.mjs --ad-hoc    skip Apple entirely: quick local build, Gatekeeper warns on first launch
// With a "Developer ID Application" certificate present, electron-builder signs with the hardened runtime
// (app/build/entitlements.mac.plist) and hands the app to Apple's notary service. Credentials, first match wins:
//   - any APPLE_* variables electron-builder understands (APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID,
//     or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_KEYCHAIN_PROFILE)
//   - the `synapse` notarytool profile: `xcrun notarytool store-credentials synapse` once, then nothing to pass.
// A signed-but-not-notarized app still trips Gatekeeper, so this fails unless the result passes `spctl`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const CONFIG = 'app/build/electron-builder.json';
const APP = path.join(ROOT, 'dist', 'mac-arm64', 'Synapse.app');
const builder = path.join(ROOT, 'node_modules', '.bin', 'electron-builder');

const run = (cmd, a, env = {}) => {
  const r = spawnSync(cmd, a, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const out = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };

const identity = out('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']).split('\n').find((l) => l.includes('Developer ID Application'));

if (args.includes('--ad-hoc') || !identity) {
  if (!identity) console.warn('build-app: no "Developer ID Application" certificate in the keychain, ad-hoc signing (Gatekeeper will warn)');
  const noSign = { CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  run(builder, ['--mac', 'dir', '--arm64', '--config', CONFIG], noSign);
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', APP]);
  run(builder, ['--mac', 'dmg', '--arm64', '--prepackaged', APP, '--config', CONFIG], noSign);
  process.exit(0);
}

const env = {};
const hasCreds = ['APPLE_ID', 'APPLE_API_KEY', 'APPLE_KEYCHAIN_PROFILE'].some((k) => process.env[k]);
if (!hasCreds && out('/usr/bin/xcrun', ['notarytool', 'history', '--keychain-profile', 'synapse'])) env.APPLE_KEYCHAIN_PROFILE = 'synapse';
if (!hasCreds && !env.APPLE_KEYCHAIN_PROFILE) {
  console.error('build-app: found a Developer ID but no notary credentials. Run `xcrun notarytool store-credentials synapse` once (see README), or use --ad-hoc.');
  process.exit(1);
}
console.log(`build-app: signing with ${identity.trim().replace(/^\S+\s+\S+\s+/, '')}, notarizing via ${env.APPLE_KEYCHAIN_PROFILE ? 'keychain profile "synapse"' : 'APPLE_* environment'}`);
run(builder, ['--mac', 'dmg', 'dir', '--arm64', '--config', CONFIG], env);

// Prove it: Gatekeeper must accept the app as "Notarized Developer ID" and the ticket must be stapled on.
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', APP]);
const assess = spawnSync('/usr/sbin/spctl', ['-a', '-t', 'exec', '-vv', APP], { encoding: 'utf8' });
const verdict = (assess.stdout + assess.stderr).trim();
console.log(verdict);
if (assess.status !== 0 || !/Notarized Developer ID/.test(verdict)) {
  console.error('build-app: Gatekeeper did not accept the app, do not ship this build');
  process.exit(1);
}
run('/usr/bin/xcrun', ['stapler', 'validate', APP]);

// The dmg is what people download: sign, notarize and staple it too, so it opens without a warning even offline.
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const DMG = path.join(ROOT, 'dist', `Synapse-${version}-arm64.dmg`);
const name = identity.match(/"(.+)"/)[1];
run('/usr/bin/codesign', ['--force', '--timestamp', '--sign', name, DMG]);
if (env.APPLE_KEYCHAIN_PROFILE) {
  run('/usr/bin/xcrun', ['notarytool', 'submit', DMG, '--keychain-profile', env.APPLE_KEYCHAIN_PROFILE, '--wait']);
  run('/usr/bin/xcrun', ['stapler', 'staple', DMG]);
  run('/usr/sbin/spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv', DMG]);
} else console.warn('build-app: the dmg is signed but only the app inside is notarized (no keychain profile)');
console.log('build-app: signed, notarized and stapled');
