// The packaged app ships only the files listed in app/build/electron-builder.json. Every local module a shipped
// file imports must be listed too, or the installed app crashes on a missing import that the checkout never shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/build/electron-builder.json'), 'utf8')).files;
const listed = (rel) => files.some((f) => !f.startsWith('!') && (f === rel || (f.endsWith('/**') && rel.startsWith(f.slice(0, -2)))));

test('every local import of a shipped module is shipped too', () => {
  const missing = [];
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const [, spec] of src.matchAll(/(?:import|from|require\()\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const dep = path.relative(ROOT, path.resolve(ROOT, path.dirname(rel), spec));
      if (!fs.existsSync(path.join(ROOT, dep))) continue; // optional or generated at runtime
      if (!listed(dep)) missing.push(`${rel} -> ${dep}`);
      else if (/\.(m?js|cjs)$/.test(dep)) visit(dep);
    }
  };
  for (const f of files) if (!f.startsWith('!') && !f.includes('*')) visit(f);
  assert.deepEqual(missing, []);
});

test('the app ships cloudflared where the phone links look for it, and the build fetches it', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/build/electron-builder.json'), 'utf8'));
  assert.ok((config.extraResources || []).some((r) => r.from === 'app/vendor/cloudflared' && r.to === 'cloudflared'), 'Contents/Resources/cloudflared');
  assert.match(fs.readFileSync(path.join(ROOT, 'app/phone-share.mjs'), 'utf8'), /process\.resourcesPath && path\.join\(process\.resourcesPath, name\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/build-app.mjs'), 'utf8'), /await fetchCloudflared\(\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/fetch-cloudflared.mjs'), 'utf8'), /const SHA256 = '[0-9a-f]{64}'/, 'pinned by checksum');
});
