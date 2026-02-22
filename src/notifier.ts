// ── Native Notification Backend ─────────────────────────────────────────────
// Dispatches notifications via terminal-notifier → osascript → console.log.
// No external npm dependencies — uses only macOS-native tools.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const PRIORITY_TITLES: Record<number, string> = {
  1: '⚡ Yo. This one\'s urgent.',
  2: '👋 Hey, heads up.',
  3: '📌 Quick reminder',
  4: '💭 When you get a sec...',
  5: '🌊 No rush, but...',
};

const PRIORITY_SOUNDS: Record<number, string> = {
  1: 'Hero',
  2: 'Ping',
  3: 'Pop',
};

/** Format an overdue duration as a fun, cheeky human-readable string. */
export function formatOverdue(diffMs: number): string {
  const mins = diffMs / 60_000;
  const hours = diffMs / 3_600_000;
  const days = diffMs / 86_400_000;

  if (mins < 2) return 'just now';
  if (mins < 30) return `${Math.floor(mins)} min ago`;
  if (hours < 1) return 'about an hour, no biggie';
  if (hours < 3) return 'been a couple hours...';
  if (hours < 6) return 'this has been waiting a while';
  if (hours < 24) return 'so... you forgot about this one 😅';
  if (hours < 48) return "it's been a whole day, dude";
  return `I've been here for ${Math.floor(days)} days. just saying.`;
}

/** Build notification options from a reminder. Pure function — no side effects. */
export function buildNotifyOpts(rem: Reminder, now: number = Date.now()): NotifyOpts {
  const title = PRIORITY_TITLES[rem.priority] ?? '📌 Quick reminder';

  let subtitle = 'due now ⏰';
  if (rem.trigger_at) {
    const triggerMs = new Date(rem.trigger_at).getTime();
    const diffMs = now - triggerMs;
    if (diffMs > 0) {
      subtitle = formatOverdue(diffMs);
    }
  }

  const message = truncate(rem.content, 80);
  const sound = PRIORITY_SOUNDS[rem.priority]; // undefined for P4/P5

  return { title, subtitle, message, sound, group: 'com.agentrem.watch' };
}

// ── App icon path ────────────────────────────────────────────────────────────

/** Resolve the bundled app icon path. Returns undefined if the file doesn't exist. */
function resolveAppIcon(): string | undefined {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const iconPath = resolve(__dirname, '../assets/icon.png');
    return existsSync(iconPath) ? iconPath : undefined;
  } catch {
    return undefined;
  }
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

  const iconPath = resolveAppIcon();
  if (iconPath) args.push('-appIcon', iconPath);

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
