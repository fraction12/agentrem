#!/usr/bin/env node
// ── CLI Entry Point ───────────────────────────────────────────────────────

import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VERSION, PRIORITY_LABELS, AgentremError } from './types.js';
import { initDb, getDb } from './db.js';
import { fmtDt, truncate, dtToIso } from './date-parser.js';
import { startWatch, resolveOnFirePreset } from './watch.js';
import { checkWatch, fmtWatchReminder } from './check-watch.js';
import { installService, uninstallService, getServiceStatus } from './service.js';
import {
  coreAdd,
  coreCheck,
  coreList,
  coreSearch,
  coreComplete,
  coreSnooze,
  coreEdit,
  coreDelete,
  coreStats,
  coreGc,
  coreHistory,
  coreUndo,
  coreExport,
  coreImport,
  coreSchema,
  type ExportData,
} from './core.js';

const program = new Command();

program
  .name('agentrem')
  .description('Structured reminders CLI for AI agents')
  .version(VERSION);

// ── init ──────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize database')
  .option('--force', 'Force recreate (backs up existing)')
  .action((opts) => {
    const msg = initDb(opts.force);
    console.log(msg);
  });

// ── add ───────────────────────────────────────────────────────────────────

program
  .command('add')
  .description('Add a reminder')
  .argument('<content>', 'Reminder text')
  .option('--due, -d <datetime>', 'Due datetime')
  .option('--trigger, -t <type>', 'Trigger type')
  .option('--priority, -p <n>', 'Priority 1-5', parseInt)
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--context, -c <ctx>', 'Context string')
  .option('--category <cat>', 'Category')
  .option('--keywords <kw>', 'Keywords for keyword trigger')
  .option('--keyword <kw>', 'Alias for --keywords')
  .option('--match <mode>', 'Keyword match mode: any|all|regex')
  .option('--check <cmd>', 'Shell command for condition trigger')
  .option('--expect <output>', 'Expected output for condition trigger')
  .option('--decay <datetime>', 'Auto-expire datetime')
  .option('--max-fires <n>', 'Auto-complete after N fires', parseInt)
  .option('--recur, -r <rule>', 'Recurrence: 1d, 1w, 2w, 1m')
  .option('--agent, -a <name>', 'Target agent')
  .option('--depends-on <id>', 'Dependency reminder ID')
  .option('--source <src>', 'Source: agent|user|system')
  .option('--dry-run', 'Preview without creating')
  .action((content, opts) => {
    const db = getDb();
    try {
      const rem = coreAdd(db, {
        content,
        due: opts.due || opts.D,
        trigger: opts.trigger || opts.T,
        priority: opts.priority || opts.P,
        tags: opts.tags,
        context: opts.context || opts.C,
        category: opts.category,
        keywords: opts.keywords || opts.keyword || opts.K,
        match: opts.match,
        check: opts.check,
        expect: opts.expect,
        decay: opts.decay,
        maxFires: opts.maxFires,
        recur: opts.recur || opts.R,
        agent: opts.agent || opts.A,
        dependsOn: opts.dependsOn,
        source: opts.source,
        dryRun: opts.dryRun,
      });

      if (opts.dryRun) {
        console.log('🔍 Dry run — would create:');
        console.log(`  Content:  ${rem.content}`);
        console.log(`  Trigger:  ${rem.trigger_type}`);
        if (rem.trigger_at) console.log(`  Due:      ${rem.trigger_at}`);
        console.log(`  Priority: ${rem.priority} (${PRIORITY_LABELS[rem.priority] || ''})`);
        if (rem.tags) console.log(`  Tags:     ${rem.tags}`);
        if (rem.context) console.log(`  Context:  ${rem.context}`);
      } else {
        console.log(`✅ Created reminder [${rem.id.slice(0, 8)}]`);
        console.log(`  Content:  ${rem.content}`);
        console.log(`  Trigger:  ${rem.trigger_type}`);
        if (rem.trigger_at)
          console.log(`  Due:      ${rem.trigger_at} (${fmtDt(rem.trigger_at)})`);
        console.log(`  Priority: ${rem.priority} (${PRIORITY_LABELS[rem.priority] || ''})`);
        if (rem.tags) console.log(`  Tags:     ${rem.tags}`);
        if (rem.context) console.log(`  Context:  ${rem.context}`);
      }
    } finally {
      db.close();
    }
  });

// ── check ─────────────────────────────────────────────────────────────────

program
  .command('check')
  .description('Check for triggered reminders')
  .option('--type <types>', 'Comma-separated trigger types')
  .option('--text <text>', 'User message text (for keyword matching)')
  .option('--budget <n>', 'Token budget (default 800)', parseInt)
  .option('--format <fmt>', 'Output format: full|compact|inline')
  .option('--json', 'Output JSON')
  .option('--agent, -a <name>', 'Agent name')
  .option('--escalate', 'Run escalation checks')
  .option('--dry-run', 'Preview without updating')
  .option('--watch', 'Block until a reminder fires (use with --timeout)')
  .option('--timeout <seconds>', 'Seconds to wait in --watch mode (exit 1 if no reminder)', parseInt)
  .action(async (opts) => {
    // ── Watch mode ─────────────────────────────────────────────────────────
    if (opts.watch) {
      const result = await checkWatch({
        agent: opts.agent || opts.A,
        type: opts.type,
        budget: opts.budget,
        timeout: opts.timeout,
      });

      if (result.timedOut) {
        // --timeout elapsed with no reminder
        process.exit(1);
        return;
      }

      if (result.reminder === null) {
        // SIGINT / SIGTERM — clean exit, no output
        process.exit(0);
        return;
      }

      console.log(fmtWatchReminder(result.reminder, !!opts.json));
      process.exit(0);
      return;
    }

    // ── Normal (one-shot) mode ──────────────────────────────────────────────
    const db = getDb();
    try {
      const result = coreCheck(db, {
        type: opts.type,
        text: opts.text,
        budget: opts.budget,
        format: opts.format,
        agent: opts.agent || opts.A,
        escalate: opts.escalate,
        dryRun: opts.dryRun,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.included.length === 0) return;

      const fmt = opts.format || 'full';
      const charLimits: Record<number, number> = { 1: 200, 2: 100, 3: 60, 4: 0, 5: 0 };

      if (fmt === 'inline') {
        for (const rem of result.included) {
          const ctx = rem.context ? ` — ${rem.context}` : '';
          console.log(`💡 Reminder [${rem.id.slice(0, 8)}]: "${rem.content}${ctx}"`);
        }
      } else if (fmt === 'compact') {
        const parts: string[] = [];
        const byPriority: Record<number, typeof result.included> = {};
        for (const rem of result.included) {
          (byPriority[rem.priority] ??= []).push(rem);
        }
        for (const p of Object.keys(byPriority).map(Number).sort()) {
          const items = byPriority[p];
          const label = PRIORITY_LABELS[p] || `P${p}`;
          if (items.length === 1) {
            const r = items[0];
            const dueStr = r.trigger_at ? ` — ${fmtDt(r.trigger_at)}` : '';
            parts.push(
              `${items.length} ${label.split(' ', 2)[1].toLowerCase()} (${truncate(r.content, 30)}${dueStr})`,
            );
          } else {
            parts.push(`${items.length} ${label.split(' ', 2)[1].toLowerCase()}`);
          }
        }
        const overflowParts: string[] = [];
        for (const p of [2, 3, 4]) {
          if (result.overflowCounts[p] > 0) {
            overflowParts.push(
              `+${result.overflowCounts[p]} ${(PRIORITY_LABELS[p] || '').split(' ', 2)[1].toLowerCase()}`,
            );
          }
        }
        const extra = overflowParts.length > 0 ? `, ${overflowParts.join(', ')} hidden` : '';
        console.log(`🔔 ${parts.join(', ')}${extra}`);
      } else {
        // Full format
        console.log('🔔 Active Reminders\n');
        const byPriority: Record<number, typeof result.included> = {};
        for (const rem of result.included) {
          (byPriority[rem.priority] ??= []).push(rem);
        }

        for (const p of Object.keys(byPriority).map(Number).sort()) {
          const label = PRIORITY_LABELS[p] || `P${p}`;
          const items = byPriority[p];
          const countStr = items.length > 1 ? ` (${items.length})` : '';
          console.log(`${label}${countStr}`);
          for (const rem of items) {
            const dueStr = rem.trigger_at ? ` — due ${fmtDt(rem.trigger_at)}` : '';
            let fireStr = '';
            if (rem.fire_count && rem.fire_count > 0) {
              fireStr = `, fired ${rem.fire_count}x`;
            }
            let triggerInfo = '';
            if (rem.trigger_type === 'keyword') {
              const config = JSON.parse(rem.trigger_config || '{}');
              const kws = config.keywords || [];
              triggerInfo = ` (keyword: "${kws.join(', ')}")`;
            } else if (rem.trigger_type === 'condition') {
              triggerInfo = ' (condition: checking)';
            } else if (rem.trigger_type === 'session') {
              triggerInfo = ' (session)';
            } else if (rem.trigger_type === 'heartbeat') {
              triggerInfo = ' (heartbeat)';
            }
            console.log(
              `- [${rem.id.slice(0, 8)}] ${truncate(rem.content, charLimits[p] || 60)}${dueStr}${fireStr}${triggerInfo}`,
            );
            if (rem.context) {
              console.log(`  Context: ${truncate(rem.context, charLimits[p] || 60)}`);
            }
            if (rem.tags) {
              console.log(`  Tags: ${rem.tags}`);
            }
          }
          console.log();
        }

        const overflowTotal = Object.values(result.overflowCounts).reduce(
          (a, b) => a + b,
          0,
        );
        if (overflowTotal > 0) {
          console.log(`...and ${overflowTotal} more (run \`agentrem list\` for all)`);
        }
      }
    } finally {
      db.close();
    }
  });

// ── list ──────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List reminders')
  .option('--status, -s <statuses>', 'Filter by status (active,completed,expired,snoozed,deleted or "all")')
  .option('--priority <priorities>', 'Comma-separated priorities')
  .option('--tag <tag>', 'Filter by tag')
  .option('--trigger <type>', 'Filter by trigger type')
  .option('--due <filter>', 'Due filter: today|tomorrow|overdue|week|date')
  .option('--agent, -a <name>', 'Agent name')
  .option('--category <cat>', 'Category filter')
  .option('--limit <n>', 'Max results', parseInt)
  .option('--format <fmt>', 'Output format: table|json|compact')
  .option('--json', 'Output JSON')
  .option('--all', 'Show all statuses')
  .action((opts) => {
    const db = getDb();
    try {
      const rows = coreList(db, {
        status: opts.status || opts.S,
        priority: opts.priority,
        tag: opts.tag,
        trigger: opts.trigger,
        due: opts.due,
        agent: opts.agent || opts.A,
        category: opts.category,
        limit: opts.limit,
        all: opts.all,
      });

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log('No reminders found.');
        return;
      }

      const fmt = opts.format || 'table';
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2));
      } else if (fmt === 'compact') {
        for (const r of rows) {
          const dueStr = r.trigger_at ? ` due:${fmtDt(r.trigger_at)}` : '';
          console.log(`[${r.id.slice(0, 8)}] P${r.priority} ${truncate(r.content, 40)}${dueStr}`);
        }
      } else {
        const header = `${'ID'.padStart(8)}  ${'P'.padStart(1)}  ${'Status'.padStart(9)}  ${'Trigger'.padStart(9)}  ${'Content'.padEnd(35)}  ${'Due/Info'.padEnd(15)}  Tags`;
        console.log(header);
        console.log('─'.repeat(header.length));
        for (const r of rows) {
          const dueInfo = r.trigger_at ? fmtDt(r.trigger_at) : r.trigger_type;
          console.log(
            `${r.id.slice(0, 8).padStart(8)}  ${String(r.priority).padStart(1)}  ${r.status.padStart(9)}  ${r.trigger_type.padStart(9)}  ${truncate(r.content, 35).padEnd(35)}  ${dueInfo.padEnd(15)}  ${r.tags || ''}`,
          );
        }
      }
    } finally {
      db.close();
    }
  });

// ── search ────────────────────────────────────────────────────────────────

program
  .command('search')
  .description('Full-text search')
  .argument('<query>', 'Search query')
  .option('--status <statuses>', 'Filter statuses')
  .option('--limit <n>', 'Max results', parseInt)
  .option('--format <fmt>', 'Output format: table|json')
  .option('--json', 'Output JSON')
  .action((query, opts) => {
    const db = getDb();
    try {
      const rows = coreSearch(db, {
        query,
        status: opts.status,
        limit: opts.limit,
      });

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log('No results found.');
        process.exit(1);
      }

      const fmt = opts.format || 'table';
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        const header = `${'ID'.padStart(8)}  ${'P'.padStart(1)}  ${'Content'.padEnd(40)}  Tags`;
        console.log(`🔍 Search results for "${query}":\n`);
        console.log(header);
        console.log('─'.repeat(header.length));
        for (const r of rows) {
          console.log(
            `${r.id.slice(0, 8).padStart(8)}  ${String(r.priority).padStart(1)}  ${truncate(r.content, 40).padEnd(40)}  ${r.tags || ''}`,
          );
        }
      }
    } finally {
      db.close();
    }
  });

// ── complete ──────────────────────────────────────────────────────────────

program
  .command('complete')
  .description('Complete a reminder')
  .argument('<id>', 'Reminder ID')
  .option('--notes <text>', 'Completion notes')
  .action((id, opts) => {
    const db = getDb();
    try {
      const result = coreComplete(db, id, opts.notes);
      if (result.nextRecurrence) {
        console.log(
          `📅 Next recurrence [${result.nextRecurrence.id.slice(0, 8)}] created — due ${result.nextRecurrence.trigger_at}`,
        );
      }
      console.log(`✅ Completed [${result.completed.id.slice(0, 8)}] ${result.completed.content}`);
    } finally {
      db.close();
    }
  });

// ── snooze ────────────────────────────────────────────────────────────────

program
  .command('snooze')
  .description('Snooze a reminder')
  .argument('<id>', 'Reminder ID')
  .option('--until <datetime>', 'Snooze until datetime')
  .option('--for <duration>', 'Snooze duration: 1h, 2h, 1d, 3d, 1w')
  .action((id, opts) => {
    const db = getDb();
    try {
      const rem = coreSnooze(db, id, opts.until, opts.for);
      console.log(
        `😴 Snoozed [${rem.id.slice(0, 8)}] until ${rem.snoozed_until} (${fmtDt(rem.snoozed_until)})`,
      );
    } finally {
      db.close();
    }
  });

// ── edit ──────────────────────────────────────────────────────────────────

program
  .command('edit')
  .description('Edit a reminder')
  .argument('<id>', 'Reminder ID')
  .option('--content <text>', 'New content')
  .option('--context <ctx>', 'New context')
  .option('--priority, -p <n>', 'New priority', parseInt)
  .option('--due, -d <datetime>', 'New due date')
  .option('--tags <tags>', 'Replace tags')
  .option('--add-tags <tags>', 'Add tags')
  .option('--remove-tags <tags>', 'Remove tags')
  .option('--category <cat>', 'New category')
  .option('--decay <datetime>', 'New decay date')
  .option('--max-fires <n>', 'New max fires', parseInt)
  .option('--keywords, -k <kw>', 'New keywords')
  .option('--agent, -a <name>', 'New agent')
  .action((id, opts) => {
    const db = getDb();
    try {
      const rem = coreEdit(db, id, {
        content: opts.content,
        context: opts.context,
        priority: opts.priority || opts.P,
        due: opts.due || opts.D,
        tags: opts.tags,
        addTags: opts.addTags,
        removeTags: opts.removeTags,
        category: opts.category,
        decay: opts.decay,
        maxFires: opts.maxFires,
        keywords: opts.keywords || opts.keyword || opts.K,
        agent: opts.agent || opts.A,
      });
      console.log(`✏️  Updated [${rem.id.slice(0, 8)}]`);
    } finally {
      db.close();
    }
  });

// ── delete ────────────────────────────────────────────────────────────────

program
  .command('delete')
  .description('Delete a reminder')
  .argument('[id]', 'Reminder ID')
  .option('--permanent', 'Permanently delete')
  .option('-y, --yes', 'Skip confirmation (default: no prompt)')
  .option('--status <status>', 'Bulk delete by status')
  .option('--older-than <days>', 'Delete older than N days')
  .action((id, opts) => {
    const db = getDb();
    try {
      const result = coreDelete(db, {
        id,
        permanent: opts.permanent,
        status: opts.status,
        olderThan: opts.olderThan,
      });
      const mode = result.permanent ? 'Permanently deleted' : 'Soft-deleted';
      if (opts.status) {
        console.log(`🗑️  ${mode} ${result.count} reminders with status '${opts.status}'`);
      } else {
        console.log(
          result.permanent
            ? `🗑️  Permanently deleted [${id}]`
            : `🗑️  Deleted [${id}] (soft delete — use --permanent to remove permanently)`,
        );
      }
    } finally {
      db.close();
    }
  });

// ── stats ─────────────────────────────────────────────────────────────────

program
  .command('stats')
  .description('Show statistics')
  .option('--json', 'Output JSON')
  .action((opts) => {
    const db = getDb();
    try {
      const s = coreStats(db);

      if (opts.json) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      const prioParts = s.byPriority.map((p) => `${p.count} ${p.label}`);
      const prioStr = prioParts.length > 0 ? ` (${prioParts.join(', ')})` : '';
      const triggerParts = s.byTrigger.map((t) => `${t.count} ${t.type}`);

      console.log('📊 Agent Reminders Stats');
      console.log(`Active: ${s.totalActive}${prioStr}`);
      console.log(`Overdue: ${s.overdue}`);
      console.log(`Snoozed: ${s.snoozed}`);
      console.log(`Completed (this week): ${s.completedWeek}`);
      console.log(`Expired: ${s.expired}`);
      if (triggerParts.length > 0) {
        console.log(`By trigger: ${triggerParts.join(', ')}`);
      }
      if (s.nextDue) {
        console.log(
          `Next due: "${truncate(s.nextDue.content, 30)}" ${fmtDt(s.nextDue.triggerAt)}`,
        );
      }
      if (s.lastCreated) {
        console.log(`Last created: ${fmtDt(s.lastCreated)}`);
      }
      const sizeStr =
        s.dbSizeBytes > 1024 * 1024
          ? `${(s.dbSizeBytes / 1024 / 1024).toFixed(1)} MB`
          : `${Math.round(s.dbSizeBytes / 1024)} KB`;
      console.log(`DB size: ${sizeStr}`);
    } finally {
      db.close();
    }
  });

// ── gc ────────────────────────────────────────────────────────────────────

program
  .command('gc')
  .description('Garbage collection')
  .option('--older-than <days>', 'Days threshold (default 30)')
  .option('--dry-run', 'Preview')
  .action((opts) => {
    const db = getDb();
    try {
      const olderThan = parseInt(opts.olderThan || '30', 10);
      const result = coreGc(db, olderThan, opts.dryRun);

      if (result.count === 0) {
        console.log('No reminders to clean up.');
        return;
      }

      if (opts.dryRun) {
        console.log(`🔍 Dry run — would remove ${result.count} reminders:`);
        for (const r of result.reminders) {
          console.log(`  [${r.id.slice(0, 8)}] ${r.status}: ${truncate(r.content, 40)}`);
        }
      } else {
        console.log(`🗑️  Removed ${result.count} old reminders and vacuumed database.`);
      }
    } finally {
      db.close();
    }
  });

// ── history ───────────────────────────────────────────────────────────────

program
  .command('history')
  .description('View history')
  .argument('[id]', 'Reminder ID (optional)')
  .option('--limit <n>', 'Number of entries', parseInt)
  .option('--format <fmt>', 'Output format: table|json')
  .option('--json', 'Output JSON')
  .action((id, opts) => {
    const db = getDb();
    try {
      const rows = coreHistory(db, id, opts.limit || 20);

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log('No history found.');
        return;
      }

      const fmt = opts.json ? 'json' : (opts.format || 'table');
      if (fmt === 'json') {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        console.log(
          `${'HID'.padStart(4)}  ${'Reminder'.padStart(8)}  ${'Action'.padStart(10)}  ${'When'.padEnd(15)}  Source`,
        );
        console.log('─'.repeat(60));
        for (const r of rows) {
          console.log(
            `${String(r.id).padStart(4)}  ${r.reminder_id.slice(0, 8).padStart(8)}  ${r.action.padStart(10)}  ${fmtDt(r.timestamp).padEnd(15)}  ${r.source || ''}`,
          );
          // Show extra detail lines for certain actions
          if (r.new_data) {
            try {
              const nd = JSON.parse(r.new_data) as Record<string, unknown>;
              if (r.action === 'fired' && nd['fire_count'] !== undefined) {
                console.log(`      Fire count: ${nd['fire_count']}`);
              } else if (nd['notes'] && typeof nd['notes'] === 'string') {
                console.log(`      Notes: ${truncate(nd['notes'], 80)}`);
              }
            } catch {
              // Ignore unparseable new_data
            }
          }
        }
      }
    } finally {
      db.close();
    }
  });

// ── undo ──────────────────────────────────────────────────────────────────

program
  .command('undo')
  .description('Undo a change')
  .argument('<history_id>', 'History entry ID')
  .action((historyId) => {
    const db = getDb();
    try {
      coreUndo(db, parseInt(historyId, 10));
      console.log(`↩️  Reverted history #${historyId}`);
    } finally {
      db.close();
    }
  });

// ── export ────────────────────────────────────────────────────────────────

program
  .command('export')
  .description('Export reminders')
  .option('--out, -o <path>', 'Output path')
  .option('--status <statuses>', 'Filter by status')
  .action((opts) => {
    const db = getDb();
    try {
      const data = coreExport(db, opts.status);

      let outPath: string;
      if (opts.out || opts.O) {
        outPath = opts.out || opts.O;
      } else {
        const dir =
          process.env['AGENTREM_DIR'] ||
          path.join(os.homedir(), '.agentrem');
        const ts = new Date()
          .toISOString()
          .replace(/[:.]/g, '')
          .slice(0, 15)
          .replace('T', '-');
        outPath = path.join(dir, `export-${ts}.json`);
      }

      const dir = path.dirname(outPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(outPath, JSON.stringify(data, null, 2), { mode: 0o600 });

      console.log(`📦 Exported ${data.reminder_count} reminders to ${outPath}`);
    } finally {
      db.close();
    }
  });

// ── import ────────────────────────────────────────────────────────────────

program
  .command('import')
  .description('Import reminders')
  .argument('<file>', 'JSON file to import')
  .option('--merge', 'Merge (skip duplicates)')
  .option('--replace', 'Replace all existing')
  .option('--dry-run', 'Preview')
  .action((file, opts) => {
    if (!fs.existsSync(file)) {
      console.error(`Error: File not found: ${file}`);
      process.exit(2);
    }

    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e: unknown) {
      console.error(`Error: Failed to parse import file: ${(e as Error).message}`);
      process.exit(2);
    }
    if (typeof rawParsed !== 'object' || rawParsed === null || Array.isArray(rawParsed)) {
      console.error('Error: Import file must be a JSON object.');
      process.exit(2);
    }
    const rawObj = rawParsed as Record<string, unknown>;
    if (!('schema_version' in rawObj)) {
      console.error('Error: Import file is missing required field: schema_version');
      process.exit(2);
    }
    if ('reminders' in rawObj && !Array.isArray(rawObj['reminders'])) {
      console.error('Error: Import file field "reminders" must be an array.');
      process.exit(2);
    }
    if ('history' in rawObj && !Array.isArray(rawObj['history'])) {
      console.error('Error: Import file field "history" must be an array.');
      process.exit(2);
    }
    const data = rawObj as unknown as ExportData;

    if (opts.dryRun) {
      console.log(
        `🔍 Dry run — would import ${(data.reminders || []).length} reminders and ${(data.history || []).length} history entries`,
      );
      return;
    }

    const db = getDb();
    try {
      const result = coreImport(db, data, opts.merge, opts.replace, false);
      console.log(
        `📥 Imported ${result.imported} reminders (${result.skipped} skipped), ${result.historyImported} history entries`,
      );
    } finally {
      db.close();
    }
  });

// ── schema ────────────────────────────────────────────────────────────────

program
  .command('schema')
  .description('Show database schema')
  .action(() => {
    const db = getDb();
    try {
      const sqls = coreSchema(db);
      for (const sql of sqls) {
        console.log(sql);
        console.log();
      }
    } finally {
      db.close();
    }
  });

// ── setup ─────────────────────────────────────────────────────────────────

program
  .command('setup')
  .description('Print integration snippets for AI tools')
  .option('--mcp', 'Print Claude Desktop MCP config instead')
  .option('--openclaw', 'Print OpenClaw integration instructions')
  .action((opts) => {
    if (opts.openclaw) {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.agentrem.watch.plist');
      const plistExists = fs.existsSync(plistPath);
      console.log('## agentrem × OpenClaw Integration\n');
      console.log('Run this command to start watching for reminders and delivering them via OpenClaw:\n');
      console.log('  agentrem watch --on-fire-preset openclaw\n');
      console.log('When a reminder fires, agentrem will schedule a one-shot OpenClaw cron that');
      console.log('delivers the reminder to your last active channel — no extra config needed.\n');
      if (plistExists) {
        console.log(`⚠️  You have a launchd plist installed at:\n  ${plistPath}`);
        console.log('Update it to include --on-fire-preset openclaw, then reload:\n');
        console.log('  launchctl unload ' + plistPath);
        console.log('  # edit the plist to add --on-fire-preset openclaw to the ProgramArguments array');
        console.log('  launchctl load ' + plistPath);
      }
      return;
    }

    if (opts.mcp) {
      const config = {
        mcpServers: {
          agentrem: {
            command: 'agentrem-mcp',
            args: [],
          },
        },
      };
      console.log('Add this to ~/Library/Application Support/Claude/claude_desktop_config.json:\n');
      console.log(JSON.stringify(config, null, 2));
    } else {
      console.log(`## Reminders
You have access to \`agentrem\` CLI for persistent reminders across sessions.

### On every session start, run:
\`\`\`bash
agentrem check --type time,session --budget 800
\`\`\`

### When the user says "remind me", "don't forget", "follow up", or "next time":
\`\`\`bash
agentrem add "<content>" --due "<when>" --priority <1-5> --tags "<tags>"
\`\`\`

### Key commands:
- \`agentrem add\` — create a reminder
- \`agentrem check\` — see what's triggered/due
- \`agentrem list\` — list all active reminders
- \`agentrem search <query>\` — full-text search
- \`agentrem complete <id>\` — mark done
- \`agentrem snooze <id> --for 2h\` — snooze
- \`agentrem --help\` — full reference`);
    }
  });

// ── doctor ─────────────────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Self-diagnostic check')
  .option('--json', 'Output JSON')
  .action((opts) => {
    const checks: { check: string; status: 'ok' | 'warn' | 'fail'; detail: string }[] = [];
    const dbPath =
      process.env['AGENTREM_DB'] ||
      path.join(
        process.env['AGENTREM_DIR'] || path.join(os.homedir(), '.agentrem'),
        'reminders.db',
      );

    // Check 1: DB exists
    const dbExists = fs.existsSync(dbPath);
    checks.push({
      check: 'Database exists',
      status: dbExists ? 'ok' : 'fail',
      detail: dbExists ? dbPath : `Not found at ${dbPath}. Run: agentrem init`,
    });

    if (dbExists) {
      try {
        const db = getDb();
        try {
          // Check 2: Schema valid
          const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all() as { name: string }[];
          const tableNames = tables.map((t) => t.name);
          const hasReminders = tableNames.includes('reminders');
          const hasHistory = tableNames.includes('history');
          const hasFts = tableNames.includes('reminders_fts');
          checks.push({
            check: 'Schema valid',
            status: hasReminders && hasHistory && hasFts ? 'ok' : 'fail',
            detail:
              hasReminders && hasHistory && hasFts
                ? `Tables: ${tableNames.join(', ')}`
                : `Missing tables. Run: agentrem init --force`,
          });

          // Check 3: Active reminders
          const stats = coreStats(db);
          checks.push({
            check: 'Active reminders',
            status: stats.totalActive > 0 ? 'ok' : 'warn',
            detail:
              stats.totalActive > 0
                ? `${stats.totalActive} active (${stats.overdue} overdue)`
                : 'No active reminders. Add one: agentrem add "Test" --due "+1h"',
          });

          // Check 4: Overdue count
          if (stats.overdue > 0) {
            checks.push({
              check: 'Overdue reminders',
              status: 'warn',
              detail: `${stats.overdue} overdue. Run: agentrem check --escalate`,
            });
          }

          // Check 5: DB size
          const dbStat = fs.statSync(dbPath);
          const sizeMB = dbStat.size / 1024 / 1024;
          checks.push({
            check: 'Database size',
            status: sizeMB < 50 ? 'ok' : 'warn',
            detail:
              sizeMB < 1
                ? `${Math.round(dbStat.size / 1024)} KB`
                : `${sizeMB.toFixed(1)} MB${sizeMB >= 50 ? '. Consider: agentrem gc' : ''}`,
          });
        } finally {
          db.close();
        }
      } catch (e: any) {
        checks.push({
          check: 'Database readable',
          status: 'fail',
          detail: `Error: ${e.message}`,
        });
      }
    }

    if (opts.json) {
      const allOk = checks.every((c) => c.status === 'ok');
      console.log(JSON.stringify({ healthy: allOk, checks }, null, 2));
      return;
    }

    const icons = { ok: '✅', warn: '⚠️', fail: '❌' };
    console.log('🩺 agentrem doctor\n');
    for (const c of checks) {
      console.log(`${icons[c.status]} ${c.check}: ${c.detail}`);
    }
    const allOk = checks.every((c) => c.status === 'ok');
    console.log(allOk ? '\n🟢 All checks passed.' : '\n🟡 Some issues found.');
  });

// ── quickstart ────────────────────────────────────────────────────────────

program
  .command('quickstart')
  .description('Interactive first-run walkthrough')
  .action(() => {
    const dbPath =
      process.env['AGENTREM_DB'] ||
      path.join(
        process.env['AGENTREM_DIR'] || path.join(os.homedir(), '.agentrem'),
        'reminders.db',
      );

    // Step 1: Init if needed
    if (!fs.existsSync(dbPath)) {
      console.log('📦 Step 1/4: Initializing database...');
      const msg = initDb(false);
      console.log(`   ${msg}\n`);
    } else {
      console.log('📦 Step 1/4: Database already exists. ✅\n');
    }

    const db = getDb();
    try {
      // Step 2: Create a sample reminder
      console.log('📝 Step 2/4: Creating a sample reminder...');
      const rem = coreAdd(db, {
        content: 'This is a test reminder from quickstart',
        due: '+5m',
        priority: 2,
        tags: 'quickstart,test',
        source: 'system',
      });
      console.log(`   Created [${rem.id.slice(0, 8)}] — due in 5 minutes\n`);

      // Step 3: Check triggered
      console.log('🔔 Step 3/4: Checking triggered reminders...');
      const result = coreCheck(db, { budget: 800 });
      console.log(`   Found ${result.included.length} triggered reminder(s)\n`);

      // Step 4: Complete it
      console.log('✅ Step 4/4: Completing the test reminder...');
      coreComplete(db, rem.id);
      console.log(`   Done! Cleaned up test reminder.\n`);

      console.log('🎉 Quickstart complete! agentrem is working.\n');
      console.log('Next steps:');
      console.log('  agentrem add "My first real reminder" --due "+1h" --priority 2');
      console.log('  agentrem check');
      console.log('  agentrem setup    # Get your CLAUDE.md snippet');
      console.log('  agentrem doctor   # Run diagnostics anytime');
    } finally {
      db.close();
    }
  });

// ── watch ─────────────────────────────────────────────────────────────────

program
  .command('watch')
  .description('Background watcher: poll for due reminders and fire OS notifications')
  .option('--interval <seconds>', 'Poll interval in seconds (default 30)', parseInt)
  .option('--agent, -a <name>', 'Agent name to check for')
  .option('--once', 'Run a single check and exit')
  .option('--verbose', 'Verbose output')
  .option('--on-fire <command>', 'Shell command to run when a reminder fires (data via env vars)')
  .option('--on-fire-preset <name>', 'Use a built-in on-fire command preset (e.g. openclaw)')
  .option('--on-fire-timeout <ms>', 'Timeout for on-fire command in ms (default 5000)', parseInt)
  .option('--cooldown <seconds>', 'Dedup cooldown in seconds (default 300)', parseInt)
  .option('--install', 'Install as a background OS service (launchd / systemd)')
  .option('--uninstall', 'Remove the background OS service')
  .option('--status', 'Show service status')
  .action(async (opts) => {
    // ── service management sub-commands ──────────────────────────────────
    if (opts.install) {
      const result = installService({
        interval: opts.interval,
        agent: opts.agent || opts.A,
        verbose: opts.verbose,
      });
      if (result.success) {
        console.log(`✅ ${result.message}`);
      } else {
        console.error(`❌ ${result.message}`);
        process.exit(1);
      }
      return;
    }

    if (opts.uninstall) {
      const result = uninstallService();
      if (result.success) {
        console.log(`✅ ${result.message}`);
      } else {
        console.error(`❌ ${result.message}`);
        process.exit(1);
      }
      return;
    }

    if (opts.status) {
      const s = getServiceStatus();
      console.log(`Installed: ${s.installed ? 'yes' : 'no'}`);
      console.log(`Running:   ${s.running ? 'yes' : 'no'}`);
      console.log(`PID:       ${s.pid != null ? String(s.pid) : 'n/a'}`);
      if (s.logPath) console.log(`Log:       ${s.logPath}`);
      console.log(`Platform:  ${s.platform}`);
      if (s.filePath) console.log(`File:      ${s.filePath}`);
      if (s.detail) console.log(`Status:    ${s.detail}`);
      return;
    }

    // ── watch loop ────────────────────────────────────────────────────────
    // Validate mutual exclusivity of --on-fire and --on-fire-preset
    if (opts.onFire && opts.onFirePreset) {
      console.error('Error: Cannot use both --on-fire and --on-fire-preset');
      process.exit(1);
    }

    // Resolve preset to concrete command string upfront (validates preset name early)
    let resolvedOnFire: string | undefined = opts.onFire;
    if (opts.onFirePreset) {
      try {
        resolvedOnFire = resolveOnFirePreset(opts.onFirePreset);
      } catch (e: any) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
    }

    try {
      await startWatch({
        interval: opts.interval,
        agent: opts.agent || opts.A,
        once: opts.once,
        verbose: opts.verbose,
        onFire: resolvedOnFire,
        onFireTimeout: opts.onFireTimeout,
        cooldown: opts.cooldown,
      });
    } catch (e: any) {
      console.error(`[agentrem watch] error: ${e.message}`);
      process.exit(1);
    }
  });

// ── Run ───────────────────────────────────────────────────────────────────

function run() {
  try {
    program.parse();
  } catch (e) {
    if (e instanceof AgentremError) {
      console.error(`Error: ${e.message}`);
      process.exit(e.exitCode);
    }
    throw e;
  }
}

run();
