import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTweet, stripAnsi } from '../scripts/notify-terminal.mjs';

const tweet = {
  id: '1958000000000000001',
  author: 'somedev',
  text: 'hey @entirehq does this work with self-hosted runners?',
  url: 'https://x.com/somedev/status/1958000000000000001',
  createdAt: '2026-08-18T14:02:11.000Z',
  kind: 'reply',
};

const at = new Date('2026-08-18T14:03:00.000Z');

test('formatTweet includes handle, kind, text and url', () => {
  const plain = stripAnsi(formatTweet(tweet, at));
  assert.match(plain, /@somedev/);
  assert.match(plain, /reply/);
  assert.match(plain, /self-hosted runners/);
  assert.match(plain, /https:\/\/x\.com\/somedev\/status\/1958000000000000001/);
});

test('formatTweet stamps the local time as HH:MM:SS', () => {
  const plain = stripAnsi(formatTweet(tweet, at));
  assert.match(plain, /^\[\d{2}:\d{2}:\d{2}\]/);
});

test('formatTweet emits ANSI colour codes', () => {
  assert.match(formatTweet(tweet, at), /\x1b\[/);
});

test('formatTweet collapses newlines in the tweet body to keep one block per tweet', () => {
  const plain = stripAnsi(formatTweet({ ...tweet, text: 'line one\nline two' }, at));
  const bodyLine = plain.split('\n').find((l) => l.includes('line one'));
  assert.match(bodyLine, /line one line two/);
});

test('formatTweet truncates a very long body', () => {
  const plain = stripAnsi(formatTweet({ ...tweet, text: 'x'.repeat(400) }, at));
  assert.match(plain, /…/);
  assert.ok(plain.length < 400, 'long tweets must not flood the terminal');
});

test('stripAnsi removes every escape sequence', () => {
  assert.equal(stripAnsi('\x1b[1mbold\x1b[0m'), 'bold');
});
