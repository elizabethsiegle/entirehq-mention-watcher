import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPLY_TEXT, replyCandidates } from './reply-match.mjs';
import { sendReply } from './x-reply.mjs';
import { fetchGithubStatus, describeGithubStatus } from './github-status.mjs';

export const REPLY_LIMIT_PER_POLL = 3;
const STATUSES = new Set(['baseline', 'dry-run', 'pending', 'sent', 'retry', 'unknown', 'rejected']);

function readState(path, handle, now) {
  if (!existsSync(path)) return { version: 1, handle, startedAt: now, pauseUntil: 0, entries: {} };
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.version !== 1 || state.handle !== handle || !Number.isFinite(state.startedAt)
    || !Number.isFinite(state.pauseUntil) || !state.entries || Array.isArray(state.entries)
    || typeof state.entries !== 'object' || Object.entries(state.entries).some(([id, entry]) =>
      !/^\d+$/.test(id) || !STATUSES.has(entry?.status)
      || (entry.status === 'retry' && !Number.isFinite(entry.retryAt)))) {
    throw new Error('Invalid reply state or changed posting account; restore the correct reply state before enabling replies');
  }
  return state;
}

function saveState(path, state) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

export async function processReplies(tweets, config, {
  dataDir, now = Date.now(), send = sendReply, log = () => {}, alert = async () => {}, shouldStop = () => false,
  checkStatus = fetchGithubStatus,
} = {}) {
  if (config.replyMode === 'off') return;
  mkdirSync(dataDir, { recursive: true });
  const lock = join(dataDir, 'replies.lock');
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Replies locked by another process or interrupted run; inspect replies.lock before removing it');
    throw error;
  }
  try {
    writeFileSync(join(lock, 'pid'), String(process.pid));
    const path = join(dataDir, config.replyMode === 'live' ? 'replies.json' : 'replies-dry-run.json');
    const initializing = !existsSync(path);
    const state = readState(path, config.replyHandle, now);
    if (initializing) {
      for (const tweet of tweets) {
        if (/^\d+$/.test(tweet.id)) state.entries[tweet.id] = { status: 'baseline' };
      }
      saveState(path, state);
      log(`reply ${config.replyMode} baseline established for @${config.replyHandle}; existing tweets skipped`);
      return;
    }
    if (state.pauseUntil > now) return;
    const candidates = replyCandidates(tweets, config, { since: state.startedAt, now })
      .filter((tweet) => !state.entries[tweet.id]
        || (state.entries[tweet.id].status === 'retry' && state.entries[tweet.id].retryAt <= now))
      .slice(0, REPLY_LIMIT_PER_POLL);

    if (candidates.length === 0 || shouldStop()) return;
    const status = await checkStatus();
    if (!status?.ok || status.active !== true) {
      log(describeGithubStatus(status));
      return;
    }

    for (const tweet of candidates) {
      if (shouldStop()) break;
      if (config.replyMode === 'dry-run') {
        state.entries[tweet.id] = { status: 'dry-run', at: now };
        saveState(path, state);
        log(`reply dry-run: ${tweet.url} — ${REPLY_TEXT}`);
        continue;
      }
      let prepared = false;
      let statusBlocked = false;
      let result;
      try {
        result = await send(config, tweet, async () => {
          // Recheck after opening the composer so a recovery during browser
          // setup or a previous reply cannot authorize a stale outage claim.
          const current = await checkStatus();
          if (!current?.ok || current.active !== true || shouldStop()) {
            statusBlocked = true;
            log(describeGithubStatus(current));
            throw new Error('No current GitHub disruption confirmed; reply held');
          }
          state.entries[tweet.id] = { status: 'pending', at: now };
          saveState(path, state);
          prepared = true;
        });
      } catch {
        result = prepared
          ? { status: 'unknown', error: 'Reply interrupted after submission was prepared; inspect X before retrying' }
          : { status: 'retry', error: 'Reply preparation failed', retryAt: now + 900000 };
      }
      if (statusBlocked) break;
      if (!['sent', 'retry', 'unknown', 'rejected'].includes(result?.status)
        || (result.status === 'retry' && !Number.isFinite(result.retryAt))) {
        result = { status: 'unknown', error: 'Invalid reply result; inspect X before retrying' };
      }
      state.entries[tweet.id] = { ...result, at: now };
      if (result.status !== 'sent') state.pauseUntil = result.status === 'retry' ? result.retryAt : now + 900000;
      saveState(path, state);
      log(`reply ${result.status}: ${tweet.url}${result.replyId ? ` → https://x.com/${config.replyHandle}/status/${result.replyId}` : ''}`);
      if (result.status !== 'sent') {
        await alert(`Auto-reply ${result.status}: ${tweet.url}. ${result.error}`);
        break;
      }
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
