import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectDir, getDataDir } from './config.mjs';
import { managesProject } from './launchd.mjs';

const projectDir = getProjectDir();
const pidFile = join(getDataDir(projectDir), 'watch.pid');

// When launchd owns the watcher it must outlive the session — and killing it
// would only make launchd restart it, churning a browser session each time.
if (managesProject(projectDir)) process.exit(0);

if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone — nothing to do.
    }
  }
  unlinkSync(pidFile);
}
