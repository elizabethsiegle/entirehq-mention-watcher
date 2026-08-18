# @entirehq Mention Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A background watcher that polls the `@entirehq` live search on X and announces each previously-unseen tweet in the Claude Code terminal and in Slack.

**Architecture:** A detached Node process, spawned by a `SessionStart` hook and killed by `SessionEnd`, polls X through a Browserbase-hosted browser authenticated with injected session cookies. Each poll intercepts X's own `SearchTimeline` JSON response (falling back to DOM extraction), normalizes it to `Tweet` records, filters out `@entirehq`'s own posts, diffs against a local seen-ID store, and pushes anything new to the inherited TTY and a Slack incoming webhook. The parse/filter/store layer is pure functions over plain objects and is fully unit-tested; the browser layer is verified by a live dry-run command.

**Tech Stack:** Node.js ≥ 20.12 (ESM), `@browserbasehq/sdk`, `playwright-core`, `node:test`, Slack incoming webhooks. No test dependencies, no dotenv (Node's native `process.loadEnvFile()`).

**Spec:** `docs/superpowers/specs/2026-08-18-entirehq-mention-watcher-design.md`

## Global Constraints

These apply to every task. Values are copied verbatim from the spec.

- **Node ≥ 20.12** — required for `process.loadEnvFile()`. Target machine runs v26.0.0.
- **ESM only.** `package.json` sets `"type": "module"`; every file uses `import`, never `require`.
- **No test dependencies.** Tests use the built-in `node:test` runner and `node:assert/strict`. The runner is invoked as `node --test "test/**/*.test.mjs"` — passing a bare directory (`node --test test/`) does not auto-discover on Node 24/26; it tries to import the directory and exits 1. Do not add jest, vitest, mocha, chai, or sinon.
- **Runtime dependencies are exactly two:** `@browserbasehq/sdk` and `playwright-core`. Do not add dotenv, axios, node-fetch, cheerio, or jsdom.
- **A hook must never exit `2`.** Exit code `2` blocks the Claude Code session from starting. Missing config exits `1`; every other hook path exits `0`.
- **Environment variable names, exactly:** `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `X_AUTH_TOKEN`, `X_CSRF_TOKEN`, `SLACK_WEBHOOK_URL` (all required); `X_WATCH_POLL_MS` (default `300000`), `X_SEARCH_QUERY` (default `@entirehq`), `X_OWN_HANDLE` (default `entirehq`) (all optional).
- **`MAX_SEEN = 500`** — the seen-ID store keeps the 500 most recent IDs.
- **The store carries an explicit `baselined` boolean.** Baseline state is never inferred from `seen.length === 0`.
- **Data directory:** `<project>/.claude/entirehq-watcher/`, holding `seen.json` and `watch.pid`. Already gitignored.
- **`@entirehq`'s own posts never notify.** Mentions, replies, and quote tweets by others do.
- **Cold cache notifies nothing** — it establishes a baseline.
- **Handles are stored without a leading `@`** everywhere in code; the `@` is added only at display time.

## Deviations from the spec

One, deliberate, recorded here so the plan and the spec do not disagree
silently:

- The spec's testing table calls for "a captured HTML fixture" for the DOM
  fallback. This plan instead extracts records **inside the browser** via
  `page.$$eval` and unit-tests the pure function over that extracted array
  (`test/fixtures/dom-records.json`). It reaches the same guarantee without
  adding an HTML-parser dependency, which the Global Constraints forbid. The
  browser-side extractor itself is thin and is covered by `npm run check`
  rather than by a unit test.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `package.json` | Deps, `"type": "module"`, `test`/`check` scripts |
| `.env.example` | Documents every variable; committed. `.env` itself is gitignored |
| `scripts/config.mjs` | Load `.env`, validate, expose config object |
| `scripts/parse.mjs` | Raw payloads → `RawTweet[]`. Pure |
| `scripts/filter.mjs` | Drop own posts, assign `kind` → `Tweet[]`. Pure |
| `scripts/store.mjs` | Seen-ID load/save/diff/evict |
| `scripts/notify-terminal.mjs` | ANSI-formatted TTY output |
| `scripts/notify-slack.mjs` | Block Kit payload + webhook POST with one retry |
| `scripts/x-scrape.mjs` | Browserbase session, cookie injection, response interception, DOM fallback |
| `scripts/check.mjs` | One live scrape, dry-run, notifies nobody |
| `scripts/watch.mjs` | Poll loop, backoff, cookie-expiry handling |
| `scripts/hook-start.mjs` | Spawn detached watcher, write PID file, idempotent |
| `scripts/hook-stop.mjs` | SIGTERM the PID, remove PID file |
| `test/*.test.mjs` | One suite per pure module |
| `test/fixtures/` | Captured X payloads |

### Shared record shapes

Every task depends on these two shapes. `RawTweet` is what `parse` emits; `Tweet` is what `filter` emits and everything downstream consumes.

```js
// RawTweet — parse.mjs output. No `kind`.
{
  id: '1958000000000000001',        // string, X status id
  author: 'somedev',                // screen name, no leading @
  text: 'hey @entirehq does ...',
  url: 'https://x.com/somedev/status/1958000000000000001',
  createdAt: '2026-08-18T14:02:11.000Z',  // ISO 8601
  inReplyToStatusId: null,          // string | null
  isQuoteStatus: false,             // boolean
}

// Tweet — filter.mjs output. `kind` added, the two raw fields dropped.
{
  id, author, text, url, createdAt,
  kind: 'mention' | 'reply' | 'quote',
}
```

---

### Task 1: Project scaffolding and config

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `scripts/config.mjs`
- Test: `test/config.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `loadConfig(env)` → config object. `env` defaults to `process.env`. Throws `ConfigError` when required vars are missing.
  - `class ConfigError extends Error` with a `missing` array property listing the absent variable names.
  - `loadEnvFile(projectDir)` → reads `<projectDir>/.env` into `process.env` if the file exists; silently does nothing if it doesn't.
  - `getProjectDir()` → `process.env.CLAUDE_PROJECT_DIR || process.cwd()`
  - `getDataDir()` → `<projectDir>/.claude/entirehq-watcher`
  - Config object shape: `{ browserbaseApiKey, browserbaseProjectId, xAuthToken, xCsrfToken, slackWebhookUrl, pollMs, searchQuery, ownHandle, searchUrl }`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "entirehq-mention-watcher",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Watches the @entirehq live search on X and announces new mentions in the Claude Code terminal and Slack.",
  "scripts": {
    "test": "node --test \"test/**/*.test.mjs\"",
    "check": "node scripts/check.mjs"
  },
  "dependencies": {
    "@browserbasehq/sdk": "^2.15.0",
    "playwright-core": "^1.61.1"
  },
  "engines": {
    "node": ">=20.12"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` written, no errors. `node_modules/` is already gitignored.

- [ ] **Step 3: Create `.env.example`**

```bash
# Browserbase — copy from ~/Desktop/demos-2-idk/wimbledon-worldcup-scores/.env
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=

# X session cookies. In a logged-in x.com tab:
#   DevTools -> Application -> Cookies -> https://x.com
# Copy the values of `auth_token` and `ct0`.
X_AUTH_TOKEN=
X_CSRF_TOKEN=

# Slack incoming webhook for the channel that should receive mentions.
# Create at https://api.slack.com/apps -> Incoming Webhooks
SLACK_WEBHOOK_URL=

# Optional
X_WATCH_POLL_MS=300000
X_SEARCH_QUERY=@entirehq
X_OWN_HANDLE=entirehq
```

- [ ] **Step 4: Write the failing test**

Create `test/config.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../scripts/config.mjs';

const complete = {
  BROWSERBASE_API_KEY: 'bb_live_abc',
  BROWSERBASE_PROJECT_ID: 'proj_123',
  X_AUTH_TOKEN: 'auth_abc',
  X_CSRF_TOKEN: 'ct0_abc',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
};

test('loadConfig maps every required variable', () => {
  const cfg = loadConfig(complete);
  assert.equal(cfg.browserbaseApiKey, 'bb_live_abc');
  assert.equal(cfg.browserbaseProjectId, 'proj_123');
  assert.equal(cfg.xAuthToken, 'auth_abc');
  assert.equal(cfg.xCsrfToken, 'ct0_abc');
  assert.equal(cfg.slackWebhookUrl, 'https://hooks.slack.com/services/T/B/X');
});

test('loadConfig applies documented defaults', () => {
  const cfg = loadConfig(complete);
  assert.equal(cfg.pollMs, 300000);
  assert.equal(cfg.searchQuery, '@entirehq');
  assert.equal(cfg.ownHandle, 'entirehq');
});

test('loadConfig honours overrides and strips @ from the handle', () => {
  const cfg = loadConfig({ ...complete, X_WATCH_POLL_MS: '60000', X_OWN_HANDLE: '@EntireHQ' });
  assert.equal(cfg.pollMs, 60000);
  assert.equal(cfg.ownHandle, 'entirehq');
});

test('loadConfig builds the live-search URL from the query', () => {
  const cfg = loadConfig({ ...complete, X_SEARCH_QUERY: '@entirehq' });
  assert.equal(
    cfg.searchUrl,
    'https://x.com/search?q=%40entirehq&src=typed_query&f=live',
  );
});

test('loadConfig throws ConfigError naming every missing variable', () => {
  const { X_AUTH_TOKEN, SLACK_WEBHOOK_URL, ...partial } = complete;
  assert.throws(
    () => loadConfig(partial),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.deepEqual(err.missing.sort(), ['SLACK_WEBHOOK_URL', 'X_AUTH_TOKEN']);
      assert.match(err.message, /X_AUTH_TOKEN/);
      return true;
    },
  );
});

test('loadConfig treats blank strings as missing', () => {
  assert.throws(() => loadConfig({ ...complete, X_CSRF_TOKEN: '   ' }), ConfigError);
});

test('loadConfig rejects a non-numeric poll interval', () => {
  assert.throws(
    () => loadConfig({ ...complete, X_WATCH_POLL_MS: 'soon' }),
    /X_WATCH_POLL_MS/,
  );
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../scripts/config.mjs'`

- [ ] **Step 6: Write the implementation**

Create `scripts/config.mjs`:

```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED = [
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'X_AUTH_TOKEN',
  'X_CSRF_TOKEN',
  'SLACK_WEBHOOK_URL',
];

export class ConfigError extends Error {
  constructor(missing) {
    super(
      `Missing required environment ${missing.length === 1 ? 'variable' : 'variables'}: ${missing.join(', ')}\n` +
        `Add them to .env in the project root — see .env.example for where each value comes from.`,
    );
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

// Claude Code sets CLAUDE_PROJECT_DIR for hook commands. Falling back to cwd
// keeps the scripts runnable by hand.
export function getProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function getDataDir(projectDir = getProjectDir()) {
  return join(projectDir, '.claude', 'entirehq-watcher');
}

export function loadEnvFile(projectDir = getProjectDir()) {
  const envPath = join(projectDir, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

function present(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !present(env[key]));
  if (missing.length) throw new ConfigError(missing);

  const pollRaw = present(env.X_WATCH_POLL_MS) ? env.X_WATCH_POLL_MS.trim() : '300000';
  const pollMs = Number(pollRaw);
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(`X_WATCH_POLL_MS must be a positive number of milliseconds, got: ${pollRaw}`);
  }

  const searchQuery = present(env.X_SEARCH_QUERY) ? env.X_SEARCH_QUERY.trim() : '@entirehq';
  const ownHandle = (present(env.X_OWN_HANDLE) ? env.X_OWN_HANDLE.trim() : 'entirehq')
    .replace(/^@/, '')
    .toLowerCase();

  return {
    browserbaseApiKey: env.BROWSERBASE_API_KEY.trim(),
    browserbaseProjectId: env.BROWSERBASE_PROJECT_ID.trim(),
    xAuthToken: env.X_AUTH_TOKEN.trim(),
    xCsrfToken: env.X_CSRF_TOKEN.trim(),
    slackWebhookUrl: env.SLACK_WEBHOOK_URL.trim(),
    pollMs,
    searchQuery,
    ownHandle,
    searchUrl: `https://x.com/search?q=${encodeURIComponent(searchQuery)}&src=typed_query&f=live`,
  };
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .env.example scripts/config.mjs test/config.test.mjs
git commit -m "feat: project scaffolding and config loading"
```

---

### Task 2: Parse the SearchTimeline JSON payload

**Files:**
- Create: `scripts/parse.mjs`
- Create: `test/fixtures/search-timeline.json`
- Test: `test/parse-json.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `parseTimelineJson(payload)` → `RawTweet[]` (shape defined in **Shared record shapes** above). Pure — no I/O, no date-of-today dependence.

**Background you need:** X's search page fetches `https://x.com/i/api/graphql/<hash>/SearchTimeline?...`. The response nests tweets several layers deep, and X has shipped two different user shapes over the past year — the screen name lives at either `core.user_results.result.core.screen_name` or `core.user_results.result.legacy.screen_name`. Some entries are also wrapped in a `TweetWithVisibilityResults` envelope, which puts the real tweet at `result.tweet`. The parser must survive all three variations, and must skip anything it cannot read rather than throwing.

- [ ] **Step 1: Create the fixture**

Create `test/fixtures/search-timeline.json`. This is a hand-built fixture covering the four cases that matter: a plain mention, a reply, a quote tweet, a post by `@entirehq` itself, plus one unreadable entry and one non-tweet cursor entry that must both be skipped.

```json
{
  "data": {
    "search_by_raw_query": {
      "search_timeline": {
        "timeline": {
          "instructions": [
            {
              "type": "TimelineAddEntries",
              "entries": [
                {
                  "entryId": "tweet-1958000000000000001",
                  "content": {
                    "entryType": "TimelineTimelineItem",
                    "itemContent": {
                      "tweet_results": {
                        "result": {
                          "__typename": "Tweet",
                          "rest_id": "1958000000000000001",
                          "core": {
                            "user_results": {
                              "result": {
                                "core": { "screen_name": "somedev", "name": "Some Dev" }
                              }
                            }
                          },
                          "legacy": {
                            "full_text": "hey @entirehq does this work with self-hosted runners?",
                            "created_at": "Tue Aug 18 14:02:11 +0000 2026",
                            "is_quote_status": false,
                            "in_reply_to_status_id_str": null
                          }
                        }
                      }
                    }
                  }
                },
                {
                  "entryId": "tweet-1958000000000000002",
                  "content": {
                    "entryType": "TimelineTimelineItem",
                    "itemContent": {
                      "tweet_results": {
                        "result": {
                          "__typename": "TweetWithVisibilityResults",
                          "tweet": {
                            "rest_id": "1958000000000000002",
                            "core": {
                              "user_results": {
                                "result": {
                                  "legacy": { "screen_name": "oldshape", "name": "Legacy Shape" }
                                }
                              }
                            },
                            "legacy": {
                              "full_text": "@entirehq thanks, that fixed it — shipping today",
                              "created_at": "Tue Aug 18 14:31:00 +0000 2026",
                              "is_quote_status": false,
                              "in_reply_to_status_id_str": "1957000000000000009"
                            }
                          }
                        }
                      }
                    }
                  }
                },
                {
                  "entryId": "tweet-1958000000000000003",
                  "content": {
                    "entryType": "TimelineTimelineItem",
                    "itemContent": {
                      "tweet_results": {
                        "result": {
                          "__typename": "Tweet",
                          "rest_id": "1958000000000000003",
                          "core": {
                            "user_results": {
                              "result": {
                                "core": { "screen_name": "QuoteFan", "name": "Quote Fan" }
                              }
                            }
                          },
                          "legacy": {
                            "full_text": "this is the release note everyone should read https://t.co/abc",
                            "created_at": "Tue Aug 18 15:00:45 +0000 2026",
                            "is_quote_status": true,
                            "in_reply_to_status_id_str": null
                          }
                        }
                      }
                    }
                  }
                },
                {
                  "entryId": "tweet-1958000000000000004",
                  "content": {
                    "entryType": "TimelineTimelineItem",
                    "itemContent": {
                      "tweet_results": {
                        "result": {
                          "__typename": "Tweet",
                          "rest_id": "1958000000000000004",
                          "core": {
                            "user_results": {
                              "result": {
                                "core": { "screen_name": "entirehq", "name": "Entire" }
                              }
                            }
                          },
                          "legacy": {
                            "full_text": "We just shipped agent integrations.",
                            "created_at": "Tue Aug 18 13:00:00 +0000 2026",
                            "is_quote_status": false,
                            "in_reply_to_status_id_str": null
                          }
                        }
                      }
                    }
                  }
                },
                {
                  "entryId": "tweet-broken",
                  "content": {
                    "entryType": "TimelineTimelineItem",
                    "itemContent": {
                      "tweet_results": {
                        "result": { "__typename": "TweetTombstone" }
                      }
                    }
                  }
                },
                {
                  "entryId": "cursor-bottom-1",
                  "content": {
                    "entryType": "TimelineTimelineCursor",
                    "value": "DAADDAABCgABF..."
                  }
                }
              ]
            },
            { "type": "TimelineTerminateTimeline", "direction": "Top" }
          ]
        }
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/parse-json.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTimelineJson } from '../scripts/parse.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/search-timeline.json', import.meta.url), 'utf8'),
);

test('parseTimelineJson extracts every readable tweet and skips the rest', () => {
  const tweets = parseTimelineJson(fixture);
  assert.equal(tweets.length, 4, 'tombstone and cursor entries must be skipped');
  assert.deepEqual(
    tweets.map((t) => t.id),
    [
      '1958000000000000001',
      '1958000000000000002',
      '1958000000000000003',
      '1958000000000000004',
    ],
  );
});

test('parseTimelineJson maps a plain mention completely', () => {
  const [first] = parseTimelineJson(fixture);
  assert.deepEqual(first, {
    id: '1958000000000000001',
    author: 'somedev',
    text: 'hey @entirehq does this work with self-hosted runners?',
    url: 'https://x.com/somedev/status/1958000000000000001',
    createdAt: '2026-08-18T14:02:11.000Z',
    inReplyToStatusId: null,
    isQuoteStatus: false,
  });
});

test('parseTimelineJson unwraps TweetWithVisibilityResults and the legacy user shape', () => {
  const reply = parseTimelineJson(fixture)[1];
  assert.equal(reply.author, 'oldshape');
  assert.equal(reply.inReplyToStatusId, '1957000000000000009');
  assert.equal(reply.url, 'https://x.com/oldshape/status/1958000000000000002');
});

test('parseTimelineJson preserves is_quote_status', () => {
  const quote = parseTimelineJson(fixture)[2];
  assert.equal(quote.isQuoteStatus, true);
  assert.equal(quote.inReplyToStatusId, null);
});

test('parseTimelineJson lowercases nothing in author but keeps it @-free', () => {
  const quote = parseTimelineJson(fixture)[2];
  assert.equal(quote.author, 'QuoteFan');
});

test('parseTimelineJson returns [] for junk input instead of throwing', () => {
  assert.deepEqual(parseTimelineJson(null), []);
  assert.deepEqual(parseTimelineJson({}), []);
  assert.deepEqual(parseTimelineJson({ data: { search_by_raw_query: null } }), []);
  assert.deepEqual(parseTimelineJson('not json'), []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/parse-json.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/parse.mjs'`

- [ ] **Step 4: Write the implementation**

Create `scripts/parse.mjs`:

```js
// X ships more than one shape for the same data, so every accessor here is
// defensive: an entry we cannot read is skipped, never thrown on. Returning a
// short list is recoverable; crashing the poll loop is not.

function toIso(twitterDate) {
  // X sends "Tue Aug 18 14:02:11 +0000 2026", which Date parses correctly.
  const parsed = new Date(twitterDate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function unwrapTweet(result) {
  if (!result || typeof result !== 'object') return null;
  // TweetWithVisibilityResults nests the real tweet one level down.
  const tweet = result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
  if (!tweet || typeof tweet !== 'object') return null;
  return tweet;
}

function screenNameOf(tweet) {
  const user = tweet?.core?.user_results?.result;
  // Newer payloads put it under `core`, older ones under `legacy`.
  return user?.core?.screen_name || user?.legacy?.screen_name || null;
}

function entriesOf(payload) {
  const instructions =
    payload?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
  if (!Array.isArray(instructions)) return [];
  return instructions
    .filter((i) => i?.type === 'TimelineAddEntries' && Array.isArray(i.entries))
    .flatMap((i) => i.entries);
}

export function parseTimelineJson(payload) {
  const tweets = [];
  for (const entry of entriesOf(payload)) {
    const tweet = unwrapTweet(entry?.content?.itemContent?.tweet_results?.result);
    if (!tweet) continue;

    const id = tweet.rest_id;
    const author = screenNameOf(tweet);
    const legacy = tweet.legacy;
    if (!id || !author || !legacy) continue;

    const createdAt = toIso(legacy.created_at);
    if (!createdAt) continue;

    tweets.push({
      id: String(id),
      author,
      text: legacy.full_text ?? '',
      url: `https://x.com/${author}/status/${id}`,
      createdAt,
      inReplyToStatusId: legacy.in_reply_to_status_id_str ?? null,
      isQuoteStatus: Boolean(legacy.is_quote_status),
    });
  }
  return tweets;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/parse-json.test.mjs`
Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add scripts/parse.mjs test/parse-json.test.mjs test/fixtures/search-timeline.json
git commit -m "feat: parse X SearchTimeline JSON into RawTweet records"
```

---

### Task 3: Parse the DOM fallback records

**Files:**
- Modify: `scripts/parse.mjs` (add a second export; leave `parseTimelineJson` untouched)
- Create: `test/fixtures/dom-records.json`
- Test: `test/parse-dom.test.mjs`

**Interfaces:**
- Consumes: `scripts/parse.mjs` from Task 2
- Produces: `parseDomRecords(records)` → `RawTweet[]`. Input is the array returned by the browser-side extractor in Task 8, each element shaped:
  ```js
  { permalink: '/somedev/status/1958...', handle: '@somedev', text: '...',
    datetime: '2026-08-18T14:02:11.000Z', hasReplyingTo: false, hasQuotedTweet: false }
  ```

**Why this shape:** extraction runs inside the browser via `page.$$eval`, so the DOM never reaches Node — which means no HTML parser dependency and a pure, testable function on this side of the boundary. This path cannot recover a real `in_reply_to_status_id`, only whether a "Replying to" block was rendered, so it synthesizes a sentinel id.

- [ ] **Step 1: Create the fixture**

Create `test/fixtures/dom-records.json`:

```json
[
  {
    "permalink": "/somedev/status/1958000000000000001",
    "handle": "@somedev",
    "text": "hey @entirehq does this work with self-hosted runners?",
    "datetime": "2026-08-18T14:02:11.000Z",
    "hasReplyingTo": false,
    "hasQuotedTweet": false
  },
  {
    "permalink": "https://x.com/oldshape/status/1958000000000000002",
    "handle": "oldshape",
    "text": "@entirehq thanks, that fixed it — shipping today",
    "datetime": "2026-08-18T14:31:00.000Z",
    "hasReplyingTo": true,
    "hasQuotedTweet": false
  },
  {
    "permalink": "/QuoteFan/status/1958000000000000003",
    "handle": "@QuoteFan",
    "text": "this is the release note everyone should read",
    "datetime": "2026-08-18T15:00:45.000Z",
    "hasReplyingTo": false,
    "hasQuotedTweet": true
  },
  {
    "permalink": "/somedev/status/1958000000000000001",
    "handle": "@somedev",
    "text": "duplicate of the first — X renders pinned/promoted repeats",
    "datetime": "2026-08-18T14:02:11.000Z",
    "hasReplyingTo": false,
    "hasQuotedTweet": false
  },
  {
    "permalink": "/somedev/photo/1",
    "handle": "@somedev",
    "text": "not a status permalink",
    "datetime": "2026-08-18T15:10:00.000Z",
    "hasReplyingTo": false,
    "hasQuotedTweet": false
  },
  {
    "permalink": "/nobody/status/1958000000000000005",
    "handle": "@nobody",
    "text": "missing timestamp",
    "datetime": null,
    "hasReplyingTo": false,
    "hasQuotedTweet": false
  }
]
```

- [ ] **Step 2: Write the failing test**

Create `test/parse-dom.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDomRecords } from '../scripts/parse.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/dom-records.json', import.meta.url), 'utf8'),
);

test('parseDomRecords keeps only well-formed, unique status records', () => {
  const tweets = parseDomRecords(fixture);
  assert.deepEqual(
    tweets.map((t) => t.id),
    ['1958000000000000001', '1958000000000000002', '1958000000000000003'],
    'duplicates, non-status permalinks, and undated records must be dropped',
  );
});

test('parseDomRecords normalizes handle and rebuilds a canonical url', () => {
  const [first] = parseDomRecords(fixture);
  assert.deepEqual(first, {
    id: '1958000000000000001',
    author: 'somedev',
    text: 'hey @entirehq does this work with self-hosted runners?',
    url: 'https://x.com/somedev/status/1958000000000000001',
    createdAt: '2026-08-18T14:02:11.000Z',
    inReplyToStatusId: null,
    isQuoteStatus: false,
  });
});

test('parseDomRecords accepts an absolute permalink and a bare handle', () => {
  const reply = parseDomRecords(fixture)[1];
  assert.equal(reply.author, 'oldshape');
  assert.equal(reply.url, 'https://x.com/oldshape/status/1958000000000000002');
});

test('parseDomRecords marks a "Replying to" record with the unknown-parent sentinel', () => {
  const reply = parseDomRecords(fixture)[1];
  assert.equal(reply.inReplyToStatusId, 'unknown');
});

test('parseDomRecords carries the quoted-tweet flag through', () => {
  const quote = parseDomRecords(fixture)[2];
  assert.equal(quote.isQuoteStatus, true);
  assert.equal(quote.inReplyToStatusId, null);
});

test('parseDomRecords returns [] for junk input instead of throwing', () => {
  assert.deepEqual(parseDomRecords(null), []);
  assert.deepEqual(parseDomRecords([]), []);
  assert.deepEqual(parseDomRecords([{}, null, 'nope']), []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/parse-dom.test.mjs`
Expected: FAIL — `parseDomRecords is not a function`

- [ ] **Step 4: Append the implementation to `scripts/parse.mjs`**

```js
const STATUS_PATH_RE = /^(?:https?:\/\/(?:x|twitter)\.com)?\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;

// The DOM path can see that a "Replying to" block was rendered but not which
// status is being replied to. This sentinel says "a parent exists, identity
// unknown" — filter.mjs only ever checks presence, never the value.
export const UNKNOWN_PARENT = 'unknown';

export function parseDomRecords(records) {
  if (!Array.isArray(records)) return [];
  const tweets = [];
  const seen = new Set();

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;

    const match = typeof record.permalink === 'string' && record.permalink.match(STATUS_PATH_RE);
    if (!match) continue;
    const [, pathAuthor, id] = match;

    if (seen.has(id)) continue;

    const createdAt = typeof record.datetime === 'string' ? new Date(record.datetime) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) continue;

    // Prefer the permalink's author: the rendered handle can belong to a
    // quoted or retweeting account rather than the tweet's own author.
    const author = pathAuthor || String(record.handle || '').replace(/^@/, '');
    if (!author) continue;

    seen.add(id);
    tweets.push({
      id,
      author,
      text: typeof record.text === 'string' ? record.text : '',
      url: `https://x.com/${author}/status/${id}`,
      createdAt: createdAt.toISOString(),
      inReplyToStatusId: record.hasReplyingTo ? UNKNOWN_PARENT : null,
      isQuoteStatus: Boolean(record.hasQuotedTweet),
    });
  }
  return tweets;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all suites green, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add scripts/parse.mjs test/parse-dom.test.mjs test/fixtures/dom-records.json
git commit -m "feat: parse DOM fallback records into RawTweet records"
```

---

### Task 4: Filter own posts and classify kind

**Files:**
- Create: `scripts/filter.mjs`
- Test: `test/filter.test.mjs`

**Interfaces:**
- Consumes: `RawTweet[]` from `parse.mjs` (Task 2 and Task 3)
- Produces: `filterAndClassify(rawTweets, ownHandle)` → `Tweet[]`. Drops posts authored by `ownHandle` (case-insensitive), assigns `kind`, drops `inReplyToStatusId` and `isQuoteStatus` from the output. Sorted oldest-first so notifications arrive in the order the tweets were written.

- [ ] **Step 1: Write the failing test**

Create `test/filter.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAndClassify } from '../scripts/filter.mjs';

function raw(overrides) {
  return {
    id: '1',
    author: 'somedev',
    text: 'hi @entirehq',
    url: 'https://x.com/somedev/status/1',
    createdAt: '2026-08-18T14:00:00.000Z',
    inReplyToStatusId: null,
    isQuoteStatus: false,
    ...overrides,
  };
}

test('filterAndClassify labels a plain mention', () => {
  const [t] = filterAndClassify([raw({})], 'entirehq');
  assert.equal(t.kind, 'mention');
});

test('filterAndClassify labels a reply', () => {
  const [t] = filterAndClassify([raw({ inReplyToStatusId: '999' })], 'entirehq');
  assert.equal(t.kind, 'reply');
});

test('filterAndClassify labels a reply found via the DOM sentinel', () => {
  const [t] = filterAndClassify([raw({ inReplyToStatusId: 'unknown' })], 'entirehq');
  assert.equal(t.kind, 'reply');
});

test('filterAndClassify labels a quote tweet', () => {
  const [t] = filterAndClassify([raw({ isQuoteStatus: true })], 'entirehq');
  assert.equal(t.kind, 'quote');
});

test('reply wins over quote when a tweet is both', () => {
  const [t] = filterAndClassify(
    [raw({ isQuoteStatus: true, inReplyToStatusId: '999' })],
    'entirehq',
  );
  assert.equal(t.kind, 'reply');
});

test('filterAndClassify drops posts authored by the watched account', () => {
  const tweets = filterAndClassify(
    [raw({ id: '1', author: 'entirehq' }), raw({ id: '2', author: 'somedev' })],
    'entirehq',
  );
  assert.deepEqual(tweets.map((t) => t.id), ['2']);
});

test('own-post matching ignores case and a leading @', () => {
  const tweets = filterAndClassify([raw({ author: 'EntireHQ' })], '@entirehq');
  assert.deepEqual(tweets, []);
});

test('filterAndClassify emits exactly the Tweet fields, no raw leftovers', () => {
  const [t] = filterAndClassify([raw({ inReplyToStatusId: '999' })], 'entirehq');
  assert.deepEqual(Object.keys(t).sort(), [
    'author', 'createdAt', 'id', 'kind', 'text', 'url',
  ]);
});

test('filterAndClassify sorts oldest first', () => {
  const tweets = filterAndClassify(
    [
      raw({ id: 'new', createdAt: '2026-08-18T16:00:00.000Z' }),
      raw({ id: 'old', createdAt: '2026-08-18T09:00:00.000Z' }),
    ],
    'entirehq',
  );
  assert.deepEqual(tweets.map((t) => t.id), ['old', 'new']);
});

test('filterAndClassify tolerates junk input', () => {
  assert.deepEqual(filterAndClassify(null, 'entirehq'), []);
  assert.deepEqual(filterAndClassify([null, 'nope'], 'entirehq'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/filter.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/filter.mjs'`

- [ ] **Step 3: Write the implementation**

Create `scripts/filter.mjs`:

```js
function classify(rawTweet) {
  // Reply beats quote: a quoted reply is still a reply to something of ours,
  // which is the more actionable framing.
  if (rawTweet.inReplyToStatusId) return 'reply';
  if (rawTweet.isQuoteStatus) return 'quote';
  return 'mention';
}

export function filterAndClassify(rawTweets, ownHandle) {
  if (!Array.isArray(rawTweets)) return [];
  const own = String(ownHandle || '').replace(/^@/, '').toLowerCase();

  return rawTweets
    .filter((t) => t && typeof t === 'object' && t.id && t.author)
    .filter((t) => t.author.toLowerCase() !== own)
    .map((t) => ({
      id: t.id,
      author: t.author,
      text: t.text,
      url: t.url,
      createdAt: t.createdAt,
      kind: classify(t),
    }))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add scripts/filter.mjs test/filter.test.mjs
git commit -m "feat: filter own posts and classify mention/reply/quote"
```

---

### Task 5: Seen-ID store with baseline and eviction

**Files:**
- Create: `scripts/store.mjs`
- Test: `test/store.test.mjs`

**Interfaces:**
- Consumes: `getDataDir()` from `scripts/config.mjs` (Task 1); `Tweet[]` from `scripts/filter.mjs` (Task 4)
- Produces:
  - `MAX_SEEN` → `500`
  - `loadStore(dataDir)` → `{ seen: string[], baselined: boolean }`. Returns `{ seen: [], baselined: false }` for a missing or corrupt file, and defaults `baselined` to `false` when an existing file omits it.
  - `saveStore(dataDir, store)` → writes `<dataDir>/seen.json`, creating directories as needed.
  - `diffSeen(store, tweets)` → `{ isBaseline, fresh, store }`. Pure: does not mutate the store passed in. `isBaseline` is `true` when `store.baselined` is falsy; in that case `fresh` is `[]`, every id is recorded, and the returned store has `baselined: true`.

**Why `baselined` is an explicit flag and not `seen.length === 0`:** a poll can
legitimately return zero tweets after filtering — the `@entirehq` search is
often dominated by `@entirehq`'s own posts, which get filtered out. Inferring
"baseline" from an empty store would then re-baseline on the next poll and
silently swallow the first real mention, which is the one notification that
matters most.

- [ ] **Step 1: Write the failing test**

Create `test/store.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStore, saveStore, diffSeen, MAX_SEEN } from '../scripts/store.mjs';

function tweet(id) {
  return {
    id,
    author: 'somedev',
    text: `tweet ${id}`,
    url: `https://x.com/somedev/status/${id}`,
    createdAt: '2026-08-18T14:00:00.000Z',
    kind: 'mention',
  };
}

test('loadStore returns an empty un-baselined store when the file is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  assert.deepEqual(loadStore(dir), { seen: [], baselined: false });
});

test('loadStore returns an empty un-baselined store when the file is corrupt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  writeFileSync(join(dir, 'seen.json'), '{ not json');
  assert.deepEqual(loadStore(dir), { seen: [], baselined: false });
});

test('loadStore defaults baselined to false when an existing file omits it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  writeFileSync(join(dir, 'seen.json'), JSON.stringify({ seen: ['a'] }));
  assert.deepEqual(loadStore(dir), { seen: ['a'], baselined: false });
});

test('saveStore then loadStore round-trips', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'store-')), 'nested');
  saveStore(dir, { seen: ['a', 'b'], baselined: true });
  assert.deepEqual(loadStore(dir), { seen: ['a', 'b'], baselined: true });
  assert.ok(readFileSync(join(dir, 'seen.json'), 'utf8').includes('"a"'));
});

test('diffSeen on a cold store records everything and notifies nothing', () => {
  const result = diffSeen({ seen: [], baselined: false }, [tweet('1'), tweet('2')]);
  assert.equal(result.isBaseline, true);
  assert.deepEqual(result.fresh, []);
  assert.deepEqual(result.store.seen, ['1', '2']);
  assert.equal(result.store.baselined, true);
});

test('an empty poll still marks the store baselined, so the next real mention notifies', () => {
  const first = diffSeen({ seen: [], baselined: false }, []);
  assert.equal(first.isBaseline, true);
  assert.deepEqual(first.store.seen, []);
  assert.equal(first.store.baselined, true);

  // The bug this guards: inferring baseline from an empty `seen` would swallow
  // this tweet instead of notifying.
  const second = diffSeen(first.store, [tweet('1')]);
  assert.equal(second.isBaseline, false);
  assert.deepEqual(second.fresh.map((t) => t.id), ['1']);
});

test('diffSeen returns only ids not already seen', () => {
  const result = diffSeen({ seen: ['1'], baselined: true }, [tweet('1'), tweet('2'), tweet('3')]);
  assert.equal(result.isBaseline, false);
  assert.deepEqual(result.fresh.map((t) => t.id), ['2', '3']);
  assert.deepEqual(result.store.seen, ['1', '2', '3']);
});

test('diffSeen does not mutate the store it was given', () => {
  const original = { seen: ['1'], baselined: true };
  diffSeen(original, [tweet('2')]);
  assert.deepEqual(original.seen, ['1']);
});

test('diffSeen deduplicates ids repeated within one batch', () => {
  const result = diffSeen({ seen: [], baselined: false }, [tweet('1'), tweet('1')]);
  assert.deepEqual(result.store.seen, ['1']);
});

test('diffSeen evicts oldest ids beyond MAX_SEEN', () => {
  const seen = Array.from({ length: MAX_SEEN }, (_, i) => `old-${i}`);
  const result = diffSeen({ seen, baselined: true }, [tweet('brand-new')]);
  assert.equal(result.store.seen.length, MAX_SEEN);
  assert.equal(result.store.seen.at(-1), 'brand-new');
  assert.equal(result.store.seen[0], 'old-1', 'the oldest id is the one dropped');
});

test('MAX_SEEN is 500', () => {
  assert.equal(MAX_SEEN, 500);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/store.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/store.mjs'`

- [ ] **Step 3: Write the implementation**

Create `scripts/store.mjs`:

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_SEEN = 500;

const EMPTY = () => ({ seen: [], baselined: false });

function storePath(dataDir) {
  return join(dataDir, 'seen.json');
}

export function loadStore(dataDir) {
  const path = storePath(dataDir);
  if (!existsSync(path)) return EMPTY();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed?.seen)
      ? { seen: parsed.seen.map(String), baselined: Boolean(parsed.baselined) }
      : EMPTY();
  } catch {
    // A corrupt store is not worth crashing over — rebuilding the baseline
    // costs one silent poll.
    return EMPTY();
  }
}

export function saveStore(dataDir, store) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(storePath(dataDir), JSON.stringify(store, null, 2));
}

// Pure. Returns a new store; never mutates the one passed in.
//
// `isBaseline` comes from the explicit `baselined` flag, never from an empty
// `seen` list: a poll can legitimately yield zero tweets after filtering, and
// re-baselining on the next poll would silently swallow the first real mention.
export function diffSeen(store, tweets) {
  const previous = Array.isArray(store?.seen) ? store.seen : [];
  const known = new Set(previous);
  const isBaseline = !store?.baselined;

  const fresh = [];
  const added = [];
  for (const tweet of tweets) {
    if (known.has(tweet.id)) continue;
    known.add(tweet.id);
    added.push(tweet.id);
    if (!isBaseline) fresh.push(tweet);
  }

  const seen = [...previous, ...added].slice(-MAX_SEEN);
  return { isBaseline, fresh, store: { seen, baselined: true } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add scripts/store.mjs test/store.test.mjs
git commit -m "feat: seen-id store with cold-cache baseline and eviction"
```

---

### Task 6: Terminal notifier

**Files:**
- Create: `scripts/notify-terminal.mjs`
- Test: `test/notify-terminal.test.mjs`

**Interfaces:**
- Consumes: `Tweet` from `scripts/filter.mjs` (Task 4)
- Produces:
  - `formatTweet(tweet, now)` → multi-line string with ANSI colour. `now` is a `Date`, used only for the `[HH:MM:SS]` stamp, and defaults to `new Date()`.
  - `printTweet(tweet)`, `printBaseline(count)`, `printStarted(pollMs, projectDir)`, `printQuiet(message)`, `printWarning(message)` — each writes one block to stdout via `console.log`.
  - `stripAnsi(value)` → the same string with every ANSI escape sequence removed. Exported so tests can assert on content without matching colour codes.

- [ ] **Step 1: Write the failing test**

Create `test/notify-terminal.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTweet, stripAnsi } from '../scripts/notify-terminal.mjs';

const tweet = {
  id: '1958000000000000001',
  author: 'somedev',
  text: 'hey @entirehq does this work with self-hosted runners?',
  url: 'https://x.com/somedev/status/1958000000000000001',
  createdAt: '2026-08-18T14:02:11.000Z',
  kind: 'reply',
};

const at = new Date('2026-08-18T14:03:00.000Z');

test('formatTweet includes handle, kind, text and url', () => {
  const plain = stripAnsi(formatTweet(tweet, at));
  assert.match(plain, /@somedev/);
  assert.match(plain, /reply/);
  assert.match(plain, /self-hosted runners/);
  assert.match(plain, /https:\/\/x\.com\/somedev\/status\/1958000000000000001/);
});

test('formatTweet stamps the local time as HH:MM:SS', () => {
  const plain = stripAnsi(formatTweet(tweet, at));
  assert.match(plain, /^\[\d{2}:\d{2}:\d{2}\]/);
});

test('formatTweet emits ANSI colour codes', () => {
  assert.match(formatTweet(tweet, at), /\x1b\[/);
});

test('formatTweet collapses newlines in the tweet body to keep one block per tweet', () => {
  const plain = stripAnsi(formatTweet({ ...tweet, text: 'line one\nline two' }, at));
  const bodyLine = plain.split('\n').find((l) => l.includes('line one'));
  assert.match(bodyLine, /line one line two/);
});

test('formatTweet truncates a very long body', () => {
  const plain = stripAnsi(formatTweet({ ...tweet, text: 'x'.repeat(400) }, at));
  assert.match(plain, /…/);
  assert.ok(plain.length < 400, 'long tweets must not flood the terminal');
});

test('stripAnsi removes every escape sequence', () => {
  assert.equal(stripAnsi('\x1b[1mbold\x1b[0m'), 'bold');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/notify-terminal.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/notify-terminal.mjs'`

- [ ] **Step 3: Write the implementation**

Create `scripts/notify-terminal.mjs`:

```js
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

const MAX_BODY = 240;

const KIND_LABEL = {
  mention: 'mention',
  reply: 'reply',
  quote: 'quote',
};

export function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function stamp(date) {
  return date.toTimeString().slice(0, 8);
}

function body(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_BODY ? `${flat.slice(0, MAX_BODY - 1)}…` : flat;
}

export function formatTweet(tweet, now = new Date()) {
  const kind = KIND_LABEL[tweet.kind] ?? tweet.kind;
  return (
    `${C.dim}[${stamp(now)}]${C.reset} ${C.yellow}${C.bold}NEW MENTION${C.reset} ` +
    `${C.cyan}@${tweet.author}${C.reset} ${C.dim}·${C.reset} ${kind}\n` +
    `  ${body(tweet.text)}\n` +
    `  ${C.dim}${tweet.url}${C.reset}`
  );
}

export function printTweet(tweet) {
  console.log(formatTweet(tweet));
}

export function printStarted(pollMs, projectDir) {
  console.log(
    `${C.bold}@entirehq mention watcher started${C.reset} ` +
      `(polling every ${Math.round(pollMs / 1000)}s) ${C.dim}[${projectDir}]${C.reset}`,
  );
}

export function printBaseline(count) {
  console.log(
    `${C.dim}[${stamp(new Date())}]${C.reset} tracking ${count} existing ` +
      `${count === 1 ? 'mention' : 'mentions'} — watching for new ones`,
  );
}

export function printQuiet(message) {
  console.log(`${C.dim}[${stamp(new Date())}] ${message}${C.reset}`);
}

export function printWarning(message) {
  console.log(`${C.red}${C.bold}[${stamp(new Date())}] ${message}${C.reset}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add scripts/notify-terminal.mjs test/notify-terminal.test.mjs
git commit -m "feat: terminal notifier"
```

---

### Task 7: Slack notifier

**Files:**
- Create: `scripts/notify-slack.mjs`
- Test: `test/notify-slack.test.mjs`

**Interfaces:**
- Consumes: `Tweet` from `scripts/filter.mjs` (Task 4)
- Produces:
  - `escapeSlack(text)` → escapes `&`, `<`, `>` for Slack mrkdwn.
  - `buildTweetMessage(tweet)` → Block Kit payload object with a `text` fallback.
  - `buildAlertMessage(text)` → a plain-text Block Kit payload, used for the cookie-expiry alert.
  - `postToSlack(webhookUrl, payload, options)` → `Promise<{ ok: boolean, status: number, attempts: number }>`. Retries exactly once on a non-2xx response or a thrown network error, then resolves `ok: false` rather than throwing. `options.fetchImpl` defaults to global `fetch`; `options.retryDelayMs` defaults to `1000`.

- [ ] **Step 1: Write the failing test**

Create `test/notify-slack.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  buildTweetMessage,
  buildAlertMessage,
  escapeSlack,
  postToSlack,
} from '../scripts/notify-slack.mjs';

const tweet = {
  id: '1958000000000000001',
  author: 'somedev',
  text: 'hey @entirehq does this work with self-hosted runners?',
  url: 'https://x.com/somedev/status/1958000000000000001',
  createdAt: '2026-08-18T14:02:11.000Z',
  kind: 'reply',
};

// Starts a throwaway webhook receiver. `statuses` is consumed one entry per
// request, so [500, 200] models "fails once, then succeeds".
async function stubWebhook(statuses) {
  const received = [];
  const queue = [...statuses];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(raw));
      res.writeHead(queue.shift() ?? 200).end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  return { url, received, close: () => new Promise((r) => server.close(r)) };
}

test('escapeSlack escapes the three mrkdwn control characters', () => {
  assert.equal(escapeSlack('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
});

test('buildTweetMessage carries handle, kind, body and link', () => {
  const payload = buildTweetMessage(tweet);
  const json = JSON.stringify(payload);
  assert.match(json, /somedev/);
  assert.match(json, /reply/);
  assert.match(json, /self-hosted runners/);
  assert.match(json, /1958000000000000001/);
});

test('buildTweetMessage sets a plain-text fallback for notifications', () => {
  assert.equal(buildTweetMessage(tweet).text, '@somedev replied to @entirehq');
  assert.equal(
    buildTweetMessage({ ...tweet, kind: 'mention' }).text,
    '@somedev mentioned @entirehq',
  );
  assert.equal(
    buildTweetMessage({ ...tweet, kind: 'quote' }).text,
    '@somedev quoted @entirehq',
  );
});

test('buildTweetMessage escapes user content so a tweet cannot forge markup', () => {
  const payload = buildTweetMessage({ ...tweet, text: '<https://evil.example|click me>' });
  assert.match(JSON.stringify(payload), /&lt;https:\/\/evil\.example/);
});

test('buildAlertMessage produces a usable payload', () => {
  const payload = buildAlertMessage('X cookies expired');
  assert.equal(payload.text, 'X cookies expired');
  assert.ok(Array.isArray(payload.blocks) && payload.blocks.length > 0);
});

test('postToSlack posts the payload and reports success', async () => {
  const hook = await stubWebhook([200]);
  const result = await postToSlack(hook.url, buildTweetMessage(tweet));
  assert.deepEqual({ ok: result.ok, attempts: result.attempts }, { ok: true, attempts: 1 });
  assert.equal(hook.received.length, 1);
  assert.equal(hook.received[0].text, '@somedev replied to @entirehq');
  await hook.close();
});

test('postToSlack retries exactly once after a server error, then succeeds', async () => {
  const hook = await stubWebhook([500, 200]);
  const result = await postToSlack(hook.url, buildTweetMessage(tweet), { retryDelayMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(hook.received.length, 2);
  await hook.close();
});

test('postToSlack gives up after the retry and resolves ok:false', async () => {
  const hook = await stubWebhook([500, 500]);
  const result = await postToSlack(hook.url, buildTweetMessage(tweet), { retryDelayMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(result.attempts, 2);
  await hook.close();
});

test('postToSlack resolves ok:false on a network error instead of throwing', async () => {
  const result = await postToSlack('http://127.0.0.1:1/hook', { text: 'x' }, { retryDelayMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/notify-slack.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/notify-slack.mjs'`

- [ ] **Step 3: Write the implementation**

Create `scripts/notify-slack.mjs`:

```js
const VERB = {
  mention: 'mentioned',
  reply: 'replied to',
  quote: 'quoted',
};

const MAX_BODY = 500;

// Slack mrkdwn treats these three as control characters. Tweet text is
// untrusted input — without this a tweet could forge a link in our channel.
export function escapeSlack(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function body(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_BODY ? `${flat.slice(0, MAX_BODY - 1)}…` : flat;
}

export function buildTweetMessage(tweet) {
  const verb = VERB[tweet.kind] ?? 'mentioned';
  const epoch = Math.floor(new Date(tweet.createdAt).getTime() / 1000);
  const handle = escapeSlack(tweet.author);

  return {
    text: `@${handle} ${verb} @entirehq`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*<https://x.com/${encodeURIComponent(tweet.author)}|@${handle}>* ${verb} @entirehq\n` +
            `>${escapeSlack(body(tweet.text))}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `<${tweet.url}|View on X> · ${tweet.kind} · <!date^${epoch}^{date_short_pretty} at {time}|${tweet.createdAt}>`,
          },
        ],
      },
    ],
  };
}

export function buildAlertMessage(text) {
  return {
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: escapeSlack(text) } }],
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves rather than rejects: the caller is a poll loop that must survive a
// bad Slack day, and the terminal has already shown the user this tweet.
export async function postToSlack(webhookUrl, payload, options = {}) {
  const { fetchImpl = fetch, retryDelayMs = 1000 } = options;
  let status = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      status = response.status;
      if (response.ok) return { ok: true, status, attempts: attempt };
    } catch {
      status = 0;
    }
    if (attempt === 1) await sleep(retryDelayMs);
  }

  return { ok: false, status, attempts: 2 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add scripts/notify-slack.mjs test/notify-slack.test.mjs
git commit -m "feat: slack webhook notifier with block kit payload and retry"
```

---

### Task 8: Browserbase scraper and the live dry-run check

**Files:**
- Create: `scripts/x-scrape.mjs`
- Create: `scripts/check.mjs`

**Interfaces:**
- Consumes: config object from `scripts/config.mjs` (Task 1); `parseTimelineJson` and `parseDomRecords` from `scripts/parse.mjs` (Tasks 2–3); `filterAndClassify` from `scripts/filter.mjs` (Task 4); terminal printers from Task 6
- Produces: `scrapeSearch(config)` → `Promise<{ source: 'json' | 'dom', tweets: RawTweet[], loginWall: boolean }>`. Throws on Browserbase or navigation failure; the caller decides whether to retry.

**No unit tests for this task.** It is I/O against a live third party — a mock of Playwright would test the mock. It is verified by `npm run check` in Step 3, and again end-to-end in Task 10.

- [ ] **Step 1: Write `scripts/x-scrape.mjs`**

```js
import Browserbase from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { parseTimelineJson, parseDomRecords } from './parse.mjs';

const TIMELINE_RE = /\/graphql\/[^/]+\/SearchTimeline/;
const NAV_TIMEOUT_MS = 45000;
const SETTLE_MS = 6000;

// X reads the session from cookies on both hosts; ct0 must also travel as the
// x-csrf-token header on the XHR, which the page's own client handles once the
// cookie is present.
function sessionCookies({ xAuthToken, xCsrfToken }) {
  return ['x.com', 'twitter.com'].flatMap((domain) => [
    { name: 'auth_token', value: xAuthToken, domain: `.${domain}`, path: '/', httpOnly: true, secure: true },
    { name: 'ct0', value: xCsrfToken, domain: `.${domain}`, path: '/', secure: true },
  ]);
}

async function detectLoginWall(page) {
  const url = page.url();
  if (/\/(i\/flow\/login|login)/.test(url)) return true;
  return (await page.locator('input[name="text"][autocomplete="username"]').count()) > 0;
}

// Runs inside the browser. Mirrors the record shape parseDomRecords expects.
function extractDomRecords() {
  return Array.from(document.querySelectorAll('article[data-testid="tweet"]')).map((article) => {
    const timeEl = article.querySelector('time[datetime]');
    const permalink = timeEl?.closest('a')?.getAttribute('href') ?? '';
    const handleEl = Array.from(article.querySelectorAll('[data-testid="User-Name"] span')).find(
      (el) => el.textContent.startsWith('@'),
    );
    return {
      permalink,
      handle: handleEl?.textContent ?? '',
      text: article.querySelector('[data-testid="tweetText"]')?.textContent ?? '',
      datetime: timeEl?.getAttribute('datetime') ?? null,
      hasReplyingTo: article.textContent.includes('Replying to'),
      hasQuotedTweet: article.querySelectorAll('[data-testid="tweetText"]').length > 1,
    };
  });
}

export async function scrapeSearch(config) {
  const bb = new Browserbase({ apiKey: config.browserbaseApiKey });
  const session = await bb.sessions.create({ projectId: config.browserbaseProjectId });
  const browser = await chromium.connectOverCDP(session.connectUrl);

  try {
    const context = browser.contexts()[0];
    await context.addCookies(sessionCookies(config));
    const page = context.pages()[0] || (await context.newPage());

    // Collect every SearchTimeline response the page fires; the first request
    // usually lands before `load` resolves, so the listener goes on first.
    const payloads = [];
    page.on('response', async (response) => {
      if (!TIMELINE_RE.test(response.url())) return;
      try {
        payloads.push(await response.json());
      } catch {
        // Non-JSON or already-consumed body — the DOM fallback covers us.
      }
    });

    await page.goto(config.searchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);

    const loginWall = await detectLoginWall(page);

    const fromJson = payloads.flatMap((payload) => parseTimelineJson(payload));
    if (fromJson.length) return { source: 'json', tweets: fromJson, loginWall: false };

    const records = await page.evaluate(extractDomRecords);
    return { source: 'dom', tweets: parseDomRecords(records), loginWall };
  } finally {
    await browser.close();
  }
}
```

- [ ] **Step 2: Write `scripts/check.mjs`**

```js
// One live scrape, printed, notifying nobody. This is the manual gate before
// the watcher is considered working.
import { loadConfig, loadEnvFile, getProjectDir, ConfigError } from './config.mjs';
import { filterAndClassify } from './filter.mjs';
import { formatTweet, printWarning, printQuiet } from './notify-terminal.mjs';
import { scrapeSearch } from './x-scrape.mjs';

loadEnvFile(getProjectDir());

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

console.log(`Dry run — scraping ${config.searchUrl}`);
console.log('Nothing will be sent to Slack.\n');

try {
  const { source, tweets, loginWall } = await scrapeSearch(config);
  printQuiet(`extraction path: ${source}`);

  if (loginWall) {
    printWarning('X served a login wall — X_AUTH_TOKEN / X_CSRF_TOKEN are stale. Re-copy both cookies.');
    process.exit(1);
  }

  const classified = filterAndClassify(tweets, config.ownHandle);
  printQuiet(`${tweets.length} tweets scraped, ${classified.length} after filtering out @${config.ownHandle}`);

  if (classified.length === 0) {
    printWarning('No tweets found. Either the search is genuinely empty or extraction broke.');
    process.exit(1);
  }

  console.log('');
  for (const tweet of classified) console.log(formatTweet(tweet));
  console.log(`\nLooks healthy. ${classified.length} tweets would be tracked.`);
} catch (err) {
  printWarning(`scrape failed: ${err.message}`);
  process.exit(1);
}
```

- [ ] **Step 3: Fill in `.env` and run the live check**

This is the first step needing real credentials. Copy `.env.example` to `.env` and fill in all five required values:
- `BROWSERBASE_API_KEY` / `BROWSERBASE_PROJECT_ID` — copy from `~/Desktop/demos-2-idk/wimbledon-worldcup-scores/.env`
- `X_AUTH_TOKEN` / `X_CSRF_TOKEN` — from a logged-in x.com tab, DevTools → Application → Cookies → `https://x.com`, values of `auth_token` and `ct0`
- `SLACK_WEBHOOK_URL` — from api.slack.com/apps → Incoming Webhooks

Run: `npm run check`
Expected: `extraction path: json`, a tweet count, and several formatted tweets. Exit code 0.

If it reports a login wall, the cookies are stale — re-copy them. If it reports `extraction path: dom` with zero tweets, X changed both paths; capture the page and revisit Tasks 2–3 before continuing.

- [ ] **Step 4: Capture a real fixture and re-verify the parser**

The Task 2 fixture is hand-built from the documented shape. Replace it with a real one now that a live payload is reachable. Add this temporarily to `scripts/x-scrape.mjs`, immediately after `payloads.push(await response.json())`:

```js
if (process.env.X_CAPTURE_FIXTURE) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.X_CAPTURE_FIXTURE, JSON.stringify(payloads.at(-1), null, 2));
}
```

Run: `X_CAPTURE_FIXTURE=$PWD/test/fixtures/search-timeline-live.json npm run check`

Then run: `npm test`

The Task 2 tests still run against the hand-built fixture. Add one more test to `test/parse-json.test.mjs` asserting the live capture parses to a non-empty list with well-formed records:

```js
test('parseTimelineJson handles the captured live payload', () => {
  const live = JSON.parse(
    readFileSync(new URL('./fixtures/search-timeline-live.json', import.meta.url), 'utf8'),
  );
  const tweets = parseTimelineJson(live);
  assert.ok(tweets.length > 0, 'live payload must yield at least one tweet');
  for (const t of tweets) {
    assert.match(t.id, /^\d+$/);
    assert.ok(t.author.length > 0);
    assert.match(t.url, /^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+$/);
    assert.ok(!Number.isNaN(new Date(t.createdAt).getTime()));
  }
});
```

Expected: PASS. If it fails, the real shape differs from the assumed one — fix `parse.mjs` until both fixtures pass, then continue.

Remove the temporary capture block from `x-scrape.mjs` before committing.

**Note:** the live fixture contains real public tweets. Skim it before committing; if anything in it shouldn't be in the repo, add `test/fixtures/search-timeline-live.json` to `.gitignore` and mark that test `{ skip: !existsSync(...) }` instead.

- [ ] **Step 5: Commit**

```bash
git add scripts/x-scrape.mjs scripts/check.mjs test/parse-json.test.mjs test/fixtures/
git commit -m "feat: browserbase scraper with json interception and dom fallback"
```

---

### Task 9: The poll loop

**Files:**
- Create: `scripts/watch.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1 and 4–8
- Produces: a long-running process. No exports.

**Behaviors this must implement, from the spec:**
- Cold cache prints one baseline line and notifies nobody
- Cookie expiry: loud terminal warning **and** exactly one Slack alert, then a 30-minute retry — the alert must not repeat on every subsequent poll
- Transient failures: exponential backoff capped at 30 minutes, reset on the first success
- A failed Slack post still marks the tweet seen

- [ ] **Step 1: Write `scripts/watch.mjs`**

```js
import { loadConfig, loadEnvFile, getProjectDir, getDataDir, ConfigError } from './config.mjs';
import { filterAndClassify } from './filter.mjs';
import { loadStore, saveStore, diffSeen } from './store.mjs';
import { printTweet, printStarted, printBaseline, printQuiet, printWarning } from './notify-terminal.mjs';
import { buildTweetMessage, buildAlertMessage, postToSlack } from './notify-slack.mjs';
import { scrapeSearch } from './x-scrape.mjs';

const MAX_BACKOFF_MS = 30 * 60 * 1000;

const projectDir = getProjectDir();
loadEnvFile(projectDir);

let config;
try {
  config = loadConfig();
} catch (err) {
  printWarning(err instanceof ConfigError ? err.message : String(err));
  process.exit(1);
}

const dataDir = getDataDir(projectDir);
let store = loadStore(dataDir);
let consecutiveFailures = 0;
let loginWallAlerted = false;
let stopped = false;
let timer = null;

async function announce(tweet) {
  printTweet(tweet);
  const result = await postToSlack(config.slackWebhookUrl, buildTweetMessage(tweet));
  if (!result.ok) {
    // Marked seen regardless: the terminal already showed it, and replaying a
    // Slack message every poll forever is worse than dropping one.
    printQuiet(`slack post failed (status ${result.status}) — terminal only for that one`);
  }
}

async function handleLoginWall() {
  printWarning('X served a login wall — X_AUTH_TOKEN / X_CSRF_TOKEN are stale. Re-copy both cookies into .env and restart the session.');
  if (!loginWallAlerted) {
    loginWallAlerted = true;
    await postToSlack(
      config.slackWebhookUrl,
      buildAlertMessage(
        '@entirehq mention watcher is not authenticated — the X session cookies expired. ' +
          'No mentions are being tracked until they are refreshed.',
      ),
    );
  }
}

async function pollOnce() {
  const { source, tweets, loginWall } = await scrapeSearch(config);

  if (loginWall) {
    await handleLoginWall();
    return MAX_BACKOFF_MS;
  }
  loginWallAlerted = false;

  // The JSON path is the healthy one. Say so out loud when we fall back, so a
  // silent degradation in extraction quality is visible rather than guessed at.
  if (source === 'dom') printQuiet('SearchTimeline JSON not seen — using the DOM fallback');

  const classified = filterAndClassify(tweets, config.ownHandle);
  const { isBaseline, fresh, store: nextStore } = diffSeen(store, classified);
  store = nextStore;
  saveStore(dataDir, store);

  if (isBaseline) {
    printBaseline(classified.length);
    return config.pollMs;
  }

  if (fresh.length === 0) {
    printQuiet(`no new mentions (${classified.length} tracked, via ${source})`);
    return config.pollMs;
  }

  for (const tweet of fresh) await announce(tweet);
  return config.pollMs;
}

function backoffMs() {
  return Math.min(config.pollMs * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
}

async function loop() {
  printStarted(config.pollMs, projectDir);

  while (!stopped) {
    let waitMs;
    try {
      waitMs = await pollOnce();
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      waitMs = backoffMs();
      printWarning(`scrape failed: ${err.message} — retrying in ${Math.round(waitMs / 1000)}s`);
    }
    if (stopped) break;
    await new Promise((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });
  }
}

function shutdown() {
  stopped = true;
  if (timer) clearTimeout(timer);
  printQuiet('mention watcher stopped');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await loop();
```

- [ ] **Step 2: Verify it starts, baselines, and stops cleanly**

Run: `X_WATCH_POLL_MS=20000 node scripts/watch.mjs`

Expected, in order: a `@entirehq mention watcher started (polling every 20s)` line, then within a minute a `tracking N existing mentions — watching for new ones` line. Nothing arrives in Slack. Wait for a second poll to print `no new mentions (N tracked, via json)`.

Press Ctrl-C. Expected: `mention watcher stopped`, process exits.

- [ ] **Step 3: Verify a genuinely new tweet reaches both channels**

The baseline is now recorded, so this proves the actual feature. Post a tweet from any account other than `@entirehq` mentioning `@entirehq`, then start the watcher again:

Run: `X_WATCH_POLL_MS=20000 node scripts/watch.mjs`

Expected, within one poll: a `NEW MENTION @yourhandle · mention` block in the terminal **and** one message in the Slack channel. Confirm both before continuing — this is the whole feature.

Then Ctrl-C.

- [ ] **Step 4: Verify the cookie-expiry path**

Run: `X_AUTH_TOKEN=deliberately-invalid X_WATCH_POLL_MS=20000 node scripts/watch.mjs`

Expected: the red login-wall warning in the terminal and exactly **one** Slack alert. Let it poll again and confirm no second Slack alert. Then Ctrl-C.

Delete the baseline written by this broken run so the real one starts fresh: `rm -f .claude/entirehq-watcher/seen.json`

- [ ] **Step 5: Commit**

```bash
git add scripts/watch.mjs
git commit -m "feat: poll loop with backoff, baseline, and cookie-expiry alerting"
```

---

### Task 10: Hooks, wiring, and end-to-end verification

**Files:**
- Create: `scripts/hook-start.mjs`
- Create: `scripts/hook-stop.mjs`
- Create: `.claude/settings.json` (or modify, if it already exists)
- Create: `README.md`

**Interfaces:**
- Consumes: `getProjectDir()` and `getDataDir()` from `scripts/config.mjs` (Task 1); `scripts/watch.mjs` (Task 9)
- Produces: the installed feature. Nothing consumes this task.

- [ ] **Step 1: Write `scripts/hook-start.mjs`**

```js
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectDir, getDataDir } from './config.mjs';

// Nothing in this file may exit 2 — that return code blocks Claude Code from
// starting the session. A broken watcher must never cost the user their shell.
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectDir = getProjectDir();
const dataDir = getDataDir(projectDir);
const pidFile = join(dataDir, 'watch.pid');

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

try {
  mkdirSync(dataDir, { recursive: true });

  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (pid && isRunning(pid)) process.exit(0);
  }

  // stdio inherits the hook's file descriptors — the same TTY Claude Code is
  // running in — so the detached watcher keeps printing into this terminal
  // after this hook process exits.
  const child = spawn(process.execPath, [join(scriptsDir, 'watch.mjs')], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  writeFileSync(pidFile, String(child.pid));
  child.unref();
} catch (err) {
  console.error(`mention watcher failed to start: ${err.message}`);
  process.exit(1);
}
```

- [ ] **Step 2: Write `scripts/hook-stop.mjs`**

```js
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectDir, getDataDir } from './config.mjs';

const pidFile = join(getDataDir(getProjectDir()), 'watch.pid');

if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone — nothing to do.
    }
  }
  unlinkSync(pidFile);
}
```

- [ ] **Step 3: Wire the hooks**

Read `.claude/settings.json` first. If it does not exist, create it with exactly this content. **If it does exist, merge** — append these command objects into the existing matcher `""` blocks rather than replacing anything already registered.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/scripts/hook-start.mjs\"" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/scripts/hook-stop.mjs\"" }
        ]
      }
    ]
  }
}
```

Use the literal string `$CLAUDE_PROJECT_DIR` — a shell variable that expands reliably inside `sh -c`. Do not pre-resolve it to an absolute path, and do not use `~`.

- [ ] **Step 4: Verify the hooks by hand**

```bash
node scripts/hook-start.mjs
```
Expected: returns immediately, `.claude/entirehq-watcher/watch.pid` exists, and within a few seconds watcher output appears in this terminal.

```bash
node scripts/hook-start.mjs
```
Expected: returns immediately and spawns **nothing** — one watcher, not two. Confirm with `pgrep -f watch.mjs | wc -l`, which must print `1`.

```bash
node scripts/hook-stop.mjs
```
Expected: the watcher prints `mention watcher stopped`, the PID file is gone, and `pgrep -f watch.mjs` finds nothing.

- [ ] **Step 5: Verify the full test suite and the live check**

```bash
npm test
npm run check
```
Expected: every suite passes, and the check prints real tweets with `extraction path: json`. Both must pass before this task is done.

- [ ] **Step 6: Write `README.md`**

```markdown
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
| `npm test` | Unit tests for the parse/filter/store/notify layer |
| `npm run check` | One live scrape, dry-run, notifies nobody |
| `node scripts/hook-start.mjs` | Start the watcher by hand |
| `node scripts/hook-stop.mjs` | Stop it |

## Layout

See `docs/superpowers/specs/2026-08-18-entirehq-mention-watcher-design.md` for
the design and the reasoning behind it.
```

- [ ] **Step 7: Commit**

```bash
git add scripts/hook-start.mjs scripts/hook-stop.mjs .claude/settings.json README.md
git commit -m "feat: session hooks, wiring, and readme"
```

---

## Verification checklist

The feature is complete when every one of these has been run and observed —
not reasoned about:

- [ ] `npm test` — all suites pass
- [ ] `npm run check` — prints real tweets, `extraction path: json`
- [ ] A real new mention appeared in the terminal **and** in Slack (Task 9, Step 3)
- [ ] The cold-cache baseline notified nobody (Task 9, Step 2)
- [ ] An invalid `X_AUTH_TOKEN` produced exactly one Slack alert, not one per poll (Task 9, Step 4)
- [ ] Running `hook-start.mjs` twice leaves exactly one watcher process (Task 10, Step 4)
- [ ] `hook-stop.mjs` leaves no watcher process behind (Task 10, Step 4)
