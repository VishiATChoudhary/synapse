# Journey Friction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the six places where a new Synapse user gets stuck between signing up and having a friend's agent talk to theirs.

**Architecture:** Builds on agent talk (v0.4.0, spec `docs/superpowers/specs/2026-10-18-agent-talk-design.md`). Cloud gains "who trusts me" plus a cloud-only mailbox item; the client and app surface it. Talk permission becomes an accept-time checkbox and an in-app request. Owner gets settings for rate and answer model, an open-at-login toggle, and OpenCode/Cursor transcripts become replayable.

**Tech Stack:** Node ESM, no new dependencies; cloud/ (SQLite on Railway, pages.mjs, mail.mjs); Electron app/; canvas public/index.html; `node:test`.

**Spec:** none separate (user opted out of questions on 2026-10-19). Binding background: the agent talk spec above. Every choice below is the controller's call, made on the user's behalf.

## Global Constraints

- No new npm dependencies (root, app/, cloud/).
- Never touch ~/.synapse, /Applications/Synapse.app, ports 4747/4757; app runs use SYNAPSE_HOME=<tmp> and SYNAPSE_APP_PORT=<free>; run Electron tests as `node tests/<x>.cjs` with SYNAPSE_APP_PORT set.
- Never run the real `claude`; tests use SYNAPSE_TALK_CLAUDE=test/fixtures/fake-claude.mjs.
- No deploys, no releases, no pushes: the controller asks the user.
- Friend-supplied strings rendered anywhere (app, canvas, web pages, email) are escaped.
- No em dashes in code, comments, copy, commits, docs. Match repo comment style.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Talk answering keeps every rule of the agent talk spec (zero tools, `--tools ''`, `--strict-mcp-config`, SYNAPSE_EXTERNAL=1).

## Review Focus

1. A stranger adds you as trusted: you get one prompt and one email, not one per poll; ignoring it is remembered.
2. A talk-request floods (agent retries in a loop): owner sees at most one pending prompt per asker agent and target, rate limited.
3. Accept with "let them ask" ticked only sets talk on edges of that accept, never on other shares.
4. Answer model setting can never smuggle flags into the claude argv (allowlist of model names).
5. Opening at login is never enabled without the user turning it on.

---

### Task 1: Cloud: who trusts me, and tell them

**Files:** Modify `cloud/server.mjs`, `cloud/mail.mjs`, `cloud/pages.mjs` (settings page section), `cloud/test/cloud.test.mjs`; client `account.mjs`.

**Interfaces:**
- `GET /v1/trusted/incoming` (auth) -> `{ incoming: [{ id, handle, name, avatar, since }] }`: users who trust me whom I do not trust back, minus ones I dismissed.
- `POST /v1/trusted/incoming/:id/dismiss` (auth) -> `{ ok: true }` (persist in a new table `trust_dismissed(user_id, other_user, at)`).
- On `POST /v1/trusted` that creates a real (non-pending) entry: if the target does not already trust the sender, `deliver()` to every machine bound to the target user `{ type: 'trusted', from: { id, handle, name, avatar } }` (add `trusted` to CLOUD_ONLY so peers cannot forge it) and send one email via mail.mjs: subject "<name> added you on Synapse", body with a "Trust back" link to `/settings#trust`. Once per pair (don't resend on re-add within 30 days).
- Web settings page: "People who trust you" list with Trust back (POST /v1/trusted {who:@handle}) and Ignore (dismiss).
- `account.mjs`: `incomingTrust() -> Promise<Array>`, `dismissTrust(id)`.

- [ ] Tests in cloud/test/cloud.test.mjs: incoming lists a one-way truster; trusting back removes them; dismiss hides them; `trusted` item delivered once to the target's machine and cannot be sent via /v1/send; email sent once (mail transport in test mode records sends; follow existing test pattern).
- [ ] Implement; run `node --test cloud/test/cloud.test.mjs` and root `npm test`; commit "Cloud: tell people who added them, and let them trust back".

### Task 2: App and agents: trust back prompt

**Files:** `remote.mjs` (route `trusted` item into the requests cache like `noteRequest`), `app/main.mjs`, `app/preload.cjs`, `app/renderer/app.js`, `app/renderer/style.css`, `mcp.mjs` (`synapse_people` shows `trustsYou` and incoming), `app/tests/trustback.cjs` (pattern of `app/tests/requests.cjs`, which drives a fake feed via SYNAPSE_FAKE_REQUESTS; extend the fake feed with `incomingTrust`).

**Interfaces:** consumes Task 1 `account.incomingTrust/dismissTrust`, `account.trust(who)`.
- Status circle blinks for incoming trust like a pending request; popover row "@x added you" with Trust back / Ignore; macOS notification once per person.
- Settings "trusted people" section lists incoming ones on top with the same buttons.

- [ ] Electron test: fake feed with one incoming truster -> circle blinks, row visible; Trust back calls trust and row disappears; Ignore calls dismiss.
- [ ] Implement, run test + root npm test; commit "App: prompt to trust back whoever added you".

### Task 3: Talk without hunting

**Files:** `account.mjs` (accept takes `{ talk: boolean }`), `remote.mjs`/`ops.mjs` (after accept creates share edges, set mode talk on exactly those edges when `talk`), `talk.mjs` + `remote.mjs` (new item `talk-request`), `ops.mjs` (`ask` on a sync share sends a talk-request instead of throwing), `mcp.mjs`, `cli.mjs` (`accept <id> --no-talk`), `app/renderer/app.js` (accept popover checkbox "Let their agent ask questions too", default checked; talk-request prompt rows), `server.mjs` (`POST /api/talk-requests/:id/allow|dismiss`, guarded like other writes), tests in `test/talk-unit.test.mjs`, `test/talk.test.mjs`, `app/tests/requests.cjs` or a new app test.

**Interfaces:**
- Item `talk-request { id: uuid, target, asker, askerName, note? }` asker -> owner; owner stores `talkRequests: [{ id, peer, peerName, peerHandle, target, targetName, asker, askerName, at, status: 'pending'|'allowed'|'dismissed' }]` in talks.json (via `update()`), at most one pending per (peer, asker, target); a new one for the same triple within 1 h is ignored; dismissed ones are not re-shown for 24 h.
- Allow -> `ops.setMode(edge, 'talk')` on the matching share edge and send `talk-status { requestId, state: 'allowed' }`; asker side `ops.ask` on a sync share returns `{ status: 'requested', note: 'Asked <owner> to let you ask <agent>. Try again once they allow it.' }` and records the request id.
- Owner sees the request in the status-circle popover and canvas (row on the target agent), plus one macOS notification.

- [ ] Tests: accept with talk sets mode only on the accept's edges; accept --no-talk leaves sync; ask on sync share yields `requested` and one pending owner request; a second ask within 1 h adds none; allow flips the edge to talk and a following ask is answered (e2e, fake claude); routes reject cross-site.
- [ ] Implement; commit "Talk: allow at accept time, and ask the owner instead of failing".

### Task 4: Owner controls for usage

**Files:** `talk.mjs` (read settings), `app/main.mjs` + renderer settings, `server.mjs` (`GET /api/talks/usage`), tests.

**Interfaces:**
- `app.json` keys `talkPerHour` (int 1..600, default 60) and `talkModel` (`'agent'` default = profile allowlisted model or none; or one of `'opus'|'sonnet'|'haiku'`). talk.mjs uses `talkPerHour` in place of LIMITS.perHour and adds `--model <talkModel>` (only from that allowlist) when not `'agent'`.
- Settings "Agent talk" section: per-hour number, answer model select, "N answers today / this week" from `GET /api/talks/usage` -> `{ today, week, byPeer: [{ name, today }] }`.

- [ ] Tests: per-hour setting enforced; model allowlist (a value like `--dangerously-skip-permissions` is ignored); usage counts.
- [ ] Implement; commit "Talk: owner sets the hourly limit and the answering model, and sees usage".

### Task 5: Answer while away

**Files:** `app/main.mjs`, preload, renderer settings, test.

- Settings toggle "Open Synapse at login" (Electron `app.setLoginItemSettings({ openAtLogin, openAsHidden: true })`), reflects `app.getLoginItemSettings()`. Default off, never enabled automatically.
- The first time a link is switched to talk (canvas or accept checkbox), one in-app suggestion: "Answer questions even when Synapse is closed? Open at login" with Turn on / Not now; remembered in app.json `loginSuggested: true`.
- In tests stub `setLoginItemSettings` (do not change the real login items of this Mac).

- [ ] Test (Electron, stubbed): toggle calls the stub with openAtLogin true/false; suggestion appears once.
- [ ] Implement; commit "App: open at login so questions get answered".

### Task 6: OpenCode and Cursor answer too

**Files:** `lib.mjs` (transcript discovery + parsers for `opencode` and `cursor-agent`), fixtures under `test/fixtures/`, tests in `test/talk-unit.test.mjs`.

- Find each tool's real session storage on this Mac (both are installed), read a real session, write a parser into `PARSERS`/discovery like codex/gemini, with a small redacted fixture (no real content: synthesize a fixture in the same format). If a tool stores sessions in a format that cannot be read without its own runtime (e.g. sqlite needing a dependency), stop for that tool and report; Node has `node:sqlite` on Node >= 22.5 which is allowed (no new dependency).
- Replay picks them up automatically (ADAPTERS maps them to `replay`).

- [ ] Tests: each parser turns its fixture into user/assistant messages; replay answerCommand for each kind carries a fixture line.
- [ ] Implement; commit "OpenCode and Cursor conversations can be read, so their agents can answer".

### Task 7: Onboarding and docs

**Files:** `cloud/pages.mjs` (welcome: a step "Let your agents talk" after trusted people, explaining talk in two sentences), `README.md`, `skill/SKILL.md`, `mcp.mjs` INSTRUCTIONS (synapse_ask, requested status), tests touching page text if any exist.

- [ ] Implement; run cloud tests + root npm test; commit "Docs and onboarding: agent talk".
