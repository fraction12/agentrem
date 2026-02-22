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

// ── Mock node:fs so icon check always returns false in tests ───────────────
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false) }));

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
  it('returns "just now" for 0ms', () => {
    expect(formatOverdue(0)).toBe('just now');
  });

  it('returns "just now" for < 2 minutes', () => {
    expect(formatOverdue(60_000)).toBe('just now');
  });

  it('returns "just now" at 1 min 59s', () => {
    expect(formatOverdue(119_000)).toBe('just now');
  });

  it('returns "2 min ago" at exactly 2 minutes', () => {
    expect(formatOverdue(2 * 60_000)).toBe('2 min ago');
  });

  it('returns "X min ago" for 2-30 min range', () => {
    expect(formatOverdue(5 * 60_000)).toBe('5 min ago');
    expect(formatOverdue(15 * 60_000)).toBe('15 min ago');
    expect(formatOverdue(29 * 60_000)).toBe('29 min ago');
  });

  it('returns "about an hour, no biggie" at 30 min', () => {
    expect(formatOverdue(30 * 60_000)).toBe('about an hour, no biggie');
  });

  it('returns "about an hour, no biggie" for 30-60 min range', () => {
    expect(formatOverdue(45 * 60_000)).toBe('about an hour, no biggie');
    expect(formatOverdue(59 * 60_000)).toBe('about an hour, no biggie');
  });

  it('returns "been a couple hours..." at 1 hour', () => {
    expect(formatOverdue(60 * 60_000)).toBe('been a couple hours...');
  });

  it('returns "been a couple hours..." for 1-3h range', () => {
    expect(formatOverdue(2 * 60 * 60_000)).toBe('been a couple hours...');
  });

  it('returns "this has been waiting a while" at 3 hours', () => {
    expect(formatOverdue(3 * 60 * 60_000)).toBe('this has been waiting a while');
  });

  it('returns "this has been waiting a while" for 3-6h range', () => {
    expect(formatOverdue(5 * 60 * 60_000)).toBe('this has been waiting a while');
  });

  it('returns the 😅 message at 6 hours', () => {
    expect(formatOverdue(6 * 60 * 60_000)).toBe('so... you forgot about this one 😅');
  });

  it('returns the 😅 message for 6-24h range', () => {
    expect(formatOverdue(12 * 60 * 60_000)).toBe('so... you forgot about this one 😅');
    expect(formatOverdue(23 * 60 * 60_000)).toBe('so... you forgot about this one 😅');
  });

  it('returns "it\'s been a whole day, dude" at 24 hours', () => {
    expect(formatOverdue(24 * 60 * 60_000)).toBe("it's been a whole day, dude");
  });

  it('returns "it\'s been a whole day, dude" for 24-48h range', () => {
    expect(formatOverdue(36 * 60 * 60_000)).toBe("it's been a whole day, dude");
  });

  it('returns "X days" message at 48 hours', () => {
    expect(formatOverdue(48 * 60 * 60_000)).toBe("I've been here for 2 days. just saying.");
  });

  it('returns "X days" message for 48h+ range', () => {
    expect(formatOverdue(7 * 24 * 60 * 60_000)).toBe("I've been here for 7 days. just saying.");
  });
});

// ── buildNotifyOpts ─────────────────────────────────────────────────────────

describe('buildNotifyOpts', () => {
  // ── Title per priority ──────────────────────────────────────────────────

  it('P1 title is cheeky urgent message', () => {
    const rem = makeReminder({ priority: 1 });
    expect(buildNotifyOpts(rem).title).toBe("⚡ Yo. This one's urgent.");
  });

  it('P2 title is heads up message', () => {
    const rem = makeReminder({ priority: 2 });
    expect(buildNotifyOpts(rem).title).toBe('👋 Hey, heads up.');
  });

  it('P3 title is quick reminder', () => {
    const rem = makeReminder({ priority: 3 });
    expect(buildNotifyOpts(rem).title).toBe('📌 Quick reminder');
  });

  it('P4 title is "when you get a sec"', () => {
    const rem = makeReminder({ priority: 4 });
    expect(buildNotifyOpts(rem).title).toBe('💭 When you get a sec...');
  });

  it('P5 title is "no rush"', () => {
    const rem = makeReminder({ priority: 5 });
    expect(buildNotifyOpts(rem).title).toBe('🌊 No rush, but...');
  });

  it('title falls back to 📌 Quick reminder for unexpected priority', () => {
    const rem = makeReminder({ priority: 99 });
    expect(buildNotifyOpts(rem).title).toBe('📌 Quick reminder');
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

  it('subtitle is "due now ⏰" when trigger_at is null', () => {
    const rem = makeReminder({ trigger_at: null });
    expect(buildNotifyOpts(rem).subtitle).toBe('due now ⏰');
  });

  it('subtitle is "just now" when less than 2 minutes overdue', () => {
    const now = Date.now();
    const dueAt = new Date(now - 30_000); // 30s ago
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildNotifyOpts(rem, now).subtitle).toBe('just now');
  });

  it('subtitle is "due now ⏰" when reminder is in the future', () => {
    const now = Date.now();
    const dueAt = new Date(now + 5 * 60_000); // 5 min ahead
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildNotifyOpts(rem, now).subtitle).toBe('due now ⏰');
  });

  it('subtitle shows "X min ago" when overdue by minutes', () => {
    const now = Date.now();
    const dueAt = new Date(now - 25 * 60_000);
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildNotifyOpts(rem, now).subtitle).toBe('25 min ago');
  });

  it('subtitle shows fun message when hours overdue', () => {
    const now = Date.now();
    const dueAt = new Date(now - 3 * 60 * 60_000);
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildNotifyOpts(rem, now).subtitle).toBe('this has been waiting a while');
  });

  it('subtitle shows days message when 2+ days overdue', () => {
    const now = Date.now();
    const dueAt = new Date(now - 2 * 24 * 60 * 60_000);
    const rem = makeReminder({ trigger_at: dtToIso(dueAt) });
    expect(buildNotifyOpts(rem, now).subtitle).toBe("I've been here for 2 days. just saying.");
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
      title: "⚡ Yo. This one's urgent.",
      subtitle: '5 min ago',
      message: 'Deploy hotfix',
      sound: 'Hero',
      group: 'com.agentrem.watch',
    };
    sendNotification(opts);

    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'terminal-notifier',
      [
        '-title', "⚡ Yo. This one's urgent.",
        '-subtitle', '5 min ago',
        '-message', 'Deploy hotfix',
        '-sound', 'Hero',
        '-group', 'com.agentrem.watch',
        // no -appIcon because existsSync is mocked to false
      ],
      { stdio: 'pipe' },
    );
  });

  it('omits -sound when sound is undefined', () => {
    const opts: NotifyOpts = {
      title: '💭 When you get a sec...',
      subtitle: 'due now ⏰',
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
      title: '📌 Quick reminder',
      subtitle: 'due now ⏰',
      message: 'Test',
    };
    sendNotification(opts);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Quick reminder'));
    consoleSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
});
