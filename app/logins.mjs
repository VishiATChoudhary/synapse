// Website logins you add in Synapse (Settings > Logins), for the agent browser to sign in with. The file keeps the site
// and username in the clear and the password encrypted with Electron's safeStorage (a key in the macOS Keychain, DPAPI
// on Windows), so it is only readable by Synapse on this Mac. An agent never gets a password: the browser fills it into
// the page after you approve (agent-browser.mjs), the same way as logins from the vault (vault.mjs).
import fs from 'node:fs';
import crypto from 'node:crypto';

const siteHost = (site) => String(site || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split('@').pop().split(':')[0].replace(/^www\./, '');
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const matches = (site, host) => !!site && !!host && (host === site || host.endsWith(`.${site}`) || site.endsWith(`.${host}`));

export function createLogins({ file, safeStorage }) {
  const read = () => { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(d.logins) ? d.logins : []; } catch { return []; } };
  const write = (logins) => fs.writeFileSync(file, JSON.stringify({ logins }, null, 2), { mode: 0o600 });
  const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
  // what callers see: never the password
  const shown = (l) => ({ base: l.base, site: l.site, user: l.user, addedAt: l.addedAt, source: 'synapse' });

  function list() { return read().map(shown); }
  function add({ site, username, password }) {
    const host = siteHost(site);
    if (!host || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.') && host !== 'localhost') throw new Error('Enter the site, like github.com.');
    const user = String(username || '').trim();
    if (!user) throw new Error('Enter the username or email.');
    if (!password) throw new Error('Enter the password.');
    if (String(password).length > 4096 || user.length > 512) throw new Error('That login is too long.');
    if (!canEncrypt()) throw new Error('This Mac cannot encrypt the password right now (is the Keychain locked?).');
    const logins = read();
    const same = logins.find((l) => l.site === host && l.user === user);
    const pw = safeStorage.encryptString(String(password)).toString('base64');
    if (same) { same.pw = pw; same.addedAt = Date.now(); }
    else logins.push({ base: `SYNAPSE_${crypto.randomBytes(6).toString('hex').toUpperCase()}`, site: host, user, pw, addedAt: Date.now() });
    write(logins);
    return shown(same || logins.at(-1));
  }
  function remove(base) {
    const logins = read(), next = logins.filter((l) => l.base !== base);
    if (next.length === logins.length) throw new Error('No such login.');
    write(next);
  }
  const loginsFor = (url) => { const host = hostOf(url); return list().filter((l) => matches(l.site, host)); };
  // the password, only for filling it into a page
  function secret(base) {
    const l = read().find((x) => x.base === base);
    if (!l) throw new Error('No such login.');
    return { username: l.user, password: safeStorage.decryptString(Buffer.from(l.pw, 'base64')) };
  }
  return { list, add, remove, loginsFor, secret, has: (base) => read().some((l) => l.base === base) };
}
