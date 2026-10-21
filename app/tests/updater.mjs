// Run with node app/tests/updater.mjs. Self-update end to end against a local fake release: signature, checksum,
// staging next to the app, and the swap after the app quits. Uses throwaway bundles, never the real Synapse.app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createUpdater, signManifest, verifyManifest, windowsEntry, newer, bundleOf, PUBLIC_KEY } from '../updater.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-update-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await sleep(50); }
  throw new Error(`Timed out: ${label}`);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' }), PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });

// a minimal, ad-hoc signed Synapse.app that says which version it is
function bundle(dir, version) {
  const app = path.join(dir, 'Synapse.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Synapse</string><key>CFBundleIdentifier</key><string>dev.synapse.test</string>
<key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  fs.copyFileSync('/usr/bin/true', path.join(app, 'Contents', 'MacOS', 'Synapse'));
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
  return app;
}
const versionOf = (app) => execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();

// the fake release: a zip of 0.3.1 and a signed latest.json, served over HTTP
const build = path.join(tmp, 'build'); fs.mkdirSync(build);
const zip = path.join(tmp, 'Synapse-arm64.zip');
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle(build, '0.3.1'), zip]);
const zipBytes = fs.readFileSync(zip);
let files = {};
const server = http.createServer((req, res) => {
  const body = files[req.url.split('?')[0]];
  if (!body) { res.writeHead(404); return res.end(); }
  res.writeHead(200); res.end(body);
}).listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const manifest = (over = {}) => signManifest({ version: '0.3.1', url: `${base}/Synapse-arm64.zip`, sha256: crypto.createHash('sha256').update(zipBytes).digest('hex'), size: zipBytes.length, dmg: `${base}/Synapse-arm64.dmg`, notes: 'test notes', ...over }, PRIV);
const publish = (m, zipBody = zipBytes) => { files = { '/latest.json': JSON.stringify(m), '/Synapse-arm64.zip': zipBody }; };
const installed = (name) => { const d = path.join(tmp, name, 'Applications'); fs.mkdirSync(d, { recursive: true }); return bundle(d, '0.3.0'); };
const updaterFor = (app, states = []) => createUpdater({ currentVersion: '0.3.0', bundle: app, manifestUrl: `${base}/latest.json`, publicKey: PUB, onState: (s) => states.push(s.state) });

try {
  // signatures: every field that matters is covered, and only our key counts
  const m = manifest();
  assert.equal(verifyManifest(m, PUB).version, '0.3.1');
  for (const [k, v] of [['version', '0.3.2'], ['url', 'https://evil.example/x.zip'], ['sha256', 'a'.repeat(64)], ['size', 5]]) {
    assert.throws(() => verifyManifest({ ...m, [k]: v }, PUB), /signature|malformed|size/, `changing ${k} breaks the signature`);
  }
  assert.throws(() => verifyManifest(m, PUBLIC_KEY), /signature/, 'a release signed with another key is refused');
  assert.throws(() => verifyManifest({ ...m, sig: undefined }, PUB), /no sig/);
  console.log('PASS manifest signatures');

  assert.ok(newer('0.3.1', '0.3.0') && newer('0.10.0', '0.9.9') && newer('1.0.0', '0.99.99'));
  assert.ok(!newer('0.3.0', '0.3.0') && !newer('0.2.9', '0.3.0'));
  assert.equal(bundleOf('/Applications/Synapse.app/Contents/MacOS/Synapse'), '/Applications/Synapse.app');
  assert.equal(bundleOf('/usr/local/bin/node'), null);
  assert.equal(bundleOf('C:\\Users\\a\\AppData\\Local\\Programs\\Synapse\\Synapse.exe', 'win32'), 'C:\\Users\\a\\AppData\\Local\\Programs\\Synapse');
  assert.equal(bundleOf('C:\\Program Files\\nodejs\\node.exe', 'win32'), null);
  console.log('PASS versions and bundle path');

  // Windows: its own signed entry in the same manifest; the Mac fields stay valid for Macs
  const setup = Buffer.from('fake installer');
  const winM = signManifest({ ...m, sig: undefined, win: signManifest({ version: '0.3.1', url: `${base}/Synapse-Setup-x64.exe`, sha256: crypto.createHash('sha256').update(setup).digest('hex'), size: setup.length }, PRIV) }, PRIV);
  assert.equal(verifyManifest(winM, PUB).url, m.url, 'a Mac still reads its own entry');
  assert.equal(windowsEntry(winM, PUB).url, `${base}/Synapse-Setup-x64.exe`);
  assert.equal(windowsEntry(m, PUB), null, 'a release without a Windows build offers nothing');
  assert.throws(() => windowsEntry({ ...winM, win: { ...winM.win, size: 99 } }, PUB), /signature/);
  assert.throws(() => windowsEntry({ ...winM, version: '0.3.2' }, PUB), /signature/, 'the version is covered by the Windows signature too');
  const winDir = path.join(tmp, 'win', 'Synapse'); fs.mkdirSync(winDir, { recursive: true });
  files = { '/latest.json': JSON.stringify(winM), '/Synapse-Setup-x64.exe': setup };
  const winUp = await createUpdater({ currentVersion: '0.3.0', bundle: winDir, manifestUrl: `${base}/latest.json`, publicKey: PUB, platform: 'win32' }).check();
  assert.equal(winUp.state, 'ready', winUp.error);
  assert.deepEqual(fs.readFileSync(winUp.staged), setup, 'the installer is staged as downloaded');
  console.log('PASS windows manifest entry and staging');

  // nothing newer: stays idle
  publish(manifest({ version: '0.3.0' }));
  const same = installed('same');
  assert.equal((await updaterFor(same).check()).state, 'idle');
  console.log('PASS no update when current');

  // a forged release (bytes swapped after signing) is refused and the app is untouched
  publish(manifest(), Buffer.concat([zipBytes.subarray(0, -10), Buffer.alloc(10)]));
  const forged = installed('forged');
  const bad = await updaterFor(forged).check();
  assert.equal(bad.state, 'error');
  assert.match(bad.error, /checksum/);
  assert.equal(versionOf(forged), '0.3.0');
  assert.ok(!fs.existsSync(path.join(path.dirname(forged), '.synapse-update')), 'nothing left staged');
  console.log('PASS forged download refused');

  // a release signed with someone else's key is refused before anything downloads
  const { privateKey: other } = crypto.generateKeyPairSync('ed25519');
  publish(signManifest({ ...manifest(), sig: undefined }, other.export({ type: 'pkcs8', format: 'pem' })));
  assert.match((await updaterFor(installed('foreign')).check()).error, /signature/);
  console.log('PASS foreign signature refused');

  // can't write next to the app: offer the download instead
  publish(manifest());
  const locked = installed('locked');
  fs.chmodSync(path.dirname(locked), 0o555);
  const man = await updaterFor(locked).check();
  fs.chmodSync(path.dirname(locked), 0o755);
  assert.equal(man.state, 'manual');
  assert.equal(man.dmg, `${base}/Synapse-arm64.dmg`);
  console.log('PASS read-only location falls back to the download');

  // the real path: download, stage next to the app, swap once the app quits, reopen it
  const app = installed('real');
  const states = [];
  const up = updaterFor(app, states);
  const ready = await up.check();
  assert.equal(ready.state, 'ready', ready.error);
  assert.equal(ready.version, '0.3.1');
  assert.ok(states.includes('downloading'));
  assert.equal(versionOf(app), '0.3.0', 'the running app is not touched while it runs');
  assert.equal(versionOf(ready.staged), '0.3.1');
  assert.equal((await up.check()).state, 'ready', 'checking again keeps the staged update');

  const running = spawn('/bin/sleep', ['30']); // stands in for the app's own process
  const opened = path.join(tmp, 'opened');
  const open = path.join(tmp, 'open.sh');
  fs.writeFileSync(open, `#!/bin/sh\necho "$1" > "${opened}"\n`); fs.chmodSync(open, 0o755);
  assert.equal(up.install({ relaunch: true, pid: running.pid, open }), true);
  await sleep(500);
  assert.equal(versionOf(app), '0.3.0', 'waits for the app to quit');
  running.kill();
  await until(() => fs.existsSync(opened), 'the app reopened');
  assert.equal(versionOf(app), '0.3.1', 'the new version is in place');
  assert.equal(fs.readFileSync(opened, 'utf8').trim(), app, 'reopened from the same place');
  assert.ok(!fs.existsSync(path.join(path.dirname(app), '.synapse-update')), 'staging and the old copy are cleaned up');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', app]);
  assert.equal(up.install({ relaunch: false }), false, 'nothing left to install');
  console.log('PASS download, stage, swap after quit, reopen');
  console.log('updater suite passed');
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
