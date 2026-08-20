import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SCORE_MODEL } from './score.mjs';

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

// An explicit opt-out. Anything else, including an unset variable, leaves
// scoring on whenever a key is present.
function isOff(value) {
  if (!present(value)) return false;
  return ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !present(env[key]));
  if (missing.length) throw new ConfigError(missing);

  const pollRaw = present(env.X_WATCH_POLL_MS) ? env.X_WATCH_POLL_MS.trim() : '300000';
  const pollMs = Number(pollRaw);
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(`X_WATCH_POLL_MS must be a positive number of milliseconds, got: ${pollRaw}`);
  }

  // Scoring is optional and additive: without a key the watcher behaves
  // exactly as it did before, posting mentions with no urgency line.
  const anthropicApiKey = present(env.ANTHROPIC_API_KEY) ? env.ANTHROPIC_API_KEY.trim() : '';
  const scoreModel = present(env.X_SCORE_MODEL) ? env.X_SCORE_MODEL.trim() : SCORE_MODEL;
  const scoringEnabled = anthropicApiKey !== '' && !isOff(env.X_SCORE_TWEETS);

  const searchQuery = present(env.X_SEARCH_QUERY) ? env.X_SEARCH_QUERY.trim() : '@entirehq';
  const ownHandle = (present(env.X_OWN_HANDLE) ? env.X_OWN_HANDLE.trim() : 'entirehq')
    .replace(/^@/, '')
    .toLowerCase();

  return {
    browserbaseApiKey: env.BROWSERBASE_API_KEY.trim(),
    browserbaseProjectId: env.BROWSERBASE_PROJECT_ID.trim(),
    xAuthToken: env.X_AUTH_TOKEN.trim(),
    xCsrfToken: env.X_CSRF_TOKEN.trim(),
    slackWebhookUrl: env.SLACK_WEBHOOK_URL.trim(),
    anthropicApiKey,
    scoreModel,
    scoringEnabled,
    pollMs,
    searchQuery,
    ownHandle,
    searchUrl: `https://x.com/search?q=${encodeURIComponent(searchQuery)}&src=typed_query&f=live`,
  };
}
