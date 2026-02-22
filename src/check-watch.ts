// ── Check-Watch: blocking wait for the next due reminder ─────────────────────
// Used by `agentrem check --watch`. Polls the DB every 5 s and returns the
// first due reminder — without marking it complete or changing state.

import { getDb } from './db.js';
import { dtToIso, fmtDt } from './date-parser.js';
import type { Reminder } from './types.js';

/** Internal poll interval — not user-configurable. */
export const POLL_INTERVAL_MS = 5_000;

export interface CheckWatchOptions {
  /** Agent filter (default 'main') */
  agent?: string;
  /** Comma-separated trigger type filter (default: 'time') */
  type?: string;
  /** Token budget — accepted for API compat, unused in watch mode */
  budget?: number;
  /** Seconds before giving up. Undefined = wait indefinitely. */
  timeout?: number;
  /** DB path override (for testing) */
  dbPath?: string;
}

export interface CheckWatchResult {
  reminder: Reminder | null;
  /** true when --timeout elapsed with no reminder found */
  timedOut: boolean;
}

/**
 * Query the DB for the first due reminder matching agent + type filters.
 * Opens and closes a fresh DB connection each call.
 * Does NOT modify the reminder in any way.
 *
 * NOTE: trigger_at is stored in 'YYYY-MM-DDTHH:MM:SS' format (T separator)
 * via dtToIso(). We pass `nowIso` as a bound parameter so the comparison
 * uses the same format — SQLite's datetime('now') uses a space, not T.
 */
export function queryDueReminder(
  dbPath: string | undefined,
  agent: string,
  types: string[],
): Reminder | null {
  if (types.length === 0) return null;
  const nowIso = dtToIso(new Date());
  const db = getDb(dbPath);
  try {
    const placeholders = types.map(() => '?').join(', ');
    const row = db
      .prepare(
        `SELECT * FROM reminders
         WHERE status = 'active'
           AND agent = ?
           AND trigger_type IN (${placeholders})
           AND trigger_at IS NOT NULL
           AND trigger_at <= ?
         ORDER BY priority, trigger_at
         LIMIT 1`,
      )
      .get(agent, ...types, nowIso) as Reminder | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

/**
 * Block until a due reminder is found (or timeout / signal).
 *
 * - Polls every POLL_INTERVAL_MS (5 s).
 * - First poll is immediate — returns instantly if a reminder is already due.
 * - Does NOT mark reminders as fired.
 * - Resolves with { reminder, timedOut }.
 */
export async function checkWatch(opts: CheckWatchOptions): Promise<CheckWatchResult> {
  const agent = opts.agent ?? 'main';
  const types = opts.type
    ? opts.type
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : ['time'];
  const timeoutMs = opts.timeout !== undefined ? opts.timeout * 1000 : undefined;

  return new Promise<CheckWatchResult>((resolve) => {
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const cleanup = () => {
      if (pollTimer !== null) clearInterval(pollTimer);
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      pollTimer = null;
      timeoutTimer = null;
    };

    const done = (result: CheckWatchResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      resolve(result);
    };

    const onSignal = () => {
      done({ reminder: null, timedOut: false });
    };

    const poll = () => {
      if (settled) return;
      try {
        const rem = queryDueReminder(opts.dbPath, agent, types);
        if (rem) {
          done({ reminder: rem, timedOut: false });
        }
      } catch {
        // DB gone (e.g. after test cleanup) — stop the loop silently
        done({ reminder: null, timedOut: false });
      }
    };

    // Graceful signal handling
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    // Optional hard timeout
    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        done({ reminder: null, timedOut: true });
      }, timeoutMs);
    }

    // Immediate first poll — returns instantly if already due
    poll();
    if (!settled) {
      pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    }
  });
}

/**
 * Format a watch-mode reminder for human or machine output.
 * Exported so index.ts and tests share the same logic.
 */
export function fmtWatchReminder(rem: Reminder, json: boolean): string {
  if (json) {
    return JSON.stringify(rem);
  }
  const dueStr = rem.trigger_at ? `, due ${fmtDt(rem.trigger_at)}` : '';
  return `🔔 Reminder due: "${rem.content}" (P${rem.priority}${dueStr})`;
}
