import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAndClassify, MATCH_HANDLE, MATCH_LINK, MATCH_BOTH } from '../scripts/filter.mjs';

const BRAND = { ownHandle: 'entirehq', brandDomain: 'entire.io' };

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
  const [t] = filterAndClassify([raw({})], BRAND);
  assert.equal(t.kind, 'mention');
});

test('filterAndClassify labels a reply', () => {
  const [t] = filterAndClassify([raw({ inReplyToStatusId: '999' })], BRAND);
  assert.equal(t.kind, 'reply');
});

test('filterAndClassify labels a reply found via the DOM sentinel', () => {
  const [t] = filterAndClassify([raw({ inReplyToStatusId: 'unknown' })], BRAND);
  assert.equal(t.kind, 'reply');
});

test('filterAndClassify labels a quote tweet', () => {
  const [t] = filterAndClassify([raw({ isQuoteStatus: true })], BRAND);
  assert.equal(t.kind, 'quote');
});

test('reply wins over quote when a tweet is both', () => {
  const [t] = filterAndClassify(
    [raw({ isQuoteStatus: true, inReplyToStatusId: '999' })],
    BRAND,
  );
  assert.equal(t.kind, 'reply');
});

test('filterAndClassify drops posts authored by the watched account', () => {
  const tweets = filterAndClassify(
    [raw({ id: '1', author: 'entirehq' }), raw({ id: '2', author: 'somedev' })],
    BRAND,
  );
  assert.deepEqual(tweets.map((t) => t.id), ['2']);
});

test('own-post matching ignores case and a leading @', () => {
  const tweets = filterAndClassify([raw({ author: 'EntireHQ' })], { ...BRAND, ownHandle: '@entirehq' });
  assert.deepEqual(tweets, []);
});

test('filterAndClassify emits exactly the Tweet fields, no raw leftovers', () => {
  const [t] = filterAndClassify([raw({ inReplyToStatusId: '999' })], BRAND);
  assert.deepEqual(Object.keys(t).sort(), [
    'author', 'createdAt', 'followers', 'followsUs', 'id', 'kind', 'matchedVia', 'text', 'url',
    'verified',
  ]);
});

test('filterAndClassify sorts oldest first', () => {
  const tweets = filterAndClassify(
    [
      raw({ id: 'new', createdAt: '2026-08-18T16:00:00.000Z' }),
      raw({ id: 'old', createdAt: '2026-08-18T09:00:00.000Z' }),
    ],
    BRAND,
  );
  assert.deepEqual(tweets.map((t) => t.id), ['old', 'new']);
});

test('filterAndClassify drops an entry missing text', () => {
  const tweets = filterAndClassify([raw({ text: undefined })], BRAND);
  assert.deepEqual(tweets, []);
});

test('filterAndClassify drops an entry missing url', () => {
  const tweets = filterAndClassify([raw({ url: undefined })], BRAND);
  assert.deepEqual(tweets, []);
});

test('filterAndClassify drops an entry missing url (empty string)', () => {
  const tweets = filterAndClassify([raw({ url: '' })], BRAND);
  assert.deepEqual(tweets, []);
});

test('filterAndClassify drops an entry with unparseable createdAt', () => {
  const tweets = filterAndClassify([raw({ createdAt: 'not a date' })], BRAND);
  assert.deepEqual(tweets, []);
});

test('filterAndClassify keeps an entry with empty text', () => {
  const [t] = filterAndClassify([raw({ text: '' })], BRAND);
  assert.equal(t.text, '');
});

test('filterAndClassify tolerates junk input', () => {
  assert.deepEqual(filterAndClassify(null, BRAND), []);
  assert.deepEqual(filterAndClassify([null, 'nope'], BRAND), []);
});

test('a post that tags the account matched on the handle', () => {
  const [t] = filterAndClassify([raw({ text: 'hi @EntireHQ' })], BRAND);
  assert.equal(t.matchedVia, MATCH_HANDLE);
});

test('a post whose only link is the site matched on the link', () => {
  const [t] = filterAndClassify(
    [raw({ text: 'this is the git host I switched to https://t.co/abc', links: ['https://entire.io/blog/post'] })],
    BRAND,
  );
  assert.equal(t.matchedVia, MATCH_LINK);
});

test('the domain written out in the text counts as a link match', () => {
  const [t] = filterAndClassify([raw({ text: 'go read entire.io, seriously' })], BRAND);
  assert.equal(t.matchedVia, MATCH_LINK);
});

test('a post that does both is recorded as both', () => {
  const [t] = filterAndClassify(
    [raw({ text: '@entirehq shipped this https://t.co/abc', links: ['entire.io/changelog'] })],
    BRAND,
  );
  assert.equal(t.matchedVia, MATCH_BOTH);
});

test('an unrelated link is not a site match', () => {
  const [t] = filterAndClassify(
    [raw({ text: 'hi @entirehq', links: ['https://github.com/entire/io'] })],
    BRAND,
  );
  assert.equal(t.matchedVia, MATCH_HANDLE);
});

test('a result that shows neither signal is attributed to the handle', () => {
  // The DOM path drops the leading "Replying to @entirehq" from the body, so
  // a real handle match can arrive with no visible evidence. Calling that a
  // link match would put "linked entire.io" on a post with no link in it.
  const [t] = filterAndClassify([raw({ text: 'yes exactly', inReplyToStatusId: 'unknown' })], BRAND);
  assert.equal(t.matchedVia, MATCH_HANDLE);
});

test('match attribution survives a missing brand domain', () => {
  const [t] = filterAndClassify([raw({ links: ['entire.io/x'] })], { ownHandle: 'entirehq' });
  assert.equal(t.matchedVia, MATCH_HANDLE);
});
