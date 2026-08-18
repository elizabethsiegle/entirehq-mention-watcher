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
