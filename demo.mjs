// Fixture agents for `npm run demo`: a believable canvas without touching real sessions.
const now = Date.now();
const say = (...pairs) => pairs.map(([role, text, tool]) => ({ role, text, tool, ts: new Date(now).toISOString() }));

const AGENTS = [
  ['api-auth', 'claude', '/dev/acme-api', say(
    ['user', 'Move session auth to short-lived JWTs with refresh rotation.'],
    ['assistant', '[Read: src/auth/session.ts]', true],
    ['assistant', '## Plan\n\n1. Add `refresh_tokens` table with **rotation + reuse detection**\n2. Issue 15 min access tokens\n3. Keep the cookie API unchanged for the web app\n\nStarting with the migration.'],
  )],
  ['api-rate-limit', 'codex', '/dev/.superset/worktrees/acme-api/rate-limit', say(
    ['user', 'Add per-tenant rate limits to the public API.'],
    ['assistant', 'Token bucket per tenant in Redis. Limits live in `config/limits.yaml`. 42 tests passing.'],
  )],
  ['api-review', 'claude', '/dev/.superset/worktrees/acme-api/review', say(
    ['user', 'Review the auth branch before it merges.'],
    ['assistant', 'Two findings so far:\n\n- **P1** refresh token not revoked on password change\n- *P2* `iat` skew not tolerated'],
  )],
  ['web-checkout', 'claude', '/dev/acme-web', say(
    ['user', 'Rebuild the checkout page on the new design system.'],
    ['assistant', 'Checkout now uses `<Stepper>` and `<PriceRow>`. Waiting on the API for the new auth cookie.'],
  )],
  ['web-e2e', 'gemini', '/dev/.superset/worktrees/acme-web/e2e', say(
    ['user', 'Write Playwright tests for checkout.'],
    ['assistant', '8 specs written. `guest checkout` is flaky on slow CI, adding a wait on the payment iframe.'],
  )],
  ['docs', 'opencode', '/dev/acme-docs', []],
  ['infra-terraform', 'codex', '/dev/acme-infra', say(
    ['user', 'Bump the Postgres instance class and add a read replica.'],
    ['assistant', 'Plan: 1 to change, 1 to add. Replica lag alarm at 30s.'],
  )],
  ['research-vector-db', 'gemini', '/dev/research', say(
    ['user', 'Compare pgvector vs a dedicated vector DB for our search.'],
    ['assistant', 'pgvector with HNSW is enough under ~10M rows. Recommend staying on Postgres.'],
  )],
  ['ml-eval', 'claude', '/dev/acme-ml', say(
    ['user', 'Run the ranking eval on the new embeddings.'],
    ['assistant', '**nDCG@10 0.412 → 0.447** (+8.5%). Biggest gain on long queries.'],
  )],
  ['cursor-landing', 'cursor-agent', '/dev/acme-web', []],
];

export function demoAgents() {
  const tick = Math.floor(Date.now() / 6000);
  return AGENTS.map(([name, kind, cwd, demo], i) => ({
    id: `demo-${name}`, pid: 100 + i, kind, name, cwd, demo,
    status: (tick + i) % 4 === 0 ? 'busy' : 'idle',
    startedAt: now - i * 600_000, updatedAt: now,
    transcript: demo.length ? `demo:${name}` : null, format: 'demo',
  }));
}

export const DEMO_EDGES = [
  ['api-auth', 'api-review'], ['api-auth', 'web-checkout'], ['api-rate-limit', 'api-review'],
  ['web-checkout', 'web-e2e'], ['research-vector-db', 'ml-eval'], ['infra-terraform', 'api-rate-limit'],
  ['docs', 'api-auth'],
];

export const DEMO_MESSAGES = [
  ['api-review', 'api-auth', 'Found a **P1**: refresh tokens survive a password change. Can you revoke them in `changePassword()`?'],
  ['api-auth', 'api-review', 'Fixed in `a41f2c9`. Revoking the whole token family now, plus a test.'],
  ['web-checkout', 'api-auth', 'Is the cookie name still `acme_session` after the JWT change?'],
];

// hand-placed so projects sit together and links don't cross
export const DEMO_LAYOUT = {
  'api-auth': [0, 0], 'api-review': [-90, -230], 'api-rate-limit': [-300, -60], 'infra-terraform': [-540, -170],
  'docs': [230, -250], 'web-checkout': [310, 90], 'web-e2e': [560, -30], 'cursor-landing': [560, 230],
  'research-vector-db': [-380, 250], 'ml-eval': [-110, 300],
};
