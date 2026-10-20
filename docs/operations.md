# Operating Synapse

What Synapse runs on, what it costs, and what to change as it grows. Numbers checked 19 October 2026;
billing period Oct 2 to Nov 2. Live load is on the admin page (`https://app.heysynapse.dev/admin`).

## Services and costs

| Service | What it does for Synapse | Plan | Cost now | When it starts to cost more |
|---|---|---|---|---|
| **Railway**, workspace Invertix, project `synapse-relay` | `cloud` (accounts, trusted people, requests, mailbox, web pages, SQLite on a volume) and `relay` (the old no-account mailbox for invite codes) | Usage-based, shared with the other Invertix projects | **$0.17 so far this period** (cloud $0.09, relay $0.08). Almost all of it is memory: cloud ~30 MB, relay ~60 MB, always on | RAM $10/GB-month, CPU $20/vCPU-month, egress $0.05/GB, volume $0.15/GB-month. Memory is what grows |
| **Resend** | Verify, reset, invite, request and "you are in" emails from `no-reply@heysynapse.dev` | Check the dashboard; free is likely | $0 on free | Free stops at **100 emails a day** / 3,000 a month (sending pauses, no bill). Pro $20/month for 50k |
| **Vercel** (account vishisht0902) | Landing page (project `getsynapse`), DNS for heysynapse.dev | Hobby | $0 | Hobby is for non-commercial use only. Once Synapse makes money, Pro is $20/month |
| **Domain** heysynapse.dev | Bought through Vercel | Yearly | ~$15/year (check the Vercel invoice) | Renews 17 Oct 2027 |
| **Apple Developer Program** | Developer ID signing and notarization of the Mac app; the App Store for the phone app | Yearly | $99/year | Flat |
| **GitHub** | Repo, Releases (the DMG and the signed `latest.json` the app updates from) | Free, public repo | $0 | Release downloads are free for public repos |
| **GitHub / Google OAuth** | Sign in with GitHub or Google | Free | $0 | Flat |
| **X OAuth** | Sign in with X | X API pay-per-use (no free tier since Feb 2026) | about $0.01 per X sign-in (one user read) | Grows with X sign-ins. Turn X off (unset `X_CLIENT_ID`) if it is not worth it |
| **Anthropic / OpenAI** | Agent talk answers run on the answering user's own Claude or Codex account | n/a | $0 to you | Never on you |

**Total for Synapse today: about $0.20 a month on Railway, plus $99 + ~$15 a year in fixed fees.**

The Invertix workspace bill (~$42 so far, ~$68 estimated for the period) is mostly other projects
(`eloquent-magic` $32.84, `demo-backend-20260622` $4.82, `cooperative-warmth` $4.49). The workspace
has a $25 soft limit (email alert) and a $450 hard limit. If Synapse should be billed on its own, move
`synapse-relay` to its own workspace.

How to read the numbers again:

```bash
railway usage --workspace Invertix --json
railway usage projects --workspace Invertix --project synapse-relay --json   # per service
railway metrics --project ef124b13-eb18-492a-a873-155b5ba4f926 --environment production --service cloud --since 1h
```

## How load grows

Every signed-in Mac running Synapse polls the cloud every 3 seconds (`SYNAPSE_SYNC_MS`), so one online
machine is about 20 requests a minute, whether anything is shared or not. The cloud answered ~800
requests an hour on 19 October, which is a handful of machines.

| Online machines | Requests/second | What happens |
|---|---|---|
| 10 | ~3 | Nothing. Today |
| 100 | ~33 | Nothing. One Node process with SQLite handles this easily |
| 1,000 | ~330 | One process still copes, but CPU starts to show on the bill. Time to cut polling |
| 10,000 | ~3,300 | Needs the changes below: one process and SQLite will not keep up |

Memory and the volume grow slowly: accounts and requests are small rows, and the mailbox keeps items for
a day at most (8 MB cap per machine). Email grows with sign-ups, not with use.

## What to change, in order

1. **Now (free).** Watch the admin page: *machines online now*, *mailbox*, *database*, *memory*. Keep the
   Railway soft limit as the alarm. The waitlist controls growth.
2. **Over ~50 sign-ups a day.** Move Resend to Pro ($20/month), or verification and invite emails stop at
   100 a day.
3. **Before charging money.** Vercel Pro ($20/month), since Hobby is non-commercial.
4. **Around 500 to 1,000 online machines.** Stop polling every 3 seconds when nothing is shared:
   poll slowly when a machine has no friends or shares, or hold the request open until something
   arrives (long-poll). This cuts requests 10x or more and is the biggest saving. It needs an app release.
5. **Around 5,000+ online machines, or if one copy of the cloud is not enough.** The cloud is built as one
   process: SQLite on one volume, rate limits in memory. To run several copies, move the data to Postgres
   (Railway has it), move rate limits to Redis, and put the mailbox on its own service. A larger single
   instance (Railway lets a service use up to 32 vCPU and 32 GB) goes a long way before that is needed.

## Gaps to know

- **The old relay ignores the waitlist.** People who are not signed in still pair through invite codes
  on `relay` (`DEFAULT_RELAY` in `remote.mjs`), which has no accounts, so the waitlist cannot stop them.
  To close it: stop the `relay` service once everyone signs in (the cloud speaks the same protocol), or
  make the app require sign-in for invites.
- **Backups.** The SQLite file is on one Railway volume. Railway volume backups cost a little (the
  Invertix bill shows $0.94 of backups across the workspace); check that `cloud`'s volume has them.
- **The volume reports 838 MB used** while the database itself is far smaller (see *Database* on the
  admin page). Check what else is on `/data` before it matters.
