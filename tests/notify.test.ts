// ── notify.test.ts ────────────────────────────────────────────────────────
// Tests for the notify module: formatting, sound mapping, overdue calculation,
// fallback detection, and sendNotification dispatch.
// execFile / execFileSync calls are mocked so no real notifications fire.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Reminder } from '../src/types.js';
import { dtToIso } from '../src/date-parser.js';

// ── Mock child_process BEFORE importing the module ─────────────────────────
vi.mock('node:child_process', () => {
  return {
    execFile: vi.fn((_cmd: string, _args: string[], cb?: Function) => {
      if (cb) cb(null, '', '');
    }),
    execFileSync: vi.fn(() => '/usr/local/bin/terminal-notifier\n'),
  };
});

import {
  buildTitle,
  buildSubtitle,
  buildMessage,
  detectNotifier,
  resetDetectedBackend,
  sendNotification,
  PRIORITY_SOUNDS,
  PRIORITY_NAMES,
  PRIORITY_EMOJIS,
  type NotifierBackend,
} from '../src/notify.js';

import { execFile, execFileSync } from 'node:child_process';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'abcdef1234567890',
    content: 'Test reminder content',
    context: null,
    trigger_type: 'time',
    trigger_at: dtToIso(new Date()),
    trigger_config: null,
    priority: 3,
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

// ── buildTitle ─────────────────────────────────────────────────────────────

describe('buildTitle', () => {
  it('includes priority emoji and label for P1 (Critical)', () => {
    const rem = makeReminder({ priority: 1 });
    expect(buildTitle(rem)).toBe('🔴 agentrem — Critical');
  });

  it('includes priority emoji and label for P2 (High)', () => {
    const rem = makeReminder({ priority: 2 });
    expect(buildTitle(rem)).toBe('🟡 agentrem — High');
  });

  it('includes priority emoji and label for P3 (Normal)', () => {
    const rem = makeReminder({ priority: 3 });
    expect(buildTitle(rem)).toBe('🔵 agentrem — Normal');
  });

  it('includes priority emoji and label for P4 (Low)', () => {
    const rem = makeReminder({ priority: 4 });
    expect(buildTitle(rem)).toBe('⚪ agentrem — Low');
  });

  it('includes priority emoji and label for P5 (Someday)', () => {
    const rem = makeReminder({ priority: 5 });
    expect(buildTitle(rem)).toBe('💤 agentrem — Someday');
  });

  it('falls back gracefully for unexpected priority', () => {
    const rem = makeReminder({ priority: 99 });
    const title = buildTitle(rem);
    expect(title).toContain('agentrem');
    expect(title).toContain('—');
  });
});

// ── buildSubtitle ──────────────────────────────────────────────────────────

describe('buildSubtitle', () => {
  it('returns "Due now" when trigger_at is null', () => {
    const rem = makeReminder({ trigger_at: null });
    expect(buildSubtitle(rem)).toBe('Due now');
  });

  it('returns "Due now" when reminder is less than 1 minute overdue', () => {
    const now = Date.now();
    const dueAt = new Date(now - 30_000); // 30s ago
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildSubtitle(rem, now)).toBe('Due now');
  });

  it('returns "Due now" when reminder is exactly on time', () => {
    const now = Date.now();
    const rem = makeReminder({ trigger_at: dtToIso(new Date(now)) });
    expect(buildSubtitle(rem, now)).toBe('Due now');
  });

  it('returns "1 minute overdue" for exactly 1 minute', () => {
    const now = Date.now();
    const dueAt = new Date(now - 60_000);
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildSubtitle(rem, now)).toBe('1 minute overdue');
  });

  it('returns "25 minutes overdue" for 25 minutes', () => {
    const now = Date.now();
    const dueAt = new Date(now - 25 * 60_000);
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildSubtitle(rem, now)).toBe('25 minutes overdue');
  });

  it('returns "59 minutes overdue" at the edge before 1 hour', () => {
    const now = Date.now();
    const dueAt = new Date(now - 59 * 60_000);
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildSubtitle(rem, now)).toBe('59 minutes overdue');
  });

  it('returns "1 hour overdue" for exactly 1 hour', () => {
    const now = Date.now();
    const dueAt = new Date(now - 60 * 60_000);
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildSubtitle(rem, now)).toBe('1 hour overdue');
  });

  it('returns "3 hours overdue" for 3 hours', () => {
    const now = Date.now();
    const dueAt = new Date(now - 3 * 60 * 60_000);
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildSubtitle(rem, now)).toBe('3 hours overdue');
  });

  it('returns "Due now" for future reminder', () => {
    const now = Date.now();
    const dueAt = new Date(now + 5 * 60_000); // 5 min in future
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    // overdueMs is negative → < 60_000 threshold → "Due now"
    expect(buildSubtitle(rem, now)).toBe('Due now');
  });
});

// ── buildMessage ──────────────────────────────────────────────────────────

describe('buildMessage', () => {
  it('returns content only when no context', () => {
    const rem = makeReminder({ content: 'Deploy hotfix', context: null });
    expect(buildMessage(rem)).toBe('Deploy hotfix');
  });

  it('appends context on a new line when present', () => {
    const rem = makeReminder({ content: 'Deploy hotfix', context: 'Production server' });
    expect(buildMessage(rem)).toBe('Deploy hotfix\nProduction server');
  });

  it('does not include tags (tags are not in message body)', () => {
    const rem = makeReminder({ content: 'Deploy hotfix', context: null, tags: 'ops,prod' });
    expect(buildMessage(rem)).toBe('Deploy hotfix');
  });
});

// ── Sound mapping ─────────────────────────────────────────────────────────

describe('PRIORITY_SOUNDS', () => {
  it('P1 (Critical) maps to Hero', () => {
    expect(PRIORITY_SOUNDS[1]).toBe('Hero');
  });

  it('P2 (High) maps to Pop', () => {
    expect(PRIORITY_SOUNDS[2]).toBe('Pop');
  });

  it('P3 (Normal) maps to Submarine', () => {
    expect(PRIORITY_SOUNDS[3]).toBe('Submarine');
  });

  it('P4 (Low) has no sound', () => {
    expect(PRIORITY_SOUNDS[4]).toBeNull();
  });

  it('P5 (Someday) has no sound', () => {
    expect(PRIORITY_SOUNDS[5]).toBeNull();
  });
});

// ── detectNotifier ────────────────────────────────────────────────────────

describe('detectNotifier', () => {
  beforeEach(() => {
    resetDetectedBackend();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetDetectedBackend();
  });

  it('returns "terminal-notifier" when which succeeds', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('/usr/local/bin/terminal-notifier\n' as any);
    const backend = detectNotifier();
    expect(backend).toBe('terminal-notifier');
  });

  it('returns "osascript" when terminal-notifier is missing but osascript is found', () => {
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => { throw new Error('not found'); }) // terminal-notifier
      .mockReturnValueOnce('/usr/bin/osascript\n' as any);             // osascript
    const backend = detectNotifier();
    expect(backend).toBe('osascript');
  });

  it('returns "console" when neither is found', () => {
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => { throw new Error('not found'); }) // terminal-notifier
      .mockImplementationOnce(() => { throw new Error('not found'); }); // osascript
    const backend = detectNotifier();
    expect(backend).toBe('console');
  });

  it('caches the result and does not re-run which checks', () => {
    vi.mocked(execFileSync).mockReturnValue('/usr/local/bin/terminal-notifier\n' as any);
    detectNotifier();
    detectNotifier();
    detectNotifier();
    // execFileSync should only be called once (for the first detection)
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
  });

  it('returns a valid NotifierBackend value', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('/usr/local/bin/terminal-notifier\n' as any);
    const backend = detectNotifier();
    expect(['terminal-notifier', 'osascript', 'console']).toContain(backend);
  });
});

// ── sendNotification dispatch ──────────────────────────────────────────────

describe('sendNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls terminal-notifier with correct args when backend is terminal-notifier', () => {
    const rem = makeReminder({ priority: 1, content: 'Critical task' });
    sendNotification(rem, { backend: 'terminal-notifier' });

    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'terminal-notifier',
      expect.arrayContaining(['-title', expect.stringContaining('Critical')]),
      expect.any(Function),
    );
  });

  it('includes -sound Hero for P1 when using terminal-notifier', () => {
    const rem = makeReminder({ priority: 1 });
    sendNotification(rem, { backend: 'terminal-notifier' });

    const callArgs = vi.mocked(execFile).mock.calls[0];
    const args = callArgs[1] as string[];
    const soundIdx = args.indexOf('-sound');
    expect(soundIdx).toBeGreaterThan(-1);
    expect(args[soundIdx + 1]).toBe('Hero');
  });

  it('includes -sound Pop for P2 when using terminal-notifier', () => {
    const rem = makeReminder({ priority: 2 });
    sendNotification(rem, { backend: 'terminal-notifier' });

    const args = vi.mocked(execFile).mock.calls[0][1] as string[];
    const soundIdx = args.indexOf('-sound');
    expect(soundIdx).toBeGreaterThan(-1);
    expect(args[soundIdx + 1]).toBe('Pop');
  });

  it('does not include -sound for P4 when using terminal-notifier', () => {
    const rem = makeReminder({ priority: 4 });
    sendNotification(rem, { backend: 'terminal-notifier' });

    const args = vi.mocked(execFile).mock.calls[0][1] as string[];
    expect(args).not.toContain('-sound');
  });

  it('groups notifications by priority using -group com.agentrem.pN', () => {
    const rem = makeReminder({ priority: 2 });
    sendNotification(rem, { backend: 'terminal-notifier' });

    const args = vi.mocked(execFile).mock.calls[0][1] as string[];
    const groupIdx = args.indexOf('-group');
    expect(groupIdx).toBeGreaterThan(-1);
    expect(args[groupIdx + 1]).toBe('com.agentrem.p2');
  });

  it('calls osascript with display notification script when backend is osascript', () => {
    const rem = makeReminder({ priority: 3, content: 'Normal task' });
    sendNotification(rem, { backend: 'osascript' });

    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining(['-e', expect.stringContaining('display notification')]),
      expect.any(Function),
    );
  });

  it('falls back to console.log when backend is console', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rem = makeReminder({ priority: 3, content: 'Console fallback task' });
    sendNotification(rem, { backend: 'console' });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('agentrem'),
    );
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does not throw for any priority level', () => {
    for (const priority of [1, 2, 3, 4, 5]) {
      const rem = makeReminder({ priority });
      expect(() => sendNotification(rem, { backend: 'console' })).not.toThrow();
    }
  });
});

// ── Priority constants ─────────────────────────────────────────────────────

describe('PRIORITY_EMOJIS', () => {
  it('has entries for all 5 priority levels', () => {
    expect(Object.keys(PRIORITY_EMOJIS).length).toBe(5);
    expect(PRIORITY_EMOJIS[1]).toBe('🔴');
    expect(PRIORITY_EMOJIS[2]).toBe('🟡');
    expect(PRIORITY_EMOJIS[3]).toBe('🔵');
    expect(PRIORITY_EMOJIS[4]).toBe('⚪');
    expect(PRIORITY_EMOJIS[5]).toBe('💤');
  });
});

describe('PRIORITY_NAMES', () => {
  it('has correct names for all priority levels', () => {
    expect(PRIORITY_NAMES[1]).toBe('Critical');
    expect(PRIORITY_NAMES[2]).toBe('High');
    expect(PRIORITY_NAMES[3]).toBe('Normal');
    expect(PRIORITY_NAMES[4]).toBe('Low');
    expect(PRIORITY_NAMES[5]).toBe('Someday');
  });
});
