// ── MCP Tools ─────────────────────────────────────────────────────────────
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
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
  type ExportData,
} from '../core.js';
import { PRIORITY_LABELS } from '../types.js';

export function registerTools(server: McpServer): void {
  // ── add_reminder ──────────────────────────────────────────────────────
  server.tool(
    'add_reminder',
    'Create a new reminder with priority, triggers, and scheduling',
    {
      content: z.string().describe('Reminder text'),
      due: z.string().optional().describe('Due datetime (relative or ISO)'),
      trigger: z.enum(['time', 'keyword', 'condition', 'session', 'heartbeat', 'manual']).default('time'),
      priority: z.number().min(1).max(5).default(3),
      tags: z.string().optional().describe('Comma-separated tags'),
      context: z.string().optional(),
      category: z.string().optional(),
      keywords: z.string().optional().describe('Comma-separated keywords for keyword trigger'),
      match: z.enum(['any', 'all', 'regex']).default('any'),
      check_command: z.string().optional().describe('Shell command for condition trigger'),
      expect: z.string().optional().describe('Expected output for condition trigger'),
      decay: z.string().optional().describe('Auto-expire datetime'),
      max_fires: z.number().optional(),
      recur: z.string().optional().describe('Recurrence: 1d, 2w, 1m'),
      agent: z.string().default('main'),
      depends_on: z.string().optional(),
      source: z.enum(['agent', 'user', 'system']).default('agent'),
    },
    async (params) => {
      const db = getDb();
      try {
        const rem = coreAdd(db, {
          content: params.content,
          due: params.due,
          trigger: params.trigger,
          priority: params.priority,
          tags: params.tags,
          context: params.context,
          category: params.category,
          keywords: params.keywords,
          match: params.match,
          check: params.check_command,
          expect: params.expect,
          decay: params.decay,
          maxFires: params.max_fires,
          recur: params.recur,
          agent: params.agent,
          dependsOn: params.depends_on,
          source: params.source,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              id: rem.id,
              id_short: rem.id.slice(0, 8),
              content: rem.content,
              trigger_type: rem.trigger_type,
              trigger_at: rem.trigger_at,
              priority: rem.priority,
              priority_label: PRIORITY_LABELS[rem.priority],
              status: rem.status,
              created_at: rem.created_at,
            }),
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      } finally {
        db.close();
      }
    },
  );

  // ── check_reminders ───────────────────────────────────────────────────
  server.tool(
    'check_reminders',
    'Check for triggered reminders. Returns due/matched reminders within token budget',
    {
      text: z.string().optional().describe('Message text for keyword matching'),
      trigger_types: z.string().optional().describe('Comma-separated trigger types'),
      budget: z.number().default(800),
      agent: z.string().default('main'),
      escalate: z.boolean().default(false),
      dry_run: z.boolean().default(false),
    },
    async (params) => {
      const db = getDb();
      try {
        const result = coreCheck(db, {
          text: params.text,
          type: params.trigger_types,
          budget: params.budget,
          agent: params.agent,
          escalate: params.escalate,
          dryRun: params.dry_run,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              triggered_count: result.totalTriggered,
              included_count: result.included.length,
              overflow_count: Object.values(result.overflowCounts).reduce((a, b) => a + b, 0),
              reminders: result.included.map((r) => ({
                id: r.id,
                id_short: r.id.slice(0, 8),
                content: r.content,
                context: r.context,
                trigger_type: r.trigger_type,
                trigger_at: r.trigger_at,
                priority: r.priority,
                priority_label: PRIORITY_LABELS[r.priority],
                fire_count: r.fire_count,
                tags: r.tags,
              })),
              overflow: {
                high: result.overflowCounts[2] || 0,
                normal: result.overflowCounts[3] || 0,
                low: result.overflowCounts[4] || 0,
              },
            }),
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      } finally {
        db.close();
      }
    },
  );

  // ── list_reminders ────────────────────────────────────────────────────
  server.tool(
    'list_reminders',
    'List reminders with optional filters',
    {
      status: z.string().optional(),
      priority: z.string().optional(),
      tag: z.string().optional(),
      trigger: z.string().optional(),
      due: z.string().optional(),
      category: z.string().optional(),
      agent: z.string().default('main'),
      limit: z.number().default(20),
      show_all: z.boolean().default(false),
    },
    async (params) => {
      const db = getDb();
      try {
        const rows = coreList(db, {
          status: params.status,
          priority: params.priority,
          tag: params.tag,
          trigger: params.trigger,
          due: params.due,
          category: params.category,
          agent: params.agent,
          limit: params.limit,
          all: params.show_all,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              count: rows.length,
              reminders: rows.map((r) => ({
                id: r.id,
                id_short: r.id.slice(0, 8),
                content: r.content,
                priority: r.priority,
                priority_label: PRIORITY_LABELS[r.priority],
                status: r.status,
                trigger_type: r.trigger_type,
                trigger_at: r.trigger_at,
                tags: r.tags,
                category: r.category,
                fire_count: r.fire_count,
                created_at: r.created_at,
                updated_at: r.updated_at,
              })),
            }),
          }],
        };
      } finally {
        db.close();
      }
    },
  );

  // ── search_reminders ──────────────────────────────────────────────────
  server.tool(
    'search_reminders',
    'Full-text search across reminder content, context, tags, and notes',
    {
      query: z.string(),
      status: z.string().default('active'),
      limit: z.number().default(10),
    },
    async (params) => {
      const db = getDb();
      try {
        const rows = coreSearch(db, {
          query: params.query,
          status: params.status,
          limit: params.limit,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              query: params.query,
              count: rows.length,
              reminders: rows.map((r) => ({
                id: r.id,
                id_short: r.id.slice(0, 8),
                content: r.content,
                priority: r.priority,
                tags: r.tags,
              })),
            }),
          }],
        };
      } finally {
        db.close();
      }
    },
  );

  // ── complete_reminder ─────────────────────────────────────────────────
  server.tool(
    'complete_reminder',
    'Complete a reminder. Handles recurrence automatically',
    {
      id: z.string(),
      notes: z.string().optional(),
    },
    async (params) => {
      const db = getDb();
      try {
        const result = coreComplete(db, params.id, params.notes);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              completed: {
                id: result.completed.id,
                id_short: result.completed.id.slice(0, 8),
                content: result.completed.content,
              },
              next_recurrence: result.nextRecurrence
                ? {
                    id: result.nextRecurrence.id,
                    id_short: result.nextRecurrence.id.slice(0, 8),
                    trigger_at: result.nextRecurrence.trigger_at,
                  }
                : null,
            }),
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      } finally {
        db.close();
      }
    },
  );

  // ── snooze_reminder ───────────────────────────────────────────────────
  server.tool(
    'snooze_reminder',
    'Snooze a reminder until a specific time or for a duration',
    {
      id: z.string(),
      until: z.string().optional(),
      duration: z.string().optional(),
    },
    async (params) => {
      const db = getDb();
      try {
        const rem = coreSnooze(db, params.id, params.until, params.duration);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              id: rem.id.slice(0, 8),
              content: rem.content,
              snoozed_until: rem.snoozed_until,
            }),
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      } finally {
        db.close();
      }
    },
  );

  // ── edit_reminder ─────────────────────────────────────────────────────
  server.tool(
    'edit_reminder',
    'Edit one or more fields of an existing reminder',
    {
      id: z.string(),
      content: z.string().optional(),
      context: z.string().optional(),
      priority: z.number().min(1).max(5).optional(),
      due: z.string().optional(),
      tags: z.string().optional(),
      add_tags: z.string().optional(),
      remove_tags: z.string().optional(),
      category: z.string().optional(),
      decay: z.string().optional(),
      max_fires: z.number().optional(),
      keywords: z.string().optional(),
      agent: z.string().optional(),
    },
    async (params) => {
      const db = getDb();
      try {
        const rem = coreEdit(db, params.id, {
          content: params.content,
          context: params.context,
          priority: params.priority,
          due: params.due,
          tags: params.tags,
          addTags: params.add_tags,
          removeTags: params.remove_tags,
          category: params.category,
          decay: params.decay,
          maxFires: params.max_fires,
          keywords: params.keywords,
          agent: params.agent,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              id: rem.id.slice(0, 8),
              reminder: rem,
            }),
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      } finally {
        db.close();
      }
    },
  );

  // ── delete_reminder ───────────────────────────────────────────────────
  server.tool(
    'delete_reminder',
    'Delete a reminder. Defaults to soft-delete (recoverable via undo)',
    {
      id: z.string().optional(),
      permanent: z.boolean().default(false),
      status: z.string().optional(),
      older_than: z.number().optional(),
    },
    async (params) => {
      const db = getDb();
      try {
        const result = coreDelete(db, {
          id: params.id,
          permanent: params.permanent,
          status: params.status,
          olderThan: params.older_than?.toString(),
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              deleted_count: result.count,
              permanent: result.permanent,
            }),
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      } finally {
        db.close();
      }
    },
  );

  // ── get_stats ─────────────────────────────────────────────────────────
  server.tool(
    'get_stats',
    'Get reminder statistics: counts by priority, trigger type, overdue, etc.',
    {},
    async () => {
      const db = getDb();
      try {
        const s = coreStats(db);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              active: s.totalActive,
              by_priority: Object.fromEntries(s.byPriority.map((p) => [p.label, p.count])),
              overdue: s.overdue,
              snoozed: s.snoozed,
              completed_this_week: s.completedWeek,
              expired: s.expired,
              by_trigger: Object.fromEntries(s.byTrigger.map((t) => [t.type, t.count])),
              next_due: s.nextDue,
              db_size_kb: Math.round(s.dbSizeBytes / 1024),
            }),
          }],
        };
      } finally {
        db.close();
      }
    },
  );

  // ── get_history ───────────────────────────────────────────────────────
  server.tool(
    'get_history',
    'View the audit trail of reminder changes',
    {
      id: z.string().optional(),
      limit: z.number().default(20),
    },
    async (params) => {
      const db = getDb();
      try {
        const entries = coreHistory(db, params.id, params.limit);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              count: entries.length,
              entries: entries.map((e) => ({
                history_id: e.id,
                reminder_id: e.reminder_id,
                reminder_id_short: e.reminder_id.slice(0, 8),
                action: e.action,
                timestamp: e.timestamp,
                source: e.source,
              })),
            }),
          }],
        };
      } finally {
        db.close();
      }
    },
  );

  // ── undo_change ───────────────────────────────────────────────────────
  server.tool(
    'undo_change',
    'Undo a specific change by reverting to the previous state',
    {
      history_id: z.number(),
    },
    async (params) => {
      const db = getDb();
      try {
        coreUndo(db, params.history_id);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ reverted_history_id: params.history_id }),
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      } finally {
        db.close();
      }
    },
  );

  // ── garbage_collect ───────────────────────────────────────────────────
  server.tool(
    'garbage_collect',
    'Remove old completed/expired/deleted reminders and vacuum the database',
    {
      older_than: z.number().default(30),
      dry_run: z.boolean().default(false),
    },
    async (params) => {
      const db = getDb();
      try {
        const result = coreGc(db, params.older_than, params.dry_run);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              removed_count: result.count,
              dry_run: params.dry_run,
            }),
          }],
        };
      } finally {
        db.close();
      }
    },
  );

  // ── export_reminders ──────────────────────────────────────────────────
  server.tool(
    'export_reminders',
    'Export reminders as JSON',
    {
      status: z.string().optional(),
    },
    async (params) => {
      const db = getDb();
      try {
        const data = coreExport(db, params.status);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(data),
          }],
        };
      } finally {
        db.close();
      }
    },
  );

  // ── import_reminders ──────────────────────────────────────────────────
  server.tool(
    'import_reminders',
    'Import reminders from JSON data',
    {
      data: z.string().describe('JSON string of export data'),
      merge: z.boolean().default(false),
      replace: z.boolean().default(false),
    },
    async (params) => {
      const db = getDb();
      try {
        const data: ExportData = JSON.parse(params.data);
        const result = coreImport(db, data, params.merge, params.replace);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              imported: result.imported,
              skipped: result.skipped,
              history_imported: result.historyImported,
            }),
          }],
        };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      } finally {
        db.close();
      }
    },
  );
}
