// Demo source: believable agents so the app runs without a paired laptop.
// Shapes match what the laptop sends: lib.mjs agents and readAgentMessages messages.
const now = Date.now();
const ago = (min) => new Date(now - min * 60_000).toISOString();
const say = (...rows) => rows.map(([role, text, tool, media], i) => ({ role, text, tool: !!tool, ts: ago(rows.length - i), ...(media ? { media } : {}) }));

// what an agent's screenshot and screen recording look like in its chat (bundled, so nothing is fetched)
const SHOT = { id: 'demo-shot', kind: 'image', asset: require('../assets/demo-checkout-shot.jpg') };
const WALKTHROUGH = {
  id: 'demo-walkthrough', kind: 'video', state: 'ready', name: 'checkout-walkthrough.mp4', duration: 6.1,
  asset: require('../assets/demo-checkout.mp4'), posterAsset: require('../assets/demo-checkout-poster.jpg'),
};

const PROJECTS = [
  { key: '/dev/acme-api', label: 'acme-api', color: '#2F5BEA' },
  { key: '/dev/acme-web', label: 'acme-web', color: '#E3A600' },
  { key: '/dev/acme-ml', label: 'acme-ml', color: '#00A36C' },
];

const AGENTS = [
  ['api-auth', 'claude', 0, null, say(
    ['user', 'Move session auth to short-lived JWTs with refresh rotation.'],
    ['assistant', '[Read: src/auth/session.ts]', true],
    ['assistant', '## Plan\n\n1. Add `refresh_tokens` table with **rotation + reuse detection**\n2. Issue 15 min access tokens\n3. Keep the cookie API unchanged for the web app\n\nStarting with the migration.'],
    ['assistant', '[Edit: migrations/0042_refresh_tokens.sql]', true],
  ), { question: 'Allow Claude to run `npm run migrate`?', options: ['Yes', 'Yes, and don\'t ask again', 'No'] }],
  ['rate-limit', 'codex', 0, 'rate-limit', say(
    ['user', 'Add per-tenant rate limits to the public API.'],
    ['assistant', 'Token bucket per tenant in Redis. Limits live in `config/limits.yaml`. 42 tests passing.'],
  )],
  ['auth-review', 'claude', 0, 'review', say(
    ['user', 'Review the auth branch before it merges.'],
    ['assistant', 'Two findings so far:\n\n- **P1** refresh token not revoked on password change\n- *P2* `iat` skew not tolerated'],
  )],
  ['checkout', 'claude', 1, null, say(
    ['user', 'Rebuild the checkout page on the new design system.'],
    ['assistant', 'Checkout now uses `<Stepper>` and `<PriceRow>`. Here it is after paying:', false, [SHOT]],
    ['assistant', '[Bash: record the checkout flow → checkout-walkthrough.mp4]', true, [WALKTHROUGH]],
    ['assistant', 'Recorded a walkthrough of the whole flow. Waiting on the API for the new auth cookie.'],
  )],
  ['e2e', 'gemini', 1, 'e2e', say(
    ['user', 'Write Playwright tests for checkout.'],
    ['assistant', '8 specs written. `guest checkout` is flaky on slow CI, adding a wait on the payment iframe.'],
  )],
  ['ranking-eval', 'claude', 2, null, say(
    ['user', 'Run the ranking eval on the new embeddings.'],
    ['assistant', '**nDCG@10 0.412 → 0.447** (+8.5%). Biggest gain on long queries.'],
  )],
];

const REPLIES = [
  'On it. Reading the relevant files first.',
  'Done. Tests pass locally, nothing pushed yet.',
  'Good call. I changed it and left a note in the PR description.',
];

export function createDemo(emit) {
  let n = 0;
  const state = {
    // a workspace's folders: its own (home) and its worktrees, as the computer reports them
    projects: PROJECTS.map((p) => ({ ...p, worktrees: [{ path: p.key, name: p.label, home: true },
      ...[...new Set(AGENTS.filter((a) => PROJECTS[a[2]] === p && a[3]).map((a) => a[3]))].map((w) => ({ path: `${p.key}/.worktrees/${w}`, name: w, home: false }))] })),
    kinds: ['claude', 'codex', 'gemini', 'opencode', 'cursor-agent'],
    agents: AGENTS.map(([name, kind, pi, worktree, messages, needs], i) => ({
      id: `demo-${name}`, kind, name, worktree, project: PROJECTS[pi], status: i === 1 ? 'busy' : 'idle', inApp: true,
      needs: needs || null, messages, updatedAt: now - i * 300_000,
    })),
  };
  const patch = (id, fn) => {
    state.agents = state.agents.map((a) => (a.id === id ? { ...a, ...fn(a), updatedAt: Date.now() } : a));
    emit({ ...state });
  };
  const push = (role, text, tool) => (a) => ({ messages: [...a.messages, { role, text, tool: !!tool, ts: new Date().toISOString() }] });
  // a turn: busy, a tool line, then a reply
  const work = (id, reply) => {
    patch(id, () => ({ status: 'busy' }));
    setTimeout(() => patch(id, push('assistant', '[Read: src/index.ts]', true)), 900);
    setTimeout(() => patch(id, (a) => ({ ...push('assistant', reply)(a), status: 'idle' })), 2400);
  };
  emit({ ...state });
  return {
    name: 'demo',
    send(id, text) {
      patch(id, push('user', text));
      work(id, REPLIES[n++ % REPLIES.length]);
    },
    answer(id, option) {
      patch(id, (a) => ({ ...push('user', option)(a), needs: null }));
      work(id, 'Migration applied. Moving on to the token issuer.');
    },
    stop(id) {
      patch(id, (a) => ({ ...push('assistant', 'Interrupted by user')(a), status: 'idle' }));
    },
    spawn({ cwd, kind, prompt }) {
      const project = state.projects.find((p) => p.worktrees.some((w) => w.path === cwd));
      const wt = project.worktrees.find((w) => w.path === cwd);
      const worktree = wt.home ? null : wt.name;
      const id = `demo-new-${Date.now()}`;
      state.agents = [{ id, kind, name: `${kind}-${worktree || project.label}`, worktree, project, status: 'idle', inApp: true, needs: null, messages: [], updatedAt: Date.now() }, ...state.agents];
      emit({ ...state });
      if (prompt) this.send(id, prompt);
      return id;
    },
  };
}
