// ── notifier.test.ts ──────────────────────────────────────────────────────
// Tests for src/notifier.ts: buildNotifyOpts (pure), formatOverdue,
// detectNotifier (cached), and sendNotification dispatch.
// child_process is mocked so no real notifications fire.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Reminder } from '../src/types.js';
import { dtToIso } from '../src/date-parser.js';

// ── Mock child_process BEFORE importing the module ─────────────────────────
vi.mock('node:child_process', () => {
  return {
    execFileSync: vi.fn(() => '/usr/local/bin/terminal-notifier\n'),
    execFile: vi.fn((_cmd: string, _args: string[], cb?: Function) => {
      if (cb) cb(null, '', '');
    }),
  };
});

import {
  buildNotifyOpts,
  formatOverdue,
  detectNotifier,
  _resetNotifierCache,
  sendNotification,
  type NotifyOpts,
  type NotifierBackend,
} from '../src/notifier.js';

import { execFileSync, execFile } from 'node:child_process';

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── formatOverdue ──────────────────────────────────────────────────────────

describe('formatOverdue', () => {
  it('returns minutes for <60 min', () => {
    expect(formatOverdue(5 * 60_000)).toBe('5m overdue');
  });

  it('returns 1m for exactly 1 minute', () => {
    expect(formatOverdue(60_000)).toBe('1m overdue');
  });

  it('returns 59m at the edge before 1 hour', () => {
    expect(formatOverdue(59 * 60_000)).toBe('59m overdue');
  });

  it('returns hours for >=60 min', () => {
    expect(formatOverdue(60 * 60_000)).toBe('1h overdue');
  });

  it('returns 3h for 3 hours', () => {
    expect(formatOverdue(3 * 60 * 60_000)).toBe('3h overdue');
  });

  it('returns 23h at the edge before 1 day', () => {
    expect(formatOverdue(23 * 60 * 60_000)).toBe('23h overdue');
  });

  it('returns days for >=24 hours', () => {
    expect(formatOverdue(24 * 60 * 60_000)).toBe('1d overdue');
  });

  it('returns 7d for a week', () => {
    expect(formatOverdue(7 * 24 * 60 * 60_000)).toBe('7d overdue');
  });
});

// ── buildNotifyOpts ─────────────────────────────────────────────────────────

describe('buildNotifyOpts', () => {
  // ── Title with priority icon ────────────────────────────────────────────

  it('title includes 🔴 for priority 1', () => {
    const rem = makeReminder({ priority: 1 });
    expect(buildNotifyOpts(rem).title).toBe('🔴 agentrem');
  });

  it('title includes 🟡 for priority 2', () => {
    const rem = makeReminder({ priority: 2 });
    expect(buildNotifyOpts(rem).title).toBe('🟡 agentrem');
  });

  it('title includes 🔵 for priority 3 (normal)', () => {
    const rem = makeReminder({ priority: 3 });
    expect(buildNotifyOpts(rem).title).toBe('🔵 agentrem');
  });

  it('title includes ⚪ for priority 4 (low)', () => {
    const rem = makeReminder({ priority: 4 });
    expect(buildNotifyOpts(rem).title).toBe('⚪ agentrem');
  });

  it('title includes 💤 for priority 5 (someday)', () => {
    const rem = makeReminder({ priority: 5 });
    expect(buildNotifyOpts(rem).title).toBe('💤 agentrem');
  });

  it('title falls back to 🔵 for unexpected priority', () => {
    const rem = makeReminder({ priority: 99 });
    expect(buildNotifyOpts(rem).title).toBe('🔵 agentrem');
  });

  // ── Sound mapping ───────────────────────────────────────────────────────

  it('P1 maps to Hero sound', () => {
    const rem = makeReminder({ priority: 1 });
    expect(buildNotifyOpts(rem).sound).toBe('Hero');
  });

  it('P2 maps to Ping sound', () => {
    const rem = makeReminder({ priority: 2 });
    expect(buildNotifyOpts(rem).sound).toBe('Ping');
  });

  it('P3 maps to Pop sound', () => {
    const rem = makeReminder({ priority: 3 });
    expect(buildNotifyOpts(rem).sound).toBe('Pop');
  });

  it('P4 has no sound', () => {
    const rem = makeReminder({ priority: 4 });
    expect(buildNotifyOpts(rem).sound).toBeUndefined();
  });

  it('P5 has no sound', () => {
    const rem = makeReminder({ priority: 5 });
    expect(buildNotifyOpts(rem).sound).toBeUndefined();
  });

  // ── Subtitle (overdue calculation) ──────────────────────────────────────

  it('subtitle is "due now" when trigger_at is null', () => {
    const rem = makeReminder({ trigger_at: null });
    expect(buildNotifyOpts(rem).subtitle).toBe('due now');
  });

  it('subtitle is "due now" when less than 1 minute overdue', () => {
    const now = Date.now();
    const dueAt = new Date(now - 30_000); // 30s ago
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildNotifyOpts(rem, now).subtitle).toBe('due now');
  });

  it('subtitle is "due now" when reminder is in the future', () => {
    const now = Date.now();
    const dueAt = new Date(now + 5 * 60_000); // 5 min ahead
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildNotifyOpts(rem, now).subtitle).toBe('due now');
  });

  it('subtitle shows minutes when >= 1 minute overdue', () => {
    const now = Date.now();
    const dueAt = new Date(now - 25 * 60_000);
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildNotifyOpts(rem, now).subtitle).toBe('25m overdue');
  });

  it('subtitle shows hours when >= 60 minutes overdue', () => {
    const now = Date.now();
    const dueAt = new Date(now - 3 * 60 * 60_000);
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildNotifyOpts(rem, now).subtitle).toBe('3h overdue');
  });

  it('subtitle shows days when >= 24 hours overdue', () => {
    const now = Date.now();
    const dueAt = new Date(now - 2 * 24 * 60 * 60_000);
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildNotifyOpts(rem, now).subtitle).toBe('2d overdue');
  });

  // ── Message ─────────────────────────────────────────────────────────────

  it('message is the content truncated to 80 chars', () => {
    const longContent = 'A'.repeat(200);
    const rem = makeReminder({ content: longContent });
    const opts = buildNotifyOpts(rem);
    expect(opts.message.length).toBeLessThanOrEqual(80);
  });

  it('message preserves short content as-is', () => {
    const rem = makeReminder({ content: 'Buy milk' });
    expect(buildNotifyOpts(rem).message).toBe('Buy milk');
  });

  // ── Group ───────────────────────────────────────────────────────────────

  it('group is always com.agentrem.watch', () => {
    const rem = makeReminder({ priority: 1 });
    expect(buildNotifyOpts(rem).group).toBe('com.agentrem.watch');
  });
});

// ── detectNotifier ────────────────────────────────────────────────────────

describe('detectNotifier', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    _resetNotifierCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetNotifierCache();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('returns "terminal-notifier" when which succeeds', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('/usr/local/bin/terminal-notifier\n' as any);
    expect(detectNotifier()).toBe('terminal-notifier');
  });

  it('returns "osascript" when terminal-notifier missing on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('not found');
    });
    expect(detectNotifier()).toBe('osascript');
  });

  it('returns "console" when terminal-notifier missing on non-macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('not found');
    });
    expect(detectNotifier()).toBe('console');
  });

  it('caches the result across calls', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('/usr/local/bin/terminal-notifier\n' as any);
    detectNotifier();
    detectNotifier();
    detectNotifier();
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
  });
});

// ── sendNotification ──────────────────────────────────────────────────────

describe('sendNotification', () => {
  beforeEach(() => {
    _resetNotifierCache();
    vi.clearAllMocks();
    // Default: terminal-notifier is available
    vi.mocked(execFileSync).mockReturnValue('/usr/local/bin/terminal-notifier\n' as any);
  });

  afterEach(() => {
    _resetNotifierCache();
  });

  it('calls terminal-notifier with correct args', () => {
    const opts: NotifyOpts = {
      title: '🔴 agentrem',
      subtitle: '5m overdue',
      message: 'Deploy hotfix',
      sound: 'Hero',
      group: 'com.agentrem.watch',
    };
    sendNotification(opts);

    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'terminal-notifier',
      [
        '-title', '🔴 agentrem',
        '-subtitle', '5m overdue',
        '-message', 'Deploy hotfix',
        '-sound', 'Hero',
        '-group', 'com.agentrem.watch',
      ],
      { stdio: 'pipe' },
    );
  });

  it('omits -sound when sound is undefined', () => {
    const opts: NotifyOpts = {
      title: '⚪ agentrem',
      subtitle: 'due now',
      message: 'Low priority',
      group: 'com.agentrem.watch',
    };
    sendNotification(opts);

    const callArgs = vi.mocked(execFileSync).mock.calls;
    const tnCall = callArgs.find((c) => c[0] === 'terminal-notifier');
    expect(tnCall).toBeDefined();
    const args = tnCall![1] as string[];
    expect(args).not.toContain('-sound');
  });

  it('falls to console.log when backend is console', () => {
    // Force console backend
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found');
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const opts: NotifyOpts = {
      title: '🔵 agentrem',
      subtitle: 'due now',
      message: 'Test',
    };
    sendNotification(opts);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('agentrem'));
    consoleSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
});
