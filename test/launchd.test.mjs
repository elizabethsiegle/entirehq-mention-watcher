import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LABEL, plistPath, buildPlist, managesProject } from '../scripts/launchd.mjs';

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  return home;
}

const opts = {
  nodePath: '/opt/homebrew/bin/node',
  watchPath: '/proj/scripts/watch.mjs',
  projectDir: '/proj',
  dataDir: '/proj/.claude/entirehq-watcher',
};

test('plistPath lands in the user LaunchAgents directory', () => {
  assert.equal(plistPath('/Users/x'), `/Users/x/Library/LaunchAgents/${LABEL}.plist`);
});

test('buildPlist keeps the watcher alive and starts it at login', () => {
  const xml = buildPlist(opts);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/);
});

test('buildPlist points at the version-independent node symlink', () => {
  assert.ok(buildPlist(opts).includes('<string>/opt/homebrew/bin/node</string>'));
});

test('buildPlist passes CLAUDE_PROJECT_DIR so getProjectDir resolves under launchd', () => {
  assert.match(buildPlist(opts), /<key>CLAUDE_PROJECT_DIR<\/key>\s*<string>\/proj<\/string>/);
});

test('buildPlist escapes XML metacharacters in paths', () => {
  const xml = buildPlist({ ...opts, projectDir: '/proj/a&b<c>' });
  assert.ok(xml.includes('/proj/a&amp;b&lt;c&gt;'));
  assert.ok(!xml.includes('/proj/a&b<c>'));
});

test('managesProject is false when no agent is installed', () => {
  assert.equal(managesProject('/proj', fakeHome()), false);
});

test('managesProject is true for the project the plist names', () => {
  const home = fakeHome();
  writeFileSync(plistPath(home), buildPlist(opts));
  assert.equal(managesProject('/proj', home), true);
});

test('managesProject is false when the plist names a different project', () => {
  const home = fakeHome();
  writeFileSync(plistPath(home), buildPlist(opts));
  // A second checkout must still run its own session-scoped watcher rather
  // than assuming the agent installed for /proj covers it.
  assert.equal(managesProject('/other-proj', home), false);
});

test('managesProject does not match a project that is merely a path prefix', () => {
  const home = fakeHome();
  writeFileSync(plistPath(home), buildPlist(opts));
  assert.equal(managesProject('/pro', home), false);
});
