// ── Programmatic JavaScript API ───────────────────────────────────────────
// Clean async wrappers for use by agents and scripts.
// import { add, check, list, complete, search } from 'agentrem'

import type Database from 'better-sqlite3';
import { initDb, getDb } from './db.js';
import {
  coreAdd,
  coreCheck,
  coreList,
  coreSearch,
  coreComplete,
  coreSnooze,
  coreStats,
  type StatsResult,
} from './core.js';
import type { Reminder } from './types.js';

// ── Re-exports ─────────────────────────────────────────────────────────────

export type { Reminder } from './types.js';
export type { StatsResult } from './core.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CheckResult {
  /** Reminders that fired and fit within the token budget */
  included: Reminder[];
  /** Count of reminders not returned per priority level due to budget */
  overflowCounts: Record<number, number>;
  /** Total number of reminders that triggered (before budget trim) */
  totalTriggered: number;
}

// ── Lazy DB singleton ──────────────────────────────────────────────────────

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (!_db) {
    // Auto-init on first call so `import { add } from 'agentrem'` just works
    initDb(false);
    _db = getDb();
  }
  return _db;
}

/** Reset the internal DB singleton (useful for testing with custom DB paths). */
export function _resetDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

// ── API Functions ──────────────────────────────────────────────────────────

export interface AddOptions {
  due?: string;
  priority?: number;
  tags?: string;
  agent?: string;
  context?: string;
  trigger?: string;
  category?: string;
  keywords?: string;
  recur?: string;
}

/**
 * Add a new reminder.
 * @example
 *   const rem = await add('Review PR', { due: 'tomorrow', priority: 2 });
 */
export async function add(content: string, opts?: AddOptions): Promise<Reminder> {
  const result = coreAdd(db(), {
    content,
    due: opts?.due,
    priority: opts?.priority,
    tags: opts?.tags,
    agent: opts?.agent,
    context: opts?.context,
    trigger: opts?.trigger,
    category: opts?.category,
    keywords: opts?.keywords,
    recur: opts?.recur,
  });
  return result;
}

export interface CheckOptions {
  type?: string;
  budget?: number;
  agent?: string;
  format?: 'text' | 'json';
}

/**
 * Check for triggered reminders. Returns all reminders that are currently
 * due/active within the given token budget.
 * @example
 *   const { included } = await check({ budget: 500 });
 */
export async function check(opts?: CheckOptions): Promise<CheckResult> {
  return coreCheck(db(), {
    type: opts?.type,
    budget: opts?.budget,
    agent: opts?.agent,
  });
}

export interface ListOptions {
  filter?: string;
  agent?: string;
  limit?: number;
  status?: string;
  priority?: string;
  tag?: string;
}

/**
 * List reminders.
 * @example
 *   const reminders = await list({ limit: 10 });
 */
export async function list(opts?: ListOptions): Promise<Reminder[]> {
  return coreList(db(), {
    agent: opts?.agent,
    limit: opts?.limit,
    status: opts?.status,
    priority: opts?.priority,
    tag: opts?.tag ?? opts?.filter,
  });
}

/**
 * Mark a reminder as completed.
 * @example
 *   const done = await complete('abc123');
 */
export async function complete(id: string, notes?: string): Promise<Reminder> {
  const { completed } = coreComplete(db(), id, notes);
  return completed;
}

export interface SnoozeOptions {
  for: string;
}

/**
 * Snooze a reminder for a duration.
 * @example
 *   const snoozed = await snooze('abc123', { for: '2h' });
 */
export async function snooze(id: string, opts: SnoozeOptions): Promise<Reminder> {
  return coreSnooze(db(), id, undefined, opts.for);
}

export interface SearchOptions {
  limit?: number;
  agent?: string;
}

/**
 * Full-text search reminders.
 * @example
 *   const results = await search('PR review');
 */
export async function search(query: string, opts?: SearchOptions): Promise<Reminder[]> {
  return coreSearch(db(), {
    query,
    limit: opts?.limit,
  });
}

/**
 * Get reminder statistics.
 * @example
 *   const s = await stats();
 *   console.log(s.totalActive);
 */
export async function stats(opts?: { agent?: string }): Promise<StatsResult> {
  void opts; // agent filter not currently in coreStats; included for API compat
  return coreStats(db());
}
