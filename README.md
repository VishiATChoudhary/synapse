<div align="center">

<img src="assets/promo.gif" alt="Synapse promo: agents multiply, link up, and go multiplayer" width="900">

# synapse

**Every coding agent on your machine, in one workspace. Read their conversations, connect them, and let them share context.**

<img alt="Node 18+" src="https://img.shields.io/badge/node-%E2%89%A518-16130F?style=flat-square&labelColor=F1EFE9">
<img alt="Dependency-free core" src="https://img.shields.io/badge/core_dependencies-0-16130F?style=flat-square&labelColor=F1EFE9">
<img alt="MCP" src="https://img.shields.io/badge/MCP-stdio-16130F?style=flat-square&labelColor=F1EFE9">
<img alt="MIT" src="https://img.shields.io/badge/license-MIT-FF4400?style=flat-square&labelColor=F1EFE9">

Claude Code · Codex · Gemini CLI · OpenCode · Cursor Agent · Amp · Copilot CLI · Superset

**[heysynapse.vercel.app](https://heysynapse.vercel.app)**

</div>

---

You have five agents open. One just figured out the auth bug, another is about to touch the same file,
and the only way they find out about each other is you copy-pasting between terminals.

Synapse puts every live agent in a desktop-style workspace, grouped by project. Follow a conversation,
connect two agents to share context, or leave a message without switching terminals. Linked agents can
also message each other, whichever CLI they run in. The original interactive canvas is one click away.

<div align="center">
<img src="assets/workspace.png" alt="The Synapse workspace: project sessions, a live conversation, and connected agents in a light desktop-style interface" width="1000">
</div>

## Desktop app

One macOS app contains **GUI** and **Terminal** modes. Switch at the top of the window; both views use
the same live processes, worktrees and fork trees. Switching never restarts an agent.

- Start Claude Code, Codex, Gemini, OpenCode, Cursor, Copilot, Amp or a shell from **New session**.
- Send prompts in the GUI; use **Open in Terminal** for sign-in, approvals and interactive CLI controls.
- Add, create or clone projects, open Git branches/worktrees, and fork conversations (Claude Code and Codex).
- Use Terminal mode for split panes, fork-tree navigation, drag ordering and the complete keyboard controls.
- Configure commands and install context-sharing tools from **Settings**. The installer backs up existing
  agent settings and includes its own Node runtime. Agent CLIs still need to be installed and signed in.
- Canvas, account/sharing, phone access and activity remain available in the same app.

```bash
npm run app:setup
npm run app
```

Build the Apple Silicon DMG with `npm run app:build`. The build uses the Developer ID certificate and
notary credentials in the local keychain, then validates Apple's acceptance. For local development
without signing credentials: `npm run app:build -- --ad-hoc`.

<img src="assets/desktop.png" alt="Synapse desktop with GUI and Terminal modes sharing one workspace" width="1000">

## Browser quick start

```bash
git clone https://github.com/VishiATChoudhary/synapse && cd synapse
node install.mjs     # wires Synapse into every agent CLI it finds (backs up each config first)
npm start            # workspace at http://localhost:4747
```

The browser workspace and CLI run on plain Node 18+ without runtime dependencies. The desktop app adds Electron and a native terminal runtime.

Just want to look around? `npm run demo` opens a workspace full of clearly labelled sample agents on
http://localhost:4848 and leaves your real sessions alone.

## The workspace

- **Project sidebar.** Switch between sessions, collapse projects, or search names, folders, and agent types with **⌘K / Ctrl+K**.
- **Conversations.** Read live transcripts with markdown, code blocks, copy controls, and a separate messages view. Your scroll position stays put when new activity arrives.
- **Shared context.** Add one-way or two-way connections from session details. Remove a connection with an undo action.
- **Messages.** In the desktop app, prompts go straight to sessions the app owns. For agents running elsewhere, messages remain queued until the next prompt or inbox check.
- **Light and dark.** Bundled fonts, keyboard navigation, saved drafts, and layouts for small screens. The appearance button switches themes.
- **Canvas.** Open **Canvas** in the sidebar, or go directly to `http://localhost:4747/canvas`, for the original graph and its drag-to-link controls.

Agent discovery runs in a background worker. The workspace uses one SSE connection, updates existing
session rows, and fetches only the selected conversation. It adds no runtime dependencies and makes
no third-party requests for the local UI. The desktop app can launch agents; the standalone browser workspace monitors agents started in other tools.

Run `npm test` for the core, workspace and local API checks; `npm run test:desktop` exercises real PTYs, both desktop views, launching, forking, worktrees and integration setup. Tests use isolated state and fake agent commands.

## What you get

<table>
<tr>
<td width="50%"><img src="assets/panel.png" alt="Agent panel with links, agent messages and recent activity"></td>
<td width="50%"><img src="assets/search.png" alt="Fuzzy search dims everything that does not match"></td>
</tr>
<tr>
<td><b>Click an agent</b> to see who it reads from, who it shares with, the messages agents sent it, and its latest conversation, rendered as markdown.</td>
<td><b>⌘F</b> fuzzy-searches by name, project, agent type or folder. Each word matches on its own, so <code>cdx api</code> finds the Codex agent in <code>acme-api</code>.</td>
</tr>
</table>

- **Live canvas.** Working agents pulse fast with an orange tick running round them, idle ones breathe. Messages travel along the links as little packets.
- **Grouped by project.** Agents of the same git repo sit together in a labelled frame, each project with its own shading (solid, hatched, dotted, ...). Worktrees count as their main repo, and a shading never changes once assigned.
- **Light and dark.** One ink on paper, orange for live state. Follows your system, or flip it with the button in the top bar. Fonts are bundled, so the canvas loads nothing from the internet.
- **Links are directional.** `A → B` means B gets A's context. Draw both directions for a two-way pair.
- **Agents talk.** Any two linked agents can message each other, Claude to Codex included.
- **You see it in the terminal.** Claude Code and Codex print a line whenever context or messages arrive. Claude Code also gets a live band above the prompt and a toast the moment something connects.

## How it works

```mermaid
flowchart LR
  subgraph machine[your machine]
    C1[Claude Code] & C2[Codex] & C3[Gemini, OpenCode,<br/>Cursor, Amp, ...]
  end
  D[discovery<br/>session registry + process scan] --> S[(~/.synapse<br/>edges · messages)]
  UI[canvas<br/>localhost:4747] <--> S
  S --> H[prompt hook<br/>Claude Code + Codex]
  S <--> M[MCP server<br/>every agent]
  S <--> K[synapse CLI<br/>+ /synapse skill]
  H --> C1 & C2
  M --> C1 & C2 & C3
```

1. **Discovery.** Claude sessions come from Claude Code's own session registry. Every other CLI is found by scanning processes and their working folders, which also works when they run inside Superset.
2. **Links** live in `~/.synapse/edges.json`. You draw them on the canvas, or an agent makes them itself with the skill or MCP tools.
3. **Context.** On each prompt, a hook injects what the linked agents said since last time, capped at 8k characters per link. Transcripts are read straight from disk: Claude's JSONL, Codex rollouts and Gemini chats.
4. **Messages** go through the same store. Claude and Codex get them with the next prompt. Other agents pick them up through the `synapse_inbox` MCP tool.
5. **Identity.** An agent figures out who it is by walking up the process tree to a known agent process, so no setup is needed per session.

## Supported agents

| Agent | Shows up | Peers can read its context | Messages | Terminal line | Live band + toasts |
|---|:-:|:-:|:-:|:-:|:-:|
| Claude Code | ✓ | ✓ | ✓ | ✓ | ✓ |
| Codex | ✓ | ✓ | ✓ | ✓ | |
| Gemini CLI | ✓ | ✓ | ✓ (MCP) | | |
| OpenCode | ✓ | ✓ | ✓ (MCP) | | |
| Cursor Agent | ✓ | ✓ | ✓ (MCP) | | |
| Amp | ✓ | | ✓ (MCP) | | |
| Copilot CLI | ✓ | | ✓ (MCP) | | |
| Superset CLI | ✓ | | ✓ (CLI) | | |

## In the terminal

When a session starts, and whenever a prompt pulls something in, Claude Code and Codex print:

```text
synapse  ⇠ reads codex-api-rate-limit  ·  ⇢ shares with api-review
synapse  ⇢ pulled context from codex-api-rate-limit (13 msgs, 3.4k chars)  ·  ✉ 1 message from api-review
```

In Claude Code, the `claude-mod/` add-on keeps a band above the prompt and pops a toast as soon as an
agent connects, unlinks or messages you:

```text
◉ synapse  reads ⇠ ● codex-api-rate-limit codex   shares ⇢ ● api-review claude   ✉ 1 from api-review
```

Run it with `claude --plugin-dir ./claude-mod`. Its test runs with `claude plugin test claude-mod`.

## Let agents do it themselves

Every agent gets the same six operations, as MCP tools (`synapse_peers`, `synapse_link`, `synapse_unlink`,
`synapse_read`, `synapse_send`, `synapse_inbox`) and as a CLI:

```bash
synapse peers --all                 # who am I linked to, and who else is running
synapse link codex-api              # link both ways (--in / --out for one direction)
synapse read codex-api              # their latest conversation
synapse send codex-api "Did the rate limiter land? I'm about to touch auth."
synapse inbox                       # what other agents sent me
synapse rename "auth refactor"     # rename yourself (or: synapse rename <agent> <name>)
synapse ui                          # start the canvas
```

The installer puts the launcher at `~/.synapse/bin/synapse` and adds a **`/synapse` skill** to Claude
Code and Codex, so you can just say *"connect to the codex agent and ask what it found"*.

## Canvas controls

| | |
|---|---|
| ⌘F or `/` | fuzzy search. ↑↓ to pick, Enter to jump |
| drag the ring around a node | create a link |
| drag a node | move it (saved) |
| drag a project frame | move the whole project; other frames step aside so they never overlap |
| click a node | details, links, messages, recent activity |
| double-click a node (or **rename** in its panel) | rename it. Empty name goes back to the generated one |
| hover a link, click × (or select it and press ⌫) | remove the link |
| scroll, drag the background | zoom, pan |
| F, or double-click the background | fit everything on screen |
| A | arrange: one block per project (also runs by itself when project frames overlap) |
| ☾ / ☀ in the top bar | light or dark |

## What's in the box

| | |
|---|---|
| `lib.mjs` | discovery, transcript parsers, projects and colours, message store |
| `app/` | desktop shell, PTYs, worktrees, fork stacks, phone access and updater |
| `ops.mjs` | peers, link, unlink, read, send, inbox. Everything below calls these |
| `server.mjs`, `discovery.mjs` + `public/` | desktop-style workspace and original canvas, live over SSE with background discovery |
| `tokens.css` | shared workspace colors, type, spacing, and light/dark themes |
| `hook.mjs` | `SessionStart` and `UserPromptSubmit` hook for Claude Code and Codex |
| `mcp.mjs` | dependency-free stdio MCP server |
| `cli.mjs`, `skill/` | the `synapse` CLI and the `/synapse` skill |
| `claude-mod/` | Claude Code band and toasts |
| `install.mjs` | idempotent installer. `--dry-run` shows what it would change |
| `promo/` | the Remotion source of the video above |

Settings: `PORT`, `SYNAPSE_HOME` (state folder, default `~/.synapse`), `SYNAPSE_BUDGET` (characters per link per prompt), `SYNAPSE_AGENT` (force an identity).

## Good to know

- Context-sharing messages are pulled on the next prompt or inbox check. Desktop prompts are sent directly to the selected PTY.
- Agents that are already running pick up the MCP server and hooks after a restart.
- Plain `codex` asks you once to trust the new hook. Gemini only loads MCP servers in folders you have trusted.
- Shared context is labelled as coming from peers, and agents are told not to treat it as instructions from you.
- Local sessions and transcripts stay on your machine. Cloud sign-in, remote sharing, phone features, and update checks use network services when enabled.

## Roadmap

- Native conversation forks for additional agent CLIs.
- Readable transcripts for Amp and Copilot.
- Broader desktop platform packaging.

## License

MIT
