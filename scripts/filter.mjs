import { normalizeHandles, scoreTweet } from './score.mjs';

function classify(rawTweet) {
  // Reply beats quote: a quoted reply is still a reply to something of ours,
  // which is the more actionable framing.
  if (rawTweet.inReplyToStatusId) return 'reply';
  if (rawTweet.isQuoteStatus) return 'quote';
  return 'mention';
}

export function filterAndClassify(rawTweets, ownHandle, employeeHandles) {
  if (!Array.isArray(rawTweets)) return [];
  const own = String(ownHandle || '').replace(/^@/, '').toLowerCase();

  // Normalize the roster once per call rather than once per tweet: this runs
  // over a whole page of scraped results every poll.
  const employees =
    employeeHandles === undefined ? undefined : normalizeHandles(employeeHandles);

  return rawTweets
    .filter((t) => {
      return (
        t &&
        typeof t === 'object' &&
        t.id &&
        t.author &&
        typeof t.text === 'string' &&
        typeof t.url === 'string' &&
        t.url &&
        !Number.isNaN(new Date(t.createdAt).getTime())
      );
    })
    .filter((t) => t.author.toLowerCase() !== own)
    .map((t) => {
      const { score, isEmployee } = scoreTweet(t, employees);
      return {
        id: t.id,
        author: t.author,
        text: t.text,
        url: t.url,
        createdAt: t.createdAt,
        kind: classify(t),
        score,
        isEmployee,
      };
    })
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}
