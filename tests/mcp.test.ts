import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { initDb } from '../src/db.js';
import { dtToIso } from '../src/date-parser.js';

let tmpDir: string;
let dbPath: string;
let origDir: string | undefined;
let origDb: string | undefined;
let client: Client;

function pastIso(hoursAgo: number): string {
  const d = new Date();
  d.setHours(d.getHours() - hoursAgo);
  return dtToIso(d);
}

function futureIso(hoursAhead: number): string {
  const d = new Date();
  d.setHours(d.getHours() + hoursAhead);
  return dtToIso(d);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrem-mcp-test-'));
  dbPath = path.join(tmpDir, 'reminders.db');
  origDir = process.env['AGENTREM_DIR'];
  origDb = process.env['AGENTREM_DB'];
  process.env['AGENTREM_DIR'] = tmpDir;
  process.env['AGENTREM_DB'] = dbPath;
  initDb(false, dbPath);

  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
});

afterEach(async () => {
  await client.close();
  if (origDir !== undefined) process.env['AGENTREM_DIR'] = origDir;
  else delete process.env['AGENTREM_DIR'];
  if (origDb !== undefined) process.env['AGENTREM_DB'] = origDb;
  else delete process.env['AGENTREM_DB'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function parseResult(result: any): any {
  const text = result.content[0].text;
  return JSON.parse(text);
}

// ── add_reminder ─────────────────────────────────────────────────────────────

describe('add_reminder tool', () => {
  it('creates a time-triggered reminder', async () => {
    const result = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'MCP test reminder', due: '+1h' },
    });
    const data = parseResult(result);
    expect(data.id).toBeTruthy();
    expect(data.content).toBe('MCP test reminder');
    expect(data.trigger_type).toBe('time');
    expect(data.status).toBe('active');
  });

  it('creates a session-triggered reminder', async () => {
    const result = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Session note', trigger: 'session' },
    });
    const data = parseResult(result);
    expect(data.trigger_type).toBe('session');
  });

  it('creates with custom priority', async () => {
    const result = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Critical', due: '+1h', priority: 1 },
    });
    const data = parseResult(result);
    expect(data.priority).toBe(1);
    expect(data.priority_label).toContain('Critical');
  });

  it('creates a keyword-triggered reminder', async () => {
    const result = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Deploy alert', trigger: 'keyword', keywords: 'deploy,release' },
    });
    const data = parseResult(result);
    expect(data.trigger_type).toBe('keyword');
  });

  it('returns error for missing due date on time trigger', async () => {
    const result = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'No due', trigger: 'time' },
    });
    expect((result as any).isError).toBe(true);
    expect(result.content[0].text).toContain('Error');
  });

  it('returns id_short (first 8 chars)', async () => {
    const result = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Short ID', due: '+1h' },
    });
    const data = parseResult(result);
    expect(data.id_short).toBe(data.id.slice(0, 8));
  });

  it('creates with tags', async () => {
    const result = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Tagged', due: '+1h', tags: 'work,urgent' },
    });
    const data = parseResult(result);
    expect(data.id).toBeTruthy();
  });

  it('creates with recurrence', async () => {
    const result = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Daily', due: '+1h', recur: '1d' },
    });
    const data = parseResult(result);
    expect(data.id).toBeTruthy();
  });
});

// ── check_reminders ──────────────────────────────────────────────────────────

describe('check_reminders tool', () => {
  it('returns empty when no reminders exist', async () => {
    const result = await client.callTool({
      name: 'check_reminders',
      arguments: {},
    });
    const data = parseResult(result);
    expect(data.triggered_count).toBe(0);
    expect(data.included_count).toBe(0);
  });

  it('triggers overdue reminders', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Overdue', due: pastIso(2) },
    });
    const result = await client.callTool({
      name: 'check_reminders',
      arguments: {},
    });
    const data = parseResult(result);
    expect(data.triggered_count).toBeGreaterThanOrEqual(1);
    expect(data.included_count).toBeGreaterThanOrEqual(1);
  });

  it('triggers keyword reminders with text', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Deploy alert', trigger: 'keyword', keywords: 'deploy' },
    });
    const result = await client.callTool({
      name: 'check_reminders',
      arguments: { text: 'time to deploy' },
    });
    const data = parseResult(result);
    expect(data.included_count).toBe(1);
  });

  it('filters by trigger type', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Session', trigger: 'session' },
    });
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Heartbeat', trigger: 'heartbeat' },
    });
    const result = await client.callTool({
      name: 'check_reminders',
      arguments: { trigger_types: 'session' },
    });
    const data = parseResult(result);
    expect(data.included_count).toBe(1);
  });

  it('includes overflow counts', async () => {
    const result = await client.callTool({
      name: 'check_reminders',
      arguments: {},
    });
    const data = parseResult(result);
    expect(data.overflow).toBeDefined();
    expect(typeof data.overflow.high).toBe('number');
    expect(typeof data.overflow.normal).toBe('number');
    expect(typeof data.overflow.low).toBe('number');
  });
});

// ── list_reminders ───────────────────────────────────────────────────────────

describe('list_reminders tool', () => {
  it('lists active reminders', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Active one', due: '+1h' },
    });
    const result = await client.callTool({
      name: 'list_reminders',
      arguments: {},
    });
    const data = parseResult(result);
    expect(data.count).toBe(1);
    expect(data.reminders[0].content).toBe('Active one');
  });

  it('filters by status', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'To complete', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    await client.callTool({
      name: 'complete_reminder',
      arguments: { id },
    });
    const result = await client.callTool({
      name: 'list_reminders',
      arguments: { status: 'completed' },
    });
    const data = parseResult(result);
    expect(data.count).toBe(1);
  });

  it('filters by priority', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'P1', due: '+1h', priority: 1 },
    });
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'P3', due: '+1h', priority: 3 },
    });
    const result = await client.callTool({
      name: 'list_reminders',
      arguments: { priority: '1' },
    });
    const data = parseResult(result);
    expect(data.count).toBe(1);
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await client.callTool({
        name: 'add_reminder',
        arguments: { content: `Item ${i}`, due: '+1h' },
      });
    }
    const result = await client.callTool({
      name: 'list_reminders',
      arguments: { limit: 2 },
    });
    const data = parseResult(result);
    expect(data.count).toBe(2);
  });

  it('shows all with show_all=true', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'To complete', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    await client.callTool({
      name: 'complete_reminder',
      arguments: { id },
    });
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Active', due: '+2h' },
    });
    const result = await client.callTool({
      name: 'list_reminders',
      arguments: { show_all: true },
    });
    const data = parseResult(result);
    expect(data.count).toBe(2);
  });

  it('includes priority_label in results', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Labeled', due: '+1h', priority: 2 },
    });
    const result = await client.callTool({
      name: 'list_reminders',
      arguments: {},
    });
    const data = parseResult(result);
    expect(data.reminders[0].priority_label).toContain('High');
  });
});

// ── search_reminders ─────────────────────────────────────────────────────────

describe('search_reminders tool', () => {
  it('finds reminders by content', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Deploy production server', due: '+1h' },
    });
    const result = await client.callTool({
      name: 'search_reminders',
      arguments: { query: 'deploy' },
    });
    const data = parseResult(result);
    expect(data.count).toBe(1);
    expect(data.query).toBe('deploy');
  });

  it('returns empty for non-matching query', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Something', due: '+1h' },
    });
    const result = await client.callTool({
      name: 'search_reminders',
      arguments: { query: 'nonexistent' },
    });
    const data = parseResult(result);
    expect(data.count).toBe(0);
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await client.callTool({
        name: 'add_reminder',
        arguments: { content: `Server task ${i}`, due: '+1h' },
      });
    }
    const result = await client.callTool({
      name: 'search_reminders',
      arguments: { query: 'server', limit: 2 },
    });
    const data = parseResult(result);
    expect(data.count).toBe(2);
  });
});

// ── complete_reminder ────────────────────────────────────────────────────────

describe('complete_reminder tool', () => {
  it('completes a reminder', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Complete me', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    const result = await client.callTool({
      name: 'complete_reminder',
      arguments: { id },
    });
    const data = parseResult(result);
    expect(data.completed.id).toBe(id);
    expect(data.next_recurrence).toBeNull();
  });

  it('returns next recurrence for recurring reminders', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Daily', due: '+1h', recur: '1d' },
    });
    const id = parseResult(addResult).id;
    const result = await client.callTool({
      name: 'complete_reminder',
      arguments: { id },
    });
    const data = parseResult(result);
    expect(data.next_recurrence).not.toBeNull();
    expect(data.next_recurrence.trigger_at).toBeTruthy();
  });

  it('returns error for nonexistent ID', async () => {
    const result = await client.callTool({
      name: 'complete_reminder',
      arguments: { id: 'nonexistent' },
    });
    expect((result as any).isError).toBe(true);
  });

  it('completes with notes', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Note test', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    const result = await client.callTool({
      name: 'complete_reminder',
      arguments: { id, notes: 'Done well' },
    });
    const data = parseResult(result);
    expect(data.completed).toBeTruthy();
  });
});

// ── snooze_reminder ──────────────────────────────────────────────────────────

describe('snooze_reminder tool', () => {
  it('snoozes with until parameter', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Snooze me', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    const result = await client.callTool({
      name: 'snooze_reminder',
      arguments: { id, until: futureIso(4) },
    });
    const data = parseResult(result);
    expect(data.snoozed_until).toBeTruthy();
  });

  it('snoozes with duration parameter', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Snooze duration', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    const result = await client.callTool({
      name: 'snooze_reminder',
      arguments: { id, duration: '2h' },
    });
    const data = parseResult(result);
    expect(data.snoozed_until).toBeTruthy();
  });

  it('returns error for nonexistent reminder', async () => {
    const result = await client.callTool({
      name: 'snooze_reminder',
      arguments: { id: 'nonexistent', until: futureIso(4) },
    });
    expect((result as any).isError).toBe(true);
  });
});

// ── edit_reminder ────────────────────────────────────────────────────────────

describe('edit_reminder tool', () => {
  it('edits content', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Old', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    const result = await client.callTool({
      name: 'edit_reminder',
      arguments: { id, content: 'New content' },
    });
    const data = parseResult(result);
    expect(data.reminder.content).toBe('New content');
  });

  it('edits priority', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Edit prio', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    const result = await client.callTool({
      name: 'edit_reminder',
      arguments: { id, priority: 1 },
    });
    const data = parseResult(result);
    expect(data.reminder.priority).toBe(1);
  });

  it('adds tags', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Tags', due: '+1h', tags: 'existing' },
    });
    const id = parseResult(addResult).id;
    const result = await client.callTool({
      name: 'edit_reminder',
      arguments: { id, add_tags: 'new' },
    });
    const data = parseResult(result);
    expect(data.reminder.tags).toContain('existing');
    expect(data.reminder.tags).toContain('new');
  });

  it('returns error for nonexistent ID', async () => {
    const result = await client.callTool({
      name: 'edit_reminder',
      arguments: { id: 'nonexistent', content: 'x' },
    });
    expect((result as any).isError).toBe(true);
  });
});

// ── delete_reminder ──────────────────────────────────────────────────────────

describe('delete_reminder tool', () => {
  it('soft deletes a reminder', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Delete me', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    const result = await client.callTool({
      name: 'delete_reminder',
      arguments: { id },
    });
    const data = parseResult(result);
    expect(data.deleted_count).toBe(1);
    expect(data.permanent).toBe(false);
  });

  it('permanently deletes a reminder', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Perm delete', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    const result = await client.callTool({
      name: 'delete_reminder',
      arguments: { id, permanent: true },
    });
    const data = parseResult(result);
    expect(data.deleted_count).toBe(1);
    expect(data.permanent).toBe(true);
  });

  it('bulk deletes by status', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'To complete', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    await client.callTool({
      name: 'complete_reminder',
      arguments: { id },
    });
    const result = await client.callTool({
      name: 'delete_reminder',
      arguments: { status: 'completed', permanent: true },
    });
    const data = parseResult(result);
    expect(data.deleted_count).toBe(1);
  });

  it('returns error for nonexistent ID', async () => {
    const result = await client.callTool({
      name: 'delete_reminder',
      arguments: { id: 'nonexistent' },
    });
    expect((result as any).isError).toBe(true);
  });
});

// ── get_stats ────────────────────────────────────────────────────────────────

describe('get_stats tool', () => {
  it('returns stats for empty database', async () => {
    const result = await client.callTool({
      name: 'get_stats',
      arguments: {},
    });
    const data = parseResult(result);
    expect(data.active).toBe(0);
    expect(data.overdue).toBe(0);
    expect(data.snoozed).toBe(0);
  });

  it('returns correct active count', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Active 1', due: '+1h' },
    });
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Active 2', due: '+2h' },
    });
    const result = await client.callTool({
      name: 'get_stats',
      arguments: {},
    });
    const data = parseResult(result);
    expect(data.active).toBe(2);
  });

  it('includes db_size_kb', async () => {
    const result = await client.callTool({
      name: 'get_stats',
      arguments: {},
    });
    const data = parseResult(result);
    expect(typeof data.db_size_kb).toBe('number');
  });

  it('includes by_priority and by_trigger', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Stats test', due: '+1h' },
    });
    const result = await client.callTool({
      name: 'get_stats',
      arguments: {},
    });
    const data = parseResult(result);
    expect(data.by_priority).toBeDefined();
    expect(data.by_trigger).toBeDefined();
  });
});

// ── get_history ──────────────────────────────────────────────────────────────

describe('get_history tool', () => {
  it('returns history entries', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'History test', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    const result = await client.callTool({
      name: 'get_history',
      arguments: { id },
    });
    const data = parseResult(result);
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(data.entries[0].action).toBe('created');
  });

  it('returns all history without ID', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'H1', due: '+1h' },
    });
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'H2', due: '+2h' },
    });
    const result = await client.callTool({
      name: 'get_history',
      arguments: {},
    });
    const data = parseResult(result);
    expect(data.count).toBe(2);
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await client.callTool({
        name: 'add_reminder',
        arguments: { content: `Item ${i}`, due: '+1h' },
      });
    }
    const result = await client.callTool({
      name: 'get_history',
      arguments: { limit: 2 },
    });
    const data = parseResult(result);
    expect(data.count).toBe(2);
  });

  it('includes reminder_id_short', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Short ID', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    const result = await client.callTool({
      name: 'get_history',
      arguments: { id },
    });
    const data = parseResult(result);
    expect(data.entries[0].reminder_id_short).toBe(id.slice(0, 8));
  });
});

// ── undo_change ──────────────────────────────────────────────────────────────

describe('undo_change tool', () => {
  it('reverts an edit', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Original', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    await client.callTool({
      name: 'edit_reminder',
      arguments: { id, content: 'Changed' },
    });
    // Get history to find the update entry
    const histResult = await client.callTool({
      name: 'get_history',
      arguments: { id },
    });
    const histData = parseResult(histResult);
    const updateEntry = histData.entries.find((e: any) => e.action === 'updated');
    const result = await client.callTool({
      name: 'undo_change',
      arguments: { history_id: updateEntry.history_id },
    });
    const data = parseResult(result);
    expect(data.reverted_history_id).toBe(updateEntry.history_id);
  });

  it('returns error for nonexistent history ID', async () => {
    const result = await client.callTool({
      name: 'undo_change',
      arguments: { history_id: 99999 },
    });
    expect((result as any).isError).toBe(true);
  });

  it('returns error when trying to undo creation', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Created', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    const histResult = await client.callTool({
      name: 'get_history',
      arguments: { id },
    });
    const histData = parseResult(histResult);
    const createEntry = histData.entries.find((e: any) => e.action === 'created');
    const result = await client.callTool({
      name: 'undo_change',
      arguments: { history_id: createEntry.history_id },
    });
    expect((result as any).isError).toBe(true);
  });
});

// ── garbage_collect ──────────────────────────────────────────────────────────

describe('garbage_collect tool', () => {
  it('returns zero for empty database', async () => {
    const result = await client.callTool({
      name: 'garbage_collect',
      arguments: {},
    });
    const data = parseResult(result);
    expect(data.removed_count).toBe(0);
  });

  it('supports dry_run', async () => {
    const result = await client.callTool({
      name: 'garbage_collect',
      arguments: { dry_run: true },
    });
    const data = parseResult(result);
    expect(data.dry_run).toBe(true);
  });

  it('accepts older_than parameter', async () => {
    const result = await client.callTool({
      name: 'garbage_collect',
      arguments: { older_than: 7 },
    });
    const data = parseResult(result);
    expect(data.removed_count).toBe(0);
  });
});

// ── export_reminders ─────────────────────────────────────────────────────────

describe('export_reminders tool', () => {
  it('exports empty database', async () => {
    const result = await client.callTool({
      name: 'export_reminders',
      arguments: {},
    });
    const data = parseResult(result);
    expect(data.reminder_count).toBe(0);
    expect(data.schema_version).toBe(1);
  });

  it('exports all reminders', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Export 1', due: '+1h' },
    });
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Export 2', due: '+2h' },
    });
    const result = await client.callTool({
      name: 'export_reminders',
      arguments: {},
    });
    const data = parseResult(result);
    expect(data.reminder_count).toBe(2);
  });

  it('filters by status', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Active', due: '+1h' },
    });
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'To complete', due: '+2h' },
    });
    const id = parseResult(addResult).id;
    await client.callTool({
      name: 'complete_reminder',
      arguments: { id },
    });
    const result = await client.callTool({
      name: 'export_reminders',
      arguments: { status: 'active' },
    });
    const data = parseResult(result);
    expect(data.reminder_count).toBe(1);
  });
});

// ── import_reminders ─────────────────────────────────────────────────────────

describe('import_reminders tool', () => {
  it('imports reminders from JSON string', async () => {
    await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'To export', due: '+1h' },
    });
    const exportResult = await client.callTool({
      name: 'export_reminders',
      arguments: {},
    });
    const exportData = parseResult(exportResult);

    // Clear by replacing
    const result = await client.callTool({
      name: 'import_reminders',
      arguments: { data: JSON.stringify(exportData), replace: true },
    });
    const data = parseResult(result);
    expect(data.imported).toBe(1);
  });

  it('merge mode skips existing', async () => {
    const addResult = await client.callTool({
      name: 'add_reminder',
      arguments: { content: 'Existing', due: '+1h' },
    });
    const id = parseResult(addResult).id;
    const exportResult = await client.callTool({
      name: 'export_reminders',
      arguments: {},
    });
    const exportData = parseResult(exportResult);
    const result = await client.callTool({
      name: 'import_reminders',
      arguments: { data: JSON.stringify(exportData), merge: true },
    });
    const data = parseResult(result);
    expect(data.skipped).toBe(1);
  });

  it('returns error for invalid JSON', async () => {
    const result = await client.callTool({
      name: 'import_reminders',
      arguments: { data: 'not json' },
    });
    expect((result as any).isError).toBe(true);
  });
});

// ── Tool discovery ───────────────────────────────────────────────────────────

describe('Tool discovery', () => {
  it('lists all expected tools', async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    const expected = [
      'add_reminder',
      'check_reminders',
      'list_reminders',
      'search_reminders',
      'complete_reminder',
      'snooze_reminder',
      'edit_reminder',
      'delete_reminder',
      'get_stats',
      'get_history',
      'undo_change',
      'garbage_collect',
      'export_reminders',
      'import_reminders',
    ];
    for (const name of expected) {
      expect(toolNames).toContain(name);
    }
  });

  it('each tool has a description', async () => {
    const tools = await client.listTools();
    for (const tool of tools.tools) {
      expect(tool.description).toBeTruthy();
    }
  });
});

// ── Resource discovery ───────────────────────────────────────────────────────

describe('Resource discovery', () => {
  it('lists expected resources', async () => {
    const resources = await client.listResources();
    const uris = resources.resources.map((r) => r.uri);
    expect(uris).toContain('agentrem://reminders/active');
    expect(uris).toContain('agentrem://reminders/overdue');
    expect(uris).toContain('agentrem://stats');
    expect(uris).toContain('agentrem://schema');
  });
});

// ── Prompt discovery ─────────────────────────────────────────────────────────

describe('Prompt discovery', () => {
  it('lists expected prompts', async () => {
    const prompts = await client.listPrompts();
    const names = prompts.prompts.map((p) => p.name);
    expect(names).toContain('triage');
    expect(names).toContain('guided-creation');
    expect(names).toContain('session-briefing');
  });
});
