// X ships more than one shape for the same data, so every accessor here is
// defensive: an entry we cannot read is skipped, never thrown on. Returning a
// short list is recoverable; crashing the poll loop is not.

function toIso(twitterDate) {
  // X sends "Tue Aug 18 14:02:11 +0000 2026", which Date parses correctly.
  const parsed = new Date(twitterDate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function unwrapTweet(result) {
  if (!result || typeof result !== 'object') return null;
  // TweetWithVisibilityResults nests the real tweet one level down.
  const tweet = result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
  if (!tweet || typeof tweet !== 'object') return null;
  return tweet;
}

function screenNameOf(tweet) {
  const user = tweet?.core?.user_results?.result;
  // Newer payloads put it under `core`, older ones under `legacy`.
  return user?.core?.screen_name || user?.legacy?.screen_name || null;
}

function entriesOf(payload) {
  const instructions =
    payload?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
  if (!Array.isArray(instructions)) return [];
  return instructions
    .filter((i) => i?.type === 'TimelineAddEntries' && Array.isArray(i.entries))
    .flatMap((i) => i.entries);
}

export function parseTimelineJson(payload) {
  const tweets = [];
  for (const entry of entriesOf(payload)) {
    const tweet = unwrapTweet(entry?.content?.itemContent?.tweet_results?.result);
    if (!tweet) continue;

    const id = tweet.rest_id;
    const author = screenNameOf(tweet);
    const legacy = tweet.legacy;
    if (!id || !author || !legacy) continue;

    const createdAt = toIso(legacy.created_at);
    if (!createdAt) continue;

    tweets.push({
      id: String(id),
      author,
      text: legacy.full_text ?? '',
      url: `https://x.com/${author}/status/${id}`,
      createdAt,
      inReplyToStatusId: legacy.in_reply_to_status_id_str ?? null,
      isQuoteStatus: Boolean(legacy.is_quote_status),
    });
  }
  return tweets;
}

const STATUS_PATH_RE = /^(?:https?:\/\/(?:x|twitter)\.com)?\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;

// The DOM path can see that a "Replying to" block was rendered but not which
// status is being replied to. This sentinel says "a parent exists, identity
// unknown" — filter.mjs only ever checks presence, never the value.
export const UNKNOWN_PARENT = 'unknown';

export function parseDomRecords(records) {
  if (!Array.isArray(records)) return [];
  const tweets = [];
  const seen = new Set();

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;

    const match = typeof record.permalink === 'string' && record.permalink.match(STATUS_PATH_RE);
    if (!match) continue;
    const [, pathAuthor, id] = match;

    if (seen.has(id)) continue;

    const createdAt = typeof record.datetime === 'string' ? toIso(record.datetime) : null;
    if (!createdAt) continue;

    // Prefer the permalink's author: the rendered handle can belong to a
    // quoted or retweeting account rather than the tweet's own author.
    const author = pathAuthor;

    seen.add(id);
    tweets.push({
      id,
      author,
      text: typeof record.text === 'string' ? record.text : '',
      url: `https://x.com/${author}/status/${id}`,
      createdAt,
      inReplyToStatusId: record.hasReplyingTo ? UNKNOWN_PARENT : null,
      isQuoteStatus: Boolean(record.hasQuotedTweet),
    });
  }
  return tweets;
}
