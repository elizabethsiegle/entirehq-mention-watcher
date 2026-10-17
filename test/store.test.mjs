import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadStore,
  saveStore,
  diffSeen,
  markSeen,
  setLoginWallAlerted,
  setBackoffAlerted,
  setEmptyResultsAlerted,
  chainCounts,
  recordChainPost,
  MAX_SEEN,
  MAX_CHAINS,
  CHAIN_WINDOW_MS,
} from '../scripts/store.mjs';

const EMPTY_STORE = {
  seen: [],
  chains: {},
  baselined: false,
  loginWallAlerted: false,
  backoffAlerted: false,
  emptyResultsAlerted: false,
};

function tweet(id) {
  return {
    id,
    author: 'somedev',
    text: `tweet ${id}`,
    url: `https://x.com/somedev/status/${id}`,
    createdAt: '2026-08-18T14:00:00.000Z',
    kind: 'mention',
  };
}

test('loadStore returns an empty un-baselined store when the file is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  assert.deepEqual(loadStore(dir), EMPTY_STORE);
});

test('loadStore returns an empty un-baselined store when the file is corrupt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  writeFileSync(join(dir, 'seen.json'), '{ not json');
  assert.deepEqual(loadStore(dir), EMPTY_STORE);
});

test('loadStore defaults baselined to false when an existing file omits it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  writeFileSync(join(dir, 'seen.json'), JSON.stringify({ seen: ['a'] }));
  assert.deepEqual(loadStore(dir), { ...EMPTY_STORE, seen: ['a'] });
});

test('loadStore defaults loginWallAlerted, backoffAlerted, and emptyResultsAlerted to false when an existing file omits them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  writeFileSync(join(dir, 'seen.json'), JSON.stringify({ seen: ['a'], baselined: true }));
  assert.deepEqual(loadStore(dir), { ...EMPTY_STORE, seen: ['a'], baselined: true });
});

test('saveStore then loadStore round-trips', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'store-')), 'nested');
  saveStore(dir, { seen: ['a', 'b'], baselined: true });
  assert.deepEqual(loadStore(dir), { ...EMPTY_STORE, seen: ['a', 'b'], baselined: true });
  assert.ok(readFileSync(join(dir, 'seen.json'), 'utf8').includes('"a"'));
});

test('saveStore then loadStore round-trips loginWallAlerted, backoffAlerted, and emptyResultsAlerted', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'store-')), 'nested');
  const full = {
    seen: ['a'],
    chains: {},
    baselined: true,
    loginWallAlerted: true,
    backoffAlerted: true,
    emptyResultsAlerted: true,
  };
  saveStore(dir, full);
  assert.deepEqual(loadStore(dir), full);
});

test('diffSeen on a cold store records everything and notifies nothing', () => {
  const result = diffSeen({ seen: [], baselined: false }, [tweet('1'), tweet('2')]);
  assert.equal(result.isBaseline, true);
  assert.deepEqual(result.fresh, []);
  assert.deepEqual(result.store.seen, ['1', '2']);
  assert.equal(result.store.baselined, true);
});

test('an empty poll still marks the store baselined, so the next real mention notifies', () => {
  const first = diffSeen({ seen: [], baselined: false }, []);
  assert.equal(first.isBaseline, true);
  assert.deepEqual(first.store.seen, []);
  assert.equal(first.store.baselined, true);

  // The bug this guards: inferring baseline from an empty `seen` would swallow
  // this tweet instead of notifying.
  const second = diffSeen(first.store, [tweet('1')]);
  assert.equal(second.isBaseline, false);
  assert.deepEqual(second.fresh.map((t) => t.id), ['1']);
});

test('diffSeen returns only ids not already seen', () => {
  const result = diffSeen({ seen: ['1'], baselined: true }, [tweet('1'), tweet('2'), tweet('3')]);
  assert.equal(result.isBaseline, false);
  assert.deepEqual(result.fresh.map((t) => t.id), ['2', '3']);
  assert.deepEqual(result.store.seen, ['1', '2', '3']);
});

test('diffSeen does not mutate the store it was given', () => {
  const original = { seen: ['1'], baselined: true };
  diffSeen(original, [tweet('2')]);
  assert.deepEqual(original.seen, ['1']);
});

test('diffSeen deduplicates ids repeated within one batch', () => {
  const result = diffSeen({ seen: [], baselined: false }, [tweet('1'), tweet('1')]);
  assert.deepEqual(result.store.seen, ['1']);
});

test('diffSeen evicts oldest ids beyond MAX_SEEN', () => {
  const seen = Array.from({ length: MAX_SEEN }, (_, i) => `old-${i}`);
  const result = diffSeen({ seen, baselined: true }, [tweet('brand-new')]);
  assert.equal(result.store.seen.length, MAX_SEEN);
  assert.equal(result.store.seen.at(-1), 'brand-new');
  assert.equal(result.store.seen[0], 'old-1', 'the oldest id is the one dropped');
});

test('MAX_SEEN is 500', () => {
  assert.equal(MAX_SEEN, 500);
});

test('markSeen appends an id', () => {
  const result = markSeen({ seen: ['1'], baselined: true }, '2');
  assert.deepEqual(result.seen, ['1', '2']);
});

test('markSeen does not mutate the store it was given', () => {
  const original = { seen: ['1'], baselined: true };
  markSeen(original, '2');
  assert.deepEqual(original.seen, ['1']);
});

test('markSeen is a no-op for an id already present', () => {
  const result = markSeen({ seen: ['1', '2'], baselined: true }, '2');
  assert.deepEqual(result.seen, ['1', '2']);
});

test('markSeen evicts the oldest id when at MAX_SEEN', () => {
  const seen = Array.from({ length: MAX_SEEN }, (_, i) => `old-${i}`);
  const result = markSeen({ seen, baselined: true }, 'brand-new');
  assert.equal(result.seen.length, MAX_SEEN);
  assert.equal(result.seen.at(-1), 'brand-new');
  assert.equal(result.seen[0], 'old-1', 'the oldest id is the one dropped');
});

test('markSeen preserves baselined', () => {
  assert.equal(markSeen({ seen: [], baselined: false }, '1').baselined, false);
  assert.equal(markSeen({ seen: [], baselined: true }, '1').baselined, true);
});

test('markSeen preserves loginWallAlerted, backoffAlerted, and emptyResultsAlerted', () => {
  const store = {
    seen: ['1'],
    baselined: true,
    loginWallAlerted: true,
    backoffAlerted: true,
    emptyResultsAlerted: true,
  };
  const result = markSeen(store, '2');
  assert.equal(result.loginWallAlerted, true);
  assert.equal(result.backoffAlerted, true);
  assert.equal(result.emptyResultsAlerted, true);
});

test('diffSeen preserves loginWallAlerted, backoffAlerted, and emptyResultsAlerted', () => {
  const store = {
    seen: [],
    baselined: true,
    loginWallAlerted: true,
    backoffAlerted: true,
    emptyResultsAlerted: true,
  };
  const result = diffSeen(store, [tweet('1')]);
  assert.equal(result.store.loginWallAlerted, true);
  assert.equal(result.store.backoffAlerted, true);
  assert.equal(result.store.emptyResultsAlerted, true);
});

test('setLoginWallAlerted sets the flag without mutating the input', () => {
  const original = { seen: [], baselined: true, loginWallAlerted: false, backoffAlerted: false, emptyResultsAlerted: false };
  const result = setLoginWallAlerted(original, true);
  assert.equal(result.loginWallAlerted, true);
  assert.equal(original.loginWallAlerted, false, 'input must not be mutated');
});

test('setBackoffAlerted sets the flag without mutating the input', () => {
  const original = { seen: [], baselined: true, loginWallAlerted: false, backoffAlerted: false, emptyResultsAlerted: false };
  const result = setBackoffAlerted(original, true);
  assert.equal(result.backoffAlerted, true);
  assert.equal(original.backoffAlerted, false, 'input must not be mutated');
});

test('setEmptyResultsAlerted sets the flag without mutating the input', () => {
  const original = { seen: [], baselined: true, loginWallAlerted: false, backoffAlerted: false, emptyResultsAlerted: false };
  const result = setEmptyResultsAlerted(original, true);
  assert.equal(result.emptyResultsAlerted, true);
  assert.equal(original.emptyResultsAlerted, false, 'input must not be mutated');
});

test('the alert setters can be turned back off and preserve the rest of the store', () => {
  const store = { seen: ['1', '2'], baselined: true, loginWallAlerted: true, backoffAlerted: true, emptyResultsAlerted: true };
  const result = setLoginWallAlerted(store, false);
  assert.equal(result.loginWallAlerted, false);
  assert.deepEqual(result.seen, ['1', '2']);
  assert.equal(result.baselined, true);
  assert.equal(result.backoffAlerted, true);
  assert.equal(result.emptyResultsAlerted, true);
});

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

test('a store with no history has spent no thread budget', () => {
  assert.deepEqual(chainCounts(EMPTY_STORE, NOW), {});
  assert.deepEqual(chainCounts({}, NOW), {});
  assert.deepEqual(chainCounts(null, NOW), {});
});

test('recordChainPost charges one post to a thread and keeps counting from the first', () => {
  const once = recordChainPost(EMPTY_STORE, 'thread:a', NOW);
  const twice = recordChainPost(once, 'thread:a', NOW + 60000);
  assert.deepEqual(chainCounts(twice, NOW + 60000), { 'thread:a': 2 });
  assert.equal(twice.chains['thread:a'].firstAt, NOW, 'the window starts at the first post, not the last');
});

test('recordChainPost leaves the store it was given alone', () => {
  const before = recordChainPost(EMPTY_STORE, 'thread:a', NOW);
  const snapshot = JSON.stringify(before);
  recordChainPost(before, 'thread:a', NOW);
  assert.equal(JSON.stringify(before), snapshot);
});

test('a thread that went quiet past the window starts fresh', () => {
  const old = recordChainPost(EMPTY_STORE, 'thread:a', NOW - CHAIN_WINDOW_MS - 1);
  assert.deepEqual(chainCounts(old, NOW), {}, 'an expired budget must not keep collapsing a thread forever');
  assert.deepEqual(chainCounts(old, NOW - CHAIN_WINDOW_MS + 1000), { 'thread:a': 1 });
});

test('the chain table is capped, dropping the threads that started longest ago', () => {
  let store = EMPTY_STORE;
  for (let i = 0; i < MAX_CHAINS + 10; i++) store = recordChainPost(store, `thread:${i}`, NOW + i);
  const counts = chainCounts(store, NOW + MAX_CHAINS + 10);
  assert.equal(Object.keys(counts).length, MAX_CHAINS);
  assert.ok(!counts['thread:0'], 'the oldest thread must be the one dropped');
  assert.ok(counts[`thread:${MAX_CHAINS + 9}`], 'the newest thread must be kept');
});

test('thread budgets survive diffSeen and markSeen', () => {
  const store = recordChainPost({ ...EMPTY_STORE, baselined: true }, 'thread:a', NOW);
  assert.deepEqual(chainCounts(diffSeen(store, [tweet('1')]).store, NOW), { 'thread:a': 1 });
  assert.deepEqual(chainCounts(markSeen(store, '1'), NOW), { 'thread:a': 1 });
});

test('thread budgets survive a save and load round trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  saveStore(dir, recordChainPost({ ...EMPTY_STORE, baselined: true }, 'thread:a', NOW));
  assert.deepEqual(chainCounts(loadStore(dir), NOW), { 'thread:a': 1 });
});

test('loadStore ignores a chain table that is the wrong shape instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  writeFileSync(
    join(dir, 'seen.json'),
    JSON.stringify({
      seen: ['1'],
      baselined: true,
      chains: { ok: { count: 2, firstAt: NOW }, bad: { count: 'two' }, worse: null, zero: { count: 0, firstAt: NOW } },
    }),
  );
  assert.deepEqual(chainCounts(loadStore(dir), NOW), { ok: 2 });
});

test('a chain table that is an array is read as no history at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  writeFileSync(join(dir, 'seen.json'), JSON.stringify({ seen: [], baselined: true, chains: ['nope'] }));
  assert.deepEqual(loadStore(dir).chains, {});
});
