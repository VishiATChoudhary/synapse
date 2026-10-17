# Synapse Cloud: accounts, trusted people, synapse requests

Status: building (2026-10-17). Branch `multiplayer`.

## Goal

People sign up (email + password, GitHub, Google, X), download the DMG, sign in inside the app,
add **trusted people** in settings, and an agent can send a **synapse request** to a trusted person.
The recipient sees a blinking circle next to "synapse" at the top right of the app, accepts or denies.
Accepted: circle turns green, hovering lists every synapsed external agent, and the requesting agent
can read the shared agent's context (`synapse_read name@owner`). Denied: circle disappears.

## Pieces

| piece | where | what |
|---|---|---|
| cloud service | `cloud/` → Railway project `synapse-relay`, service `cloud`, https://synapse-cloud.up.railway.app | accounts, OAuth, email, trusted list, requests, machine mailbox (superset of `relay/`), web pages (signup, login, forgot/reset, verify, device approval, onboarding, download, settings, public profiles) |
| client lib | `account.mjs` (new), `remote.mjs` | login state in `~/.synapse/account.json`; cloud calls; machine bound to the user; accept/deny applies the share |
| agent surface | `mcp.mjs`, `cli.mjs`, `skill/SKILL.md` | `synapse_request`, `synapse_people`, `synapse_requests` tools; CLI `login/logout/whoami/trust/request/requests/accept/deny` |
| app | `app/main.mjs`, `app/preload.cjs`, `app/renderer/*` | login screen, account/profile modal, trusted people in settings, the status circle + popover |
| website | cloud pages; `synapse-site` landing gets Sign up / Download links | onboarding |

`relay/` keeps running for old clients. New clients use the cloud for the mailbox too
(`/v1/register|invite|join|send|poll` are identical there).

## Tokens

- **Session token** (user): opaque `syn_<base64url 32 bytes>`, stored hashed (sha256) server side.
  Web: cookie `syn_session` (HttpOnly, Secure, SameSite=Lax, 30 days). App/CLI: `Authorization: Bearer syn_…`
  (1 year, revocable under Settings → Devices).
- **Machine token**: HMAC-signed `body.sig` exactly like `relay/` (`{k:'machine', m, u?}`).
  `/v1/register` called with a session bearer binds the machine to the user (`u`).
  Mailbox routes (`invite/join/send/poll`) authenticate with the machine token as before.

## API (JSON in, JSON out; errors are `{ error: "human sentence" }` with 4xx/5xx)

Base: `https://synapse-cloud.up.railway.app` (override with env `SYNAPSE_CLOUD`).

### Auth
- `POST /v1/auth/signup {email, password, name?, client?: 'app'|'cli'|'web', label?}` → `{token, user}` (web also sets cookie). Sends a verification email. Password ≥ 8 chars.
- `POST /v1/auth/login {email, password, client?, label?}` → `{token, user}`; 401 `{error}` on bad creds.
- `POST /v1/auth/logout` (bearer or cookie) → `{ok:true}`.
- `POST /v1/auth/forgot {email}` → always `{ok:true}`; emails a reset link `/reset?token=…` (1 hour).
- `POST /v1/auth/reset {token, password}` → `{ok:true}`; signs out every other session.
- `POST /v1/auth/verify {token}` / page `GET /verify?token=` → marks email verified.
- `POST /v1/auth/resend-verification` (auth) → `{ok:true}`.
- OAuth: `GET /auth/{github|google|x}/start?next=<path>` → provider → `GET /auth/{provider}/callback` → cookie session, redirect to `next` (default `/welcome`). Signed in already → the identity is linked to the current account. Matching *verified* email → same account.
- `GET /v1/auth/providers` → `{github: bool, google: bool, x: bool, email: true}` (which ones are configured).

### Device sign-in (app / CLI, any provider)
- `POST /v1/device/start {label}` → `{deviceCode, userCode, url, interval: 2, expiresIn: 600}`; `url` = `/device?code=<userCode>`. Add `&via=github|google|x` to jump straight to that provider.
- Browser: `/device?code=` signs in if needed, then shows "Sign in Synapse on <label>?" → Approve.
- `POST /v1/device/poll {deviceCode}` → `{status:'pending'}` | `{status:'approved', token, user}` (once) | 410 `{error}` expired/denied.

### Me / profiles
- `GET /v1/me` → `{user}`; `user = {id, email, emailVerified, handle, name, avatar, providers:[...], hasPassword, createdAt}`.
- `PATCH /v1/me {name?, handle?, avatar?}` → `{user}` (handle: `[a-z0-9_-]{2,24}`, unique).
- `POST /v1/me/password {current?, password}` → `{ok:true}` (`current` required when a password exists).
- `DELETE /v1/me {password?}` → `{ok:true}`.
- `GET /v1/me/sessions` → `{sessions:[{id, kind, label, createdAt, lastUsed, current}]}`; `DELETE /v1/me/sessions/:id`.
- `GET /v1/users/:handle` → public `{handle, name, avatar, createdAt}`; page `GET /u/:handle`.

### Trusted people
- `GET /v1/trusted` → `{trusted:[{id, handle, name, avatar, email?, pending:boolean, trustsYou:boolean}]}` (`pending` = invited by email, no account yet).
- `POST /v1/trusted {who}` → `who` is an email, `@handle` or handle → `{person}`. Unknown email: stored as pending + invite email sent; becomes real on their signup.
- `DELETE /v1/trusted/:id` → `{ok:true}`.

### Synapse requests
- `POST /v1/requests {to, machineId, agent:{id, name, kind, project}, target?, note?}`
  `to` must be in the sender's trusted list (handle, @handle, email or name). `target` is a free-text hint for which of their agents (e.g. "api agent").
  → `{request}`. Duplicate pending (same agent → same person) returns the existing one.
- `GET /v1/requests` → `{incoming:[request], outgoing:[request]}` (pending + last 30 days).
  `request = {id, status:'pending'|'accepted'|'denied'|'cancelled', from:{handle,name,avatar}, to:{handle,name,avatar}, agent:{id,name,kind,project}, target, note, createdAt, decidedAt, fromMachine, toMachine, shared:[{id,name,kind,project}]}`
- `POST /v1/requests/:id/accept {machineId, agents:[{id,name,kind,project}]}` (recipient) → `{request, pair, peer:{machineId, name}}`.
  Server delivers to the requester's machine mailbox: `{type:'paired', from: <accepter machine>, name, pair}` and `{type:'request', id, status:'accepted', shared:[...]}`.
  The accepter's client then adds the peer (`remote.json` peers) and creates share edges `<local agent> → remoteId(fromMachine, agent.id)`; the existing sync pushes context.
- `POST /v1/requests/:id/deny` (recipient) → `{request}`; requester mailbox gets `{type:'request', id, status:'denied'}`.
- `POST /v1/requests/:id/cancel` (sender) → `{request}`.

### Mailbox (unchanged from relay)
`POST /v1/register` (optional session bearer) → `{machineId, token}`; `/v1/invite`, `/v1/join`, `/v1/send`, `/v1/poll` with machine bearer.
The mailbox is persisted (SQLite), items expire after 24 h.

## Web pages (served by the cloud, same origin as the API)
`/` (redirect to landing or /welcome), `/signup`, `/login`, `/forgot`, `/reset`, `/verify`, `/device`,
`/welcome` (onboarding: verify email → download → sign in on the Mac → add trusted people → first request),
`/download` (302 to latest DMG on GitHub releases), `/settings` (profile, password, connected accounts, devices, trusted people, requests, delete), `/u/:handle`.

## Client state
- `~/.synapse/account.json`: `{cloud, token, user}` (0600). Shared by the app, CLI and MCP.
- `~/.synapse/requests.json`: last fetched `{incoming, outgoing, t}` (the app and canvas read it).
- `remote.json` keeps machine identity; when signed in, `relay` = cloud URL and registration carries the session bearer.

## App UI
- **Circle** (`#syn-dot` inside `#btn-canvas`, before "synapse", replacing ◇):
  pending incoming request → blinking (signal colour); any active external link and no pending → solid green;
  otherwise hidden (no circle, the ◇ shows). Click → popover: pending requests with Accept (pick which of my agents, default the best match) / Deny; hover → list of synapsed external agents (theirs shared with me, mine shared with them) with owner.
- **Login screen** on first launch when signed out: email/password (sign in / create account / forgot), buttons GitHub, Google, X (device flow in browser), "continue without an account" (local only).
- **Account modal** (sidebar foot avatar or settings): name, handle, avatar, email + verified state, change password, open web settings, sign out.
- **Settings modal**: new "trusted people" section (add by email/handle, remove, pending marker).
- Notifications: a macOS notification when a new incoming request arrives.
