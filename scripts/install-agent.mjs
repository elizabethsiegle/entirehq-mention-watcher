import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { getProjectDir, getDataDir } from './config.mjs';
import { LABEL, plistPath, buildPlist } from './launchd.mjs';

// Prefer the version-independent symlink over process.execPath, which points
// into a versioned Cellar directory that vanishes on the next node upgrade
// and would leave launchd running a binary that no longer exists.
function stableNodePath() {
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(getProjectDir());
const dataDir = getDataDir(projectDir);
const target = plistPath();

mkdirSync(dirname(target), { recursive: true });
mkdirSync(dataDir, { recursive: true });

const nodePath = stableNodePath();
writeFileSync(
  target,
  buildPlist({ nodePath, watchPath: join(scriptsDir, 'watch.mjs'), projectDir, dataDir }),
);

const domain = `gui/${process.getuid()}`;

// Tear down any previous instance first — bootstrap fails outright if the
// label is already loaded, and a stale one would keep running old settings.
try {
  execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' });
} catch {
  // Not loaded — nothing to remove.
}

try {
  execFileSync('launchctl', ['bootstrap', domain, target], { stdio: 'pipe' });
} catch (err) {
  console.error(`Failed to bootstrap the launch agent: ${err.stderr?.toString().trim() || err.message}`);
  process.exit(1);
}

console.log(`installed ${LABEL}`);
console.log(`  plist:   ${target}`);
console.log(`  node:    ${nodePath}`);
console.log(`  project: ${projectDir}`);
console.log(`  logs:    ${join(dataDir, 'watch.log')}`);
console.log('');
console.log('The watcher now runs independently of Claude Code: at login, across');
console.log('reboots, and restarted automatically if it dies. Stop it with:');
console.log('  npm run uninstall-agent');
