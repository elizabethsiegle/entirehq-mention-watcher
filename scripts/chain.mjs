import { ROUTINE } from './tier.mjs';
import { MATCH_GITHUB } from './filter.mjs';

export const DEFAULT_CHAIN_LIMIT = 3;

// One account thanking twelve people one reply at a time is twelve mentions
// and one thread. X gives every reply under a tweet the same
// conversation_id_str, which is the only reliable way to tell those apart
// from twelve unrelated mentions.
//
// The DOM fallback path never sees that id. Grouping by author there is not
// the same thing, but in the case that matters it collapses the same posts:
// a chain flood is almost always one account replying over and over.
export function chainIdOf(tweet) {
  if (tweet?.conversationId) return `thread:${tweet.conversationId}`;
  return `author:${String(tweet?.author || '').toLowerCase()}`;
}

// Decides which of this batch's mentions get their own Slack post and which
// are summarized as a count. `counts` is what each thread has already spent
// inside the store's window, so a thread cannot restart its budget by
// arriving in pieces.
//
// Priority is never collapsed and never charged: the budget exists to keep
// the channel readable, and a channel nobody reads is worse than a loud one,
// but losing one actionable mention is worse than both.
export function planAnnouncements(decided, { counts = {}, limit = DEFAULT_CHAIN_LIMIT } = {}) {
  const spent = { ...counts };
  const plan = [];
  const buckets = new Map();

  for (const entry of decided) {
    if (entry?.decision?.tier !== ROUTINE || entry?.tweet?.matchedVia === MATCH_GITHUB) {
      plan.push({ type: 'post', ...entry });
      continue;
    }

    const chainId = chainIdOf(entry.tweet);
    const used = spent[chainId] ?? 0;

    if (used < limit) {
      spent[chainId] = used + 1;
      plan.push({ type: 'post', chainId, ...entry });
      continue;
    }

    let bucket = buckets.get(chainId);
    if (!bucket) {
      // The summary takes the position of the thread's first collapsed
      // mention, so the channel keeps the order things happened in.
      bucket = { type: 'collapse', chainId, entries: [] };
      buckets.set(chainId, bucket);
      plan.push(bucket);
    }
    bucket.entries.push(entry);
  }

  return plan;
}

const MAX_NAMED_AUTHORS = 3;

// "9 more replies in this thread" needs to say whose thread it is, or the
// reader has to open it to find out whether it concerns them.
export function summarizeChain(entries) {
  const tweets = entries.map((e) => e.tweet);
  const authors = [...new Set(tweets.map((t) => t.author))];
  const named = authors.slice(0, MAX_NAMED_AUTHORS);
  const rest = authors.length - named.length;
  return {
    count: tweets.length,
    authors: named,
    moreAuthors: rest > 0 ? rest : 0,
    // The newest one: whoever opens this wants to land on the live end of
    // the thread, not where it started.
    url: tweets[tweets.length - 1].url,
  };
}
