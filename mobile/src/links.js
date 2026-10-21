// Links and files in an agent's messages that can open on the phone. The same rules as the computer's
// (app/phone-share.mjs targetsIn), which checks again before sharing anything.
const EXT = 'pdf|md|markdown|txt|log|csv|tsv|json|ya?ml|toml|xml|html?|svg|png|jpe?g|gif|webp|mp4|mov|webm';
const SITE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s)<>"'`\]]*)?/g;
const FILE = new RegExp(`(?:file:\\/\\/)?(?:~\\/|\\/|\\.{1,2}\\/)?(?:[\\w@.+-]+\\/)*[\\w@+-][\\w@.+-]*\\.(?:${EXT})\\b`, 'gi');

export function targetsIn(text) {
  const out = new Set(), s = String(text || '');
  for (const m of s.matchAll(SITE)) out.add(m[0].replace(/[.,;:]+$/, ''));
  const bare = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/(?!\/)\S+/gi, (u) => (u.startsWith('file://') ? u : ' '.repeat(u.length)));
  for (const m of bare.matchAll(FILE)) out.add(m[0]);
  return [...out];
}

export const isSite = (target) => /^https?:/i.test(target);
export const labelOf = (target) => (isSite(target) ? target.replace(/^https?:\/\/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\])/, 'localhost').replace(/^https?:\/\//, '').replace(/\/$/, '') : target.split('/').pop());
export const minutesLeft = (expires, now = Date.now()) => Math.max(0, Math.ceil((expires - now) / 60_000));
