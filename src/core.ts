// ── Core Business Logic ───────────────────────────────────────────────────
// Pure functions that return data. No stdout, no process.exit.

import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SCHEMA_VERSION,
  PRIORITY_LABELS,
  VALID_TRIGGERS,
  AgentremError,
  type Reminder,
  type HistoryEntry,
  type KeywordConfig,
  type ConditionConfig,
  type RecurRule,
} from './types.js';
import { parseDate, dtToIso, truncate, parseRecur, nextRecurrence } from './date-parser.js';
import { findReminder, recordHistory } from './db.js';

// ── Add ───────────────────────────────────────────────────────────────────

export interface AddOptions {
  content: string;
  due?: string;
  trigger?: string;
  priority?: number;
  tags?: string;
  context?: string;
  category?: string;
  keywords?: string;
  match?: string;
  check?: string;
  expect?: string;
  decay?: string;
  maxFires?: number;
  recur?: string;
  agent?: string;
  dependsOn?: string;
  source?: string;
  dryRun?: boolean;
}

export function coreAdd(db: Database.Database, opts: AddOptions): Reminder {
  const content = opts.content;
  const trigger = opts.trigger || 'time';
  const priority = opts.priority || 3;

  if (priority < 1 || priority > 5) {
    throw new AgentremError('Priority must be 1-5');
  }
  if (!VALID_TRIGGERS.has(trigger)) {
    throw new AgentremError(
      `Invalid trigger type: '${trigger}'. Must be one of: ${[...VALID_TRIGGERS].sort().join(', ')}`,
    );
  }

  // Parse due date
  let triggerAt: string | null = null;
  if (opts.due) {
    triggerAt = dtToIso(parseDate(opts.due));
  }

  // Validation
  if (trigger === 'time' && !triggerAt) {
    throw new AgentremError('Time trigger requires --due / -d flag');
  }
  if (trigger === 'keyword' && !opts.keywords) {
    throw new AgentremError('Keyword trigger requires --keywords / -k flag');
  }
  if (trigger === 'condition' && (!opts.check || !opts.expect)) {
    throw new AgentremError(
      'Condition trigger requires both --check and --expect flags',
    );
  }

  // Build trigger_config
  let triggerConfig: string | null = null;
  if (trigger === 'keyword') {
    triggerConfig = JSON.stringify({
      keywords: opts.keywords!.split(',').map((k) => k.trim()),
      match: opts.match || 'any',
    });
  } else if (trigger === 'condition') {
    triggerConfig = JSON.stringify({
      check: opts.check,
      expect: opts.expect,
    });
  }

  // Parse decay
  let decayAt: string | null = null;
  if (opts.decay) {
    decayAt = dtToIso(parseDate(opts.decay));
  }

  // Parse recurrence
  let recurRule: string | null = null;
  if (opts.recur) {
    recurRule = JSON.stringify(parseRecur(opts.recur));
  }

  // Validate depends_on
  if (opts.dependsOn) {
    const dep = findReminder(db, opts.dependsOn);
    if (!dep) {
      throw new AgentremError(`Dependency not found: ${opts.dependsOn}. Run 'agentrem list' to see valid reminder IDs.`);
    }
  }

  const source = opts.source || 'agent';
  const agent = opts.agent || 'main';

  if (opts.dryRun) {
    // Return a fake reminder for dry run display
    return {
      id: 'dry-run',
      content,
      context: opts.context || null,
      trigger_type: trigger as Reminder['trigger_type'],
      trigger_at: triggerAt,
      trigger_config: triggerConfig,
      priority,
      tags: opts.tags || null,
      category: opts.category || null,
      status: 'active',
      snoozed_until: null,
      decay_at: decayAt,
      escalation: null,
      fire_count: 0,
      last_fired: null,
      max_fires: opts.maxFires ?? null,
      recur_rule: recurRule,
      recur_parent_id: null,
      depends_on: opts.dependsOn || null,
      related_ids: null,
      source,
      agent,
      created_at: dtToIso(new Date()),
      updated_at: dtToIso(new Date()),
      completed_at: null,
      notes: null,
    };
  }

  // Insert
  const info = db
    .prepare(
      `INSERT INTO reminders(content, context, trigger_type, trigger_at, trigger_config,
        priority, tags, category, decay_at, max_fires, recur_rule, depends_on,
        source, agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      content,
      opts.context || null,
      trigger,
      triggerAt,
      triggerConfig,
      priority,
      opts.tags || null,
      opts.category || null,
      decayAt,
      opts.maxFires ?? null,
      recurRule,
      opts.dependsOn || null,
      source,
      agent,
    );

  const rem = db
    .prepare('SELECT * FROM reminders WHERE rowid = ?')
    .get(info.lastInsertRowid) as Reminder;
  recordHistory(db, rem.id, 'created', null, rem as unknown as Record<string, unknown>, source);

  return rem;
}

// ── Check ─────────────────────────────────────────────────────────────────

export interface CheckOptions {
  type?: string;
  text?: string;
  budget?: number;
  format?: string;
  agent?: string;
  escalate?: boolean;
  dryRun?: boolean;
}

export interface CheckResult {
  included: Reminder[];
  overflowCounts: Record<number, number>;
  totalTriggered: number;
}

export function coreCheck(db: Database.Database, opts: CheckOptions): CheckResult {
  const now = new Date();
  const nowIso = dtToIso(now);
  const agent = opts.agent || 'main';
  const budget = (opts.budget || 800) * 4; // tokens -> chars
  const typesFilter = opts.type ? new Set(opts.type.split(',')) : null;

  // 1. Reactivate snoozed reminders whose snooze has expired
  db.prepare(
    "UPDATE reminders SET status='active', snoozed_until=NULL, updated_at=? " +
      "WHERE status='snoozed' AND snoozed_until <= ? AND agent=?",
  ).run(nowIso, nowIso, agent);

  // 2. Expire decayed reminders
  const expiredRows = db
    .prepare(
      "SELECT id FROM reminders WHERE decay_at <= ? AND status='active' AND agent=?",
    )
    .all(nowIso, agent) as { id: string }[];
  for (const row of expiredRows) {
    const rem = db.prepare('SELECT * FROM reminders WHERE id=?').get(row.id) as Reminder;
    db.prepare("UPDATE reminders SET status='expired', updated_at=? WHERE id=?").run(
      nowIso,
      row.id,
    );
    recordHistory(db, row.id, 'expired', rem as unknown as Record<string, unknown>, null, 'system');
  }

  // 3. Escalation
  if (opts.escalate) {
    const cutoff48h = dtToIso(new Date(now.getTime() - 48 * 3600 * 1000));
    db.prepare(
      "UPDATE reminders SET priority=2, updated_at=? " +
        "WHERE priority=3 AND trigger_type='time' AND trigger_at <= ? AND status='active' AND agent=?",
    ).run(nowIso, cutoff48h, agent);

    const cutoff24h = dtToIso(new Date(now.getTime() - 24 * 3600 * 1000));
    db.prepare(
      "UPDATE reminders SET priority=1, updated_at=? " +
        "WHERE priority=2 AND trigger_type='time' AND trigger_at <= ? AND status='active' AND agent=?",
    ).run(nowIso, cutoff24h, agent);
  }

  // 4. Gather triggered reminders
  const triggered: Reminder[] = [];

  // Get all completed IDs for dependency checking
  const completedIds = new Set(
    (
      db
        .prepare("SELECT id FROM reminders WHERE status='completed'")
        .all() as { id: string }[]
    ).map((r) => r.id),
  );

  function checkDependency(rem: Reminder): boolean {
    if (!rem.depends_on) return true;
    return completedIds.has(rem.depends_on);
  }

  // Time triggers
  if (!typesFilter || typesFilter.has('time')) {
    const rows = db
      .prepare(
        "SELECT * FROM reminders WHERE trigger_type='time' AND trigger_at <= ? " +
          "AND status='active' AND agent=?",
      )
      .all(nowIso, agent) as Reminder[];
    for (const rem of rows) {
      if (checkDependency(rem)) {
        triggered.push(rem);
      }
    }
  }

  // Keyword triggers
  if ((!typesFilter || typesFilter.has('keyword')) && opts.text) {
    const rows = db
      .prepare(
        "SELECT * FROM reminders WHERE trigger_type='keyword' AND status='active' AND agent=?",
      )
      .all(agent) as Reminder[];
    const textLower = opts.text.toLowerCase();
    for (const rem of rows) {
      if (!checkDependency(rem)) continue;
      const config: KeywordConfig = JSON.parse(rem.trigger_config || '{}');
      const keywords = config.keywords || [];
      const matchMode = config.match || 'any';
      if (matchMode === 'any') {
        if (keywords.some((kw) => textLower.includes(kw.toLowerCase()))) {
          triggered.push(rem);
        }
      } else if (matchMode === 'all') {
        if (keywords.every((kw) => textLower.includes(kw.toLowerCase()))) {
          triggered.push(rem);
        }
      } else if (matchMode === 'regex') {
        for (const kw of keywords) {
          try {
            if (new RegExp(kw, 'i').test(opts.text)) {
              triggered.push(rem);
              break;
            }
          } catch {
            // Invalid regex, skip
          }
        }
      }
    }
  }

  // Condition triggers
  if (!typesFilter || typesFilter.has('condition')) {
    const rows = db
      .prepare(
        "SELECT * FROM reminders WHERE trigger_type='condition' AND status='active' AND agent=?",
      )
      .all(agent) as Reminder[];
    for (const rem of rows) {
      if (!checkDependency(rem)) continue;
      const config: ConditionConfig = JSON.parse(rem.trigger_config || '{}');
      try {
        // Use execFileSync with shell for condition checks (user-defined commands)
        const result = execFileSync('/bin/sh', ['-c', config.check], {
          timeout: 10000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (result === config.expect) {
          triggered.push(rem);
        }
      } catch {
        // Command failed or timed out
      }
    }
  }

  // Session triggers
  if (!typesFilter || typesFilter.has('session')) {
    const rows = db
      .prepare(
        "SELECT * FROM reminders WHERE trigger_type='session' AND status='active' AND agent=?",
      )
      .all(agent) as Reminder[];
    for (const rem of rows) {
      if (checkDependency(rem)) {
        triggered.push(rem);
      }
    }
  }

  // Heartbeat triggers
  if (!typesFilter || typesFilter.has('heartbeat')) {
    const rows = db
      .prepare(
        "SELECT * FROM reminders WHERE trigger_type='heartbeat' AND status='active' AND agent=?",
      )
      .all(agent) as Reminder[];
    for (const rem of rows) {
      if (checkDependency(rem)) {
        triggered.push(rem);
      }
    }
  }

  // Manual triggers are never auto-injected

  if (triggered.length === 0) {
    return { included: [], overflowCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, totalTriggered: 0 };
  }

  // Sort by priority
  triggered.sort((a, b) => a.priority - b.priority);

  // Deduplicate by ID
  const seen = new Set<string>();
  const deduped: Reminder[] = [];
  for (const rem of triggered) {
    if (!seen.has(rem.id)) {
      seen.add(rem.id);
      deduped.push(rem);
    }
  }

  // Budget system
  const charLimits: Record<number, number> = { 1: 200, 2: 100, 3: 60, 4: 0, 5: 0 };
  let used = 0;
  const included: Reminder[] = [];
  const overflowCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  for (const rem of deduped) {
    const p = rem.priority;
    if (p === 5) continue;
    if (p === 4) {
      overflowCounts[4]++;
      continue;
    }

    const limit = charLimits[p];
    const contentText = truncate(rem.content, limit);
    const entrySize = contentText.length + 30;

    if (p === 1) {
      included.push(rem);
      used += entrySize;
    } else if (p === 2) {
      if (used + entrySize <= budget * 0.6) {
        included.push(rem);
        used += entrySize;
      } else {
        overflowCounts[2]++;
      }
    } else if (p === 3) {
      if (used + entrySize <= budget * 0.85) {
        included.push(rem);
        used += entrySize;
      } else {
        overflowCounts[3]++;
      }
    }
  }

  // Update fire counts (unless dry run)
  if (!opts.dryRun) {
    for (const rem of included) {
      const newFire = (rem.fire_count || 0) + 1;
      db.prepare(
        'UPDATE reminders SET fire_count=?, last_fired=?, updated_at=? WHERE id=?',
      ).run(newFire, nowIso, nowIso, rem.id);

      if (rem.max_fires && newFire >= rem.max_fires) {
        const old = { ...rem };
        db.prepare(
          "UPDATE reminders SET status='completed', completed_at=?, updated_at=? WHERE id=?",
        ).run(nowIso, nowIso, rem.id);
        const remAfter = db
          .prepare('SELECT * FROM reminders WHERE id=?')
          .get(rem.id) as Reminder;
        recordHistory(
          db,
          rem.id,
          'completed',
          old as unknown as Record<string, unknown>,
          remAfter as unknown as Record<string, unknown>,
          'system',
        );
      }
    }
  }

  return { included, overflowCounts, totalTriggered: deduped.length };
}

// ── List ──────────────────────────────────────────────────────────────────

export interface ListOptions {
  status?: string;
  priority?: string;
  tag?: string;
  trigger?: string;
  due?: string;
  agent?: string;
  category?: string;
  limit?: number;
  all?: boolean;
}

export function coreList(db: Database.Database, opts: ListOptions): Reminder[] {
  const agent = opts.agent || 'main';
  const limit = opts.limit || 20;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.all) {
    // no status filter
  } else if (opts.status) {
    const statuses = opts.status.split(',').map((s) => s.trim());
    conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  } else {
    conditions.push("status = 'active'");
  }

  conditions.push('agent = ?');
  params.push(agent);

  if (opts.priority) {
    const prios = opts.priority.split(',').map((p) => parseInt(p.trim(), 10));
    conditions.push(`priority IN (${prios.map(() => '?').join(',')})`);
    params.push(...prios);
  }

  if (opts.tag) {
    conditions.push('tags LIKE ?');
    params.push(`%${opts.tag}%`);
  }

  if (opts.trigger) {
    conditions.push('trigger_type = ?');
    params.push(opts.trigger);
  }

  if (opts.category) {
    conditions.push('category = ?');
    params.push(opts.category);
  }

  if (opts.due) {
    const now = new Date();
    const d = opts.due.toLowerCase();
    if (d === 'today') {
      const eod = new Date(now);
      eod.setHours(23, 59, 59, 0);
      conditions.push("trigger_at <= ? AND trigger_type='time'");
      params.push(dtToIso(eod));
    } else if (d === 'tomorrow') {
      const tmrw = new Date(now);
      tmrw.setDate(tmrw.getDate() + 1);
      tmrw.setHours(23, 59, 59, 0);
      conditions.push("trigger_at <= ? AND trigger_type='time'");
      params.push(dtToIso(tmrw));
    } else if (d === 'overdue') {
      conditions.push("trigger_at <= ? AND trigger_type='time'");
      params.push(dtToIso(now));
    } else if (d === 'week') {
      const eow = new Date(now);
      eow.setDate(eow.getDate() + 7);
      eow.setHours(23, 59, 59, 0);
      conditions.push("trigger_at <= ? AND trigger_type='time'");
      params.push(dtToIso(eow));
    } else {
      const dt = parseDate(d);
      conditions.push('DATE(trigger_at) = DATE(?)');
      params.push(dtToIso(dt));
    }
  }

  const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1';
  const query = `SELECT * FROM reminders WHERE ${where} ORDER BY priority, trigger_at LIMIT ?`;
  params.push(limit);

  return db.prepare(query).all(...params) as Reminder[];
}

// ── Search ────────────────────────────────────────────────────────────────

export interface SearchOptions {
  query: string;
  status?: string;
  limit?: number;
}

export function coreSearch(db: Database.Database, opts: SearchOptions): Reminder[] {
  const limit = opts.limit || 10;
  const statuses = opts.status ? opts.status.split(',').map((s) => s.trim()) : ['active'];

  const placeholders = statuses.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT r.* FROM reminders_fts f
       JOIN reminders r ON r.rowid = f.rowid
       WHERE reminders_fts MATCH ? AND r.status IN (${placeholders})
       ORDER BY rank LIMIT ?`,
    )
    .all(opts.query, ...statuses, limit) as Reminder[];
}

// ── Complete ──────────────────────────────────────────────────────────────

export interface CompleteResult {
  completed: Reminder;
  nextRecurrence: Reminder | null;
}

export function coreComplete(
  db: Database.Database,
  id: string,
  notes?: string,
): CompleteResult {
  const rem = findReminder(db, id);
  if (!rem) {
    throw new AgentremError(`Reminder not found: ${id}. Run 'agentrem list' to see active reminders.`);
  }

  const nowIso = dtToIso(new Date());
  const oldData = { ...rem };
  let nextRem: Reminder | null = null;

  // Check for recurrence
  if (rem.recur_rule) {
    const rule: RecurRule = JSON.parse(rem.recur_rule);
    const nextDt = nextRecurrence(rem.trigger_at, rule);
    const info = db
      .prepare(
        `INSERT INTO reminders(content, context, trigger_type, trigger_at, trigger_config,
          priority, tags, category, decay_at, max_fires, recur_rule, recur_parent_id,
          depends_on, source, agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rem.content,
        rem.context,
        rem.trigger_type,
        dtToIso(nextDt),
        rem.trigger_config,
        rem.priority,
        rem.tags,
        rem.category,
        rem.decay_at,
        rem.max_fires,
        rem.recur_rule,
        rem.recur_parent_id || rem.id,
        rem.depends_on,
        rem.source,
        rem.agent,
      );
    nextRem = db
      .prepare('SELECT * FROM reminders WHERE rowid = ?')
      .get(info.lastInsertRowid) as Reminder;
    recordHistory(db, nextRem.id, 'created', null, nextRem as unknown as Record<string, unknown>, 'system');
  }

  // Complete the current one
  let finalNotes = notes || null;
  if (notes && rem.notes) {
    finalNotes = rem.notes + '\n' + notes;
  } else if (!notes) {
    finalNotes = rem.notes;
  }

  db.prepare(
    "UPDATE reminders SET status='completed', completed_at=?, updated_at=?, notes=? WHERE id=?",
  ).run(nowIso, nowIso, finalNotes, rem.id);

  const newData = db.prepare('SELECT * FROM reminders WHERE id=?').get(rem.id) as Reminder;
  recordHistory(
    db,
    rem.id,
    'completed',
    oldData as unknown as Record<string, unknown>,
    newData as unknown as Record<string, unknown>,
    'agent',
  );

  return { completed: newData, nextRecurrence: nextRem };
}

// ── Snooze ────────────────────────────────────────────────────────────────

export function coreSnooze(
  db: Database.Database,
  id: string,
  until?: string,
  forDuration?: string,
): Reminder {
  const rem = findReminder(db, id);
  if (!rem) {
    throw new AgentremError(`Reminder not found: ${id}. Run 'agentrem list' to see active reminders.`);
  }

  if (!until && !forDuration) {
    throw new AgentremError('Snooze requires --until or --for. Example: agentrem snooze <id> --for 2h');
  }

  let snoozeDt: Date;
  if (until) {
    snoozeDt = parseDate(until);
  } else {
    // Parse duration like "1h", "2h", "1d", "3d", "1w"
    try {
      snoozeDt = parseDate(`+${forDuration}`);
    } catch {
      const m = /^(\d+)([mhdw])$/i.exec(forDuration!);
      if (!m) {
        throw new AgentremError(`Cannot parse duration: '${forDuration}'`);
      }
      const n = parseInt(m[1], 10);
      const u = m[2].toLowerCase();
      snoozeDt = new Date();
      if (u === 'm') snoozeDt.setMinutes(snoozeDt.getMinutes() + n);
      else if (u === 'h') snoozeDt.setHours(snoozeDt.getHours() + n);
      else if (u === 'd') snoozeDt.setDate(snoozeDt.getDate() + n);
      else if (u === 'w') snoozeDt.setDate(snoozeDt.getDate() + n * 7);
    }
  }

  const nowIso = dtToIso(new Date());
  const oldData = { ...rem };

  db.prepare(
    "UPDATE reminders SET status='snoozed', snoozed_until=?, updated_at=? WHERE id=?",
  ).run(dtToIso(snoozeDt), nowIso, rem.id);

  const newData = db.prepare('SELECT * FROM reminders WHERE id=?').get(rem.id) as Reminder;
  recordHistory(
    db,
    rem.id,
    'snoozed',
    oldData as unknown as Record<string, unknown>,
    newData as unknown as Record<string, unknown>,
    'agent',
  );

  return newData;
}

// ── Edit ──────────────────────────────────────────────────────────────────

export interface EditOptions {
  content?: string;
  context?: string;
  priority?: number;
  due?: string;
  tags?: string;
  addTags?: string;
  removeTags?: string;
  category?: string;
  decay?: string;
  maxFires?: number;
  keywords?: string;
  agent?: string;
}

export function coreEdit(
  db: Database.Database,
  id: string,
  opts: EditOptions,
): Reminder {
  const rem = findReminder(db, id);
  if (!rem) {
    throw new AgentremError(`Reminder not found: ${id}. Run 'agentrem list' to see active reminders.`);
  }

  const oldData = { ...rem };
  const nowIso = dtToIso(new Date());
  const updates: Record<string, string | number | null> = {};

  if (opts.content !== undefined) updates['content'] = opts.content;
  if (opts.context !== undefined) updates['context'] = opts.context;
  if (opts.priority !== undefined) {
    if (opts.priority < 1 || opts.priority > 5) {
      throw new AgentremError('Priority must be 1-5');
    }
    updates['priority'] = opts.priority;
  }
  if (opts.due !== undefined) {
    updates['trigger_at'] = dtToIso(parseDate(opts.due));
  }
  if (opts.tags !== undefined) {
    updates['tags'] = opts.tags;
  }
  if (opts.addTags) {
    const existing = new Set(
      (rem.tags || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    );
    const newTags = opts.addTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    for (const t of newTags) existing.add(t);
    updates['tags'] = [...existing].sort().join(',');
  }
  if (opts.removeTags) {
    const existing = new Set(
      (rem.tags || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    );
    const rmTags = opts.removeTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    for (const t of rmTags) existing.delete(t);
    updates['tags'] = [...existing].sort().join(',');
  }
  if (opts.category !== undefined) updates['category'] = opts.category;
  if (opts.decay !== undefined) {
    updates['decay_at'] = dtToIso(parseDate(opts.decay));
  }
  if (opts.maxFires !== undefined) updates['max_fires'] = opts.maxFires;
  if (opts.keywords !== undefined) {
    const config: KeywordConfig = JSON.parse(rem.trigger_config || '{}');
    config.keywords = opts.keywords.split(',').map((k) => k.trim());
    updates['trigger_config'] = JSON.stringify(config);
  }
  if (opts.agent !== undefined) updates['agent'] = opts.agent;

  if (Object.keys(updates).length === 0) {
    throw new AgentremError(
      'No changes specified. Use --content, --priority, --due, --tags, etc.',
    );
  }

  updates['updated_at'] = nowIso;
  const setClause = Object.keys(updates)
    .map((k) => `${k}=?`)
    .join(', ');
  const values = [...Object.values(updates), rem.id];

  db.prepare(`UPDATE reminders SET ${setClause} WHERE id=?`).run(...values);

  const newData = db.prepare('SELECT * FROM reminders WHERE id=?').get(rem.id) as Reminder;
  recordHistory(
    db,
    rem.id,
    'updated',
    oldData as unknown as Record<string, unknown>,
    newData as unknown as Record<string, unknown>,
    'agent',
  );

  return newData;
}

// ── Delete ────────────────────────────────────────────────────────────────

export interface DeleteOptions {
  id?: string;
  permanent?: boolean;
  status?: string;
  olderThan?: string;
}

export interface DeleteResult {
  count: number;
  permanent: boolean;
}

export function coreDelete(db: Database.Database, opts: DeleteOptions): DeleteResult {
  const nowIso = dtToIso(new Date());

  // Bulk delete by status
  if (opts.status) {
    const conditions = ['status = ?'];
    const params: (string | number)[] = [opts.status];

    if (opts.olderThan) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - parseInt(opts.olderThan, 10));
      conditions.push('updated_at <= ?');
      params.push(dtToIso(cutoff));
    }

    const where = conditions.join(' AND ');
    const countRow = db
      .prepare(`SELECT COUNT(*) as c FROM reminders WHERE ${where}`)
      .get(...params) as { c: number };
    const count = countRow.c;

    if (opts.permanent) {
      db.prepare(`DELETE FROM reminders WHERE ${where}`).run(...params);
    } else {
      db.prepare(
        `UPDATE reminders SET status='deleted', updated_at=? WHERE ${where}`,
      ).run(nowIso, ...params);
    }

    return { count, permanent: !!opts.permanent };
  }

  if (!opts.id) {
    throw new AgentremError('Reminder ID required. Usage: agentrem delete <id> or agentrem delete --status expired for bulk delete.');
  }

  const rem = findReminder(db, opts.id);
  if (!rem) {
    throw new AgentremError(`Reminder not found: ${opts.id}. Run 'agentrem list --all' to see all reminders.`);
  }

  const oldData = { ...rem };

  if (opts.permanent) {
    db.prepare('DELETE FROM reminders WHERE id=?').run(rem.id);
    recordHistory(db, rem.id, 'deleted', oldData as unknown as Record<string, unknown>, null, 'agent');
  } else {
    db.prepare(
      "UPDATE reminders SET status='deleted', updated_at=? WHERE id=?",
    ).run(nowIso, rem.id);
    const newData = db.prepare('SELECT * FROM reminders WHERE id=?').get(rem.id) as Reminder;
    recordHistory(
      db,
      rem.id,
      'deleted',
      oldData as unknown as Record<string, unknown>,
      newData as unknown as Record<string, unknown>,
      'agent',
    );
  }

  return { count: 1, permanent: !!opts.permanent };
}

// ── Stats ─────────────────────────────────────────────────────────────────

export interface StatsResult {
  totalActive: number;
  byPriority: { priority: number; count: number; label: string }[];
  overdue: number;
  snoozed: number;
  completedWeek: number;
  expired: number;
  byTrigger: { type: string; count: number }[];
  nextDue: { content: string; triggerAt: string } | null;
  lastCreated: string | null;
  dbSizeBytes: number;
}

export function coreStats(db: Database.Database): StatsResult {
  const nowIso = dtToIso(new Date());

  const active = db
    .prepare(
      "SELECT priority, COUNT(*) as cnt FROM reminders WHERE status='active' GROUP BY priority ORDER BY priority",
    )
    .all() as { priority: number; cnt: number }[];
  const totalActive = active.reduce((sum, r) => sum + r.cnt, 0);
  const byPriority = active.map((r) => ({
    priority: r.priority,
    count: r.cnt,
    label:
      ({ 1: 'critical', 2: 'high', 3: 'normal', 4: 'low', 5: 'someday' } as Record<number, string>)[
        r.priority
      ] || `p${r.priority}`,
  }));

  const overdueRow = db
    .prepare(
      "SELECT COUNT(*) as c FROM reminders WHERE trigger_type='time' AND trigger_at <= ? AND status='active'",
    )
    .get(nowIso) as { c: number };

  const snoozedRow = db
    .prepare("SELECT COUNT(*) as c FROM reminders WHERE status='snoozed'")
    .get() as { c: number };

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const completedWeekRow = db
    .prepare(
      "SELECT COUNT(*) as c FROM reminders WHERE status='completed' AND completed_at >= ?",
    )
    .get(dtToIso(weekAgo)) as { c: number };

  const expiredRow = db
    .prepare("SELECT COUNT(*) as c FROM reminders WHERE status='expired'")
    .get() as { c: number };

  const triggers = db
    .prepare(
      "SELECT trigger_type, COUNT(*) as cnt FROM reminders WHERE status='active' GROUP BY trigger_type ORDER BY cnt DESC",
    )
    .all() as { trigger_type: string; cnt: number }[];
  const byTrigger = triggers.map((r) => ({ type: r.trigger_type, count: r.cnt }));

  const nextDueRow = db
    .prepare(
      "SELECT content, trigger_at FROM reminders WHERE trigger_type='time' AND trigger_at > ? AND status='active' ORDER BY trigger_at LIMIT 1",
    )
    .get(nowIso) as { content: string; trigger_at: string } | undefined;

  const lastRow = db
    .prepare('SELECT created_at FROM reminders ORDER BY created_at DESC LIMIT 1')
    .get() as { created_at: string } | undefined;

  // DB size
  let dbSizeBytes = 0;
  try {
    const dbPath =
      process.env['AGENTREM_DB'] ||
      path.join(
        process.env['AGENTREM_DIR'] || path.join(os.homedir(), '.agentrem'),
        'reminders.db',
      );
    if (fs.existsSync(dbPath)) {
      dbSizeBytes = fs.statSync(dbPath).size;
    }
  } catch {
    // ignore
  }

  return {
    totalActive,
    byPriority,
    overdue: overdueRow.c,
    snoozed: snoozedRow.c,
    completedWeek: completedWeekRow.c,
    expired: expiredRow.c,
    byTrigger,
    nextDue: nextDueRow
      ? { content: nextDueRow.content, triggerAt: nextDueRow.trigger_at }
      : null,
    lastCreated: lastRow?.created_at || null,
    dbSizeBytes,
  };
}

// ── GC ────────────────────────────────────────────────────────────────────

export interface GcResult {
  count: number;
  reminders: { id: string; status: string; content: string }[];
}

export function coreGc(
  db: Database.Database,
  olderThan: number = 30,
  dryRun: boolean = false,
): GcResult {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThan);
  const cutoffIso = dtToIso(cutoff);

  const rows = db
    .prepare(
      "SELECT id, status, content FROM reminders WHERE status IN ('completed', 'expired', 'deleted') AND updated_at <= ?",
    )
    .all(cutoffIso) as { id: string; status: string; content: string }[];

  if (rows.length === 0 || dryRun) {
    return { count: rows.length, reminders: rows };
  }

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM reminders WHERE id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM history WHERE reminder_id IN (${placeholders})`).run(
    ...ids,
  );
  db.exec('VACUUM');

  return { count: rows.length, reminders: rows };
}

// ── History ───────────────────────────────────────────────────────────────

export function coreHistory(
  db: Database.Database,
  id?: string,
  limit: number = 20,
): HistoryEntry[] {
  if (id) {
    // Try to resolve the reminder ID first
    const rem = findReminder(db, id);
    const rid = rem ? rem.id : id;
    return db
      .prepare(
        'SELECT * FROM history WHERE reminder_id = ? OR reminder_id LIKE ? ORDER BY timestamp DESC LIMIT ?',
      )
      .all(rid, rid + '%', limit) as HistoryEntry[];
  }
  return db
    .prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT ?')
    .all(limit) as HistoryEntry[];
}

// ── Undo ──────────────────────────────────────────────────────────────────

export function coreUndo(db: Database.Database, historyId: number): void {
  const hist = db
    .prepare('SELECT * FROM history WHERE id = ?')
    .get(historyId) as HistoryEntry | undefined;
  if (!hist) {
    throw new AgentremError(`History entry not found: ${historyId}. Run 'agentrem history' to see valid entries.`);
  }

  if (hist.action === 'created') {
    throw new AgentremError(
      'Cannot undo creation — use `agentrem delete` instead',
    );
  }

  if (!hist.old_data) {
    throw new AgentremError('No old data to restore');
  }

  const old = JSON.parse(hist.old_data) as Record<string, unknown>;
  const rem = findReminder(db, hist.reminder_id);

  if (!rem) {
    // Reminder might have been permanently deleted — recreate
    const cols = Object.keys(old);
    const placeholders = cols.map(() => '?').join(',');
    const colNames = cols.join(',');
    db.prepare(`INSERT INTO reminders(${colNames}) VALUES (${placeholders})`).run(
      ...cols.map((c) => old[c] as string | number | null),
    );
  } else {
    // Update to old state
    const nowIso = dtToIso(new Date());
    old['updated_at'] = nowIso;
    const setClause = Object.keys(old)
      .filter((k) => k !== 'id')
      .map((k) => `${k}=?`)
      .join(', ');
    const values = Object.keys(old)
      .filter((k) => k !== 'id')
      .map((k) => old[k] as string | number | null);
    values.push(hist.reminder_id);
    db.prepare(`UPDATE reminders SET ${setClause} WHERE id=?`).run(...values);
  }

  recordHistory(
    db,
    hist.reminder_id,
    'reverted',
    rem as unknown as Record<string, unknown> | null,
    old,
    'agent',
  );
}

// ── Export ─────────────────────────────────────────────────────────────────

export interface ExportData {
  exported_at: string;
  schema_version: number;
  reminder_count: number;
  reminders: Record<string, unknown>[];
  history: Record<string, unknown>[];
}

export function coreExport(db: Database.Database, status?: string): ExportData {
  const conditions: string[] = [];
  const params: string[] = [];

  if (status) {
    const statuses = status.split(',').map((s) => s.trim());
    conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const reminders = db
    .prepare(`SELECT * FROM reminders ${where}`)
    .all(...params) as Record<string, unknown>[];

  const allHistory: Record<string, unknown>[] = [];
  for (const rem of reminders) {
    const h = db
      .prepare('SELECT * FROM history WHERE reminder_id = ?')
      .all(rem['id'] as string) as Record<string, unknown>[];
    allHistory.push(...h);
  }

  return {
    exported_at: dtToIso(new Date()),
    schema_version: SCHEMA_VERSION,
    reminder_count: reminders.length,
    reminders,
    history: allHistory,
  };
}

// ── Import ────────────────────────────────────────────────────────────────

export interface ImportResult {
  imported: number;
  skipped: number;
  historyImported: number;
}

export function coreImport(
  db: Database.Database,
  data: ExportData,
  merge: boolean = false,
  replace: boolean = false,
  dryRun: boolean = false,
): ImportResult {
  const reminders = data.reminders || [];
  const history = data.history || [];

  if (dryRun) {
    return {
      imported: reminders.length,
      skipped: 0,
      historyImported: history.length,
    };
  }

  if (replace) {
    db.prepare('DELETE FROM reminders').run();
    db.prepare('DELETE FROM history').run();
  }

  let imported = 0;
  let skipped = 0;

  for (const rem of reminders) {
    if (merge) {
      const existing = db
        .prepare('SELECT id FROM reminders WHERE id = ?')
        .get(rem['id'] as string);
      if (existing) {
        skipped++;
        continue;
      }
    }

    const cols = Object.keys(rem);
    const placeholders = cols.map(() => '?').join(',');
    const colNames = cols.join(',');
    try {
      db.prepare(`INSERT INTO reminders(${colNames}) VALUES (${placeholders})`).run(
        ...cols.map((c) => rem[c] as string | number | null),
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  let historyImported = 0;
  for (const h of history) {
    try {
      db.prepare(
        'INSERT INTO history(reminder_id, action, old_data, new_data, timestamp, source) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        h['reminder_id'] as string,
        h['action'] as string,
        (h['old_data'] as string) || null,
        (h['new_data'] as string) || null,
        h['timestamp'] as string,
        (h['source'] as string) || null,
      );
      historyImported++;
    } catch {
      // skip
    }
  }

  return { imported, skipped, historyImported };
}

// ── Schema ────────────────────────────────────────────────────────────────

export function coreSchema(db: Database.Database): string[] {
  const rows = db
    .prepare(
      'SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name',
    )
    .all() as { sql: string }[];
  return rows.map((r) => r.sql);
}
