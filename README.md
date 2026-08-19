# @entirehq mention watcher

Someone replies to `@entirehq` on X. You find out four hours later, because
nobody had that search tab open.

This closes that gap. A daemon polls the live `@entirehq` search every five
minutes and posts every new mention, reply, and quote tweet to Slack.

```
@somedev replied to @entirehq
> hey @entirehq does this work with self-hosted runners?
View on X · reply · Aug 18 at 5:17 PM
```

It runs as a launchd agent — at login, across reboots, restarted if it dies,
independent of whether Claude Code is open. Zero tokens: a plain Node process
posting to a webhook, not an agent.

## Setup

```bash
npm install
cp .env.example .env       # fill in the five values below
npm run check              # one live scrape, printed, notifies nobody
npm run install-agent      # install + start the daemon
```

| Variable | Where it comes from |
| --- | --- |
| `BROWSERBASE_API_KEY` | browserbase.com → Settings |
| `BROWSERBASE_PROJECT_ID` | same page |
| `X_AUTH_TOKEN` | logged-in x.com tab → DevTools → Application → Cookies → `auth_token` |
| `X_CSRF_TOKEN` | same place → `ct0` |
| `SLACK_WEBHOOK_URL` | api.slack.com/apps → your app → Incoming Webhooks |

Optional: `X_WATCH_POLL_MS` (`300000`), `X_SEARCH_QUERY` (`@entirehq`),
`X_OWN_HANDLE` (`entirehq`).

Config is read once at boot — after editing `.env`, re-run `install-agent`.

**Why cookies, not the X API.** Live search is login-gated, and API v2's
recent-search endpoint needs a paid tier (~$200/mo). Two cookies cost nothing
and last months; when they expire the watcher says so in Slack rather than
returning nothing, which would read as "nobody is mentioning us."

## How it works

```
launchd (RunAtLoad, KeepAlive) → watch.mjs
   ↓
   scrape ──→ parse ──→ filter ──→ diff ──→ post to Slack
   Browserbase   X's own    drop our    seen-id     Block Kit
   + Playwright  JSON       own posts,  store       webhook
                 (DOM        label
                  fallback)  kind
   ↓
   sleep 5m, repeat
```

- **Claude Code's hooks are a fallback.** `SessionStart`/`SessionEnd` run a
  session-scoped watcher only when no agent is installed for this project. With
  the agent installed they stand down, so notifications never double up.
- **Slack is the only channel.** Nothing prints to your terminal; diagnostics
  go to `.claude/entirehq-watcher/watch.log` — including when Slack is the
  thing that's broken.
- **It reads X's JSON, not the page.** Playwright intercepts the
  `SearchTimeline` response instead of scraping `data-testid` attributes X
  rotates at will. Reply/quote classification uses real fields
  (`in_reply_to_status_id`, `is_quote_status`). DOM extraction is a labelled
  fallback.
- **Seen only once Slack accepts it.** Marking a failed post as seen would drop
  that mention permanently and silently; a failure costs one duplicate attempt
  next poll instead.
- **The first run notifies nobody.** It baselines whatever is already on the
  page, or day one dumps every existing mention into Slack.
- **It won't shut up about being broken.** Expired cookies, scrapes stuck at
  the 30-minute backoff cap, and three consecutive empty polls each fire
  exactly one Slack alert, deduped through the store so restarts don't
  re-alarm.

## Known limitations

- **One page per poll** — no scrolling, so roughly X's first ~20 results.
  Heavier bursts overflow; the watcher logs a note when a poll comes back that
  full. Shorter `X_WATCH_POLL_MS` reduces the risk at the cost of more sessions.
- **`X_OWN_HANDLE` suppresses one account** — teammates' personal replies do
  notify.
- **One agent per machine** — the launchd label is fixed. A second checkout
  sees the plist names a different project and falls back to its hooks.
- **Automated browsing is contrary to X's ToS** — accepted knowingly, for one
  account's own brand mentions at low volume.

## Commands

| Command | What it does |
| --- | --- |
| `npm run install-agent` | Install and start the daemon (idempotent) |
| `npm run uninstall-agent` | Stop and remove it; hooks take over again |
| `npm run check` | One live scrape, dry-run, notifies nobody |
| `npm test` | 97 tests: config, both parsers, filter, store, notifiers, launchd |
| `tail -f .claude/entirehq-watcher/watch.log` | What the daemon is doing |

One Browserbase session per poll — 288/day at the default, now continuous
rather than only while an editor is open.

## Layout

| Path | |
| --- | --- |
| `scripts/config.mjs` | Loads and validates `.env`; native `loadEnvFile` |
| `scripts/x-scrape.mjs` | Browserbase session, cookies, JSON interception, DOM fallback |
| `scripts/parse.mjs` | Both payload shapes → normalized records. Pure |
| `scripts/filter.mjs` | Drops our own posts, labels mention/reply/quote. Pure |
| `scripts/store.mjs` | Seen-id cache, 500-id cap, baseline and alert flags |
| `scripts/notify-slack.mjs` | Block Kit payload, webhook POST, one retry |
| `scripts/notify-terminal.mjs` | ANSI output — `check.mjs` only |
| `scripts/watch.mjs` | The poll loop: backoff, alerting, logging, shutdown |
| `scripts/launchd.mjs` | Plist generation, per-project ownership check. Pure |
| `scripts/install-agent.mjs` / `uninstall-agent.mjs` | Daemon lifecycle |
| `scripts/hook-start.mjs` / `hook-stop.mjs` | Session-scoped fallback |

Node ≥ 20.12, ESM, two runtime dependencies (`@browserbasehq/sdk`,
`playwright-core`), zero test dependencies — the suite is `node:test`.
`parse`, `filter`, `store`, and `launchd` are pure functions, which is why the
logic is testable without a network.

## How this was built

Spec → plan → ten TDD tasks, each implemented by one agent and reviewed by
another. Design doc and plan are in `docs/superpowers/`, committed before any
code was written.

Review caught six defects that originated in the plan itself — a `node --test`
invocation that silently exits 1 on Node 24+, a Browserbase session leaked on
every connect failure (billable), and a store that marked a batch seen *before*
announcing it, losing the remainder if killed mid-batch.

The first live run exposed the one thing no test could: the watcher had never
actually run. It only existed while a Claude Code session was open — which is
what the launchd agent replaced.
