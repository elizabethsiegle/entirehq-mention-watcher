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

function isLoaded() {
  try {
    execFileSync('launchctl', ['print', `${domain}/${LABEL}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Tear down any previous instance first: bootstrap fails outright if the label
// is already loaded, and a stale one would keep running old settings.
try {
  execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' });
} catch {
  // Not loaded — nothing to remove.
}

// bootout returns before launchd has finished releasing the label. Bootstrapping
// into that window fails with "Bootstrap failed: 5: Input/output error", which
// reads like a permissions problem and is really just a race.
const deadline = Date.now() + 10000;
while (isLoaded() && Date.now() < deadline) {
  execFileSync('sleep', ['0.25']);
}

try {
  execFileSync('launchctl', ['bootstrap', domain, target], { stdio: 'pipe' });
} catch (err) {
  const detail = err.stderr?.toString().trim() || err.message;
  console.error(`Failed to bootstrap the launch agent: ${detail}`);
  if (isLoaded()) console.error(`${LABEL} is still loaded — run: launchctl bootout ${domain}/${LABEL}`);
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
