#!/usr/bin/env node
// Fetch the cloudflared binary the app ships (live links for the phone, app/phone-share.mjs) into app/vendor/.
// Cloudflare's own release, pinned by version and checked against its sha256; kept out of git (app/vendor/ is
// ignored) and fetched again only when the pinned version changes. Apache 2.0, so it may be redistributed.
//   node scripts/fetch-cloudflared.mjs            the macOS (arm64) binary
//   node scripts/fetch-cloudflared.mjs --win      the Windows (x64) one, app/vendor/cloudflared.exe
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = '2026.9.3';
const BUILDS = {
  mac: { file: 'cloudflared-darwin-arm64.tgz', sha256: '587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095', bin: 'cloudflared' },
  win: { file: 'cloudflared-windows-amd64.exe', sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2', bin: 'cloudflared.exe' },
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'app', 'vendor');

export async function fetchCloudflared(platform = 'mac') {
  const b = BUILDS[platform];
  const BIN = path.join(DIR, b.bin), STAMP = path.join(DIR, `${b.bin}.version`);
  if (fs.existsSync(BIN) && fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === VERSION) return BIN;
  fs.mkdirSync(DIR, { recursive: true });
  const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${b.file}`);
  if (!res.ok) throw new Error(`cloudflared ${VERSION}: download failed (${res.status})`);
  const body = Buffer.from(await res.arrayBuffer());
  const sum = crypto.createHash('sha256').update(body).digest('hex');
  if (sum !== b.sha256) throw new Error(`cloudflared ${VERSION}: checksum ${sum} does not match the pinned ${b.sha256}`);
  if (platform === 'win') fs.writeFileSync(BIN, body); // a bare exe, and it cannot run here to report its version
  else {
    const tmp = path.join(DIR, 'cloudflared.tgz');
    fs.writeFileSync(tmp, body);
    execFileSync('/usr/bin/tar', ['-xzf', tmp, '-C', DIR]);
    fs.rmSync(tmp);
    fs.chmodSync(BIN, 0o755);
    const v = execFileSync(BIN, ['--version'], { encoding: 'utf8' });
    if (!v.includes(VERSION)) throw new Error(`cloudflared: expected ${VERSION}, got ${v.trim()}`);
  }
  fs.writeFileSync(STAMP, VERSION);
  return BIN;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fetchCloudflared(process.argv.includes('--win') ? 'win' : 'mac').then((b) => console.log(`cloudflared ${VERSION} at ${path.relative(ROOT, b)}`), (e) => { console.error(e.message); process.exit(1); });
}
