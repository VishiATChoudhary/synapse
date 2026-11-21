import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiKeys, withKeys, CODEX_KEY_FLAGS } from '../app/api-keys.mjs';

const crypto = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(`enc:${t}`), decryptString: (b) => String(b).replace(/^enc:/, '') };
const make = (fetch = null) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-keys-')), 'api-keys.json');
  return { file, keys: createApiKeys({ file, safeStorage: crypto, fetch }) };
};

test('a saved key is encrypted, shown by its last four, and reaches the agents that use it', async () => {
  const { file, keys } = make();
  await keys.set('anthropic', '  ANTHROPIC_API_KEY="sk-ant-secret-1234"  ');
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /"sk-ant-secret-1234"/);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  const a = keys.list().find((p) => p.id === 'anthropic');
  assert.equal(a.saved, true); assert.equal(a.last4, '1234'); assert.equal(JSON.stringify(keys.list()).includes('secret'), false);
  assert.deepEqual(keys.envFor('claude').env, { ANTHROPIC_API_KEY: 'sk-ant-secret-1234' });
  assert.deepEqual(keys.envFor('opencode').env, { ANTHROPIC_API_KEY: 'sk-ant-secret-1234' });
  assert.deepEqual(keys.envFor('codex').env, {});
  assert.deepEqual(keys.envFor('shell').env, {});
});

test('an agent can be turned off for a key, and a removed key is gone', async () => {
  const { keys } = make();
  await keys.set('openai', 'sk-openai-abcdefgh');
  keys.use('openai', 'codex', false);
  assert.deepEqual(keys.envFor('codex').env, {});
  assert.equal(keys.envFor('opencode').env.OPENAI_API_KEY, 'sk-openai-abcdefgh');
  keys.use('openai', 'codex', true);
  assert.equal(keys.envFor('codex').env.OPENAI_API_KEY, 'sk-openai-abcdefgh');
  assert.throws(() => keys.use('openai', 'claude', true), /not used by that agent/);
  keys.remove('openai');
  assert.deepEqual(keys.envFor('codex').env, {});
});

test('a key the provider refuses is not saved; one it cannot reach is', async () => {
  const refused = make(async () => ({ ok: false, status: 401 })).keys;
  await assert.rejects(refused.set('openai', 'sk-wrong-12345678'), /refused/);
  assert.equal(refused.list().find((p) => p.id === 'openai').saved, false);
  const offline = make(async () => { throw new Error('offline'); }).keys;
  assert.equal((await offline.set('openai', 'sk-ok-12345678')).checked, null);
  let asked;
  const good = make(async (url, o) => { asked = [url, o.headers]; return { ok: true, status: 200 }; }).keys;
  assert.equal((await good.set('google', 'AIza-good-key-1')).checked, true);
  assert.match(asked[0], /generativelanguage/); assert.equal(asked[1]['x-goog-api-key'], 'AIza-good-key-1');
  assert.equal(good.envFor('gemini').env.GEMINI_DEFAULT_AUTH_TYPE, 'gemini-api-key');
  await assert.rejects(good.set('google', 'has space in it'), /does not look/);
});

test('withKeys adds the flags Codex and OpenCode need, and nothing without a key', () => {
  const env = { OPENAI_API_KEY: 'k' };
  assert.equal(withKeys('codex', 'codex -c check_for_update_on_startup=false', { env, from: ['openai'] }).command, `codex ${CODEX_KEY_FLAGS} -c check_for_update_on_startup=false`);
  assert.equal(withKeys('opencode', 'opencode', { env, from: ['openai'] }).command, 'opencode --standalone');
  assert.equal(withKeys('opencode', 'opencode --standalone', { env, from: ['openai'] }).command, 'opencode --standalone');
  assert.deepEqual(withKeys('codex', 'codex', { env: {}, from: [] }), { command: 'codex', env: {} });
  assert.equal(withKeys('claude', 'claude --resume x', { env: { ANTHROPIC_API_KEY: 'k' }, from: ['anthropic'] }).command, 'claude --resume x');
});
