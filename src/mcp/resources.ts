// ── MCP Resources ─────────────────────────────────────────────────────────
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../db.js';
import { coreList, coreStats, coreSchema } from '../core.js';
import { dtToIso } from '../date-parser.js';
import { PRIORITY_LABELS } from '../types.js';

export function registerResources(server: McpServer): void {
  // Active reminders
  server.resource(
    'active-reminders',
    'agentrem://reminders/active',
    { description: 'All active reminders sorted by priority', mimeType: 'application/json' },
    async () => {
      const db = getDb();
      try {
        const rows = coreList(db, { limit: 100 });
        return {
          contents: [{
            uri: 'agentrem://reminders/active',
            mimeType: 'application/json',
            text: JSON.stringify(rows, null, 2),
          }],
        };
      } finally {
        db.close();
      }
    },
  );

  // Overdue reminders
  server.resource(
    'overdue-reminders',
    'agentrem://reminders/overdue',
    { description: 'Overdue reminders', mimeType: 'application/json' },
    async () => {
      const db = getDb();
      try {
        const rows = coreList(db, { due: 'overdue', limit: 100 });
        return {
          contents: [{
            uri: 'agentrem://reminders/overdue',
            mimeType: 'application/json',
            text: JSON.stringify(rows, null, 2),
          }],
        };
      } finally {
        db.close();
      }
    },
  );

  // Stats
  server.resource(
    'stats',
    'agentrem://stats',
    { description: 'Reminder statistics', mimeType: 'application/json' },
    async () => {
      const db = getDb();
      try {
        const s = coreStats(db);
        return {
          contents: [{
            uri: 'agentrem://stats',
            mimeType: 'application/json',
            text: JSON.stringify(s, null, 2),
          }],
        };
      } finally {
        db.close();
      }
    },
  );

  // Schema
  server.resource(
    'schema',
    'agentrem://schema',
    { description: 'Database schema', mimeType: 'text/plain' },
    async () => {
      const db = getDb();
      try {
        const sqls = coreSchema(db);
        return {
          contents: [{
            uri: 'agentrem://schema',
            mimeType: 'text/plain',
            text: sqls.join('\n\n'),
          }],
        };
      } finally {
        db.close();
      }
    },
  );
}
