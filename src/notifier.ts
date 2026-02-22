// ── Native Notification Backend ─────────────────────────────────────────────
// Dispatches notifications via terminal-notifier → osascript → console.log.
// No external npm dependencies — uses only macOS-native tools.

import { execFileSync } from 'node:child_process';
import { truncate } from './date-parser.js';
import type { Reminder } from './types.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface NotifyOpts {
  title: string;
  subtitle: string;
  message: string;
  sound?: string;
  group?: string;
}

export type NotifierBackend = 'terminal-notifier' | 'osascript' | 'console';

// ── Detection ───────────────────────────────────────────────────────────────

let cachedBackend: NotifierBackend | undefined;

/** Detect the best available notification backend. Result is cached. */
export function detectNotifier(): NotifierBackend {
  if (cachedBackend !== undefined) return cachedBackend;

  try {
    execFileSync('which', ['terminal-notifier'], { stdio: 'pipe' });
    cachedBackend = 'terminal-notifier';
    return cachedBackend;
  } catch {
    // not on PATH
  }

  if (process.platform === 'darwin') {
    cachedBackend = 'osascript';
    return cachedBackend;
  }

  cachedBackend = 'console';
  return cachedBackend;
}

/** Reset the cached backend (for testing). */
export function _resetNotifierCache(): void {
  cachedBackend = undefined;
}

// ── Option builder (pure, fully testable) ───────────────────────────────────

const PRIORITY_ICONS: Record<number, string> = {
  1: '🔴',
  2: '🟡',
  3: '🔵',
  4: '⚪',
  5: '💤',
};

const PRIORITY_SOUNDS: Record<number, string> = {
  1: 'Hero',
  2: 'Ping',
  3: 'Pop',
};

/** Format an overdue duration as a human-readable string. */
export function formatOverdue(diffMs: number): string {
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m overdue`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h overdue`;
  const days = Math.floor(hours / 24);
  return `${days}d overdue`;
}

/** Build notification options from a reminder. Pure function — no side effects. */
export function buildNotifyOpts(rem: Reminder, now: number = Date.now()): NotifyOpts {
  const icon = PRIORITY_ICONS[rem.priority] ?? '🔵';
  const title = `${icon} agentrem`;

  let subtitle = 'due now';
  if (rem.trigger_at) {
    const triggerMs = new Date(rem.trigger_at).getTime();
    const diffMs = now - triggerMs;
    if (diffMs >= 60_000) {
      subtitle = formatOverdue(diffMs);
    }
  }

  const message = truncate(rem.content, 80);
  const sound = PRIORITY_SOUNDS[rem.priority]; // undefined for P4/P5

  return { title, subtitle, message, sound, group: 'com.agentrem.watch' };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/** Send a notification via the best available backend. */
export function sendNotification(opts: NotifyOpts): void {
  const backend = detectNotifier();

  switch (backend) {
    case 'terminal-notifier':
      sendViaTerminalNotifier(opts);
      break;
    case 'osascript':
      sendViaOsascript(opts);
      break;
    case 'console':
      sendViaConsole(opts);
      break;
  }
}

function sendViaTerminalNotifier(opts: NotifyOpts): void {
  const args = ['-title', opts.title, '-subtitle', opts.subtitle, '-message', opts.message];
  if (opts.sound) args.push('-sound', opts.sound);
  if (opts.group) args.push('-group', opts.group);

  try {
    execFileSync('terminal-notifier', args, { stdio: 'pipe' });
  } catch {
    // terminal-notifier failed — fall back to osascript
    sendViaOsascript(opts);
  }
}

function sendViaOsascript(opts: NotifyOpts): void {
  const subtitle = opts.subtitle ? ` subtitle "${escapeAppleScript(opts.subtitle)}"` : '';
  const sound = opts.sound ? ` sound name "${escapeAppleScript(opts.sound)}"` : '';
  const script =
    `display notification "${escapeAppleScript(opts.message)}"` +
    ` with title "${escapeAppleScript(opts.title)}"${subtitle}${sound}`;

  try {
    execFileSync('osascript', ['-e', script], { stdio: 'pipe' });
  } catch {
    // osascript failed — fall back to console
    sendViaConsole(opts);
  }
}

function sendViaConsole(opts: NotifyOpts): void {
  console.log(`🔔 ${opts.title} — ${opts.subtitle}: ${opts.message}`);
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
