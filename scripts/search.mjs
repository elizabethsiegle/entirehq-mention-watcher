import { scrapeSearch } from './x-scrape.mjs';
import { githubOpportunity } from './github-opportunity.mjs';

const MAX_TWEET_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export function isGithubReliabilityMention(tweet) {
  const text = String(tweet.text || '');
  return /github/i.test(text) && /\b(outages?|down|downtime|reliability|unreliable|unavailable|degraded)\b/i.test(text);
}

export async function scrapeWatchSearches(config, { scrape = scrapeSearch, now = Date.now() } = {}) {
  const queries = [
    { name: 'Entire', query: config.searchQuery },
    { name: 'GitHub reliability', query: config.githubSearchQuery },
  ];
  const results = await Promise.all(queries.map(async ({ name, query }) => {
    try {
      const result = await scrape({
        ...config,
        searchQuery: query,
        searchUrl: `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`,
      });
      return { ...result, name, query };
    } catch (err) {
      throw new Error(`${name} search failed: ${err.message}`, { cause: err });
    }
  }));

  return {
    source: results.map((r) => `${r.name}:${r.source}`).join(', '),
    loginWall: results.some((r) => r.loginWall),
    tweets: results.flatMap((r) => r.tweets
      .filter((tweet) => {
        const createdAt = Date.parse(tweet.createdAt);
        return createdAt >= now - MAX_TWEET_AGE_MS && createdAt <= now;
      })
      .filter((tweet) => r.name !== 'GitHub reliability' || githubOpportunity(tweet))
      .map((tweet) => ({
        ...tweet,
        searchTopic: r.name === 'GitHub reliability' ? 'github' : null,
      }))),
    searches: results,
  };
}
