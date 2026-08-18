import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_SEEN = 500;

const EMPTY = () => ({ seen: [], baselined: false });

function storePath(dataDir) {
  return join(dataDir, 'seen.json');
}

export function loadStore(dataDir) {
  const path = storePath(dataDir);
  if (!existsSync(path)) return EMPTY();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed?.seen)
      ? { seen: parsed.seen.map(String), baselined: Boolean(parsed.baselined) }
      : EMPTY();
  } catch {
    // A corrupt store is not worth crashing over — rebuilding the baseline
    // costs one silent poll.
    return EMPTY();
  }
}

export function saveStore(dataDir, store) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(storePath(dataDir), JSON.stringify(store, null, 2));
}

// Pure. Returns a new store; never mutates the one passed in.
//
// `isBaseline` comes from the explicit `baselined` flag, never from an empty
// `seen` list: a poll can legitimately yield zero tweets after filtering, and
// re-baselining on the next poll would silently swallow the first real mention.
export function diffSeen(store, tweets) {
  const previous = Array.isArray(store?.seen) ? store.seen : [];
  const known = new Set(previous);
  const isBaseline = !store?.baselined;

  const fresh = [];
  const added = [];
  for (const tweet of tweets) {
    if (known.has(tweet.id)) continue;
    known.add(tweet.id);
    added.push(tweet.id);
    if (!isBaseline) fresh.push(tweet);
  }

  const seen = [...previous, ...added].slice(-MAX_SEEN);
  return { isBaseline, fresh, store: { seen, baselined: true } };
}
