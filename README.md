# 🧠 agentrem — Reminders for AI Agents

[![npm version](https://img.shields.io/npm/v/agentrem)](https://www.npmjs.com/package/agentrem)
[![CI](https://github.com/fraction12/agentrem/actions/workflows/ci.yml/badge.svg)](https://github.com/fraction12/agentrem/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-392%20passing-brightgreen)](https://github.com/fraction12/agentrem)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/node/v/agentrem)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

Structured reminders CLI + MCP server that gives AI agents persistent, priority-aware memory with triggers, recurrence, dependencies, full-text search, and native OS notifications.

**Why?** AI agents forget between sessions. agentrem gives them a reminder system that persists across sessions, triggers on time/keywords/conditions, fires native desktop notifications, and fits within token budgets.

## Install

```bash
npm install -g agentrem
agentrem init
```

## Connect to Your AI Tool

### Claude Code (Recommended)

Claude Code has shell access, so it works out of the box — no MCP config needed.

**1. Install globally:**

```bash
npm install -g agentrem
agentrem init
```

**2. Add to your `CLAUDE.md`:**

```markdown
## Reminders
You have access to `agentrem` CLI for persistent reminders across sessions.

### On every session start, run:
agentrem check --type time,session --budget 800

### When the user says "remind me", "don't forget", "follow up", or "next time":
agentrem add "<content>" --due "<when>" --priority <1-5> --tags "<tags>"

### Key commands:
- `agentrem add` — create a reminder
- `agentrem check` — see what's triggered/due
- `agentrem list` — list all active reminders
- `agentrem search <query>` — full-text search
- `agentrem complete <id>` — mark done
- `agentrem snooze <id> --for 2h` — snooze
- `agentrem --help` — full reference
```

**3. That's it.** Next time you tell Claude Code "remind me to deploy tomorrow at 9am", it runs:

```bash
agentrem add "Deploy to production" --due "tomorrow" --priority 2
```

Next session, `agentrem check` surfaces it automatically.

### Claude Desktop (MCP)

For Claude Desktop (the chat app), use the MCP server:

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Or without global install:

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

Same MCP pattern — point your config to `agentrem-mcp` or `npx agentrem mcp`.

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
# Run the interactive walkthrough (first time)
agentrem quickstart

# Time-triggered reminder
agentrem add "Deploy v2.1 to staging" --due "+2h" --priority 2 --tags "deploy,staging"

# Natural language dates
agentrem add "Send weekly report" --due "tomorrow" --priority 2
agentrem add "Check alerts" --due "in 30 minutes"
agentrem add "Quarterly review" --due "2026-04-01" --priority 3

# Keyword-triggered (fires when text matches)
agentrem add "Review security checklist" --trigger keyword --keywords "deploy,release" --match any

# Session reminder (fires every session start)
agentrem add "Check CI pipeline status" --trigger session

# Recurring weekly reminder
agentrem add "Weekly sync prep" --due "2026-02-24T09:00:00" --recur 1w

# Check what's triggered
agentrem check

# List all active
agentrem list

# Full-text search
agentrem search "deploy staging"

# Complete
agentrem complete <id>

# Run self-diagnostics
agentrem doctor
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
| `watch` | Background daemon: poll + fire OS notifications |
| `doctor` | Self-diagnostic check |
| `quickstart` | Interactive first-run walkthrough |
| `setup` | Print CLAUDE.md snippet (`--mcp` for MCP config) |

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

## Natural Language Dates

`--due` (and `--until`, `--decay`) accept many formats:

```bash
--due "now"                  # Immediately
--due "today"                # Today at 23:59
--due "tomorrow"             # Tomorrow at 09:00
--due "in 5 minutes"         # Relative natural language
--due "in 2 hours"
--due "in 3 days"
--due "in 1 week"
--due "+5m"                  # Short relative
--due "+2h"
--due "+3d"
--due "+1w"
--due "2026-02-22T09:00:00"  # ISO datetime
--due "2026-02-22"           # ISO date
```

## Background Watcher

`agentrem watch` polls for due reminders and fires native OS notifications. Perfect for always-on setups or running as a background service.

```bash
# Run in foreground
agentrem watch                           # Poll every 30s
agentrem watch --interval 60             # Custom interval
agentrem watch --agent jarvis            # Watch for a specific agent
agentrem watch --once                    # Single check, then exit
agentrem watch --verbose                 # Show poll log

# Service management (auto-start on boot)
agentrem watch --install                 # Install as launchd/systemd service
agentrem watch --install --interval 60   # Install with custom interval
agentrem watch --uninstall               # Remove service
agentrem watch --status                  # Check if installed and running
```

The watcher uses a 5-minute per-reminder cooldown to avoid notification spam. It checks all trigger types (`time`, `heartbeat`, `session`, `condition`) and runs escalation automatically.

**Service files:**
- macOS: `~/Library/LaunchAgents/com.agentrem.watch.plist`
- Linux: `~/.config/systemd/user/agentrem-watch.service`
- Logs: `~/.agentrem/logs/watch.log`

## Native Notifications 🔔

agentrem ships a custom Swift app (`Agentrem.app`) in `assets/`. On macOS, notifications show:

- **App name:** "agentrem" with a 🔔 bell icon (not a terminal icon)
- **Priority-based sounds:** P1=Hero, P2=Ping, P3=Pop
- **Cheeky overdue messages:** e.g. "so... you forgot about this one 😅"

**Notification backend priority:**

| Backend | When used |
|---------|-----------|
| `Agentrem.app` | Preferred on macOS (bundled, no dependencies) |
| `terminal-notifier` | Fallback if app is missing |
| `osascript` | macOS AppleScript fallback |
| `console` | Linux / last resort |

To rebuild the Swift app from source:

```bash
npm run build:notify
```

## Features

- **Natural language dates** — `--due "tomorrow"`, `"in 5 minutes"`, `"+2h"`, ISO formats
- **Background watcher** — `agentrem watch` daemon with OS service management
- **Native notifications** — custom macOS app with bell icon, priority sounds, cheeky overdue messages
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
- **Doctor** — `agentrem doctor` runs self-diagnostics
- **Quickstart** — `agentrem quickstart` for interactive first-run setup

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
npm test          # 392 tests

# Rebuild native notification app (Swift)
npm run build:notify
```

## License

MIT
