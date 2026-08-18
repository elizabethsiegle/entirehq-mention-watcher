# @entirehq mention watcher

Someone replies to `@entirehq` on X. You find out four hours later, because
nobody had that search tab open.

This closes that gap. A background process polls the live `@entirehq` search
and announces every new mention, reply, and quote tweet in two places at once:
the Claude Code terminal you're already working in, and a Slack channel.

```
[14:02:11] NEW MENTION @somedev · reply
  hey @entirehq does this work with self-hosted runners?
  https://x.com/somedev/status/1958000000000000001
```

Slack gets the same thing as a Block Kit message: handle linked to profile, a
kind badge, the text, the permalink, a relative timestamp.

It starts when you open a session in this project and stops when you close it.
No daemon to remember, no dashboard to check, and it costs zero tokens — the
watcher is a plain Node process writing to your terminal, not an agent.

## Status: built and reviewed, not yet run against live X

Every piece of pure logic is covered by 88 tests. **Nothing has touched the
real X or Slack yet** — this was built without the session cookies, so every
step that needed them was written and deliberately left unrun rather than
faked.

`docs/VERIFICATION.md` has the 12-step queue to close that gap, what's already
proven, and three caveats worth reading before you trust a green run.

## Setup

```bash
npm install
cp .env.example .env      # then fill in the five values below
npm run check             # one live scrape, printed, notifies nobody
```

| Variable | Where it comes from |
| --- | --- |
| `BROWSERBASE_API_KEY` | browserbase.com → Settings |
| `BROWSERBASE_PROJECT_ID` | same page |
| `X_AUTH_TOKEN` | a logged-in x.com tab → DevTools → Application → Cookies → `auth_token` |
| `X_CSRF_TOKEN` | same place → `ct0` |
| `SLACK_WEBHOOK_URL` | api.slack.com/apps → your app → Incoming Webhooks |

Optional: `X_WATCH_POLL_MS` (default `300000`), `X_SEARCH_QUERY` (default
`@entirehq`), `X_OWN_HANDLE` (default `entirehq`).

**Why cookies and not the X API.** The live-search tab is login-gated, and X
API v2's recent-search endpoint needs a paid Basic tier (~$200/mo). Two cookies
pasted into `.env` cost nothing and last months. When they expire the watcher
says so loudly — in the terminal and exactly once in Slack — rather than
quietly returning nothing, which would read as "nobody is mentioning us."

## How it works

```
SessionStart hook → spawns watch.mjs (detached, inherits your terminal)
   ↓
   scrape ──→ parse ──→ filter ──→ diff ──→ announce
   Browserbase   X's own    drop our    seen-id     terminal
   + Playwright  JSON       own posts,  store       + Slack
                 (DOM        label
                  fallback)  kind
   ↓
   sleep 5m, repeat
SessionEnd hook → kills it by pid
```

**It reads X's JSON, not the page.** The search page renders from X's own
`SearchTimeline` endpoint, so Playwright intercepts that response instead of
scraping `data-testid` attributes X rotates whenever it likes. Reply and quote
classification then comes from real fields (`in_reply_to_status_id`,
`is_quote_status`) rather than sniffing rendered text for "Replying to". DOM
extraction stays as a labelled fallback, and says so in the terminal when it
fires.

**The first run notifies nobody.** It records everything currently on the page
as a baseline and reports only what appears after. Without that, day one dumps
every existing mention into Slack.

**It won't shut up about being broken.** Silence is indistinguishable from "no
mentions", so three conditions each fire exactly one Slack alert: expired
cookies, a scrape that has been failing long enough to hit the 30-minute
backoff cap, and three consecutive polls returning zero tweets after a
non-empty baseline. Each dedupes through the store, so a restart — or a
`/clear` — doesn't re-alarm.

## Known limitations

- **One page per poll.** A single page load, no scrolling, so roughly X's first
  ~20 results. More mentions than that inside one interval and the overflow is
  missed — not stored, not announced. The watcher prints a note when a poll
  comes back at or above that size, so the ceiling is visible rather than
  silent. A shorter `X_WATCH_POLL_MS` reduces the risk, at the cost of more
  Browserbase sessions. Whether real volume ever approaches this is queue
  item 10.
- **Two sessions share one watcher.** The pid file is per-project, so a second
  session correctly won't start a duplicate — but whichever session closes
  *first* kills it for both, leaving the other silently unwatched. No reference
  counting. Restart by hand with `node scripts/hook-start.mjs`.
- **Automated browsing is contrary to X's terms of service.** Accepted
  knowingly: this watches one account's own brand mentions at low volume.

## Cost

One Browserbase session per poll — about 288/day at the 5-minute default while
you have a session open. `X_WATCH_POLL_MS` is the dial if that matters.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | 88 tests over config, both parsers, filter, store, both notifiers |
| `npm run check` | One live scrape, dry-run, notifies nobody. The health check |
| `node scripts/hook-start.mjs` | Start the watcher by hand (idempotent) |
| `node scripts/hook-stop.mjs` | Stop it |

## Layout

| Path | |
| --- | --- |
| `scripts/config.mjs` | Loads and validates `.env`; native `loadEnvFile`, no dotenv |
| `scripts/x-scrape.mjs` | Browserbase session, cookie injection, JSON interception, DOM fallback |
| `scripts/parse.mjs` | Both payload shapes → normalized records. Pure |
| `scripts/filter.mjs` | Drops our own posts, labels mention/reply/quote. Pure |
| `scripts/store.mjs` | Seen-id cache, 500-id cap, baseline and alert flags. Atomic writes |
| `scripts/notify-terminal.mjs` | ANSI output |
| `scripts/notify-slack.mjs` | Block Kit payload, webhook POST, one retry |
| `scripts/watch.mjs` | The poll loop: backoff, alerting, shutdown |
| `scripts/hook-start.mjs` / `hook-stop.mjs` | Spawn/kill, pid tracked per project |
| `scripts/check.mjs` | The dry run |
| `docs/VERIFICATION.md` | What's proven, what isn't, and how to close it |

Node ≥ 20.12, ESM, two runtime dependencies (`@browserbasehq/sdk`,
`playwright-core`), zero test dependencies — the suite is `node:test`.

`parse`, `filter`, and `store` are pure functions over plain objects. That's
where the logic lives and why it's testable without a network.

## How this was built

Spec → plan → ten TDD tasks, each implemented by one agent and reviewed by
another, with a whole-branch review at the end. The design doc and the
implementation plan are in `docs/superpowers/`, committed before any code was
written.

Review earned its keep. It caught six defects that originated in the plan
itself, including a `node --test` invocation that silently exits 1 on Node 24+,
a Browserbase session leaked on every connect failure (billable), and — the
worst — a store that marked a whole batch of mentions as seen *before*
announcing them, so being killed mid-batch permanently lost the remainder. That
last one defeated the entire purpose of the tool, and it was in the design, not
the implementation.
