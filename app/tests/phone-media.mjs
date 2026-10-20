// Screenshots and videos from an agent's chat reach the phone: a real local Synapse Cloud, the app's bridge,
// and the phone app's protocol code. A Claude transcript with a screenshot and a video it rendered.
//   node app/tests/phone-media.mjs            (ffmpeg, if installed)
//   SYNAPSE_NO_FFMPEG=1 node app/tests/phone-media.mjs   (macOS's avconvert)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startCloud } from './cloud-fixture.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-media-'));
const cwd = path.join(home, 'project');
fs.mkdirSync(path.join(cwd, 'out'), { recursive: true });

// a 40 s 1080p video, big enough that it has to be made smaller
const video = path.join(cwd, 'out', 'demo.mp4');
const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((p) => fs.existsSync(p));
if (!ffmpeg) { console.log('SKIP phone media: needs ffmpeg to make the test video'); process.exit(0); }
execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '40',
  '-c:v', 'libx264', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
assert.ok(fs.statSync(video).size > 20e6, 'the test video starts too big for the phone');
const png = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x200', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-']).toString('base64');

const transcript = path.join(home, 'session.jsonl');
const line = (o) => JSON.stringify({ timestamp: new Date().toISOString(), ...o });
fs.writeFileSync(transcript, [
  line({ type: 'user', message: { role: 'user', content: 'Make a demo video of the page and show me a screenshot.' } }),
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Taking a screenshot first.' }, { type: 'tool_use', name: 'mcp__playwright__browser_take_screenshot', input: {} }] } }),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] } }),
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ffmpeg -i rec.mov out/demo.mp4' } }] } }),
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Rendered `out/demo.mp4` and `out/missing.mp4`.' }] } }),
].join('\n') + '\n');

process.env.SYNAPSE_HOME = home;
process.env.SYNAPSE_DEMO = '1';
process.env.SYNAPSE_DEMO_TRANSCRIPT = transcript;
process.env.SYNAPSE_DEMO_CWD = cwd;
const cloud = await startCloud();
process.env.SYNAPSE_CLOUD = cloud.base;
const owner = await cloud.signup('owner@example.com', 'Owner');
fs.writeFileSync(path.join(home, 'account.json'), JSON.stringify({ cloud: cloud.base, token: owner.token, user: owner.user }));

const phone = await import('../phone.mjs');
const link = await import('../../mobile/src/link.js');
phone.start({ projects: () => [], kinds: () => ['claude'], ptyOf: () => null, write() {}, submit() {}, spawn() {}, changed() {} });

const until = async (what, fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 200)); }
};
const inbox = [];
const pull = async () => inbox.push(...await c.poll());
const find = (fn) => inbox.find(fn);

const me = await link.signIn(cloud.base, { email: 'owner@example.com', password: 'correct horse' }, 'Test iPhone');
const [mac] = await until('the Mac registers', async () => { const l = await link.computers(me); return l.length && l; });
const c = link.connect(me, mac);
await c.send({ t: 'hello' });
await until('asking', async () => (await phone.devices()).list.length);
phone.allow((await phone.devices()).list[0].id);

// an older phone (no media: 1) gets text only
await c.send({ t: 'hello' });
await c.send({ t: 'watch', id: 'demo-media' });
const plain = await until('messages for an old phone', async () => { await pull(); return find((m) => m.t === 'messages' && m.id === 'demo-media'); });
assert.ok(plain.messages.every((m) => !m.media), 'no media for a phone that did not ask');
assert.ok(plain.messages.some((m) => m.text.includes('Rendered')));

// this phone shows media
inbox.length = 0;
await c.send({ t: 'hello', media: 1 });
await c.send({ t: 'watch', id: 'demo-media' });
const withMedia = await until('messages with media', async () => { await pull(); return [...inbox].reverse().find((m) => m.t === 'messages' && m.messages.some((x) => x.media)); });
const shotMsg = withMedia.messages.find((m) => m.role === 'assistant' && m.text.includes('Taking a screenshot'));
assert.equal(shotMsg.media.length, 1, 'the screenshot belongs to the message that took it');
assert.equal(shotMsg.media[0].kind, 'image');
const vids = withMedia.messages.flatMap((m) => m.media || []).filter((x) => x.kind === 'video');
assert.equal(new Set(vids.map((v) => v.id)).size, 1, 'only the video that exists, once');
assert.equal(vids[0].name, 'demo.mp4');

inbox.length = 0;
await c.send({ t: 'media', id: shotMsg.media[0].id });
const img = await until('the screenshot arrives', async () => { await pull(); return find((m) => m.t === 'media'); });
assert.equal(img.data, png, 'small images go as they are');

// the phone copy is made while the phone looks at the chat
const ready = await until('the phone copy of the video is ready', async () => {
  await pull();
  return [...inbox].reverse().map((m) => m.t === 'messages' && m.messages.flatMap((x) => x.media || []).find((x) => x.kind === 'video' && x.state !== 'converting')).find(Boolean);
}, 240_000);
assert.equal(ready.state, 'ready', ready.error || '');
assert.ok(ready.size <= 8 << 20, `the copy is at most 8 MB (${ready.size})`);
assert.ok(ready.duration > 39 && ready.duration < 41);
assert.ok(ready.poster, 'it has a first frame');

// pieces, two at a time, as the app asks for them
inbox.length = 0;
const parts = [];
let asked = 0;
const ask = async () => { if (asked < ready.pieces) await c.send({ t: 'piece', id: ready.id, i: asked++ }); };
await ask(); await ask();
await until('every piece', async () => {
  await pull();
  for (let k = inbox.length - 1; k >= 0; k--) if (inbox[k].t === 'piece') { const p = inbox.splice(k, 1)[0]; parts[p.i] = p.bytes; await ask(); }
  if (process.env.DEBUG) console.log('pieces', parts.filter(Boolean).length, '/', ready.pieces, 'asked', asked, 'inbox', inbox.map((m) => m.t + (m.gone ? ' gone' : '') + (m.error ? ': ' + m.error : '')).join(','));
  return parts.filter(Boolean).length === ready.pieces;
}, 120_000);
const got = Buffer.concat(parts.map((p) => Buffer.from(p)));
assert.equal(got.length, ready.size);
const copy = path.join(home, 'got.mp4');
fs.writeFileSync(copy, got);
const probe = execFileSync(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name,width', '-of', 'csv=p=0', copy]).toString();
assert.match(probe, /^(h264|hevc),(1280|960|640)$/m, `a phone-sized copy that plays (${probe.trim()})`);

inbox.length = 0;
await c.send({ t: 'media', id: ready.poster });
const poster = await until('the first frame', async () => { await pull(); return find((m) => m.t === 'media'); });
assert.equal(poster.mime, 'image/jpeg');
assert.ok(poster.data.length > 1000);

console.log(`PASS phone media (${process.env.SYNAPSE_NO_FFMPEG ? 'avconvert' : 'ffmpeg'}): text only for old phones, screenshot in its message, video made ${(ready.size / 1e6).toFixed(1)} MB from ${(fs.statSync(video).size / 1e6).toFixed(0)} MB, sent in ${ready.pieces} pieces, first frame`);
cloud.stop();
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
