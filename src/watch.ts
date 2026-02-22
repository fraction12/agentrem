// ── Watch / Notification Loop ─────────────────────────────────────────────
// Polls coreCheck() on an interval and fires native OS notifications for
// due reminders, with per-reminder dedup (5-minute cooldown).

import { execSync } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getDb } from './db.js';
import { coreCheck } from './core.js';
import { truncate } from './date-parser.js';
import { buildNotifyOpts, sendNotification } from './notifier.js';
import type { Reminder } from './types.js';

export const DEDUP_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export interface WatchOptions {
  /** Poll interval in seconds (default 30) */
  interval?: number;
  /** Agent name to check for (default 'main') */
  agent?: string;
  /** Run check once and exit (no loop) */
  once?: boolean;
  /** Verbose logging */
  verbose?: boolean;
  /** Optional db path (for testing) */
  dbPath?: string;
  /**
   * Override the notification function (defaults to fireNotification).
   * Useful for testing — pass a no-op or spy to avoid spawning OS notifiers.
   */
  onNotify?: (rem: Reminder) => void;
  /** Shell command to execute when a reminder fires. Reminder data passed via env vars. */
  onFire?: string;
  /** Timeout for on-fire command in milliseconds (default 5000) */
  onFireTimeout?: number;
}

export interface WatchState {
  /** Map of reminder ID → timestamp of last notification */
  lastNotified: Map<string, number>;
}

/** Returns true if the reminder should be notified (not in cooldown). */
export function shouldNotify(state: WatchState, reminderId: string, now: number = Date.now()): boolean {
  const last = state.lastNotified.get(reminderId);
  if (last === undefined) return true;
  return now - last >= DEDUP_COOLDOWN_MS;
}

/** Mark a reminder as notified (records current timestamp). */
export function markNotified(state: WatchState, reminderId: string, now: number = Date.now()): void {
  state.lastNotified.set(reminderId, now);
}

/** Send a native OS notification for a single reminder. */
export function fireNotification(rem: Reminder): void {
  const opts = buildNotifyOpts(rem);
  sendNotification(opts);
}

const ON_FIRE_LOG_DIR = join(homedir(), '.agentrem', 'logs');
const ON_FIRE_LOG_FILE = join(ON_FIRE_LOG_DIR, 'on-fire.log');

/** Execute the on-fire command for a fired reminder. Fire-and-forget: never throws. */
export function executeOnFire(command: string, rem: Reminder, timeoutMs: number = 5000): boolean {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    AGENTREM_ID: rem.id,
    AGENTREM_CONTENT: rem.content,
    AGENTREM_PRIORITY: String(rem.priority ?? 3),
    AGENTREM_TAGS: rem.tags ?? '',
    AGENTREM_CONTEXT: rem.context ?? '',
    AGENTREM_DUE: rem.trigger_at ?? '',
    AGENTREM_FIRE_COUNT: String(rem.fire_count ?? 1),
  };

  try {
    execSync(command, {
      env,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch (err: unknown) {
    try {
      mkdirSync(ON_FIRE_LOG_DIR, { recursive: true });
      const msg = err instanceof Error ? err.message : String(err);
      const line = `${new Date().toISOString()} | ${rem.id.slice(0, 8)} | ${msg}\n`;
      appendFileSync(ON_FIRE_LOG_FILE, line);
    } catch {
      // If even logging fails, silently continue
    }
    return false;
  }
}

/** Run a single check cycle: poll DB, notify due reminders, return notified list. */
export function runCheckCycle(
  state: WatchState,
  opts: WatchOptions,
  now: number = Date.now(),
): Reminder[] {
  const db = getDb(opts.dbPath);
  let notified: Reminder[] = [];
  try {
    const result = coreCheck(db, {
      type: 'time,heartbeat,session,condition',
      agent: opts.agent || 'main',
      escalate: true,
    });

    const notify = opts.onNotify ?? fireNotification;
    for (const rem of result.included) {
      if (shouldNotify(state, rem.id, now)) {
        notify(rem);
        // Execute on-fire hook sequentially after notification
        if (opts.onFire) {
          const ok = executeOnFire(opts.onFire, rem, opts.onFireTimeout ?? 5000);
          if (opts.verbose) {
            console.log(`[agentrem watch] 🔥 [${rem.id.slice(0, 8)}] on-fire ${ok ? 'ok' : 'failed'}`);
          }
        }
        markNotified(state, rem.id, now);
        notified.push(rem);
        if (opts.verbose) {
          console.log(`[agentrem watch] 🔔 [${rem.id.slice(0, 8)}] ${truncate(rem.content, 60)}`);
        }
      } else if (opts.verbose) {
        console.log(`[agentrem watch] ⏭️  [${rem.id.slice(0, 8)}] in cooldown, skipping`);
      }
    }

    if (opts.verbose) {
      console.log(
        `[agentrem watch] checked at ${new Date(now).toISOString()} — ` +
          `${result.totalTriggered} triggered, ${notified.length} notified`,
      );
    }
  } finally {
    db.close();
  }

  return notified;
}

/** Start the watch loop. Resolves when the loop stops (only if `once` or `signal` fires). */
export async function startWatch(opts: WatchOptions, signal?: AbortSignal): Promise<void> {
  const intervalMs = (opts.interval ?? 30) * 1000;
  const state: WatchState = { lastNotified: new Map() };

  if (opts.verbose) {
    console.log(
      `[agentrem watch] started — interval=${opts.interval ?? 30}s agent=${opts.agent ?? 'main'}`,
    );
  }

  // Run immediately on start
  runCheckCycle(state, opts);

  if (opts.once) return;

  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setInterval>;

    const stop = () => {
      clearInterval(timer);
      resolve();
    };

    timer = setInterval(() => {
      if (signal?.aborted) {
        stop();
        return;
      }
      runCheckCycle(state, opts);
    }, intervalMs);

    if (signal) {
      signal.addEventListener('abort', stop, { once: true });
    }

    // SIGINT / SIGTERM for clean shutdown when running as a daemon
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  if (opts.verbose) console.log('[agentrem watch] stopped.');
}
