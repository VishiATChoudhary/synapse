// A real Synapse Cloud on a free port with a throwaway database, for the phone tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLOUD = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../cloud');

export async function startCloud() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-cloud-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  // inside Electron, execPath is Electron: the cloud needs a real node (it uses node:sqlite)
  const proc = spawn(process.versions.electron ? 'node' : process.execPath, ['server.mjs'], {
    cwd: CLOUD, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PORT: String(port), PUBLIC_URL: base, CLOUD_DATA: data, CLOUD_SECRET: 'test-secret', CLOUD_DEV_MAIL: '1', CLOUD_IP_LIMIT_SCALE: '50' },
  });
  let up = false, err = '';
  proc.stderr.on('data', (d) => { err += d; });
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`the test cloud did not start: ${err}`);
  const signup = async (email, name) => {
    const r = await fetch(`${base}/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name, password: 'correct horse', client: 'app' }) });
    return r.json();
  };
  return { base, signup, stop: () => { proc.kill(); fs.rmSync(data, { recursive: true, force: true }); } };
}
