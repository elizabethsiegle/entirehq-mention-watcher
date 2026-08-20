import { bandFor } from './score.mjs';

const VERB = {
  mention: 'mentioned',
  reply: 'replied to',
  quote: 'quoted',
};

const MAX_BODY = 500;

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

// A scored tweet or nothing. One guard for both the score line and the
// notification prefix, so they can never disagree about whether a score
// exists (a score of 0 is a real score, and must survive this).
function readPressing(pressing) {
  if (!pressing || typeof pressing.score !== 'number' || !Number.isFinite(pressing.score)) return null;
  return {
    score: pressing.score,
    band: bandFor(pressing.score),
    reason: escapeSlack(String(pressing.reason ?? '').trim()),
  };
}

export function buildTweetMessage(tweet) {
  const verb = VERB[tweet.kind] ?? 'mentioned';
  const epoch = Math.floor(new Date(tweet.createdAt).getTime() / 1000);
  const handle = escapeSlack(tweet.author);
  const pressing = readPressing(tweet.pressing);

  // The urgency leads both the message body and the notification preview, so
  // the channel can triage from the sidebar without opening anything.
  const scoreLine = pressing
    ? `${pressing.band.dot} *${pressing.score}* · ${pressing.band.label}` +
      `${pressing.reason ? ` · ${pressing.reason}` : ''}\n`
    : '';
  const prefix = pressing ? `[${pressing.score} ${pressing.band.label}] ` : '';

  return {
    text: `${prefix}@${handle} ${verb} @entirehq`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            scoreLine +
            `*<https://x.com/${encodeURIComponent(tweet.author)}|@${handle}>* ${verb} @entirehq\n` +
            `>${escapeSlack(body(tweet.text))}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `<${tweet.url}|View on X> · ${tweet.kind} · <!date^${epoch}^{date_short_pretty} at {time}|${tweet.createdAt}>`,
          },
        ],
      },
    ],
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
