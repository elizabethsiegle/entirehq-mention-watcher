import { EMPLOYEE_BADGE } from './score.mjs';

const VERB = {
  mention: 'mentioned',
  reply: 'replied to',
  quote: 'quoted',
};

const MAX_BODY = 500;
const EMPLOYEE_HEADER = '👥 ENTIRE TEAM POST';

// Slack mrkdwn treats these three as control characters. Tweet text is
// untrusted input — without this a tweet could forge a link in our channel.
export function escapeSlack(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function body(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_BODY ? `${flat.slice(0, MAX_BODY - 1)}…` : flat;
}

export function buildTweetMessage(tweet) {
  const verb = VERB[tweet.kind] ?? 'mentioned';
  const epoch = Math.floor(new Date(tweet.createdAt).getTime() / 1000);
  const handle = escapeSlack(tweet.author);
  const score = Number.isFinite(tweet.score) ? `score ${tweet.score}` : null;

  // Assembled from parts rather than interpolated in one string: a record
  // written before scoring existed has no score, and `score undefined` in the
  // channel would be worse than simply not saying it.
  const context = [`<${tweet.url}|View on X>`, tweet.kind];
  if (tweet.isEmployee) context.push(EMPLOYEE_BADGE);
  if (score) context.push(score);
  context.push(`<!date^${epoch}^{date_short_pretty} at {time}|${tweet.createdAt}>`);

  // The fallback text is what Slack shows in the notification popup, so the
  // badge has to reach it too or the whole point is lost on mobile.
  const fallback = tweet.isEmployee
    ? `${EMPLOYEE_HEADER} — @${handle} ${verb} @entirehq${score ? ` (${score})` : ''}`
    : `@${handle} ${verb} @entirehq`;

  // Context blocks are deliberately quiet in Slack. Put employee authorship
  // in a header as well, so it is visible while scanning a busy channel.
  const blocks = [];
  if (tweet.isEmployee) {
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: score ? `${EMPLOYEE_HEADER} · ${score}` : EMPLOYEE_HEADER, emoji: true },
    });
  }

  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*<https://x.com/${encodeURIComponent(tweet.author)}|@${handle}>* ${verb} @entirehq\n` +
          `>${escapeSlack(body(tweet.text))}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: context.join(' · '),
        },
      ],
    },
  );

  return {
    text: fallback,
    blocks,
  };
}

export function buildAlertMessage(text) {
  return {
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: escapeSlack(text) } }],
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves rather than rejects: the caller is a poll loop that must survive a
// bad Slack day, and the terminal has already shown the user this tweet.
export async function postToSlack(webhookUrl, payload, options = {}) {
  const { fetchImpl = fetch, retryDelayMs = 1000 } = options;
  let status = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      status = response.status;
      if (response.ok) return { ok: true, status, attempts: attempt };
    } catch {
      status = 0;
    }
    if (attempt === 1) await sleep(retryDelayMs);
  }

  return { ok: false, status, attempts: 2 };
}
