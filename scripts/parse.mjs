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

// X migrated the author counters out of `user.legacy` (now empty on live
// payloads) into `relationship_counts`. Both are read so an older payload
// shape, and the hand-built fixtures, keep working.
function authorSignal(tweet) {
  const user = tweet?.core?.user_results?.result ?? {};
  const followers = user?.relationship_counts?.followers ?? user?.legacy?.followers_count ?? null;
  const followedBy = user?.relationship_perspectives?.followed_by;
  return {
    followers: typeof followers === 'number' ? followers : null,
    // Whether this account follows @entirehq. Undefined means the payload did
    // not say, which must not be read as "does not follow us".
    followsUs: typeof followedBy === 'boolean' ? followedBy : null,
    verified: Boolean(user?.is_blue_verified || user?.verification?.verified),
  };
}

// X rewrites every link in `full_text` to a t.co shortlink, so the real
// destination survives only in the entities block. Reading it is what lets a
// post that links the site but never tags the account be recognized as one.
function linksOf(legacy) {
  const urls = legacy?.entities?.urls;
  if (!Array.isArray(urls)) return [];
  const links = [];
  for (const url of urls) {
    for (const value of [url?.expanded_url, url?.display_url]) {
      if (typeof value === 'string' && value) links.push(value);
    }
  }
  return links;
}

function entriesOf(payload) {
  const instructions =
    payload?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
  if (!Array.isArray(instructions)) return [];
  return instructions
    .filter((i) => i?.type === 'TimelineAddEntries' && Array.isArray(i.entries))
    .flatMap((i) => i.entries);
}

// notify-slack.mjs interpolates `author` and `id` straight into a Slack
// link construct (`<url|text>`); a value containing `|` or `>` would break
// out of that syntax. X enforces this handle/id shape server-side, so this
// is defense in depth rather than a live exploit — but the guarantee
// downstream code relies on needs to be enforced where the data enters, not
// just assumed.
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const ID_RE = /^\d+$/;

export function parseTimelineJson(payload) {
  const tweets = [];
  const seenIds = new Set();
  for (const entry of entriesOf(payload)) {
    const tweet = unwrapTweet(entry?.content?.itemContent?.tweet_results?.result);
    if (!tweet) continue;

    const id = tweet.rest_id;
    const author = screenNameOf(tweet);
    const legacy = tweet.legacy;
    if (!id || !author || !legacy) continue;
    if (!HANDLE_RE.test(author) || !ID_RE.test(String(id))) continue;

    const createdAt = toIso(legacy.created_at);
    if (!createdAt) continue;

    // X can fire more than one SearchTimeline response per navigation (and a
    // single payload can carry more than one TimelineAddEntries instruction),
    // so the same tweet can arrive twice. Without this, a duplicate inflates
    // "tracking N" / "N tracked" counts even though nothing new happened.
    const idStr = String(id);
    if (seenIds.has(idStr)) continue;
    seenIds.add(idStr);

    tweets.push({
      id: idStr,
      author,
      text: legacy.full_text ?? '',
      url: `https://x.com/${author}/status/${id}`,
      createdAt,
      links: linksOf(legacy),
      // X's id for the whole thread: the root tweet's id, shared by every
      // reply under it. It is what tells twelve replies apart from twelve
      // unrelated mentions.
      conversationId: typeof legacy.conversation_id_str === 'string' ? legacy.conversation_id_str : null,
      inReplyToStatusId: legacy.in_reply_to_status_id_str ?? null,
      isQuoteStatus: Boolean(legacy.is_quote_status),
      isRetweet: Boolean(legacy.retweeted_status_result || legacy.retweeted_status_id_str),
      ...authorSignal(tweet),
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
      // The DOM shows a link as its display text ("entire.io/blog/…"), which
      // is the only form of the destination this path can see.
      links: Array.isArray(record.links) ? record.links.filter((l) => typeof l === 'string' && l) : [],
      // The rendered page never names the thread, so chain grouping falls
      // back to the author on this path.
      conversationId: null,
      inReplyToStatusId: record.hasReplyingTo ? UNKNOWN_PARENT : null,
      isQuoteStatus: Boolean(record.hasQuotedTweet),
      isRetweet: null,
    });
  }
  return tweets;
}
