// Images and videos for the phone: what the agent chats point at, ready to send.
//
// Images come out of the transcripts as base64; big ones are scaled down to a phone-sized JPEG (sips).
// Videos are files on disk: each is converted once to a small phone copy (at most MAX_VIDEO bytes, about
// 720p) with ffmpeg when it is installed, else macOS's own avconvert, plus a first-frame poster. Copies live
// in ~/.synapse/media, named by media id. One conversion runs at a time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { DATA } from '../lib.mjs';

export const DIR = path.join(DATA, 'media');
export const MAX_VIDEO = 8 << 20;
const TARGET = 7.4e6;              // aim under MAX_VIDEO: encoders overshoot a little
const IMAGE_MAX = 400_000;         // base64 characters; bigger images are scaled down
const GIF_AS_IMAGE = 1.5e6;        // a small gif goes as an image when it cannot be converted
const CACHE_MAX = 2 * 1024 ** 3;        // converted copies kept on this Mac, oldest out first
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|gif)$/i;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 20);
const run = (cmd, args, timeout = 10 * 60_000) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stderr })) : resolve(String(stdout)))));
const which = (() => {
  const found = new Map();
  return (name) => {
    if (process.env.SYNAPSE_NO_FFMPEG && /^ff/.test(name)) return null; // tests: the path without ffmpeg
    const dirs = process.platform === 'win32' ? (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean) : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
    if (!found.has(name)) found.set(name, dirs.map((d) => path.join(d, process.platform === 'win32' ? `${name}.exe` : name)).find((p) => fs.existsSync(p)) || null);
    return found.get(name);
  };
})();

// ---------------------------------------------------------------- the store

const images = new Map(); // id -> { mime, data } (base64)
const videos = new Map(); // id -> { path, size, mtime, state, error?, meta? }

export function addImage({ mime, data }) {
  const id = `i${sha(data)}`;
  if (!images.has(id)) images.set(id, { mime, data });
  if (images.size > 400) images.delete(images.keys().next().value);
  return { id, kind: 'image', mime };
}

// a path the agent mentioned: only a video file that exists now counts
export function addVideo(p, cwd) {
  let file = String(p || '');
  if (file.startsWith('~/')) file = path.join(os.homedir(), file.slice(2));
  else if (!path.isAbsolute(file)) file = path.resolve(cwd || os.homedir(), file);
  if (!VIDEO_EXT.test(file)) return null;
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || st.size < 1024) return null;
  const id = `v${sha(`${file}:${st.size}:${st.mtimeMs}`)}`;
  if (!videos.has(id)) {
    const meta = readMeta(id);
    videos.set(id, { path: file, size: st.size, mtime: st.mtimeMs, state: meta ? 'ready' : 'new', meta });
  }
  return id;
}

// what a chat shows for a video: its name, and how far it is
export function videoRef(id) {
  const v = videos.get(id);
  if (!v) return null;
  const m = v.meta || {};
  return {
    id, kind: 'video', name: path.basename(v.path), state: v.state, error: v.error || null,
    ...(v.state === 'ready' ? { duration: m.duration ?? null, cut: m.cut ?? null, size: m.size, pieces: m.pieces, mime: m.mime, poster: m.poster ? `${id}p` : null, asImage: !!m.asImage } : {}),
  };
}

export function image(id) {
  if (images.has(id)) return images.get(id);
  // a video's poster, or a small gif sent as an image
  const v = videos.get(id.replace(/p$/, '')) || videos.get(id);
  if (!v?.meta) return null;
  const file = id.endsWith('p') ? path.join(DIR, `${id.slice(0, -1)}.jpg`) : v.meta.asImage ? v.path : null;
  if (!file) return null;
  try { return { mime: id.endsWith('p') ? 'image/jpeg' : 'image/gif', data: fs.readFileSync(file).toString('base64') }; } catch { return null; }
}

// a phone-sized copy of a big image
export async function shrink(img) {
  if (img.data.length <= IMAGE_MAX || img.small) return img.small || img;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-img-'));
  try {
    const src = path.join(tmp, `in.${img.mime.split('/')[1].replace('jpeg', 'jpg')}`), out = path.join(tmp, 'out.jpg');
    fs.writeFileSync(src, Buffer.from(img.data, 'base64'));
    await run('/usr/bin/sips', ['-Z', '1600', '-s', 'format', 'jpeg', '-s', 'formatOptions', '75', src, '--out', out], 60_000);
    img.small = { mime: 'image/jpeg', data: fs.readFileSync(out).toString('base64') };
  } catch { img.small = img; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return img.small;
}

// ---------------------------------------------------------------- video pieces

export const PIECE = 1 << 20;
export function piece(id, i) {
  const v = videos.get(id);
  if (v?.state !== 'ready' || v.meta.asImage) return null;
  const file = path.join(DIR, `${id}.mp4`);
  const n = Math.ceil(v.meta.size / PIECE);
  if (!(i >= 0 && i < n)) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(PIECE, v.meta.size - i * PIECE));
    fs.readSync(fd, buf, 0, buf.length, i * PIECE);
    return { i, n, size: v.meta.size, bytes: buf };
  } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------- conversion

const queue = [];
let busy = false;
export let onChange = () => {};
export const setOnChange = (fn) => { onChange = fn; };

// start making the phone copy of a video (once); the chat refs show how far it is
export function prepare(id) {
  const v = videos.get(id);
  if (!v || v.state !== 'new') return;
  v.state = 'converting';
  queue.push(id);
  next();
}

async function next() {
  if (busy || !queue.length) return;
  busy = true;
  const id = queue.shift(), v = videos.get(id);
  try {
    v.meta = await convert(id, v.path);
    writeMeta(id, v.meta);
    v.state = 'ready';
  } catch (e) {
    v.state = 'failed';
    v.error = e.userMessage || 'could not make a phone copy of this video';
  }
  busy = false;
  onChange();
  next();
}

const metaFile = (id) => path.join(DIR, `${id}.json`);
function readMeta(id) {
  try {
    const m = JSON.parse(fs.readFileSync(metaFile(id), 'utf8'));
    return m.asImage || fs.existsSync(path.join(DIR, `${id}.mp4`)) ? m : null;
  } catch { return null; }
}
function writeMeta(id, m) { fs.writeFileSync(metaFile(id), JSON.stringify(m)); prune(); }

async function duration(file) {
  const ffprobe = which('ffprobe');
  if (ffprobe) {
    const d = Number((await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 60_000).catch(() => '')).trim());
    if (d > 0) return d;
  }
  const md = (await run('/usr/bin/mdls', ['-raw', '-name', 'kMDItemDurationSeconds', file], 20_000).catch(() => '')).trim();
  if (Number(md) > 0) return Number(md);
  const af = (await run('/usr/bin/afinfo', [file], 20_000).catch(() => '')).match(/estimated duration:\s*([\d.]+)/);
  return af ? Number(af[1]) : null;
}

async function poster(file, out) {
  const ffmpeg = which('ffmpeg');
  if (ffmpeg) {
    try { await run(ffmpeg, ['-y', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-q:v', '5', out], 60_000); if (fs.existsSync(out)) return true; } catch {}
  }
  // Quick Look makes thumbnails of any video macOS can read
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-ql-'));
  try {
    await run('/usr/bin/qlmanage', ['-t', '-s', '640', '-o', tmp, file], 60_000);
    const png = fs.readdirSync(tmp).find((f) => f.endsWith('.png'));
    if (!png) return false;
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', path.join(tmp, png), '--out', out], 30_000);
    return fs.existsSync(out);
  } catch { return false; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function convert(id, file) {
  fs.mkdirSync(DIR, { recursive: true });
  const out = path.join(DIR, `${id}.mp4`), tmp = path.join(DIR, `${id}.part.mp4`);
  const dur = await duration(file);
  const gif = /\.gif$/i.test(file), ffmpeg = which('ffmpeg');
  const hasPoster = await poster(file, path.join(DIR, `${id}.jpg`));
  if (gif && (!ffmpeg || fs.statSync(file).size <= GIF_AS_IMAGE)) {
    if (fs.statSync(file).size > GIF_AS_IMAGE) throw Object.assign(new Error('gif too big'), { userMessage: 'this gif is too big to preview' });
    return { asImage: true, poster: hasPoster, duration: dur };
  }
  let cut = null;
  fs.rmSync(tmp, { force: true });
  if (ffmpeg) {
    // a bitrate that fits the whole video; when that would be too low to watch, keep the first part instead
    const audio = 64_000;
    let rate = dur ? Math.floor((TARGET * 8) / dur - audio) : 1_500_000;
    if (dur && rate < 220_000) { rate = 220_000; cut = Math.floor((TARGET * 8) / (rate + audio)); }
    rate = Math.min(rate, 2_500_000);
    for (let attempt = 0; attempt < 3; attempt++) {
      await run(ffmpeg, ['-y', '-v', 'error', '-i', file, ...(cut ? ['-t', String(cut)] : []),
        '-vf', "scale='min(1280,iw)':-2:flags=bicubic,fps='min(30,source_fps)'", '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main',
        '-b:v', String(rate), '-maxrate', String(Math.floor(rate * 1.4)), '-bufsize', String(rate * 2), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-movflags', '+faststart', tmp]).catch(async (e) => {
        // fps=min(...) needs a recent ffmpeg; try once without it
        if (attempt) throw e;
        await run(ffmpeg, ['-y', '-v', 'error', '-i', file, ...(cut ? ['-t', String(cut)] : []), '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast',
          '-b:v', String(rate), '-maxrate', String(Math.floor(rate * 1.4)), '-bufsize', String(rate * 2), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-movflags', '+faststart', tmp]);
      });
      if (fs.statSync(tmp).size <= MAX_VIDEO) break;
      rate = Math.floor(rate * 0.75);
      if (attempt === 2) throw Object.assign(new Error('still too big'), { userMessage: 'could not make this video small enough' });
    }
  } else {
    if (/\.webm$/i.test(file) || process.platform === 'win32') throw Object.assign(new Error('no ffmpeg'), { userMessage: `install ffmpeg on your computer to preview ${process.platform === 'win32' ? '' : 'webm '}videos` });
    let fits = false;
    for (const preset of ['Preset1280x720', 'Preset960x540', 'Preset640x480']) {
      await run('/usr/bin/avconvert', ['--source', file, '--preset', preset, '--output', tmp, '--replace']);
      if (fs.statSync(tmp).size <= MAX_VIDEO) { fits = true; break; }
    }
    if (!fits) {
      if (!dur) throw Object.assign(new Error('too big'), { userMessage: 'this video is too long to send to the phone' });
      cut = Math.floor((dur * TARGET) / fs.statSync(tmp).size);
      await run('/usr/bin/avconvert', ['--source', file, '--preset', 'Preset640x480', '--output', tmp, '--replace', '--duration', String(cut)]);
      if (fs.statSync(tmp).size > MAX_VIDEO) throw Object.assign(new Error('too big'), { userMessage: 'this video is too long to send to the phone' });
    }
  }
  fs.renameSync(tmp, out);
  const size = fs.statSync(out).size;
  return { mime: 'video/mp4', size, pieces: Math.ceil(size / PIECE), duration: dur, cut: cut && dur && cut < dur ? cut : null, poster: hasPoster };
}

// converted copies past CACHE_MAX go, oldest first
function prune() {
  try {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.mp4') && !f.includes('.part.')).map((f) => ({ f, st: fs.statSync(path.join(DIR, f)) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    let total = 0;
    for (const { f, st } of files) {
      total += st.size;
      if (total > CACHE_MAX) for (const ext of ['.mp4', '.jpg', '.json']) fs.rmSync(path.join(DIR, f.replace(/\.mp4$/, ext)), { force: true });
    }
  } catch {}
}
