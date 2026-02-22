// ── notify.ts — Native OS notification module ─────────────────────────────
// Replaces node-notifier with direct terminal-notifier CLI calls + osascript
// fallback. Auto-detects available backend at startup and caches the result.

import { execFile, execFileSync } from 'node:child_process';
import type { Reminder } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type NotifierBackend = 'terminal-notifier' | 'osascript' | 'console';

// ── Constants ──────────────────────────────────────────────────────────────

export const PRIORITY_EMOJIS: Record<number, string> = {
  1: '🔴',
  2: '🟡',
  3: '🔵',
  4: '⚪',
  5: '💤',
};

export const PRIORITY_NAMES: Record<number, string> = {
  1: 'Critical',
  2: 'High',
  3: 'Normal',
  4: 'Low',
  5: 'Someday',
};

/** Priority-based sounds. null = no sound. */
export const PRIORITY_SOUNDS: Record<number, string | null> = {
  1: 'Hero',
  2: 'Pop',
  3: 'Submarine',
  4: null,
  5: null,
};

// ── Backend detection ──────────────────────────────────────────────────────

let _detectedBackend: NotifierBackend | undefined;

/**
 * Detect which notification backend is available.
 * Runs `which` checks and caches the result for subsequent calls.
 *
 * Priority: terminal-notifier → osascript → console
 */
export function detectNotifier(): NotifierBackend {
  if (_detectedBackend !== undefined) return _detectedBackend;

  try {
    execFileSync('which', ['terminal-notifier'], { stdio: 'pipe' });
    _detectedBackend = 'terminal-notifier';
    return _detectedBackend;
  } catch {
    // not installed
  }

  try {
    execFileSync('which', ['osascript'], { stdio: 'pipe' });
    _detectedBackend = 'osascript';
    return _detectedBackend;
  } catch {
    // not available (non-macOS)
  }

  _detectedBackend = 'console';
  return _detectedBackend;
}

/** Reset the cached backend detection (used in tests). */
export function resetDetectedBackend(): void {
  _detectedBackend = undefined;
}

// ── Formatting helpers ─────────────────────────────────────────────────────

/**
 * Build the notification title.
 * Format: `🔴 agentrem — Critical`
 */
export function buildTitle(rem: Reminder): string {
  const emoji = PRIORITY_EMOJIS[rem.priority] ?? '🔵';
  const name = PRIORITY_NAMES[rem.priority] ?? 'Normal';
  return `${emoji} agentrem — ${name}`;
}

/**
 * Build the subtitle showing how overdue the reminder is.
 * Returns "Due now" if not yet overdue, or e.g. "25 minutes overdue".
 */
export function buildSubtitle(rem: Reminder, now: number = Date.now()): string {
  if (!rem.trigger_at) return 'Due now';

  const dueMs = new Date(rem.trigger_at).getTime();
  const overdueMs = now - dueMs;

  if (overdueMs < 60_000) return 'Due now'; // less than 1 minute

  const minutes = Math.floor(overdueMs / 60_000);
  if (minutes < 60) {
    return minutes === 1 ? '1 minute overdue' : `${minutes} minutes overdue`;
  }

  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour overdue' : `${hours} hours overdue`;
}

/**
 * Build the notification message body.
 * Includes content and optionally context.
 */
export function buildMessage(rem: Reminder): string {
  const parts: string[] = [rem.content];
  if (rem.context) parts.push(rem.context);
  return parts.join('\n');
}

// ── Send notification ──────────────────────────────────────────────────────

export interface SendNotificationOptions {
  /** Override the detected backend (useful for testing) */
  backend?: NotifierBackend;
  /** Override 'now' timestamp for overdue calculation */
  now?: number;
}

/**
 * Send a native OS notification for a reminder.
 *
 * Fallback chain: terminal-notifier → osascript → console.log
 * Fires asynchronously (fire-and-forget) — does not block the caller.
 */
export function sendNotification(rem: Reminder, opts: SendNotificationOptions = {}): void {
  const backend = opts.backend ?? detectNotifier();
  const title = buildTitle(rem);
  const subtitle = buildSubtitle(rem, opts.now);
  const message = buildMessage(rem);
  const sound = PRIORITY_SOUNDS[rem.priority] ?? null;
  const group = `com.agentrem.p${rem.priority}`;

  if (backend === 'terminal-notifier') {
    const args: string[] = [
      '-title', title,
      '-subtitle', subtitle,
      '-message', message,
      '-group', group,
      '-activate', 'com.apple.Terminal',
    ];
    if (sound) args.push('-sound', sound);

    execFile('terminal-notifier', args, (err) => {
      if (err) {
        // terminal-notifier failed, fall through to console
        console.log(`[agentrem notify] ${title} | ${subtitle}\n  ${message}`);
      }
    });
    return;
  }

  if (backend === 'osascript') {
    const safeMsg = escapeAppleScript(message);
    const safeTitle = escapeAppleScript(title);
    const safeSubtitle = escapeAppleScript(subtitle);
    const soundClause = sound ? ` sound name "${sound}"` : '';
    const script =
      `display notification "${safeMsg}" with title "${safeTitle}" subtitle "${safeSubtitle}"${soundClause}`;

    execFile('osascript', ['-e', script], (err) => {
      if (err) {
        console.log(`[agentrem notify] ${title} | ${subtitle}\n  ${message}`);
      }
    });
    return;
  }

  // Console fallback
  console.log(`[agentrem notify] ${title} | ${subtitle}\n  ${message}`);
}

// ── Internal helpers ───────────────────────────────────────────────────────

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
