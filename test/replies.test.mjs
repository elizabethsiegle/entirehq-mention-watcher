import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processReplies } from '../scripts/replies.mjs';
import { isGithubOutage, replyCandidates, REPLY_TEXT } from '../scripts/reply-match.mjs';

const config = { replyMode: 'live', replyHandle: 'lizziepika', ownHandle: 'entirehq', mutedHandles: ['muted'] };
const start = Date.parse('2026-10-28T18:00:00Z');
const tweet = (id = '1', extra = {}) => ({
  id, author: 'developer', text: 'GitHub is down again', isRetweet: false,
  createdAt: new Date(start + 1000).toISOString(), url: `https://x.com/developer/status/${id}`, ...extra,
});
function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'replies-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  const alerts = [];
  const send = async (config, tweet, beforeSubmit) => {
    await beforeSubmit();
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'replies.json'))).entries[tweet.id].status, 'pending');
    calls.push(tweet.id);
    return { status: 'sent', replyId: `99${tweet.id}` };
  };
  return { dataDir, send, calls, alerts, alert: async (message) => alerts.push(message) };
}
const read = (f, name = 'replies.json') => JSON.parse(readFileSync(join(f.dataDir, name)));

test('outage matching requires concrete GitHub outage language', () => {
  for (const text of ['GitHub is down again', 'github actions unavailable', "GitHub’s outage broke CI", 'Another outage on GitHub', 'github downtime today', '@github seems to be down', 'GitHub API degraded', 'GitHub is experiencing a major outage right now.', 'Anyone know if GitHub is down?', 'Agents asking if GitHub is down']) {
    assert.equal(isGithubOutage(tweet('1', { text })), true, text);
  }
  for (const text of ['GitHub reliability matters', 'GitHub stars are down', 'GitHub is down to 500 employees', 'GitHub is not down', 'No GitHub outage today', 'If GitHub is down, use a mirror', "We can't use these features if GitHub is down", 'GitHub outage resolved', 'GitHub is back up', 'My app is down https://github.com/acme/app', 'download from github', 'RT @dev: GitHub is down']) {
    assert.equal(isGithubOutage(tweet('1', { text })), false, text);
  }
  assert.equal(isGithubOutage(tweet('1', { isRetweet: true })), false);
  assert.equal(isGithubOutage(tweet('1', { isRetweet: null })), false);
  assert.equal(REPLY_TEXT, '@goentire is up. entire.com');
});

test('candidates exclude own, brand, muted, invalid, old, future and duplicate tweets', () => {
  const tweets = [tweet(), tweet(), ...['LIZZIEPIKA', 'entirehq', 'muted'].map((author, i) => tweet(String(i + 2), { author })),
    tweet('5', { createdAt: new Date(start - 7200000).toISOString() }),
    tweet('6', { createdAt: new Date(start + 100000).toISOString() }),
    tweet('7', { createdAt: 'invalid' }), tweet('bad'), tweet('8', { author: 'invalid/name' })];
  assert.deepEqual(replyCandidates(tweets, config, { since: start, now: start + 2000 }).map(t => t.id), ['1']);
});

test('first live poll baselines all current tweets without sending, even on an existing Slack installation', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dataDir, 'seen.json'), JSON.stringify({ baselined: true, seen: [] }));
  await processReplies([tweet()], config, { ...f, now: start });
  await processReplies([tweet(), tweet('2')], config, { ...f, now: start + 2000 });
  assert.deepEqual(f.calls, ['2']);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dataDir, 'seen.json'))), { baselined: true, seen: [] });
});

test('successful replies survive restarts and duplicate search results', async (t) => {
  const f = fixture(t);
  await processReplies([], config, { ...f, now: start });
  await processReplies([tweet(), tweet()], config, { ...f, now: start + 2000 });
  await processReplies([tweet()], config, { ...f, now: start + 3000 });
  assert.deepEqual(f.calls, ['1']);
  assert.equal(read(f).entries['1'].replyId, '991');
});

test('dry-run never calls send and live mode establishes its own baseline', async (t) => {
  const f = fixture(t);
  const dry = { ...config, replyMode: 'dry-run' };
  await processReplies([], dry, { ...f, now: start });
  await processReplies([tweet()], dry, { ...f, now: start + 2000 });
  assert.equal(read(f, 'replies-dry-run.json').entries['1'].status, 'dry-run');
  await processReplies([tweet()], config, { ...f, now: start + 3000 });
  await processReplies([tweet()], config, { ...f, now: start + 4000 });
  assert.deepEqual(f.calls, []);
});

test('rate limiting pauses all replies and retries only after reset independently of Slack state', async (t) => {
  const f = fixture(t);
  await processReplies([], config, { ...f, now: start });
  await processReplies([tweet()], config, { ...f, now: start + 2000, send: async (c, t, before) => {
    await before(); return { status: 'retry', retryAt: start + 10000, error: 'rate limit' };
  } });
  await processReplies([tweet(), tweet('2')], config, { ...f, now: start + 3000 });
  assert.deepEqual(f.calls, []);
  await processReplies([tweet()], config, { ...f, now: start + 11000 });
  assert.deepEqual(f.calls, ['1']);
  assert.equal(f.alerts.length, 1);
});

test('interrupted and unconfirmed sends are held, never blindly retried', async (t) => {
  const f = fixture(t);
  await processReplies([], config, { ...f, now: start });
  await processReplies([tweet()], config, { ...f, now: start + 2000, send: async (c, t, before) => {
    await before(); throw new Error('network disconnected');
  } });
  assert.equal(read(f).entries['1'].status, 'unknown');
  await processReplies([tweet()], config, { ...f, now: start + 1000000 });
  assert.deepEqual(f.calls, []);
});

test('a crash after durable reservation cannot cause a second send', async (t) => {
  const f = fixture(t);
  await processReplies([], config, { ...f, now: start });
  const state = read(f);
  state.entries['1'] = { status: 'pending', at: start + 1000 };
  writeFileSync(join(f.dataDir, 'replies.json'), JSON.stringify(state));
  await processReplies([tweet()], config, { ...f, now: start + 2000 });
  assert.deepEqual(f.calls, []);
});

test('corrupt state and an account change fail closed', async (t) => {
  const f = fixture(t);
  await processReplies([], config, { ...f, now: start });
  await assert.rejects(processReplies([tweet()], { ...config, replyHandle: 'someoneelse' }, { ...f, now: start + 2000 }), /changed posting account/);
  writeFileSync(join(f.dataDir, 'replies.json'), '{broken');
  await assert.rejects(processReplies([tweet()], config, { ...f, now: start + 2000 }));
  assert.deepEqual(f.calls, []);
});

test('a concurrent or interrupted run cannot share the reply state', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.dataDir, 'replies.lock'));
  await assert.rejects(processReplies([tweet()], config, { ...f, now: start + 2000 }), /Replies locked/);
  assert.deepEqual(f.calls, []);
});

test('one poll sends at most three replies and the next can process the remainder', async (t) => {
  const f = fixture(t);
  const tweets = ['1', '2', '3', '4'].map(id => tweet(id));
  await processReplies([], config, { ...f, now: start });
  await processReplies(tweets, config, { ...f, now: start + 2000 });
  assert.deepEqual(f.calls, ['1', '2', '3']);
  await processReplies(tweets, config, { ...f, now: start + 3000 });
  assert.deepEqual(f.calls, ['1', '2', '3', '4']);
});

test('off mode does not create state or call transport', async () => {
  await processReplies([tweet()], { ...config, replyMode: 'off' }, { send: () => assert.fail('must not send') });
});

test('shutdown stops the batch before another reply is attempted', async (t) => {
  const f = fixture(t);
  await processReplies([], config, { ...f, now: start });
  await processReplies([tweet(), tweet('2')], config, {
    ...f, now: start + 2000, shouldStop: () => f.calls.length > 0,
  });
  assert.deepEqual(f.calls, ['1']);
});

test('a second runner cannot post while the first is waiting for X', async (t) => {
  const f = fixture(t);
  await processReplies([], config, { ...f, now: start });
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const running = processReplies([tweet()], config, {
    ...f, now: start + 2000, send: async (c, t, before) => {
      await before(); started(); await wait; return { status: 'sent', replyId: '999' };
    },
  });
  await ready;
  try {
    await assert.rejects(processReplies([tweet()], config, { ...f, now: start + 2000 }), /Replies locked/);
  } finally {
    release(); await running;
  }
  assert.equal(read(f).entries['1'].status, 'sent');
});
