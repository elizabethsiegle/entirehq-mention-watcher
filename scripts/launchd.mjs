import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// One agent per machine. The label is fixed rather than per-project because
// launchd keys on it — two projects would silently fight over the same slot,
// so managesProject() below checks which project actually won.
export const LABEL = 'io.entire.entirehq-mention-watcher';

export function plistPath(home = homedir()) {
  return join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildPlist({ nodePath, watchPath, projectDir, dataDir }) {
  const e = xmlEscape;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${e(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${e(nodePath)}</string>
    <string>${e(watchPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${e(projectDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_PROJECT_DIR</key>
    <string>${e(projectDir)}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${e(join(dataDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${e(join(dataDir, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
}

// True only when an agent is installed AND it points at this project. A plist
// naming a different checkout means launchd is watching that one, not this
// one — the session hooks must still run their own watcher here.
export function managesProject(projectDir, home = homedir()) {
  const path = plistPath(home);
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes(`<string>${xmlEscape(projectDir)}</string>`);
  } catch {
    return false;
  }
}
