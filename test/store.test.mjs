import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStore, saveStore, diffSeen, MAX_SEEN } from '../scripts/store.mjs';

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
  assert.deepEqual(loadStore(dir), { seen: [], baselined: false });
});

test('loadStore returns an empty un-baselined store when the file is corrupt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  writeFileSync(join(dir, 'seen.json'), '{ not json');
  assert.deepEqual(loadStore(dir), { seen: [], baselined: false });
});

test('loadStore defaults baselined to false when an existing file omits it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  writeFileSync(join(dir, 'seen.json'), JSON.stringify({ seen: ['a'] }));
  assert.deepEqual(loadStore(dir), { seen: ['a'], baselined: false });
});

test('saveStore then loadStore round-trips', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'store-')), 'nested');
  saveStore(dir, { seen: ['a', 'b'], baselined: true });
  assert.deepEqual(loadStore(dir), { seen: ['a', 'b'], baselined: true });
  assert.ok(readFileSync(join(dir, 'seen.json'), 'utf8').includes('"a"'));
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
