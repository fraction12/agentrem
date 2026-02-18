#!/usr/bin/env python3
"""agentrem — Structured reminders CLI for AI agents.

Single-file, priority-aware, trigger-based reminder system with FTS5 search,
undo/history, recurrence, decay, escalation, and budget-aware context injection.
"""

import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import textwrap
from datetime import datetime, timedelta
from pathlib import Path

try:
    from dateutil import parser as dateutil_parser
except ImportError:
    dateutil_parser = None

# ── Constants ──────────────────────────────────────────────────────────────────

AGENTREM_DIR = Path(os.environ.get("AGENTREM_DIR", Path.home() / ".agentrem"))
DB_PATH = Path(os.environ.get("AGENTREM_DB", AGENTREM_DIR / "reminders.db"))
SCHEMA_VERSION = 1
__version__ = "0.1.0"

PRIORITY_LABELS = {1: "🔴 Critical", 2: "🟡 High", 3: "🔵 Normal", 4: "⚪ Low", 5: "💤 Someday"}
PRIORITY_COLORS = {1: "🔴", 2: "🟡", 3: "🔵", 4: "⚪", 5: "💤"}
VALID_TRIGGERS = {"time", "keyword", "condition", "session", "heartbeat", "manual"}
VALID_STATUSES = {"active", "snoozed", "completed", "expired", "failed", "deleted"}
VALID_SOURCES = {"agent", "user", "system"}

# ── Date Parsing ───────────────────────────────────────────────────────────────

RELATIVE_RE = re.compile(r'^\+(\d+)([mhdw])$', re.IGNORECASE)

def parse_date(s: str) -> datetime:
    """Parse a date string in order: relative, named shortcuts, dateutil, ISO."""
    s = s.strip()

    # 1. Relative shortcuts: +Nh, +Nm, +Nd, +Nw
    m = RELATIVE_RE.match(s)
    if m:
        n, unit = int(m.group(1)), m.group(2).lower()
        now = datetime.now()
        if unit == 'm':
            return now + timedelta(minutes=n)
        elif unit == 'h':
            return now + timedelta(hours=n)
        elif unit == 'd':
            return now + timedelta(days=n)
        elif unit == 'w':
            return now + timedelta(weeks=n)

    # 2. Named shortcuts
    sl = s.lower()
    now = datetime.now()
    if sl == 'today':
        return now.replace(hour=23, minute=59, second=0, microsecond=0)
    if sl == 'tomorrow':
        tmrw = now + timedelta(days=1)
        return tmrw.replace(hour=9, minute=0, second=0, microsecond=0)
    if sl.startswith('tomorrow'):
        # "tomorrow 2pm", "tomorrow at 3:30", etc.
        tmrw = now + timedelta(days=1)
        time_part = sl.replace('tomorrow', '').strip().lstrip('at').strip()
        if time_part and dateutil_parser:
            try:
                parsed_time = dateutil_parser.parse(time_part, fuzzy=True)
                return tmrw.replace(hour=parsed_time.hour, minute=parsed_time.minute, second=0, microsecond=0)
            except (ValueError, OverflowError):
                pass
        return tmrw.replace(hour=9, minute=0, second=0, microsecond=0)

    # 3. dateutil natural language
    if dateutil_parser:
        try:
            dt = dateutil_parser.parse(s, fuzzy=True, dayfirst=False)
            # If no time was specified and it parsed to midnight, that's fine
            return dt
        except (ValueError, OverflowError):
            pass

    # 4. ISO 8601 fallback
    for fmt in ('%Y-%m-%dT%H:%M:%S', '%Y-%m-%dT%H:%M', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue

    raise ValueError(f"Cannot parse date: '{s}'")


def fmt_dt(s: str | None) -> str:
    """Format an ISO datetime string for display."""
    if not s:
        return ""
    try:
        dt = datetime.fromisoformat(s)
        now = datetime.now()
        diff = now - dt
        if diff.total_seconds() < 0:
            # Future
            diff = -diff
            if diff.total_seconds() < 60:
                return "in <1m"
            elif diff.total_seconds() < 3600:
                return f"in {int(diff.total_seconds() / 60)}m"
            elif diff.total_seconds() < 86400:
                h = diff.total_seconds() / 3600
                return f"in {h:.0f}h"
            else:
                d = diff.days
                return f"in {d}d"
        else:
            # Past
            if diff.total_seconds() < 60:
                return "<1m ago"
            elif diff.total_seconds() < 3600:
                return f"{int(diff.total_seconds() / 60)}m ago"
            elif diff.total_seconds() < 86400:
                h = diff.total_seconds() / 3600
                return f"{h:.0f}h ago"
            else:
                d = diff.days
                return f"{d}d ago"
    except Exception:
        return s


def dt_to_iso(dt: datetime) -> str:
    return dt.strftime('%Y-%m-%dT%H:%M:%S')


# ── Database ───────────────────────────────────────────────────────────────────

def get_db(path: Path | None = None) -> sqlite3.Connection:
    """Get a database connection. Auto-inits if needed."""
    p = path or DB_PATH
    if not p.exists():
        err(f"Database not found at {p}. Run `agentrem init` first.")
        sys.exit(2)
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def row_to_dict(row: sqlite3.Row) -> dict:
    return dict(row)


def init_db(force: bool = False):
    """Create or reinitialize the database."""
    AGENTREM_DIR.mkdir(parents=True, exist_ok=True)

    if DB_PATH.exists():
        if force:
            ts = datetime.now().strftime('%Y%m%d-%H%M%S')
            backup = DB_PATH.with_name(f"reminders.db.bak.{ts}")
            shutil.copy2(DB_PATH, backup)
            print(f"Backed up existing DB to {backup}")
            DB_PATH.unlink()
        else:
            # Check schema version and migrate if needed
            conn = sqlite3.connect(str(DB_PATH))
            conn.row_factory = sqlite3.Row
            try:
                ver = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
            except Exception:
                ver = None
            conn.close()
            if ver and ver >= SCHEMA_VERSION:
                print(f"✅ Database already initialized at {DB_PATH} (schema v{ver})")
                return
            # Migration needed
            print(f"Migrating database from v{ver} to v{SCHEMA_VERSION}...")

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS reminders (
            id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
            content         TEXT NOT NULL,
            context         TEXT,
            trigger_type    TEXT NOT NULL DEFAULT 'time',
            trigger_at      TEXT,
            trigger_config  TEXT,
            priority        INTEGER NOT NULL DEFAULT 3,
            tags            TEXT,
            category        TEXT,
            status          TEXT NOT NULL DEFAULT 'active',
            snoozed_until   TEXT,
            decay_at        TEXT,
            escalation      TEXT,
            fire_count      INTEGER DEFAULT 0,
            last_fired      TEXT,
            max_fires       INTEGER,
            recur_rule      TEXT,
            recur_parent_id TEXT,
            depends_on      TEXT,
            related_ids     TEXT,
            source          TEXT DEFAULT 'agent',
            agent           TEXT DEFAULT 'main',
            created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
            updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
            completed_at    TEXT,
            notes           TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_rem_status ON reminders(status);
        CREATE INDEX IF NOT EXISTS idx_rem_trigger ON reminders(trigger_type, status);
        CREATE INDEX IF NOT EXISTS idx_rem_due ON reminders(trigger_at) WHERE trigger_type = 'time' AND status = 'active';
        CREATE INDEX IF NOT EXISTS idx_rem_priority ON reminders(priority) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_rem_agent ON reminders(agent);
        CREATE INDEX IF NOT EXISTS idx_rem_tags ON reminders(tags);

        CREATE TABLE IF NOT EXISTS history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            reminder_id TEXT NOT NULL,
            action      TEXT NOT NULL,
            old_data    TEXT,
            new_data    TEXT,
            timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime')),
            source      TEXT
        );

        CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
    """)

    # FTS5 table — create separately (virtual tables can't be in executescript with IF NOT EXISTS reliably)
    try:
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS reminders_fts USING fts5(
                content, context, tags, notes,
                content=reminders, content_rowid=rowid
            )
        """)
    except sqlite3.OperationalError:
        pass  # Already exists

    # FTS sync triggers
    conn.executescript("""
        CREATE TRIGGER IF NOT EXISTS reminders_ai AFTER INSERT ON reminders BEGIN
            INSERT INTO reminders_fts(rowid, content, context, tags, notes)
            VALUES (new.rowid, new.content, new.context, new.tags, new.notes);
        END;

        CREATE TRIGGER IF NOT EXISTS reminders_ad AFTER DELETE ON reminders BEGIN
            INSERT INTO reminders_fts(reminders_fts, rowid, content, context, tags, notes)
            VALUES ('delete', old.rowid, old.content, old.context, old.tags, old.notes);
        END;

        CREATE TRIGGER IF NOT EXISTS reminders_au AFTER UPDATE ON reminders BEGIN
            INSERT INTO reminders_fts(reminders_fts, rowid, content, context, tags, notes)
            VALUES ('delete', old.rowid, old.content, old.context, old.tags, old.notes);
            INSERT INTO reminders_fts(rowid, content, context, tags, notes)
            VALUES (new.rowid, new.content, new.context, new.tags, new.notes);
        END;
    """)

    # Set schema version
    conn.execute("INSERT OR REPLACE INTO schema_version(version) VALUES (?)", (SCHEMA_VERSION,))
    conn.commit()
    conn.close()

    print(f"✅ Initialized agentrem database at {DB_PATH} (schema v{SCHEMA_VERSION})")


# ── Helpers ────────────────────────────────────────────────────────────────────

def err(msg: str):
    print(f"Error: {msg}", file=sys.stderr)


def find_reminder(conn: sqlite3.Connection, rid: str) -> dict | None:
    """Find a reminder by ID or prefix."""
    row = conn.execute("SELECT * FROM reminders WHERE id = ?", (rid,)).fetchone()
    if row:
        return row_to_dict(row)
    # Try prefix match
    rows = conn.execute("SELECT * FROM reminders WHERE id LIKE ?", (rid + '%',)).fetchall()
    if len(rows) == 1:
        return row_to_dict(rows[0])
    if len(rows) > 1:
        err(f"Ambiguous ID prefix '{rid}' matches {len(rows)} reminders. Use more characters.")
        return None
    return None


def record_history(conn: sqlite3.Connection, reminder_id: str, action: str,
                   old_data: dict | None = None, new_data: dict | None = None, source: str | None = None):
    conn.execute(
        "INSERT INTO history(reminder_id, action, old_data, new_data, source) VALUES (?, ?, ?, ?, ?)",
        (reminder_id, action,
         json.dumps(old_data, default=str) if old_data else None,
         json.dumps(new_data, default=str) if new_data else None,
         source)
    )


def truncate(s: str, max_len: int) -> str:
    if not s:
        return ""
    if len(s) <= max_len:
        return s
    return s[:max_len - 1] + "…"


def parse_recur(rule_str: str) -> dict:
    """Parse recurrence like '1d', '2w', '1m'."""
    m = re.match(r'^(\d+)([dwm])$', rule_str.lower())
    if not m:
        raise ValueError(f"Invalid recurrence pattern: '{rule_str}'. Use format like 1d, 2w, 1m")
    return {"interval": int(m.group(1)), "unit": m.group(2)}


def next_recurrence(trigger_at: str | None, rule: dict) -> datetime:
    """Calculate the next recurrence datetime."""
    base = datetime.fromisoformat(trigger_at) if trigger_at else datetime.now()
    interval = rule.get("interval", 1)
    unit = rule.get("unit", "d")
    if unit == 'd':
        return base + timedelta(days=interval)
    elif unit == 'w':
        return base + timedelta(weeks=interval)
    elif unit == 'm':
        # Approximate month
        return base + timedelta(days=interval * 30)
    return base + timedelta(days=interval)


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_init(args):
    init_db(force=args.force)


def cmd_add(args):
    conn = get_db()
    try:
        content = args.content
        trigger = args.trigger or 'time'
        priority = args.priority or 3

        if priority < 1 or priority > 5:
            err("Priority must be 1-5")
            sys.exit(2)

        if trigger not in VALID_TRIGGERS:
            err(f"Invalid trigger type: '{trigger}'. Must be one of: {', '.join(sorted(VALID_TRIGGERS))}")
            sys.exit(2)

        # Parse due date
        trigger_at = None
        if args.due:
            try:
                trigger_at = dt_to_iso(parse_date(args.due))
            except ValueError as e:
                err(str(e))
                sys.exit(2)

        # Validation
        if trigger == 'time' and not trigger_at:
            err("Time trigger requires --due / -d flag")
            sys.exit(2)
        if trigger == 'keyword' and not args.keywords:
            err("Keyword trigger requires --keywords / -k flag")
            sys.exit(2)
        if trigger == 'condition' and (not args.check or not args.expect):
            err("Condition trigger requires both --check and --expect flags")
            sys.exit(2)

        # Build trigger_config
        trigger_config = None
        if trigger == 'keyword':
            trigger_config = json.dumps({
                "keywords": [k.strip() for k in args.keywords.split(',')],
                "match": args.match or "any"
            })
        elif trigger == 'condition':
            trigger_config = json.dumps({
                "check": args.check,
                "expect": args.expect
            })

        # Parse decay
        decay_at = None
        if args.decay:
            try:
                decay_at = dt_to_iso(parse_date(args.decay))
            except ValueError as e:
                err(f"Cannot parse decay date: {e}")
                sys.exit(2)

        # Parse recurrence
        recur_rule = None
        if args.recur:
            try:
                recur_rule = json.dumps(parse_recur(args.recur))
            except ValueError as e:
                err(str(e))
                sys.exit(2)

        # Validate depends_on
        if args.depends_on:
            dep = find_reminder(conn, args.depends_on)
            if not dep:
                err(f"Reminder not found: {args.depends_on}")
                sys.exit(2)

        source = args.source or 'agent'
        agent = args.agent or 'main'

        if args.dry_run:
            print("🔍 Dry run — would create:")
            print(f"  Content:  {content}")
            print(f"  Trigger:  {trigger}")
            if trigger_at:
                print(f"  Due:      {trigger_at}")
            print(f"  Priority: {priority} ({PRIORITY_LABELS.get(priority, '')})")
            if args.tags:
                print(f"  Tags:     {args.tags}")
            if args.context:
                print(f"  Context:  {args.context}")
            if trigger_config:
                print(f"  Config:   {trigger_config}")
            if decay_at:
                print(f"  Decay:    {decay_at}")
            if recur_rule:
                print(f"  Recur:    {recur_rule}")
            return

        # Insert
        cursor = conn.execute(
            """INSERT INTO reminders(content, context, trigger_type, trigger_at, trigger_config,
                priority, tags, category, decay_at, max_fires, recur_rule, depends_on,
                source, agent)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (content, args.context, trigger, trigger_at, trigger_config,
             priority, args.tags, args.category, decay_at, args.max_fires,
             recur_rule, args.depends_on, source, agent)
        )

        # Get the created reminder
        rem = row_to_dict(conn.execute("SELECT * FROM reminders WHERE rowid = ?", (cursor.lastrowid,)).fetchone())
        record_history(conn, rem['id'], 'created', new_data=rem, source=source)
        conn.commit()

        print(f"✅ Created reminder [{rem['id'][:8]}]")
        print(f"  Content:  {content}")
        print(f"  Trigger:  {trigger}")
        if trigger_at:
            print(f"  Due:      {trigger_at} ({fmt_dt(trigger_at)})")
        print(f"  Priority: {priority} ({PRIORITY_LABELS.get(priority, '')})")
        if args.tags:
            print(f"  Tags:     {args.tags}")
        if args.context:
            print(f"  Context:  {args.context}")
    finally:
        conn.close()


def cmd_check(args):
    conn = get_db()
    try:
        now = datetime.now()
        now_iso = dt_to_iso(now)
        agent = args.agent or 'main'
        budget = (args.budget or 800) * 4  # budget is in tokens, convert to chars
        fmt = args.format or 'full'
        dry_run = args.dry_run
        types_filter = set(args.type.split(',')) if args.type else None

        # 1. Reactivate snoozed reminders whose snooze has expired
        conn.execute(
            "UPDATE reminders SET status='active', snoozed_until=NULL, updated_at=? "
            "WHERE status='snoozed' AND snoozed_until <= ? AND agent=?",
            (now_iso, now_iso, agent)
        )

        # 2. Expire decayed reminders
        expired_rows = conn.execute(
            "SELECT id FROM reminders WHERE decay_at <= ? AND status='active' AND agent=?",
            (now_iso, agent)
        ).fetchall()
        for row in expired_rows:
            rem = row_to_dict(conn.execute("SELECT * FROM reminders WHERE id=?", (row['id'],)).fetchone())
            conn.execute("UPDATE reminders SET status='expired', updated_at=? WHERE id=?", (now_iso, row['id']))
            record_history(conn, row['id'], 'expired', old_data=rem, source='system')

        # 3. Escalation (if requested)
        if args.escalate:
            # P3 overdue 48h → P2
            cutoff_48h = dt_to_iso(now - timedelta(hours=48))
            conn.execute(
                "UPDATE reminders SET priority=2, updated_at=? "
                "WHERE priority=3 AND trigger_type='time' AND trigger_at <= ? AND status='active' AND agent=?",
                (now_iso, cutoff_48h, agent)
            )
            # P2 overdue 24h → P1
            cutoff_24h = dt_to_iso(now - timedelta(hours=24))
            conn.execute(
                "UPDATE reminders SET priority=1, updated_at=? "
                "WHERE priority=2 AND trigger_type='time' AND trigger_at <= ? AND status='active' AND agent=?",
                (now_iso, cutoff_24h, agent)
            )

        conn.commit()

        # 4. Gather triggered reminders
        triggered = []

        # Get all completed IDs for dependency checking
        completed_ids = set(
            r['id'] for r in conn.execute(
                "SELECT id FROM reminders WHERE status='completed'"
            ).fetchall()
        )

        def check_dependency(rem: dict) -> bool:
            """Return True if dependency is satisfied (or none exists)."""
            dep = rem.get('depends_on')
            if not dep:
                return True
            return dep in completed_ids

        # Time triggers
        if types_filter is None or 'time' in types_filter:
            rows = conn.execute(
                "SELECT * FROM reminders WHERE trigger_type='time' AND trigger_at <= ? "
                "AND status='active' AND agent=?",
                (now_iso, agent)
            ).fetchall()
            for row in rows:
                rem = row_to_dict(row)
                if check_dependency(rem):
                    triggered.append(rem)

        # Keyword triggers
        if (types_filter is None or 'keyword' in types_filter) and args.text:
            rows = conn.execute(
                "SELECT * FROM reminders WHERE trigger_type='keyword' AND status='active' AND agent=?",
                (agent,)
            ).fetchall()
            text_lower = args.text.lower()
            for row in rows:
                rem = row_to_dict(row)
                if not check_dependency(rem):
                    continue
                config = json.loads(rem.get('trigger_config') or '{}')
                keywords = config.get('keywords', [])
                match_mode = config.get('match', 'any')
                if match_mode == 'any':
                    if any(kw.lower() in text_lower for kw in keywords):
                        triggered.append(rem)
                elif match_mode == 'all':
                    if all(kw.lower() in text_lower for kw in keywords):
                        triggered.append(rem)
                elif match_mode == 'regex':
                    for kw in keywords:
                        try:
                            if re.search(kw, args.text, re.IGNORECASE):
                                triggered.append(rem)
                                break
                        except re.error:
                            pass

        # Condition triggers
        if types_filter is None or 'condition' in types_filter:
            rows = conn.execute(
                "SELECT * FROM reminders WHERE trigger_type='condition' AND status='active' AND agent=?",
                (agent,)
            ).fetchall()
            for row in rows:
                rem = row_to_dict(row)
                if not check_dependency(rem):
                    continue
                config = json.loads(rem.get('trigger_config') or '{}')
                check_cmd = config.get('check', '')
                expect = config.get('expect', '')
                try:
                    result = subprocess.run(check_cmd, shell=True, capture_output=True,
                                            text=True, timeout=10)
                    if result.stdout.strip() == expect:
                        triggered.append(rem)
                except (subprocess.TimeoutExpired, OSError):
                    pass

        # Session triggers
        if types_filter is None or 'session' in types_filter:
            rows = conn.execute(
                "SELECT * FROM reminders WHERE trigger_type='session' AND status='active' AND agent=?",
                (agent,)
            ).fetchall()
            for row in rows:
                rem = row_to_dict(row)
                if check_dependency(rem):
                    triggered.append(rem)

        # Heartbeat triggers
        if types_filter is None or 'heartbeat' in types_filter:
            rows = conn.execute(
                "SELECT * FROM reminders WHERE trigger_type='heartbeat' AND status='active' AND agent=?",
                (agent,)
            ).fetchall()
            for row in rows:
                rem = row_to_dict(row)
                if check_dependency(rem):
                    triggered.append(rem)

        # Manual triggers are never auto-injected

        if not triggered:
            sys.exit(1)

        # Sort by priority
        triggered.sort(key=lambda r: r['priority'])

        # Deduplicate by ID (in case a reminder matches multiple trigger types)
        seen = set()
        deduped = []
        for rem in triggered:
            if rem['id'] not in seen:
                seen.add(rem['id'])
                deduped.append(rem)
        triggered = deduped

        # Budget system
        char_limits = {1: 200, 2: 100, 3: 60, 4: 0, 5: 0}
        used = 0
        included = []
        overflow_counts = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}

        for rem in triggered:
            p = rem['priority']
            if p == 5:
                continue
            if p == 4:
                overflow_counts[4] += 1
                continue

            limit = char_limits[p]
            content_text = truncate(rem['content'], limit)
            entry_size = len(content_text) + 30  # overhead for formatting

            if p == 1:
                # Always include critical
                included.append(rem)
                used += entry_size
            elif p == 2:
                if used + entry_size <= budget * 0.6:
                    included.append(rem)
                    used += entry_size
                else:
                    overflow_counts[2] += 1
            elif p == 3:
                if used + entry_size <= budget * 0.85:
                    included.append(rem)
                    used += entry_size
                else:
                    overflow_counts[3] += 1

        # Update fire counts (unless dry run)
        if not dry_run:
            for rem in included:
                new_fire = (rem.get('fire_count') or 0) + 1
                conn.execute(
                    "UPDATE reminders SET fire_count=?, last_fired=?, updated_at=? WHERE id=?",
                    (new_fire, now_iso, now_iso, rem['id'])
                )
                # Auto-complete if max_fires reached
                if rem.get('max_fires') and new_fire >= rem['max_fires']:
                    old = dict(rem)
                    conn.execute(
                        "UPDATE reminders SET status='completed', completed_at=?, updated_at=? WHERE id=?",
                        (now_iso, now_iso, rem['id'])
                    )
                    rem_after = row_to_dict(conn.execute("SELECT * FROM reminders WHERE id=?", (rem['id'],)).fetchone())
                    record_history(conn, rem['id'], 'completed', old_data=old, new_data=rem_after, source='system')
            conn.commit()

        # Format output
        if fmt == 'inline':
            for rem in included:
                ctx = f" — {rem['context']}" if rem.get('context') else ""
                print(f"💡 Reminder [{rem['id'][:8]}]: \"{rem['content']}{ctx}\"")
        elif fmt == 'compact':
            parts = []
            by_priority = {}
            for rem in included:
                p = rem['priority']
                by_priority.setdefault(p, []).append(rem)
            for p in sorted(by_priority):
                items = by_priority[p]
                label = PRIORITY_LABELS.get(p, f"P{p}")
                if len(items) == 1:
                    r = items[0]
                    due_str = ""
                    if r.get('trigger_at'):
                        due_str = f" — {fmt_dt(r['trigger_at'])}"
                    parts.append(f"{len(items)} {label.split(' ', 1)[1].lower()} ({truncate(r['content'], 30)}{due_str})")
                else:
                    parts.append(f"{len(items)} {label.split(' ', 1)[1].lower()}")
            overflow_parts = []
            for p in (2, 3, 4):
                if overflow_counts[p] > 0:
                    overflow_parts.append(f"+{overflow_counts[p]} {PRIORITY_LABELS.get(p, '').split(' ', 1)[1].lower()}")
            extra = ""
            if overflow_parts:
                extra = f", {', '.join(overflow_parts)} hidden"
            print(f"🔔 {', '.join(parts)}{extra}")
        else:
            # Full format
            print("🔔 Active Reminders\n")
            by_priority = {}
            for rem in included:
                by_priority.setdefault(rem['priority'], []).append(rem)

            for p in sorted(by_priority):
                label = PRIORITY_LABELS.get(p, f"P{p}")
                items = by_priority[p]
                count_str = f" ({len(items)})" if len(items) > 1 else ""
                print(f"{label}{count_str}")
                for rem in items:
                    due_str = ""
                    if rem.get('trigger_at'):
                        due_str = f" — due {fmt_dt(rem['trigger_at'])}"
                    fire_str = ""
                    if rem.get('fire_count') and rem['fire_count'] > 0:
                        fire_str = f", fired {rem['fire_count']}x"
                    trigger_info = ""
                    if rem['trigger_type'] == 'keyword':
                        config = json.loads(rem.get('trigger_config') or '{}')
                        kws = config.get('keywords', [])
                        trigger_info = f" (keyword: \"{', '.join(kws)}\")"
                    elif rem['trigger_type'] == 'condition':
                        trigger_info = " (condition: checking)"
                    elif rem['trigger_type'] == 'session':
                        trigger_info = " (session)"
                    elif rem['trigger_type'] == 'heartbeat':
                        trigger_info = " (heartbeat)"

                    print(f"- [{rem['id'][:8]}] {truncate(rem['content'], char_limits.get(p, 60))}{due_str}{fire_str}{trigger_info}")
                    if rem.get('context'):
                        print(f"  Context: {truncate(rem['context'], char_limits.get(p, 60))}")
                    if rem.get('tags'):
                        print(f"  Tags: {rem['tags']}")
                print()

            # Overflow summary
            overflow_total = sum(overflow_counts.values())
            if overflow_total > 0:
                print(f"...and {overflow_total} more (run `agentrem list` for all)")

    finally:
        conn.close()


def cmd_list(args):
    conn = get_db()
    try:
        agent = args.agent or 'main'
        fmt = args.format or 'table'
        limit = args.limit or 20

        conditions = []
        params = []

        if args.all:
            pass  # no status filter
        elif args.status:
            statuses = [s.strip() for s in args.status.split(',')]
            conditions.append(f"status IN ({','.join('?' * len(statuses))})")
            params.extend(statuses)
        else:
            conditions.append("status = 'active'")

        conditions.append("agent = ?")
        params.append(agent)

        if args.priority:
            prios = [int(p.strip()) for p in args.priority.split(',')]
            conditions.append(f"priority IN ({','.join('?' * len(prios))})")
            params.extend(prios)

        if args.tag:
            conditions.append("tags LIKE ?")
            params.append(f"%{args.tag}%")

        if args.trigger:
            conditions.append("trigger_type = ?")
            params.append(args.trigger)

        if args.category:
            conditions.append("category = ?")
            params.append(args.category)

        if args.due:
            now = datetime.now()
            d = args.due.lower()
            if d == 'today':
                eod = now.replace(hour=23, minute=59, second=59)
                conditions.append("trigger_at <= ? AND trigger_type='time'")
                params.append(dt_to_iso(eod))
            elif d == 'tomorrow':
                tmrw = (now + timedelta(days=1)).replace(hour=23, minute=59, second=59)
                conditions.append("trigger_at <= ? AND trigger_type='time'")
                params.append(dt_to_iso(tmrw))
            elif d == 'overdue':
                conditions.append("trigger_at <= ? AND trigger_type='time'")
                params.append(dt_to_iso(now))
            elif d == 'week':
                eow = (now + timedelta(days=7)).replace(hour=23, minute=59, second=59)
                conditions.append("trigger_at <= ? AND trigger_type='time'")
                params.append(dt_to_iso(eow))
            else:
                try:
                    dt = parse_date(d)
                    conditions.append("DATE(trigger_at) = DATE(?)")
                    params.append(dt_to_iso(dt))
                except ValueError:
                    err(f"Cannot parse due filter: '{args.due}'")
                    sys.exit(2)

        where = " AND ".join(conditions) if conditions else "1=1"
        query = f"SELECT * FROM reminders WHERE {where} ORDER BY priority, trigger_at LIMIT ?"
        params.append(limit)

        rows = conn.execute(query, params).fetchall()

        if not rows:
            print("No reminders found.")
            return

        if fmt == 'json':
            result = [row_to_dict(r) for r in rows]
            print(json.dumps(result, indent=2, default=str))
        elif fmt == 'compact':
            for row in rows:
                r = row_to_dict(row)
                due_str = f" due:{fmt_dt(r['trigger_at'])}" if r.get('trigger_at') else ""
                print(f"[{r['id'][:8]}] P{r['priority']} {truncate(r['content'], 40)}{due_str}")
        else:
            # Table format
            header = f"{'ID':>8}  {'P':>1}  {'Status':>9}  {'Trigger':>9}  {'Content':<35}  {'Due/Info':<15}  {'Tags'}"
            print(header)
            print("─" * len(header))
            for row in rows:
                r = row_to_dict(row)
                due_info = fmt_dt(r.get('trigger_at')) if r.get('trigger_at') else r['trigger_type']
                print(f"{r['id'][:8]:>8}  {r['priority']:>1}  {r['status']:>9}  {r['trigger_type']:>9}  "
                      f"{truncate(r['content'], 35):<35}  {due_info:<15}  {r.get('tags') or ''}")
    finally:
        conn.close()


def cmd_search(args):
    conn = get_db()
    try:
        query = args.query
        limit = args.limit or 10
        fmt = args.format or 'table'
        statuses = [s.strip() for s in args.status.split(',')] if args.status else ['active']

        # FTS5 search — join with reminders for status filter
        placeholders = ','.join('?' * len(statuses))
        rows = conn.execute(
            f"""SELECT r.* FROM reminders_fts f
                JOIN reminders r ON r.rowid = f.rowid
                WHERE reminders_fts MATCH ? AND r.status IN ({placeholders})
                ORDER BY rank LIMIT ?""",
            (query, *statuses, limit)
        ).fetchall()

        if not rows:
            print("No results found.")
            sys.exit(1)

        if fmt == 'json':
            print(json.dumps([row_to_dict(r) for r in rows], indent=2, default=str))
        else:
            header = f"{'ID':>8}  {'P':>1}  {'Content':<40}  {'Tags'}"
            print(f"🔍 Search results for \"{query}\":\n")
            print(header)
            print("─" * len(header))
            for row in rows:
                r = row_to_dict(row)
                print(f"{r['id'][:8]:>8}  {r['priority']:>1}  {truncate(r['content'], 40):<40}  {r.get('tags') or ''}")
    finally:
        conn.close()


def cmd_complete(args):
    conn = get_db()
    try:
        rem = find_reminder(conn, args.id)
        if not rem:
            err(f"Reminder not found: {args.id}")
            sys.exit(2)

        now_iso = dt_to_iso(datetime.now())
        old_data = dict(rem)

        # Check for recurrence
        if rem.get('recur_rule'):
            rule = json.loads(rem['recur_rule'])
            next_dt = next_recurrence(rem.get('trigger_at'), rule)
            # Create next occurrence
            conn.execute(
                """INSERT INTO reminders(content, context, trigger_type, trigger_at, trigger_config,
                    priority, tags, category, decay_at, max_fires, recur_rule, recur_parent_id,
                    depends_on, source, agent)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (rem['content'], rem['context'], rem['trigger_type'], dt_to_iso(next_dt),
                 rem['trigger_config'], rem['priority'], rem['tags'], rem['category'],
                 rem['decay_at'], rem['max_fires'], rem['recur_rule'],
                 rem.get('recur_parent_id') or rem['id'],
                 rem['depends_on'], rem['source'], rem['agent'])
            )
            next_rem = row_to_dict(conn.execute("SELECT * FROM reminders WHERE rowid = last_insert_rowid()").fetchone())
            record_history(conn, next_rem['id'], 'created', new_data=next_rem, source='system')
            print(f"📅 Next recurrence [{next_rem['id'][:8]}] created — due {dt_to_iso(next_dt)}")

        # Complete the current one
        notes = args.notes
        if notes and rem.get('notes'):
            notes = rem['notes'] + '\n' + notes

        conn.execute(
            "UPDATE reminders SET status='completed', completed_at=?, updated_at=?, notes=? WHERE id=?",
            (now_iso, now_iso, notes or rem.get('notes'), rem['id'])
        )
        new_data = row_to_dict(conn.execute("SELECT * FROM reminders WHERE id=?", (rem['id'],)).fetchone())
        record_history(conn, rem['id'], 'completed', old_data=old_data, new_data=new_data, source='agent')
        conn.commit()

        print(f"✅ Completed [{rem['id'][:8]}] {rem['content']}")
    finally:
        conn.close()


def cmd_snooze(args):
    conn = get_db()
    try:
        rem = find_reminder(conn, args.id)
        if not rem:
            err(f"Reminder not found: {args.id}")
            sys.exit(2)

        if not args.until and not getattr(args, 'for_duration', None):
            err("Snooze requires --until or --for")
            sys.exit(2)

        if args.until:
            try:
                snooze_dt = parse_date(args.until)
            except ValueError as e:
                err(str(e))
                sys.exit(2)
        else:
            dur = getattr(args, 'for_duration')
            try:
                snooze_dt = parse_date(f"+{dur}")
            except ValueError:
                # Try parsing as relative
                m = re.match(r'^(\d+)([mhdw])$', dur.lower())
                if not m:
                    err(f"Cannot parse duration: '{dur}'")
                    sys.exit(2)
                n, u = int(m.group(1)), m.group(2)
                now = datetime.now()
                if u == 'm':
                    snooze_dt = now + timedelta(minutes=n)
                elif u == 'h':
                    snooze_dt = now + timedelta(hours=n)
                elif u == 'd':
                    snooze_dt = now + timedelta(days=n)
                elif u == 'w':
                    snooze_dt = now + timedelta(weeks=n)

        now_iso = dt_to_iso(datetime.now())
        old_data = dict(rem)

        conn.execute(
            "UPDATE reminders SET status='snoozed', snoozed_until=?, updated_at=? WHERE id=?",
            (dt_to_iso(snooze_dt), now_iso, rem['id'])
        )
        new_data = row_to_dict(conn.execute("SELECT * FROM reminders WHERE id=?", (rem['id'],)).fetchone())
        record_history(conn, rem['id'], 'snoozed', old_data=old_data, new_data=new_data, source='agent')
        conn.commit()

        print(f"😴 Snoozed [{rem['id'][:8]}] until {dt_to_iso(snooze_dt)} ({fmt_dt(dt_to_iso(snooze_dt))})")
    finally:
        conn.close()


def cmd_edit(args):
    conn = get_db()
    try:
        rem = find_reminder(conn, args.id)
        if not rem:
            err(f"Reminder not found: {args.id}")
            sys.exit(2)

        old_data = dict(rem)
        now_iso = dt_to_iso(datetime.now())
        updates = {}

        if args.content is not None:
            updates['content'] = args.content
        if args.context is not None:
            updates['context'] = args.context
        if args.priority is not None:
            if args.priority < 1 or args.priority > 5:
                err("Priority must be 1-5")
                sys.exit(2)
            updates['priority'] = args.priority
        if args.due is not None:
            try:
                updates['trigger_at'] = dt_to_iso(parse_date(args.due))
            except ValueError as e:
                err(str(e))
                sys.exit(2)
        if args.tags is not None:
            updates['tags'] = args.tags
        if args.add_tags:
            existing = set(t.strip() for t in (rem.get('tags') or '').split(',') if t.strip())
            new_tags = set(t.strip() for t in args.add_tags.split(',') if t.strip())
            updates['tags'] = ','.join(sorted(existing | new_tags))
        if args.remove_tags:
            existing = set(t.strip() for t in (rem.get('tags') or '').split(',') if t.strip())
            rm_tags = set(t.strip() for t in args.remove_tags.split(',') if t.strip())
            updates['tags'] = ','.join(sorted(existing - rm_tags))
        if args.category is not None:
            updates['category'] = args.category
        if args.decay is not None:
            try:
                updates['decay_at'] = dt_to_iso(parse_date(args.decay))
            except ValueError as e:
                err(str(e))
                sys.exit(2)
        if args.max_fires is not None:
            updates['max_fires'] = args.max_fires
        if args.keywords is not None:
            config = json.loads(rem.get('trigger_config') or '{}')
            config['keywords'] = [k.strip() for k in args.keywords.split(',')]
            updates['trigger_config'] = json.dumps(config)
        if args.agent is not None:
            updates['agent'] = args.agent

        if not updates:
            err("No changes specified. Use --content, --priority, --due, --tags, etc.")
            sys.exit(2)

        updates['updated_at'] = now_iso
        set_clause = ', '.join(f"{k}=?" for k in updates)
        values = list(updates.values()) + [rem['id']]

        conn.execute(f"UPDATE reminders SET {set_clause} WHERE id=?", values)
        new_data = row_to_dict(conn.execute("SELECT * FROM reminders WHERE id=?", (rem['id'],)).fetchone())
        record_history(conn, rem['id'], 'updated', old_data=old_data, new_data=new_data, source='agent')
        conn.commit()

        print(f"✏️  Updated [{rem['id'][:8]}]")
        for k, v in updates.items():
            if k != 'updated_at':
                print(f"  {k}: {v}")
    finally:
        conn.close()


def cmd_delete(args):
    conn = get_db()
    try:
        now_iso = dt_to_iso(datetime.now())

        # Bulk delete by status
        if args.status:
            conditions = ["status = ?"]
            params = [args.status]
            if args.older_than:
                cutoff = dt_to_iso(datetime.now() - timedelta(days=int(args.older_than)))
                conditions.append("updated_at <= ?")
                params.append(cutoff)

            where = " AND ".join(conditions)

            if args.permanent:
                count = conn.execute(f"SELECT COUNT(*) FROM reminders WHERE {where}", params).fetchone()[0]
                conn.execute(f"DELETE FROM reminders WHERE {where}", params)
            else:
                count = conn.execute(f"SELECT COUNT(*) FROM reminders WHERE {where}", params).fetchone()[0]
                conn.execute(f"UPDATE reminders SET status='deleted', updated_at=? WHERE {where}",
                            [now_iso] + params)
            conn.commit()
            mode = "Permanently deleted" if args.permanent else "Soft-deleted"
            print(f"🗑️  {mode} {count} reminders with status '{args.status}'")
            return

        if not args.id:
            err("Reminder ID required (or use --status for bulk delete)")
            sys.exit(2)

        rem = find_reminder(conn, args.id)
        if not rem:
            err(f"Reminder not found: {args.id}")
            sys.exit(2)

        old_data = dict(rem)

        if args.permanent:
            conn.execute("DELETE FROM reminders WHERE id=?", (rem['id'],))
            record_history(conn, rem['id'], 'deleted', old_data=old_data, source='agent')
            conn.commit()
            print(f"🗑️  Permanently deleted [{rem['id'][:8]}]")
        else:
            conn.execute("UPDATE reminders SET status='deleted', updated_at=? WHERE id=?",
                        (now_iso, rem['id']))
            new_data = row_to_dict(conn.execute("SELECT * FROM reminders WHERE id=?", (rem['id'],)).fetchone())
            record_history(conn, rem['id'], 'deleted', old_data=old_data, new_data=new_data, source='agent')
            conn.commit()
            print(f"🗑️  Deleted [{rem['id'][:8]}] (soft delete — use --permanent to remove permanently)")
    finally:
        conn.close()


def cmd_stats(args):
    conn = get_db()
    try:
        # Active counts by priority
        active = conn.execute(
            "SELECT priority, COUNT(*) as cnt FROM reminders WHERE status='active' GROUP BY priority ORDER BY priority"
        ).fetchall()
        total_active = sum(r['cnt'] for r in active)
        prio_parts = []
        for r in active:
            label = {1: 'critical', 2: 'high', 3: 'normal', 4: 'low', 5: 'someday'}.get(r['priority'], f"p{r['priority']}")
            prio_parts.append(f"{r['cnt']} {label}")

        # Overdue
        now_iso = dt_to_iso(datetime.now())
        overdue = conn.execute(
            "SELECT COUNT(*) FROM reminders WHERE trigger_type='time' AND trigger_at <= ? AND status='active'",
            (now_iso,)
        ).fetchone()[0]

        # Snoozed
        snoozed = conn.execute("SELECT COUNT(*) FROM reminders WHERE status='snoozed'").fetchone()[0]

        # Completed this week
        week_ago = dt_to_iso(datetime.now() - timedelta(days=7))
        completed_week = conn.execute(
            "SELECT COUNT(*) FROM reminders WHERE status='completed' AND completed_at >= ?",
            (week_ago,)
        ).fetchone()[0]

        # Expired
        expired = conn.execute("SELECT COUNT(*) FROM reminders WHERE status='expired'").fetchone()[0]

        # By trigger type
        triggers = conn.execute(
            "SELECT trigger_type, COUNT(*) as cnt FROM reminders WHERE status='active' GROUP BY trigger_type ORDER BY cnt DESC"
        ).fetchall()
        trigger_parts = [f"{r['cnt']} {r['trigger_type']}" for r in triggers]

        # Next due
        next_due = conn.execute(
            "SELECT content, trigger_at FROM reminders WHERE trigger_type='time' AND trigger_at > ? AND status='active' ORDER BY trigger_at LIMIT 1",
            (now_iso,)
        ).fetchone()

        # Last created
        last = conn.execute("SELECT created_at FROM reminders ORDER BY created_at DESC LIMIT 1").fetchone()

        # DB size
        db_size = DB_PATH.stat().st_size if DB_PATH.exists() else 0
        if db_size > 1024 * 1024:
            size_str = f"{db_size / 1024 / 1024:.1f} MB"
        else:
            size_str = f"{db_size / 1024:.0f} KB"

        print("📊 Agent Reminders Stats")
        prio_str = f" ({', '.join(prio_parts)})" if prio_parts else ""
        print(f"Active: {total_active}{prio_str}")
        print(f"Overdue: {overdue}")
        print(f"Snoozed: {snoozed}")
        print(f"Completed (this week): {completed_week}")
        print(f"Expired: {expired}")
        if trigger_parts:
            print(f"By trigger: {', '.join(trigger_parts)}")
        if next_due:
            print(f"Next due: \"{truncate(next_due['content'], 30)}\" {fmt_dt(next_due['trigger_at'])}")
        if last:
            print(f"Last created: {fmt_dt(last['created_at'])}")
        print(f"DB size: {size_str}")
    finally:
        conn.close()


def cmd_gc(args):
    conn = get_db()
    try:
        older_than = int(args.older_than or 30)
        cutoff = dt_to_iso(datetime.now() - timedelta(days=older_than))

        rows = conn.execute(
            "SELECT id, status, content FROM reminders WHERE status IN ('completed', 'expired', 'deleted') AND updated_at <= ?",
            (cutoff,)
        ).fetchall()

        if not rows:
            print("No reminders to clean up.")
            return

        if args.dry_run:
            print(f"🔍 Dry run — would remove {len(rows)} reminders:")
            for r in rows:
                print(f"  [{r['id'][:8]}] {r['status']}: {truncate(r['content'], 40)}")
            return

        ids = [r['id'] for r in rows]
        placeholders = ','.join('?' * len(ids))
        conn.execute(f"DELETE FROM reminders WHERE id IN ({placeholders})", ids)
        conn.execute(f"DELETE FROM history WHERE reminder_id IN ({placeholders})", ids)
        conn.execute("VACUUM")
        conn.commit()

        print(f"🗑️  Removed {len(rows)} old reminders and vacuumed database.")
    finally:
        conn.close()


def cmd_history(args):
    conn = get_db()
    try:
        limit = args.limit or 20
        fmt = args.format or 'table'

        if args.id:
            rem = find_reminder(conn, args.id)
            if rem:
                rid = rem['id']
            else:
                rid = args.id
            rows = conn.execute(
                "SELECT * FROM history WHERE reminder_id = ? OR reminder_id LIKE ? ORDER BY timestamp DESC LIMIT ?",
                (rid, rid + '%', limit)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM history ORDER BY timestamp DESC LIMIT ?",
                (limit,)
            ).fetchall()

        if not rows:
            print("No history found.")
            return

        if fmt == 'json':
            print(json.dumps([row_to_dict(r) for r in rows], indent=2, default=str))
        else:
            print(f"{'HID':>4}  {'Reminder':>8}  {'Action':>10}  {'When':<15}  {'Source'}")
            print("─" * 60)
            for row in rows:
                r = row_to_dict(row)
                print(f"{r['id']:>4}  {r['reminder_id'][:8]:>8}  {r['action']:>10}  "
                      f"{fmt_dt(r['timestamp']):<15}  {r.get('source') or ''}")
    finally:
        conn.close()


def cmd_undo(args):
    conn = get_db()
    try:
        hist = conn.execute("SELECT * FROM history WHERE id = ?", (int(args.history_id),)).fetchone()
        if not hist:
            err(f"History entry not found: {args.history_id}")
            sys.exit(2)

        h = row_to_dict(hist)
        if h['action'] == 'created':
            err("Cannot undo creation — use `agentrem delete` instead")
            sys.exit(2)

        if not h.get('old_data'):
            err("No old data to restore")
            sys.exit(2)

        old = json.loads(h['old_data'])
        rem = find_reminder(conn, h['reminder_id'])

        if not rem:
            # Reminder might have been permanently deleted — recreate
            cols = list(old.keys())
            placeholders = ','.join('?' * len(cols))
            col_names = ','.join(cols)
            conn.execute(f"INSERT INTO reminders({col_names}) VALUES ({placeholders})", list(old.values()))
        else:
            # Update to old state
            now_iso = dt_to_iso(datetime.now())
            old['updated_at'] = now_iso
            set_clause = ', '.join(f"{k}=?" for k in old if k != 'id')
            values = [v for k, v in old.items() if k != 'id'] + [h['reminder_id']]
            conn.execute(f"UPDATE reminders SET {set_clause} WHERE id=?", values)

        record_history(conn, h['reminder_id'], 'reverted', old_data=rem, new_data=old, source='agent')
        conn.commit()

        print(f"↩️  Reverted history #{h['id']} — reminder [{h['reminder_id'][:8]}] restored to previous state")
    finally:
        conn.close()


def cmd_export(args):
    conn = get_db()
    try:
        conditions = []
        params = []

        if args.status:
            statuses = [s.strip() for s in args.status.split(',')]
            conditions.append(f"status IN ({','.join('?' * len(statuses))})")
            params.extend(statuses)

        where = "WHERE " + " AND ".join(conditions) if conditions else ""
        reminders = [row_to_dict(r) for r in conn.execute(f"SELECT * FROM reminders {where}", params).fetchall()]

        # Get history for exported reminders
        all_history = []
        for rem in reminders:
            h = [row_to_dict(r) for r in conn.execute(
                "SELECT * FROM history WHERE reminder_id = ?", (rem['id'],)
            ).fetchall()]
            all_history.extend(h)

        export_data = {
            "exported_at": dt_to_iso(datetime.now()),
            "schema_version": SCHEMA_VERSION,
            "reminder_count": len(reminders),
            "reminders": reminders,
            "history": all_history
        }

        if args.out:
            out_path = Path(args.out)
        else:
            ts = datetime.now().strftime('%Y%m%d-%H%M%S')
            out_path = AGENTREM_DIR / f"export-{ts}.json"

        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(export_data, indent=2, default=str))

        print(f"📦 Exported {len(reminders)} reminders to {out_path}")
    finally:
        conn.close()


def cmd_import(args):
    conn = get_db()
    try:
        filepath = Path(args.file)
        if not filepath.exists():
            err(f"File not found: {filepath}")
            sys.exit(2)

        data = json.loads(filepath.read_text())
        reminders = data.get('reminders', [])
        history = data.get('history', [])

        if args.dry_run:
            print(f"🔍 Dry run — would import {len(reminders)} reminders and {len(history)} history entries")
            return

        if args.replace:
            conn.execute("DELETE FROM reminders")
            conn.execute("DELETE FROM history")

        imported = 0
        skipped = 0
        for rem in reminders:
            if args.merge:
                existing = conn.execute("SELECT id FROM reminders WHERE id = ?", (rem['id'],)).fetchone()
                if existing:
                    skipped += 1
                    continue
            cols = list(rem.keys())
            placeholders = ','.join('?' * len(cols))
            col_names = ','.join(cols)
            try:
                conn.execute(f"INSERT INTO reminders({col_names}) VALUES ({placeholders})",
                            [rem[c] for c in cols])
                imported += 1
            except sqlite3.IntegrityError:
                skipped += 1

        # Import history
        hist_imported = 0
        for h in history:
            try:
                conn.execute(
                    "INSERT INTO history(reminder_id, action, old_data, new_data, timestamp, source) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (h['reminder_id'], h['action'], h.get('old_data'), h.get('new_data'),
                     h['timestamp'], h.get('source'))
                )
                hist_imported += 1
            except Exception:
                pass

        conn.commit()
        print(f"📥 Imported {imported} reminders ({skipped} skipped), {hist_imported} history entries")
    finally:
        conn.close()


def cmd_schema(args):
    conn = get_db()
    try:
        rows = conn.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").fetchall()
        for row in rows:
            print(row['sql'])
            print()
    finally:
        conn.close()


# ── CLI Parser ─────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='agentrem',
        description='Structured reminders CLI for AI agents'
    )
    parser.add_argument('--version', action='version', version=f'%(prog)s {__version__}')
    sub = parser.add_subparsers(dest='command')

    # init
    p_init = sub.add_parser('init', help='Initialize database')
    p_init.add_argument('--force', action='store_true', help='Force recreate (backs up existing)')

    # add
    p_add = sub.add_parser('add', help='Add a reminder')
    p_add.add_argument('content', help='Reminder text')
    p_add.add_argument('--due', '-d', help='Due datetime')
    p_add.add_argument('--trigger', '-t', help='Trigger type')
    p_add.add_argument('--priority', '-p', type=int, help='Priority 1-5')
    p_add.add_argument('--tags', help='Comma-separated tags')
    p_add.add_argument('--context', '-c', help='Context string')
    p_add.add_argument('--category', help='Category')
    p_add.add_argument('--keywords', '-k', help='Keywords for keyword trigger')
    p_add.add_argument('--match', help='Keyword match mode: any|all|regex')
    p_add.add_argument('--check', help='Shell command for condition trigger')
    p_add.add_argument('--expect', help='Expected output for condition trigger')
    p_add.add_argument('--decay', help='Auto-expire datetime')
    p_add.add_argument('--max-fires', type=int, help='Auto-complete after N fires')
    p_add.add_argument('--recur', '-r', help='Recurrence: 1d, 1w, 2w, 1m')
    p_add.add_argument('--agent', '-a', help='Target agent')
    p_add.add_argument('--depends-on', help='Dependency reminder ID')
    p_add.add_argument('--source', help='Source: agent|user|system')
    p_add.add_argument('--dry-run', action='store_true', help='Preview without creating')

    # check
    p_check = sub.add_parser('check', help='Check for triggered reminders')
    p_check.add_argument('--type', help='Comma-separated trigger types')
    p_check.add_argument('--text', help='User message text (for keyword matching)')
    p_check.add_argument('--budget', type=int, help='Token budget (default 800)')
    p_check.add_argument('--format', choices=['full', 'compact', 'inline'], help='Output format')
    p_check.add_argument('--agent', '-a', help='Agent name')
    p_check.add_argument('--escalate', action='store_true', help='Run escalation checks')
    p_check.add_argument('--dry-run', action='store_true', help='Preview without updating')

    # list
    p_list = sub.add_parser('list', help='List reminders')
    p_list.add_argument('--status', '-s', help='Comma-separated statuses')
    p_list.add_argument('--priority', help='Comma-separated priorities')
    p_list.add_argument('--tag', help='Filter by tag')
    p_list.add_argument('--trigger', help='Filter by trigger type')
    p_list.add_argument('--due', help='Due filter: today|tomorrow|overdue|week|date')
    p_list.add_argument('--agent', '-a', help='Agent name')
    p_list.add_argument('--category', help='Category filter')
    p_list.add_argument('--limit', type=int, help='Max results')
    p_list.add_argument('--format', choices=['table', 'json', 'compact'], help='Output format')
    p_list.add_argument('--all', action='store_true', help='Show all statuses')

    # search
    p_search = sub.add_parser('search', help='Full-text search')
    p_search.add_argument('query', help='Search query')
    p_search.add_argument('--status', help='Filter statuses')
    p_search.add_argument('--limit', type=int, help='Max results')
    p_search.add_argument('--format', choices=['table', 'json'], help='Output format')

    # complete
    p_complete = sub.add_parser('complete', help='Complete a reminder')
    p_complete.add_argument('id', help='Reminder ID')
    p_complete.add_argument('--notes', help='Completion notes')

    # snooze
    p_snooze = sub.add_parser('snooze', help='Snooze a reminder')
    p_snooze.add_argument('id', help='Reminder ID')
    p_snooze.add_argument('--until', help='Snooze until datetime')
    p_snooze.add_argument('--for', dest='for_duration', help='Snooze duration: 1h, 2h, 1d, 3d, 1w')

    # edit
    p_edit = sub.add_parser('edit', help='Edit a reminder')
    p_edit.add_argument('id', help='Reminder ID')
    p_edit.add_argument('--content', help='New content')
    p_edit.add_argument('--context', help='New context')
    p_edit.add_argument('--priority', '-p', type=int, help='New priority')
    p_edit.add_argument('--due', '-d', help='New due date')
    p_edit.add_argument('--tags', help='Replace tags')
    p_edit.add_argument('--add-tags', help='Add tags')
    p_edit.add_argument('--remove-tags', help='Remove tags')
    p_edit.add_argument('--category', help='New category')
    p_edit.add_argument('--decay', help='New decay date')
    p_edit.add_argument('--max-fires', type=int, help='New max fires')
    p_edit.add_argument('--keywords', '-k', help='New keywords')
    p_edit.add_argument('--agent', '-a', help='New agent')

    # delete
    p_delete = sub.add_parser('delete', help='Delete a reminder')
    p_delete.add_argument('id', nargs='?', help='Reminder ID')
    p_delete.add_argument('--permanent', action='store_true', help='Permanently delete')
    p_delete.add_argument('--status', help='Bulk delete by status')
    p_delete.add_argument('--older-than', help='Delete older than N days')

    # stats
    sub.add_parser('stats', help='Show statistics')

    # gc
    p_gc = sub.add_parser('gc', help='Garbage collection')
    p_gc.add_argument('--older-than', help='Days threshold (default 30)')
    p_gc.add_argument('--dry-run', action='store_true', help='Preview')

    # history
    p_hist = sub.add_parser('history', help='View history')
    p_hist.add_argument('id', nargs='?', help='Reminder ID (optional)')
    p_hist.add_argument('--limit', type=int, help='Number of entries')
    p_hist.add_argument('--format', choices=['table', 'json'], help='Output format')

    # undo
    p_undo = sub.add_parser('undo', help='Undo a change')
    p_undo.add_argument('history_id', help='History entry ID')

    # export
    p_export = sub.add_parser('export', help='Export reminders')
    p_export.add_argument('--out', '-o', help='Output path')
    p_export.add_argument('--status', help='Filter by status')

    # import
    p_import = sub.add_parser('import', help='Import reminders')
    p_import.add_argument('file', help='JSON file to import')
    p_import.add_argument('--merge', action='store_true', help='Merge (skip duplicates)')
    p_import.add_argument('--replace', action='store_true', help='Replace all existing')
    p_import.add_argument('--dry-run', action='store_true', help='Preview')

    # schema
    sub.add_parser('schema', help='Show database schema')

    return parser


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    handlers = {
        'init': cmd_init,
        'add': cmd_add,
        'check': cmd_check,
        'list': cmd_list,
        'search': cmd_search,
        'complete': cmd_complete,
        'snooze': cmd_snooze,
        'edit': cmd_edit,
        'delete': cmd_delete,
        'stats': cmd_stats,
        'gc': cmd_gc,
        'history': cmd_history,
        'undo': cmd_undo,
        'export': cmd_export,
        'import': cmd_import,
        'schema': cmd_schema,
    }

    handler = handlers.get(args.command)
    if not handler:
        err(f"Unknown command: {args.command}")
        sys.exit(2)

    try:
        handler(args)
    except sqlite3.DatabaseError as e:
        err(f"Database error: {e}")
        err("Try running: agentrem init --force")
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)
    except SystemExit:
        raise
    except Exception as e:
        err(f"Unexpected error: {e}")
        sys.exit(2)


if __name__ == '__main__':
    main()
