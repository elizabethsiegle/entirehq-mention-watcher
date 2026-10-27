import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../scripts/config.mjs';
import { scrapeWatchSearches, isGithubReliabilityMention } from '../scripts/search.mjs';
import { filterAndClassify } from '../scripts/filter.mjs';
import { diffSeen, markSeen } from '../scripts/store.mjs';
import { buildTweetMessage, postToSlack } from '../scripts/notify-slack.mjs';
import { planAnnouncements } from '../scripts/chain.mjs';
import { buildPrompt } from '../scripts/classify.mjs';

const config = loadConfig({
  BROWSERBASE_API_KEY: 'test', BROWSERBASE_PROJECT_ID: 'test',
  X_AUTH_TOKEN: 'test', X_CSRF_TOKEN: 'test', SLACK_WEBHOOK_URL: 'https://example.test/webhook',
});
const raw = (id, text) => ({
  id, text, author: 'dev', url: `https://x.com/dev/status/${id}`,
  createdAt: '2026-10-27T06:00:00Z', conversationId: 'thread',
});

test('GitHub results must discuss reliability in their own text, not merely link to GitHub', () => {
  assert.equal(isGithubReliabilityMention(raw('1', 'Github outage again')), true);
  assert.equal(isGithubReliabilityMention(raw('2', 'Is GITHUB down?')), true);
  assert.equal(isGithubReliabilityMention(raw('3', 'Github reliability has improved')), true);
  assert.equal(isGithubReliabilityMention(raw('4', 'Zero downtime deployments https://t.co/code')), false);
  assert.equal(isGithubReliabilityMention(raw('5', 'https://t.co/repo')), false);
});

test('GitHub query defaults cover outages and reliability, with a separate override', () => {
  assert.match(config.githubSearchQuery, /github/);
  for (const term of ['outage', 'downtime', 'reliability', 'degraded']) {
    assert.ok(config.githubSearchQuery.includes(term));
  }
  const overridden = loadConfig({
    BROWSERBASE_API_KEY: 'test', BROWSERBASE_PROJECT_ID: 'test', X_AUTH_TOKEN: 'test',
    X_CSRF_TOKEN: 'test', SLACK_WEBHOOK_URL: 'test', X_GITHUB_SEARCH_QUERY: 'github outage',
  });
  assert.equal(overridden.githubSearchQuery, 'github outage');
  assert.equal(overridden.searchQuery, config.searchQuery);
});

test('separate searches deliver GitHub tweets once with accurate labels and retry on Slack failure', async () => {
  const calls = [];
  const result = await scrapeWatchSearches(config, { scrape: async (c) => {
    calls.push(c);
    return { source: 'json', loginWall: false, tweets: c.searchQuery === config.searchQuery
      ? [raw('1', '@entirehq great'), raw('2', '@entirehq github outage')]
      : [raw('2', '@entirehq github outage'), raw('3', 'GitHub is down again')] };
  } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => new URL(c.searchUrl).searchParams.get('q')),
    [config.searchQuery, config.githubSearchQuery]);
  const store = { seen: ['1'], baselined: true };
  const { fresh } = diffSeen(store, filterAndClassify(result.tweets, config));
  assert.deepEqual(fresh.map((t) => t.id), ['2', '3']);
  const github = fresh.find((t) => t.id === '3');
  assert.equal(github.matchedVia, 'github');
  assert.match(buildPrompt(github), /Matched: GitHub outage\/reliability search/);
  const payload = buildTweetMessage(github, { tier: 'routine' });
  assert.match(payload.text, /discussed GitHub reliability/);
  assert.match(JSON.stringify(payload.blocks), /GitHub reliability/);
  assert.doesNotMatch(JSON.stringify(payload), /mentioned @entirehq/);
  const failed = await postToSlack(config.slackWebhookUrl, payload, {
    fetchImpl: async () => ({ ok: false, status: 503 }), retryDelayMs: 0,
  });
  assert.equal(failed.ok, false);
  assert.equal(diffSeen(store, [github]).fresh.length, 1);
  const delivered = await postToSlack(config.slackWebhookUrl, payload, {
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(delivered.ok, true);
  assert.equal(diffSeen(markSeen(store, github.id), [github]).fresh.length, 0);
});

test('GitHub tweets keep their individual Slack posts even when a thread budget is exhausted', () => {
  const tweets = filterAndClassify([raw('1', 'github down'), raw('2', 'github unreliable')]
    .map((t) => ({ ...t, searchTopic: 'github' })), config);
  const plan = planAnnouncements(tweets.map((tweet) => ({ tweet, decision: { tier: 'routine' } })), { limit: 0 });
  assert.deepEqual(plan.map((p) => p.type), ['post', 'post']);
});

test('login walls on either search are surfaced', async () => {
  const result = await scrapeWatchSearches(config, { scrape: async (c) => ({
    source: 'dom', tweets: [], loginWall: c.searchQuery === config.githubSearchQuery,
  }) });
  assert.equal(result.loginWall, true);
});

test('failed searches identify the affected monitor and do not look like empty results', async () => {
  await assert.rejects(scrapeWatchSearches(config, { scrape: async (c) => {
    if (c.searchQuery === config.githubSearchQuery) throw new Error('quota exceeded');
    return { source: 'json', tweets: [], loginWall: false };
  } }), /GitHub reliability search failed: quota exceeded/);
});
