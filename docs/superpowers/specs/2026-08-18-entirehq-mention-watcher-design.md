# @entirehq Mention Watcher — Design

Date: 2026-08-18
Status: Approved for planning

## Problem

Replies, tags, and quote tweets aimed at `@entirehq` are only visible by
manually reloading `https://x.com/search?q=%40entirehq&src=typed_query&f=live`.
Conversations worth answering get found late.

## Goal

A background watcher that polls that search, detects tweets it has not seen
before, and announces each one twice: as a line in the Claude Code terminal,
and as a message in Slack.

## Non-goals

- Replying, liking, or otherwise writing to X.
- Watching accounts other than `@entirehq`.
- Any UI beyond terminal output and Slack messages.
- Running when no Claude Code session is open in this project.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Data source | Browserbase + authenticated X session | The live-search tab is login-gated; Browserbase credentials already exist on this machine. The X API v2 search endpoint needs a paid Basic tier. |
| X authentication | `auth_token` + `ct0` cookies injected into the browser context | Driving X's login form hits 2FA, email challenges, and suspicious-activity locks. Cookies are stable for months and fail loudly. |
| Slack delivery | Incoming webhook URL | No OAuth scopes, no app install, one env var. Single channel is sufficient. |
| Claude Code delivery | Detached background process printing to the inherited TTY | Zero token cost, zero Claude API calls. Matches the existing `wimbledon-worldcup-watcher` pattern already installed on this machine. |
| Packaging | Project-local scripts in this repo | The repo exists for this one job; keeping the scraper, differ, and notifiers in the tree makes the work legible. |
| Tweets that notify | Mentions by others, replies, quote tweets | Requested scope. |
| Tweets that do not notify | Posts authored by `@entirehq` | The account already knows what it posted. |

## Architecture

Nine modules under `scripts/`. `parse`, `filter`, and `store` are pure
functions over plain objects — they hold the logic worth testing and need no
network.

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `config.mjs` | Load `.env`, validate required vars, expose config | none (native `process.loadEnvFile()`) |
| `x-scrape.mjs` | Browserbase session, cookie injection, navigation; returns raw payloads | `@browserbasehq/sdk`, `playwright-core`, `config` |
| `parse.mjs` | Raw payload → normalized `Tweet[]`, `kind` left unset | none (pure) |
| `filter.mjs` | Exclude own posts, assign `kind` from the raw reply/quote fields | none (pure) |
| `store.mjs` | Seen-ID cache, diff, baseline, eviction | `node:fs` |
| `notify-terminal.mjs` | ANSI-formatted TTY output | none |
| `notify-slack.mjs` | Block Kit payload → webhook POST | `fetch` |
| `watch.mjs` | Poll loop wiring the above | all of the above |
| `hook-start.mjs` / `hook-stop.mjs` | Spawn/kill detached watcher, PID file | `node:child_process` |

### The `Tweet` record

Every extraction path emits this shape. Nothing downstream knows which path
produced it.

```js
{
  id: '1234567890123456789',      // status id, from the permalink — exact identity
  author: 'somedev',              // screen name, no leading @
  text: 'hey @entirehq does ...',
  url: 'https://x.com/somedev/status/1234567890123456789',
  createdAt: '2026-08-18T14:02:11.000Z',
  kind: 'mention' | 'reply' | 'quote',   // assigned by filter.mjs, not parse.mjs
}
```

`parse.mjs` also carries `inReplyToStatusId` and `isQuoteStatus` through on each
record. `filter.mjs` reads them to assign `kind` and then drops them, so the
records reaching `store` and the notifiers hold exactly the fields above.

## Reading X

**Primary path — GraphQL response interception.** X's search page renders from
its own `SearchTimeline` endpoint. Playwright listens for it:

```
page.on('response') → url matches **/SearchTimeline* → JSON
```

This yields `rest_id`, `full_text`, `screen_name`, `created_at`,
`is_quote_status`, and `in_reply_to_status_id` as real fields. Reply and quote
classification comes from data rather than from sniffing rendered text for
"Replying to".

**Fallback path — DOM extraction.** If no matching response arrives before the
navigation settles, extract from `article[data-testid="tweet"]` elements
instead, and log which path was used. This path is expected to be less
accurate at classifying `kind`; it may label a quote tweet as a plain mention.

`kind` classification:

- `reply` — `in_reply_to_status_id` is present
- `quote` — `is_quote_status` is true and it is not a reply
- `mention` — everything else

## Data flow

```
SessionStart hook → spawn watch.mjs (detached, stdio inherited)
  loop:
    scrape → parse → filter → diff against store
      cold cache?  → mark all seen, print one baseline line, notify nothing
      new tweets?  → print to TTY, POST to Slack, mark seen
    save store → sleep POLL_MS → repeat
SessionEnd hook → kill by PID
```

### Cold-cache baseline

On a first run with no store file, every tweet currently on the page is marked
seen and **nothing is notified**. Output is a single line:

```
tracking 14 existing mentions — watching for new ones
```

Without this rule the first run dumps every existing mention into Slack.

### Store

`<project>/.claude/entirehq-watcher/seen.json`, holding seen IDs in insertion
order, capped at the most recent 500. Older entries are evicted. The PID file
lives beside it at `watch.pid`. The whole directory is gitignored.

## Notification format

Terminal:

```
[14:02:11] NEW MENTION  @somedev · reply
  "hey @entirehq does this work with self-hosted runners?"
  https://x.com/somedev/status/1234567890123456789
```

Slack, via Block Kit: author handle linked to profile, a `kind` badge, the
tweet text, the permalink, and a relative timestamp. One message per tweet.

## Error handling

| Failure | Behavior |
| --- | --- |
| Missing required env var | Print a message naming the missing key and exit `1` without spawning. Exit code `1` is advisory to Claude Code; the hook must never exit `2`, which would block the session from starting. |
| Expired or invalid X cookies — detected by a login-wall redirect or a timeline with zero results where the login form is present | Loud terminal warning **and** exactly one Slack message, then back off to a 30-minute retry. Silent failure is the worst outcome: it reads as "nobody is mentioning us." |
| Browserbase or network failure | Dim log line, keep looping. Exponential backoff on consecutive failures, capped at 30 minutes. Backoff resets on the first success. |
| Slack POST failure | Retry once, then log and continue. The tweet is still marked seen — the terminal already displayed it, and dropping one Slack message beats replaying it every poll forever. |

## Configuration

`.env` in the project root, gitignored:

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `BROWSERBASE_API_KEY` | yes | — | Browserbase auth |
| `BROWSERBASE_PROJECT_ID` | yes | — | Browserbase project |
| `X_AUTH_TOKEN` | yes | — | X session cookie `auth_token` |
| `X_CSRF_TOKEN` | yes | — | X session cookie `ct0` |
| `SLACK_WEBHOOK_URL` | yes | — | Incoming webhook |
| `X_WATCH_POLL_MS` | no | `300000` | Poll interval (5 minutes) |
| `X_SEARCH_QUERY` | no | `@entirehq` | Search term, for reuse |
| `X_OWN_HANDLE` | no | `entirehq` | Screen name whose own posts are filtered out |

One Browserbase session is created per poll — roughly 288 sessions per working
day at the default interval. Raising `X_WATCH_POLL_MS` is the lever if that
cost matters.

## Hook wiring

This project's `.claude/settings.json` gains one entry in each of `SessionStart`
and `SessionEnd`, merged into any existing matcher `""` block rather than
replacing it:

```json
{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/scripts/hook-start.mjs\"" }
{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/scripts/hook-stop.mjs\"" }
```

`hook-start.mjs` is idempotent: if the PID file names a live process, it exits
`0` without spawning a second watcher. No failure in this watcher may exit `2`
from a hook — that return code blocks the Claude Code session itself.

## Testing

Node's built-in `node:test` runner. No test dependencies.

| Suite | Covers |
| --- | --- |
| `parse` | A captured real `SearchTimeline` JSON fixture and a captured HTML fixture, both committed under `test/fixtures/` |
| `filter` | Own-tweet exclusion; `kind` classification for each of mention, reply, quote |
| `store` | Diff of new versus seen; cold-cache baseline returning zero notifications; 500-ID eviction |
| `notify-slack` | Payload shape and failure retry, against a stub HTTP server on localhost |

Manual verification gate: `npm run check` performs one real scrape in dry-run
mode, prints what it found, and notifies nobody. The feature is not complete
until that command has been run against live X and its output confirmed.

## Prerequisites from the user

1. `SLACK_WEBHOOK_URL` — created at api.slack.com/apps for the target channel.
2. `auth_token` and `ct0` cookie values from a logged-in x.com tab
   (DevTools → Application → Cookies → https://x.com).

Browserbase credentials can be copied from
`~/Desktop/demos-2-idk/wimbledon-worldcup-scores/.env`.

## Risks

- **X changes its response shape or selectors.** Mitigated by fixture-based
  tests that fail loudly rather than silently returning zero tweets, and by the
  DOM fallback path.
- **Automated browsing of X is contrary to its terms of service.** Accepted
  knowingly: this monitors the user's own brand mentions at low volume.
- **Cookie expiry.** Handled explicitly above; the failure is announced, never
  silent.
