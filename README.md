# agentrem

Structured reminders for AI agents. A CLI + MCP server that gives agents persistent, priority-aware memory with triggers, recurrence, dependencies, and full-text search.

## Install

```bash
npm install
npm run build
```

## Quick Start

```bash
# Initialize the database
agentrem init

# Add a time-triggered reminder
agentrem add "Deploy v2.1 to staging" --due "+2h" --priority 2 --tags "deploy,staging"

# Add a keyword-triggered reminder
agentrem add "Review security checklist" --trigger keyword --keywords "deploy,release" --match any

# Add a session reminder (fires every session start)
agentrem add "Check CI pipeline status" --trigger session

# Check for triggered reminders
agentrem check

# List active reminders
agentrem list

# Complete a reminder
agentrem complete <id>
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize the database (`--force` to recreate with backup) |
| `add <content>` | Create a reminder |
| `check` | Check for triggered reminders |
| `list` | List reminders with filters |
| `search <query>` | Full-text search across content, context, tags, notes |
| `complete <id>` | Mark a reminder as completed |
| `snooze <id>` | Snooze a reminder (`--until` or `--for`) |
| `edit <id>` | Edit reminder fields |
| `delete [id]` | Soft-delete a reminder (`--permanent` for hard delete) |
| `stats` | Show statistics |
| `gc` | Garbage collect old completed/expired/deleted reminders |
| `history [id]` | View audit trail |
| `undo <history_id>` | Revert a specific change |
| `export` | Export reminders to JSON |
| `import <file>` | Import reminders from JSON |
| `schema` | Show database schema |

## Trigger Types

| Type | Fires when... | Required flags |
|------|--------------|----------------|
| `time` | Due datetime is reached | `--due` |
| `keyword` | Text matches keywords | `--keywords`, optional `--match` |
| `condition` | Shell command output matches expected | `--check`, `--expect` |
| `session` | Every session check | (none) |
| `heartbeat` | Every heartbeat check | (none) |
| `manual` | Only via explicit check | (none) |

## Priority Levels

| Level | Label | Behavior in `check` |
|-------|-------|---------------------|
| 1 | Critical | Always included |
| 2 | High | Included within 60% budget |
| 3 | Normal | Included within 85% budget |
| 4 | Low | Counted but not included |
| 5 | Someday | Skipped entirely |

## Features

- **Recurrence** &mdash; `--recur 1d` / `2w` / `1m` auto-creates the next instance on completion
- **Dependencies** &mdash; `--depends-on <id>` blocks triggering until the dependency is completed
- **Decay** &mdash; `--decay <datetime>` auto-expires reminders after a date
- **Max fires** &mdash; `--max-fires <n>` auto-completes after N triggers
- **Escalation** &mdash; `check --escalate` promotes overdue reminders (P3 &rarr; P2 after 48h, P2 &rarr; P1 after 24h)
- **Token budget** &mdash; `check --budget <n>` limits output to fit context windows
- **Full-text search** &mdash; FTS5 across content, context, tags, and notes
- **Undo** &mdash; Revert any change via the audit history
- **Multi-agent** &mdash; `--agent <name>` isolates reminders per agent
- **Export/Import** &mdash; JSON backup with merge and replace modes

## MCP Server

Run as a Model Context Protocol server for integration with AI tools:

```bash
npm run mcp
# or
node dist/mcp/server.js
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `add_reminder` | Create a reminder |
| `check_reminders` | Check for triggered reminders |
| `list_reminders` | List with filters |
| `search_reminders` | Full-text search |
| `complete_reminder` | Complete a reminder |
| `snooze_reminder` | Snooze until a time or for a duration |
| `edit_reminder` | Edit fields |
| `delete_reminder` | Delete (soft or permanent) |
| `get_stats` | Statistics |
| `get_history` | Audit trail |
| `undo_change` | Revert a change |
| `garbage_collect` | Clean up old reminders |
| `export_reminders` | Export as JSON |
| `import_reminders` | Import from JSON |

### MCP Resources

| URI | Description |
|-----|-------------|
| `agentrem://reminders/active` | All active reminders |
| `agentrem://reminders/overdue` | Overdue reminders |
| `agentrem://stats` | Reminder statistics |
| `agentrem://schema` | Database schema |

### MCP Prompts

| Prompt | Description |
|--------|-------------|
| `triage` | Review and prioritize active reminders |
| `guided-creation` | Interactive reminder creation |
| `session-briefing` | Session start briefing |

## Development

```bash
npm run dev          # Watch mode
npm test             # Run tests
npm run build        # Compile TypeScript
```

## License

MIT
