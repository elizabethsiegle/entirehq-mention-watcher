import { loadConfig, loadEnvFile } from './config.mjs';
import { scrapeWatchSearches } from './search.mjs';
import { REPLY_TEXT, replyCandidates, isGithubOutage } from './reply-match.mjs';
import { prepareReply, verifyReplyAccount, withReplyPage } from './x-reply.mjs';

loadEnvFile();
const config = loadConfig({ ...process.env, X_REPLY_MODE: 'dry-run' });
const { tweets, loginWall } = await scrapeWatchSearches(config);
if (loginWall) throw new Error('X login expired');
const candidates = replyCandidates(tweets, config);
console.log(`Posting account: @${config.replyHandle}\nExact reply: ${REPLY_TEXT}`);
for (const tweet of candidates) console.log(`${tweet.url}\n  ${tweet.text.replace(/\s+/g, ' ')}`);
console.log(`${candidates.length} matching tweets from the last hour. Live activation will baseline these without replying.`);

if (process.argv.includes('--check-composer')) {
  const tweet = candidates[0]
    || tweets.find((tweet) => isGithubOutage(tweet) && tweet.author.toLowerCase() !== config.replyHandle)
    || tweets.find((tweet) => tweet.isRetweet === false && tweet.author.toLowerCase() !== config.replyHandle);
  if (!tweet) {
    await withReplyPage(config, async (page) => {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
      await verifyReplyAccount(page, config.replyHandle);
    });
    console.log('Posting account verified; no matching tweet available to check the composer.');
  } else {
    console.log(`Checking composer only on ${tweet.url}; this does not make the tweet eligible for a live reply.`);
    await withReplyPage(config, async (page) => {
      await prepareReply(page, tweet, config);
      await page.getByRole('dialog').getByTestId('tweetTextarea_0').fill('');
    });
    console.log(`Account, composer, and exact text verified on ${tweet.url}. The Post button was never clicked and the draft was cleared.`);
  }
}
console.log('No replies or Slack messages posted; no reply state written.');
