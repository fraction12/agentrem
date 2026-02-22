// ── watch.test.ts ─────────────────────────────────────────────────────────
// Tests for dedup logic, notification formatting, and service file generation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initDb, getDb } from '../src/db.js';
import { coreAdd } from '../src/core.js';
import { dtToIso } from '../src/date-parser.js';

// ─── Watch module under test ───────────────────────────────────────────────
import {
  DEDUP_COOLDOWN_MS,
  shouldNotify,
  markNotified,
  type WatchState,
  runCheckCycle,
} from '../src/watch.js';

// ─── Service module under test ─────────────────────────────────────────────
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  getLaunchAgentPath,
  getSystemdUnitPath,
  escapeXml,
  LAUNCH_AGENT_LABEL,
  SYSTEMD_UNIT_NAME,
  type ServiceOptions,
} from '../src/service.js';

import type { Reminder } from '../src/types.js';

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

function makeState(): WatchState {
  return { lastNotified: new Map() };
}

// ── Dedup / cooldown logic ───────────────────────────────────────────────────

describe('shouldNotify', () => {
  it('returns true when reminder has never been notified', () => {
    const state = makeState();
    expect(shouldNotify(state, 'rem-1')).toBe(true);
  });

  it('returns false immediately after notification (within cooldown)', () => {
    const state = makeState();
    const now = Date.now();
    markNotified(state, 'rem-1', now);
    // 1 minute later — still in 5-min cooldown
    expect(shouldNotify(state, 'rem-1', now + 60_000)).toBe(false);
  });

  it('returns false at exactly cooldown boundary (exclusive)', () => {
    const state = makeState();
    const now = Date.now();
    markNotified(state, 'rem-1', now);
    // exactly at cooldown — should still be false (cooldown not yet elapsed)
    expect(shouldNotify(state, 'rem-1', now + DEDUP_COOLDOWN_MS - 1)).toBe(false);
  });

  it('returns true after cooldown has fully elapsed', () => {
    const state = makeState();
    const now = Date.now();
    markNotified(state, 'rem-1', now);
    // After 5 min
    expect(shouldNotify(state, 'rem-1', now + DEDUP_COOLDOWN_MS)).toBe(true);
  });

  it('tracks different reminders independently', () => {
    const state = makeState();
    const now = Date.now();
    markNotified(state, 'rem-1', now);
    // rem-1 in cooldown, rem-2 never notified
    expect(shouldNotify(state, 'rem-1', now + 60_000)).toBe(false);
    expect(shouldNotify(state, 'rem-2', now + 60_000)).toBe(true);
  });

  it('returns true after cooldown for one reminder but false for another', () => {
    const state = makeState();
    const now = Date.now();
    markNotified(state, 'rem-1', now);
    markNotified(state, 'rem-2', now + 3 * 60_000); // notified 3 min later

    const checkTime = now + DEDUP_COOLDOWN_MS + 1_000; // 5min1s after start
    // rem-1 cooldown has elapsed
    expect(shouldNotify(state, 'rem-1', checkTime)).toBe(true);
    // rem-2 still in cooldown (only ~2min elapsed since its notification)
    expect(shouldNotify(state, 'rem-2', checkTime)).toBe(false);
  });
});

describe('markNotified', () => {
  it('stores the timestamp for the given ID', () => {
    const state = makeState();
    const ts = 1_700_000_000_000;
    markNotified(state, 'rem-x', ts);
    expect(state.lastNotified.get('rem-x')).toBe(ts);
  });

  it('overwrites previous timestamp on re-notification', () => {
    const state = makeState();
    const ts1 = 1_700_000_000_000;
    const ts2 = ts1 + DEDUP_COOLDOWN_MS + 1_000;
    markNotified(state, 'rem-x', ts1);
    markNotified(state, 'rem-x', ts2);
    expect(state.lastNotified.get('rem-x')).toBe(ts2);
  });
});

describe('DEDUP_COOLDOWN_MS', () => {
  it('is exactly 5 minutes in milliseconds', () => {
    expect(DEDUP_COOLDOWN_MS).toBe(5 * 60 * 1000);
  });
});

describe('shouldNotify — custom cooldown', () => {
  it('respects a custom cooldownMs of 10 seconds', () => {
    const state = makeState();
    const now = Date.now();
    markNotified(state, 'rem-1', now);
    // 5 seconds later — within 10s cooldown
    expect(shouldNotify(state, 'rem-1', now + 5_000, 10_000)).toBe(false);
    // 11 seconds later — beyond 10s cooldown
    expect(shouldNotify(state, 'rem-1', now + 11_000, 10_000)).toBe(true);
  });

  it('respects a custom cooldownMs of 0 (always notify)', () => {
    const state = makeState();
    const now = Date.now();
    markNotified(state, 'rem-1', now);
    // Immediately — cooldown 0 means always re-notify
    expect(shouldNotify(state, 'rem-1', now, 0)).toBe(true);
  });
});

// ── GC timing ────────────────────────────────────────────────────────────────

describe('runCheckCycle — gc timing', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrem-gc-test-'));
    dbPath = path.join(tmpDir, 'reminders.db');
    process.env['AGENTREM_DB'] = dbPath;
    initDb(false, dbPath);
  });

  afterEach(() => {
    delete process.env['AGENTREM_DB'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const noopNotify = () => {};

  it('runs gc on first poll (lastGc defaults to 0)', () => {
    const state: WatchState = { lastNotified: new Map() }; // lastGc undefined → 0
    const now = Date.now();
    runCheckCycle(state, { dbPath, onNotify: noopNotify, gcIntervalMs: 86_400_000 }, now);
    // state.lastGc should now be set to `now`
    expect(state.lastGc).toBe(now);
  });

  it('does not run gc again within the interval', () => {
    const now = Date.now();
    const state: WatchState = { lastNotified: new Map(), lastGc: now - 1_000 }; // 1 sec ago
    runCheckCycle(state, { dbPath, onNotify: noopNotify, gcIntervalMs: 86_400_000 }, now);
    // gc should NOT have run — lastGc unchanged
    expect(state.lastGc).toBe(now - 1_000);
  });

  it('runs gc again after the interval elapses', () => {
    const now = Date.now();
    const state: WatchState = { lastNotified: new Map(), lastGc: now - 86_400_001 }; // just over 24h ago
    runCheckCycle(state, { dbPath, onNotify: noopNotify, gcIntervalMs: 86_400_000 }, now);
    // gc should have run — lastGc updated to now
    expect(state.lastGc).toBe(now);
  });
});

// ── runCheckCycle integration ─────────────────────────────────────────────────

describe('runCheckCycle', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrem-watch-test-'));
    dbPath = path.join(tmpDir, 'reminders.db');
    process.env['AGENTREM_DB'] = dbPath;
    initDb(false, dbPath);
  });

  afterEach(() => {
    delete process.env['AGENTREM_DB'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const noopNotify = () => {};

  it('returns empty array when no reminders are due', () => {
    const state = makeState();
    const notified = runCheckCycle(state, { dbPath, once: true, onNotify: noopNotify });
    expect(notified).toEqual([]);
  });

  it('notifies a due reminder and records it in state', () => {
    const db = getDb(dbPath);
    const pastDue = new Date(Date.now() - 10_000);
    coreAdd(db, {
      content: 'Overdue task',
      trigger: 'time',
      due: dtToIso(pastDue),
      priority: 2,
    });
    db.close();

    const state = makeState();
    const notified = runCheckCycle(state, { dbPath, once: true, onNotify: noopNotify });
    expect(notified.length).toBeGreaterThanOrEqual(1);
    expect(notified[0].content).toBe('Overdue task');
    // State should record the notification
    expect(state.lastNotified.size).toBe(1);
  });

  it('does not re-notify a reminder within cooldown', () => {
    const db = getDb(dbPath);
    const pastDue = new Date(Date.now() - 10_000);
    const rem = coreAdd(db, {
      content: 'Cooldown task',
      trigger: 'time',
      due: dtToIso(pastDue),
      priority: 3,
    });
    db.close();

    const state = makeState();
    const now = Date.now();
    // Pre-mark as notified 1 minute ago
    markNotified(state, rem.id, now - 60_000);

    const notified = runCheckCycle(state, { dbPath, once: true, onNotify: noopNotify }, now);
    // Should be filtered out by dedup
    const thisRem = notified.find((r) => r.id === rem.id);
    expect(thisRem).toBeUndefined();
  });

  it('re-notifies after cooldown has elapsed', () => {
    const db = getDb(dbPath);
    const pastDue = new Date(Date.now() - 10_000);
    const rem = coreAdd(db, {
      content: 'Re-notify task',
      trigger: 'time',
      due: dtToIso(pastDue),
      priority: 2,
    });
    db.close();

    const state = makeState();
    const longAgo = Date.now() - DEDUP_COOLDOWN_MS - 5_000;
    markNotified(state, rem.id, longAgo);

    const notified = runCheckCycle(state, { dbPath, once: true, onNotify: noopNotify });
    const thisRem = notified.find((r) => r.id === rem.id);
    expect(thisRem).toBeDefined();
  });

  it('respects --cooldown option: does not re-notify within custom cooldown', () => {
    const db = getDb(dbPath);
    const rem = coreAdd(db, {
      content: 'Cooldown option task',
      trigger: 'heartbeat', // heartbeat never auto-completes
      priority: 3,
    });
    db.close();

    const state = makeState();
    const now = Date.now();
    // Notified 5 seconds ago
    markNotified(state, rem.id, now - 5_000);

    // Custom cooldown of 60 seconds — should NOT re-notify after 5s
    const notified = runCheckCycle(
      state,
      { dbPath, once: true, onNotify: noopNotify, cooldown: 60 },
      now,
    );
    const thisRem = notified.find((r) => r.id === rem.id);
    expect(thisRem).toBeUndefined();
  });

  it('respects --cooldown option: notifies when not yet in cooldown', () => {
    const db = getDb(dbPath);
    coreAdd(db, {
      content: 'Cooldown elapsed task',
      trigger: 'heartbeat',
      priority: 3,
    });
    db.close();

    const state = makeState();
    // Custom cooldown of 10 seconds, no prior notification
    const notified = runCheckCycle(
      state,
      { dbPath, once: true, onNotify: noopNotify, cooldown: 10 },
    );
    expect(notified.length).toBeGreaterThanOrEqual(1);
    expect(notified[0].content).toBe('Cooldown elapsed task');
  });
});

// ── generateLaunchdPlist ─────────────────────────────────────────────────────

describe('generateLaunchdPlist', () => {
  it('produces valid XML with required plist structure', () => {
    const plist = generateLaunchdPlist({ binPath: '/usr/local/bin/agentrem' });
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain('<!DOCTYPE plist');
    expect(plist).toContain('<plist version="1.0">');
    expect(plist).toContain('</plist>');
  });

  it('includes the correct Label key', () => {
    const plist = generateLaunchdPlist();
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
  });

  it('includes RunAtLoad and KeepAlive', () => {
    const plist = generateLaunchdPlist();
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
    expect(plist).toContain('<key>KeepAlive</key>');
  });

  it('includes the agentrem watch command', () => {
    const plist = generateLaunchdPlist({ binPath: '/usr/local/bin/agentrem' });
    expect(plist).toContain('<string>/usr/local/bin/agentrem</string>');
    expect(plist).toContain('<string>watch</string>');
  });

  it('includes the custom interval', () => {
    const plist = generateLaunchdPlist({ interval: 60 });
    expect(plist).toContain('<string>--interval</string>');
    expect(plist).toContain('<string>60</string>');
  });

  it('includes agent flag when specified', () => {
    const plist = generateLaunchdPlist({ agent: 'dash' });
    expect(plist).toContain('<string>--agent</string>');
    expect(plist).toContain('<string>dash</string>');
  });

  it('includes --verbose when specified', () => {
    const plist = generateLaunchdPlist({ verbose: true });
    expect(plist).toContain('<string>--verbose</string>');
  });

  it('does not include --verbose when not specified', () => {
    const plist = generateLaunchdPlist({ verbose: false });
    expect(plist).not.toContain('--verbose');
  });

  it('includes log file paths', () => {
    const plist = generateLaunchdPlist({ logDir: '/tmp/testlogs' });
    // Normalize path separators for cross-platform (Windows uses backslashes)
    const normalized = plist.replace(/\\/g, '/');
    expect(normalized).toContain('/tmp/testlogs/watch.log');
    expect(normalized).toContain('/tmp/testlogs/watch.error.log');
  });

  it('escapes special XML characters in paths', () => {
    const plist = generateLaunchdPlist({ logDir: '/path/with & special <chars>' });
    expect(plist).toContain('&amp;');
    expect(plist).toContain('&lt;');
    expect(plist).toContain('&gt;');
  });
});

// ── generateSystemdUnit ────────────────────────────────────────────────────

describe('generateSystemdUnit', () => {
  it('has [Unit], [Service], and [Install] sections', () => {
    const unit = generateSystemdUnit();
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
  });

  it('includes ExecStart with agentrem watch', () => {
    const unit = generateSystemdUnit({ binPath: '/usr/bin/agentrem' });
    expect(unit).toContain('ExecStart=/usr/bin/agentrem watch');
  });

  it('includes the custom interval', () => {
    const unit = generateSystemdUnit({ interval: 120 });
    expect(unit).toContain('--interval 120');
  });

  it('includes agent name when specified', () => {
    const unit = generateSystemdUnit({ agent: 'myagent' });
    expect(unit).toContain('--agent myagent');
  });

  it('includes --verbose when specified', () => {
    const unit = generateSystemdUnit({ verbose: true });
    expect(unit).toContain('--verbose');
  });

  it('does not include --verbose when not specified', () => {
    const unit = generateSystemdUnit({ verbose: false });
    expect(unit).not.toContain('--verbose');
  });

  it('has Restart=on-failure', () => {
    const unit = generateSystemdUnit();
    expect(unit).toContain('Restart=on-failure');
  });

  it('has WantedBy=default.target', () => {
    const unit = generateSystemdUnit();
    expect(unit).toContain('WantedBy=default.target');
  });

  it('includes custom log dir paths', () => {
    const unit = generateSystemdUnit({ logDir: '/var/log/agentrem' });
    expect(unit).toContain('/var/log/agentrem/watch.log');
    expect(unit).toContain('/var/log/agentrem/watch.error.log');
  });

  it('sets HOME environment variable', () => {
    const unit = generateSystemdUnit();
    expect(unit).toContain(`HOME=${os.homedir()}`);
  });
});

// ── escapeXml helper ─────────────────────────────────────────────────────────

describe('escapeXml', () => {
  it('escapes ampersands', () => {
    expect(escapeXml('foo & bar')).toBe('foo &amp; bar');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeXml("it's here")).toBe('it&apos;s here');
  });

  it('does not modify normal strings', () => {
    expect(escapeXml('/usr/local/bin/agentrem')).toBe('/usr/local/bin/agentrem');
  });
});

// ── getLaunchAgentPath / getSystemdUnitPath ────────────────────────────────

describe('getLaunchAgentPath', () => {
  it('returns a path under ~/Library/LaunchAgents/', () => {
    const p = getLaunchAgentPath();
    expect(p).toContain(path.join(os.homedir(), 'Library', 'LaunchAgents'));
    expect(p).toContain(LAUNCH_AGENT_LABEL);
    expect(p.endsWith('.plist')).toBe(true);
  });
});

describe('getSystemdUnitPath', () => {
  it('returns a path under ~/.config/systemd/user/', () => {
    const p = getSystemdUnitPath();
    expect(p).toContain(path.join(os.homedir(), '.config', 'systemd', 'user'));
    expect(p).toContain(SYSTEMD_UNIT_NAME);
    expect(p.endsWith('.service')).toBe(true);
  });
});
