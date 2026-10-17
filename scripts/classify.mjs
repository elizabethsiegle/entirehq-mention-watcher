import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-haiku-5-5';

const SYSTEM = `You triage public X/Twitter mentions of @entirehq, a git hosting platform built for AI coding agents, founded by GitHub's former CEO. Its site is entire.io.

A mention reaches you either because it tags the account or because it links the site. A post that links entire.io without tagging @entirehq is a real mention. Judge it on the same terms, and remember the author is not expecting a reply.

Judge whether the @entirehq team should act on a mention right now. Act means: reply, repost, or route it to someone internally.

PRIORITY: a question or support request aimed at the product; a user reporting a real problem; a notable endorsement worth reposting; someone comparing @entirehq to a competitor or saying they are switching; a request for access or a demo.
ROUTINE: generic praise, emoji-only replies, tangential mentions in an unrelated thread, pile-on replies that add nothing, chatter between other people where @entirehq is incidental.
IGNORE: spam, crypto/airdrop bait, unrelated accounts that merely contain the string, engagement farming.

Judge the text on its own merits. Follower counts are scored separately and must not influence this call.`;

const TOOL = {
  name: 'record_triage',
  description: 'Record the triage decision for one mention.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      tier: { type: 'string', enum: ['PRIORITY', 'ROUTINE', 'IGNORE'] },
      reason: { type: 'string', description: 'At most eight words, lowercase, no trailing period.' },
    },
    required: ['tier', 'reason'],
    additionalProperties: false,
  },
};

const MATCHED = {
  handle: 'tags the account',
  link: 'links the site, does not tag the account',
  both: 'tags the account and links the site',
};

export function buildPrompt(tweet) {
  return [
    `Author: @${tweet.author}`,
    `Kind: ${tweet.kind}`,
    `Matched: ${MATCHED[tweet.matchedVia] ?? MATCHED.handle}`,
    `Text: ${tweet.text}`,
  ].join('\n');
}

// Resolves rather than rejects. The caller is a poll loop whose deterministic
// score is a complete answer on its own, so a classifier outage degrades the
// tiering instead of dropping the notification.
export async function classify(tweet, { client, timeoutMs = 15000 } = {}) {
  if (!client) return { ok: false, tier: null, reason: null, error: 'no client' };

  try {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 256,
        system: SYSTEM,
        output_config: { effort: 'low' },
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content: buildPrompt(tweet) }],
      },
      { timeout: timeoutMs },
    );

    if (response.stop_reason === 'refusal') {
      return { ok: false, tier: null, reason: null, error: 'refusal' };
    }

    const call = response.content.find((block) => block.type === 'tool_use');
    if (!call) return { ok: false, tier: null, reason: null, error: 'no tool_use block' };

    const { tier, reason } = call.input ?? {};
    if (!['PRIORITY', 'ROUTINE', 'IGNORE'].includes(tier)) {
      return { ok: false, tier: null, reason: null, error: `bad tier: ${tier}` };
    }
    return { ok: true, tier, reason: String(reason ?? '').slice(0, 80) };
  } catch (err) {
    return { ok: false, tier: null, reason: null, error: err?.message ?? String(err) };
  }
}

export function createClient(apiKey) {
  return apiKey ? new Anthropic({ apiKey }) : null;
}
