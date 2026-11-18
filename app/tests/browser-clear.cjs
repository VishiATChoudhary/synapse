// Real Electron test: clearing the browser's data for a stuck sign-in. "This site" removes the site's cookies
// (including the parent domain's, where sign-in cookies often live) and its storage, and leaves other sites signed
// in; "everything" removes all of it.
// Run: ./node_modules/.bin/electron tests/browser-clear.cjs
const { app, BrowserWindow, session } = require('electron');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.acme.test 127.0.0.1, MAP acme.test 127.0.0.1, MAP other.test 127.0.0.1');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-browser-clear-'));
app.setPath('userData', path.join(dir, 'electron'));
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>ok</title>hi'); });

(async () => {
  await app.whenReady();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const win = new BrowserWindow({ show: false });
  const { createAgentBrowser } = await import(pathToFileURL(path.join(__dirname, '..', 'agent-browser.mjs')));
  const browser = createAgentBrowser({ dataDir: dir, getWin: () => win, agentName: () => 'test', root: path.join(__dirname, '..'), packaged: false });
  const s = session.fromPartition('persist:synapse-browser');
  const set = (url, name, domain) => s.cookies.set({ url, name, value: '1', ...(domain ? { domain } : {}) });
  const names = async () => (await s.cookies.get({})).map((c) => `${c.name}@${c.domain}`).sort();

  await browser.user('a', 'go', { url: `http://app.acme.test:${port}/` });
  const wcOf = () => require('electron').webContents.getAllWebContents().find((w) => w.getURL().includes('app.acme.test'));
  for (let i = 0; i < 50 && !wcOf()?.getURL().includes('acme'); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 500));
  await wcOf().executeJavaScript(`localStorage.setItem('token', 'x')`);
  await set(`http://app.acme.test:${port}/`, 'session');
  await set(`http://acme.test:${port}/`, 'sso', '.acme.test');
  await set(`http://other.test:${port}/`, 'keep');
  assert.deepEqual(await names(), ['keep@other.test', 'session@app.acme.test', 'sso@.acme.test']);

  const r = await browser.user('a', 'clear-site');
  assert.equal(r.site, 'acme.test'); assert.equal(r.cookies, 2);
  assert.deepEqual(await names(), ['keep@other.test'], 'only the other site stays signed in');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await wcOf().executeJavaScript(`localStorage.getItem('token')`), null, 'the site\'s storage is gone');
  console.log('PASS clear this site: its cookies (parent domain too) and storage, other sites kept');

  await browser.user('a', 'clear-all');
  assert.deepEqual(await names(), []);
  console.log('PASS clear everything');
  server.close(); app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
