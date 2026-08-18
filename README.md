# @entirehq mention watcher

Watches `https://x.com/search?q=%40entirehq&src=typed_query&f=live` and
announces every new mention, reply, and quote tweet in two places: the Claude
Code terminal you're working in, and a Slack channel.

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in all five required values — `.env.example`
   documents where each one comes from.
3. `npm run check` — one live scrape, printed, notifying nobody. If this prints
   tweets, you're set.

## How it runs

A `SessionStart` hook spawns a detached poller; `SessionEnd` kills it. It polls
every 5 minutes by default (`X_WATCH_POLL_MS`), so it only runs while you have
a Claude Code session open in this project.

The first run notifies nothing — it records everything currently on the page as
a baseline, then reports only what appears after that.

## When it stops working

X session cookies expire every few months. The watcher says so loudly, in the
terminal and once in Slack: re-copy `auth_token` and `ct0` from a logged-in
x.com tab into `.env` and restart the session.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests for the parse/filter/store/notify layer (78 tests) |
| `npm run check` | One live scrape, dry-run, notifies nobody |
| `node scripts/hook-start.mjs` | Start the watcher by hand |
| `node scripts/hook-stop.mjs` | Stop it |

## Layout

See `docs/superpowers/specs/2026-08-18-entirehq-mention-watcher-design.md` for
the design and the reasoning behind it.
