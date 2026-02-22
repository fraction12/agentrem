// ── Database Layer ─────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SCHEMA_VERSION, type Reminder, type HistoryEntry } from './types.js';

function getDefaultDir(): string {
  return process.env['AGENTREM_DIR'] || path.join(os.homedir(), '.agentrem');
}

function getDefaultDbPath(): string {
  return (
    process.env['AGENTREM_DB'] || path.join(getDefaultDir(), 'reminders.db')
  );
}

export function getDb(dbPath?: string): Database.Database {
  const p = dbPath || getDefaultDbPath();
  if (!fs.existsSync(p)) {
    // Auto-initialize on first use so `agentrem check` works without `agentrem init`
    initDb(false, p);
  }
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function initDb(force: boolean = false, dbPath?: string): string {
  const dir = process.env['AGENTREM_DIR'] || path.join(os.homedir(), '.agentrem');
  const p = dbPath || getDefaultDbPath();

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (fs.existsSync(p)) {
    if (force) {
      const ts = new Date()
        .toISOString()
        .replace(/[:.]/g, '')
        .slice(0, 15)
        .replace('T', '-');
      const backup = p.replace('reminders.db', `reminders.db.bak.${ts}`);
      fs.copyFileSync(p, backup);
      fs.unlinkSync(p);
      const result = createDb(p);
      return `Backed up existing DB to ${backup}\n${result}`;
    } else {
      // Check schema version
      try {
        const db = new Database(p);
        const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as
          | { v: number }
          | undefined;
        db.close();
        if (row && row.v >= SCHEMA_VERSION) {
          return `\u2705 Database already initialized at ${p} (schema v${row.v})`;
        }
      } catch {
        // Fall through to create
      }
      return createDb(p);
    }
  }

  return createDb(p);
}

function createDb(p: string): string {
  const db = new Database(p);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      content         TEXT NOT NULL,
      context         TEXT,
      trigger_type    TEXT NOT NULL DEFAULT 'time',
      trigger_at      TEXT,
      trigger_config  TEXT,
      priority        INTEGER NOT NULL DEFAULT 3,
      tags            TEXT,
      category        TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      snoozed_until   TEXT,
      decay_at        TEXT,
      escalation      TEXT,
      fire_count      INTEGER DEFAULT 0,
      last_fired      TEXT,
      max_fires       INTEGER,
      recur_rule      TEXT,
      recur_parent_id TEXT,
      depends_on      TEXT,
      related_ids     TEXT,
      source          TEXT DEFAULT 'agent',
      agent           TEXT DEFAULT 'main',
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
      completed_at    TEXT,
      notes           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rem_status ON reminders(status);
    CREATE INDEX IF NOT EXISTS idx_rem_trigger ON reminders(trigger_type, status);
    CREATE INDEX IF NOT EXISTS idx_rem_due ON reminders(trigger_at) WHERE trigger_type = 'time' AND status = 'active';
    CREATE INDEX IF NOT EXISTS idx_rem_priority ON reminders(priority) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_rem_agent ON reminders(agent);
    CREATE INDEX IF NOT EXISTS idx_rem_tags ON reminders(tags);

    CREATE TABLE IF NOT EXISTS history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id TEXT NOT NULL,
      action      TEXT NOT NULL,
      old_data    TEXT,
      new_data    TEXT,
      timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
      source      TEXT
    );

    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  `);

  // FTS5 table
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS reminders_fts USING fts5(
        content, context, tags, notes,
        content=reminders, content_rowid=rowid
      )
    `);
  } catch {
    // Already exists
  }

  // FTS sync triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS reminders_ai AFTER INSERT ON reminders BEGIN
      INSERT INTO reminders_fts(rowid, content, context, tags, notes)
      VALUES (new.rowid, new.content, new.context, new.tags, new.notes);
    END;

    CREATE TRIGGER IF NOT EXISTS reminders_ad AFTER DELETE ON reminders BEGIN
      INSERT INTO reminders_fts(reminders_fts, rowid, content, context, tags, notes)
      VALUES ('delete', old.rowid, old.content, old.context, old.tags, old.notes);
    END;

    CREATE TRIGGER IF NOT EXISTS reminders_au AFTER UPDATE ON reminders BEGIN
      INSERT INTO reminders_fts(reminders_fts, rowid, content, context, tags, notes)
      VALUES ('delete', old.rowid, old.content, old.context, old.tags, old.notes);
      INSERT INTO reminders_fts(rowid, content, context, tags, notes)
      VALUES (new.rowid, new.content, new.context, new.tags, new.notes);
    END;
  `);

  db.prepare('INSERT OR REPLACE INTO schema_version(version) VALUES (?)').run(
    SCHEMA_VERSION,
  );

  db.close();
  return `\u2705 Initialized agentrem database at ${p} (schema v${SCHEMA_VERSION})`;
}

// ── Helpers ──────────────────────────────────────────────────────────────

export function findReminder(
  db: Database.Database,
  rid: string,
): Reminder | null {
  const row = db
    .prepare('SELECT * FROM reminders WHERE id = ?')
    .get(rid) as Reminder | undefined;
  if (row) return row;

  // Try prefix match
  const rows = db
    .prepare('SELECT * FROM reminders WHERE id LIKE ?')
    .all(rid + '%') as Reminder[];
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) {
    throw new Error(
      `Ambiguous ID prefix '${rid}' matches ${rows.length} reminders. Use more characters.`,
    );
  }
  return null;
}

export function recordHistory(
  db: Database.Database,
  reminderId: string,
  action: string,
  oldData?: Record<string, unknown> | null,
  newData?: Record<string, unknown> | null,
  source?: string | null,
): void {
  db.prepare(
    'INSERT INTO history(reminder_id, action, old_data, new_data, source) VALUES (?, ?, ?, ?, ?)',
  ).run(
    reminderId,
    action,
    oldData ? JSON.stringify(oldData) : null,
    newData ? JSON.stringify(newData) : null,
    source || null,
  );
}

export function getHistoryEntries(
  db: Database.Database,
  reminderId?: string,
  limit: number = 20,
): HistoryEntry[] {
  if (reminderId) {
    return db
      .prepare(
        'SELECT * FROM history WHERE reminder_id = ? OR reminder_id LIKE ? ORDER BY timestamp DESC LIMIT ?',
      )
      .all(reminderId, reminderId + '%', limit) as HistoryEntry[];
  }
  return db
    .prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT ?')
    .all(limit) as HistoryEntry[];
}
