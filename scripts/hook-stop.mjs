import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectDir, getDataDir } from './config.mjs';

const pidFile = join(getDataDir(getProjectDir()), 'watch.pid');

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
