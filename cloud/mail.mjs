// Outgoing email: Resend (RESEND_API_KEY) or any SMTP server (SMTP_URL=smtps://user:pass@host:465).
// CLOUD_DEV_MAIL=1 keeps mail in memory instead (readable at GET /v1/dev/outbox) for tests and local runs.
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';

const LOGO = `${process.env.PUBLIC_URL || 'https://app.heysynapse.dev'}/icon.png`;
const FROM = process.env.MAIL_FROM || 'Synapse <onboarding@resend.dev>';
export const devOutbox = [];
export const mailConfigured = () => !!(process.env.RESEND_API_KEY || process.env.SMTP_URL || process.env.CLOUD_DEV_MAIL);

export async function sendMail({ to, subject, text, html }) {
  if (process.env.CLOUD_DEV_MAIL) {
    devOutbox.push({ to, subject, text, t: Date.now() });
    if (devOutbox.length > 200) devOutbox.shift();
    return;
  }
  if (process.env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return;
  }
  if (process.env.SMTP_URL) return smtp(process.env.SMTP_URL, { to, subject, text, html });
  console.warn(`mail not configured, dropped "${subject}" to ${to}`);
}

// A small SMTP client: implicit TLS (smtps, port 465) or STARTTLS (smtp, port 587), AUTH LOGIN.
function smtp(url, { to, subject, text, html }) {
  const u = new URL(url);
  const secure = u.protocol === 'smtps:';
  const port = Number(u.port || (secure ? 465 : 587));
  const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
  const from = FROM.match(/<([^>]+)>/)?.[1] || FROM;
  const boundary = `b${crypto.randomBytes(8).toString('hex')}`;
  const enc = (s) => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
  const b64 = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
  const fromHeader = FROM.includes('<') ? `${enc(FROM.split('<')[0].trim())} <${from}>` : from;
  const message = [
    `From: ${fromHeader}`, `To: ${to}`, `Subject: ${enc(subject)}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${from.split('@')[1] || 'synapse'}>`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(text),
    ...(html ? [`--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(html)] : []),
    `--${boundary}--`, '',
  ].join('\r\n');

  return new Promise((resolve, reject) => {
    let sock = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port });
    let buf = '', waiting = null;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('smtp timeout')); }, 20_000);
    const onData = (d) => {
      buf += d.toString();
      const lines = buf.split('\r\n');
      const last = lines[lines.length - 2];
      if (last && /^\d{3} /.test(last)) { const reply = buf; buf = ''; const w = waiting; waiting = null; w?.(reply); }
    };
    const expect = (code) => new Promise((res, rej) => { waiting = (r) => (r.startsWith(String(code)) ? res(r) : rej(new Error(`smtp: ${r.trim()}`))); });
    const cmd = (line, code) => { const p = expect(code); sock.write(`${line}\r\n`); return p; };
    sock.on('data', onData);
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    (async () => {
      await expect(220);
      await cmd('EHLO synapse', 250);
      if (!secure) {
        await cmd('STARTTLS', 220);
        sock.removeListener('data', onData);
        sock = tls.connect({ socket: sock, servername: u.hostname });
        sock.on('data', onData);
        await new Promise((r) => sock.once('secureConnect', r));
        await cmd('EHLO synapse', 250);
      }
      await cmd('AUTH LOGIN', 334);
      await cmd(Buffer.from(user).toString('base64'), 334);
      await cmd(Buffer.from(pass).toString('base64'), 235);
      await cmd(`MAIL FROM:<${from}>`, 250);
      await cmd(`RCPT TO:<${to}>`, 250);
      await cmd('DATA', 354);
      await cmd(`${message.replace(/^\./gm, '..')}\r\n.`, 250);
      sock.write('QUIT\r\n');
      sock.end();
    })().then(() => { clearTimeout(timer); resolve(); }, (e) => { clearTimeout(timer); sock.destroy(); reject(e); });
  });
}

// --- the emails themselves: short, plain, with the link on its own line
const wrap = (title, body, link, cta) => `<!doctype html><html><body style="margin:0;background:#F4F1EA;font:15px/1.55 -apple-system,Helvetica,Arial,sans-serif;color:#141414">
<div style="max-width:520px;margin:0 auto;padding:40px 28px">
<div style="font:600 13px ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase"><img src="${LOGO}" width="28" height="28" alt="" style="vertical-align:middle;margin-right:9px;border-radius:7px">synapse</div>
<h1 style="font-size:24px;line-height:1.2;margin:28px 0 14px">${title}</h1>
<p style="margin:0 0 22px">${body}</p>
${link ? `<p style="margin:0 0 26px"><a href="${link}" style="display:inline-block;background:#141414;color:#F4F1EA;text-decoration:none;padding:11px 18px;font:600 12px ui-monospace,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase">${cta}</a></p>
<p style="margin:0;color:#6b6b6b;font-size:12.5px;word-break:break-all">Or paste this link: ${link}</p>` : ''}
</div></body></html>`;

export const emails = {
  verify: (name, link) => ({
    subject: 'Confirm your email for Synapse',
    text: `Hi ${name},\n\nConfirm your email so friends can find you on Synapse:\n\n${link}\n\nThe link works for 24 hours. If you did not sign up, ignore this email.`,
    html: wrap('Confirm your email', `Hi ${esc(name)}, confirm your email so friends can find you on Synapse. The link works for 24 hours.`, link, 'Confirm email'),
  }),
  reset: (name, link) => ({
    subject: 'Reset your Synapse password',
    text: `Hi ${name},\n\nSomeone (hopefully you) asked to reset your Synapse password:\n\n${link}\n\nThe link works for one hour. If it was not you, ignore this email: your password stays the same.`,
    html: wrap('Reset your password', `Hi ${esc(name)}, someone (hopefully you) asked to reset your Synapse password. The link works for one hour. If it was not you, ignore this email.`, link, 'Choose a new password'),
  }),
  approved: (name, link) => ({
    subject: 'You are in: Synapse multiplayer is open for you',
    text: `Hi ${name},\n\nYou are off the waitlist. You can now add trusted people and share agents with friends:\n\n${link}`,
    html: wrap('You are in', `Hi ${esc(name)}, you are off the waitlist. You can now add trusted people and share agents with friends.`, link, 'Get started'),
  }),
  trustedInvite: (fromName, link) => ({
    subject: `${fromName} added you as a trusted person on Synapse`,
    text: `${fromName} wants to share coding agents with you on Synapse: their agents and yours can read each other's context once you both agree.\n\nCreate your account:\n\n${link}`,
    html: wrap(`${esc(fromName)} trusts you on Synapse`, `${esc(fromName)} wants to share coding agents with you: their agents and yours can read each other's context once you both agree.`, link, 'Create your account'),
  }),
  trustedBack: (fromName, link) => ({
    subject: `${fromName} added you on Synapse`,
    text: `${fromName} added you to their trusted people on Synapse. Their agents cannot reach yours until you add them too.\n\nTrust back, or ignore:\n\n${link}`,
    html: wrap(`${esc(fromName)} added you`, `${esc(fromName)} added you to their trusted people. Their agents cannot reach yours until you add them too. You still accept each request.`, link, 'Trust back'),
  }),
  offer: (fromName, agentName, link) => ({
    subject: `${fromName} shared an agent with you on Synapse`,
    text: `${fromName} wants to share their agent "${agentName}" with you, so one of your agents can read its context.\n\nAccept it in the Synapse app (the blinking circle at the top right), or see it here:\n\n${link}`,
    html: wrap(`${esc(fromName)} shared an agent`, `${esc(fromName)} wants to share their agent <b>${esc(agentName)}</b> with you, so one of your agents can read its context. Accept it in the Synapse app: the blinking circle at the top right.`, link, 'Open requests'),
  }),
  request: (fromName, agentName, link) => ({
    subject: `${fromName} wants to synapse with your agents`,
    text: `${fromName}'s agent "${agentName}" asked to read context from one of your agents.\n\nAccept or deny it in the Synapse app (the blinking circle at the top right), or see it here:\n\n${link}`,
    html: wrap(`${esc(fromName)} wants to synapse`, `${esc(fromName)}'s agent <b>${esc(agentName)}</b> asked to read context from one of your agents. Accept or deny it in the Synapse app: the blinking circle at the top right.`, link, 'Open requests'),
  }),
};
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
