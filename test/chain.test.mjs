import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAnnouncements, summarizeChain, chainIdOf, DEFAULT_CHAIN_LIMIT } from '../scripts/chain.mjs';
import { PRIORITY, ROUTINE } from '../scripts/tier.mjs';

function entry({ id = 'x', tier = ROUTINE, author = 'somedev', conversationId = 'thread-a' } = {}) {
  return {
    tweet: {
      id: String(id),
      author,
      conversationId,
      text: 'thanks!',
      url: `https://x.com/${author}/status/${id}`,
      kind: 'reply',
    },
    decision: { tier, reasons: [], score: 1 },
  };
}

function shape(plan) {
  return plan.map((item) =>
    item.type === 'post' ? `post:${item.tweet.id}` : `collapse:${item.entries.length}`,
  );
}

test('a thread under its budget posts every reply', () => {
  const plan = planAnnouncements([entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })], { limit: 3 });
  assert.deepEqual(shape(plan), ['post:1', 'post:2', 'post:3']);
});

test('the replies past the budget collapse into one summary, not one line each', () => {
  const batch = Array.from({ length: 12 }, (_, i) => entry({ id: i + 1 }));
  const plan = planAnnouncements(batch, { limit: 3 });
  assert.deepEqual(shape(plan), ['post:1', 'post:2', 'post:3', 'collapse:9']);
});

test('the summary takes the position of the first reply it swallowed', () => {
  const plan = planAnnouncements(
    [
      entry({ id: 1, conversationId: 'a' }),
      entry({ id: 2, conversationId: 'a' }),
      entry({ id: 3, conversationId: 'b' }),
    ],
    { limit: 1 },
  );
  assert.deepEqual(shape(plan), ['post:1', 'collapse:1', 'post:3']);
});

test('separate threads keep separate budgets', () => {
  const plan = planAnnouncements(
    [
      entry({ id: 1, conversationId: 'a' }),
      entry({ id: 2, conversationId: 'b' }),
      entry({ id: 3, conversationId: 'a' }),
      entry({ id: 4, conversationId: 'b' }),
    ],
    { limit: 1 },
  );
  assert.deepEqual(shape(plan), ['post:1', 'post:2', 'collapse:1', 'collapse:1']);
});

test('a budget already spent in an earlier poll is not handed back', () => {
  // The drip case: the same thread arriving two replies at a time would
  // otherwise get a fresh budget every five minutes.
  const plan = planAnnouncements(
    [entry({ id: 1, conversationId: 'a' }), entry({ id: 2, conversationId: 'a' })],
    { limit: 3, counts: { 'thread:a': 3 } },
  );
  assert.deepEqual(shape(plan), ['collapse:2']);
});

test('priority is never collapsed, however loud its thread is', () => {
  const plan = planAnnouncements(
    [
      entry({ id: 1 }),
      entry({ id: 2 }),
      entry({ id: 3 }),
      entry({ id: 4, tier: PRIORITY }),
      entry({ id: 5 }),
    ],
    { limit: 2, counts: { 'thread:thread-a': 2 } },
  );
  assert.deepEqual(shape(plan), ['collapse:4', 'post:4']);
  assert.equal(plan[1].decision.tier, PRIORITY);
});

test('priority does not spend the routine budget either', () => {
  const plan = planAnnouncements(
    [entry({ id: 1, tier: PRIORITY }), entry({ id: 2 }), entry({ id: 3 })],
    { limit: 2 },
  );
  assert.deepEqual(shape(plan), ['post:1', 'post:2', 'post:3']);
});

test('a budget of zero collapses a thread from its first routine reply', () => {
  const plan = planAnnouncements([entry({ id: 1 }), entry({ id: 2 })], { limit: 0 });
  assert.deepEqual(shape(plan), ['collapse:2']);
});

test('the default budget is applied when none is given', () => {
  const batch = Array.from({ length: DEFAULT_CHAIN_LIMIT + 1 }, (_, i) => entry({ id: i + 1 }));
  const plan = planAnnouncements(batch);
  assert.equal(plan.filter((i) => i.type === 'post').length, DEFAULT_CHAIN_LIMIT);
});

test('planAnnouncements does not mutate the counts it was given', () => {
  const counts = { 'thread:thread-a': 1 };
  planAnnouncements([entry({ id: 1 }), entry({ id: 2 })], { limit: 3, counts });
  assert.deepEqual(counts, { 'thread:thread-a': 1 });
});

test('a thread id groups by conversation, and by author when X did not give one', () => {
  assert.equal(chainIdOf({ conversationId: '123', author: 'someone' }), 'thread:123');
  assert.equal(chainIdOf({ conversationId: null, author: 'SomeDev' }), 'author:somedev');
});

test('replies in one thread from different accounts are still one thread', () => {
  const plan = planAnnouncements(
    [
      entry({ id: 1, author: 'a', conversationId: 'x' }),
      entry({ id: 2, author: 'b', conversationId: 'x' }),
      entry({ id: 3, author: 'c', conversationId: 'x' }),
    ],
    { limit: 1 },
  );
  assert.deepEqual(shape(plan), ['post:1', 'collapse:2']);
});

test('without a conversation id, one account replying over and over is one chain', () => {
  // The DOM fallback path never sees the thread id. Grouping by author is
  // what keeps a flood from that path collapsing at all.
  const plan = planAnnouncements(
    [
      entry({ id: 1, author: 'chatty', conversationId: null }),
      entry({ id: 2, author: 'chatty', conversationId: null }),
      entry({ id: 3, author: 'other', conversationId: null }),
    ],
    { limit: 1 },
  );
  assert.deepEqual(shape(plan), ['post:1', 'collapse:1', 'post:3']);
});

test('summarizeChain names who is in the thread and links its newest reply', () => {
  const entries = [
    entry({ id: 1, author: 'ann' }),
    entry({ id: 2, author: 'bob' }),
    entry({ id: 3, author: 'ann' }),
    entry({ id: 4, author: 'cat' }),
    entry({ id: 5, author: 'dan' }),
  ];
  const summary = summarizeChain(entries);
  assert.equal(summary.count, 5);
  assert.deepEqual(summary.authors, ['ann', 'bob', 'cat']);
  assert.equal(summary.moreAuthors, 1, 'a repeated author must not be counted twice');
  assert.equal(summary.url, entries[4].tweet.url);
});

test('summarizeChain reports no extra authors when they all fit', () => {
  const summary = summarizeChain([entry({ id: 1, author: 'ann' }), entry({ id: 2, author: 'bob' })]);
  assert.equal(summary.moreAuthors, 0);
});
