import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReplyResponse, verifyReplyAccount, sendReply } from '../scripts/x-reply.mjs';
import { REPLY_TEXT } from '../scripts/reply-match.mjs';

const success = { data: { create_tweet: { tweet_results: { result: {
  rest_id: '999', legacy: { in_reply_to_status_id_str: '123' },
} } } } };

test('confirmation requires a real reply ID and the requested parent, not just HTTP 200', () => {
  assert.deepEqual(parseReplyResponse(200, success, '123'), { status: 'sent', replyId: '999' });
  assert.equal(parseReplyResponse(200, success, '456').status, 'unknown');
  assert.equal(parseReplyResponse(200, {}, '123').status, 'unknown');
  assert.equal(parseReplyResponse(200, { errors: [{ code: 187 }] }, '123').status, 'unknown');
  assert.equal(parseReplyResponse(500, null, '123').status, 'unknown');
  assert.equal(parseReplyResponse(403, {}, '123').status, 'rejected');
});

test('rate limits respect reset, Retry-After and daily posting caps', () => {
  const now = 1000000;
  assert.equal(parseReplyResponse(429, {}, '123', { 'retry-after': '1200' }, now).retryAt, now + 1200000);
  assert.equal(parseReplyResponse(429, {}, '123', { 'x-rate-limit-reset': '3000' }, now).retryAt, 3000000);
  assert.equal(parseReplyResponse(200, { errors: [{ code: 88 }] }, '123', {}, now).retryAt, now + 900000);
  assert.equal(parseReplyResponse(200, { errors: [{ code: 185 }] }, '123', {}, now).retryAt, now + 86400000);
});

test('posting identity must match the configured account', async () => {
  const page = (href) => ({ getByTestId: () => ({ getAttribute: async () => href }) });
  assert.equal(await verifyReplyAccount(page('/LizziePika'), 'lizziepika'), 'lizziepika');
  await assert.rejects(verifyReplyAccount(page('/someoneelse'), 'lizziepika'), /mismatch/);
  await assert.rejects(verifyReplyAccount(page(null), 'lizziepika'), /no authenticated account/);
});

function browser({ account = '/lizziepika', response = success, timeout = false, clickError = false } = {}) {
  const events = [];
  const editor = { fill: async (text) => events.push(['fill', text]), innerText: async () => REPLY_TEXT };
  const button = { isEnabled: async () => true, click: async () => {
    events.push(['submit']);
    if (clickError) throw new Error('disconnected');
  } };
  const target = {
    first: () => ({ waitFor: async () => {} }), count: async () => 1,
    getByTestId: (id) => { assert.equal(id, 'reply'); return { click: async () => events.push(['open']) }; },
  };
  const page = {
    goto: async (url) => events.push(['goto', url]),
    locator: () => ({}),
    getByTestId: (id) => id === 'AppTabBar_Profile_Link'
      ? { getAttribute: async () => account } : { filter: () => target },
    getByRole: () => ({ getByTestId: (id) => id === 'tweetTextarea_0' ? editor : button }),
    waitForResponse: async (predicate) => {
      events.push(['listen']);
      const reply = {
        url: () => 'https://x.com/i/api/graphql/hash/CreateTweet',
        request: () => ({ postDataJSON: () => ({ variables: { tweet_text: REPLY_TEXT, reply: { in_reply_to_tweet_id: '123' } } }) }),
        json: async () => response, status: () => 200, headers: () => ({}),
      };
      assert.equal(predicate(reply), true);
      assert.equal(predicate({ ...reply, request: () => ({ postDataJSON: () => ({ variables: { tweet_text: 'wrong' } }) }) }), false);
      if (timeout) throw new Error('timeout');
      return reply;
    },
  };
  return { events, open: async (config, action) => action(page) };
}

test('sender fills exact text, reserves before clicking, and listens before submission', async () => {
  const b = browser();
  const result = await sendReply({ replyHandle: 'lizziepika' }, { id: '123', author: 'dev' }, () => b.events.push(['reserve']), b);
  assert.equal(result.status, 'sent');
  assert.deepEqual(b.events, [
    ['goto', 'https://x.com/dev/status/123'], ['open'], ['fill', REPLY_TEXT], ['reserve'], ['listen'], ['submit'],
  ]);
});

test('wrong account or persistence failure never clicks Post', async () => {
  const wrong = browser({ account: '/wrong' });
  await sendReply({ replyHandle: 'lizziepika' }, { id: '123', author: 'dev' }, () => assert.fail('must not reserve'), wrong);
  assert.equal(wrong.events.some(([event]) => event === 'submit'), false);
  const disk = browser();
  await sendReply({ replyHandle: 'lizziepika' }, { id: '123', author: 'dev' }, () => { throw new Error('disk full'); }, disk);
  assert.equal(disk.events.some(([event]) => event === 'submit'), false);
});

test('timeout and click failure cannot cause automatic reposting', async () => {
  for (const options of [{ timeout: true }, { clickError: true }]) {
    const b = browser(options);
    const result = await sendReply({ replyHandle: 'lizziepika' }, { id: '123', author: 'dev' }, () => {}, b);
    assert.equal(result.status, 'unknown');
    assert.equal(b.events.filter(([event]) => event === 'submit').length, 1);
  }
});
