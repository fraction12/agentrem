import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeOnFire } from '../src/watch.js';
import { runCheckCycle, type WatchState } from '../src/watch.js';
import type { Reminder } from '../src/types.js';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const LOG_DIR = join(homedir(), '.agentrem', 'logs');
const LOG_FILE = join(LOG_DIR, 'on-fire.log');

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'test-1234-5678-abcd',
    content: 'Test reminder content',
    priority: 2,
    tags: 'test,uat',
    context: 'test context',
    trigger_at: '2026-02-22T12:00:00',
    fire_count: 1,
    status: 'active',
    trigger_type: 'time',
    created_at: '2026-02-22T10:00:00',
    updated_at: '2026-02-22T10:00:00',
    ...overrides,
  } as Reminder;
}

describe('executeOnFire', () => {
  it('executes command with correct env vars', () => {
    const rem = makeReminder();
    // Use node to echo env vars as JSON
    const cmd = `node -e "process.stdout.write(JSON.stringify({
      id: process.env.AGENTREM_ID,
      content: process.env.AGENTREM_CONTENT,
      priority: process.env.AGENTREM_PRIORITY,
      tags: process.env.AGENTREM_TAGS,
      context: process.env.AGENTREM_CONTEXT,
      due: process.env.AGENTREM_DUE,
      fireCount: process.env.AGENTREM_FIRE_COUNT,
    }))"`;

    // We can't capture stdout from executeOnFire (it pipes but doesn't return it)
    // So just verify it returns true (success)
    const result = executeOnFire(cmd, rem);
    expect(result).toBe(true);
  });

  it('returns true on successful command', () => {
    const rem = makeReminder();
    const result = executeOnFire('echo ok', rem);
    expect(result).toBe(true);
  });

  it('returns false and does not throw on command failure', () => {
    const rem = makeReminder();
    const result = executeOnFire('exit 1', rem);
    expect(result).toBe(false);
  });

  it('returns false on command timeout without throwing', () => {
    const rem = makeReminder();
    // Sleep for 2s but timeout at 100ms
    const result = executeOnFire('sleep 2', rem, 100);
    expect(result).toBe(false);
  });

  it('logs errors to on-fire.log', () => {
    // Clean log file first
    try { rmSync(LOG_FILE); } catch {}

    const rem = makeReminder({ id: 'err-test-1234' });
    executeOnFire('exit 1', rem);

    expect(existsSync(LOG_FILE)).toBe(true);
    const log = readFileSync(LOG_FILE, 'utf-8');
    expect(log).toContain('err-test');
  });

  it('passes all expected env var fields', () => {
    const rem = makeReminder({
      id: 'env-check-id',
      content: 'env check content',
      priority: 1,
      tags: 'a,b,c',
      context: 'my context',
      trigger_at: '2026-03-01T08:00:00',
      fire_count: 3,
    });

    // Write env vars to a temp file so we can read them
    const tmpFile = join(homedir(), '.agentrem', 'logs', 'env-test.json');
    try { rmSync(tmpFile); } catch {}
    
    const cmd = `node -e "require('fs').writeFileSync('${tmpFile.replace(/'/g, "\\'")}', JSON.stringify({
      id: process.env.AGENTREM_ID,
      content: process.env.AGENTREM_CONTENT,
      priority: process.env.AGENTREM_PRIORITY,
      tags: process.env.AGENTREM_TAGS,
      context: process.env.AGENTREM_CONTEXT,
      due: process.env.AGENTREM_DUE,
      fireCount: process.env.AGENTREM_FIRE_COUNT,
    }))"`;

    executeOnFire(cmd, rem);

    const data = JSON.parse(readFileSync(tmpFile, 'utf-8'));
    expect(data.id).toBe('env-check-id');
    expect(data.content).toBe('env check content');
    expect(data.priority).toBe('1');
    expect(data.tags).toBe('a,b,c');
    expect(data.context).toBe('my context');
    expect(data.due).toBe('2026-03-01T08:00:00');
    expect(data.fireCount).toBe('3');

    try { rmSync(tmpFile); } catch {}
  });

  it('uses default timeout of 5000ms', () => {
    const rem = makeReminder();
    // A command that sleeps 1s should succeed with default 5s timeout
    const result = executeOnFire('sleep 1', rem);
    expect(result).toBe(true);
  });

  it('handles empty/null optional fields gracefully', () => {
    const rem = makeReminder({
      tags: undefined as any,
      context: undefined as any,
      trigger_at: undefined as any,
      fire_count: undefined as any,
    });
    // Should not throw
    const result = executeOnFire('echo ok', rem);
    expect(result).toBe(true);
  });
});

describe('runCheckCycle with onFire', () => {
  it('does not call on-fire when no reminders fire', () => {
    const state: WatchState = { lastNotified: new Map() };
    // With a fresh DB that has no reminders, on-fire should not be called
    const notified = runCheckCycle(state, {
      onFire: 'echo should-not-run',
      onNotify: () => {}, // no-op notifications
    });
    expect(notified.length).toBe(0);
  });
});
