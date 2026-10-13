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

function reach(tweet) {
  const n = Number(tweet.followers);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 10000) return `${Math.round(n / 1000)}k followers`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k followers`;
  return `${n} followers`;
}

function meta(tweet, triage) {
  const r = reach(tweet);
  const reasons = (triage?.reasons ?? []).filter((x) => x !== r);
  return [tweet.kind, r, reasons.slice(0, 3).join(', ') || null]
    .filter(Boolean)
    .join(' \u00b7 ');
}

// Priority gets the full card and a leading marker; routine collapses to one
// line. The whole point of the split is that a skimming reader can tell them
// apart without reading either, so the shapes must differ, not just the words.
export function buildTweetMessage(tweet, triage = null) {
  const verb = VERB[tweet.kind] ?? 'mentioned';
  const epoch = Math.floor(new Date(tweet.createdAt).getTime() / 1000);
  const handle = escapeSlack(tweet.author);
  const profile = `https://x.com/${encodeURIComponent(tweet.author)}`;

  if (triage && triage.tier === 'routine') {
    const r = reach(tweet);
    const tail = [tweet.kind, r].filter(Boolean).join(' \u00b7 ');
    return {
      text: `@${handle} ${verb} @entirehq`,
      blocks: [
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text:
                `<${profile}|@${handle}> \u00b7 ${escapeSlack(body(tweet.text).slice(0, 140))} ` +
                `\u00b7 <${tweet.url}|open> \u00b7 ${tail}`,
            },
          ],
        },
      ],
    };
  }

  return {
    text: `\u2605 @${handle} ${verb} @entirehq`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*\u2605 <${profile}|@${handle}>* ${verb} @entirehq\n` +
            `>${escapeSlack(body(tweet.text))}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              `<${tweet.url}|View on X> \u00b7 ${escapeSlack(meta(tweet, triage))} \u00b7 ` +
              `<!date^${epoch}^{date_short_pretty} at {time}|${tweet.createdAt}>`,
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
