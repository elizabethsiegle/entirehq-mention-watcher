export const REPLY_TEXT = '@goentire is up. entire.com';
export const MAX_REPLY_AGE_MS = 60 * 60 * 1000;

export function isGithubOutage(tweet) {
  const text = String(tweet.text || '').replace(/https?:\/\/\S+/gi, '');
  if (tweet.isRetweet !== false || /^RT\s+@/i.test(text)) return false;
  if (!/\bgithub\b/i.test(text)) return false;
  if (/\b(?:not|never|no longer)\s+(?:currently\s+)?(?:down|unavailable|having an outage)\b|\bno\s+(?:github\s+)?outage|\b(?:when|imagine|what if)\s+github\b|\b(?:back up|resolved|recovered)\b/i.test(text)) return false;
  if (/\bif\s+github\b/i.test(text) && !/\b(?:asking|wondering|know|checking|check|see|sure)\s+if\s+github\b/i.test(text)) return false;

  const service = 'github(?:\\s+(?:actions|api|pages|packages|copilot))?';
  return new RegExp(`\\b${service}(?:['’]s)?\\s+(?:(?:is|was|has|seems|looks|went|gone|going|currently|still|apparently|to|be)\\s+){0,4}(?:down|unavailable|degraded)\\b(?!\\s+(?:to|the)\\b)`, 'i').test(text)
    || new RegExp(`\\b${service}(?:['’]s)?\\s+(?:(?:is|was|has|having|experiencing|suffering|from|a|an|another|major|new|current|ongoing|global|partial|service)\\s+){0,6}(?:outages?|downtime)\\b`, 'i').test(text)
    || /\b(?:outages?|downtime)\s+(?:(?:on|at|of|with|for|affecting)\s+)?github\b/i.test(text);
}

export function replyCandidates(tweets, config, { since = 0, now = Date.now() } = {}) {
  const excluded = new Set([config.replyHandle, config.ownHandle, ...(config.mutedHandles || [])]
    .map((handle) => String(handle || '').replace(/^@/, '').toLowerCase()));
  const unique = new Map();
  for (const tweet of tweets) {
    const created = Date.parse(tweet.createdAt);
    if (!/^\d+$/.test(tweet.id) || !/^[a-z0-9_]{1,15}$/i.test(tweet.author)) continue;
    if (!Number.isFinite(created) || created <= since || created > now || now - created > MAX_REPLY_AGE_MS) continue;
    if (excluded.has(tweet.author.toLowerCase()) || !isGithubOutage(tweet)) continue;
    unique.set(tweet.id, tweet);
  }
  return [...unique.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
