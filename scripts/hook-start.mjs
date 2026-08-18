import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectDir, getDataDir } from './config.mjs';

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
  mkdirSync(dataDir, { recursive: true });

  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (pid && isRunning(pid)) process.exit(0);
  }

  // stdio inherits the hook's file descriptors — the same TTY Claude Code is
  // running in — so the detached watcher keeps printing into this terminal
  // after this hook process exits.
  const child = spawn(process.execPath, [join(scriptsDir, 'watch.mjs')], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  writeFileSync(pidFile, String(child.pid));
  child.unref();
} catch (err) {
  console.error(`mention watcher failed to start: ${err.message}`);
  process.exit(1);
}
