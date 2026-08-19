import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectDir, getDataDir } from './config.mjs';
import { managesProject } from './launchd.mjs';

// Nothing in this file may exit 2 — that return code blocks Claude Code from
// starting the session. A broken watcher must never cost the user their shell.
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectDir = getProjectDir();
const dataDir = getDataDir(projectDir);
const pidFile = join(dataDir, 'watch.pid');

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

try {
  // A launchd agent for this project keeps its own always-on watcher alive.
  // Spawning a second one here would double every Slack notification.
  if (managesProject(projectDir)) process.exit(0);

  mkdirSync(dataDir, { recursive: true });

  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (pid && isRunning(pid)) process.exit(0);
  }

  // The watcher notifies through Slack only and writes its diagnostics to
  // .claude/entirehq-watcher/watch.log, so it has nothing to say to the
  // terminal. Detaching from Claude Code's fds entirely also means closing
  // the terminal can't hand the process a broken pipe.
  const child = spawn(process.execPath, [join(scriptsDir, 'watch.mjs')], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    detached: true,
    stdio: 'ignore',
  });

  writeFileSync(pidFile, String(child.pid));
  child.unref();
} catch (err) {
  console.error(`mention watcher failed to start: ${err.message}`);
  process.exit(1);
}
