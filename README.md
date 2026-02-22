# 🔔 agentrem

[![npm version](https://img.shields.io/npm/v/agentrem)](https://www.npmjs.com/package/agentrem)
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
- `agentrem check --watch` — block until next reminder fires
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

Run `agentrem setup --mcp` to print this config. MCP tools: `add_reminder` · `check_reminders` · `list_reminders` · `search_reminders` · `complete_reminder` · `snooze_reminder` · `edit_reminder` · `delete_reminder` · `get_stats` · `get_history` · `undo_change` · `garbage_collect` · `export_reminders` · `import_reminders`

---

## All Commands

| Command | Key Flags | Example |
|---------|-----------|---------|
| `add <content>` | `--due` `--priority` `--tags` `--trigger` `--recur` `--agent` `--context` `--category` `--depends-on` `--dry-run` | `agentrem add "PR review" --due "+4h" --priority 2` |
| `check` | `--type` `--text` `--budget` `--format` `--json` `--escalate` `--agent` `--dry-run` | `agentrem check --type time,session --budget 800 --json` |
| `check --watch` | `--timeout` `--json` `--type` `--agent` | `agentrem check --watch --timeout 300 --json` |
| `list` | `--status` `--priority` `--tag` `--due` `--limit` `--json` `--all` `--agent` `--category` `--trigger` `--format` | `agentrem list --priority 1,2 --json` |
| `search <query>` | `--status` `--limit` `--json` | `agentrem search "deploy staging" --json` |
| `complete <id>` | `--notes` | `agentrem complete abc12345` |
| `snooze <id>` | `--until` `--for` | `agentrem snooze abc12345 --for 2h` |
| `edit <id>` | `--content` `--due` `--priority` `--tags` `--add-tags` `--remove-tags` `--context` `--category` `--agent` | `agentrem edit abc12345 --priority 1` |
| `delete [id]` | `--permanent` `--status` `--older-than` | `agentrem delete abc12345 --permanent` |
| `stats` | `--json` | `agentrem stats --json` |
| `history [id]` | `--limit` `--json` | `agentrem history --limit 20 --json` |
| `undo <history_id>` | — | `agentrem undo 42` |
| `gc` | `--older-than` `--dry-run` | `agentrem gc --older-than 30` |
| `export` | `--out` `--status` | `agentrem export --out backup.json` |
| `import <file>` | `--merge` `--replace` `--dry-run` | `agentrem import backup.json --merge` |
| `watch` | `--interval` `--once` `--verbose` `--on-fire` `--on-fire-preset` `--on-fire-timeout` `--install` `--uninstall` `--status` `--agent` | `agentrem watch --on-fire-preset openclaw` |
| `setup` | `--mcp` | `agentrem setup` / `agentrem setup --mcp` |
| `doctor` | `--json` | `agentrem doctor` |
| `init` | `--force` | `agentrem init` |
| `quickstart` | — | `agentrem quickstart` |
| `schema` | — | `agentrem schema` |

**`--json` is available on `check`, `list`, `search`, `stats`, `history`, `doctor` — use it for structured output in your agent.**

### Trigger Types

| Type | Fires when... | Key flags |
|------|--------------|-----------|
| `time` | Due datetime is reached | `--due` (notifies once by default; stays active until explicitly completed) |
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

## check --watch: Blocking Mode

`agentrem check --watch` blocks until the next due reminder fires. Useful for scripting, pipelines, or pausing an agent until something needs attention.

```bash
# Wait indefinitely for next reminder
agentrem check --watch

# Exit 1 if nothing fires within 5 minutes
agentrem check --watch --timeout 300

# Get the full reminder as JSON when it fires
agentrem check --watch --json

# Filter by trigger type and agent
agentrem check --watch --type time,heartbeat --agent jarvis --timeout 60
```

**Exit codes:** `0` = reminder found (or SIGINT/SIGTERM), `1` = timeout elapsed with no reminder.

> **Note:** `--watch` does **not** update fire counts. Use a regular `agentrem check` after to actually mark reminders as fired.

**Poll-then-act pattern:**
```bash
if agentrem check --watch --timeout 120 --json > /tmp/due.json; then
  echo "Reminder fired:"
  cat /tmp/due.json
  agentrem check   # mark as fired
fi
```

## watch --on-fire: Hooks

Execute a shell command whenever a reminder fires:

```bash
agentrem watch --on-fire "curl -X POST https://hooks.example.com/reminder"
```

Reminder data is passed as environment variables (no shell injection — data never interpolated into the command):

| Variable | Description |
|----------|-------------|
| `AGENTREM_ID` | Reminder ID |
| `AGENTREM_CONTENT` | Reminder text |
| `AGENTREM_PRIORITY` | Priority (1-5) |
| `AGENTREM_TAGS` | Comma-separated tags |
| `AGENTREM_CONTEXT` | Context string |
| `AGENTREM_DUE` | Due datetime |
| `AGENTREM_FIRE_COUNT` | Number of times fired |

- **Fire-and-forget** — failures are logged to `~/.agentrem/logs/on-fire.log`, never crash the watcher
- **Sequential** — multiple reminders process one at a time
- **Timeout:** 5 seconds default, configurable with `--on-fire-timeout <ms>`

**Built-in presets** — skip the shell command entirely:
```bash
agentrem watch --on-fire-preset openclaw   # auto-delivers to your OpenClaw agent
```

Or craft your own:
```bash
agentrem watch --on-fire 'curl -X POST https://hooks.example.com/reminder -d "text=$AGENTREM_CONTENT"'
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

On macOS, agentrem ships a bundled Swift app (`Agentrem.app`) that runs as a singleton process — notifications appear under "agentrem" with a bell icon.

| Priority | Sound |
|----------|-------|
| P1 🔴 Critical | Hero |
| P2 🟡 High | Ping |
| P3 🔵 Normal | Pop |

**Notification behavior:**
- **Click body** → notification re-appears (won't dismiss until you act on it)
- **Complete ✅** → marks reminder complete and dismisses (the **only** way to complete a fired reminder)
- **Multiple reminders** → single process handles all via IPC
- **Fallback chain:** `Agentrem.app` → `terminal-notifier` → `osascript` → `console`

To rebuild the Swift app: `npm run build:notify`

---

## Programmatic API

Use agentrem directly from JavaScript/TypeScript — no CLI subprocess needed.

```bash
npm install agentrem
```

```typescript
import { add, check, list, complete, snooze, search, stats } from 'agentrem';
import type { Reminder } from 'agentrem';

// Add a reminder
const rem = await add('Review PR #42', { due: 'tomorrow', priority: 2, tags: 'pr,review' });

// Check for triggered reminders (session start pattern)
const { included, totalTriggered } = await check({ type: 'time,session', budget: 800 });
for (const r of included) {
  console.log(`[P${r.priority}] ${r.content}`);
}

// List active reminders
const reminders = await list({ limit: 20 });

// Complete a reminder
const done = await complete(rem.id, 'Reviewed and merged');

// Snooze a reminder
const snoozed = await snooze(rem.id, { for: '2h' });

// Full-text search
const results = await search('deploy staging');

// Get statistics
const s = await stats();
console.log(`${s.totalActive} active, ${s.overdue} overdue`);
```

**All API functions are async and return full `Reminder` objects.** The database is auto-initialized on first call (no manual `init` needed).

See `llms-full.txt` for complete type signatures and all options.

---

## Why agentrem?

```
# vs flat files / memory.md
agentrem check --json   # structured output your agent can parse; memory.md can't do that
```

- **Persistent across sessions** — SQLite-backed, survives restarts, not just in-context notes
- **Priority-aware + token budgets** — `check --budget 800` fits within any context window without overflow
- **Triggerable** — time, keyword, condition, session, heartbeat triggers; not just static lists
- **Blocking watch mode** — `check --watch` lets agents pause until something needs attention
- **Agent-native** — `--json` everywhere, `--agent` namespacing, MCP server for chat clients

---

## Install

```bash
npm install -g agentrem
```

The database auto-initializes on first use. Run `agentrem setup` to get your `CLAUDE.md` snippet, or `agentrem setup --mcp` for Claude Desktop.

MIT License
