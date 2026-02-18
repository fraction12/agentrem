---
name: agentrem-keyword-check
description: "Check agent reminders for keyword triggers on every inbound message"
metadata:
  {
    "openclaw":
      {
        "emoji": "🔔",
        "events": ["message:received"],
        "requires": { "bins": ["agentrem"] },
      },
  }
---

# Agent Reminders — Keyword Check Hook

Runs `agentrem check --type keyword --text "<message>"` on every inbound message.
If a keyword-triggered reminder matches, the reminder text is pushed into the
agent's context via `event.messages`.

## How It Works

1. Listens for `message:received` events
2. Extracts the message content
3. Runs `agentrem check --type keyword --text "..." --format inline --dry-run`
4. If reminders match (exit code 0), pushes the output into `event.messages`

The agent sees the reminder in its next context turn — no AGENTS.md hack needed.

## Requirements

- `agentrem` CLI must be on PATH (`/opt/homebrew/bin/agentrem`)
