# 🧠 agentrem — Reminders for AI Agents

<p align="center">
  <strong>Because even AI agents forget things.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://github.com/fraction12/agentrem"><img src="https://img.shields.io/badge/python-3.10+-blue?style=for-the-badge&logo=python&logoColor=white" alt="Python 3.10+"></a>
  <a href="https://github.com/fraction12/agentrem"><img src="https://img.shields.io/badge/tests-186_passing-brightgreen?style=for-the-badge" alt="186 tests passing"></a>
  <a href="https://github.com/fraction12/agentrem"><img src="https://img.shields.io/badge/dependencies-zero-orange?style=for-the-badge" alt="Zero dependencies"></a>
</p>

---

You know that feeling when you wake up and can't remember what you were doing? That's every session for an AI agent. Context window ends, everything's gone. Poof.

**agentrem** fixes that. It's a structured reminders system built *by* an agent, *for* agents. Not a human todo app awkwardly repurposed — actual infrastructure for AI cognition.

One Python file. One SQLite database. Zero dependencies. Works with any agent framework that can shell out.

## Why This Exists

Agents currently solve the memory problem with:
- 📝 Markdown files (hope you remember to search them)
- ⏰ Cron jobs (fire whether relevant or not)
- 🔍 Semantic search (you have to *know* to look)

All of these are **pull-based** — the agent has to actively remember to check. That's the exact problem we're trying to solve.

**agentrem is push-based.** Reminders surface themselves at the right moment:

- ⏰ **Time triggers** — "at 3pm, tell me about X"
- 🔑 **Keyword triggers** — "next time someone mentions budget, surface this context"
- 🔄 **Session triggers** — "next time I wake up, remember to check Y"
- 💓 **Heartbeat triggers** — "keep this in mind all week" (with auto-decay)
- ⚡ **Condition triggers** — "when the PR is merged, remind me to deploy"
- 📋 **Manual triggers** — someday/maybe items, query when you want

## Install

```bash
# Just grab the file (it's one file)
mkdir -p ~/.agentrem
curl -o ~/.agentrem/agentrem.py https://raw.githubusercontent.com/fraction12/agentrem/main/agentrem.py
chmod +x ~/.agentrem/agentrem.py
ln -sf ~/.agentrem/agentrem.py /usr/local/bin/agentrem

# Or pip install (coming soon)
pip install git+https://github.com/fraction12/agentrem.git

# Optional: better date parsing
pip install python-dateutil

# Initialize
agentrem init
```

That's it. No server, no daemon, no config files. Just a CLI and a database.

## Quick Start

```bash
# The basics
agentrem add "Follow up with client" --due "+2h" --priority 2
agentrem add "Mention budget deadline" --trigger keyword --keywords "budget,finances"
agentrem add "Check overnight logs" --trigger session --max-fires 1

# What's due?
agentrem check --format compact
# 🔔 1 high (Follow up with client — due now), 1 normal

# Done with it
agentrem complete abc123 --notes "Client confirmed"
```

## The Smart Parts

### Budget-Aware Context Injection

You have 50 reminders but only 800 tokens of context budget. What do you do?

```bash
agentrem check --budget 800 --format full
```

agentrem handles it:
- **P1 (Critical)** — always included, full text
- **P2 (High)** — included until 60% budget used
- **P3 (Normal)** — truncated to first line until 85%
- **P4 (Low)** — count only ("...and 12 more")
- **P5 (Someday)** — never auto-injected

No overflow. No context window explosions. Just the right information at the right priority.

### Auto-Escalation

Forget something? It gets louder.

- P3 overdue > 48 hours → bumped to P2
- P2 overdue > 24 hours → bumped to P1
- P1 items? They don't let you forget.

```bash
agentrem check --escalate  # Run this on a schedule
```

### Keyword Matching

This is the killer feature. Instead of scheduling a reminder for a specific time, you say:

```bash
agentrem add "Remind about the equity split decision" \
  --trigger keyword \
  --keywords "brandon,partnership,equity" \
  --context "500 buy-in, 70/30 split"
```

Next time the word "brandon" appears in conversation — boom, the context surfaces. No scheduling needed. The reminder finds its own moment.

### Undo Everything

Every state change is tracked. Made a mistake? Go back.

```bash
agentrem history           # See what changed
agentrem undo 42           # Revert change #42
```

## All Commands

| Command | What it does |
|---------|-------------|
| `init` | Set up the database |
| `add` | Create a reminder |
| `check` | Get due reminders (the main event) |
| `list` | Browse with filters |
| `search` | Full-text search (FTS5) |
| `complete` | Mark done |
| `snooze` | Not now, later |
| `edit` | Change anything |
| `delete` | Soft delete (undoable) |
| `stats` | Dashboard overview |
| `gc` | Clean up old stuff |
| `history` | Audit trail |
| `undo` | Time travel |
| `export` | Backup to JSON |
| `import` | Restore from JSON |
| `schema` | Debug the DB |

## Date Formats

```bash
--due "+2h"              # 2 hours from now
--due "+30m"             # 30 minutes
--due "+3d"              # 3 days
--due "tomorrow"         # Tomorrow at 9am
--due "tomorrow 2pm"     # Tomorrow at 2pm
--due "friday at noon"   # Next Friday (needs python-dateutil)
--due "2026-03-01T14:00" # Exact ISO 8601
```

## Integration

### With OpenClaw

agentrem was built for [OpenClaw](https://github.com/openclaw/openclaw) and integrates via hooks:

- **`message:received` hook** — checks keyword triggers on every inbound message, automatically
- **`agent:bootstrap` hook** — injects due reminders when a session starts

See [`examples/`](examples/) for the hook implementations. Drop them in `~/.openclaw/hooks/` and you're set.

### With Anything Else

Any framework that can run a shell command can use agentrem:

```python
import subprocess

result = subprocess.run(
    ["agentrem", "check", "--format", "compact"],
    capture_output=True, text=True
)
if result.stdout.strip():
    inject_into_context(result.stdout)
```

Works with LangChain, CrewAI, AutoGPT, custom agents — anything.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTREM_DIR` | `~/.agentrem` | Home directory |
| `AGENTREM_DB` | `~/.agentrem/reminders.db` | Database path |

That's the entire configuration surface. No YAML. No TOML. No JSON config files. Environment variables and CLI flags.

## Storage

One SQLite file. ACID transactions. FTS5 full-text search. WAL mode for concurrent access. Handles thousands of reminders without breaking a sweat.

```bash
agentrem stats
# 📊 Agent Reminders Stats
# Active: 23 (4 critical, 6 high, 10 normal, 3 low)
# Overdue: 2
# By trigger: 15 time, 4 keyword, 2 condition, 1 session, 1 heartbeat
# DB size: 45 KB
```

## Requirements

- Python 3.10+
- SQLite 3.35+ with FTS5 (comes with Python)
- Optional: `python-dateutil` for natural language dates

## Tests

186 tests covering every command, trigger type, and edge case:

```bash
python3 -m unittest tests/test_agentrem.py -v
```

## Philosophy

Human reminder apps assume you have eyes to check a notification. Agents don't. They need reminders that **inject themselves into the context window** at the right moment — by time, by topic, by condition.

This is the difference between an agent that forgets and one that follows through.

---

<p align="center">
  Built by an agent, for agents. 🤖
</p>

## License

MIT
