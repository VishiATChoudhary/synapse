// Website logins from the user's vault (~/shennies/vault, `vault login set SITE USER`): its index lists them (site
// and user, never secrets) and the macOS Keychain holds the values. The agent browser fills a login into a page
// after you approve it; the password goes from the Keychain into the page and never to the agent.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = () => process.env.VAULT_HOME || path.join(os.homedir(), '.vault');
const SERVICE = () => process.env.VAULT_SERVICE || 'shennies-vault';
// tests: a JSON file of { BASE: { username, password } } instead of the Keychain (unpackaged runs only)
const FAKE = () => process.env.SYNAPSE_VAULT_FAKE || null;

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const siteHost = (site) => String(site || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split('@').pop().split(':')[0].replace(/^www\./, '');
// a login for github.com is good on github.com and its subdomains (and the other way round: a login saved for
// accounts.example.com works on example.com's sign-in)
const matches = (site, host) => !!site && !!host && (host === site || host.endsWith(`.${site}`) || site.endsWith(`.${host}`));

export function logins() {
  let index = {};
  try { index = JSON.parse(fs.readFileSync(path.join(HOME(), 'index.json'), 'utf8')); } catch { return []; }
  return Object.entries(index)
    .filter(([k, e]) => e?.type === 'login' && k.endsWith('_PASSWORD'))
    .map(([k, e]) => ({ base: k.slice(0, -'_PASSWORD'.length), site: siteHost(e.site), user: String(e.user || '') }));
}
export const available = () => fs.existsSync(path.join(HOME(), 'index.json'));
export const loginsFor = (url) => { const host = hostOf(url); return logins().filter((l) => matches(l.site, host)); };

const keychain = (account) => new Promise((resolve, reject) => {
  execFile('/usr/bin/security', ['find-generic-password', '-a', account, '-s', SERVICE(), '-w'], { timeout: 20000 }, (err, out) => {
    if (err) reject(new Error('The Keychain did not give the login (is it locked, or was access denied?).'));
    else resolve(out.replace(/\n$/, ''));
  });
});

// the secret, only for filling; callers never pass it to an agent
export async function secret(base, { packaged = true } = {}) {
  if (!/^[A-Z0-9_]+$/.test(base)) throw new Error('Not a vault login.');
  if (FAKE() && !packaged) {
    const f = JSON.parse(fs.readFileSync(FAKE(), 'utf8'))[base];
    if (!f) throw new Error('No such login.');
    return f;
  }
  if (process.platform !== 'darwin') throw new Error('Vault logins come from the macOS Keychain.');
  const [username, password] = await Promise.all([keychain(`${base}_USERNAME`).catch(() => null), keychain(`${base}_PASSWORD`)]);
  return { username: username ?? '', password };
}
