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

// Best-effort release so a session isn't left running (and billing) when
// something downstream throws. Swallows its own failure so the original
// error is always what the caller sees.
async function releaseSession(bb, session, config) {
  try {
    await bb.sessions.update(session.id, { status: 'REQUEST_RELEASE', projectId: config.browserbaseProjectId });
  } catch {
    // Release is best-effort — a failure here must not mask the original error.
  }
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
      // Heuristic, DOM-fallback path only — less reliable than the JSON
      // path's `is_quote_status` field. A genuine quoted tweet is rendered as
      // a nested clickable card, so its tweetText lives inside a [role="link"]
      // container. Counting tweetText nodes (the naive check) also fires on
      // "Translate post", which renders original + translated text as two
      // same-testid blocks with no quote involved.
      hasQuotedTweet: article.querySelector('[role="link"] [data-testid="tweetText"]') !== null,
    };
  });
}

export async function scrapeSearch(config) {
  const bb = new Browserbase({ apiKey: config.browserbaseApiKey });
  const session = await bb.sessions.create({ projectId: config.browserbaseProjectId });

  let browser;
  try {
    browser = await chromium.connectOverCDP(session.connectUrl);

    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('scrapeSearch: Browserbase session returned no browser context to inject cookies into');
    }
    await context.addCookies(sessionCookies(config));
    const page = context.pages()[0] || (await context.newPage());

    // Collect every SearchTimeline response the page fires; the first request
    // usually lands before `load` resolves, so the listener goes on first.
    // Handler promises are tracked (not just fired) and awaited below —
    // Playwright does not await `response` listeners itself, so without this
    // a still-in-flight `response.json()` could lose a race against the
    // fixed settle wait, silently truncating `payloads` and yielding a
    // partial-but-plausible `source: 'json'` result.
    const payloads = [];
    const pending = [];
    page.on('response', (response) => {
      if (!TIMELINE_RE.test(response.url())) return;
      pending.push(
        response
          .json()
          .then((json) => payloads.push(json))
          .catch(() => {
            // Non-JSON or already-consumed body — the DOM fallback covers us.
          }),
      );
    });

    await page.goto(config.searchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    await Promise.all(pending);

    const loginWall = await detectLoginWall(page);

    const fromJson = payloads.flatMap((payload) => parseTimelineJson(payload));
    if (fromJson.length) {
      // Wall detection is scoped (per spec) to a login-wall redirect or a
      // zero-result timeline with the login form present. A JSON payload
      // with real tweets means the session is good, so surfacing the raw
      // `loginWall` value here would report a false wall on a healthy
      // watcher and trip its backoff/Slack alarm for nothing.
      return { source: 'json', tweets: fromJson, loginWall: false };
    }

    const records = await page.evaluate(extractDomRecords);
    const domTweets = parseDomRecords(records);
    // Same scoping as the JSON path just above: the wall check only means
    // anything when we came back with nothing, otherwise a real result on a
    // healthy session would falsely trip the backoff/Slack alarm.
    return { source: 'dom', tweets: domTweets, loginWall: domTweets.length === 0 && loginWall };
  } catch (err) {
    await releaseSession(bb, session, config);
    throw err;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // A close that throws (a flaky remote CDP socket, typically) must
        // never replace a real result or a real error from the try block —
        // that's exactly what a throw from `finally` would do. It also means
        // the close can't be relied on to have released the Browserbase
        // session, so do it explicitly here instead.
        await releaseSession(bb, session, config);
      }
    }
  }
}
