import { isGithubOutage } from './reply-match.mjs';

export function githubOpportunity(tweet) {
  const text = String(tweet.text || '').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
  if (tweet.inReplyToStatusId || tweet.kind === 'reply' || tweet.isQuoteStatus || tweet.kind === 'quote' || /^@/.test(text)) return null;
  const profile = tweet.authorProfile || {};
  if (/business|government|organization/i.test(profile.verifiedType || '')) return null;
  if (/\b(?:official account|we (?:are|build|provide|help)|our (?:platform|product|customers)|news (?:outlet|updates)|status (?:page|updates))\b/i.test(`${profile.name || ''} ${profile.bio || ''}`)) return null;
  if (!/\bgithub\b/i.test(text) || tweet.isRetweet || /^RT\s+@/i.test(text)) return null;
  if (/status|outage|isdown|vendorwatch/i.test(tweet.author || '')) return null;
  if (/\b(?:resolved|recovered|back up|back online|operational|postmortem|post-mortem|yesterday|last week|last month|remember when)\b/i.test(text)) return null;
  if (/\b(?:not|never|no longer)\s+(?:currently\s+)?(?:down|unavailable)|\bno\s+(?:github\s+)?outage|\bgithub\s+was\b/i.test(text)) return null;
  if (/\b(?:imagine|what if|when|if)\s+github\b/i.test(text) && !/\b(?:wondering|checking|know|sure)\s+if\s+github\b/i.test(text)) return null;
  if (/\b(?:subscribe|status update|incident update|monitoring update|uptime report|sponsored|airdrop|giveaway)\b/i.test(text)) return null;
  if (/\b(?:would|could)\s+(?:crash|break|fail)|\bmillions of engineers\b|\b(?:joking|satire|hypothetically)\b/i.test(text)) return null;

  // Quoted outage language is not evidence that the author is experiencing it.
  const ownText = text.replace(/["“][^"”]*["”]/g, '');
  if (!/\bgithub\b/i.test(ownText)) return null;

  const alternative = /\b(?:alternative(?:s)?|replace(?:ment)?|switch(?:ing)?|mov(?:e|ing) (?:off|away)|migrat(?:e|ing))\b/i.test(text)
    && (/\b(?:looking|seeking|need|want|recommend|anyone|suggest|considering|should|ready|time to|any)\b/i.test(text)
      || /\b(?:what|which)\s+(?:(?:are|is)\s+(?:the|a|some)\s+)?github alternatives?\b/i.test(text)
      || /^github alternatives?\s*\?$/i.test(text));
  if (alternative && !/\b(?:already|finally|just)\s+(?:moved|migrated|switched)\b/i.test(text)) {
    if (/\b(?:actions|copilot|pages|packages)\b/i.test(text)) return null;
    return {
      tag: 'SEEKING ALTERNATIVE',
      summary: 'Asks about leaving GitHub or finding alternatives; an invitation to try Entire fits the request.',
      reply: 'Looking for another home for your repos? Try entire.com!',
    };
  }

  // A git host is not a substitute for a broken CI runner or coding assistant.
  if (/\b(?:actions|copilot|pages|packages|runners?|workflows?|ci\/cd)\b/i.test(text)) return null;
  const blocked = /\b(?:can['’]?t|cannot|unable to|won['’]?t|fails? to|failing to)\s+(?:git\s+)?(?:push|pull|clone|fetch|access|open|load)\b/i.test(text)
    || /\b(?:push(?:es)?|pulls?|clones?|fetch|git|repo(?:sitories|sitory|s)?|pull requests?)\b.{0,50}\b(?:failing|broken|blocked|unavailable|timing out)\b/i.test(text);
  if (blocked) return {
    tag: 'HOSTING BLOCKED',
    summary: 'Reports blocked repository work on GitHub; suggest trying Entire for repo hosting.',
    reply: 'Blocked on your repo? You could give entire.com a try!',
  };
  if (!isGithubOutage({ ...tweet, isRetweet: false })) return null;
  return {
    tag: 'GITHUB DOWN',
    summary: 'Reports or asks about GitHub being unavailable; a brief invitation to try Entire is relevant.',
    reply: 'You could give entire.com a try!',
  };
}
