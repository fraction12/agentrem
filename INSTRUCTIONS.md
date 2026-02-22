# agentrem-node — TypeScript Rewrite with MCP Server

## What You're Building

Rewrite `agentrem` (a Python CLI tool for AI agent reminders) in TypeScript/Node.js, with a built-in MCP (Model Context Protocol) server. This should be production-ready, fully tested, and installable via `npx`.

## Reference Files

- **Python source:** `~/Documents/Projects/agentrem/agentrem.py` (1,620 lines) — the complete existing implementation
- **Python tests:** `~/Documents/Projects/agentrem/tests/test_agentrem.py` (2,121 lines, 186 tests) — port ALL of these
- **MCP Plan:** `~/Documents/Projects/agentrem/MCP_PLAN.md` — detailed MCP server design (tools, resources, prompts, schemas)

## Architecture

```
agentrem-node/
├── src/
│   ├── index.ts              # CLI entry point (commander)
│   ├── core.ts               # Business logic (pure functions, no I/O to stdout)
│   ├── db.ts                 # SQLite + FTS5 database layer
│   ├── types.ts              # TypeScript interfaces/types
│   ├── date-parser.ts        # Date parsing (relative, named, ISO)
│   └── mcp/
│       ├── server.ts         # MCP server entry point
│       ├── tools.ts          # 14 MCP tools
│       ├── resources.ts      # MCP resources
│       └── prompts.ts        # MCP prompt templates
├── tests/
│   ├── core.test.ts          # Core business logic tests
│   ├── db.test.ts            # Database layer tests
│   ├── cli.test.ts           # CLI integration tests
│   ├── mcp.test.ts           # MCP server tests
│   └── date-parser.test.ts   # Date parsing tests
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

## Key Requirements

### 1. CLI (Feature Parity with Python)
- All 16 commands: init, add, check, list, search, complete, snooze, edit, delete, stats, gc, history, undo, export, import, schema
- Same argument names and behavior
- JSON output mode (`--format json`)
- Compact output mode (`--format compact`)

### 2. MCP Server
- Entry point: `agentrem mcp` (stdio mode) or `agentrem mcp --http --port 3847`
- 14 tools: add, check, list, search, complete, snooze, edit, delete, stats, history, undo, gc, export, import
- 6 resources: active reminders, single reminder, overdue, keyword triggers, stats, schema
- 3 prompts: triage, guided creation, session briefing
- Use `@modelcontextprotocol/sdk` for the server

### 3. Database
- Use `better-sqlite3` for SQLite + FTS5
- Same schema as Python version (must be compatible — same DB file)
- DB path: `~/.agentrem/reminders.db` (configurable via AGENTREM_DB env var)

### 4. Testing
- Use vitest
- Port ALL 186 tests from Python
- Add MCP-specific tests
- Target: 200+ tests, all passing

### 5. Package
- `package.json` with `bin` entry for CLI
- `npx agentrem` should work
- Dependencies: better-sqlite3, commander, @modelcontextprotocol/sdk
- TypeScript strict mode

## Critical Details from Python Implementation

### Priority System
- P1 (Critical) → P5 (Someday)
- Emoji labels: 🔴🟡🔵⚪💤
- Escalation: P3→P2 after 3 missed checks, P2→P1 after 5

### Trigger Types
- `time` — fires at specific datetime
- `keyword` — fires when keywords match in message text
- `session` — fires once per session start
- `heartbeat` — fires on heartbeat checks
- `condition` — fires when shell command returns expected output
- `manual` — only fires when explicitly checked

### Keyword Matching
- `match: any` — any keyword present
- `match: all` — all keywords present
- `match: regex` — keyword is a regex pattern

### Budget-Aware Context Injection
- `check` command has a `--budget` parameter (default 800 tokens)
- Returns reminders that fit within the token budget
- Priority-ordered: P1 first, then P2, etc.
- Overflow tracking: reports how many reminders didn't fit

### Undo System
- History table tracks all changes
- `undo` command reverts last change per reminder
- Operations logged: create, complete, snooze, edit, delete, escalate, fire

### Recurrence
- Pattern: `1d`, `2w`, `1m`, `3h`
- On completion, auto-creates next occurrence
- Tracks `recurrence_count`

### ID System
- 16-char hex IDs (random)
- Prefix matching for all commands (first 4+ chars)

### Export/Import
- JSON format with all fields
- Import validates and deduplicates by ID

## What NOT to Do
- Don't add features not in the Python version
- Don't change the database schema
- Don't use any ORM — raw better-sqlite3
- Don't skip tests — port every single one
