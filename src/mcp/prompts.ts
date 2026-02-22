// ── MCP Prompts ───────────────────────────────────────────────────────────
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {
  // Triage prompt
  server.prompt(
    'triage',
    'Triage and prioritize active reminders',
    {},
    async () => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Review all active reminders using the check_reminders and list_reminders tools.
For each reminder:
1. Check if it's still relevant
2. Suggest priority adjustments if needed
3. Identify any that should be completed, snoozed, or deleted
4. Flag any overdue items that need immediate attention

Present your findings as a prioritized action list.`,
        },
      }],
    }),
  );

  // Guided creation prompt
  server.prompt(
    'guided-creation',
    'Help create a well-structured reminder',
    { task: z.string().describe('What the reminder is about') },
    async ({ task }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Help me create a well-structured reminder for: "${task}"

Consider:
1. What trigger type is most appropriate? (time, keyword, session, heartbeat, condition, manual)
2. What priority level? (1=Critical, 2=High, 3=Normal, 4=Low, 5=Someday)
3. Should it have a due date?
4. Any relevant tags or categories?
5. Should it recur?
6. Any dependencies on other reminders?

Use the add_reminder tool to create it once we've determined the right parameters.`,
        },
      }],
    }),
  );

  // Session briefing prompt
  server.prompt(
    'session-briefing',
    'Get a briefing of all relevant reminders for this session',
    {},
    async () => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Start a session briefing:
1. Use check_reminders to find all triggered reminders
2. Use list_reminders to see upcoming items
3. Use get_stats to see the overall picture

Summarize:
- What needs immediate attention (overdue/critical)
- What's coming up today/tomorrow
- Any session-triggered notes
- Quick stats overview`,
        },
      }],
    }),
  );
}
