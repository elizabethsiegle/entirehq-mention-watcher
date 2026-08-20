import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../scripts/config.mjs';
import { SCORE_MODEL } from '../scripts/score.mjs';

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
  assert.equal(cfg.searchQuery, '@entirehq');
  assert.equal(cfg.ownHandle, 'entirehq');
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

test('scoring is off when no ANTHROPIC_API_KEY is set', () => {
  const config = loadConfig(complete);
  assert.equal(config.scoringEnabled, false);
  assert.equal(config.anthropicApiKey, '');
});

test('scoring turns on with an ANTHROPIC_API_KEY and defaults to the pinned model', () => {
  const config = loadConfig({ ...complete, ANTHROPIC_API_KEY: ' sk-test ' });
  assert.equal(config.scoringEnabled, true);
  assert.equal(config.anthropicApiKey, 'sk-test');
  assert.equal(config.scoreModel, SCORE_MODEL);
});

test('X_SCORE_TWEETS accepts an explicit opt-out even when a key is present', () => {
  for (const off of ['0', 'false', 'no', 'off', 'OFF']) {
    const config = loadConfig({ ...complete, ANTHROPIC_API_KEY: 'sk-test', X_SCORE_TWEETS: off });
    assert.equal(config.scoringEnabled, false, `${off} should disable scoring`);
  }
  for (const on of ['1', 'true', 'yes', '']) {
    const config = loadConfig({ ...complete, ANTHROPIC_API_KEY: 'sk-test', X_SCORE_TWEETS: on });
    assert.equal(config.scoringEnabled, true, `${on} should leave scoring on`);
  }
});

test('X_SCORE_MODEL overrides the scoring model', () => {
  const config = loadConfig({ ...complete, ANTHROPIC_API_KEY: 'sk-test', X_SCORE_MODEL: ' claude-haiku-4-5 ' });
  assert.equal(config.scoreModel, 'claude-haiku-4-5');
});
