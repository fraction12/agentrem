// ── check-watch.test.ts ───────────────────────────────────────────────────
// Tests for the `agentrem check --watch` blocking-wait implementation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initDb, getDb } from '../src/db.js';
import { coreAdd } from '../src/core.js';
import { dtToIso } from '../src/date-parser.js';
import {
  POLL_INTERVAL_MS,
  queryDueReminder,
  checkWatch,
  fmtWatchReminder,
  type CheckWatchOptions,
} from '../src/check-watch.js';
import type { Reminder } from '../src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'abcdef1234567890',
    content: 'Test reminder',
    context: null,
    trigger_type: 'time',
    trigger_at: dtToIso(new Date(Date.now() - 60_000)), // 1 min ago
    trigger_config: null,
    priority: 2,
    tags: null,
    category: null,
    status: 'active',
    snoozed_until: null,
    decay_at: null,
    escalation: null,
    fire_count: 0,
    last_fired: null,
    max_fires: null,
    recur_rule: null,
    recur_parent_id: null,
    depends_on: null,
    related_ids: null,
    source: 'agent',
    agent: 'main',
    created_at: dtToIso(new Date()),
    updated_at: dtToIso(new Date()),
    completed_at: null,
    notes: null,
    ...overrides,
  };
}

// ── DB fixture ────────────────────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrem-cw-test-'));
  dbPath = path.join(tmpDir, 'reminders.db');
  process.env['AGENTREM_DB'] = dbPath;
  initDb(false, dbPath);
});

afterEach(() => {
  delete process.env['AGENTREM_DB'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── queryDueReminder ──────────────────────────────────────────────────────────

describe('queryDueReminder', () => {
  it('returns null when no reminders exist', () => {
    const rem = queryDueReminder(dbPath, 'main', ['time']);
    expect(rem).toBeNull();
  });

  it('returns null when the only reminder is future-due', () => {
    const db = getDb(dbPath);
    const future = new Date(Date.now() + 60_000);
    coreAdd(db, { content: 'Future task', due: dtToIso(future), priority: 2 });
    db.close();

    const rem = queryDueReminder(dbPath, 'main', ['time']);
    expect(rem).toBeNull();
  });

  it('returns a past-due reminder immediately', () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 10_000);
    coreAdd(db, { content: 'Past due task', due: dtToIso(past), priority: 2 });
    db.close();

    const rem = queryDueReminder(dbPath, 'main', ['time']);
    expect(rem).not.toBeNull();
    expect(rem!.content).toBe('Past due task');
  });

  it('returns null when the reminder belongs to a different agent', () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 10_000);
    coreAdd(db, {
      content: 'Other agent task',
      due: dtToIso(past),
      priority: 2,
      agent: 'other-agent',
    });
    db.close();

    // Query for 'main' — should not find 'other-agent' reminders
    const rem = queryDueReminder(dbPath, 'main', ['time']);
    expect(rem).toBeNull();
  });

  it('respects the agent filter — returns the right agent reminder', () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 10_000);
    coreAdd(db, {
      content: 'My agent task',
      due: dtToIso(past),
      priority: 2,
      agent: 'dash',
    });
    db.close();

    const rem = queryDueReminder(dbPath, 'dash', ['time']);
    expect(rem).not.toBeNull();
    expect(rem!.content).toBe('My agent task');
    expect(rem!.agent).toBe('dash');
  });

  it('returns null when type filter excludes the trigger type', () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 10_000);
    coreAdd(db, { content: 'Time task', due: dtToIso(past), priority: 2 });
    db.close();

    // Only asking for 'heartbeat' type — should not find 'time' reminder
    const rem = queryDueReminder(dbPath, 'main', ['heartbeat']);
    expect(rem).toBeNull();
  });

  it('returns null when types array is empty', () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 10_000);
    coreAdd(db, { content: 'Some task', due: dtToIso(past), priority: 2 });
    db.close();

    const rem = queryDueReminder(dbPath, 'main', []);
    expect(rem).toBeNull();
  });

  it('returns the highest-priority reminder (lowest number) first', () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 10_000);
    coreAdd(db, { content: 'Normal task', due: dtToIso(past), priority: 3 });
    coreAdd(db, { content: 'Critical task', due: dtToIso(past), priority: 1 });
    coreAdd(db, { content: 'High task', due: dtToIso(past), priority: 2 });
    db.close();

    const rem = queryDueReminder(dbPath, 'main', ['time']);
    expect(rem).not.toBeNull();
    expect(rem!.priority).toBe(1);
    expect(rem!.content).toBe('Critical task');
  });

  it('does not return completed reminders', () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 10_000);
    const rem = coreAdd(db, { content: 'Done task', due: dtToIso(past), priority: 2 });
    // Mark as completed
    db.prepare("UPDATE reminders SET status='completed' WHERE id=?").run(rem.id);
    db.close();

    const result = queryDueReminder(dbPath, 'main', ['time']);
    expect(result).toBeNull();
  });
});

// ── checkWatch — immediate resolution ────────────────────────────────────────

describe('checkWatch — immediate resolution', () => {
  it('resolves immediately when a reminder is already due', async () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 5_000);
    coreAdd(db, { content: 'Already due', due: dtToIso(past), priority: 2 });
    db.close();

    const result = await checkWatch({ dbPath });
    expect(result.reminder).not.toBeNull();
    expect(result.reminder!.content).toBe('Already due');
    expect(result.timedOut).toBe(false);
  });

  it('returns the correct reminder object', async () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 5_000);
    coreAdd(db, {
      content: 'Send quarterly report',
      due: dtToIso(past),
      priority: 2,
      tags: 'finance,quarterly',
    });
    db.close();

    const result = await checkWatch({ dbPath });
    expect(result.reminder).not.toBeNull();
    expect(result.reminder!.content).toBe('Send quarterly report');
    expect(result.reminder!.priority).toBe(2);
    expect(result.reminder!.tags).toBe('finance,quarterly');
    expect(result.reminder!.status).toBe('active');
  });

  it('does NOT mark the reminder as fired (read-only)', async () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 5_000);
    const created = coreAdd(db, {
      content: 'Readonly check',
      due: dtToIso(past),
      priority: 3,
    });
    db.close();

    await checkWatch({ dbPath });

    // Verify the reminder is unchanged in DB
    const db2 = getDb(dbPath);
    const afterRem = db2
      .prepare('SELECT * FROM reminders WHERE id=?')
      .get(created.id) as Reminder;
    db2.close();
    expect(afterRem.status).toBe('active');
    expect(afterRem.fire_count).toBe(0);
    expect(afterRem.last_fired).toBeNull();
  });
});

// ── checkWatch — text format output ──────────────────────────────────────────

describe('fmtWatchReminder — text format', () => {
  it('produces the correct human-readable format', () => {
    const rem = makeReminder({
      content: 'Send quarterly report',
      priority: 2,
      trigger_at: dtToIso(new Date(Date.now() - 5 * 60_000)), // 5 min ago
    });
    const output = fmtWatchReminder(rem, false);
    expect(output).toContain('🔔 Reminder due:');
    expect(output).toContain('"Send quarterly report"');
    expect(output).toContain('P2');
    expect(output).toContain('ago');
  });

  it('includes due-time string when trigger_at is set', () => {
    const rem = makeReminder({
      content: 'Task with due time',
      priority: 3,
      trigger_at: dtToIso(new Date(Date.now() - 3600_000)), // 1h ago
    });
    const output = fmtWatchReminder(rem, false);
    expect(output).toContain('due');
    expect(output).toContain('1h ago');
  });

  it('omits due-time suffix when trigger_at is null', () => {
    const rem = makeReminder({ trigger_at: null });
    const output = fmtWatchReminder(rem, false);
    // The static "Reminder due:" is always present; ', due <time>' should NOT be appended
    expect(output).not.toContain(', due ');
    expect(output).toContain(`(P${rem.priority})`);
    // Ends with close-paren, no extra date info
    expect(output.endsWith(`(P${rem.priority})`)).toBe(true);
  });
});

// ── checkWatch — JSON format output ──────────────────────────────────────────

describe('fmtWatchReminder — JSON format', () => {
  it('produces valid JSON output', () => {
    const rem = makeReminder({ content: 'Send quarterly report', priority: 2 });
    const output = fmtWatchReminder(rem, true);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('JSON includes id, content, priority, and trigger_at', () => {
    const rem = makeReminder({
      content: 'Send quarterly report',
      priority: 2,
      trigger_at: '2026-02-22T15:00:00',
    });
    const output = fmtWatchReminder(rem, true);
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe(rem.id);
    expect(parsed.content).toBe('Send quarterly report');
    expect(parsed.priority).toBe(2);
    expect(parsed.trigger_at).toBe('2026-02-22T15:00:00');
  });

  it('JSON output is single-line (compact)', () => {
    const rem = makeReminder();
    const output = fmtWatchReminder(rem, true);
    expect(output).not.toContain('\n');
  });
});

// ── checkWatch — timeout ──────────────────────────────────────────────────────

describe('checkWatch — timeout', () => {
  it('resolves with timedOut=true when timeout elapses and no reminder fires', async () => {
    vi.useFakeTimers();

    const opts: CheckWatchOptions = { dbPath, timeout: 10 }; // 10-second timeout
    const watchPromise = checkWatch(opts);

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(10_001);

    const result = await watchPromise;
    expect(result.timedOut).toBe(true);
    expect(result.reminder).toBeNull();
  });

  it('resolves with the reminder (not timedOut) when found before timeout', async () => {
    vi.useFakeTimers();

    // Add a reminder but set its due date AFTER current fake time
    // We'll add it with a past time so it's immediately due
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 1_000); // 1s ago (fake clock)
    coreAdd(db, { content: 'Before timeout', due: dtToIso(past), priority: 1 });
    db.close();

    const opts: CheckWatchOptions = { dbPath, timeout: 60 }; // 60s timeout

    // Don't advance time — first immediate poll should find it
    const result = await checkWatch(opts);
    expect(result.timedOut).toBe(false);
    expect(result.reminder).not.toBeNull();
    expect(result.reminder!.content).toBe('Before timeout');
  });

  it('fires the poll interval before timeout fires', async () => {
    vi.useFakeTimers();

    const opts: CheckWatchOptions = { dbPath, timeout: 30 }; // 30s timeout
    const watchPromise = checkWatch(opts);

    // First poll ran immediately (no reminders). Advance past one interval (5s).
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);

    // Still no reminder — not yet timed out
    // Now add a reminder so the next poll finds it
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 1_000);
    coreAdd(db, { content: 'Added after delay', due: dtToIso(past), priority: 2 });
    db.close();

    // Advance another interval — poll should pick it up
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 100);

    const result = await watchPromise;
    expect(result.timedOut).toBe(false);
    expect(result.reminder).not.toBeNull();
    expect(result.reminder!.content).toBe('Added after delay');
  });

  it('exits with code 1 semantics: timedOut=true, reminder=null', async () => {
    vi.useFakeTimers();

    const watchPromise = checkWatch({ dbPath, timeout: 5 });
    await vi.advanceTimersByTimeAsync(5_001);

    const result = await watchPromise;
    // This maps to process.exit(1) in index.ts
    expect(result.timedOut).toBe(true);
    expect(result.reminder).toBeNull();
  });
});

// ── checkWatch — agent filter ─────────────────────────────────────────────────

describe('checkWatch — agent filter', () => {
  it('only returns reminders for the specified agent', async () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 5_000);
    coreAdd(db, {
      content: 'Main agent reminder',
      due: dtToIso(past),
      priority: 2,
      agent: 'main',
    });
    db.close();

    // Watching for 'dash' agent — should not see 'main' reminders
    const opts: CheckWatchOptions = { dbPath, agent: 'dash', timeout: 0 };

    // timeout=0 means it times out immediately (0ms)
    vi.useFakeTimers();
    const watchPromise = checkWatch(opts);
    await vi.advanceTimersByTimeAsync(1);
    const result = await watchPromise;

    // Timed out — no reminder for 'dash' agent
    expect(result.timedOut).toBe(true);
    expect(result.reminder).toBeNull();
  });

  it('returns reminder when agent matches', async () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 5_000);
    coreAdd(db, {
      content: 'Dash reminder',
      due: dtToIso(past),
      priority: 2,
      agent: 'dash',
    });
    db.close();

    const result = await checkWatch({ dbPath, agent: 'dash' });
    expect(result.reminder).not.toBeNull();
    expect(result.reminder!.content).toBe('Dash reminder');
    expect(result.reminder!.agent).toBe('dash');
  });

  it('defaults to agent=main when no agent specified', async () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 5_000);
    coreAdd(db, {
      content: 'Main default reminder',
      due: dtToIso(past),
      priority: 2,
      // agent defaults to 'main' in coreAdd
    });
    db.close();

    const result = await checkWatch({ dbPath }); // no agent specified
    expect(result.reminder).not.toBeNull();
    expect(result.reminder!.content).toBe('Main default reminder');
  });
});

// ── checkWatch — SIGINT graceful handling ─────────────────────────────────────

describe('checkWatch — SIGINT graceful handling', () => {
  it('resolves with null reminder and timedOut=false on SIGINT', async () => {
    vi.useFakeTimers();

    // No reminders — would wait forever without SIGINT
    const opts: CheckWatchOptions = { dbPath }; // no timeout
    const watchPromise = checkWatch(opts);

    // Emit SIGINT to trigger graceful shutdown
    process.emit('SIGINT');

    // Let microtasks settle (no real time needed)
    await vi.advanceTimersByTimeAsync(0);

    const result = await watchPromise;
    expect(result.reminder).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it('resolves cleanly on SIGTERM', async () => {
    vi.useFakeTimers();

    const opts: CheckWatchOptions = { dbPath };
    const watchPromise = checkWatch(opts);

    process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);

    const result = await watchPromise;
    expect(result.reminder).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it('does not reject or throw on SIGINT — just resolves', async () => {
    vi.useFakeTimers();

    const opts: CheckWatchOptions = { dbPath };
    const watchPromise = checkWatch(opts);
    process.emit('SIGINT');
    await vi.advanceTimersByTimeAsync(0);

    // Should not throw
    await expect(watchPromise).resolves.toEqual({ reminder: null, timedOut: false });
  });
});

// ── checkWatch — type filter ──────────────────────────────────────────────────

describe('checkWatch — type filter', () => {
  it('defaults to watching time-type reminders only', async () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 5_000);
    coreAdd(db, { content: 'Time reminder', due: dtToIso(past), priority: 2 });
    db.close();

    const result = await checkWatch({ dbPath }); // default: type='time'
    expect(result.reminder).not.toBeNull();
    expect(result.reminder!.trigger_type).toBe('time');
  });

  it('respects explicit --type filter matching trigger_type', async () => {
    const db = getDb(dbPath);
    const past = new Date(Date.now() - 5_000);
    coreAdd(db, { content: 'Time reminder', due: dtToIso(past), priority: 2 });
    db.close();

    const result = await checkWatch({ dbPath, type: 'time' });
    expect(result.reminder).not.toBeNull();
  });
});

// ── POLL_INTERVAL_MS constant ─────────────────────────────────────────────────

describe('POLL_INTERVAL_MS', () => {
  it('is exactly 5 seconds', () => {
    expect(POLL_INTERVAL_MS).toBe(5_000);
  });
});
