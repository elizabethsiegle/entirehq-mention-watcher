import { existsSync } from 'node:fs';
import { parseHandleList } from './score.mjs';
import { join } from 'node:path';

const REQUIRED = [
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'X_AUTH_TOKEN',
  'X_CSRF_TOKEN',
  'SLACK_WEBHOOK_URL',
];

export class ConfigError extends Error {
  constructor(missing) {
    super(
      `Missing required environment ${missing.length === 1 ? 'variable' : 'variables'}: ${missing.join(', ')}\n` +
        `Add them to .env in the project root — see .env.example for where each value comes from.`,
    );
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

// Claude Code sets CLAUDE_PROJECT_DIR for hook commands. Falling back to cwd
// keeps the scripts runnable by hand.
export function getProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function getDataDir(projectDir = getProjectDir()) {
  return join(projectDir, '.claude', 'entirehq-watcher');
}

export function loadEnvFile(projectDir = getProjectDir()) {
  const envPath = join(projectDir, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

function present(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !present(env[key]));
  if (missing.length) throw new ConfigError(missing);

  const pollRaw = present(env.X_WATCH_POLL_MS) ? env.X_WATCH_POLL_MS.trim() : '300000';
  const pollMs = Number(pollRaw);
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(`X_WATCH_POLL_MS must be a positive number of milliseconds, got: ${pollRaw}`);
  }

  const chainRaw = present(env.X_CHAIN_LIMIT) ? env.X_CHAIN_LIMIT.trim() : '3';
  const chainLimit = Number(chainRaw);
  if (!Number.isInteger(chainLimit) || chainLimit < 0) {
    throw new Error(`X_CHAIN_LIMIT must be a whole number of posts per thread (0 or more), got: ${chainRaw}`);
  }

  const ownHandle = (present(env.X_OWN_HANDLE) ? env.X_OWN_HANDLE.trim() : 'entirehq')
    .replace(/^@/, '')
    .toLowerCase();
  const brandDomain = (present(env.X_BRAND_DOMAIN) ? env.X_BRAND_DOMAIN.trim() : 'entire.io')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();

  // A post that links the site is a mention even when it never tags the
  // account, so both terms go into one query: one scrape, one Browserbase
  // session per poll. The domain is quoted so X matches it as a phrase
  // rather than as the word "entire".
  const searchQuery = present(env.X_SEARCH_QUERY)
    ? env.X_SEARCH_QUERY.trim()
    : `(@${ownHandle} OR "${brandDomain}")`;

  return {
    // Optional. Without it the LLM triage is skipped and the deterministic
    // score decides tiers alone, which is a supported mode, not a failure.
    anthropicApiKey: present(env.ANTHROPIC_API_KEY) ? env.ANTHROPIC_API_KEY.trim() : null,
    mutedHandles: parseHandleList(env.X_MUTE_HANDLES),
    teamHandles: parseHandleList(env.X_TEAM_HANDLES),
    browserbaseApiKey: env.BROWSERBASE_API_KEY.trim(),
    browserbaseProjectId: env.BROWSERBASE_PROJECT_ID.trim(),
    xAuthToken: env.X_AUTH_TOKEN.trim(),
    xCsrfToken: env.X_CSRF_TOKEN.trim(),
    slackWebhookUrl: env.SLACK_WEBHOOK_URL.trim(),
    pollMs,
    chainLimit,
    searchQuery,
    ownHandle,
    brandDomain,
    searchUrl: `https://x.com/search?q=${encodeURIComponent(searchQuery)}&src=typed_query&f=live`,
  };
}
