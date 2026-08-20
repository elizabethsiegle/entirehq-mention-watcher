import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  buildTweetMessage,
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

test('buildTweetMessage sets a plain-text fallback for notifications', () => {
  assert.equal(buildTweetMessage(tweet).text, '@somedev replied to @entirehq');
  assert.equal(
    buildTweetMessage({ ...tweet, kind: 'mention' }).text,
    '@somedev mentioned @entirehq',
  );
  assert.equal(
    buildTweetMessage({ ...tweet, kind: 'quote' }).text,
    '@somedev quoted @entirehq',
  );
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

test('postToSlack posts the payload and reports success', async () => {
  const hook = await stubWebhook([200]);
  const result = await postToSlack(hook.url, buildTweetMessage(tweet));
  assert.deepEqual({ ok: result.ok, attempts: result.attempts }, { ok: true, attempts: 1 });
  assert.equal(hook.received.length, 1);
  assert.equal(hook.received[0].text, '@somedev replied to @entirehq');
  await hook.close();
});

test('postToSlack retries exactly once after a server error, then succeeds', async () => {
  const hook = await stubWebhook([500, 200]);
  const result = await postToSlack(hook.url, buildTweetMessage(tweet), { retryDelayMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(hook.received.length, 2);
  await hook.close();
});

test('postToSlack gives up after the retry and resolves ok:false', async () => {
  const hook = await stubWebhook([500, 500]);
  const result = await postToSlack(hook.url, buildTweetMessage(tweet), { retryDelayMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(result.attempts, 2);
  await hook.close();
});

test('postToSlack resolves ok:false on a network error instead of throwing', async () => {
  const result = await postToSlack('http://127.0.0.1:1/hook', { text: 'x' }, { retryDelayMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
});

const scoredTweet = {
  ...tweet,
  text: 'is @entirehq down? my checkpoints stopped saving an hour ago',
  pressing: { score: 91, reason: 'possible outage, checkpoints not saving' },
};

test('buildTweetMessage puts the pressing score on the first line, above the tweet', () => {
  const section = buildTweetMessage(scoredTweet).blocks[0].text.text;
  const lines = section.split('\n');
  assert.match(lines[0], /\*91\* · now · possible outage, checkpoints not saving/);
  assert.match(lines[1], /@somedev/, 'the author line follows the score');
  assert.match(lines[2], /checkpoints stopped saving/, 'the tweet body comes last');
});

test('buildTweetMessage leads the notification text with the score', () => {
  assert.equal(buildTweetMessage(scoredTweet).text, '[91 now] @somedev replied to @entirehq');
});

test('buildTweetMessage renders each band label for its score', () => {
  const labelFor = (score) =>
    buildTweetMessage({ ...tweet, pressing: { score, reason: 'r' } }).blocks[0].text.text.split('\n')[0];
  assert.match(labelFor(91), /now/);
  assert.match(labelFor(70), /today/);
  assert.match(labelFor(40), /this week/);
  assert.match(labelFor(20), /fyi/);
  assert.match(labelFor(3), /noise/);
});

test('buildTweetMessage omits the score line entirely when a tweet is unscored', () => {
  for (const pressing of [null, undefined, {}]) {
    const payload = buildTweetMessage({ ...tweet, pressing });
    assert.equal(payload.blocks[0].text.text, buildTweetMessage(tweet).blocks[0].text.text);
    assert.equal(payload.text, '@somedev replied to @entirehq');
  }
});

test('buildTweetMessage keeps a score of 0 visible rather than treating it as absent', () => {
  const section = buildTweetMessage({ ...tweet, pressing: { score: 0, reason: 'crypto spam' } }).blocks[0].text.text;
  assert.match(section.split('\n')[0], /\*0\* · noise · crypto spam/);
});

test('buildTweetMessage escapes mrkdwn control characters in the score reason', () => {
  const section = buildTweetMessage({
    ...tweet,
    pressing: { score: 50, reason: 'asks <http://evil|click> & more' },
  }).blocks[0].text.text;
  assert.ok(!section.split('\n')[0].includes('<http'), 'a raw link construct must not survive into the score line');
  assert.match(section, /&lt;http/);
  assert.match(section, /&amp;/);
});

test('buildTweetMessage renders a score with no reason without a dangling separator', () => {
  const first = buildTweetMessage({ ...tweet, pressing: { score: 45, reason: '' } }).blocks[0].text.text.split('\n')[0];
  assert.match(first, /\*45\* · this week$/);
});

test('buildTweetMessage ignores a non-numeric score instead of half-rendering it', () => {
  for (const score of ['91', NaN, null, undefined]) {
    const payload = buildTweetMessage({ ...tweet, pressing: { score, reason: 'r' } });
    assert.equal(payload.text, '@somedev replied to @entirehq', `score ${score} must not reach the notification text`);
    assert.equal(payload.blocks[0].text.text, buildTweetMessage(tweet).blocks[0].text.text);
  }
});
