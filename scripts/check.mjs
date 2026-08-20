// One live scrape, printed, notifying nobody. This is the manual gate before
// the watcher is considered working.
import { loadConfig, loadEnvFile, getProjectDir, ConfigError } from './config.mjs';
import { filterAndClassify } from './filter.mjs';
import { formatTweet, printWarning, printQuiet } from './notify-terminal.mjs';
import { scrapeSearch } from './x-scrape.mjs';
import { createScorer, scoreTweet } from './score.mjs';

// A dry run should show what the score looks like without spending a call per
// tweet on a full page of history.
const SCORE_LIMIT = 5;

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

  const scorer = config.scoringEnabled ? createScorer(config) : null;
  if (!scorer) {
    printQuiet('urgency scoring off: set ANTHROPIC_API_KEY in .env to score mentions');
  } else {
    printQuiet(`scoring the ${Math.min(SCORE_LIMIT, classified.length)} most recent with ${config.scoreModel}`);
    if (classified.length > SCORE_LIMIT) {
      printQuiet(
        `the other ${classified.length - SCORE_LIMIT} will print unscored (dry-run cap only, ` +
          'the watcher scores every new mention)',
      );
    }
  }

  // Newest last in the printed list, so the scored ones are the tail.
  const toScore = new Set(classified.slice(-SCORE_LIMIT));
  const scored = [];
  for (const tweet of classified) {
    if (!scorer || !toScore.has(tweet)) {
      scored.push(tweet);
      continue;
    }
    const { pressing, error } = await scoreTweet(scorer, tweet);
    if (error) printWarning(`scoring failed for ${tweet.url}: ${error}`);
    scored.push({ ...tweet, pressing });
  }

  console.log('');
  for (const tweet of scored) console.log(formatTweet(tweet));
  console.log(`\nLooks healthy. ${classified.length} tweets would be tracked.`);
} catch (err) {
  printWarning(`scrape failed: ${err.message}`);
  process.exit(1);
}
