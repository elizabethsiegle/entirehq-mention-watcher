import { PRIORITY_THRESHOLD, scoreTweet, isTeam } from './score.mjs';

export const PRIORITY = 'priority';
export const ROUTINE = 'routine';
export const MUTED = 'muted';

// The two signals answer different questions and neither subsumes the other:
// the score measures reach (how many people see this), the classifier measures
// intent (is this worth answering). Either one alone mis-ranks a common case —
// a thoughtful support question from a 200-follower account, or an emoji reply
// from someone with 40k.
export function decideTier({ tweet, score, reasons, verdict, mutedHandles = [], teamHandles = [] }) {
  if (isTeam(tweet.author, mutedHandles)) {
    return { tier: MUTED, reasons: ['muted account'], verdict: null };
  }

  const onTeam = isTeam(tweet.author, teamHandles);
  const llm = verdict?.ok ? verdict.tier : null;
  const combined = [...reasons];
  if (verdict?.ok && verdict.reason) combined.push(verdict.reason);

  // A team member's own reply is a receipt, never a call to action.
  if (onTeam) return { tier: ROUTINE, reasons: combined, verdict: llm };

  // A verdict wins whenever the classifier actually read the text. The score
  // measures reach, and reach does not make an emoji reply worth answering —
  // letting a high score override an explicit ROUTINE put eleven emoji
  // tag-chain replies from one 2.2k-follower account into priority on the
  // first live run. IGNORE is demoted rather than dropped: a false negative on
  // a real support question would be invisible, and silence is the one failure
  // this tool exists to prevent.
  if (llm === 'ROUTINE' || llm === 'IGNORE') return { tier: ROUTINE, reasons: combined, verdict: llm };

  if (llm === 'PRIORITY') return { tier: PRIORITY, reasons: combined, verdict: llm };

  // No usable verdict (classifier off, errored, or timed out): the score
  // decides alone. This is the degraded path and it is meant to still work.
  if (score >= PRIORITY_THRESHOLD) return { tier: PRIORITY, reasons: combined, verdict: llm };

  return { tier: ROUTINE, reasons: combined, verdict: llm };
}

export function triage(tweet, { mutedHandles = [], teamHandles = [], verdict = null } = {}) {
  const { score, reasons } = scoreTweet(tweet, { teamHandles });
  return { ...decideTier({ tweet, score, reasons, verdict, mutedHandles, teamHandles }), score };
}
