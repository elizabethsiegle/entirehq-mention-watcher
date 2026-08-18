import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDomRecords } from '../scripts/parse.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/dom-records.json', import.meta.url), 'utf8'),
);

test('parseDomRecords keeps only well-formed, unique status records', () => {
  const tweets = parseDomRecords(fixture);
  assert.deepEqual(
    tweets.map((t) => t.id),
    [
      '1958000000000000001',
      '1958000000000000002',
      '1958000000000000003',
      '1958000000000000007',
    ],
    'duplicates, non-status permalinks, and undated records must be dropped',
  );
});

test('parseDomRecords normalizes handle and rebuilds a canonical url', () => {
  const [first] = parseDomRecords(fixture);
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

test('parseDomRecords accepts an absolute permalink and a bare handle', () => {
  const reply = parseDomRecords(fixture)[1];
  assert.equal(reply.author, 'oldshape');
  assert.equal(reply.url, 'https://x.com/oldshape/status/1958000000000000002');
});

test('parseDomRecords marks a "Replying to" record with the unknown-parent sentinel', () => {
  const reply = parseDomRecords(fixture)[1];
  assert.equal(reply.inReplyToStatusId, 'unknown');
});

test('parseDomRecords carries the quoted-tweet flag through', () => {
  const quote = parseDomRecords(fixture)[2];
  assert.equal(quote.isQuoteStatus, true);
  assert.equal(quote.inReplyToStatusId, null);
});

test('parseDomRecords prefers the permalink author over a mismatched handle', () => {
  const tweets = parseDomRecords(fixture);
  const quoted = tweets[3];
  assert.equal(quoted.author, 'realauthor');
  assert.equal(quoted.url, 'https://x.com/realauthor/status/1958000000000000007');
});

test('parseDomRecords returns [] for junk input instead of throwing', () => {
  assert.deepEqual(parseDomRecords(null), []);
  assert.deepEqual(parseDomRecords([]), []);
  assert.deepEqual(parseDomRecords([{}, null, 'nope']), []);
});
