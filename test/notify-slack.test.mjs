import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  buildTweetMessage,
  kindLabel,
  buildAlertMessage,
  escapeSlack,
  postToSlack,
} from '../scripts/notify-slack.mjs';

const tweet = {
  id: '1958000000000000001',
  author: 'somedev',
  text: 'hey @entirehq does this work with self-hosted runners?',
  url: 'https://x.com/somedev/status/1958000000000000001',
  createdAt: '2026-08-18T14:02:11.000Z',
  kind: 'reply',
};

// Starts a throwaway webhook receiver. `statuses` is consumed one entry per
// request, so [500, 200] models "fails once, then succeeds".
async function stubWebhook(statuses) {
  const received = [];
  const queue = [...statuses];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(raw));
      res.writeHead(queue.shift() ?? 200).end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  return { url, received, close: () => new Promise((r) => server.close(r)) };
}

test('escapeSlack escapes the three mrkdwn control characters', () => {
  assert.equal(escapeSlack('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
});

test('buildTweetMessage carries handle, kind, body and link', () => {
  const payload = buildTweetMessage(tweet);
  const json = JSON.stringify(payload);
  assert.match(json, /somedev/);
  assert.match(json, /reply/);
  assert.match(json, /self-hosted runners/);
  assert.match(json, /1958000000000000001/);
});

test('buildTweetMessage keeps the Slack link construct intact for a well-formed tweet', () => {
  // notify-slack.mjs interpolates author/id/url raw into `<url|text>`. This
  // pins the exact, unbroken construct for a normal tweet — the invariant
  // that parseTimelineJson's handle/id validation (scripts/parse.mjs) now
  // protects at the ingestion boundary.
  const payload = buildTweetMessage(tweet);
  const context = payload.blocks[1].elements[0].text;
  assert.ok(
    context.includes('<https://x.com/somedev/status/1958000000000000001|View on X>'),
    `expected an intact link construct, got: ${context}`,
  );
});

test('a priority fallback text is marked, because that is what a phone shows', () => {
  assert.equal(buildTweetMessage(tweet).text, '\u2605 REPLY \u00b7 @somedev replied to @entirehq');
  assert.equal(
    buildTweetMessage({ ...tweet, kind: 'mention' }).text,
    '\u2605 TWEET \u00b7 @somedev mentioned @entirehq',
  );
  assert.equal(
    buildTweetMessage({ ...tweet, kind: 'quote' }).text,
    '\u2605 QUOTE \u00b7 @somedev quoted @entirehq',
  );
});

test('a routine fallback text carries the kind but no priority marker', () => {
  const payload = buildTweetMessage(tweet, { tier: 'routine', reasons: [] });
  assert.equal(payload.text, 'REPLY \u00b7 @somedev replied to @entirehq');
});

test('kindLabel distinguishes a standalone tweet from a reply and a quote', () => {
  assert.equal(kindLabel('mention'), 'TWEET');
  assert.equal(kindLabel('reply'), 'REPLY');
  assert.equal(kindLabel('quote'), 'QUOTE');
  assert.equal(kindLabel(undefined), 'TWEET');
});

test('both tiers lead with the kind in the same slot', () => {
  for (const kind of ['mention', 'reply', 'quote']) {
    const label = kindLabel(kind);
    const priority = buildTweetMessage({ ...tweet, kind }, { tier: 'priority', reasons: [] });
    const routine = buildTweetMessage({ ...tweet, kind }, { tier: 'routine', reasons: [] });
    // The label must sit at the head of the rendered line, not mid-chain,
    // which is what made reply-vs-tweet unreadable at a glance.
    assert.match(priority.blocks[0].text.text, new RegExp(`^\\*\\u2605 \`${label}\``));
    assert.match(routine.blocks[0].elements[0].text, new RegExp(`^\`${label}\``));
  }
});

test('the kind is not repeated in the priority trailing chain', () => {
  const payload = buildTweetMessage(tweet, { tier: 'priority', reasons: ['question'] });
  const context = payload.blocks[1].elements[0].text;
  assert.doesNotMatch(context, /\breply\b/);
});

test('routine and priority render structurally different blocks', () => {
  const priority = buildTweetMessage(tweet, { tier: 'priority', reasons: ['question'] });
  const routine = buildTweetMessage(tweet, { tier: 'routine', reasons: ['question'] });
  // A skimming reader must be able to tell them apart without reading either.
  assert.equal(priority.blocks[0].type, 'section');
  assert.equal(routine.blocks[0].type, 'context');
  assert.equal(routine.blocks.length, 1);
});

test('a priority card shows reach and the triage reasons', () => {
  const payload = buildTweetMessage(
    { ...tweet, followers: 17388 },
    { tier: 'priority', reasons: ['17k followers', 'question'] },
  );
  const rendered = JSON.stringify(payload);
  assert.match(rendered, /17k followers/);
  assert.match(rendered, /question/);
});

test('reach is omitted rather than shown as zero when unknown', () => {
  const payload = buildTweetMessage({ ...tweet, followers: null }, { tier: 'priority', reasons: [] });
  assert.doesNotMatch(JSON.stringify(payload), /followers/);
});

test('a routine line still escapes user content', () => {
  const payload = buildTweetMessage(
    { ...tweet, text: '<https://evil.example|click me>' },
    { tier: 'routine', reasons: [] },
  );
  assert.match(JSON.stringify(payload), /&lt;https:\/\/evil\.example/);
  assert.doesNotMatch(JSON.stringify(payload), /\|click me>/);
});

test('buildTweetMessage escapes user content so a tweet cannot forge markup', () => {
  const payload = buildTweetMessage({ ...tweet, text: '<https://evil.example|click me>' });
  assert.match(JSON.stringify(payload), /&lt;https:\/\/evil\.example/);
});

test('buildAlertMessage produces a usable payload', () => {
  const payload = buildAlertMessage('X cookies expired');
  assert.equal(payload.text, 'X cookies expired');
  assert.ok(Array.isArray(payload.blocks) && payload.blocks.length > 0);
});

test('postToSlack posts the payload and reports success', async (t) => {
  const hook = await stubWebhook([200]);
  t.after(() => hook.close());
  const result = await postToSlack(hook.url, buildTweetMessage(tweet));
  assert.deepEqual({ ok: result.ok, attempts: result.attempts }, { ok: true, attempts: 1 });
  assert.equal(hook.received.length, 1);
  assert.equal(hook.received[0].text, '\u2605 REPLY \u00b7 @somedev replied to @entirehq');
});

test('postToSlack retries exactly once after a server error, then succeeds', async (t) => {
  const hook = await stubWebhook([500, 200]);
  t.after(() => hook.close());
  const result = await postToSlack(hook.url, buildTweetMessage(tweet), { retryDelayMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(hook.received.length, 2);
});

test('postToSlack gives up after the retry and resolves ok:false', async (t) => {
  const hook = await stubWebhook([500, 500]);
  t.after(() => hook.close());
  const result = await postToSlack(hook.url, buildTweetMessage(tweet), { retryDelayMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(result.attempts, 2);
});

test('postToSlack resolves ok:false on a network error instead of throwing', async () => {
  const result = await postToSlack('http://127.0.0.1:1/hook', { text: 'x' }, { retryDelayMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
});

test('reach is not printed twice when a reason already names it', () => {
  const payload = buildTweetMessage(
    { ...tweet, followers: 17388 },
    { tier: 'priority', reasons: ['17k followers', 'not a follower'] },
  );
  const rendered = payload.blocks.map((b) =>
    b.type === 'section' ? b.text.text : b.elements.map((e) => e.text).join(' '),
  ).join(' ');
  assert.equal(rendered.match(/17k followers/g).length, 1);
});

const linkOnly = {
  ...tweet,
  kind: 'mention',
  matchedVia: 'link',
  text: 'finally moved our repos off github https://t.co/abc',
};

test('a link-only share does not claim the author tagged us', () => {
  // "replied to @entirehq" on a post that never tagged the account is a
  // factual error in the one line a phone notification shows.
  const payload = buildTweetMessage(linkOnly, { tier: 'priority', reasons: [] });
  assert.equal(payload.text, '\u2605 TWEET \u00b7 @somedev linked entire.io');
  assert.doesNotMatch(payload.text, /@entirehq/);
});

test('a link-only reply keeps its kind but still reports what it matched', () => {
  const payload = buildTweetMessage(
    { ...linkOnly, kind: 'reply' },
    { tier: 'routine', reasons: [] },
  );
  assert.equal(payload.text, 'REPLY \u00b7 @somedev linked entire.io');
});

test('a post that both tags and links reads as a mention and says it linked too', () => {
  const payload = buildTweetMessage(
    { ...linkOnly, matchedVia: 'both', kind: 'reply' },
    { tier: 'routine', reasons: [] },
  );
  assert.equal(payload.text, 'REPLY \u00b7 @somedev replied to @entirehq');
  assert.match(payload.blocks[0].elements[0].text, /links entire\.io/);
});

test('both tiers show the link tag in the channel, not just in the notification', () => {
  const priority = buildTweetMessage(linkOnly, { tier: 'priority', reasons: ['question'] });
  const routine = buildTweetMessage(linkOnly, { tier: 'routine', reasons: ['question'] });
  assert.match(priority.blocks[1].elements[0].text, /links entire\.io/);
  assert.match(routine.blocks[0].elements[0].text, /links entire\.io/);
});

test('a handle match carries no link tag', () => {
  const payload = buildTweetMessage(
    { ...tweet, matchedVia: 'handle' },
    { tier: 'routine', reasons: [] },
  );
  assert.doesNotMatch(payload.blocks[0].elements[0].text, /links/);
});

test('the brand names come from config, so a rename cannot leave stale text behind', () => {
  const brand = { handle: 'acmehq', domain: 'acme.dev' };
  assert.equal(
    buildTweetMessage(linkOnly, { tier: 'routine', reasons: [] }, brand).text,
    'TWEET \u00b7 @somedev linked acme.dev',
  );
  assert.equal(
    buildTweetMessage({ ...tweet, matchedVia: 'handle' }, { tier: 'routine', reasons: [] }, brand).text,
    'REPLY \u00b7 @somedev replied to @acmehq',
  );
});

test('a tweet with no match attribution still renders the pre-existing wording', () => {
  // Nothing persisted carries matchedVia, so a record read back from an older
  // store must not render as a link share.
  assert.equal(buildTweetMessage(tweet).text, '\u2605 REPLY \u00b7 @somedev replied to @entirehq');
});
