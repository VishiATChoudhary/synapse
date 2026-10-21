// Live links for the phone: what counts as a link or file in a chat, Markdown that cannot carry markup, a file
// server that answers only under its token and only with that file (an HTML page's neighbours, never dotfiles
// or the folder above), and shares that start, top up, end on time or on stop. A fake cloudflared stands in
// for the real one (it prints an address and keeps running, like the real one).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-share-')));
process.env.SYNAPSE_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.SYNAPSE_HOME);
const share = await import('../app/phone-share.mjs');
after(() => share.stopAll());

// prints a tunnel address that points back at the port it was given, so tests can fetch through "the tunnel"
const fake = path.join(tmp, 'cloudflared');
fs.writeFileSync(fake, `#!/bin/sh
port=$(echo "$@" | sed -E 's/.*127\\.0\\.0\\.1:([0-9]+).*/\\1/')
echo "INF |  https://fake-$port.trycloudflare.com  |" >&2
echo "INF Registered tunnel connection" >&2
exec sleep 600
`);
fs.chmodSync(fake, 0o755);
const local = (url) => url.replace(/^https:\/\/fake-(\d+)\.trycloudflare\.com/, 'http://127.0.0.1:$1');
const get = (url) => fetch(local(url)).then(async (r) => ({ status: r.status, body: await r.text(), type: r.headers.get('content-type') }));

const docs = path.join(tmp, 'docs');
fs.mkdirSync(docs);
fs.writeFileSync(path.join(docs, 'plan.md'), '# Plan\n\n- **ship** it\n- <img src=x onerror=alert(1)>\n');
fs.writeFileSync(path.join(docs, 'page.html'), '<link rel=stylesheet href="s.css"><h1>hi</h1>');
fs.writeFileSync(path.join(docs, 's.css'), 'h1{color:red}');
fs.writeFileSync(path.join(docs, '.env'), 'SECRET=1');
fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside');

test('links and files in a message, not web addresses', () => {
  const t = 'Open http://localhost:5173/app. Plan in docs/plan.md and ~/x/report.pdf, see https://example.com/a.pdf, file:///tmp/r.html, [Write: /Users/v/out/chart.png] and src/lib.mjs';
  assert.deepEqual(share.targetsIn(t), ['http://localhost:5173/app', 'docs/plan.md', '~/x/report.pdf', 'file:///tmp/r.html', '/Users/v/out/chart.png']);
  assert.equal(share.siteOf('http://example.com:80/'), null, 'only this machine');
  assert.deepEqual(share.siteOf('http://127.0.0.1:3000/a?b=1'), { port: 3000, path: '/a?b=1' });
});

test('markdown is escaped before it is formatted', () => {
  const html = share.markdown('# T\n\n- <script>x</script> **b**\n\n```\n<y>\n```\n\n[ok](https://a.dev) [bad](javascript:alert(1))');
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt; <strong>b<\/strong>/);
  assert.match(html, /<pre><code>&lt;y&gt;<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/a.dev">ok<\/a>/);
  assert.doesNotMatch(html, /href="javascript/, 'only web and anchor links become links');
});

test('a file share serves that file under its token, Markdown as a page, nothing else', async () => {
  const s = await share.share('plan.md', { cwd: docs, cloudflared: fake, ready: async () => {} });
  assert.equal(s.state, 'live', s.error);
  const page = await get(s.url);
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /<strong>ship<\/strong>/);
  assert.doesNotMatch(page.body, /<img src=x/, 'markup in the file stays text');
  assert.equal((await get(`${s.url}plan.md`)).body, fs.readFileSync(path.join(docs, 'plan.md'), 'utf8'), 'the raw file to download');
  for (const p of ['.env', 's.css', '..%2Foutside.txt', '../outside.txt']) assert.equal((await get(`${s.url}${p}`)).status, 404, p);
  assert.equal((await get(s.url.replace(/[0-9a-f]{32}/, 'f'.repeat(32)))).status, 404, 'a wrong token finds nothing');
});

test('an HTML page also gets the files next to it, never dotfiles or the folder above', async () => {
  const s = await share.share(path.join(docs, 'page.html'), { cloudflared: fake, ready: async () => {} });
  assert.match((await get(s.url)).body, /<h1>hi<\/h1>/);
  assert.equal((await get(`${s.url}s.css`)).body, 'h1{color:red}');
  for (const p of ['.env', '..%2Foutside.txt', '%2E%2E/outside.txt']) assert.equal((await get(`${s.url}${p}`)).status, 404, p);
});

test('a site share tunnels its port; the same target gives the same link; extend, stop and expiry', async (t) => {
  const site = http.createServer((req, res) => res.end(`host ${req.headers.host}`));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  t.after(() => site.close());
  const port = site.address().port;
  const s = await share.share(`http://localhost:${port}/dash?x=1`, { cloudflared: fake, ready: async () => {} });
  assert.equal(s.state, 'live', s.error);
  assert.ok(s.url.endsWith('/dash?x=1'), 'opens where the agent pointed');
  assert.equal((await share.share(`http://localhost:${port}/dash?x=1`, { cloudflared: fake, ready: async () => {} })).id, s.id);
  const later = share.extend(s.id);
  assert.ok(later.expires - Date.now() > share.TTL + 60_000, 'extend adds 15 minutes');
  assert.ok(share.list().some((x) => x.id === s.id));
  assert.equal(share.stop(s.id), true);
  assert.ok(!share.list().some((x) => x.id === s.id), 'stopped');
  await assert.rejects(share.share('http://localhost:1/', { cloudflared: fake, ready: async () => {} }), /nothing is running on localhost:1/);
  await assert.rejects(share.share(path.join(docs, 'missing.pdf'), { cloudflared: fake, ready: async () => {} }), /does not exist/);
  await assert.rejects(share.share(path.join(docs, 'x.exe'), { cloudflared: fake, ready: async () => {} }), /cannot be opened/);
  fs.writeFileSync(path.join(docs, 'notes.txt'), 'n');
  await assert.rejects(share.share(path.join(docs, 'notes.txt'), { cloudflared: null }), /missing its tunnel helper/);
});

test('pids are written down and swept, so no tunnel outlives a crash', async () => {
  share.stopAll();
  const s = await share.share(path.join(docs, 'plan.md'), { cloudflared: fake, ready: async () => {} });
  const pids = JSON.parse(fs.readFileSync(path.join(process.env.SYNAPSE_HOME, 'shares.json'), 'utf8'));
  assert.equal(pids.length, 1);
  share.stopAll();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.SYNAPSE_HOME, 'shares.json'), 'utf8')), [], 'cleared on stop');
  assert.equal(share.list().length, 0, s.id);
});
