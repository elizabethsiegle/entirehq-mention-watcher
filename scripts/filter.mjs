function classify(rawTweet) {
  // Reply beats quote: a quoted reply is still a reply to something of ours,
  // which is the more actionable framing.
  if (rawTweet.inReplyToStatusId) return 'reply';
  if (rawTweet.isQuoteStatus) return 'quote';
  return 'mention';
}

export function filterAndClassify(rawTweets, ownHandle) {
  if (!Array.isArray(rawTweets)) return [];
  const own = String(ownHandle || '').replace(/^@/, '').toLowerCase();

  return rawTweets
    .filter((t) => t && typeof t === 'object' && t.id && t.author)
    .filter((t) => t.author.toLowerCase() !== own)
    .map((t) => ({
      id: t.id,
      author: t.author,
      text: t.text,
      url: t.url,
      createdAt: t.createdAt,
      kind: classify(t),
    }))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}
