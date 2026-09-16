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

  const classified = filterAndClassify(tweets, config.ownHandle, config.employeeHandles);
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
