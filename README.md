# @entirehq mention watcher

Someone replies to `@entirehq` on X. You find out four hours later, because
nobody had that search tab open.

This closes that gap. A daemon polls the live `@entirehq` search every five
minutes and posts every new mention, reply, and quote tweet to Slack, each one
led by a Claude-scored urgency number so the channel can triage before reading.

```
🔴 91 · now · possible outage, checkpoints not saving
@somedev replied to @entirehq
> is @entirehq down? my checkpoints stopped saving an hour ago
View on X · reply · Aug 18 at 5:17 PM
```

It runs as a launchd agent — at login, across reboots, restarted if it dies,
independent of whether Claude Code is open. A plain Node process posting to a
webhook, not an agent: the only tokens it spends are one small Claude call per
new mention for the score, and it runs fine with scoring switched off.

## Setup

```bash
npm install
cp .env.example .env       # fill in the five values below
npm run check              # one live scrape, printed, notifies nobody
npm run check-score        # four sample mentions scored, no scrape needed
npm run install-agent      # install + start the daemon
```

| Variable | Where it comes from |
| --- | --- |
| `BROWSERBASE_API_KEY` | browserbase.com → Settings |
| `BROWSERBASE_PROJECT_ID` | same page |
| `X_AUTH_TOKEN` | logged-in x.com tab → DevTools → Application → Cookies → `auth_token` |
| `X_CSRF_TOKEN` | same place → `ct0` |
| `SLACK_WEBHOOK_URL` | api.slack.com/apps → your app → Incoming Webhooks |

Optional: `ANTHROPIC_API_KEY` (console.anthropic.com → API keys; without it
mentions post unscored), `X_WATCH_POLL_MS` (`300000`), `X_SEARCH_QUERY`
(`@entirehq`), `X_OWN_HANDLE` (`entirehq`), `X_SCORE_TWEETS` (`true`),
`X_SCORE_MODEL` (`claude-opus-5`).

Config is read once at boot — after editing `.env`, re-run `install-agent`.

**Why cookies, not the X API.** Live search is login-gated, and API v2's
recent-search endpoint needs a paid tier (~$200/mo). Two cookies cost nothing
and last months; when they expire the watcher says so in Slack rather than
returning nothing, which would read as "nobody is mentioning us."

## How it works

```
launchd (RunAtLoad, KeepAlive) → watch.mjs
   ↓
   scrape ──→ parse ──→ filter ──→ diff ──→ score ──→ post to Slack
   Browserbase   X's own    drop our    seen-id   Claude     Block Kit
   + Playwright  JSON       own posts,  store     0-100      webhook
                 (DOM        label                urgency
                  fallback)  kind                 + reason
   ↓
   sleep 5m, repeat
```

- **Claude Code's hooks are a fallback.** `SessionStart`/`SessionEnd` run a
  session-scoped watcher only when no agent is installed for this project. With
  the agent installed they stand down, so notifications never double up.
- **Slack is the only channel.** Nothing prints to your terminal; diagnostics
  go to `.claude/entirehq-watcher/watch.log` — including when Slack is the
  thing that's broken.
- **The score leads, and it is advisory.** One Claude call per new mention
  returns a 0-100 urgency plus a short reason, rendered above the tweet in the
  Slack message and in the notification preview. Bands are ours, not the
  model's: 85+ `now`, 60+ `today`, 35+ `this week`, 10+ `fyi`, below that
  `noise`, so the same number always reads the same way. A failed, refused, or
  off-schema score never delays or blocks the mention: it posts unscored and
  the reason lands in the log. The tweet is fenced and labelled as untrusted
  data in the prompt, so a mention that tells the model to score itself 0 does
  not get to. `npm run check-score` includes that injection attempt as a live
  sample and fails if it scores 60 or above.
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
- **The score is one model's read of one tweet** — no thread, no author
  history, no follower count. Treat it as triage order, not truth, and check
  the log line if a number looks wrong: it records the reason the model gave.
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
| `npm run check-score` | Scores four sample mentions, no Browserbase or cookies needed |
| `npm test` | 129 tests: config, both parsers, filter, store, scoring, notifiers, launchd |
| `tail -f .claude/entirehq-watcher/watch.log` | What the daemon is doing |

One Browserbase session per poll — 288/day at the default, now continuous
rather than only while an editor is open. Scoring adds one Claude call per new
mention (not per poll), roughly 500 input and 40 output tokens each.

## Layout

| Path | |
| --- | --- |
| `scripts/config.mjs` | Loads and validates `.env`; native `loadEnvFile` |
| `scripts/x-scrape.mjs` | Browserbase session, cookies, JSON interception, DOM fallback |
| `scripts/parse.mjs` | Both payload shapes → normalized records. Pure |
| `scripts/filter.mjs` | Drops our own posts, labels mention/reply/quote. Pure |
| `scripts/store.mjs` | Seen-id cache, 500-id cap, baseline and alert flags |
| `scripts/score.mjs` | Claude urgency score, structured output, score bands. Pure apart from the call |
| `scripts/notify-slack.mjs` | Block Kit payload, webhook POST, one retry |
| `scripts/notify-terminal.mjs` | ANSI output — `check.mjs` only |
| `scripts/watch.mjs` | The poll loop: backoff, alerting, logging, shutdown |
| `scripts/launchd.mjs` | Plist generation, per-project ownership check. Pure |
| `scripts/install-agent.mjs` / `uninstall-agent.mjs` | Daemon lifecycle |
| `scripts/hook-start.mjs` / `hook-stop.mjs` | Session-scoped fallback |

Node ≥ 20.12, ESM, three runtime dependencies (`@browserbasehq/sdk`,
`playwright-core`, `@anthropic-ai/sdk`), zero test dependencies — the suite is
`node:test`.
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
