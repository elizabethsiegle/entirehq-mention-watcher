import Browserbase from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { sessionCookies } from './x-scrape.mjs';
import { REPLY_TEXT } from './reply-match.mjs';

export async function withReplyPage(config, action) {
  const bb = new Browserbase({ apiKey: config.browserbaseApiKey, timeout: 20000, maxRetries: 0 });
  const session = await bb.sessions.create({ projectId: config.browserbaseProjectId });
  let browser;
  try {
    browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 20000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error('No browser context for replies');
    await context.addCookies(sessionCookies(config));
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(45000);
    return await action(page);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await bb.sessions.update(session.id, { status: 'REQUEST_RELEASE', projectId: config.browserbaseProjectId }).catch(() => {});
  }
}

export async function verifyReplyAccount(page, expectedHandle) {
  const href = await page.getByTestId('AppTabBar_Profile_Link').getAttribute('href');
  const handle = /^\/([a-z0-9_]{1,15})$/i.exec(href || '')?.[1]?.toLowerCase();
  if (!handle || handle !== expectedHandle.toLowerCase()) {
    throw new Error(`X reply account mismatch: expected @${expectedHandle}, found ${handle ? `@${handle}` : 'no authenticated account'}`);
  }
  return handle;
}

export function parseReplyResponse(status, body, tweetId, headers = {}, now = Date.now()) {
  const result = body?.data?.create_tweet?.tweet_results?.result;
  const tweet = result?.tweet ?? result;
  if (status >= 200 && status < 300 && /^\d+$/.test(tweet?.rest_id || '')
    && tweet?.legacy?.in_reply_to_status_id_str === tweetId) {
    return { status: 'sent', replyId: tweet.rest_id };
  }
  const codes = (Array.isArray(body?.errors) ? body.errors : []).map((error) => error.code);
  if (status === 429 || codes.includes(88) || codes.includes(185)) {
    const seconds = Number(headers['retry-after']);
    const retryAfter = Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : Date.parse(headers['retry-after']);
    const reset = Number(headers['x-rate-limit-reset']) * 1000;
    return {
      status: 'retry',
      retryAt: Math.max(now + (codes.includes(185) ? 86400000 : 900000), retryAfter || 0, reset || 0),
      error: 'X rate limit; replies paused',
    };
  }
  if (status >= 400 && status < 500) {
    return { status: 'rejected', error: `X rejected reply (HTTP ${status})` };
  }
  // A transport failure, duplicate error, or changed response shape can hide a
  // successful send. Never retry those automatically.
  return { status: 'unknown', error: `Reply was not confirmed (HTTP ${status}); inspect X before retrying` };
}

export async function prepareReply(page, tweet, config) {
  await page.goto(`https://x.com/${tweet.author}/status/${tweet.id}`, { waitUntil: 'domcontentloaded' });
  await verifyReplyAccount(page, config.replyHandle);
  const target = page.getByTestId('tweet').filter({
    has: page.locator(`a[href="/${tweet.author}/status/${tweet.id}"] time`),
  });
  await target.first().waitFor({ state: 'visible' });
  if (await target.count() !== 1) throw new Error('Could not identify the exact tweet to reply to');
  await target.getByTestId('reply').click();
  const dialog = page.getByRole('dialog');
  const editor = dialog.getByTestId('tweetTextarea_0');
  await editor.fill(REPLY_TEXT);
  if (await editor.innerText() !== REPLY_TEXT) throw new Error('Reply composer text does not match');
  const button = dialog.getByTestId('tweetButton');
  if (!await button.isEnabled()) throw new Error('Reply button is disabled');
  return button;
}

export async function sendReply(config, tweet, beforeSubmit, { open = withReplyPage } = {}) {
  let submitted = false;
  try {
    return await open(config, async (page) => {
      const button = await prepareReply(page, tweet, config);
      await beforeSubmit();
      submitted = true;
      const responsePromise = page.waitForResponse((response) => {
        if (!/\/graphql\/[^/]+\/CreateTweet(?:\?|$)/.test(response.url())) return false;
        try {
          const variables = response.request().postDataJSON()?.variables;
          return variables?.reply?.in_reply_to_tweet_id === tweet.id && variables?.tweet_text === REPLY_TEXT;
        } catch {
          return false;
        }
      }, { timeout: 20000 }).catch(() => null);
      try {
        await button.click();
        const response = await responsePromise;
        if (!response) return { status: 'unknown', error: 'Reply confirmation timed out; inspect X before retrying' };
        const body = await response.json().catch(() => null);
        return parseReplyResponse(response.status(), body, tweet.id, response.headers());
      } finally {
        await responsePromise;
      }
    });
  } catch {
    return submitted
      ? { status: 'unknown', error: 'Reply submission interrupted; inspect X before retrying' }
      : { status: 'retry', error: 'Could not prepare reply; check X login, account, and composer', retryAt: Date.now() + 900000 };
  }
}
