#!/usr/bin/env node
// Fetch the cloudflared binary the app ships (live links for the phone, app/phone-share.mjs) into app/vendor/.
// Cloudflare's own release, pinned by version and checked against its sha256; kept out of git (app/vendor/ is
// ignored) and fetched again only when the pinned version changes. Apache 2.0, so it may be redistributed.
//   node scripts/fetch-cloudflared.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const VERSION = '2026.9.3';
const SHA256 = '587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095';
const URL_ = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-darwin-arm64.tgz`;

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIR = path.join(ROOT, 'app', 'vendor'), BIN = path.join(DIR, 'cloudflared'), STAMP = path.join(DIR, 'cloudflared.version');

export async function fetchCloudflared() {
  if (fs.existsSync(BIN) && fs.readFileSync(STAMP, 'utf8').trim() === VERSION) return BIN;
  fs.mkdirSync(DIR, { recursive: true });
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`cloudflared ${VERSION}: download failed (${res.status})`);
  const tgz = Buffer.from(await res.arrayBuffer());
  const sum = crypto.createHash('sha256').update(tgz).digest('hex');
  if (sum !== SHA256) throw new Error(`cloudflared ${VERSION}: checksum ${sum} does not match the pinned ${SHA256}`);
  const tmp = path.join(DIR, 'cloudflared.tgz');
  fs.writeFileSync(tmp, tgz);
  execFileSync('/usr/bin/tar', ['-xzf', tmp, '-C', DIR]);
  fs.rmSync(tmp);
  fs.chmodSync(BIN, 0o755);
  const v = execFileSync(BIN, ['--version'], { encoding: 'utf8' });
  if (!v.includes(VERSION)) throw new Error(`cloudflared: expected ${VERSION}, got ${v.trim()}`);
  fs.writeFileSync(STAMP, VERSION);
  return BIN;
}

if (import.meta.url === `file://${process.argv[1]}`) fetchCloudflared().then((b) => console.log(`cloudflared ${VERSION} at ${path.relative(ROOT, b)}`), (e) => { console.error(e.message); process.exit(1); });
