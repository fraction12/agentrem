// ── Types ──────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;
export const VERSION = '1.5.2';

export const PRIORITY_LABELS: Record<number, string> = {
  1: '🔴 Critical',
  2: '🟡 High',
  3: '🔵 Normal',
  4: '⚪ Low',
  5: '💤 Someday',
};

export const PRIORITY_COLORS: Record<number, string> = {
  1: '🔴',
  2: '🟡',
  3: '🔵',
  4: '⚪',
  5: '💤',
};

export const VALID_TRIGGERS = new Set([
  'time',
  'keyword',
  'condition',
  'session',
  'heartbeat',
  'manual',
]);

export const VALID_STATUSES = new Set([
  'active',
  'snoozed',
  'completed',
  'expired',
  'failed',
  'deleted',
]);

export const VALID_SOURCES = new Set(['agent', 'user', 'system']);

export type TriggerType =
  | 'time'
  | 'keyword'
  | 'condition'
  | 'session'
  | 'heartbeat'
  | 'manual';

export type ReminderStatus =
  | 'active'
  | 'snoozed'
  | 'completed'
  | 'expired'
  | 'failed'
  | 'deleted';

export type Source = 'agent' | 'user' | 'system';

export interface Reminder {
  id: string;
  content: string;
  context: string | null;
  trigger_type: TriggerType;
  trigger_at: string | null;
  trigger_config: string | null;
  priority: number;
  tags: string | null;
  category: string | null;
  status: ReminderStatus;
  snoozed_until: string | null;
  decay_at: string | null;
  escalation: string | null;
  fire_count: number;
  last_fired: string | null;
  max_fires: number | null;
  recur_rule: string | null;
  recur_parent_id: string | null;
  depends_on: string | null;
  related_ids: string | null;
  source: string;
  agent: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  notes: string | null;
}

export interface HistoryEntry {
  id: number;
  reminder_id: string;
  action: string;
  old_data: string | null;
  new_data: string | null;
  timestamp: string;
  source: string | null;
}

export interface KeywordConfig {
  keywords: string[];
  match: 'any' | 'all' | 'regex';
}

export interface ConditionConfig {
  check: string;
  expect: string;
}

export interface RecurRule {
  interval: number;
  unit: 'd' | 'w' | 'm';
}

export class AgentremError extends Error {
  constructor(
    message: string,
    public exitCode: number = 2,
  ) {
    super(message);
    this.name = 'AgentremError';
  }
}
