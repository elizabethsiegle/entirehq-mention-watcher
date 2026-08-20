import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadEnvFile, getProjectDir, getDataDir, ConfigError } from './config.mjs';
import { filterAndClassify } from './filter.mjs';
import {
  loadStore,
  saveStore,
  diffSeen,
  markSeen,
  setLoginWallAlerted,
  setBackoffAlerted,
  setEmptyResultsAlerted,
} from './store.mjs';
import { buildTweetMessage, buildAlertMessage, postToSlack } from './notify-slack.mjs';
import { createScorer, scoreTweet } from './score.mjs';
import { scrapeSearch } from './x-scrape.mjs';

const MAX_BACKOFF_MS = 30 * 60 * 1000;

// If a poll's raw scrape returns at least this many tweets, the result may
// have been truncated by X's own page size (roughly 20 entries per load) —
// scrapeSearch reads a single page and never scrolls. Worth a heads-up, not
// an alert: it's a visibility hint, not a failure.
const FULL_PAGE_HINT = 18;

// How many consecutive polls may scrape zero raw tweets — after a baseline
// that had previously seen at least one — before that looks like a broken
// extractor rather than a genuinely quiet account.
const EMPTY_SCRAPE_ALERT_THRESHOLD = 3;

// A broken pipe (terminal closed, Claude Code closed the inherited fd) must
// never take down this detached, unsupervised process — there's no
// supervisor to restart it, and a dead pid left in the pid file blocks
// hook-start from respawning until the next session.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const projectDir = getProjectDir();
const dataDir = getDataDir(projectDir);
loadEnvFile(projectDir);

// Mentions go to Slack and nowhere else. The operational diagnostics that used
// to print into the Claude Code terminal are appended here instead — without
// them a silent watcher would be undebuggable, and when Slack itself is the
// thing that's broken this file is the only place left to say so.
const logFile = join(dataDir, 'watch.log');

function logLine(message) {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never be the thing that kills the watcher.
  }
}

let config;
try {
  config = loadConfig();
} catch (err) {
  const message = err instanceof ConfigError ? err.message : String(err);
  logLine(`fatal: ${message}`);
  // Config failed, so there is no webhook to alert through — stderr is the
  // only channel left for a fatal startup error.
  process.stderr.write(`@entirehq mention watcher: ${message}\n`);
  process.exit(1);
}

// Register our own pid rather than relying on whoever spawned us. Under
// launchd nothing else writes this file, and the session hooks read it to
// decide whether a watcher is already up.
const pidFile = join(dataDir, 'watch.pid');
try {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pidFile, String(process.pid));
} catch {
  // A missing pid file costs a duplicate-spawn check, not correctness.
}

// Null whenever no ANTHROPIC_API_KEY is set or scoring is switched off, in
// which case mentions post exactly as they did before, minus the score line.
const scorer = config.scoringEnabled ? createScorer(config) : null;
logLine(
  scorer
    ? `urgency scoring on (${config.scoreModel})`
    : 'urgency scoring off: set ANTHROPIC_API_KEY in .env to score mentions',
);

let store = loadStore(dataDir);
let consecutiveFailures = 0;
let consecutiveEmptyScrapes = 0;
let stopped = false;
let timer = null;

async function announce(tweet) {
  // Score first, then post once. A scoring failure must never hold up the
  // mention itself, so scoreTweet swallows it and we post unscored.
  const { pressing, error } = await scoreTweet(scorer, tweet);
  if (error) logLine(`scoring failed for ${tweet.url}: ${error}. Posting unscored.`);

  const result = await postToSlack(config.slackWebhookUrl, buildTweetMessage({ ...tweet, pressing }));
  const scoreNote = pressing ? `pressing ${pressing.score} (${pressing.reason})` : 'unscored';
  if (result.ok) {
    logLine(`slack ok: @${tweet.author} ${tweet.kind} ${scoreNote} ${tweet.url}`);
  } else {
    logLine(`slack FAILED (status ${result.status}): @${tweet.author} ${tweet.url} — will retry next poll`);
  }
  return result.ok;
}

async function handleLoginWall() {
  logLine('login wall — X_AUTH_TOKEN / X_CSRF_TOKEN are stale; re-copy both cookies into .env and restart');
  if (!store.loginWallAlerted) {
    store = setLoginWallAlerted(store, true);
    saveStore(dataDir, store);
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
  if (store.loginWallAlerted) {
    store = setLoginWallAlerted(store, false);
    saveStore(dataDir, store);
  }

  // The JSON path is the healthy one. Say so out loud when we fall back, so a
  // silent degradation in extraction quality is visible rather than guessed at.
  if (source === 'dom') logLine('SearchTimeline JSON not seen — using the DOM fallback');

  if (tweets.length >= FULL_PAGE_HINT) {
    logLine(
      `scraped ${tweets.length} tweets this poll — X returns one page (~20 entries); ` +
        'this result may be truncated and some mentions from this window could be missed',
    );
  }

  // A previously non-empty baseline (some tweet was recorded at some point)
  // that suddenly scrapes zero raw tweets, repeatedly, looks like a broken
  // extractor or an exhausted Browserbase quota rather than a quiet account.
  const hadNonEmptyBaseline = store.baselined && store.seen.length > 0;
  if (tweets.length === 0 && hadNonEmptyBaseline) {
    consecutiveEmptyScrapes += 1;
  } else {
    consecutiveEmptyScrapes = 0;
    if (store.emptyResultsAlerted) {
      store = setEmptyResultsAlerted(store, false);
      saveStore(dataDir, store);
    }
  }

  if (consecutiveEmptyScrapes >= EMPTY_SCRAPE_ALERT_THRESHOLD && !store.emptyResultsAlerted) {
    store = setEmptyResultsAlerted(store, true);
    saveStore(dataDir, store);
    logLine(`${consecutiveEmptyScrapes} consecutive polls scraped zero tweets after a non-empty baseline — the extractor may be broken`);
    await postToSlack(
      config.slackWebhookUrl,
      buildAlertMessage(
        `@entirehq mention watcher has scraped zero tweets for ${consecutiveEmptyScrapes} consecutive polls after ` +
          'previously seeing mentions. Something is likely broken (extractor or Browserbase quota) — mentions are not being tracked.',
      ),
    );
  }

  const classified = filterAndClassify(tweets, config.ownHandle);
  const { isBaseline, fresh, store: nextStore } = diffSeen(store, classified);

  if (isBaseline) {
    store = nextStore;
    saveStore(dataDir, store);
    logLine(`baseline established — ${classified.length} tweets recorded, nothing announced`);
    return config.pollMs;
  }

  if (fresh.length === 0) {
    // Nothing new to announce, but ids diffSeen already folded in (e.g. from
    // this same batch) still need to be on disk.
    store = nextStore;
    saveStore(dataDir, store);
    logLine(`no new mentions (${classified.length} tracked, via ${source})`);
    return config.pollMs;
  }

  // Persist one tweet at a time, right after its announce attempt, instead
  // of marking the whole batch seen up front. The watcher is killed by a
  // SessionEnd hook every time a Claude Code session closes, so dying
  // mid-batch is routine, not exotic — if the batch were marked seen before
  // announcing, a death partway through would permanently lose the
  // unannounced remainder.
  //
  // A tweet is marked seen only once Slack has actually accepted it. Slack is
  // the sole delivery channel now, so marking a failed post as seen would drop
  // that mention permanently and silently. Leaving it unseen costs a duplicate
  // attempt next poll, which is the cheaper mistake.
  for (const tweet of fresh) {
    const delivered = await announce(tweet);
    if (delivered) {
      store = markSeen(store, tweet.id);
      saveStore(dataDir, store);
    }
  }
  return config.pollMs;
}

function backoffMs() {
  return Math.min(config.pollMs * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
}

async function loop() {
  logLine(`watcher started — polling every ${Math.round(config.pollMs / 1000)}s — slack-only — ${projectDir}`);

  while (!stopped) {
    let waitMs;
    try {
      waitMs = await pollOnce();
      consecutiveFailures = 0;
      if (store.backoffAlerted) {
        store = setBackoffAlerted(store, false);
        saveStore(dataDir, store);
      }
    } catch (err) {
      consecutiveFailures += 1;
      waitMs = backoffMs();
      logLine(`scrape failed: ${err.message} — retrying in ${Math.round(waitMs / 1000)}s`);

      if (waitMs >= MAX_BACKOFF_MS && !store.backoffAlerted) {
        store = setBackoffAlerted(store, true);
        saveStore(dataDir, store);
        logLine('scrape failures have escalated to the 30-minute backoff cap — persistent failure, not a blip');
        await postToSlack(
          config.slackWebhookUrl,
          buildAlertMessage(
            '@entirehq mention watcher has hit the maximum retry backoff after repeated scrape failures. ' +
              'Mentions are not being tracked until this recovers.',
          ),
        );
      }
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
  try {
    rmSync(pidFile, { force: true });
  } catch {
    // Best effort — a stale pid file is handled by the liveness check.
  }
  logLine('watcher stopped');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// No supervisor sits above this detached process. An uncaught exception must
// be logged and swallowed here so a one-off bug in a single poll can't kill
// the whole watcher — it should log, keep the loop alive, and definitely
// never exit(2), which would leave a dead pid in the pid file that
// hook-start won't know to replace.
process.on('uncaughtException', (err) => {
  logLine(`uncaught exception: ${err?.message ?? err}`);
});

await loop();
