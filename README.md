# 🔔 agentrem

[![npm version](https://img.shields.io/npm/v/agentrem)](https://www.npmjs.com/package/agentrem)
[![Tests](https://img.shields.io/badge/tests-392%20passing-brightgreen)](https://github.com/fraction12/agentrem)
[![CI](https://github.com/fraction12/agentrem/actions/workflows/ci.yml/badge.svg)](https://github.com/fraction12/agentrem/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/node/v/agentrem)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

Structured reminders for AI agents. Persistent, searchable, works across sessions.

## Instant Start

```bash
npx agentrem add "Deploy to prod" --due tomorrow --priority 2
npx agentrem check
npx agentrem list
```

---

## For AI Agents

Copy this into your `CLAUDE.md` / `AGENTS.md` (or run `agentrem setup` to generate it):

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

---

## MCP Server

For Claude Desktop and any MCP client — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

No global install? Use `npx`:

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

Run `agentrem setup --mcp` to print this config. MCP tools: `add_reminder` · `check_reminders` · `list_reminders` · `search_reminders` · `complete_reminder` · `snooze_reminder` · `edit_reminder` · `delete_reminder` · `get_stats` · `undo_change` · `export_reminders` · `import_reminders`

---

## All Commands

| Command | Key Flags | Example |
|---------|-----------|---------|
| `add <content>` | `--due` `--priority` `--tags` `--trigger` `--recur` `--agent` `--dry-run` | `agentrem add "PR review" --due "+4h" --priority 2` |
| `check` | `--type` `--text` `--budget` `--format` `--json` `--escalate` `--agent` | `agentrem check --type time,session --budget 800 --json` |
| `list` | `--status` `--priority` `--tag` `--due` `--limit` `--json` `--all` `--agent` | `agentrem list --priority 1,2 --json` |
| `search <query>` | `--status` `--limit` `--json` | `agentrem search "deploy staging" --json` |
| `complete <id>` | `--notes` | `agentrem complete abc12345` |
| `snooze <id>` | `--until` `--for` | `agentrem snooze abc12345 --for 2h` |
| `edit <id>` | `--content` `--due` `--priority` `--tags` `--add-tags` `--remove-tags` | `agentrem edit abc12345 --priority 1` |
| `delete [id]` | `--permanent` `--status` `--older-than` | `agentrem delete abc12345 --permanent` |
| `stats` | `--json` | `agentrem stats --json` |
| `history [id]` | `--limit` `--json` | `agentrem history --limit 20 --json` |
| `undo <history_id>` | — | `agentrem undo 42` |
| `gc` | `--older-than` `--dry-run` | `agentrem gc --older-than 30` |
| `export` | `--out` `--status` | `agentrem export --out backup.json` |
| `import <file>` | `--merge` `--replace` `--dry-run` | `agentrem import backup.json --merge` |
| `watch` | `--interval` `--once` `--verbose` `--install` `--uninstall` `--status` `--agent` | `agentrem watch --install` |
| `setup` | `--mcp` | `agentrem setup` / `agentrem setup --mcp` |
| `doctor` | `--json` | `agentrem doctor` |
| `init` | `--force` | `agentrem init` |
| `quickstart` | — | `agentrem quickstart` |
| `schema` | — | `agentrem schema` |

**`--json` is available on `check`, `list`, `search`, `stats`, `history`, `doctor` — use it for structured output in your agent.**

### Trigger Types

| Type | Fires when... | Key flags |
|------|--------------|-----------|
| `time` | Due datetime is reached | `--due` |
| `keyword` | Message text matches | `--keywords`, `--match any\|all\|regex` |
| `condition` | Shell command output matches | `--check`, `--expect` |
| `session` | Every session start check | — |
| `heartbeat` | Every heartbeat check | — |
| `manual` | Explicit `check` only | — |

### Priority Levels

| Level | Label | Behavior |
|-------|-------|----------|
| 1 | 🔴 Critical | Always surfaced |
| 2 | 🟡 High | Surfaced within 60% budget |
| 3 | 🔵 Normal | Surfaced within 85% budget |
| 4 | ⚪ Low | Counted but not surfaced |
| 5 | 💤 Someday | Skipped entirely |

---

## Natural Language Dates

`--due`, `--until`, and `--decay` all accept natural language:

```bash
--due "now"                   # Immediately
--due "today"                 # Today at 23:59
--due "tomorrow"              # Tomorrow at 09:00
--due "in 5 minutes"
--due "in 2 hours"
--due "in 3 days"
--due "in 1 week"
--due "+5m"                   # Short relative
--due "+2h"
--due "+3d"
--due "+1w"
--due "2026-04-01T09:00:00"   # ISO datetime
--due "2026-04-01"            # ISO date
```

---

## Background Watcher

`agentrem watch` polls for due reminders and fires native OS notifications.

```bash
agentrem watch                           # Poll every 30s (foreground)
agentrem watch --interval 60             # Custom interval
agentrem watch --once                    # Single check and exit
agentrem watch --agent jarvis            # Watch for a specific agent
agentrem watch --verbose                 # Show poll log

# Install as OS service (auto-start on boot)
agentrem watch --install
agentrem watch --install --interval 60
agentrem watch --status
agentrem watch --uninstall
```

**Service files:** macOS → `~/Library/LaunchAgents/com.agentrem.watch.plist` · Linux → `~/.config/systemd/user/agentrem-watch.service` · Logs → `~/.agentrem/logs/watch.log`

---

## Native Notifications 🔔

On macOS, agentrem ships a bundled Swift app (`Agentrem.app`) so notifications appear with a bell icon — not a terminal icon.

| Priority | Sound |
|----------|-------|
| P1 🔴 Critical | Hero |
| P2 🟡 High | Ping |
| P3 🔵 Normal | Pop |

**Backend fallback order:** `Agentrem.app` → `terminal-notifier` → `osascript` → `console`

Notifications include a **Complete** button and cheeky overdue messages. To rebuild the Swift app: `npm run build:notify`

---

## Why agentrem?

```
# vs flat files / memory.md
agentrem check --json   # structured output your agent can parse; memory.md can't do that
```

- **Persistent across sessions** — SQLite-backed, survives restarts, not just in-context notes
- **Priority-aware + token budgets** — `check --budget 800` fits within any context window without overflow
- **Triggerable** — time, keyword, condition, session, heartbeat triggers; not just static lists
- **Agent-native** — `--json` everywhere, `--agent` namespacing, MCP server for chat clients

---

## Install

```bash
npm install -g agentrem
agentrem init
```

Then run `agentrem setup` to get your `CLAUDE.md` snippet, or `agentrem setup --mcp` for Claude Desktop.

MIT License
