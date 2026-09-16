import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_EMPLOYEE_HANDLES, normalizeHandles, parseEmployeeFile } from './score.mjs';

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
// The hand-editable roster. Lives at the project root so it is obvious, and is
// read at boot like everything else in this file.
export const EMPLOYEE_FILE = 'employees.csv';

export function readEmployeeFile(projectDir = getProjectDir()) {
  try {
    const path = join(projectDir, EMPLOYEE_FILE);
    if (!existsSync(path)) return [];
    return parseEmployeeFile(readFileSync(path, 'utf8'));
  } catch {
    // An unreadable roster costs correct badging, not a boot. Falling back to
    // the built-in list is strictly better than refusing to watch at all.
    return [];
  }
}

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

export function loadConfig(env = process.env, projectDir = getProjectDir()) {
  const missing = REQUIRED.filter((key) => !present(env[key]));
  if (missing.length) throw new ConfigError(missing);

  const pollRaw = present(env.X_WATCH_POLL_MS) ? env.X_WATCH_POLL_MS.trim() : '300000';
  const pollMs = Number(pollRaw);
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(`X_WATCH_POLL_MS must be a positive number of milliseconds, got: ${pollRaw}`);
  }

  const searchQuery = present(env.X_SEARCH_QUERY) ? env.X_SEARCH_QUERY.trim() : '@entirehq';
  const ownHandle = (present(env.X_OWN_HANDLE) ? env.X_OWN_HANDLE.trim() : 'entirehq')
    .replace(/^@/, '')
    .toLowerCase();

  // Who counts as the Entire team, for scoring. Three sources, in order:
  //   1. X_EMPLOYEE_HANDLES, for a one-off override without touching the file
  //   2. employees.csv, the file people are actually meant to edit
  //   3. the built-in roster in score.mjs, so a fresh clone still works
  // Unlike the other options, getting this wrong only mis-scores a post rather
  // than breaking the watcher, which is why nothing here throws.
  const fromFile = present(env.X_EMPLOYEE_HANDLES) ? [] : readEmployeeFile(projectDir);
  const roster = present(env.X_EMPLOYEE_HANDLES)
    ? env.X_EMPLOYEE_HANDLES.split(',')
    : fromFile.length > 0
      ? fromFile
      : DEFAULT_EMPLOYEE_HANDLES;
  const employeeHandles = [...normalizeHandles(roster)];

  return {
    browserbaseApiKey: env.BROWSERBASE_API_KEY.trim(),
    browserbaseProjectId: env.BROWSERBASE_PROJECT_ID.trim(),
    xAuthToken: env.X_AUTH_TOKEN.trim(),
    xCsrfToken: env.X_CSRF_TOKEN.trim(),
    slackWebhookUrl: env.SLACK_WEBHOOK_URL.trim(),
    pollMs,
    searchQuery,
    ownHandle,
    employeeHandles,
    searchUrl: `https://x.com/search?q=${encodeURIComponent(searchQuery)}&src=typed_query&f=live`,
  };
}
