import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTweet,
  stripAnsi,
  printTweet,
  printStarted,
  printBaseline,
  printQuiet,
  printWarning,
  MAX_BODY,
} from '../scripts/notify-terminal.mjs';

const tweet = {
  id: '1958000000000000001',
  author: 'somedev',
  text: 'hey @entirehq does this work with self-hosted runners?',
  url: 'https://x.com/somedev/status/1958000000000000001',
  createdAt: '2026-08-18T14:02:11.000Z',
  kind: 'reply',
};

const at = new Date('2026-08-18T14:03:00.000Z');

function capture(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

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

test('formatTweet truncates a very long body at MAX_BODY characters with ellipsis', () => {
  const plain = stripAnsi(formatTweet({ ...tweet, text: 'x'.repeat(400) }, at));
  const bodyLine = plain.split('\n')[1].trim();
  assert.match(plain, /…/);
  assert.equal(bodyLine.length, MAX_BODY, `body should be exactly ${MAX_BODY} chars including ellipsis`);
  assert.equal(bodyLine[MAX_BODY - 1], '…', 'last character of truncated body should be ellipsis');
});

test('formatTweet does not truncate a body of exactly MAX_BODY characters', () => {
  const body240 = 'a'.repeat(MAX_BODY);
  const plain = stripAnsi(formatTweet({ ...tweet, text: body240 }, at));
  const bodyLine = plain.split('\n')[1].trim();
  assert.ok(!bodyLine.includes('…'), 'should not contain ellipsis');
  assert.equal(bodyLine, body240, 'body should be unchanged');
});

test('MAX_BODY is 240', () => {
  assert.equal(MAX_BODY, 240);
});

test('stripAnsi removes every escape sequence', () => {
  assert.equal(stripAnsi('\x1b[1mbold\x1b[0m'), 'bold');
});

test('printBaseline with 1 mention uses singular', () => {
  const lines = capture(() => printBaseline(1));
  const plain = stripAnsi(lines[0]);
  assert.match(plain, /1 existing mention/);
  assert.ok(!plain.includes('mentions'), 'should not contain plural form');
});

test('printBaseline with multiple mentions uses plural', () => {
  const lines = capture(() => printBaseline(14));
  const plain = stripAnsi(lines[0]);
  assert.match(plain, /14 existing mentions/);
});

test('printStarted reports poll interval correctly without NaN', () => {
  const lines = capture(() => printStarted(300000, '/some/dir'));
  const plain = stripAnsi(lines[0]);
  assert.match(plain, /polling every 300s/);
  assert.ok(!plain.includes('NaN'), 'poll interval should not be NaN');
  assert.match(plain, /\/some\/dir/);
});

test('printTweet emits the formatted tweet', () => {
  const lines = capture(() => printTweet(tweet));
  assert.equal(lines.length, 1, 'should emit exactly one block');
  const plain = stripAnsi(lines[0]);
  const expected = stripAnsi(formatTweet(tweet));
  assert.equal(plain, expected);
});

test('printQuiet emits one line with the message', () => {
  const lines = capture(() => printQuiet('hello'));
  assert.equal(lines.length, 1);
  const plain = stripAnsi(lines[0]);
  assert.match(plain, /hello/);
});

test('printWarning emits one line with the message', () => {
  const lines = capture(() => printWarning('uh oh'));
  assert.equal(lines.length, 1);
  const plain = stripAnsi(lines[0]);
  assert.match(plain, /uh oh/);
});

test('printWarning uses red and bold colour while printQuiet does not', () => {
  const quietLines = capture(() => printQuiet('message'));
  const warningLines = capture(() => printWarning('message'));
  // printWarning should have red (\x1b[31m) and bold (\x1b[1m) codes
  assert.match(warningLines[0], /\x1b\[31m/);
  assert.match(warningLines[0], /\x1b\[1m/);
  // printQuiet should not use red
  assert.ok(!quietLines[0].includes('\x1b[31m'));
});

test('formatTweet shows the pressing score on the header line, keeping one block per tweet', () => {
  const plain = stripAnsi(formatTweet({ ...tweet, pressing: { score: 91, reason: 'possible outage' } }, at));
  const lines = plain.split('\n');
  assert.equal(lines.length, 3, 'a scored tweet is still three lines');
  assert.match(lines[0], /91 now \(possible outage\)/);
  assert.match(lines[1], /self-hosted runners/, 'the body stays on the second line');
});

test('formatTweet renders an unscored tweet exactly as before', () => {
  assert.equal(formatTweet({ ...tweet, pressing: null }, at), formatTweet(tweet, at));
  assert.equal(formatTweet({ ...tweet, pressing: {} }, at), formatTweet(tweet, at));
});

test('formatTweet keeps a score of 0 on the header line', () => {
  const plain = stripAnsi(formatTweet({ ...tweet, pressing: { score: 0, reason: 'spam' } }, at));
  assert.match(plain.split('\n')[0], /0 noise \(spam\)/);
});
