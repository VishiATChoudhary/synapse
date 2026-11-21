// API keys for the agents (Settings > API keys). A key is kept encrypted with the Keychain (safeStorage), like the
// browser logins, and goes to the agents that use its provider as an environment variable when a session starts
// (envFor). Each key can be turned off per agent: a Claude subscription and an Anthropic key for OpenCode can live
// side by side. The key itself never comes back out to the window; it shows as its last four characters.
import fs from 'node:fs';

// provider: label, the env vars it sets, the agents that read them, where to get one, how to check one
export const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', env: ['ANTHROPIC_API_KEY'], agents: ['claude', 'opencode'], url: 'https://console.anthropic.com/settings/keys', hint: 'sk-ant-…',
    check: { url: 'https://api.anthropic.com/v1/models?limit=1', headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) } },
  { id: 'openai', label: 'OpenAI', env: ['OPENAI_API_KEY'], agents: ['codex', 'opencode'], url: 'https://platform.openai.com/api-keys', hint: 'sk-…',
    check: { url: 'https://api.openai.com/v1/models', headers: (k) => ({ authorization: `Bearer ${k}` }) } },
  { id: 'google', label: 'Google Gemini', env: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'], agents: ['gemini', 'opencode'], url: 'https://aistudio.google.com/apikey', hint: 'AIza…',
    check: { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', headers: (k) => ({ 'x-goog-api-key': k }) } },
  { id: 'openrouter', label: 'OpenRouter', env: ['OPENROUTER_API_KEY'], agents: ['opencode'], url: 'https://openrouter.ai/settings/keys', hint: 'sk-or-…',
    check: { url: 'https://openrouter.ai/api/v1/key', headers: (k) => ({ authorization: `Bearer ${k}` }) } },
  { id: 'xai', label: 'xAI', env: ['XAI_API_KEY'], agents: ['opencode'], url: 'https://console.x.ai', hint: 'xai-…',
    check: { url: 'https://api.x.ai/v1/models', headers: (k) => ({ authorization: `Bearer ${k}` }) } },
  { id: 'groq', label: 'Groq', env: ['GROQ_API_KEY'], agents: ['opencode'], url: 'https://console.groq.com/keys', hint: 'gsk_…',
    check: { url: 'https://api.groq.com/openai/v1/models', headers: (k) => ({ authorization: `Bearer ${k}` }) } },
  { id: 'deepseek', label: 'DeepSeek', env: ['DEEPSEEK_API_KEY'], agents: ['opencode'], url: 'https://platform.deepseek.com/api_keys', hint: 'sk-…',
    check: { url: 'https://api.deepseek.com/models', headers: (k) => ({ authorization: `Bearer ${k}` }) } },
  { id: 'mistral', label: 'Mistral', env: ['MISTRAL_API_KEY'], agents: ['opencode'], url: 'https://console.mistral.ai/api-keys', hint: '',
    check: { url: 'https://api.mistral.ai/v1/models', headers: (k) => ({ authorization: `Bearer ${k}` }) } },
  { id: 'cursor', label: 'Cursor', env: ['CURSOR_API_KEY'], agents: ['cursor-agent'], url: 'https://cursor.com/dashboard?tab=integrations', hint: 'key_…' },
  { id: 'amp', label: 'Amp', env: ['AMP_API_KEY'], agents: ['amp'], url: 'https://ampcode.com/settings', hint: 'sgamp_…' },
];
const byId = (id) => PROVIDERS.find((p) => p.id === id);

// Codex reads OPENAI_API_KEY only through a provider that names it (signed in with ChatGPT, its own provider uses
// that login): these flags add one, the same OpenAI API, billed to the key. Values without quotes, so they survive
// both sh and cmd.exe (Codex takes a value that is not TOML as a plain string).
export const CODEX_KEY_FLAGS = ['model_provider=synapse_openai', 'model_providers.synapse_openai.name=OpenAI', 'model_providers.synapse_openai.base_url=https://api.openai.com/v1',
  'model_providers.synapse_openai.env_key=OPENAI_API_KEY', 'model_providers.synapse_openai.wire_api=responses'].map((v) => `-c ${v}`).join(' ');

export function createApiKeys({ file, safeStorage, fetch: get = globalThis.fetch }) {
  const read = () => { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d.keys === 'object' ? d.keys : {}; } catch { return {}; } };
  const write = (keys) => fs.writeFileSync(file, JSON.stringify({ keys }, null, 2), { mode: 0o600 });
  const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
  const open = (k) => { try { return safeStorage.decryptString(Buffer.from(k.enc, 'base64')); } catch { return ''; } };

  // every provider, with what is saved for it (never the key)
  function list() {
    const keys = read();
    return PROVIDERS.map(({ id, label, env, agents, url, hint, check }) => {
      const k = keys[id];
      return { id, label, env, agents, url, hint, checkable: !!check, saved: !!k, last4: k?.last4 || '', addedAt: k?.addedAt || 0, off: k?.off || [], checked: k?.checked ?? null };
    });
  }

  // does the provider take it? true, false (refused), or null (could not ask: offline, or no way to check)
  async function check(id, key) {
    const p = byId(id);
    if (!p?.check || !get) return null;
    try {
      const r = await get(p.check.url, { headers: p.check.headers(key), signal: AbortSignal.timeout(8000) });
      if (r.ok) return true;
      if (r.status === 401 || r.status === 403 || r.status === 400) return false;
      return null;
    } catch { return null; }
  }

  async function set(id, key) {
    const p = byId(id);
    if (!p) throw new Error('Unknown provider.');
    key = String(key || '').trim().replace(/^(?:export\s+)?[A-Z][A-Z0-9_]*=/, '').replace(/^["']|["']$/g, '').trim(); // pasted as KEY=value, or in quotes
    if (!key) throw new Error('Paste the key.');
    if (key.length < 8 || key.length > 512 || /\s/.test(key)) throw new Error('That does not look like an API key.');
    if (!canEncrypt()) throw new Error('This Mac cannot encrypt the key right now (is the Keychain locked?).');
    const ok = await check(id, key);
    if (ok === false) throw new Error(`${p.label} refused that key. Check it and paste it again.`);
    const keys = read();
    keys[id] = { enc: safeStorage.encryptString(key).toString('base64'), last4: key.slice(-4), addedAt: Date.now(), off: keys[id]?.off || [], checked: ok };
    write(keys);
    return list().find((x) => x.id === id);
  }

  function remove(id) {
    const keys = read();
    if (!keys[id]) throw new Error('No key saved for that.');
    delete keys[id]; write(keys);
  }

  // turn a key on or off for one agent
  function use(id, agent, on) {
    const p = byId(id), keys = read();
    if (!p || !keys[id]) throw new Error('No key saved for that.');
    if (!p.agents.includes(agent)) throw new Error(`${p.label} keys are not used by that agent.`);
    const off = new Set(keys[id].off || []);
    if (on) off.delete(agent); else off.add(agent);
    keys[id].off = [...off]; write(keys);
    return list().find((x) => x.id === id);
  }

  async function recheck(id) {
    const keys = read(), k = keys[id];
    if (!k) throw new Error('No key saved for that.');
    const key = open(k);
    if (!key) throw new Error('This Mac could not unlock the key. Paste it again.');
    k.checked = await check(id, key); write(keys);
    return list().find((x) => x.id === id);
  }

  // the env a new session of this agent gets, and the providers it came from
  function envFor(agent) {
    const keys = read(), env = {}, from = [];
    for (const p of PROVIDERS) {
      const k = keys[p.id];
      if (!k || !p.agents.includes(agent) || (k.off || []).includes(agent)) continue;
      const key = open(k);
      if (!key) continue;
      for (const v of p.env) env[v] = key;
      from.push(p.id);
    }
    if (agent === 'gemini' && env.GEMINI_API_KEY) env.GEMINI_DEFAULT_AUTH_TYPE = 'gemini-api-key';
    return { env, from };
  }

  return { list, set, remove, use, recheck, envFor };
}

// The start command and env for a session, with its keys: env vars for all, and Codex and OpenCode need a flag
// for theirs to count (see CODEX_KEY_FLAGS; OpenCode's shared background service has its own env, a private one
// gets this session's).
export function withKeys(kind, command, { env, from }) {
  if (!command || !from.length) return { command, env: {} };
  if (kind === 'codex' && from.includes('openai')) command = command.replace(/^(\S*codex(?:\.cmd)?)(?=\s|$)/, `$1 ${CODEX_KEY_FLAGS}`);
  if (kind === 'opencode' && !/\s--standalone(\s|$)/.test(command)) command = `${command} --standalone`;
  return { command, env };
}
