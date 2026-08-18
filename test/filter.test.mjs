import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAndClassify } from '../scripts/filter.mjs';

function raw(overrides) {
  return {
    id: '1',
    author: 'somedev',
    text: 'hi @entirehq',
    url: 'https://x.com/somedev/status/1',
    createdAt: '2026-08-18T14:00:00.000Z',
    inReplyToStatusId: null,
    isQuoteStatus: false,
    ...overrides,
  };
}

test('filterAndClassify labels a plain mention', () => {
  const [t] = filterAndClassify([raw({})], 'entirehq');
  assert.equal(t.kind, 'mention');
});

test('filterAndClassify labels a reply', () => {
  const [t] = filterAndClassify([raw({ inReplyToStatusId: '999' })], 'entirehq');
  assert.equal(t.kind, 'reply');
});

test('filterAndClassify labels a reply found via the DOM sentinel', () => {
  const [t] = filterAndClassify([raw({ inReplyToStatusId: 'unknown' })], 'entirehq');
  assert.equal(t.kind, 'reply');
});

test('filterAndClassify labels a quote tweet', () => {
  const [t] = filterAndClassify([raw({ isQuoteStatus: true })], 'entirehq');
  assert.equal(t.kind, 'quote');
});

test('reply wins over quote when a tweet is both', () => {
  const [t] = filterAndClassify(
    [raw({ isQuoteStatus: true, inReplyToStatusId: '999' })],
    'entirehq',
  );
  assert.equal(t.kind, 'reply');
});

test('filterAndClassify drops posts authored by the watched account', () => {
  const tweets = filterAndClassify(
    [raw({ id: '1', author: 'entirehq' }), raw({ id: '2', author: 'somedev' })],
    'entirehq',
  );
  assert.deepEqual(tweets.map((t) => t.id), ['2']);
});

test('own-post matching ignores case and a leading @', () => {
  const tweets = filterAndClassify([raw({ author: 'EntireHQ' })], '@entirehq');
  assert.deepEqual(tweets, []);
});

test('filterAndClassify emits exactly the Tweet fields, no raw leftovers', () => {
  const [t] = filterAndClassify([raw({ inReplyToStatusId: '999' })], 'entirehq');
  assert.deepEqual(Object.keys(t).sort(), [
    'author', 'createdAt', 'id', 'kind', 'text', 'url',
  ]);
});

test('filterAndClassify sorts oldest first', () => {
  const tweets = filterAndClassify(
    [
      raw({ id: 'new', createdAt: '2026-08-18T16:00:00.000Z' }),
      raw({ id: 'old', createdAt: '2026-08-18T09:00:00.000Z' }),
    ],
    'entirehq',
  );
  assert.deepEqual(tweets.map((t) => t.id), ['old', 'new']);
});

test('filterAndClassify drops an entry missing text', () => {
  const tweets = filterAndClassify([raw({ text: undefined })], 'entirehq');
  assert.deepEqual(tweets, []);
});

test('filterAndClassify drops an entry missing url', () => {
  const tweets = filterAndClassify([raw({ url: undefined })], 'entirehq');
  assert.deepEqual(tweets, []);
});

test('filterAndClassify drops an entry missing url (empty string)', () => {
  const tweets = filterAndClassify([raw({ url: '' })], 'entirehq');
  assert.deepEqual(tweets, []);
});

test('filterAndClassify drops an entry with unparseable createdAt', () => {
  const tweets = filterAndClassify([raw({ createdAt: 'not a date' })], 'entirehq');
  assert.deepEqual(tweets, []);
});

test('filterAndClassify keeps an entry with empty text', () => {
  const [t] = filterAndClassify([raw({ text: '' })], 'entirehq');
  assert.equal(t.text, '');
});

test('filterAndClassify tolerates junk input', () => {
  assert.deepEqual(filterAndClassify(null, 'entirehq'), []);
  assert.deepEqual(filterAndClassify([null, 'nope'], 'entirehq'), []);
});
