import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTimelineJson } from '../scripts/parse.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/search-timeline.json', import.meta.url), 'utf8'),
);

test('parseTimelineJson extracts every readable tweet and skips the rest', () => {
  const tweets = parseTimelineJson(fixture);
  assert.equal(tweets.length, 4, 'tombstone and cursor entries must be skipped');
  assert.deepEqual(
    tweets.map((t) => t.id),
    [
      '1958000000000000001',
      '1958000000000000002',
      '1958000000000000003',
      '1958000000000000004',
    ],
  );
});

test('parseTimelineJson maps a plain mention completely', () => {
  const [first] = parseTimelineJson(fixture);
  assert.deepEqual(first, {
    id: '1958000000000000001',
    author: 'somedev',
    text: 'hey @entirehq does this work with self-hosted runners?',
    url: 'https://x.com/somedev/status/1958000000000000001',
    createdAt: '2026-08-18T14:02:11.000Z',
    inReplyToStatusId: null,
    isQuoteStatus: false,
  });
});

test('parseTimelineJson unwraps TweetWithVisibilityResults and the legacy user shape', () => {
  const reply = parseTimelineJson(fixture)[1];
  assert.equal(reply.author, 'oldshape');
  assert.equal(reply.inReplyToStatusId, '1957000000000000009');
  assert.equal(reply.url, 'https://x.com/oldshape/status/1958000000000000002');
});

test('parseTimelineJson preserves is_quote_status', () => {
  const quote = parseTimelineJson(fixture)[2];
  assert.equal(quote.isQuoteStatus, true);
  assert.equal(quote.inReplyToStatusId, null);
});

test('parseTimelineJson lowercases nothing in author but keeps it @-free', () => {
  const quote = parseTimelineJson(fixture)[2];
  assert.equal(quote.author, 'QuoteFan');
});

test('parseTimelineJson returns [] for junk input instead of throwing', () => {
  assert.deepEqual(parseTimelineJson(null), []);
  assert.deepEqual(parseTimelineJson({}), []);
  assert.deepEqual(parseTimelineJson({ data: { search_by_raw_query: null } }), []);
  assert.deepEqual(parseTimelineJson('not json'), []);
});
