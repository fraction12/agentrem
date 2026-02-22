// ── Service / Daemon File Generator ──────────────────────────────────────
// Generates and manages launchd plist (macOS) + systemd unit (Linux)
// so `agentrem watch` can run as a background service.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

export const LAUNCH_AGENT_LABEL = 'com.agentrem.watch';
export const SYSTEMD_UNIT_NAME = 'agentrem-watch.service';

export interface ServiceOptions {
  /** Path to the agentrem binary (default: detected from PATH) */
  binPath?: string;
  /** Poll interval in seconds */
  interval?: number;
  /** Agent name */
  agent?: string;
  /** Whether to be verbose */
  verbose?: boolean;
  /** Log directory override */
  logDir?: string;
}

// ── File generators ────────────────────────────────────────────────────────

/** Returns the path to the macOS LaunchAgent plist. */
export function getLaunchAgentPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

/** Returns the path to the systemd user unit file. */
export function getSystemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

/** Detects the agentrem binary path. */
function detectBin(override?: string): string {
  if (override) return override;
  try {
    return execFileSync('which', ['agentrem'], { encoding: 'utf8' }).trim();
  } catch {
    // Fallback to global node_modules
    return 'agentrem';
  }
}

/**
 * Generate a launchd plist XML for macOS.
 * The plist restarts the watcher on crash and runs it as the current user.
 */
export function generateLaunchdPlist(opts: ServiceOptions = {}): string {
  const bin = detectBin(opts.binPath);
  const interval = opts.interval ?? 30;
  const logDir = opts.logDir ?? path.join(os.homedir(), '.agentrem', 'logs');
  const stdoutLog = path.join(logDir, 'watch.log');
  const stderrLog = path.join(logDir, 'watch.error.log');

  const programArgs = [bin, 'watch', `--interval`, String(interval)];
  if (opts.agent) {
    programArgs.push('--agent', opts.agent);
  }
  if (opts.verbose) {
    programArgs.push('--verbose');
  }

  const programArgsXml = programArgs
    .map((a) => `\t\t<string>${escapeXml(a)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCH_AGENT_LABEL}</string>

\t<key>ProgramArguments</key>
\t<array>
${programArgsXml}
\t</array>

\t<key>RunAtLoad</key>
\t<true/>

\t<key>KeepAlive</key>
\t<true/>

\t<key>StandardOutPath</key>
\t<string>${escapeXml(stdoutLog)}</string>

\t<key>StandardErrorPath</key>
\t<string>${escapeXml(stderrLog)}</string>

\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
\t\t<string>${escapeXml(os.homedir())}</string>
\t</dict>

\t<key>ThrottleInterval</key>
\t<integer>10</integer>
</dict>
</plist>
`;
}

/**
 * Generate a systemd user unit file for Linux.
 */
export function generateSystemdUnit(opts: ServiceOptions = {}): string {
  const bin = detectBin(opts.binPath);
  const interval = opts.interval ?? 30;

  const execArgs = [bin, 'watch', `--interval`, String(interval)];
  if (opts.agent) {
    execArgs.push('--agent', opts.agent);
  }
  if (opts.verbose) {
    execArgs.push('--verbose');
  }

  const execStart = execArgs.join(' ');
  const logDir = opts.logDir ?? path.join(os.homedir(), '.agentrem', 'logs');

  return `[Unit]
Description=agentrem watch daemon — fires notifications for due reminders
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=10
Environment=HOME=${os.homedir()}
StandardOutput=append:${logDir}/watch.log
StandardError=append:${logDir}/watch.error.log

[Install]
WantedBy=default.target
`;
}

// ── Install / uninstall / status ───────────────────────────────────────────

export type Platform = 'darwin' | 'linux' | 'other';

function getPlatform(): Platform {
  const p = os.platform();
  if (p === 'darwin') return 'darwin';
  if (p === 'linux') return 'linux';
  return 'other';
}

export interface ServiceResult {
  success: boolean;
  message: string;
  path?: string;
}

/**
 * Install the watch daemon as an OS background service.
 * macOS: writes a LaunchAgent plist and runs `launchctl load`
 * Linux: writes a systemd user unit and runs `systemctl --user enable --now`
 */
export function installService(opts: ServiceOptions = {}): ServiceResult {
  const platform = getPlatform();

  if (platform === 'darwin') {
    const plistPath = getLaunchAgentPath();
    const logDir = opts.logDir ?? path.join(os.homedir(), '.agentrem', 'logs');

    // Ensure log directory exists
    fs.mkdirSync(logDir, { recursive: true });

    const plist = generateLaunchdPlist(opts);
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist, 'utf8');

    // Unload first if already loaded (ignore errors)
    try {
      execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe' });
    } catch {
      // not loaded yet, that's fine
    }

    try {
      execFileSync('launchctl', ['load', plistPath], { stdio: 'pipe' });
    } catch (e: any) {
      return {
        success: false,
        message: `Wrote plist but launchctl load failed: ${e.message}`,
        path: plistPath,
      };
    }

    return {
      success: true,
      message: `Installed LaunchAgent at ${plistPath} and loaded via launchctl`,
      path: plistPath,
    };
  }

  if (platform === 'linux') {
    const unitPath = getSystemdUnitPath();
    const logDir = opts.logDir ?? path.join(os.homedir(), '.agentrem', 'logs');

    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });

    const unit = generateSystemdUnit(opts);
    fs.writeFileSync(unitPath, unit, 'utf8');

    try {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
      execFileSync('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME], {
        stdio: 'pipe',
      });
    } catch (e: any) {
      return {
        success: false,
        message: `Wrote unit but systemctl failed: ${e.message}`,
        path: unitPath,
      };
    }

    return {
      success: true,
      message: `Installed systemd unit at ${unitPath} and enabled via systemctl`,
      path: unitPath,
    };
  }

  return {
    success: false,
    message: `Unsupported platform: ${os.platform()}. Only macOS and Linux are supported.`,
  };
}

/**
 * Uninstall the watch daemon service.
 */
export function uninstallService(): ServiceResult {
  const platform = getPlatform();

  if (platform === 'darwin') {
    const plistPath = getLaunchAgentPath();

    if (!fs.existsSync(plistPath)) {
      return { success: false, message: `LaunchAgent plist not found at ${plistPath}` };
    }

    try {
      execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe' });
    } catch {
      // ignore if not loaded
    }

    fs.unlinkSync(plistPath);
    return {
      success: true,
      message: `Unloaded and removed LaunchAgent plist at ${plistPath}`,
      path: plistPath,
    };
  }

  if (platform === 'linux') {
    const unitPath = getSystemdUnitPath();

    if (!fs.existsSync(unitPath)) {
      return { success: false, message: `Systemd unit not found at ${unitPath}` };
    }

    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME], {
        stdio: 'pipe',
      });
    } catch {
      // ignore
    }

    fs.unlinkSync(unitPath);
    return {
      success: true,
      message: `Disabled and removed systemd unit at ${unitPath}`,
      path: unitPath,
    };
  }

  return {
    success: false,
    message: `Unsupported platform: ${os.platform()}`,
  };
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  platform: Platform;
  filePath: string;
  detail: string;
}

/**
 * Check the current service status.
 */
export function getServiceStatus(): ServiceStatus {
  const platform = getPlatform();

  if (platform === 'darwin') {
    const plistPath = getLaunchAgentPath();
    const installed = fs.existsSync(plistPath);
    let running = false;
    let detail = installed ? `Plist at ${plistPath}` : `Not installed (expected: ${plistPath})`;

    if (installed) {
      try {
        const out = execFileSync('launchctl', ['list', LAUNCH_AGENT_LABEL], {
          encoding: 'utf8',
          stdio: 'pipe',
        });
        running = !out.includes('"PID" = 0') && out.trim().length > 0;
        detail = `launchctl: ${out.trim().slice(0, 120)}`;
      } catch {
        detail = 'Plist present but not loaded by launchctl';
      }
    }

    return { installed, running, platform, filePath: plistPath, detail };
  }

  if (platform === 'linux') {
    const unitPath = getSystemdUnitPath();
    const installed = fs.existsSync(unitPath);
    let running = false;
    let detail = installed ? `Unit at ${unitPath}` : `Not installed (expected: ${unitPath})`;

    if (installed) {
      try {
        execFileSync('systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME], {
          stdio: 'pipe',
        });
        running = true;
        detail = 'active (running)';
      } catch {
        detail = 'Unit present but not active';
      }
    }

    return { installed, running, platform, filePath: unitPath, detail };
  }

  return {
    installed: false,
    running: false,
    platform,
    filePath: '',
    detail: `Unsupported platform: ${os.platform()}`,
  };
}

// ── XML helpers ────────────────────────────────────────────────────────────

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
