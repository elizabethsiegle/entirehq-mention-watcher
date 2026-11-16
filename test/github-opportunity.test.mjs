import test from 'node:test';
import assert from 'node:assert/strict';
import { githubOpportunity } from '../scripts/github-opportunity.mjs';
import { buildTweetMessage } from '../scripts/notify-slack.mjs';
import { triage } from '../scripts/tier.mjs';

const tweet = (text, overrides = {}) => ({
  author: 'developer', text, matchedVia: 'github', kind: 'mention',
  url: 'https://x.com/developer/status/123', createdAt: '2026-11-16T00:00:00Z',
  ...overrides,
});

test('finds invitations that fit GitHub hosting pain or a request for alternatives', () => {
  const examples = [
    ['Is GitHub down for anyone else?', 'GITHUB DOWN'],
    ['GitHub is down again', 'GITHUB DOWN'],
    ["I can't push to GitHub and need to ship", 'HOSTING BLOCKED'],
    ['GitHub clones are timing out', 'HOSTING BLOCKED'],
    ['Anyone recommend a GitHub alternative for my repos?', 'SEEKING ALTERNATIVE'],
    ['Looking to move off GitHub. Any suggestions?', 'SEEKING ALTERNATIVE'],
  ];
  for (const [text, tag] of examples) assert.equal(githubOpportunity(tweet(text))?.tag, tag, text);
});

test('rejects reliability chatter and problems a git-hosting invitation does not address', () => {
  for (const text of [
    'GitHub reliability has improved', 'GitHub uptime is 99.9%',
    'GitHub Actions is down', 'GitHub Copilot unavailable again',
    'GitHub Pages is down', 'GitHub is down and CI runners are failing',
    'Looking for a GitHub Actions alternative?',
    'GitHub was down yesterday', 'GitHub outage resolved', 'GitHub is back up',
    'Imagine GitHub is down', 'If GitHub goes down we have backups',
    'GitHub is not down', 'No GitHub outage today',
    'RT @dev: GitHub is down', 'Subscribe for GitHub outage updates',
    'Just switched from GitHub to GitLab',
    '@daleverett Wait what? Is flashdive a github alternative?',
    'Zero downtime deployment https://github.com/example',
  ]) assert.equal(githubOpportunity(tweet(text)), null, text);
  assert.equal(githubOpportunity(tweet('GitHub is down', { author: 'githubstatus' })), null);
  assert.equal(githubOpportunity(tweet('GitHub is down', { author: 'outageslive' })), null);
  assert.equal(githubOpportunity(tweet('GitHub is down', { isRetweet: true })), null);
});

test('both tiers show opportunity summary, tag, original text, draft, timestamp and reply link', () => {
  for (const tier of ['routine', 'priority']) {
    const payload = buildTweetMessage(tweet("I can't push to GitHub <help>"), { tier });
    const rendered = JSON.stringify(payload);
    assert.match(payload.text, /HOSTING BLOCKED.*blocked repository work/);
    assert.match(rendered, /Reply idea:.*entire.com/);
    assert.match(rendered, /&lt;help&gt;/);
    assert.match(rendered, /View \/ reply on X/);
    assert.match(rendered, /2026-11-16T00:00:00Z/);
    assert.doesNotMatch(rendered, /entire.com is up|current disruption confirmed/);
  }
});

test('a classifier rejection suppresses GitHub prospects while preserving direct brand mentions', () => {
  const verdict = { ok: true, tier: 'IGNORE', reason: 'not a useful invitation' };
  assert.equal(triage(tweet('GitHub is down'), { verdict }).tier, 'muted');
  assert.equal(triage(tweet('@entirehq GitHub is down', { matchedVia: 'handle' }), { verdict }).tier, 'routine');
});
