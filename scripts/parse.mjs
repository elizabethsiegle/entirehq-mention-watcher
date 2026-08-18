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
