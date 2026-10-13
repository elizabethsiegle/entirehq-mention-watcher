export const PRIORITY_THRESHOLD = 4;

const QUESTION_RE = /\?/;
const COMPETITOR_RE = /\b(github|gitlab|bitbucket|cursor|origin|forgejo|gitea|sourcehut)\b/i;
const INTENT_RE = /\b(switch(ing|ed)?|migrat(e|ing|ed)|mov(e|ing|ed) (off|from|to)|replac(e|ing)|try(ing)?|signed up|onboard(ing)?|self-?host)\b/i;

function normalize(handle) {
  return String(handle || '').trim().replace(/^@/, '').trim().toLowerCase();
}

export function parseHandleList(raw) {
  return String(raw || '')
    .split(',')
    .map(normalize)
    .filter(Boolean);
}

// Engagement counts are deliberately absent. A mention is seen within one poll
// of being posted, when every tweet still reads 0 likes and ~20 views, so
// scoring on traction would rank everything identically at exactly the moment
// the decision has to be made. Author reach is known immediately; traction is
// not.
export function scoreTweet(tweet, { teamHandles = [] } = {}) {
  const reasons = [];
  let score = 0;

  const followers = Number(tweet.followers) || 0;
  if (followers >= 10000) {
    score += 3;
    reasons.push(`${Math.round(followers / 1000)}k followers`);
  } else if (followers >= 2000) {
    score += 2;
    reasons.push(`${(followers / 1000).toFixed(1)}k followers`);
  }

  // Someone already following @entirehq is part of the existing audience. A
  // mention from outside it is reach we do not already have.
  if (tweet.followsUs === false) {
    score += 2;
    reasons.push('not a follower');
  }

  if (QUESTION_RE.test(tweet.text || '')) {
    score += 2;
    reasons.push('question');
  }

  if (tweet.kind === 'quote') {
    score += 2;
    reasons.push('quote tweet');
  } else if (tweet.kind === 'mention') {
    score += 1;
    reasons.push('standalone mention');
  }

  if (COMPETITOR_RE.test(tweet.text || '') && INTENT_RE.test(tweet.text || '')) {
    score += 2;
    reasons.push('switching intent');
  }

  if (tweet.verified) score += 1;

  if (teamHandles.includes(normalize(tweet.author))) {
    score -= 5;
    reasons.push('team account');
  }

  return { score, reasons };
}

export function isTeam(author, teamHandles = []) {
  return teamHandles.includes(normalize(author));
}
