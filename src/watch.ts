// ── Watch / Notification Loop ─────────────────────────────────────────────
// Polls coreCheck() on an interval and fires native OS notifications for
// due reminders, with per-reminder dedup (5-minute cooldown).

import { execSync } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getDb } from './db.js';
import { coreCheck, coreGc } from './core.js';
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
  /** Built-in on-fire preset name (e.g. 'openclaw'). Mutually exclusive with onFire. */
  onFirePreset?: string;
  /** Timeout for on-fire command in milliseconds (default 5000) */
  onFireTimeout?: number;
  /** How often to run garbage collection in ms (default 24h) */
  gcIntervalMs?: number;
  /** Dedup cooldown in seconds (default 300 = 5 minutes) */
  cooldown?: number;
}

export interface WatchState {
  /** Map of reminder ID → timestamp of last notification */
  lastNotified: Map<string, number>;
  /** Timestamp of last garbage collection run (0 = never, triggers on first tick) */
  lastGc?: number;
}

/** Returns true if the reminder should be notified (not in cooldown). */
export function shouldNotify(state: WatchState, reminderId: string, now: number = Date.now(), cooldownMs: number = DEDUP_COOLDOWN_MS): boolean {
  const last = state.lastNotified.get(reminderId);
  if (last === undefined) return true;
  return now - last >= cooldownMs;
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

/**
 * Resolve a built-in on-fire preset name to its shell command string.
 * Throws if the preset is unknown.
 */
export function resolveOnFirePreset(preset: string): string {
  if (preset === 'openclaw') {
    return (
      'openclaw cron add --name "agentrem-fire"' +
      ' --at "$(date -u -v+10S +%Y-%m-%dT%H:%M:%SZ)"' +
      ' --message "🔔 Reminder: $AGENTREM_CONTENT (P$AGENTREM_PRIORITY)"' +
      ' --delete-after-run --announce --best-effort-deliver'
    );
  }
  throw new Error(`Unknown --on-fire-preset: "${preset}". Supported presets: openclaw`);
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

const DEFAULT_GC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Run a single check cycle: poll DB, notify due reminders, return notified list. */
export function runCheckCycle(
  state: WatchState,
  opts: WatchOptions,
  now: number = Date.now(),
): Reminder[] {
  // Resolve preset to concrete command (do this once per cycle, outside the loop)
  const resolvedOnFire: string | undefined =
    opts.onFirePreset !== undefined ? resolveOnFirePreset(opts.onFirePreset) : opts.onFire;

  const db = getDb(opts.dbPath);
  let notified: Reminder[] = [];
  try {
    // ── Periodic GC ────────────────────────────────────────────────────────
    const gcIntervalMs = opts.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS;
    const lastGc = state.lastGc ?? 0;
    if (now - lastGc >= gcIntervalMs) {
      try {
        const gcResult = coreGc(db, 30);
        state.lastGc = now;
        if (opts.verbose) {
          console.log(
            `[agentrem watch] 🗑️  gc ran — ${gcResult.count} reminder(s) cleaned`,
          );
        }
      } catch (gcErr) {
        if (opts.verbose) {
          const msg = gcErr instanceof Error ? gcErr.message : String(gcErr);
          console.log(`[agentrem watch] ⚠️  gc error (non-fatal): ${msg}`);
        }
      }
    }

    const result = coreCheck(db, {
      type: 'time,heartbeat,session,condition',
      agent: opts.agent || 'main',
      escalate: true,
    });

    const cooldownMs = opts.cooldown !== undefined ? opts.cooldown * 1000 : DEDUP_COOLDOWN_MS;
    const notify = opts.onNotify ?? fireNotification;
    for (const rem of result.included) {
      if (shouldNotify(state, rem.id, now, cooldownMs)) {
        notify(rem);
        // Execute on-fire hook sequentially after notification
        if (resolvedOnFire) {
          const ok = executeOnFire(resolvedOnFire, rem, opts.onFireTimeout ?? 5000);
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
  const state: WatchState = { lastNotified: new Map(), lastGc: 0 };

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
