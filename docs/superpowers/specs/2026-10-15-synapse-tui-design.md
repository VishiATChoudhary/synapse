# Synapse TUI and forks: design

Date: 2026-10-15
Status: approved in conversation, awaiting written review

## 1. Why

Two pains drive this.

1. **Side questions dirty the main context.** A coding agent returns a list of five points. You want to dig into point three. Asking inline fills the main session with a side discussion you then scroll past. Claude Code's `/branch` copies the session, but it gives no structure, no way back, and nothing for other agents.
2. **Superset is the only place that distributes projects, worktrees and agents, and it is a desktop app that needs a login.** The user wants the same distribution in a terminal, wired to Synapse, with forks as a first-class interaction.

So: a Rust TUI that hosts agent sessions and plain shells per project and worktree, shows Synapse state inline, and treats a fork as a card pushed on top of its parent.

## 2. Scope

Three sub-projects, delivered in this order. Each gets its own implementation plan.

| Phase | Deliverable | Depends on |
|---|---|---|
| 1 | TUI shell: projects, worktrees, slots, PTYs, launch profiles, status | nothing |
| 2 | Synapse view inside the TUI: links, messages, activity, link and send from the sidebar | phase 1 |
| 3 | Fork stacks: `/sfork`, per-kind fork adapters, stack cards, fan-out tree, send back, pop | phase 1, hook work in `hook.mjs` |

Out of scope for all three: daemon or detach (sessions die with the TUI), multiplayer, Windows, scrollback search, split panes.

## 3. Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Runtime | Rust: `ratatui`, `crossterm`, `portable-pty`, `vt100`, `serde_json` | Own multiplexer, full control over stack and fan-out rendering, single binary. tmux has no hover and poor overlays. Node has no PTY. |
| Process model | Single process, v1 | Half the work. Session layer sits behind a trait so a daemon can be added later without touching UI. |
| Where it lives | `tui/` crate in this repo, binary `synapse-tui` | Shares `~/.synapse` state and the `synapse` CLI. |
| Fork mechanism | Native fork per agent kind, fallback to Synapse-injected context | Four kinds have native forks. Exact context beats copying. |
| Fork surfaces | `/sfork <question>` typed in the session, `synapse_fork` MCP tool, `synapse fork` CLI, TUI leader key | Typed form is the primary one. Hook intercepts and blocks it so it never enters the parent's context. |
| Fork interaction | Child covers parent in the same slot. Stack of cards. Hover or leader key fans the stack into a tree. | User's drawing: left a deck, right a tree of parent, children, grandchildren. |
| Return path | Opt-in. Child sends a short summary to parent with the existing `synapse send`. Nothing flows back unless asked. | Keeps the parent clean. Reuses the message store. |
| Permissions | Launch profiles copy Superset's commands: `claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`, `gemini --approval-mode=auto_edit`, `copilot --allow-tool=write`, `amp`. Cursor gets an auto-approve hook. | User asked for Superset parity. Profiles are editable, so a cautious mode is one line away. |
| Plain shells | A `shell` profile runs `$SHELL -l`. Same slot model, no Synapse identity, cannot be forked. | User asked. Needed for git and tests anyway. |

## 4. Verified facts

Experiments run on 2026-10-15 with `claude -p` and the installed CLIs.

- A `UserPromptSubmit` hook receives `/sfork why fruit 2?` as raw text in `prompt`. Claude Code did not reject it as an unknown command before the hook ran. Returning `{"decision":"block","reason":"..."}` stopped it. The user saw the reason.
- The blocked prompt is written to the parent transcript as a `system` entry, not a `user` entry. Synapse's transcript parser reads only `user` and `assistant`, so peers never see it. The model never sees it.
- `claude -p --resume <id> --fork-session "<question>"` forks and answers from the parent's context.
- `codex fork <session-id> [prompt]` and `codex exec fork <session-id> <prompt>` exist. Codex's session id is in the rollout filename and in `session_meta`.
- `opencode --session <id> --fork` and `opencode run -s <id> --fork` exist.
- `gemini` has `--session-file <json>`, `--session-id <uuid>`, `-i <prompt>`.
- `cursor-agent` and `copilot` have `--resume` only. Two processes on one session is unsafe.
- `amp` is not installed. Fork support unverified.
- Rust 1.92 toolchain present.
- Superset's embedded terminal reports `TERM_PROGRAM=kitty` without a kitty binary. `SUPERSET_TERMINAL_ID` is the reliable detector. `superset terminals create --local` needs a login.

## 5. Unverified, check first in each phase

Each is a task at the top of the relevant plan. If one fails, the fallback next to it applies.

| Item | Phase | Fallback |
|---|---|---|
| Interactive Claude Code passes unknown `/sfork` to the hook as print mode does | 3 | Register `/sfork` as a real skill and block in `UserPromptExpansion` |
| Codex's `UserPromptSubmit` hook can block a prompt | 3 | Codex forks only through MCP tool, CLI or leader key |
| `gemini --session-file <chat> --session-id <new> -i "<q>"` behaves as a fork | 3 | Gemini uses the Synapse-injected fallback |
| OpenCode's current session id can be read from `~/.local/share/opencode/opencode.db` by cwd and recency | 3 | OpenCode uses the Synapse-injected fallback |
| `vt100` crate renders Claude Code and Codex TUIs correctly (they use alt screen, bracketed paste, mouse) | 1 | Swap to `tui-term` or `alacritty_terminal` behind the same `Screen` trait |
| `--session-id` combines with `--fork-session` so the child id is known before spawn | 3 | Child identifies itself in `SessionStart` via env `SYNAPSE_FORK_ID` |

## 6. Phase 1: TUI shell

### 6.1 Crate layout

```text
tui/
  Cargo.toml
  src/
    main.rs        arg parsing, terminal setup, event loop
    app.rs         App state, key routing, redraw
    model.rs       Project, Worktree, Slot, Session (pure data, unit tested)
    pty.rs         Session spawn, reader thread, resize, kill. Behind trait `Host`
    screen.rs      trait Screen { feed, resize, cell(x,y), cursor }; vt100 impl
    ui/
      sidebar.rs   projects, worktrees, slots, synapse strip
      header.rs    stack cards for the focused slot
      pane.rs      renders Screen into ratatui buffer
      overlay.rs   fan-out tree, pickers, prompts, confirms
      status.rs    bottom line
    synapse.rs     reads ~/.synapse/*.json, shells to `synapse` CLI
    git.rs         worktree list, add, remove, current branch
    profiles.rs    launch profiles from ~/.synapse/tui.json
    forks.rs       phase 3: adapters, request watcher
```

### 6.2 State model

```text
Project  { key, label, path, color }
Worktree { project, name, path, branch }
Slot     { id, worktree, stack: Vec<Session>, focused_depth }
Session  { id, kind, pid, pty, screen, title, status, synapse_id: Option<String>,
           parent: Option<SessionId>, question: Option<String>, exit: Option<i32> }
```

- A Slot is what you switch between. Normal session is a stack of one.
- A Session's `kind` is a launch profile name: `claude`, `codex`, `gemini`, `opencode`, `cursor-agent`, `copilot`, `amp`, `shell`.
- `synapse_id` resolves by pid from `synapse agents --json`, polled each second. Shells never get one.
- `parent` and `question` are set only by forks (phase 3) but exist from day one so phase 3 adds no migrations.

### 6.3 Projects and worktrees

- Project registry: `~/.synapse/tui.json` → `projects: [path]`. Added with `synapse-tui add <path>`, leader + `p`, or automatically when a live agent's cwd belongs to an unregistered repo (same rule the canvas uses: `git rev-parse --git-common-dir`).
- Worktrees: `git worktree list --porcelain` per project. Superset worktrees under `~/.superset/worktrees` appear because they are plain git worktrees.
- New worktree: `git worktree add -b <name> ~/.synapse/worktrees/<project>/<name> <base>`. Base defaults to the main checkout's current branch. Opens a shell slot in it and offers the agent picker.
- Remove: confirm, kill slots in it, `git worktree remove <path>`. Dirty tree → refuse with git's message, offer `--force` behind a second confirm.
- Project colour: `synapse` already assigns one per project in `~/.synapse/colors.json`. TUI reads it, never assigns.

### 6.4 Launch profiles

`~/.synapse/tui.json`:

```json
{
  "projects": ["/Users/vishi/shennies/synapse"],
  "profiles": {
    "shell":        { "command": "$SHELL -l" },
    "claude":       { "command": "claude --dangerously-skip-permissions" },
    "codex":        { "command": "codex --dangerously-bypass-approvals-and-sandbox" },
    "gemini":       { "command": "gemini --approval-mode=auto_edit" },
    "opencode":     { "command": "opencode" },
    "cursor-agent": { "command": "cursor-agent" },
    "copilot":      { "command": "copilot --allow-tool=write" },
    "amp":          { "command": "amp" }
  }
}
```

Seeded on first run. `command` is run through `$SHELL -lc` so PATH and wrappers apply. Missing binary → slot shows the error and stays open as a shell.

Every PTY gets env: `SYNAPSE_SESSION=<slot id>`, `SYNAPSE_TUI=1`, `TERM=xterm-256color`, `COLORTERM=truecolor`.

### 6.5 Status

Three states per session: working, waiting (needs input or permission), idle.

- Claude: `~/.claude/sessions/*.json` `status` field, already read by `lib.mjs`.
- Claude and Codex, richer: `hook.mjs` gains `Stop`, `SessionEnd`, `Notification` handling and writes `~/.synapse/status.json` as `{ "<SYNAPSE_SESSION>": { state, at } }`. `install.mjs` wires the new events. This mirrors Superset's `notify.sh` keyed by `SUPERSET_TERMINAL_ID`.
- Everything else: CPU heuristic from `lib.mjs` (busy above 4 percent) until per-kind hooks land. Gemini settings hooks, Cursor `hooks.json` and the OpenCode plugin are copyable from `~/.superset/hooks`.
- PTY exit: card greys, exit code in the title.

### 6.6 Layout

```text
┌ projects ─────┬─ ▣ auth-fix ▣ ▣ ·  3 ───────────────────────────────────┐
│ ▾ synapse     │                                                          │
│   main      ● │   focused session, top of its stack                      │
│   auth-fix  ◐ │                                                          │
│   promo     $ │                                                          │
│ ▸ toffee-web  │                                                          │
│               │                                                          │
│ ⇠ codex-api   │                                                          │
│ ✉ 1 msg       │                                                          │
├───────────────┴──────────────────────────────────────────────────────────┤
│ ⌃Space  n new  t shell  w worktree  f fork  g synapse  ⌫ pop  ? help     │
└──────────────────────────────────────────────────────────────────────────┘
```

- Sidebar: project → worktree → slots. `●` working, `◐` waiting, `○` idle, `$` shell, `✗` exited. Below: Synapse strip for the focused slot (phase 2). Toggle with leader + `b`.
- Header: focused slot's stack as cards, top of stack rightmost, depth count. One session shows one card.
- Pane: the top session's screen. Cursor shape and colour pass through.
- Status line: leader hints, or the last error for five seconds.
- Below 80x24: sidebar hidden, header one line.

### 6.7 Keys and mouse

Leader is `Ctrl+Space`. Everything not prefixed goes raw to the PTY, including `Ctrl+C`.

| Leader + | Action |
|---|---|
| `n` | new agent slot in focused worktree, profile picker |
| `t` | new shell slot |
| `w` | new worktree, name prompt |
| `W` | remove focused worktree |
| `p` | add project, path prompt |
| `j` `k` or arrows | move focus in sidebar |
| `1`..`9` | jump to slot |
| `x` | close focused session, confirm if running |
| `b` | toggle sidebar |
| `f` | fan-out tree (phase 3) |
| `F` | new fork of the focused session, question prompt (phase 3) |
| `⌫` | pop top of stack (phase 3) |
| `g` | Synapse view (phase 2) |
| `q` | quit, confirm lists running sessions |
| `?` | help overlay |

Mouse: click sidebar rows and header cards to focus. Wheel inside the pane passes to the PTY. Hover on header cards opens the fan-out (phase 3).

Resize: every PTY gets the pane size on terminal resize, so agents reflow.

### 6.8 Event loop

One UI thread. One reader thread per PTY sends bytes over an `mpsc` channel. A ticker fires every 250 ms for status polling and redraw of pulsing indicators. The loop selects on key events, PTY bytes, ticker. Redraw only when something changed. Target under 16 ms per frame with ten live sessions.

### 6.9 Errors

- Agent binary missing: message in the slot, stays a shell.
- PTY dies: grey card, exit code, Enter restarts, `x` closes.
- `~/.synapse` unreadable: sidebar shows "synapse offline", rest works.
- `git` failure: status line shows git's stderr, nothing changes.
- Panic: `panic = "abort"` is off; a panic hook restores the terminal before exit so the user's shell is not left in raw mode.

### 6.10 Tests

- `model.rs`: slot focus, stack push and pop, tree layout for fan-out, serialisation of `tui.json`.
- `screen.rs`: scripted byte streams, assert cells. Includes alt screen enter and leave, bracketed paste, 256 and truecolour.
- `pty.rs`: spawn `sh -c 'printf hi; exit 3'`, assert bytes and exit code.
- `git.rs`: temp repo, add and remove worktree, dirty refusal.
- Manual checklist in the plan: Claude and Codex each in a slot, resize, quit confirm.

## 7. Phase 2: Synapse in the TUI

Reads the same files the canvas and hook use. No new state.

- Sidebar strip for the focused slot: `⇠ reads` and `⇢ shares` names, unread message count. Data from `edges.json` and `messages.json`.
- Leader + `g`: Synapse overlay. Left: every live agent grouped by project, status dot, TUI-hosted ones marked. Right: focused agent's links and last ten messages. Keys: `l` link both ways, `i` in, `o` out, `u` unlink, `s` send (prompt), Esc.
- Mutations shell to `synapse link|unlink|send` with `SYNAPSE_AGENT=<id>` set, so `ops.mjs` stays the single implementation.
- Activity: tail `events.jsonl` like `server.mjs` does. A `context` or `message` event flashes the sidebar row for one second.
- Agents running outside the TUI appear in the overlay but have no slot. Selecting one offers nothing but link and send.

Tests: fixture `~/.synapse` directory with edges and messages, assert overlay model. `SYNAPSE_HOME` already redirects the Node side, so the same fixture serves both.

## 8. Phase 3: Fork stacks

### 8.1 Flow of one `/sfork`

1. User types `/sfork why is point 3 wrong?` in a Claude session hosted in slot S.
2. `hook.mjs` `UserPromptSubmit` matches `^/sfork\s+(.+)`. It appends a request to `~/.synapse/forks.json`: `{ id, parent: <agent id>, parentKind, cwd, question, requestedAt, status: "pending", host: "tui" | "tab" }`. `host` is `tui` when `SYNAPSE_TUI=1` is in the hook's env, else `tab`. It returns `{"decision":"block","reason":"synapse ⑂ forked"}`. The parent never sees the prompt.
3. TUI watches `forks.json` (mtime, 250 ms ticker). For a `pending` request with `host: tui` whose parent pid is in slot S, it builds the child command from the adapter for `parentKind`, spawns it in S's worktree with env `SYNAPSE_FORK_ID`, `SYNAPSE_FORK_OF`, pushes the Session on S's stack, and marks the request `spawned`.
4. Child's `SessionStart` hook (Claude, Codex) sees `SYNAPSE_FORK_OF`, creates the edge parent → child with `kind: "fork"`, injects framing: "You are a fork of <parent>, spun off to explore: <question>. Stay on it. When the user says done or send back, send a short summary to <parent> with `synapse send` and say so." Kinds without a hook get the framing as the initial prompt.
5. User works in the child. The header shows two cards. Parent's screen is kept alive underneath, still receiving output.
6. User says "send back". Child runs `synapse send <parent> "<summary>"`. Parent gets it on its next prompt through the existing message path.
7. Leader + `⌫` pops: confirms if the child is working, kills it, marks the fork `closed`, parent is on top again.

When no TUI is running (`host: tab`), `ops.fork` opens the child in a new terminal tab through the opener in section 8.4. Same request record, same adapters.

### 8.2 Adapters

`forks.rs` and `ops.mjs` both implement this table. The Node side is the source of truth for CLI, MCP and tab mode; the Rust side mirrors it for TUI mode. A shared JSON fixture in `tui/tests/adapters.json` keeps them in sync.

| Kind | Session id | Fork command | Headless |
|---|---|---|---|
| claude | session registry | `claude --resume <id> --fork-session "<q>"` plus the profile's flags | `claude -p --resume <id> --fork-session "<q>"` |
| codex | rollout filename | `codex fork <id> "<q>"` plus profile flags | `codex exec fork <id> "<q>"` |
| opencode | latest session for cwd in `opencode.db` | `opencode --session <id> --fork` then prompt as first input | `opencode run -s <id> --fork "<q>"` |
| gemini | chat file for cwd, already resolved in `lib.mjs` | `gemini --session-file <chat> --session-id <new> -i "<q>"` | `gemini -p` on the same |
| cursor-agent, copilot, amp | n/a | fallback | fallback |
| shell | n/a | refused | refused |

Fallback: spawn a fresh session of the same profile, create the fork edge, and put the question plus "read your parent with `synapse read <parent>` first" as the initial prompt. The card is marked `≈` so the user knows the context is injected, not inherited.

### 8.3 Fan-out overlay

Leader + `f`, or mouse hover on the header cards for 300 ms. Full-pane overlay drawing the slot's fork tree:

```text
                      ┌─────────────┐
                      │   parent    │
                      └──────┬──────┘
        ┌────────────┬───────┴──────┬────────────┐
   ┌────┴────┐  ┌────┴────┐              ┌───────┴──────┐
   │ child ● │  │ child ○ │              │ child ◐      │
   └─────────┘  └────┬────┘              └──────────────┘
                ┌────┴──────┐
                │grandchild │
                └───────────┘
```

- Node label: question, clipped to 24 chars. Status dot. `≈` for fallback forks.
- Arrow keys move between nodes, Enter brings that node's session to the top of the stack and closes the overlay. `d` closes a node's session (confirm). Esc closes the overlay.
- Tree layout: simple layered layout, parent centred over its children. Width overflow scrolls horizontally.
- The stack is a path through this tree, root to focused node. Choosing a node in another branch replaces the path, it does not kill sessions.

### 8.4 Terminal tab opener, non-TUI mode

`terminal.mjs` in the Node side. Strategies in order, first success wins:

1. `SUPERSET_TERMINAL_ID` set → `superset terminals create --local --workspace $SUPERSET_WORKSPACE_ID --command "<cmd>"`. Needs login, error message says so.
2. `TERM_PROGRAM=iTerm.app` → AppleScript new tab, write text.
3. `TERM_PROGRAM=Apple_Terminal` → AppleScript `do script`.
4. Fallback → `open -a Terminal <script>` with a temp script that `cd`s and runs the command.

### 8.5 Other fork surfaces

- `synapse_fork` MCP tool and `synapse fork "<q>" [--headless]` CLI call `ops.fork(me, question, opts)`. Same request record. Costs one tool call in the parent, which is the price of letting the agent decide.
- TUI leader + `F` prompts for a question and files the request itself for the focused session.
- Headless mode (`--headless`): `ops.fork` runs the headless command, stores the answer on the request, and the canvas panel shows it with a "send to parent" button. The TUI shows headless answers as a `✉` card that opens a read-only pane.

### 8.6 Edge cases

- Parent exits while children live: children stay, card for the parent greys, fan-out still shows it. Send back fails with "parent gone", child is told.
- Fork of a fork: works the same, `parent` is the child's id. Depth unlimited, header clips cards from the left.
- Two forks on the same parent: two children, same slot, fan-out shows them side by side. Header shows the path to the focused one.
- Transcript lag: Claude writes the transcript asynchronously. The TUI waits until the parent transcript's mtime is at least the request's `requestedAt`, up to two seconds, before spawning.
- Request older than ten minutes with status `pending`: marked `stale`, ignored.
- Blocked `/sfork` in a session not hosted by the TUI and with no opener working: hook returns the reason "synapse: could not open a terminal, run `synapse fork` from the canvas".

### 8.7 Canvas

Fork edges (`kind: "fork"`) draw dashed. Child nodes draw smaller, placed under their parent. Parent panel gets "ask on side" input and a list of fork results with "send to parent". Small change to `public/index.html`, same data.

### 8.8 Tests

- `hook.mjs`: feed `/sfork x` on stdin with `SYNAPSE_HOME` pointing at a temp dir, assert block output and the request record.
- Adapters: fixture table, assert argv per kind.
- `model.rs`: push, pop, path through tree, layered layout coordinates for the ASCII above.
- Integration: spawn a fake agent (`sh` that prints its env), file a request, assert a child appears with `SYNAPSE_FORK_OF` set.
- Manual: Claude parent, `/sfork`, work in child, send back, pop, message arrives in parent.

## 9. Install and run

- `cargo install --path tui` puts `synapse-tui` on PATH. `install.mjs` prints the command if cargo is present, never runs it.
- `synapse tui` in `cli.mjs` execs `synapse-tui` when found.
- `install.mjs` wires the new hook events for Claude and Codex and seeds `tui.json`.

## 10. Open questions, deferred

- Daemon mode for surviving a closed terminal.
- Hooks for Gemini, Cursor, OpenCode, Copilot status. Scripts exist in Superset to copy from.
- Fork into a different kind (Claude parent, Codex child) using the fallback path. Trivial once fallback exists, not in phase 3.
- Scrollback and search in the pane.
