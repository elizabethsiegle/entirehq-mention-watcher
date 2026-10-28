import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadEnvFile, getProjectDir, getDataDir, ConfigError } from './config.mjs';
import { filterAndClassify } from './filter.mjs';
import {
  loadStore,
  saveStore,
  diffSeen,
  markSeen,
  chainCounts,
  recordChainPost,
  setLoginWallAlerted,
  setBackoffAlerted,
  setEmptyResultsAlerted,
} from './store.mjs';
import {
  buildTweetMessage,
  buildChainMessage,
  buildAlertMessage,
  postToSlack,
} from './notify-slack.mjs';
import { planAnnouncements, summarizeChain } from './chain.mjs';
import { scrapeWatchSearches } from './search.mjs';
import { triage, MUTED, PRIORITY } from './tier.mjs';
import { classify, createClient } from './classify.mjs';
import { processReplies } from './replies.mjs';
import { fetchGithubStatus, describeGithubStatus } from './github-status.mjs';

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

const anthropic = createClient(config.anthropicApiKey);
if (!anthropic) {
  logLine('ANTHROPIC_API_KEY not set — triage runs on the deterministic score alone');
}

let store = loadStore(dataDir);
let consecutiveFailures = 0;
let consecutiveEmptyScrapes = 0;
let stopped = false;
let timer = null;
let wakeUp = null;
let replyFailureAlerted = false;

async function handleReplies(tweets) {
  try {
    await processReplies(tweets, config, {
      dataDir,
      shouldStop: () => stopped,
      log: logLine,
      alert: (message) => postToSlack(config.slackWebhookUrl, buildAlertMessage(message)),
    });
    replyFailureAlerted = false;
  } catch (error) {
    logLine(`replies paused: ${error.message}`);
    if (!replyFailureAlerted) {
      replyFailureAlerted = true;
      await postToSlack(config.slackWebhookUrl, buildAlertMessage(`Auto-replies paused: ${error.message}. Slack monitoring continues.`));
    }
  }
}

// Returns the tier decision, or null for a muted account. Muting is resolved
// before any API call so a muted handle costs nothing to skip.
async function decideOn(tweet) {
  const pre = triage(tweet, { mutedHandles: config.mutedHandles, teamHandles: config.teamHandles });
  if (pre.tier === MUTED) {
    logLine(`muted: @${tweet.author} ${tweet.url}`);
    return null;
  }

  const verdict = anthropic ? await classify(tweet, { client: anthropic }) : null;
  if (verdict && !verdict.ok) logLine(`triage degraded (${verdict.error}) — score only`);

  return triage(tweet, {
    mutedHandles: config.mutedHandles,
    teamHandles: config.teamHandles,
    verdict,
  });
}

async function announce(tweet, decision) {
  const result = await postToSlack(
    config.slackWebhookUrl,
    buildTweetMessage(tweet, decision, { handle: config.ownHandle, domain: config.brandDomain }),
  );
  const label = `${decision.tier}${decision.tier === PRIORITY ? ' \u2605' : ''} score=${decision.score}`;
  if (result.ok) {
    logLine(`slack ok [${label}]: @${tweet.author} ${tweet.kind} ${tweet.url}`);
  } else {
    logLine(`slack FAILED (status ${result.status}) [${label}]: @${tweet.author} ${tweet.url} — will retry next poll`);
  }
  return result.ok;
}

async function announceChain(chainId, entries) {
  const summary = summarizeChain(entries);
  const result = await postToSlack(config.slackWebhookUrl, buildChainMessage(summary));
  if (result.ok) {
    logLine(`slack ok [chain]: ${summary.count} collapsed from ${chainId}`);
  } else {
    logLine(
      `slack FAILED (status ${result.status}) [chain]: ${summary.count} from ${chainId} — will retry next poll`,
    );
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
  const { source, tweets, loginWall, searches } = await scrapeWatchSearches(config);

  if (loginWall) {
    await handleLoginWall();
    return { waitMs: MAX_BACKOFF_MS, tweets: null };
  }
  if (store.loginWallAlerted) {
    store = setLoginWallAlerted(store, false);
    saveStore(dataDir, store);
  }

  // The JSON path is the healthy one. Say so out loud when we fall back, so a
  // silent degradation in extraction quality is visible rather than guessed at.
  for (const search of searches) {
    logLine(`${search.name}: ${search.tweets.length} tweets via ${search.source}`);
    if (search.source === 'dom') logLine(`${search.name}: SearchTimeline JSON not seen — using the DOM fallback`);

    if (search.tweets.length >= FULL_PAGE_HINT) {
      logLine(
        `${search.name}: scraped ${search.tweets.length} tweets this poll — X returns one page (~20 entries); ` +
          'this result may be truncated and some mentions from this window could be missed',
      );
    }
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

  const classified = filterAndClassify(tweets, config);
  const { isBaseline, fresh, store: nextStore } = diffSeen(store, classified);

  if (isBaseline) {
    store = nextStore;
    saveStore(dataDir, store);
    logLine(`baseline established — ${classified.length} tweets recorded, nothing announced`);
    return { waitMs: config.pollMs, tweets };
  }

  if (fresh.length === 0) {
    // Nothing new to announce, but ids diffSeen already folded in (e.g. from
    // this same batch) still need to be on disk.
    store = nextStore;
    saveStore(dataDir, store);
    logLine(`no new mentions (${classified.length} tracked, via ${source})`);
    return { waitMs: config.pollMs, tweets };
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
  const decided = [];
  for (const tweet of fresh) {
    const decision = await decideOn(tweet);
    if (!decision) {
      store = markSeen(store, tweet.id);
      saveStore(dataDir, store);
      continue;
    }
    decided.push({ tweet, decision });
  }

  // Tiers are known before anything is posted, which is what lets a thread
  // past its budget collapse into one line without risking a priority
  // mention. It costs no extra classifier calls: every fresh mention was
  // already being classified one at a time.
  const plan = planAnnouncements(decided, {
    counts: chainCounts(store),
    limit: config.chainLimit,
  });

  for (const item of plan) {
    if (item.type === 'post') {
      if (!(await announce(item.tweet, item.decision))) continue;
      store = markSeen(store, item.tweet.id);
      // Charged only after Slack accepts it, so a bad Slack day cannot spend
      // a thread's budget on posts nobody saw.
      if (item.chainId) store = recordChainPost(store, item.chainId);
      saveStore(dataDir, store);
      continue;
    }

    if (!(await announceChain(item.chainId, item.entries))) continue;
    // The summary is the delivery for every mention in it, so they are only
    // seen once it lands.
    for (const entry of item.entries) store = markSeen(store, entry.tweet.id);
    saveStore(dataDir, store);
  }
  return { waitMs: config.pollMs, tweets };
}

function backoffMs() {
  return Math.min(config.pollMs * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
}

async function loop() {
  logLine(`watcher started — polling every ${Math.round(config.pollMs / 1000)}s — ${projectDir}`);
  logLine(`auto-replies: ${config.replyMode}${config.replyHandle ? ` as @${config.replyHandle}` : ''}`);
  logLine(`search query: ${config.searchQuery}`);
  logLine(`GitHub reliability query: ${config.githubSearchQuery}`);
  logLine(`thread budget: ${config.chainLimit} individual posts per thread per 6h, then one summary line per poll`);

  while (!stopped) {
    let waitMs;
    const githubStatus = await fetchGithubStatus();
    logLine(describeGithubStatus(githubStatus));
    if (stopped) break;
    try {
      const batch = await pollOnce();
      waitMs = batch.waitMs;
      if (batch.tweets && !stopped) await handleReplies(batch.tweets);
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
      wakeUp = resolve;
      timer = setTimeout(resolve, waitMs);
    });
    timer = null;
    wakeUp = null;
  }
}

function shutdown() {
  stopped = true;
  if (timer) clearTimeout(timer);
  wakeUp?.();
  logLine('shutdown requested — finishing the current poll');
}

function finishShutdown() {
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
finishShutdown();
