export const MATCH_HANDLE = 'handle';
export const MATCH_LINK = 'link';
export const MATCH_BOTH = 'both';

function classify(rawTweet) {
  // Reply beats quote: a quoted reply is still a reply to something of ours,
  // which is the more actionable framing.
  if (rawTweet.inReplyToStatusId) return 'reply';
  if (rawTweet.isQuoteStatus) return 'quote';
  return 'mention';
}

// The search asks for the handle OR the domain, so a result can arrive for
// either reason and the two read differently downstream: "replied to
// @entirehq" is wrong for a post that only shared a link.
//
// Neither signal present means the match came from something this record
// cannot see. The DOM path drops the "Replying to @entirehq" prefix from the
// tweet body, for one. Handle is the right answer there: it is what every
// result meant before the domain joined the query.
function matchedVia(rawTweet, own, domain) {
  const text = String(rawTweet.text || '').toLowerCase();
  const links = (Array.isArray(rawTweet.links) ? rawTweet.links : []).join(' ').toLowerCase();

  const byLink = Boolean(domain) && (links.includes(domain) || text.includes(domain));
  const byHandle = Boolean(own) && text.includes(`@${own}`);

  if (byLink && byHandle) return MATCH_BOTH;
  if (byLink) return MATCH_LINK;
  return MATCH_HANDLE;
}

export function filterAndClassify(rawTweets, { ownHandle, brandDomain } = {}) {
  if (!Array.isArray(rawTweets)) return [];
  const own = String(ownHandle || '').replace(/^@/, '').toLowerCase();
  const domain = String(brandDomain || '').toLowerCase();

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
    .map((t) => ({
      id: t.id,
      author: t.author,
      text: t.text,
      url: t.url,
      createdAt: t.createdAt,
      kind: classify(t),
      matchedVia: matchedVia(t, own, domain),
      conversationId: t.conversationId ?? null,
      followers: t.followers ?? null,
      followsUs: t.followsUs ?? null,
      verified: t.verified ?? false,
    }))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}
