# 🧠 agentrem — Reminders for AI Agents

Structured reminders CLI + MCP server that gives AI agents persistent, priority-aware memory with triggers, recurrence, dependencies, and full-text search.

**Why?** AI agents forget between sessions. agentrem gives them a reminder system that persists across sessions, triggers on time/keywords/conditions, and fits within token budgets.

## Install

```bash
npm install -g agentrem
agentrem init
```

## Connect to Your AI Tool

### Claude Desktop / Claude Code

Add to your Claude Desktop MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agentrem": {
      "command": "agentrem-mcp",
      "args": []
    }
  }
}
```

Or if using `npx`:

```json
{
  "mcpServers": {
    "agentrem": {
      "command": "npx",
      "args": ["-y", "agentrem", "mcp"]
    }
  }
}
```

Restart Claude Desktop. You'll see agentrem tools available (add, check, list, search, complete, snooze, etc.).

### Cursor / Windsurf / Any MCP Client

Same pattern — point your MCP config to:

```bash
agentrem-mcp
# or
npx agentrem mcp
```

### OpenClaw

agentrem works as a CLI tool that OpenClaw agents call directly:

```bash
# Session start hook
agentrem check --type time,session --budget 800

# Keyword scanning on messages
agentrem check --type keyword --text "user message here"

# Periodic maintenance
agentrem check --escalate && agentrem gc --days 30
```

### Any Agent with Shell Access

If your agent can run shell commands, it can use agentrem directly:

```bash
agentrem add "Follow up on PR review" --due "+4h" --priority 2
agentrem check
agentrem complete <id>
```

## Quick Start

```bash
# Time-triggered reminder
agentrem add "Deploy v2.1 to staging" --due "+2h" --priority 2 --tags "deploy,staging"

# Keyword-triggered (fires when text matches)
agentrem add "Review security checklist" --trigger keyword --keywords "deploy,release" --match any

# Session reminder (fires every session start)
agentrem add "Check CI pipeline status" --trigger session

# Recurring weekly reminder
agentrem add "Weekly sync prep" --due "monday 9am" --recur 1w

# Check what's triggered
agentrem check

# List all active
agentrem list

# Full-text search
agentrem search "deploy staging"

# Complete
agentrem complete <id>
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize database (`--force` to recreate with backup) |
| `add <content>` | Create a reminder |
| `check` | Check for triggered reminders |
| `list` | List reminders with filters |
| `search <query>` | Full-text search across all fields |
| `complete <id>` | Mark done (auto-creates next if recurring) |
| `snooze <id>` | Snooze (`--until` or `--for`) |
| `edit <id>` | Edit reminder fields |
| `delete [id]` | Soft-delete (`--permanent` for hard delete) |
| `stats` | Show statistics |
| `gc` | Garbage collect old reminders |
| `history [id]` | View audit trail |
| `undo <history_id>` | Revert a change |
| `export` | Export to JSON |
| `import <file>` | Import from JSON |
| `schema` | Show database schema |

## Trigger Types

| Type | Fires when... | Key flags |
|------|--------------|-----------|
| `time` | Due datetime is reached | `--due` |
| `keyword` | Text matches keywords | `--keywords`, `--match` |
| `condition` | Shell command matches expected output | `--check`, `--expect` |
| `session` | Every session check | — |
| `heartbeat` | Every heartbeat check | — |
| `manual` | Only via explicit check | — |

## Priority Levels

| Level | Label | Behavior |
|-------|-------|----------|
| 1 | 🔴 Critical | Always surfaced |
| 2 | 🟡 High | Surfaced within 60% budget |
| 3 | 🔵 Normal | Surfaced within 85% budget |
| 4 | ⚪ Low | Counted but not surfaced |
| 5 | 💤 Someday | Skipped entirely |

## Features

- **Recurrence** — `--recur 1d/2w/1m` auto-creates next instance on completion
- **Dependencies** — `--depends-on <id>` blocks until dependency is completed
- **Decay** — `--decay <datetime>` auto-expires after a date
- **Max fires** — `--max-fires <n>` auto-completes after N triggers
- **Escalation** — `check --escalate` promotes overdue (P3→P2 after 48h, P2→P1 after 24h)
- **Token budget** — `check --budget <n>` limits output to fit context windows
- **Full-text search** — FTS5 across content, context, tags, notes
- **Undo** — revert any change via audit history
- **Multi-agent** — `--agent <name>` isolates reminders per agent
- **Export/Import** — JSON backup with merge and replace modes

## MCP Server

The MCP server exposes all functionality as tools, resources, and prompts for AI clients.

### Tools
`add_reminder` · `check_reminders` · `list_reminders` · `search_reminders` · `complete_reminder` · `snooze_reminder` · `edit_reminder` · `delete_reminder` · `get_stats` · `get_history` · `undo_change` · `garbage_collect` · `export_reminders` · `import_reminders`

### Resources
- `agentrem://reminders/active` — all active reminders
- `agentrem://reminders/overdue` — overdue reminders
- `agentrem://stats` — statistics
- `agentrem://schema` — database schema

### Prompts
- `triage` — review and prioritize active reminders
- `guided-creation` — interactive reminder creation
- `session-briefing` — session start briefing

## Development

```bash
git clone https://github.com/fraction12/agentrem.git
cd agentrem
npm install
npm run build
npm test          # 292 tests
```

## License

MIT
