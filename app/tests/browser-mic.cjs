// A page in the agent browser gets the microphone only after you allow its site; Deny keeps it out
const { app, BrowserWindow, systemPreferences } = require('electron');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
systemPreferences.getMediaAccessStatus = () => 'granted'; // no macOS prompt for the test binary
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-browser-mic-'));
app.setPath('userData', path.join(dir, 'electron'));
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>voice</title>hi'); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await app.whenReady();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const win = new BrowserWindow({ show: false });
  const { createAgentBrowser } = await import(pathToFileURL(path.join(__dirname, '..', 'agent-browser.mjs')));
  const browser = createAgentBrowser({ dataDir: dir, getWin: () => win, agentName: () => 'test', root: path.join(__dirname, '..'), packaged: false });
  browser.start();
  const mic = `navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'ok'; }, (e) => e.name)`;
  const pageAt = async (host) => {
    await browser.user('a', 'go', { url: `http://${host}:${port}/` });
    let wc; for (let i = 0; i < 50 && !(wc = require('electron').webContents.getAllWebContents().find((w) => w.getURL().includes(host))); i++) await wait(100);
    await wait(400); return wc;
  };
  const answerNext = async (choice) => {
    let q; for (let i = 0; i < 50 && !(q = browser.snapshot().asks.find((x) => x.kind === 'mic')); i++) await wait(100);
    assert.ok(q, 'Synapse asks before a page gets the microphone');
    browser.answer(q.id, choice); return q;
  };

  let wc = await pageAt('localhost');
  let result = wc.executeJavaScript(mic);
  const q = await answerNext('deny');
  assert.equal(q.origin, `http://localhost:${port}`);
  assert.equal(await result, 'NotAllowedError');
  console.log('PASS deny keeps the microphone off');

  result = wc.executeJavaScript(mic);
  await answerNext('once');
  assert.equal(await result, 'ok');
  assert.equal(await wc.executeJavaScript(mic), 'ok', 'no second question for the same site');
  console.log('PASS allow gives the site the microphone, asked once');

  wc = await pageAt('127.0.0.1');
  result = wc.executeJavaScript(mic);
  await answerNext('always');
  assert.equal(await result, 'ok');
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'agent-browser-mic.json'), 'utf8')).includes(`http://127.0.0.1:${port}`));
  console.log('PASS always remembers the site');
  browser.stop(); server.close(); app.exit(0);
})().catch((e) => { console.error(e); app.exit(1); });
