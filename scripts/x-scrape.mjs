import Browserbase from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import { parseTimelineJson, parseDomRecords } from './parse.mjs';

const TIMELINE_RE = /\/graphql\/[^/]+\/SearchTimeline/;
const NAV_TIMEOUT_MS = 45000;
const SETTLE_MS = 6000;

// X reads the session from cookies on both hosts; ct0 must also travel as the
// x-csrf-token header on the XHR, which the page's own client handles once the
// cookie is present.
function sessionCookies({ xAuthToken, xCsrfToken }) {
  return ['x.com', 'twitter.com'].flatMap((domain) => [
    { name: 'auth_token', value: xAuthToken, domain: `.${domain}`, path: '/', httpOnly: true, secure: true },
    { name: 'ct0', value: xCsrfToken, domain: `.${domain}`, path: '/', secure: true },
  ]);
}

async function detectLoginWall(page) {
  const url = page.url();
  if (/\/(i\/flow\/login|login)/.test(url)) return true;
  return (await page.locator('input[name="text"][autocomplete="username"]').count()) > 0;
}

// Runs inside the browser. Mirrors the record shape parseDomRecords expects.
function extractDomRecords() {
  return Array.from(document.querySelectorAll('article[data-testid="tweet"]')).map((article) => {
    const timeEl = article.querySelector('time[datetime]');
    const permalink = timeEl?.closest('a')?.getAttribute('href') ?? '';
    const handleEl = Array.from(article.querySelectorAll('[data-testid="User-Name"] span')).find(
      (el) => el.textContent.startsWith('@'),
    );
    return {
      permalink,
      handle: handleEl?.textContent ?? '',
      text: article.querySelector('[data-testid="tweetText"]')?.textContent ?? '',
      datetime: timeEl?.getAttribute('datetime') ?? null,
      hasReplyingTo: article.textContent.includes('Replying to'),
      hasQuotedTweet: article.querySelectorAll('[data-testid="tweetText"]').length > 1,
    };
  });
}

export async function scrapeSearch(config) {
  const bb = new Browserbase({ apiKey: config.browserbaseApiKey });
  const session = await bb.sessions.create({ projectId: config.browserbaseProjectId });
  const browser = await chromium.connectOverCDP(session.connectUrl);

  try {
    const context = browser.contexts()[0];
    await context.addCookies(sessionCookies(config));
    const page = context.pages()[0] || (await context.newPage());

    // Collect every SearchTimeline response the page fires; the first request
    // usually lands before `load` resolves, so the listener goes on first.
    const payloads = [];
    page.on('response', async (response) => {
      if (!TIMELINE_RE.test(response.url())) return;
      try {
        payloads.push(await response.json());
      } catch {
        // Non-JSON or already-consumed body — the DOM fallback covers us.
      }
    });

    await page.goto(config.searchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);

    const loginWall = await detectLoginWall(page);

    const fromJson = payloads.flatMap((payload) => parseTimelineJson(payload));
    if (fromJson.length) return { source: 'json', tweets: fromJson, loginWall: false };

    const records = await page.evaluate(extractDomRecords);
    return { source: 'dom', tweets: parseDomRecords(records), loginWall };
  } finally {
    await browser.close();
  }
}
