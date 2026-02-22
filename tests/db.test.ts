import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { initDb, getDb, findReminder, recordHistory, getHistoryEntries } from '../src/db.js';
import { VERSION } from '../src/types.js';

let tmpDir: string;
let dbPath: string;
let origDir: string | undefined;
let origDb: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrem-test-'));
  dbPath = path.join(tmpDir, 'reminders.db');
  origDir = process.env['AGENTREM_DIR'];
  origDb = process.env['AGENTREM_DB'];
  process.env['AGENTREM_DIR'] = tmpDir;
  process.env['AGENTREM_DB'] = dbPath;
});

afterEach(() => {
  if (origDir !== undefined) process.env['AGENTREM_DIR'] = origDir;
  else delete process.env['AGENTREM_DIR'];
  if (origDb !== undefined) process.env['AGENTREM_DB'] = origDb;
  else delete process.env['AGENTREM_DB'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── initDb ────────────────────────────────────────────────────────────────────

describe('initDb', () => {
  it('creates the DB file', () => {
    initDb(false, dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('has correct schema version', () => {
    initDb(false, dbPath);
    const db = new Database(dbPath);
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    db.close();
    expect(row.v).toBe(1);
  });

  it('creates all expected tables', () => {
    initDb(false, dbPath);
    const db = new Database(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    db.close();

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('reminders');
    expect(tableNames).toContain('reminders_fts');
    expect(tableNames).toContain('history');
    expect(tableNames).toContain('schema_version');
  });

  it('creates all expected indexes', () => {
    initDb(false, dbPath);
    const db = new Database(dbPath);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as { name: string }[];
    db.close();

    const indexNames = indexes.map((i) => i.name);
    const expected = [
      'idx_rem_status',
      'idx_rem_trigger',
      'idx_rem_due',
      'idx_rem_priority',
      'idx_rem_agent',
      'idx_rem_tags',
    ];
    for (const idx of expected) {
      expect(indexNames).toContain(idx);
    }
  });

  it('is idempotent - second call returns already initialized', () => {
    initDb(false, dbPath);
    const result = initDb(false, dbPath);
    expect(result).toContain('already initialized');
  });

  it('force recreates the database', () => {
    initDb(false, dbPath);
    // Insert a marker row so we can verify the DB was recreated
    const db = new Database(dbPath);
    db.exec(
      "INSERT INTO reminders(id, content, trigger_type) VALUES ('marker123', 'test', 'manual')",
    );
    db.close();

    initDb(true, dbPath);

    const db2 = new Database(dbPath);
    const count = db2.prepare('SELECT COUNT(*) as c FROM reminders').get() as { c: number };
    db2.close();
    expect(count.c).toBe(0);
  });

  it('creates a backup file on force init', () => {
    initDb(false, dbPath);
    initDb(true, dbPath);

    const files = fs.readdirSync(tmpDir);
    const backups = files.filter((f) => f.includes('.bak.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('enables WAL journal mode', () => {
    initDb(false, dbPath);
    const db = new Database(dbPath);
    const row = db.pragma('journal_mode') as { journal_mode: string }[];
    db.close();
    expect(row[0].journal_mode).toBe('wal');
  });
});

// ── getDb ─────────────────────────────────────────────────────────────────────

describe('getDb', () => {
  it('auto-initializes DB if it does not exist (fix #4)', () => {
    // Before: getDb() would throw; now it auto-inits
    expect(fs.existsSync(dbPath)).toBe(false);
    const db = getDb(dbPath);
    expect(db).toBeInstanceOf(Database);
    db.close();
    // DB file should now exist
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('auto-init creates a valid schema', () => {
    const db = getDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    db.close();
    const names = tables.map((t) => t.name);
    expect(names).toContain('reminders');
    expect(names).toContain('history');
  });

  it('returns a working Database instance after init', () => {
    initDb(false, dbPath);
    const db = getDb(dbPath);
    expect(db).toBeInstanceOf(Database);
    // Verify it can run a query
    const row = db.prepare('SELECT 1 as v').get() as { v: number };
    expect(row.v).toBe(1);
    db.close();
  });

  it('enables WAL mode on returned connection', () => {
    initDb(false, dbPath);
    const db = getDb(dbPath);
    const row = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(row[0].journal_mode).toBe('wal');
    db.close();
  });
});

// ── VERSION reads from package.json (fix #1) ──────────────────────────────────

describe('VERSION', () => {
  it('matches the version in package.json', () => {
    const pkgPath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it('is a semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ── findReminder ──────────────────────────────────────────────────────────────

describe('findReminder', () => {
  let db: Database.Database;

  beforeEach(() => {
    initDb(false, dbPath);
    db = getDb(dbPath);
  });

  afterEach(() => {
    db.close();
  });

  it('returns null for nonexistent ID', () => {
    const result = findReminder(db, 'nonexistent');
    expect(result).toBeNull();
  });

  it('finds by exact full ID', () => {
    db.prepare(
      "INSERT INTO reminders(id, content, trigger_type) VALUES ('abcd1234ef567890', 'test reminder', 'manual')",
    ).run();

    const result = findReminder(db, 'abcd1234ef567890');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('abcd1234ef567890');
    expect(result!.content).toBe('test reminder');
  });

  it('finds by prefix (first 4+ chars)', () => {
    db.prepare(
      "INSERT INTO reminders(id, content, trigger_type) VALUES ('abcd1234ef567890', 'test reminder', 'manual')",
    ).run();

    const result = findReminder(db, 'abcd');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('abcd1234ef567890');
  });

  it('throws on ambiguous prefix with 2+ matches', () => {
    db.prepare(
      "INSERT INTO reminders(id, content, trigger_type) VALUES ('abcd1111aaaaaaaa', 'first', 'manual')",
    ).run();
    db.prepare(
      "INSERT INTO reminders(id, content, trigger_type) VALUES ('abcd2222bbbbbbbb', 'second', 'manual')",
    ).run();

    expect(() => findReminder(db, 'abcd')).toThrow(/Ambiguous ID prefix/);
  });
});

// ── recordHistory ─────────────────────────────────────────────────────────────

describe('recordHistory', () => {
  let db: Database.Database;

  beforeEach(() => {
    initDb(false, dbPath);
    db = getDb(dbPath);
  });

  afterEach(() => {
    db.close();
  });

  it('records a history entry with all fields', () => {
    const oldData = { status: 'active' };
    const newData = { status: 'completed' };
    recordHistory(db, 'rem-001', 'update', oldData, newData, 'agent');

    const rows = db.prepare('SELECT * FROM history WHERE reminder_id = ?').all('rem-001') as {
      reminder_id: string;
      action: string;
      old_data: string | null;
      new_data: string | null;
      source: string | null;
    }[];

    expect(rows.length).toBe(1);
    expect(rows[0].reminder_id).toBe('rem-001');
    expect(rows[0].action).toBe('update');
    expect(rows[0].old_data).toBe(JSON.stringify(oldData));
    expect(rows[0].new_data).toBe(JSON.stringify(newData));
    expect(rows[0].source).toBe('agent');
  });

  it('records with null old/new data', () => {
    recordHistory(db, 'rem-002', 'create');

    const rows = db.prepare('SELECT * FROM history WHERE reminder_id = ?').all('rem-002') as {
      old_data: string | null;
      new_data: string | null;
      source: string | null;
    }[];

    expect(rows.length).toBe(1);
    expect(rows[0].old_data).toBeNull();
    expect(rows[0].new_data).toBeNull();
    expect(rows[0].source).toBeNull();
  });

  it('records with source', () => {
    recordHistory(db, 'rem-003', 'delete', null, null, 'user');

    const rows = db.prepare('SELECT * FROM history WHERE reminder_id = ?').all('rem-003') as {
      source: string | null;
    }[];

    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('user');
  });
});

// ── getHistoryEntries ─────────────────────────────────────────────────────────

describe('getHistoryEntries', () => {
  let db: Database.Database;

  beforeEach(() => {
    initDb(false, dbPath);
    db = getDb(dbPath);
    // Seed several history entries across different reminders
    recordHistory(db, 'rem-aaa', 'create', null, { content: 'first' }, 'agent');
    recordHistory(db, 'rem-aaa', 'update', { status: 'active' }, { status: 'snoozed' }, 'user');
    recordHistory(db, 'rem-bbb', 'create', null, { content: 'second' }, 'agent');
    recordHistory(db, 'rem-bbb', 'delete', { status: 'active' }, null, 'system');
    recordHistory(db, 'rem-ccc', 'create', null, { content: 'third' }, 'agent');
  });

  afterEach(() => {
    db.close();
  });

  it('returns entries for a specific reminder', () => {
    const entries = getHistoryEntries(db, 'rem-aaa');
    expect(entries.length).toBe(2);
    for (const e of entries) {
      expect(e.reminder_id).toBe('rem-aaa');
    }
  });

  it('returns all entries when no reminderId given', () => {
    const entries = getHistoryEntries(db);
    expect(entries.length).toBe(5);
  });

  it('respects the limit parameter', () => {
    const entries = getHistoryEntries(db, undefined, 2);
    expect(entries.length).toBe(2);
  });
});

// ── DB permission warning ─────────────────────────────────────────────────────

describe('getDb — permission warning', () => {
  let tmpDir2: string;
  let dbPath2: string;
  let origDir: string | undefined;
  let origDb: string | undefined;

  beforeEach(() => {
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrem-perm-test-'));
    dbPath2 = path.join(tmpDir2, 'reminders.db');
    origDir = process.env['AGENTREM_DIR'];
    origDb = process.env['AGENTREM_DB'];
    process.env['AGENTREM_DIR'] = tmpDir2;
    process.env['AGENTREM_DB'] = dbPath2;
    initDb(false, dbPath2);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origDir !== undefined) process.env['AGENTREM_DIR'] = origDir;
    else delete process.env['AGENTREM_DIR'];
    if (origDb !== undefined) process.env['AGENTREM_DB'] = origDb;
    else delete process.env['AGENTREM_DB'];
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  it('warns when DB file has world-readable permissions (e.g. 644)', () => {
    if (process.platform === 'win32') return; // skip on Windows

    // Set loose permissions on the DB file
    fs.chmodSync(dbPath2, 0o644);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const db = getDb(dbPath2);
    db.close();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('has loose permissions'),
    );
  });

  it('does not warn when DB file has strict permissions (e.g. 600)', () => {
    if (process.platform === 'win32') return; // skip on Windows

    // Set strict permissions on the DB file
    fs.chmodSync(dbPath2, 0o600);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const db = getDb(dbPath2);
    db.close();

    // Should not warn about permissions
    const permWarnings = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes('has loose permissions'),
    );
    expect(permWarnings).toHaveLength(0);
  });
});
