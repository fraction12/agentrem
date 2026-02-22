// ── watch-gc-error.test.ts ────────────────────────────────────────────────────
// Tests that gc errors are non-fatal and never crash the watch loop.
// Uses vi.mock to inject a throwing coreGc.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initDb } from '../src/db.js';

// Mock core module so we can make coreGc throw
vi.mock('../src/core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core.js')>();
  return {
    ...actual,
    // Replaced per-test via vi.mocked / mockImplementation
    coreGc: vi.fn(actual.coreGc),
  };
});

import { runCheckCycle, type WatchState } from '../src/watch.js';
import { coreGc } from '../src/core.js';

describe('runCheckCycle — gc error handling', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrem-gc-err-test-'));
    dbPath = path.join(tmpDir, 'reminders.db');
    process.env['AGENTREM_DB'] = dbPath;
    initDb(false, dbPath);
    vi.mocked(coreGc).mockClear();
  });

  afterEach(() => {
    delete process.env['AGENTREM_DB'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does not throw when coreGc throws — watch loop continues', () => {
    vi.mocked(coreGc).mockImplementation(() => {
      throw new Error('gc exploded');
    });

    const state: WatchState = { lastNotified: new Map(), lastGc: 0 };
    const noopNotify = () => {};

    // Must not throw
    expect(() =>
      runCheckCycle(state, { dbPath, onNotify: noopNotify, gcIntervalMs: 0 }, Date.now()),
    ).not.toThrow();

    // gc was attempted
    expect(vi.mocked(coreGc)).toHaveBeenCalled();

    // lastGc should NOT have been updated (error prevented it)
    expect(state.lastGc).toBe(0);
  });

  it('logs the gc error message when verbose=true but still continues', () => {
    vi.mocked(coreGc).mockImplementation(() => {
      throw new Error('db locked');
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const state: WatchState = { lastNotified: new Map(), lastGc: 0 };

    expect(() =>
      runCheckCycle(state, { dbPath, onNotify: () => {}, gcIntervalMs: 0, verbose: true }, Date.now()),
    ).not.toThrow();

    const logs = consoleSpy.mock.calls.map((args) => args.join(' '));
    const gcErrLog = logs.find((l) => l.includes('gc error'));
    expect(gcErrLog).toBeDefined();
    expect(gcErrLog).toContain('db locked');

    consoleSpy.mockRestore();
  });
});
