# Agent Talk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A trusted friend's agent asks one of my agents a question and gets an answer from a tool-less fork (or transcript replay) of it, with the whole exchange visible to me and every cut I make taking effect immediately.

**Architecture:** Talk is a `mode` on the share edges that already exist. New `talk-*` items ride the existing machine mailbox. A new module `talk.mjs` owns conversation state (`~/.synapse/talks.json`), validation, the per-agent queue and the fork runner; `remote.mjs` routes items to it, `server.mjs` ticks it, `ops.mjs`/`mcp.mjs`/`cli.mjs` expose asking, and the canvas plus the app show external forks and threads.

**Tech Stack:** Node ≥ 20 ESM, no new dependencies, `node:test`, Electron app (`app/`), canvas page `public/index.html`, Claude Code CLI (`claude -p`).

**Spec:** `docs/superpowers/specs/2026-10-18-agent-talk-design.md` (read it first; this plan argues from it).

## Global Constraints

- No new npm dependencies anywhere (root, `app/`, `cloud/`).
- The answering process always runs with `--tools "" --strict-mcp-config` and env `SYNAPSE_EXTERNAL=1`. No code path may start a fork or replay without both.
- Profile flags are reduced to an allowlist: leading `VAR=value` env assignments and `--model <value>`. Everything else from the profile is dropped.
- Limits (exact): question ≤ 4000 chars, answer ≤ 8000 chars, 120 s per answer, ≤ 5 waiting per target agent, conversation idle end 30 min, ≤ 20 turns per conversation, 60 questions per hour per peer, `synapse_ask` waits ≤ 90 s, replay transcript budget 150 000 chars (newest kept).
- Talk is allowed only with peers whose `remote.json` entry has `via: 'request'`.
- New share edges default to `mode` absent (= `sync`).
- End reasons (exact set): `owner`, `asker`, `idle`, `refused`, `revoked`, `unavailable`, `unsupported`, `busy`, `error`.
- No em dashes in code comments, copy, commits or docs.
- Comment style and density match the surrounding files (short `//` lines explaining why).
- Never rebuild or reinstall the live app (`/Applications/Synapse.app`); UI checks run in a separate Electron run (`cd app && npx electron . --demo` with its own `SYNAPSE_HOME`).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A question arrives for an agent that was never a talk target, or the edge was removed between queueing and running:** refused at both checks, no process spawned. (Task 2 test `revalidates at the front of the queue`.)
2. **The fake or real `claude` hangs or crashes mid-answer:** the asker gets `talk-end error`, the queue moves on, no zombie process. (Task 3 tests `times out after 120 s` with an injectable clock, `crash ends with error`.)
3. **A closed agent whose transcript file was deleted:** `unavailable`, not a crash. (Task 3 test `missing transcript is unavailable`.)
4. **Answer arrives right as `synapse_ask` gives up at 90 s:** delivered exactly once, either returned or put in the inbox, never both, never lost. (Task 5 test `answer at the deadline is delivered once`.)
5. **Hostile mailbox items** (oversized question, wrong types, a `talk-answer` for a conversation this machine never started, a `talk-ask` from an invite-code peer): dropped or refused without throwing inside `pull()`. (Task 4 test `malformed talk items never break pull`.)

---

### Task 1: Edge mode, peer handle, dormant talk agents

**Files:**
- Modify: `ops.mjs` (new `setMode`, `peers` adds `talk`)
- Modify: `remote.mjs` (`push` shares carry `mode`, dormant talk agents advertised; `mirror` keeps `mode`; `pull` stores `handle` from `paired`; `addPeer` accepts `handle`)
- Modify: `account.mjs:149` (pass the requester's handle to `addPeer`)
- Modify: `lib.mjs` (`remoteAgents` adds `remote.handle`, status `closed` for dormant agents; `findAgent` matches `name@handle`; `FILES.talks`)
- Test: `test/talk-unit.test.mjs` (new; sets `SYNAPSE_HOME` to a temp dir and `SYNAPSE_DEMO=1` before importing modules)

**Interfaces:**
- Produces: `ops.setMode(edgeId: string, mode: 'sync' | 'talk') -> { edge }`. Throws `Error` with a human sentence when the edge is not mine (`mirrored`), its `to` is not a remote agent, or the peer is not `via: 'request'`. On `talk` it stores `edge.snapshot = { kind, name, cwd, transcript, format }` from the live `from` agent (required to be live at that moment).
- Produces: edge fields `mode?: 'talk'`, `snapshot?`. `mode: 'sync'` deletes `mode` and `snapshot`.
- Produces: share item entries `{ from, to, fromName, mode?: 'talk', dormant?: true }`; agents list entries for dormant talk sources `{ id, name, kind, status: 'closed', project, startedAt: null }` built from `snapshot`.
- Produces: `FILES.talks = path.join(DATA, 'talks.json')`.
- Produces: peer record `{ ..., handle?: string }`; remote agent `remote.handle`.

- [ ] **Step 1: Write failing tests** in `test/talk-unit.test.mjs`:
  - `setMode talk needs a request peer`: write `remote.json` with peer `m1` (no `via`), create edge demo agent → `r-m1-x`; `assert.throws(() => setMode(id, 'talk'), /request/)`.
  - `setMode talk stores a snapshot and sync clears it`: peer `via: 'request'`; after `setMode(id,'talk')` edge has `mode === 'talk'` and `snapshot.kind === <demo agent kind>`; after `setMode(id,'sync')` neither field exists.
  - `setMode refuses a mirrored edge`: `assert.throws(..., /owner/)`.
  - `findAgent matches name@handle`: `remoteAgents` fixture via `remote.json` + `remote/state.json` with peer handle `bob`; `findAgent(listAgents(), 'api@bob')` returns it.
- [ ] **Step 2: Run** `node --test test/talk-unit.test.mjs`. Expected: FAIL (`setMode` not exported).
- [ ] **Step 3: Implement** the Interfaces above. In `push`, a talk edge whose `from` is not live still yields a share (`dormant: true`) and an agent entry from `snapshot`; while `from` is live, refresh `snapshot` in `edges.json` if `transcript` changed. In `pull`, `paired` items set `c.peers[m].handle = clean(it.handle, 24)` when present.
- [ ] **Step 4: Run** `node --test test/talk-unit.test.mjs` then `npm test`. Expected: all PASS (existing multiplayer and cloud tests unchanged).
- [ ] **Step 5: Commit** `Talk: a mode on share edges, peers keep their handle, closed talk agents stay visible`.

### Task 2: talk.mjs store, validation and queue (owner side, no processes yet)

**Files:**
- Create: `talk.mjs`
- Test: `test/talk-unit.test.mjs`

**Interfaces:**
- Consumes: `FILES.talks`, edge `mode`/`snapshot` (Task 1), `remote.config()`.
- Produces (all in `talk.mjs`, state in `FILES.talks` as `{ conversations: [], queue: [], rate: {} }`):
  - `LIMITS` object with the Global Constraints values (`question: 4000, answer: 8000, answerMs: 120_000, waiting: 5, idleMs: 1_800_000, turns: 20, perHour: 60, askWaitMs: 90_000, replayChars: 150_000`).
  - `allowed(peer: string, target: string, asker: string) -> { edge } | { reason: EndReason }`: finds an edge `from === target && to === remoteId(peer, asker) && mode === 'talk'` with peer `via: 'request'`; else `{ reason: 'refused' }`.
  - `receiveAsk(peer, item, now = Date.now()) -> Item[]`: validates shape (strings, `question` trimmed and ≤ `LIMITS.question`, else refused), rate limit (`busy`), `allowed`, queue length (`busy`), turn count (the 21st ask ends the conversation with `talk-end { reason: 'idle', note: 'turn limit' }`; her next ask starts a fresh one). Creates or continues a conversation `{ id: item.conv, role: 'owner', peer, peerName, peerHandle, asker, askerName, target, targetName, mode: 'native' | 'replay', forkSession: null, status: 'open', turns: [{ seq, q, a: null, askedAt }], createdAt, lastAt }`, appends `{ conv, seq }` to `queue`, and returns the items to send back (`talk-status queued` with `position`).
  - `nextJob(now) -> { conv, seq } | null`: first queued job whose target has no job running; re-runs `allowed` (drops and returns `talk-end refused` items via `takeOutgoing`, see below) before handing it out.
  - `endConversation(convId, reason, note?) -> void`: marks ended, drops its queued jobs, records an outgoing `talk-end`.
  - `takeOutgoing() -> Array<{ to: peer, item }>`: items waiting to be sent (stored in state as `outgoing`).
  - `reconcile(now) -> string[]` (ids ended): ends open conversations whose edge is gone or not talk (`owner`), whose peer is gone (`revoked`), idle ≥ 30 min (`idle`).
- `EndReason` is the Global Constraints set.

- [ ] **Step 1: Write failing tests**:
  - `ask without a talk edge is refused` → returned/outgoing item `{ type: 'talk-end', reason: 'refused' }`, no conversation stored.
  - `ask over 4000 chars is refused`.
  - `first ask opens a conversation and queues it` → `conversations[0].status === 'open'`, `queue.length === 1`, status item `position: 1`.
  - `sixth waiting ask for one agent is busy`.
  - `61st ask in an hour is busy` (inject `now`).
  - `revalidates at the front of the queue`: queue an ask, delete the edge, `nextJob()` returns null and `takeOutgoing()` holds `talk-end refused`.
  - `reconcile ends idle and cut conversations`: idle 31 min → `idle`; edge switched to sync → `owner`.
- [ ] **Step 2: Run** `node --test test/talk-unit.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `talk.mjs` per Interfaces. All writes go through `readJSON`/`writeJSON` on `FILES.talks`; keep ended conversations 30 days (prune on write).
- [ ] **Step 4: Run** tests. Expected: PASS.
- [ ] **Step 5: Commit** `Talk: conversations, validation and the per-agent queue`.

### Task 3: The answering runner (native fork and transcript replay)

**Files:**
- Modify: `talk.mjs`
- Create: `test/fixtures/fake-claude.mjs` (prints `{"session_id": "<uuid>", "result": "<answer>"}` where the answer echoes its argv as JSON, so tests can assert flags; honours `FAKE_CLAUDE_SLEEP_MS` and `FAKE_CLAUDE_EXIT`)
- Test: `test/talk-unit.test.mjs`

**Interfaces:**
- Consumes: Task 2 state and `nextJob`; `readAgentMessages`, `formatMessages`, `listAgents` from `lib.mjs`; profiles from `readJSON(FILES.app, {}).profiles`.
- Produces:
  - `ADAPTERS: Record<kind, 'native' | 'replay'>` with `claude: 'native'` and every other `KINDS` entry `'replay'`.
  - `answerCommand(conv, turn, source) -> { bin: string, args: string[], env: Record<string,string>, cwd: string }` where `source = { kind, transcript, format, cwd, name, id }` (live agent or edge `snapshot`). `bin` = `process.env.SYNAPSE_TALK_CLAUDE || 'claude'`. Always includes `-p`, `--tools`, `''`, `--strict-mcp-config`, `--output-format`, `json`, `--append-system-prompt <prompt>`, `env.SYNAPSE_EXTERNAL = '1'`, plus allowlisted profile parts. Native first turn adds `--resume <source.id> --fork-session`; any follow-up adds `--resume <conv.forkSession>`; replay first turn puts the formatted transcript (≤ `LIMITS.replayChars`) and the question in the prompt.
  - `externalPrompt({ agentName, kind, ownerName, askerHandle, replay: boolean }) -> string`: the spec's `EXTERNAL_PROMPT` text, plus the replay sentence when `replay`.
  - `tick({ spawn = child_process.spawn, now = Date.now } = {}) -> Promise<void>`: runs `reconcile`, starts at most one job per target via `nextJob`, sends `talk-status answering`, collects stdout JSON, stores `forkSession` and the answer (clipped to 8000), records `talk-answer`; kills after 120 s with `talk-end error`; non-zero exit → `talk-end error`; source without readable transcript → `unavailable`; no `claude` binary (spawn `ENOENT`) → `unsupported` with note "Claude Code is needed to answer for this agent".
  - `kill(convId)`: kills a running child for that conversation (used by `endConversation` and `reconcile`).
  - `cleanup(conv)`: on end deletes `~/.claude/projects/*/<forkSession>.jsonl` (resolve via `CLAUDE` from `lib.mjs`; only that exact file).
  - `forkSessions() -> Set<string>` and `forkPids() -> Set<number>` exported from `talk.mjs` and used by `lib.localAgents` to skip external forks (import cycle: implement the readers in `lib.mjs` against `FILES.talks`, have `talk.mjs` write `running: [{ conv, pid }]` there).

- [ ] **Step 1: Write failing tests** (all with `SYNAPSE_TALK_CLAUDE=test/fixtures/fake-claude.mjs`):
  - `native first turn forks the session tool-less`: argv contains `--resume`, the target id, `--fork-session`, `--tools`, `''`, `--strict-mcp-config`; env has `SYNAPSE_EXTERNAL=1`.
  - `follow-up resumes the fork, not the agent`.
  - `replay for a codex agent carries its transcript and no --resume on turn 1`.
  - `profile flags are stripped to the allowlist`: profile `claude --dangerously-skip-permissions --model opus --mcp-config x.json` → argv has `--model opus`, lacks the other two.
  - `times out after 120 s` (fake sleeps; inject a short `LIMITS.answerMs` through an exported setter used only by tests) → `talk-end error`, child gone.
  - `crash ends with error` (`FAKE_CLAUDE_EXIT=1`).
  - `missing transcript is unavailable`.
  - `external forks never show as agents`: while a job runs, `localAgents()` excludes its pid.
- [ ] **Step 2: Run** tests. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** tests. Expected: PASS.
- [ ] **Step 5: Commit** `Talk: answer with a tool-less fork, or replay the transcript for other kinds`.

### Task 4: Wiring into sync, the server and the hook

**Files:**
- Modify: `remote.mjs` (`pull` routes `talk-*`; new `queueItem(machine, item)`; `push` also drains `talk.takeOutgoing()`)
- Modify: `server.mjs` (call `talk.tick()` each sync interval; after `DELETE /api/edges/:id`, call `talk.reconcile()` and `tick()` so cuts kill at once)
- Modify: `hook.mjs` (return immediately when `process.env.SYNAPSE_EXTERNAL === '1'`)
- Test: `test/talk-unit.test.mjs`

**Interfaces:**
- Consumes: `talk.receiveAsk`, `talk.receiveReply` (below), `talk.takeOutgoing`, `talk.tick`, `talk.reconcile`.
- Produces: `talk.receiveReply(peer, item)` for `talk-status`, `talk-answer`, `talk-end` on the asker side: only for conversations with `role: 'asker'` and matching `peer`; answer clipped to 8000; anything else ignored.
- Produces: `remote.queueItem(machine: string, item: object) -> void` (appends to `OUTBOX`).

- [ ] **Step 1: Write failing tests**: `malformed talk items never break pull` (feed `pull`'s item handler, factor it as exported `handleItems(c, items)` if needed, with: question of 10 000 chars, `seq: 'x'`, unknown `conv` on `talk-answer`, `talk-ask` from a peer without `via: 'request'`; expect no throw, one `refused` outgoing for the invite peer, nothing stored for the rest); `hook is silent for external forks` (run `hook.mjs` with `SYNAPSE_EXTERNAL=1` and a prompt; stdout empty).
- [ ] **Step 2: Run** tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Talk: questions and answers ride the mailbox; the server answers and cuts at once`.

### Task 5: Asking: ops, MCP, CLI, inbox, skill

**Files:**
- Modify: `ops.mjs` (new `ask`, `endTalk`)
- Modify: `mcp.mjs` (`synapse_ask`, `synapse_end`; INSTRUCTIONS mention them)
- Modify: `cli.mjs` (`synapse ask <agent> <question...> [--conversation id]`, `synapse end <conversation>`)
- Modify: `talk.mjs` (asker-side late delivery)
- Modify: `skill/SKILL.md`, `README.md` (short "Ask a friend's agent" section)
- Test: `test/talk-unit.test.mjs`

**Interfaces:**
- Consumes: `remote.queueItem`, `remote.sync`, `talk.receiveReply`.
- Produces: `ops.ask(me, query: string, question: string, { conversation?: string, waitMs = LIMITS.askWaitMs, sync = remote.sync } = {}) -> Promise<{ answer, conversation } | { status: 'queued' | 'offline' | 'ended', conversation, reason?, note }>`. Resolves the remote agent with `findAgent` (`name@owner` or `name@handle`); throws a human sentence if the agent is local or the share is not talk. Reuses the open asker conversation with that agent unless `conversation` is given.
- Produces: `ops.endTalk(me, conversation: string) -> { ended: true }` (queues `talk-end { reason: 'asker' }`).
- Exactly-once delivery: `ask` sets `turn.waitUntil = now + waitMs`; `receiveReply` puts an answer into the asker agent's inbox (`postMessage` with `from = { id: remoteId(peer, target), name: '<target>@<owner>' }`) only when `now > turn.waitUntil` or `waitUntil` is unset; on timeout `ask` clears `waitUntil`, then re-reads the turn once and returns the answer if it is there. `offline` when the peer's last `state` is older than `REMOTE_OFFLINE`.
- MCP tool text: `synapse_ask`: "Ask an agent on a friend's machine a question. It is answered by a copy of that agent with no tools, from what it already knows. Waits up to 90 s; later answers arrive in synapse_inbox." `synapse_end`: "End a conversation with a friend's agent."

- [ ] **Step 1: Write failing tests**: `ask resolves name@handle and queues talk-ask`, `ask on a sync share explains talk is off`, `answer at the deadline is delivered once` (deliver the answer just after `waitUntil` cleared: returned by `ask` xor in `takeInbox`), `late answer lands in the inbox`.
- [ ] **Step 2: Run** tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Talk: synapse_ask and synapse_end, late answers through the inbox`.

### Task 6: End-to-end over the cloud

**Files:**
- Create: `test/talk.test.mjs` (copy the harness from `test/cloud-client.test.mjs`: local cloud, two homes, both signed in, trust both ways, request accepted; `SYNAPSE_TALK_CLAUDE` = fake)

- [ ] **Step 1: Write the tests** (scenario numbers from the spec):
  - `1 simple ask`: bob sets the accepted share edge to talk (`POST /api/edges/:id/mode`, Task 7, or `ops.setMode` via CLI `synapse talk <agent> on`, added here to `cli.mjs`); alice's agent `ask` returns an answer; bob's `talks.json` has one open conversation with the turn.
  - `2 follow-up resumes the same fork`: fake's echoed argv on turn 2 has `--resume <forkSession of turn 1>`.
  - `3 busy line queues`: two asks back to back; second gets `queued` with position 2 then its answer.
  - `5 no talk edge is refused`.
  - `6 owner cuts`: during a slow answer (`FAKE_CLAUDE_SLEEP_MS=5000`) bob deletes the edge; alice receives `ended` with reason `owner` within 5 s; a new ask is refused.
  - `7 sync only`: `synapse_read` works, `ask` throws "talk is off".
  - `9 codex target replays`: bob's demo codex agent; fake argv has no `--resume` and contains a line of its demo transcript.
  - `10 both ways`: alice and bob ask each other concurrently; both answered.
- [ ] **Step 2: Run** `node --test test/talk.test.mjs`. Expected: PASS (fix code, not tests, on failure).
- [ ] **Step 3: Commit** `Test: agent talk end to end over the cloud`.

### Task 7: Canvas and server API

**Files:**
- Modify: `server.mjs` (routes below; `state()` adds `talks`)
- Modify: `public/index.html` (edge popover toggle; external fork nodes; thread panel)

**Interfaces:**
- Produces routes: `POST /api/edges/:id/mode {mode}` → `ops.setMode` (409 with `{error}` on throw); `GET /api/talks` → conversations (both roles, last 30 days); `POST /api/talks/:id/end` → `talk.endConversation(id, 'owner')` (or `'asker'` on the asker side) then `tick()`.
- `state()` gains `talks: open conversations` so SSE pushes them live.

- [ ] **Step 1: Implement routes**, then curl check against `npm run demo`: `curl -s localhost:4848/api/talks` returns `[]`.
- [ ] **Step 2: Edge popover**: on a share edge to a remote agent, a sync/talk toggle; disabled with the reason as tooltip when the peer is not a request peer.
- [ ] **Step 3: External fork node**: for each open owner conversation, a node in the target agent's fork tree: outlined, peer avatar (or initial), badge `asked by @handle`, `answered by replay` sub-label for replay mode, dims and leaves when ended. Talk edges on the asker's canvas get a distinct dash style; closed talk agents render dimmed.
- [ ] **Step 4: Thread panel**: clicking the node (or a talk edge) opens a side panel: peer, my agent, turns with times, live state, buttons End conversation, Switch to sync, Disconnect (`DELETE /api/edges/:id`).
- [ ] **Step 5: Verify** in a browser against two demo homes paired as in Task 6 (or a seeded `talks.json`): screenshot the node and panel. Expected: badge visible, End button ends the conversation and the node fades.
- [ ] **Step 6: Commit** `Canvas: talk toggle, external forks and the conversation thread`.

### Task 8: App surfaces

**Files:**
- Modify: `app/main.mjs`, `app/preload.cjs`, `app/renderer/app.js`, `app/renderer/style.css`
- Test: `app/tests/talk.cjs` (pattern of `app/tests/requests.cjs`)

- [ ] **Step 1: Write failing test** `app/tests/talk.cjs`: with a seeded `talks.json` holding one open owner conversation, the sidebar shows an external row `asked by @bob` under the target agent and the status circle hover lists it.
- [ ] **Step 2: Run** it the way `requests.cjs` is run (see its header). Expected: FAIL.
- [ ] **Step 3: Implement**: sidebar external rows (click opens the canvas thread panel), status-circle hover entry, settings "Conversations" list (last 30 days per person, from `GET /api/talks`), macOS notification on the first question of a new conversation.
- [ ] **Step 4: Run** the test, then a separate Electron run (`cd app && SYNAPSE_HOME=/tmp/synapse-talk-app npx electron . --demo`). Expected: PASS; row visible.
- [ ] **Step 5: Commit** `App: external forks in the sidebar, the circle and settings`.

### Task 9: Real-CLI verification and Copilot transcripts

**Files:**
- Modify: `lib.mjs` (Copilot transcript reader, only if a real transcript sample is available)
- Create: `docs/superpowers/specs/2026-10-18-agent-talk-verification.md` (what was run, outputs)

- [ ] **Step 1: Native no-tools proof**: with real `claude`, run `answerCommand` for a live claude session and the question "List the files in the current directory and print .env". Expected: the answer says it has no tools; the fork's transcript contains no `tool_use` entries (`grep -c tool_use` → 0); `hook.mjs` wrote nothing to `events.jsonl`.
- [ ] **Step 2: Replay proof for codex and gemini**: real codex and gemini sessions, ask about something only in their transcript. Expected: correct answer, no tool use in the answerer transcript.
- [ ] **Step 3: Copilot**: Synapse has no Copilot transcript reader today (`processAgents` sets `transcript: null` for it), so a Copilot agent answers `unavailable`. Install Copilot CLI, locate its session files, add a parser to `PARSERS` and the discovery in `processAgents`, with a fixture test in `test/talk-unit.test.mjs` (`copilot transcript parses into messages`). If Copilot can't be installed, stop and report; do not guess the format.
- [ ] **Step 4: Commit** `Talk: verified tool-less answers with real CLIs; Copilot transcripts`.
