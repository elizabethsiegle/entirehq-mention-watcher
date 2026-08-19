# Outstanding verification

> **Superseded 2026-08-18.** The live gap described below is closed. The
> pipeline has since run end to end against real X and real Slack: a scrape of
> 40 tweets via the JSON path, delivered to `#entirehq-x-mentions`, from the
> launchd daemon in its production configuration. The suite is now 97 tests.
> This document is kept as the record of what was outstanding at the time.

Everything in this repo passes 88 unit tests, but **nothing has ever run against
live X or Slack.** The three secrets below were unavailable while the feature was
built, so every step that needs them was deliberately written and left unrun
rather than faked.

Fill these in `.env` (already gitignored; `.env.example` documents each):

```
X_AUTH_TOKEN=          # x.com tab -> DevTools -> Application -> Cookies -> auth_token
X_CSRF_TOKEN=          # same place -> ct0
SLACK_WEBHOOK_URL=     # api.slack.com/apps -> your app -> Incoming Webhooks
```

`BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` are already set.

## What IS verified

- All pure logic: config, both parse paths, filter, store, and both notifiers —
  88 tests, several of them mutation-checked (the test was proven to fail when
  the behaviour it guards was deliberately broken).
- Hook lifecycle: `hook-start` exits 0 and writes the pid file; `hook-stop`
  exits 0, removes it, and is safe when nothing is running; the `isRunning`
  idempotence guard was proven with a live dummy process; no code path can
  exit 2 (which would block a Claude Code session from starting).
- Config failure: a missing secret names the exact variables and exits 1.
- Terminal delivery mechanism: a detached child's output reached the terminal
  through the hook's inherited file descriptors. See caveat 1 below.

## Queue

Run in order; each builds on the last.

| # | Step | Expected |
| --- | --- | --- |
| 1 | `npm run check` | `extraction path: json`, a nonzero tweet count, formatted tweets, exit 0 |
| 2 | Capture a real `SearchTimeline` payload and add a test parsing it | The committed fixture is hand-built from the documented shape and has **never** been checked against a real response |
| 3 | Confirm `parse.mjs`'s assumed JSON shape matches X's current response | Both user-shape variants and the `TweetWithVisibilityResults` envelope still parse |
| 4 | Exercise login-wall detection and the DOM fallback against real markup | The fallback path and `detectLoginWall` have never seen real X HTML |
| 5 | `X_WATCH_POLL_MS=20000 node scripts/watch.mjs` | Started line, then `tracking N existing mentions`; **nothing** in Slack; a second poll prints `no new mentions`; Ctrl-C stops cleanly |
| 6 | Post a mention of @entirehq from another account | It appears in the terminal **and** in Slack. This is the whole feature |
| 7 | `X_AUTH_TOKEN=deliberately-invalid` for several polls, across a `/clear` | Exactly **one** Slack alert total, not one per poll and not one per session start |
| 8 | Two `hook-start` runs with a live watcher | `pgrep -f "scripts/watch.mjs" \| wc -l` is 1; `hook-stop` leaves 0 |
| 9 | Watch the Browserbase dashboard across several polls | Sessions are released, not accumulating. On the success path release relies on `browser.close()` — an assumption, not a verified fact. A leak here costs money |
| 10 | Measure the tweets returned per poll | Establishes whether the one-page ceiling (see README "Known limitations") is close to real volume, and so whether pagination is worth building |
| 11 | Slack burst behaviour | More than one message per second, and a 429 with `Retry-After`. `postToSlack` retries once after a flat 1s then drops the message |
| 12 | Browserbase quota/cost at ~288 sessions/day | Confirm the monthly spend is acceptable and that quota exhaustion produces the intended Slack alert |

## Caveats found by review, worth knowing before you trust a green run

1. **The terminal-delivery proof is not airtight.** It was obtained by running
   `hook-start` from a shell, which has a different file-descriptor topology
   than a real `SessionStart` hook — whose stdout may be captured rather than
   shown. Step 6 is what actually settles it. If watcher output turns out to be
   captured into session context rather than printed, that also breaks the
   design's zero-token-cost premise and the delivery mechanism needs rethinking.
2. **A `/clear` cycle is a full kill and respawn.** Steps 7 and 8 should be run
   across one, not just within a single continuous process.
3. **Two concurrent sessions share one watcher**, and whichever closes first
   kills it for both. Documented in the README; no reference counting exists.

## Parked, known, and deliberate

Recorded so nobody mistakes them for oversights:

- A stale `.seen.json.*.tmp` can be left behind if a disk write fails. Inert,
  in a gitignored directory.
- On a doubly-failing poll (error *and* a throwing browser close), the session
  release is called twice. `REQUEST_RELEASE` is idempotent.
- `parseTimelineJson` dedupes within one payload but not across two intercepted
  responses, so the displayed "tracking N" count can read high. `diffSeen`
  dedupes before anything is announced, so notifications are unaffected.
- The backoff-cap Slack alert fires on the first failure if `X_WATCH_POLL_MS` is
  set to 30 minutes or more.
- The DOM fallback cannot recover a real parent status id, so it marks replies
  with an `unknown` sentinel and classifies quote tweets by a structural
  heuristic rather than a real field.
