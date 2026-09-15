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

const employeeTweet = {
  ...tweet,
  author: 'lizziepika',
  url: 'https://x.com/lizziepika/status/1958000000000000002',
  text: 'yep, self-hosted runners work out of the box',
  score: 20,
  isEmployee: true,
};

const outsiderTweet = { ...tweet, score: 60, isEmployee: false };

function contextOf(payload) {
  return payload.blocks[1].elements[0].text;
}

test('an employee post is badged and scored in the context line', () => {
  const context = contextOf(buildTweetMessage(employeeTweet));
  assert.match(context, /Entire team/);
  assert.match(context, /score 20/);
});

test('an outsider post shows its score but carries no team badge', () => {
  const context = contextOf(buildTweetMessage(outsiderTweet));
  assert.match(context, /score 60/);
  assert.ok(!context.includes('Entire team'), `unexpected badge in: ${context}`);
});

test('the badge reaches the notification fallback, which is all mobile shows', () => {
  assert.equal(
    buildTweetMessage(employeeTweet).text,
    '@lizziepika replied to @entirehq (Entire team)',
  );
  assert.equal(buildTweetMessage(outsiderTweet).text, '@somedev replied to @entirehq');
});

test('a scored tweet keeps the View on X link construct intact', () => {
  // The context line is now assembled from parts; the link must not be
  // collateral damage of that refactor.
  assert.ok(
    contextOf(buildTweetMessage(employeeTweet)).includes(
      '<https://x.com/lizziepika/status/1958000000000000002|View on X>',
    ),
  );
});

test('a record written before scoring existed renders no score segment', () => {
  // store.mjs keeps ids, not records, but buildTweetMessage is also called
  // directly. "score undefined" in the channel would be worse than silence.
  const context = contextOf(buildTweetMessage(tweet));
  assert.ok(!context.includes('score'), `unexpected score in: ${context}`);
  assert.ok(!context.includes('undefined'), `undefined leaked into: ${context}`);
});

test('a zero score is rendered, not swallowed as falsy', () => {
  assert.match(contextOf(buildTweetMessage({ ...tweet, score: 0 })), /score 0/);
});

test('the scored context line keeps its separator layout', () => {
  const context = contextOf(buildTweetMessage(employeeTweet));
  assert.match(context, /View on X> · reply · Entire team · score 20 · <!date/);
});
