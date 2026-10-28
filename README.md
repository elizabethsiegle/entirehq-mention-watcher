# @entirehq mention watcher

Someone replies to `@entirehq` on X, or posts a link to entire.io without
tagging anyone. You find out four hours later, because nobody had that search
tab open.

This closes that gap. A daemon polls two live searches every five minutes:
Entire's handle/domain mentions and GitHub outage/reliability discussions.
It triages every new result and posts it to
Slack in one of two shapes so the ones worth acting on do not read like the
rest.

```
★ `REPLY` @HaimantikaM · 17k followers
> Great points! We are also building something for this, would
> love to give you early access.
View on X · not a follower, offers early access · Oct 14 at 11:57 AM

`REPLY` @devsdv_ · @haatifff @neatlogs @EntireHQ Thanks 👍 · open · 172 followers

`CHAIN` 9 more replies in this thread · @Archilyte_, @j3rah_, @catmanyau, +4 · open
```

Priority gets a card and a `★` in the notification text; routine collapses to
one line, and a thread that keeps going collapses to a count. Every line leads with its kind in the same slot (`TWEET`, `REPLY`,
`QUOTE`), so the left edge answers "reply or tweet?" without reading the line.
A post that linked the site without tagging the account reads `linked
entire.io` instead of `replied to @entirehq`, because it did not.
On a live sample of 20 mentions this put 1 in priority and 16 in routine, with
3 muted.

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

Optional: `X_WATCH_POLL_MS` (`300000`), `X_CHAIN_LIMIT` (`3`),
`X_OWN_HANDLE` (`entirehq`),
`X_BRAND_DOMAIN` (`entire.io`), `X_SEARCH_QUERY` (defaults to
`(@entirehq OR "entire.io")`, built from the two above),
`ANTHROPIC_API_KEY`, `X_MUTE_HANDLES`, `X_TEAM_HANDLES`.

`X_GITHUB_SEARCH_QUERY` overrides the separate GitHub search, which defaults to
`("github down" OR "github is down" OR "github goes down" OR (github OR @github OR @githubstatus) (outage OR outages OR downtime OR reliability OR unreliable OR unavailable OR degraded)) -is:retweet`.
Results go to the same Slack webhook with a `GitHub reliability` label. These
are public reports and discussions, not confirmation of an active outage.
The GitHub search also requires GitHub and a reliability term in the tweet's
own text, so a bare GitHub link is insufficient.
GitHub-only results get individual posts even when a thread has exhausted its
routine reply budget. A tweet found by both searches is delivered only once.
On an existing installation, the first poll after this update delivers unseen
GitHub results; a fresh installation still baselines both searches silently.

Config is read once at boot — after editing `.env`, re-run `install-agent`.

The watcher also checks [GitHub's official status summary](https://www.githubstatus.com/api/v2/summary.json)
at the start of every poll, including when auto-replies are off or X scraping
fails. Its current description, affected components, and active incidents are
logged to `watch.log`. This is a public JSON endpoint; no API key is needed.
The check follows the watcher's poll/backoff schedule.

## GitHub outage auto-replies

The watcher can reply to new GitHub outage tweets from `@lizziepika` with exactly:

```text
@goentire is up. entire.com
```

Set `X_REPLY_HANDLE=lizziepika` and choose `X_REPLY_MODE` in `.env`:

- `off` (default): monitoring only.
- `dry-run`: log eligible replies without posting. Uses separate state from live mode.
- `live`: post replies through the existing Browserbase/X browser session.

Run `npm run replies:preview -- --check-composer` to inspect matches and verify
the account and reply composer. This command opens a composer, checks the exact
text, and clears it without clicking Post. It writes no reply state and sends no
Slack messages. If there are no outage matches, it can check the composer on
another search result; that does not make that tweet eligible for a live reply.
Then run `npm run install-agent` to load the chosen mode.

The browser's authenticated account must match `X_REPLY_HANDLE` before every
send. This is separate from `X_OWN_HANDLE`, which still controls brand monitoring.
No additional X API credentials are required.

Before a batch of replies, and again immediately before each Post click, the
bot checks githubstatus.com. It requires an official degraded/outage status,
an affected component, or an investigating/identified incident with nonzero
impact. Normal operation, maintenance alone, or a monitoring/resolved incident
with otherwise healthy services does not authorize a reply. An HTTP error,
timeout, or unexpected response also holds replies. No previous status is reused
after a failed request. Each status request has a 10-second timeout.

This confirms that GitHub reports a current disruption; it does not establish
that a specific tweet describes the same affected service. Tweet matching and
all existing reply exclusions still apply. Held tweets can be reconsidered
within the one-hour freshness window if a disruption is subsequently confirmed.
`replies:preview` shows the official status and how many matches pass this check.
Adding this check does not enable replies: `X_REPLY_MODE=off` remains paused.

Live mode establishes its own baseline on the first successful poll. It skips
the current results and anything created before activation, then considers new
tweets from the last hour. Conservative text patterns match concrete GitHub
outages, downtime, or unavailable/degraded services; they do not prove that an
outage is ongoing. Resolved reports, hypothetical outages, generic reliability
comments, retweets, muted accounts, and the posting/brand accounts are excluded.
DOM fallback records are excluded from replies because they cannot reliably
identify retweets. Slack monitoring still receives those records.

At most three replies are attempted per poll. Rate limits pause all replies for
at least 15 minutes and honor later server reset times; daily posting limits pause
for at least 24 hours. Other failures pause replies for 15 minutes and leave
Slack monitoring running. Tweets older than an hour expire even while waiting.

Reply state lives in `.claude/entirehq-watcher/replies.json`, independently of
Slack's seen IDs. A pending reservation is saved before clicking Post, and only
a response containing a reply ID and the expected parent confirms success.
Unconfirmed sends are held as `unknown` (or `pending` after an interrupted run)
and are never retried automatically. This prevents duplicate attempts but can
leave a reply unsent when a crash occurs just before the click. Reply entries
are retained without eviction; preserve this file across restarts.

An interrupted process can leave `replies.lock` behind. Stop the watcher, verify
the PID in `replies.lock/pid` is no longer running, inspect pending/unknown entries
against the account's replies on X, then remove only the stale lock directory and
restart. Keep the reply ledger; deleting it discards deduplication history.
The watcher logs errors and sends Slack failure alerts.

**Why cookies, not the X API.** Live search is login-gated, and API v2's
recent-search endpoint needs a paid tier (~$200/mo). Two cookies cost nothing
and last months; when they expire the watcher says so in Slack rather than
returning nothing, which would read as "nobody is mentioning us."

## How it works

```
launchd (RunAtLoad, KeepAlive) → watch.mjs
   ↓
   scrape ──→ parse ──→ filter ──→ diff ──→ post to Slack
   Browserbase   X's own    drop our     seen-id     Block Kit
   + Playwright  JSON       own posts,   store       webhook
                 (DOM        label kind
                  fallback)  and match
   ↓
   sleep 5m, repeat
```

- **Claude Code's hooks are a fallback.** `SessionStart`/`SessionEnd` run a
  session-scoped watcher only when no agent is installed for this project. With
  the agent installed they stand down, so notifications never double up.
- **Slack receives monitoring notifications.** Optional auto-replies post to X.
  Nothing prints to your terminal; diagnostics
  go to `.claude/entirehq-watcher/watch.log` — including when Slack is the
  thing that's broken.
- **The handle and the domain are one query, not two polls.** The search is
  `(@entirehq OR "entire.io")`, so a link share with no tag is caught at the
  same cost as before: one Browserbase session per poll. Each mention records
  how it matched (handle, link, or both), and Slack and the classifier both
  read that, since a link share is not addressed to anyone and the author is
  not waiting on a reply.
- **GitHub has a separate search page.** GitHub discussion cannot crowd Entire
  mentions out of the same result page. Both searches must succeed before a
  batch is delivered; a failure uses the existing backoff and Slack alerts.
- **A link is invisible in the tweet text.** X rewrites every URL in
  `full_text` to `t.co`, so the domain can only be matched against the
  expanded URLs in `entities.urls` (the link's display text, on the DOM
  fallback path). Matching the text alone would have found nothing.
- **A thread gets a budget, not a line per reply.** One account thanking
  twelve people one reply at a time is twelve mentions and one thread. The
  first `X_CHAIN_LIMIT` routine mentions from a thread post normally; the rest
  collapse into a single `CHAIN` line naming who is in it. The budget is
  charged in the store and lasts six hours, so a thread that drips in two
  replies per poll cannot restart it every five minutes. Priority is never
  collapsed and never charged: a quiet channel is worth less than one
  actionable mention.
- **Collapsing happens after triage, not before.** The tier has to be known
  first or a real support question could disappear into a count. It costs
  nothing extra: every new mention was already being classified one at a time.
- **Two signals decide the tier, and they answer different questions.** A
  deterministic score measures reach (follower count, whether the author
  already follows `@entirehq`, verified, question, quote vs deep reply,
  switching intent). Claude Haiku reads the text and judges intent. A verdict
  wins whenever the classifier ran: reach does not make an emoji reply worth
  answering. The score decides alone when `ANTHROPIC_API_KEY` is unset or the
  call fails, so an outage degrades the ranking instead of dropping the post.
- **Engagement counts are deliberately unused.** A mention is seen within one
  poll of being posted, when every tweet still reads 0 likes and ~20 views, so
  traction cannot rank anything at the moment the decision has to be made.
  Author reach is known immediately; traction is not.
- **`IGNORE` demotes, it never drops.** A classifier false negative on a real
  support question would be invisible, and silence is the failure this tool
  exists to prevent. Only `X_MUTE_HANDLES` suppresses outright.
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

- **One page per search per poll** — no scrolling, so roughly X's first ~20 results per search.
  Heavier bursts overflow; the watcher logs a note when a poll comes back that
  full. Shorter `X_WATCH_POLL_MS` reduces the risk at the cost of more sessions.
  Both terms share that one page, so a burst of replies to the account can
  crowd out a link share posted in the same window. A live check on Oct 17
  came back 20 of 20 full, 19 of them replies in one tag chain.
- **A link match is only as good as X's index.** The domain is searched as a
  quoted phrase, so a post that writes "entire dot io", links a shortener, or
  embeds the URL in an image is not found. Neither is one whose link X has
  not indexed yet.
- **A collapsed reply is never shown again.** The `CHAIN` line is its only
  delivery: it is marked seen once that line lands, so the text of a routine
  reply past the budget lives on X and nowhere else. The thread link is in the
  line for exactly that reason.
- **Threads are only groupable on the JSON path.** `conversation_id_str` does
  not exist in the rendered page, so under the DOM fallback a chain is grouped
  by author instead. One account replying repeatedly still collapses; three
  accounts piling into one thread do not.
- **Muting is by handle, not by person.** `X_OWN_HANDLE` drops the brand
  account, `X_MUTE_HANDLES` drops named accounts entirely, and
  `X_TEAM_HANDLES` pins teammates to the routine tier (their replies are a
  receipt, not a call to action).
- **One agent per machine** — the launchd label is fixed. A second checkout
  sees the plist names a different project and falls back to its hooks.
- **Automated browsing is contrary to X's ToS** — accepted knowingly, for one
  account's own brand mentions at low volume.

## Commands

| Command | What it does |
| --- | --- |
| `npm run install-agent` | Install and start the daemon (idempotent) |
| `npm run uninstall-agent` | Stop and remove it; hooks take over again |
| `npm run preview` | Triages both live searches and prints the tiers. Posts nothing |
| `npm run replies:preview -- --check-composer` | Preview outage replies and check the X composer without posting |
| `npm run check` | Both live searches, dry-run, notifies nobody |
| `npm test` | Tests config, parsers, search delivery, filter, store, notifiers, launchd, triage, chains |
| `tail -f .claude/entirehq-watcher/watch.log` | What the daemon is doing |

Two Browserbase sessions per poll — 576/day at the default. One Haiku call per *new* mention
(not per poll), so classifier spend tracks mention volume, not uptime: tens of
calls a day at current volume, cents a month.

## Layout

| Path | |
| --- | --- |
| `scripts/config.mjs` | Loads and validates `.env`; native `loadEnvFile` |
| `scripts/x-scrape.mjs` | Browserbase session, cookies, JSON interception, DOM fallback |
| `scripts/search.mjs` | Separate Entire and GitHub searches, with source attribution |
| `scripts/reply-match.mjs` | Outage matching, freshness, exclusions, and exact reply text |
| `scripts/github-status.mjs` | Public githubstatus.com summary and current-disruption confirmation |
| `scripts/replies.mjs` | Independent reply ledger, baseline, locking, and retry scheduling |
| `scripts/x-reply.mjs` | Verified posting account, browser composer, and send confirmation |
| `scripts/parse.mjs` | Both payload shapes → normalized records. Pure |
| `scripts/filter.mjs` | Drops our own posts, labels mention/reply/quote and handle/link. Pure |
| `scripts/store.mjs` | Seen-id cache, 500-id cap, baseline and alert flags |
| `scripts/score.mjs` | Deterministic reach/shape score and handle lists. Pure |
| `scripts/classify.mjs` | Claude Haiku intent triage; resolves, never throws |
| `scripts/tier.mjs` | Combines score and verdict into a tier. Pure |
| `scripts/chain.mjs` | Groups a batch by thread and spends the per-thread budget. Pure |
| `scripts/notify-slack.mjs` | Tiered Block Kit payloads, webhook POST, one retry |
| `scripts/preview.mjs` | Dry-run triage of one live scrape |
| `scripts/notify-terminal.mjs` | ANSI output — `check.mjs` only |
| `scripts/watch.mjs` | The poll loop: backoff, alerting, logging, shutdown |
| `scripts/launchd.mjs` | Plist generation, per-project ownership check. Pure |
| `scripts/install-agent.mjs` / `uninstall-agent.mjs` | Daemon lifecycle |
| `scripts/hook-start.mjs` / `hook-stop.mjs` | Session-scoped fallback |

Node ≥ 20.12, ESM, three runtime dependencies (`@browserbasehq/sdk`,
`playwright-core`, `@anthropic-ai/sdk`), zero test dependencies — the suite is
`node:test`. `parse`, `filter`, `store`, `launchd`, `score`, and `tier` are
pure functions, which is why the logic is testable without a network.

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

The first live run of the triage did the same. With `tool_choice: auto` about
one Haiku call in six answered in prose instead of calling the tool, and
letting a high score override an explicit `ROUTINE` verdict put eleven
emoji-only tag-chain replies from a single account into priority. Forcing the
tool call and letting the verdict win took priority from 13 of 20 to 1 of 20.
