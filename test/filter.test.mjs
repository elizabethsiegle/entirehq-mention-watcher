import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterAndClassify } from '../scripts/filter.mjs';
import { BASE_SCORE, EMPLOYEE_SCORE, DEFAULT_EMPLOYEE_HANDLES } from '../scripts/score.mjs';

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
    'author', 'createdAt', 'id', 'isEmployee', 'kind', 'score', 'text', 'url',
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

test('an outsider carries the base score and no employee flag', () => {
  const [t] = filterAndClassify([raw({ author: 'somedev' })], 'entirehq');
  assert.equal(t.score, BASE_SCORE);
  assert.equal(t.isEmployee, false);
});

test('every Entire teammate is scored down by default', () => {
  for (const handle of DEFAULT_EMPLOYEE_HANDLES) {
    const [t] = filterAndClassify([raw({ author: handle })], 'entirehq');
    assert.equal(t.score, EMPLOYEE_SCORE, `${handle} should score ${EMPLOYEE_SCORE}`);
    assert.equal(t.isEmployee, true, `${handle} should be flagged`);
  }
});

test('a teammate is still announced, not dropped', () => {
  // The trail says "take note of it", not "hide it". Scoring must never
  // become a filter by accident.
  const tweets = filterAndClassify(
    [raw({ id: '1', author: 'lizziepika' }), raw({ id: '2', author: 'somedev' })],
    'entirehq',
  );
  assert.deepEqual(tweets.map((t) => t.id).sort(), ['1', '2']);
});

test('employee scoring survives odd casing from X', () => {
  const [t] = filterAndClassify([raw({ author: 'LizziePika' })], 'entirehq');
  assert.equal(t.isEmployee, true);
});

test('an explicit roster overrides the default six', () => {
  const [ashtom] = filterAndClassify([raw({ author: 'ashtom' })], 'entirehq', ['newhire']);
  assert.equal(ashtom.isEmployee, false, 'ashtom is not on the custom roster');
  const [newhire] = filterAndClassify([raw({ author: 'newhire' })], 'entirehq', ['@NewHire']);
  assert.equal(newhire.isEmployee, true);
});

test('scoring is independent of kind', () => {
  // Only authorship moves the number, per the trail decision.
  const [reply] = filterAndClassify([raw({ author: 'ashtom', inReplyToStatusId: '9' })], 'entirehq');
  const [quote] = filterAndClassify([raw({ author: 'ashtom', isQuoteStatus: true })], 'entirehq');
  assert.equal(reply.score, EMPLOYEE_SCORE);
  assert.equal(quote.score, EMPLOYEE_SCORE);
});

test('tagging a teammate does not move an outsider score', () => {
  // Explicitly pinned: the trail title says "tagged", but the agreed rule is
  // authorship-only. A tweet mentioning @lizziepika scores like any outsider.
  const [t] = filterAndClassify(
    [raw({ author: 'somedev', text: 'hey @lizziepika does this work?' })],
    'entirehq',
  );
  assert.equal(t.score, BASE_SCORE);
  assert.equal(t.isEmployee, false);
});
