import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { LABEL, plistPath } from './launchd.mjs';

const target = plistPath();
const domain = `gui/${process.getuid()}`;

try {
  execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' });
  console.log(`stopped ${LABEL}`);
} catch {
  console.log(`${LABEL} was not loaded`);
}

if (existsSync(target)) {
  rmSync(target);
  console.log(`removed ${target}`);
} else {
  console.log('no plist to remove');
}

console.log('');
console.log('The Claude Code session hooks take over again — the watcher will run');
console.log('only while a session is open in this project.');
