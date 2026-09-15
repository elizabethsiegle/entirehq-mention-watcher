import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError, readEmployeeFile, EMPLOYEE_FILE } from '../scripts/config.mjs';

// A project dir containing only the roster file we hand it, so these assertions
// never depend on the repo's own employees.csv.
function projectWith(rosterContents) {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-cfg-'));
  if (rosterContents !== null) writeFileSync(join(dir, EMPLOYEE_FILE), rosterContents);
  return dir;
}

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

test('loadConfig defaults the employee roster to the six Entire handles', () => {
  const cfg = loadConfig(complete);
  assert.deepEqual(
    [...cfg.employeeHandles].sort(),
    ['ashtom', 'blackgirlbytes', 'evisdrenova', 'haimantikam', 'jkcso', 'lizziepika'],
  );
});

test('X_EMPLOYEE_HANDLES replaces the roster, tolerating @ and spacing', () => {
  const cfg = loadConfig({ ...complete, X_EMPLOYEE_HANDLES: '@NewHire, second ,@third' });
  assert.deepEqual([...cfg.employeeHandles].sort(), ['newhire', 'second', 'third']);
});

test('a blank X_EMPLOYEE_HANDLES falls back to the default roster', () => {
  const cfg = loadConfig({ ...complete, X_EMPLOYEE_HANDLES: '   ' });
  assert.equal(cfg.employeeHandles.length, 6);
});

test('X_EMPLOYEE_HANDLES dedupes repeated handles', () => {
  const cfg = loadConfig({ ...complete, X_EMPLOYEE_HANDLES: 'ashtom,@Ashtom, ashtom ' });
  assert.deepEqual(cfg.employeeHandles, ['ashtom']);
});

test('a bad employee roster never throws, unlike the other options', () => {
  // Mis-scoring one post is recoverable; refusing to boot is not.
  assert.doesNotThrow(() => loadConfig({ ...complete, X_EMPLOYEE_HANDLES: ',,,@@@,' }));
});

test('the roster comes from employees.csv when it is present', () => {
  const dir = projectWith('newhire,Some Person\nsecond\n');
  try {
    assert.deepEqual(loadConfig(complete, dir).employeeHandles, ['newhire', 'second']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing employees.csv falls back to the built-in roster', () => {
  const dir = projectWith(null);
  try {
    assert.equal(loadConfig(complete, dir).employeeHandles.length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an employees.csv with no usable handles falls back rather than emptying', () => {
  // An accidentally blanked file should not silently stop badging the team.
  const dir = projectWith('# everyone got deleted\n\n');
  try {
    assert.equal(loadConfig(complete, dir).employeeHandles.length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('X_EMPLOYEE_HANDLES outranks employees.csv', () => {
  const dir = projectWith('fromfile\n');
  try {
    const cfg = loadConfig({ ...complete, X_EMPLOYEE_HANDLES: '@fromenv' }, dir);
    assert.deepEqual(cfg.employeeHandles, ['fromenv']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the roster file supports notes and comments end to end', () => {
  const dir = projectWith('# team\nlizziepika,Lizzie Siegle,DevRel\n@Ashtom,Thomas\n');
  try {
    assert.deepEqual(loadConfig(complete, dir).employeeHandles, ['lizziepika', 'ashtom']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable roster file never stops the watcher booting', () => {
  const dir = projectWith('ashtom\n');
  try {
    chmodSync(join(dir, EMPLOYEE_FILE), 0o000);
    // Root ignores the permission bit, so only assert when it actually blocks.
    const blocked = readEmployeeFile(dir).length === 0;
    if (blocked) assert.equal(loadConfig(complete, dir).employeeHandles.length, 6);
    assert.doesNotThrow(() => loadConfig(complete, dir));
  } finally {
    chmodSync(join(dir, EMPLOYEE_FILE), 0o600);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the roster file shipped in this repo is the six Entire handles', () => {
  // Guards the checked-in employees.csv itself, not just the parser.
  assert.deepEqual(
    [...readEmployeeFile(process.cwd())].sort(),
    ['ashtom', 'blackgirlbytes', 'evisdrenova', 'haimantikam', 'jkcso', 'lizziepika'],
  );
});
