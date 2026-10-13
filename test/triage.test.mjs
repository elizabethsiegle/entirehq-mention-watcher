import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreTweet, parseHandleList, PRIORITY_THRESHOLD } from '../scripts/score.mjs';
import { triage, decideTier, PRIORITY, ROUTINE, MUTED } from '../scripts/tier.mjs';

function tweet(over = {}) {
  return {
    id: '1', author: 'somedev', text: 'neat', url: 'https://x.com/somedev/status/1',
    createdAt: new Date().toISOString(), kind: 'reply',
    followers: 100, followsUs: true, verified: false, ...over,
  };
}

test('parseHandleList normalizes @ and case and drops blanks', () => {
  assert.deepEqual(parseHandleList('@Lizziepika, BlackGirlBytes ,, '), ['lizziepika', 'blackgirlbytes']);
});

test('parseHandleList on empty input is an empty list', () => {
  assert.deepEqual(parseHandleList(undefined), []);
  assert.deepEqual(parseHandleList(''), []);
});

test('a large account scores for reach', () => {
  assert.equal(scoreTweet(tweet({ followers: 17388 })).score, 3);
});

test('a non-follower scores for reach we do not already have', () => {
  const { score, reasons } = scoreTweet(tweet({ followsUs: false }));
  assert.equal(score, 2);
  assert.ok(reasons.includes('not a follower'));
});

test('an unknown follow relationship is not treated as a non-follower', () => {
  assert.equal(scoreTweet(tweet({ followsUs: null })).score, 0);
});

test('a question scores', () => {
  assert.ok(scoreTweet(tweet({ text: 'does this work with self-hosted runners?' })).score >= 2);
});

test('switching intent needs both a competitor and an intent verb', () => {
  assert.ok(scoreTweet(tweet({ text: 'migrating off github to entire' })).reasons.includes('switching intent'));
  assert.ok(!scoreTweet(tweet({ text: 'github is down again' })).reasons.includes('switching intent'));
});

test('a team account is scored down hard', () => {
  assert.ok(scoreTweet(tweet({ author: 'lizziepika', followers: 17388 }), { teamHandles: ['lizziepika'] }).score < 0);
});

test('a muted handle is muted before anything else runs', () => {
  const r = triage(tweet({ author: 'lizziepika' }), { mutedHandles: ['lizziepika'] });
  assert.equal(r.tier, MUTED);
});

test('muting is case and @ insensitive', () => {
  assert.equal(triage(tweet({ author: 'LizziePika' }), { mutedHandles: parseHandleList('@lizziepika') }).tier, MUTED);
});

test('a teammate reply is always routine, however high it scores', () => {
  const r = triage(
    tweet({ author: 'blackgirlbytes', followers: 50000, followsUs: false, text: 'how do I do X?' }),
    { teamHandles: ['blackgirlbytes'] },
  );
  assert.equal(r.tier, ROUTINE);
});

test('an LLM PRIORITY verdict promotes a low-scoring mention', () => {
  const r = triage(tweet({ followers: 80 }), { verdict: { ok: true, tier: 'PRIORITY', reason: 'support question' } });
  assert.equal(r.tier, PRIORITY);
  assert.ok(r.score < PRIORITY_THRESHOLD, 'precondition: score alone would not promote');
});

test('an LLM IGNORE verdict demotes a high-scoring mention', () => {
  const r = triage(
    tweet({ followers: 50000, followsUs: false, text: 'airdrop?' }),
    { verdict: { ok: true, tier: 'IGNORE', reason: 'crypto spam' } },
  );
  assert.equal(r.tier, ROUTINE);
});

test('IGNORE demotes but never drops, so a misfire stays visible', () => {
  const r = triage(tweet(), { verdict: { ok: true, tier: 'IGNORE', reason: 'spam' } });
  assert.notEqual(r.tier, MUTED);
});

test('a failed classifier falls back to the score, still promoting a strong mention', () => {
  const r = triage(
    tweet({ followers: 17388, followsUs: false, text: 'does entire support self-hosted runners?' }),
    { verdict: { ok: false, error: 'timeout' } },
  );
  assert.equal(r.tier, PRIORITY);
});

test('a failed classifier leaves a weak mention routine', () => {
  assert.equal(triage(tweet({ followers: 10 }), { verdict: { ok: false, error: 'timeout' } }).tier, ROUTINE);
});

test('no classifier at all behaves exactly like a failed one', () => {
  const strong = { followers: 17388, followsUs: false, text: 'how do I migrate from github?' };
  assert.equal(triage(tweet(strong), { verdict: null }).tier, triage(tweet(strong), { verdict: { ok: false } }).tier);
});

test('the LLM reason is carried into the displayed reasons', () => {
  const r = triage(tweet(), { verdict: { ok: true, tier: 'PRIORITY', reason: 'asks about pricing' } });
  assert.ok(r.reasons.includes('asks about pricing'));
});

test('decideTier does not mutate the reasons array it is given', () => {
  const reasons = ['question'];
  decideTier({ tweet: tweet(), score: 9, reasons, verdict: { ok: true, tier: 'PRIORITY', reason: 'x' } });
  assert.deepEqual(reasons, ['question']);
});

test('an explicit ROUTINE verdict is not overridden by a high score', () => {
  // Regression: reach alone promoted emoji tag-chain replies the classifier
  // had already judged routine.
  const r = triage(
    tweet({ author: 'someone', followers: 2292, followsUs: false, kind: 'mention' }),
    { verdict: { ok: true, tier: 'ROUTINE', reason: 'emoji-only tag reply' } },
  );
  assert.ok(r.score >= PRIORITY_THRESHOLD, 'precondition: score alone would promote');
  assert.equal(r.tier, ROUTINE);
});

test('a PRIORITY verdict still wins over a zero score', () => {
  const r = triage(
    tweet({ followers: 5, followsUs: true }),
    { verdict: { ok: true, tier: 'PRIORITY', reason: 'support question' } },
  );
  assert.equal(r.tier, PRIORITY);
});
