---
name: agentrem-bootstrap
description: "Inject due agent reminders into session context on bootstrap"
metadata:
  {
    "openclaw":
      {
        "emoji": "📋",
        "events": ["agent:bootstrap"],
        "requires": { "bins": ["agentrem"] },
      },
  }
---

# Agent Reminders — Bootstrap Hook

Runs `agentrem check` at session bootstrap and injects due reminders into the
agent's context as a workspace bootstrap file.

## How It Works

1. Listens for `agent:bootstrap` events
2. Runs `agentrem check --type session,time,heartbeat --format compact`
3. If reminders are due, injects them as a bootstrap file so the agent
   sees them in its "Project Context" section

## Requirements

- `agentrem` CLI must be on PATH (`/opt/homebrew/bin/agentrem`)
