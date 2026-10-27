import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_SEEN = 500;

// How long a thread's posting budget is remembered. A thread that drips one
// reply every poll would otherwise get a fresh budget every five minutes,
// which is the flood this is meant to stop, only slower.
export const CHAIN_WINDOW_MS = 6 * 60 * 60 * 1000;

// Bounds the file the same way MAX_SEEN does. Dropping the oldest entries
// first means the threads still being replied to are the ones kept.
export const MAX_CHAINS = 200;

const EMPTY = () => ({
  seen: [],
  chains: {},
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
          chains: readChains(parsed?.chains),
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
      chains: readChains(store?.chains),
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
    chains: readChains(store?.chains),
    baselined: Boolean(store?.baselined),
    loginWallAlerted: Boolean(store?.loginWallAlerted),
    backoffAlerted: Boolean(store?.backoffAlerted),
    emptyResultsAlerted: Boolean(store?.emptyResultsAlerted),
  };
}

// A thread's posting budget: how many of its replies have been announced
// individually, and when the count started. Anything older than the window
// is gone, so a thread that goes quiet starts fresh if it wakes up again.
function readChains(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const chains = {};
  for (const [id, value] of Object.entries(raw)) {
    const count = Number(value?.count);
    const firstAt = Number(value?.firstAt);
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(firstAt)) continue;
    chains[id] = { count: Math.floor(count), firstAt };
  }
  return chains;
}

function liveChains(chains, now) {
  const cutoff = now - CHAIN_WINDOW_MS;
  const live = Object.entries(chains).filter(([, c]) => c.firstAt > cutoff);
  live.sort((a, b) => a[1].firstAt - b[1].firstAt);
  return Object.fromEntries(live.slice(-MAX_CHAINS));
}

// Pure. How many individual posts each live thread has already spent.
export function chainCounts(store, now = Date.now()) {
  const chains = liveChains(readChains(store?.chains), now);
  return Object.fromEntries(Object.entries(chains).map(([id, c]) => [id, c.count]));
}

// Pure. Returns a new store with one more post charged to `chainId`. Called
// only after Slack accepts the post, so a failed delivery does not spend
// budget the channel never saw.
export function recordChainPost(store, chainId, now = Date.now()) {
  const chains = liveChains(readChains(store?.chains), now);
  const existing = chains[chainId];
  return {
    ...store,
    chains: liveChains(
      { ...chains, [chainId]: { count: (existing?.count ?? 0) + 1, firstAt: existing?.firstAt ?? now } },
      now,
    ),
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
