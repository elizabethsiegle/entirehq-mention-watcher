import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../scripts/config.mjs';

const complete = {
  BROWSERBASE_API_KEY: 'bb_live_abc',
  BROWSERBASE_PROJECT_ID: 'proj_123',
  X_AUTH_TOKEN: 'auth_abc',
  X_CSRF_TOKEN: 'ct0_abc',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
};

test('loadConfig maps every required variable', () => {
  const cfg = loadConfig(complete);
  assert.equal(cfg.browserbaseApiKey, 'bb_live_abc');
  assert.equal(cfg.browserbaseProjectId, 'proj_123');
  assert.equal(cfg.xAuthToken, 'auth_abc');
  assert.equal(cfg.xCsrfToken, 'ct0_abc');
  assert.equal(cfg.slackWebhookUrl, 'https://hooks.slack.com/services/T/B/X');
});

test('loadConfig applies documented defaults', () => {
  const cfg = loadConfig(complete);
  assert.equal(cfg.pollMs, 300000);
  assert.equal(cfg.ownHandle, 'entirehq');
  assert.equal(cfg.brandDomain, 'entire.io');
});

test('the default search asks for the handle and the site in one query', () => {
  // One query means one Browserbase session per poll. Two searches would
  // double the per-poll cost for the same coverage.
  const cfg = loadConfig(complete);
  assert.equal(cfg.searchQuery, '(@entirehq OR "entire.io")');
  assert.match(cfg.searchUrl, /f=live$/);
  assert.equal(decodeURIComponent(new URL(cfg.searchUrl).searchParams.get('q')), '(@entirehq OR "entire.io")');
});

test('the default query follows a renamed handle and domain', () => {
  const cfg = loadConfig({ ...complete, X_OWN_HANDLE: '@AcmeHQ', X_BRAND_DOMAIN: 'https://acme.dev/' });
  assert.equal(cfg.brandDomain, 'acme.dev');
  assert.equal(cfg.searchQuery, '(@acmehq OR "acme.dev")');
});

test('an explicit X_SEARCH_QUERY is used verbatim', () => {
  const cfg = loadConfig({ ...complete, X_SEARCH_QUERY: '@entirehq OR url:entire.io' });
  assert.equal(cfg.searchQuery, '@entirehq OR url:entire.io');
});

test('loadConfig honours overrides and strips @ from the handle', () => {
  const cfg = loadConfig({ ...complete, X_WATCH_POLL_MS: '60000', X_OWN_HANDLE: '@EntireHQ' });
  assert.equal(cfg.pollMs, 60000);
  assert.equal(cfg.ownHandle, 'entirehq');
});

test('loadConfig builds the live-search URL from the query', () => {
  const cfg = loadConfig({ ...complete, X_SEARCH_QUERY: '@entirehq' });
  assert.equal(
    cfg.searchUrl,
    'https://x.com/search?q=%40entirehq&src=typed_query&f=live',
  );
});

test('loadConfig throws ConfigError naming every missing variable', () => {
  const { X_AUTH_TOKEN, SLACK_WEBHOOK_URL, ...partial } = complete;
  assert.throws(
    () => loadConfig(partial),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.deepEqual(err.missing.sort(), ['SLACK_WEBHOOK_URL', 'X_AUTH_TOKEN']);
      assert.match(err.message, /X_AUTH_TOKEN/);
      return true;
    },
  );
});

test('loadConfig treats blank strings as missing', () => {
  assert.throws(() => loadConfig({ ...complete, X_CSRF_TOKEN: '   ' }), ConfigError);
});

test('loadConfig rejects a non-numeric poll interval', () => {
  assert.throws(
    () => loadConfig({ ...complete, X_WATCH_POLL_MS: 'soon' }),
    /X_WATCH_POLL_MS/,
  );
});
