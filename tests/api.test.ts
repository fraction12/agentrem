import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initDb } from '../src/db.js';
import {
  add,
  check,
  list,
  complete,
  snooze,
  search,
  stats,
  _resetDb,
} from '../src/api.js';

let tmpDir: string;
let dbPath: string;
let origDir: string | undefined;
let origDb: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrem-api-test-'));
  dbPath = path.join(tmpDir, 'reminders.db');
  origDir = process.env['AGENTREM_DIR'];
  origDb = process.env['AGENTREM_DB'];
  process.env['AGENTREM_DIR'] = tmpDir;
  process.env['AGENTREM_DB'] = dbPath;
  // Pre-init so getDb doesn't fail; api.ts also calls initDb but this is safe
  initDb(false, dbPath);
  _resetDb();
});

afterEach(() => {
  _resetDb();
  if (origDir !== undefined) process.env['AGENTREM_DIR'] = origDir;
  else delete process.env['AGENTREM_DIR'];
  if (origDb !== undefined) process.env['AGENTREM_DB'] = origDb;
  else delete process.env['AGENTREM_DB'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('api.add', () => {
  it('adds a reminder and returns a Reminder object', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dueStr = tomorrow.toISOString().slice(0, 10); // YYYY-MM-DD

    const rem = await add('Test reminder', { due: dueStr, priority: 2 });

    expect(rem).toBeDefined();
    expect(rem.id).toBeTruthy();
    expect(rem.content).toBe('Test reminder');
    expect(rem.priority).toBe(2);
    expect(rem.status).toBe('active');
    expect(rem.trigger_type).toBe('time');
  });

  it('adds a reminder with tags and context', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dueStr = tomorrow.toISOString().slice(0, 10);

    const rem = await add('Tagged reminder', {
      due: dueStr,
      tags: 'work,urgent',
      context: 'Some context here',
      agent: 'test-agent',
    });

    expect(rem.tags).toBe('work,urgent');
    expect(rem.context).toBe('Some context here');
    expect(rem.agent).toBe('test-agent');
  });

  it('adds a session trigger reminder (no due required)', async () => {
    const rem = await add('Session reminder', { trigger: 'session' });
    expect(rem.trigger_type).toBe('session');
    expect(rem.status).toBe('active');
  });

  it('throws if time trigger and no due', async () => {
    await expect(add('No due')).rejects.toThrow();
  });
});

describe('api.list', () => {
  it('returns an empty array when no reminders', async () => {
    const items = await list();
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(0);
  });

  it('returns added reminders', async () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const due = d.toISOString().slice(0, 10);

    await add('Reminder A', { due });
    await add('Reminder B', { due });

    const items = await list();
    expect(items.length).toBe(2);
    expect(items.map((r) => r.content)).toContain('Reminder A');
    expect(items.map((r) => r.content)).toContain('Reminder B');
  });

  it('respects limit option', async () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const due = d.toISOString().slice(0, 10);

    await add('R1', { due });
    await add('R2', { due });
    await add('R3', { due });

    const items = await list({ limit: 2 });
    expect(items.length).toBe(2);
  });

  it('filters by tag', async () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const due = d.toISOString().slice(0, 10);

    await add('Tagged', { due, tags: 'work' });
    await add('Untagged', { due });

    const items = await list({ filter: 'work' });
    expect(items.length).toBe(1);
    expect(items[0].content).toBe('Tagged');
  });
});

describe('api.complete', () => {
  it('marks a reminder as completed', async () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const due = d.toISOString().slice(0, 10);

    const rem = await add('Complete me', { due });
    const done = await complete(rem.id);

    expect(done.status).toBe('completed');
    expect(done.completed_at).toBeTruthy();
  });

  it('throws if reminder not found', async () => {
    await expect(complete('nonexistent-id')).rejects.toThrow();
  });
});

describe('api.snooze', () => {
  it('snoozes a reminder', async () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const due = d.toISOString().slice(0, 10);

    const rem = await add('Snooze me', { due });
    const snoozed = await snooze(rem.id, { for: '2h' });

    expect(snoozed.status).toBe('snoozed');
    expect(snoozed.snoozed_until).toBeTruthy();
  });

  it('throws if reminder not found', async () => {
    await expect(snooze('bad-id', { for: '1h' })).rejects.toThrow();
  });
});

describe('api.search', () => {
  it('returns empty array when no matches', async () => {
    const results = await search('nonexistent query xyz');
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  it('finds reminders by content', async () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const due = d.toISOString().slice(0, 10);

    await add('Fix the widget bug', { due });
    await add('Deploy to production', { due });

    const results = await search('widget');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('widget');
  });

  it('respects limit option', async () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const due = d.toISOString().slice(0, 10);

    await add('Alpha task', { due });
    await add('Alpha thing', { due });
    await add('Alpha item', { due });

    const results = await search('Alpha', { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe('api.check', () => {
  it('returns CheckResult with included/overflowCounts/totalTriggered', async () => {
    const result = await check();
    expect(result).toBeDefined();
    expect(Array.isArray(result.included)).toBe(true);
    expect(typeof result.totalTriggered).toBe('number');
    expect(typeof result.overflowCounts).toBe('object');
  });

  it('includes overdue reminders', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const due = yesterday.toISOString().slice(0, 10);

    await add('Overdue task', { due });

    const result = await check();
    expect(result.included.length).toBeGreaterThan(0);
    expect(result.included[0].content).toBe('Overdue task');
  });
});

describe('api.stats', () => {
  it('returns a StatsResult object', async () => {
    const s = await stats();
    expect(s).toBeDefined();
    expect(typeof s.totalActive).toBe('number');
    expect(Array.isArray(s.byPriority)).toBe(true);
    expect(typeof s.overdue).toBe('number');
    expect(typeof s.snoozed).toBe('number');
  });

  it('reflects added reminders', async () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const due = d.toISOString().slice(0, 10);

    await add('Task 1', { due, priority: 1 });
    await add('Task 2', { due, priority: 3 });

    const s = await stats();
    expect(s.totalActive).toBe(2);
  });
});

describe('import { add } from agentrem', () => {
  it('add is a function exported from the api module', () => {
    // Verify the named export is accessible as a function
    expect(typeof add).toBe('function');
  });

  it('check, list, complete, snooze, search, stats are all exported', () => {
    expect(typeof check).toBe('function');
    expect(typeof list).toBe('function');
    expect(typeof complete).toBe('function');
    expect(typeof snooze).toBe('function');
    expect(typeof search).toBe('function');
    expect(typeof stats).toBe('function');
  });
});
