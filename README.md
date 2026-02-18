# agentrem

Structured reminders for AI agents. A single-file CLI tool that gives agents persistent, priority-aware, trigger-based memory across sessions.

## The Problem

AI agents have ephemeral context windows. Every session starts blank. Agents forget follow-ups, miss deadlines, and lose track of things that matter. Current workarounds — markdown files, cron jobs, semantic search — are human tools awkwardly repurposed.

## The Solution

`agentrem` is a purpose-built reminders system for AI agents:

- **6 trigger types** — time, keyword, condition, session-start, heartbeat, manual
- **Priority & escalation** — P1-P5 with auto-escalation for overdue items
- **Budget-aware context injection** — fits reminders into token budgets without overflow
- **Full-text search** — SQLite FTS5 across all reminder fields
- **Undo/history** — full audit trail with revert capability
- **Decay & recurrence** — auto-expire temporary awareness, recurring reminders
- **Cross-agent support** — multiple agents sharing one database
- **Zero dependencies** — stdlib only (optional `python-dateutil` for natural language dates)

## Install

```bash
# From PyPI (when published)
pip install agentrem

# Or just copy the single file
curl -o ~/.agentrem/agentrem.py https://raw.githubusercontent.com/fraction12/agentrem/main/agentrem.py
chmod +x ~/.agentrem/agentrem.py
ln -sf ~/.agentrem/agentrem.py /usr/local/bin/agentrem

# Optional: natural language date parsing
pip install python-dateutil
```

Then initialize:

```bash
agentrem init
```

## Quick Start

```bash
# Time-based reminder
agentrem add "Follow up with client" --due "+2h" --priority 2

# Keyword trigger — fires when a topic comes up
agentrem add "Mention the budget deadline" --trigger keyword \
  --keywords "budget,finances,spending" --priority 2

# Session-start — one-shot, next time the agent wakes up
agentrem add "Check overnight logs" --trigger session --max-fires 1

# Heartbeat — persistent awareness with auto-expiry
agentrem add "User is traveling until Friday" --trigger heartbeat --decay "+5d"

# Condition — fires when external state changes
agentrem add "PR merged — deploy" --trigger condition \
  --check "gh pr view 42 --json merged -q .merged" --expect "true"

# Check for due reminders (context injection)
agentrem check --format compact

# List active reminders
agentrem list

# Search
agentrem search "budget"

# Complete
agentrem complete abc123 --notes "Done"
```

## How It Works

### For the Agent

The agent calls `agentrem check` and gets formatted text injected into its context window:

```
🔔 Active Reminders

🔴 Critical
- [a1b2c3d4] Follow up on vendor API outage — due 2h ago, fired 3x
  Context: They promised a fix by Monday.

🟡 High
- [e5f6g7h8] Dentist appointment tomorrow 2pm
```

The budget system ensures reminders fit within token limits:
- **P1 (Critical)** — always included, up to 200 chars each
- **P2 (High)** — included until 60% budget used
- **P3 (Normal)** — included until 85% budget
- **P4 (Low)** — count only
- **P5 (Someday)** — never auto-injected

### Trigger Types

| Type | Fires when... | Example |
|------|--------------|---------|
| `time` | Due date/time is reached | "Remind me Tuesday at 3pm" |
| `keyword` | Keywords appear in text | "When budget comes up, mention X" |
| `condition` | Shell command output matches | "When PR is merged..." |
| `session` | Agent starts a new session | "Next time I wake up, check X" |
| `heartbeat` | Each heartbeat cycle | "User is on vacation this week" |
| `manual` | Explicitly queried | Someday/maybe items |

### Escalation

Overdue reminders automatically escalate:
- P3 overdue > 48h → P2
- P2 overdue > 24h → P1

## Commands

| Command | Description |
|---------|-------------|
| `agentrem init` | Initialize database |
| `agentrem add <text>` | Create a reminder |
| `agentrem check` | Get due reminders (context injection) |
| `agentrem list` | List reminders with filters |
| `agentrem search <query>` | Full-text search |
| `agentrem complete <id>` | Mark done |
| `agentrem snooze <id>` | Defer a reminder |
| `agentrem edit <id>` | Modify a reminder |
| `agentrem delete <id>` | Soft delete (undoable) |
| `agentrem stats` | Dashboard overview |
| `agentrem gc` | Garbage collection |
| `agentrem history [id]` | View audit trail |
| `agentrem undo <hid>` | Revert a change |
| `agentrem export` | Export to JSON |
| `agentrem import <file>` | Import from JSON |
| `agentrem schema` | Print DB schema |

## Date Formats

```bash
--due "+2h"              # 2 hours from now
--due "+30m"             # 30 minutes
--due "+3d"              # 3 days
--due "+1w"              # 1 week
--due "tomorrow"         # Tomorrow at 9am
--due "tomorrow 2pm"     # Tomorrow at 2pm
--due "friday at noon"   # Next Friday (requires python-dateutil)
--due "2026-03-01T14:00" # Exact ISO 8601
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTREM_DIR` | `~/.agentrem` | Directory for database and config |
| `AGENTREM_DB` | `~/.agentrem/reminders.db` | Database file path |

## Integration with AI Frameworks

### OpenClaw

`agentrem` works standalone, but integrates deeply with [OpenClaw](https://github.com/openclaw/openclaw) via hooks:

- **`message:received` hook** — checks keyword triggers on every inbound message
- **`agent:bootstrap` hook** — injects due reminders at session start
- **Heartbeat** — checks time-based reminders every 30 minutes
- **Maintenance cron** — runs escalation and cleanup periodically

See the [`examples/`](examples/) directory for OpenClaw hook implementations.

### Other Frameworks

Any AI agent framework that can shell out to CLI tools can use `agentrem`:

```python
import subprocess

# Check for due reminders
result = subprocess.run(
    ["agentrem", "check", "--format", "compact"],
    capture_output=True, text=True
)
if result.returncode == 0:
    # Inject result.stdout into agent context
    agent.add_context(result.stdout)
```

## Storage

SQLite database at `~/.agentrem/reminders.db` with:
- Full schema with 20+ fields per reminder
- FTS5 full-text search index
- History/audit table for undo
- Schema versioning for migrations

## Requirements

- Python 3.10+
- SQLite 3.35+ (with FTS5 — included in most Python distributions)
- Optional: `python-dateutil` for natural language date parsing

## License

MIT
