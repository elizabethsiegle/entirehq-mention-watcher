import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_SEEN = 500;

const EMPTY = () => ({
  seen: [],
  baselined: false,
  loginWallAlerted: false,
  backoffAlerted: false,
  emptyResultsAlerted: false,
});

function storePath(dataDir) {
  return join(dataDir, 'seen.json');
}

export function loadStore(dataDir) {
  const path = storePath(dataDir);
  if (!existsSync(path)) return EMPTY();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed?.seen)
      ? {
          seen: parsed.seen.map(String),
          baselined: Boolean(parsed.baselined),
          loginWallAlerted: Boolean(parsed.loginWallAlerted),
          backoffAlerted: Boolean(parsed.backoffAlerted),
          emptyResultsAlerted: Boolean(parsed.emptyResultsAlerted),
        }
      : EMPTY();
  } catch {
    // A corrupt store is not worth crashing over — rebuilding the baseline
    // costs one silent poll.
    return EMPTY();
  }
}

// Atomic: write to a temp file in the same directory, then rename over the
// target. saveStore now runs once per announced tweet (and once per alert
// flag flip), so a crash mid-write is likelier than it used to be — a
// partial write would otherwise leave a corrupt file that loadStore's catch
// turns into a fresh, un-baselined store, silently re-baselining and
// swallowing every mention on the page from then on. A same-directory
// rename is atomic on the filesystems this runs on; a cross-device temp
// file would not be.
export function saveStore(dataDir, store) {
  mkdirSync(dataDir, { recursive: true });
  const path = storePath(dataDir);
  const tmpPath = join(dataDir, `.seen.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  renameSync(tmpPath, path);
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
  return {
    isBaseline,
    fresh,
    store: {
      seen,
      baselined: true,
      loginWallAlerted: Boolean(store?.loginWallAlerted),
      backoffAlerted: Boolean(store?.backoffAlerted),
      emptyResultsAlerted: Boolean(store?.emptyResultsAlerted),
    },
  };
}

// Pure. Returns a new store; never mutates the one passed in. A no-op if
// `id` is already present, so re-marking a tweet doesn't grow the list
// twice. Callers persist one id at a time (see watch.mjs) so a process
// killed mid-batch can't have already recorded ids it never actually
// announced.
export function markSeen(store, id) {
  const previous = Array.isArray(store?.seen) ? store.seen : [];
  const seen = previous.includes(id) ? [...previous] : [...previous, id].slice(-MAX_SEEN);
  return {
    seen,
    baselined: Boolean(store?.baselined),
    loginWallAlerted: Boolean(store?.loginWallAlerted),
    backoffAlerted: Boolean(store?.backoffAlerted),
    emptyResultsAlerted: Boolean(store?.emptyResultsAlerted),
  };
}

// Pure setters for the once-only alert flags. Each returns a NEW store with
// just that flag set; the rest of the store is carried through unchanged.
// Persisting these (rather than keeping them as module-level variables in
// watch.mjs) is what makes each alert fire exactly once per episode instead
// of once per process — the watcher is respawned on every SessionStart and
// every /clear, which would otherwise reset an in-memory flag and re-alert
// on a condition that never actually recovered.
export function setLoginWallAlerted(store, value) {
  return { ...store, loginWallAlerted: Boolean(value) };
}

export function setBackoffAlerted(store, value) {
  return { ...store, backoffAlerted: Boolean(value) };
}

export function setEmptyResultsAlerted(store, value) {
  return { ...store, emptyResultsAlerted: Boolean(value) };
}
