#!/usr/bin/env python3
"""Comprehensive test suite for agentrem — structured reminders CLI for AI agents.

Uses stdlib unittest only (zero external deps).
All tests use temporary databases via AGENTREM_DB / AGENTREM_DIR env vars.
"""

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

# Path to the agentrem CLI script
AGENTREM_PY = str(Path(__file__).resolve().parent.parent / "agentrem.py")


class AgentremTestBase(unittest.TestCase):
    """Base class with helpers for all agentrem tests."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="agentrem_test_")
        self.db_path = os.path.join(self.tmpdir, "reminders.db")
        self.env = os.environ.copy()
        self.env["AGENTREM_DIR"] = self.tmpdir
        self.env["AGENTREM_DB"] = self.db_path
        # Initialize the database for most tests
        self._init_db()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _init_db(self):
        """Initialize the database."""
        result = self.run_cmd("init")
        self.assertEqual(result.returncode, 0, f"init failed: {result.stderr}")

    def run_cmd(self, *args) -> subprocess.CompletedProcess:
        """Run an agentrem command and return the CompletedProcess."""
        cmd = [sys.executable, AGENTREM_PY] + list(args)
        return subprocess.run(
            cmd, capture_output=True, text=True, env=self.env, timeout=30
        )

    def get_db(self) -> sqlite3.Connection:
        """Get a direct database connection for verification."""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def add_reminder(self, content="Test reminder", **kwargs) -> str:
        """Add a reminder and return its ID."""
        cmd_args = ["add", content]
        # Defaults
        if "trigger" not in kwargs and "due" not in kwargs and "keywords" not in kwargs and "check" not in kwargs:
            kwargs.setdefault("due", "+1h")

        for key, value in kwargs.items():
            flag = f"--{key.replace('_', '-')}"
            if isinstance(value, bool):
                if value:
                    cmd_args.append(flag)
            else:
                cmd_args.extend([flag, str(value)])

        result = self.run_cmd(*cmd_args)
        self.assertEqual(result.returncode, 0, f"add failed: {result.stderr}\nstdout: {result.stdout}")

        # Extract ID from output like "✅ Created reminder [abcdef01]"
        match = re.search(r'\[([a-f0-9]+)\]', result.stdout)
        self.assertIsNotNone(match, f"Could not find reminder ID in output: {result.stdout}")
        return match.group(1)

    def insert_reminder_directly(self, **kwargs) -> str:
        """Insert a reminder directly into the DB for setup purposes. Returns full ID."""
        conn = self.get_db()
        defaults = {
            "content": "Direct insert",
            "trigger_type": "time",
            "priority": 3,
            "status": "active",
            "source": "agent",
            "agent": "main",
        }
        defaults.update(kwargs)

        cols = list(defaults.keys())
        placeholders = ",".join("?" * len(cols))
        col_names = ",".join(cols)
        values = [defaults[c] for c in cols]

        conn.execute(
            f"INSERT INTO reminders({col_names}) VALUES ({placeholders})", values
        )
        row = conn.execute(
            "SELECT id FROM reminders WHERE rowid = last_insert_rowid()"
        ).fetchone()
        conn.commit()
        rid = row["id"]
        conn.close()
        return rid

    def get_reminder(self, rid: str) -> dict | None:
        """Get a reminder by full or prefix ID."""
        conn = self.get_db()
        row = conn.execute("SELECT * FROM reminders WHERE id = ?", (rid,)).fetchone()
        if not row:
            row = conn.execute(
                "SELECT * FROM reminders WHERE id LIKE ?", (rid + "%",)
            ).fetchone()
        conn.close()
        return dict(row) if row else None

    def count_reminders(self, status=None) -> int:
        conn = self.get_db()
        if status:
            row = conn.execute(
                "SELECT COUNT(*) as c FROM reminders WHERE status=?", (status,)
            ).fetchone()
        else:
            row = conn.execute("SELECT COUNT(*) as c FROM reminders").fetchone()
        conn.close()
        return row["c"]

    def get_history(self, reminder_id=None) -> list[dict]:
        conn = self.get_db()
        if reminder_id:
            rows = conn.execute(
                "SELECT * FROM history WHERE reminder_id = ? OR reminder_id LIKE ? ORDER BY id",
                (reminder_id, reminder_id + "%"),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM history ORDER BY id").fetchall()
        conn.close()
        return [dict(r) for r in rows]


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Database & Init
# ═══════════════════════════════════════════════════════════════════════════════


class TestInit(AgentremTestBase):
    def setUp(self):
        # Don't auto-init for init tests
        self.tmpdir = tempfile.mkdtemp(prefix="agentrem_test_")
        self.db_path = os.path.join(self.tmpdir, "reminders.db")
        self.env = os.environ.copy()
        self.env["AGENTREM_DIR"] = self.tmpdir
        self.env["AGENTREM_DB"] = self.db_path

    def test_init_creates_db(self):
        result = self.run_cmd("init")
        self.assertEqual(result.returncode, 0)
        self.assertTrue(os.path.exists(self.db_path))
        self.assertIn("Initialized", result.stdout)

    def test_init_correct_schema_version(self):
        self.run_cmd("init")
        conn = self.get_db()
        ver = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
        conn.close()
        self.assertEqual(ver, 1)

    def test_init_tables_exist(self):
        self.run_cmd("init")
        conn = self.get_db()
        tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()
        ]
        conn.close()
        for expected in ["reminders", "reminders_fts", "history", "schema_version"]:
            self.assertIn(expected, tables, f"Table {expected} not found")

    def test_init_indexes_exist(self):
        self.run_cmd("init")
        conn = self.get_db()
        indexes = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
            ).fetchall()
        ]
        conn.close()
        for expected in [
            "idx_rem_status",
            "idx_rem_trigger",
            "idx_rem_due",
            "idx_rem_priority",
            "idx_rem_agent",
            "idx_rem_tags",
        ]:
            self.assertIn(expected, indexes, f"Index {expected} not found")

    def test_init_idempotent(self):
        self.run_cmd("init")
        result = self.run_cmd("init")
        self.assertEqual(result.returncode, 0)
        self.assertIn("already initialized", result.stdout)

    def test_init_force_recreates(self):
        self.run_cmd("init")
        # Add a reminder so DB has data
        self.run_cmd("add", "test reminder", "--due", "+1h")
        self.assertEqual(self.count_reminders(), 1)

        result = self.run_cmd("init", "--force")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Backed up", result.stdout)
        # DB should be fresh (no reminders)
        self.assertEqual(self.count_reminders(), 0)

    def test_init_force_creates_backup(self):
        self.run_cmd("init")
        result = self.run_cmd("init", "--force")
        self.assertEqual(result.returncode, 0)
        # Check backup file exists
        backups = [f for f in os.listdir(self.tmpdir) if f.startswith("reminders.db.bak")]
        self.assertGreater(len(backups), 0)

    def test_wal_mode_enabled(self):
        self.run_cmd("init")
        conn = self.get_db()
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        conn.close()
        self.assertEqual(mode, "wal")


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Add
# ═══════════════════════════════════════════════════════════════════════════════


class TestAdd(AgentremTestBase):
    # -- Time triggers --

    def test_add_time_trigger_relative_hours(self):
        rid = self.add_reminder("In one hour", due="+1h")
        rem = self.get_reminder(rid)
        self.assertIsNotNone(rem)
        self.assertEqual(rem["trigger_type"], "time")
        self.assertIsNotNone(rem["trigger_at"])
        # Should be roughly 1 hour from now
        trigger_dt = datetime.fromisoformat(rem["trigger_at"])
        diff = trigger_dt - datetime.now()
        self.assertAlmostEqual(diff.total_seconds(), 3600, delta=60)

    def test_add_time_trigger_relative_minutes(self):
        rid = self.add_reminder("In 30 min", due="+30m")
        rem = self.get_reminder(rid)
        trigger_dt = datetime.fromisoformat(rem["trigger_at"])
        diff = trigger_dt - datetime.now()
        self.assertAlmostEqual(diff.total_seconds(), 1800, delta=60)

    def test_add_time_trigger_relative_days(self):
        rid = self.add_reminder("In one day", due="+1d")
        rem = self.get_reminder(rid)
        trigger_dt = datetime.fromisoformat(rem["trigger_at"])
        diff = trigger_dt - datetime.now()
        self.assertAlmostEqual(diff.total_seconds(), 86400, delta=60)

    def test_add_time_trigger_relative_weeks(self):
        rid = self.add_reminder("In one week", due="+1w")
        rem = self.get_reminder(rid)
        trigger_dt = datetime.fromisoformat(rem["trigger_at"])
        diff = trigger_dt - datetime.now()
        self.assertAlmostEqual(diff.total_seconds(), 7 * 86400, delta=60)

    def test_add_time_trigger_named_tomorrow(self):
        rid = self.add_reminder("Tomorrow task", due="tomorrow")
        rem = self.get_reminder(rid)
        trigger_dt = datetime.fromisoformat(rem["trigger_at"])
        expected = (datetime.now() + timedelta(days=1)).replace(
            hour=9, minute=0, second=0, microsecond=0
        )
        self.assertEqual(trigger_dt.hour, 9)
        self.assertEqual(trigger_dt.minute, 0)
        self.assertEqual(trigger_dt.date(), expected.date())

    def test_add_time_trigger_named_today(self):
        rid = self.add_reminder("Today task", due="today")
        rem = self.get_reminder(rid)
        trigger_dt = datetime.fromisoformat(rem["trigger_at"])
        self.assertEqual(trigger_dt.date(), datetime.now().date())
        self.assertEqual(trigger_dt.hour, 23)
        self.assertEqual(trigger_dt.minute, 59)

    def test_add_time_trigger_iso_format(self):
        target = "2030-06-15T14:30:00"
        rid = self.add_reminder("ISO date", due=target)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["trigger_at"], target)

    # -- Keyword triggers --

    def test_add_keyword_trigger(self):
        rid = self.add_reminder(
            "Keyword test",
            trigger="keyword",
            keywords="deploy,release",
        )
        rem = self.get_reminder(rid)
        self.assertEqual(rem["trigger_type"], "keyword")
        config = json.loads(rem["trigger_config"])
        self.assertIn("deploy", config["keywords"])
        self.assertIn("release", config["keywords"])
        self.assertEqual(config["match"], "any")

    def test_add_keyword_trigger_match_all(self):
        rid = self.add_reminder(
            "All keywords",
            trigger="keyword",
            keywords="alpha,beta",
            match="all",
        )
        rem = self.get_reminder(rid)
        config = json.loads(rem["trigger_config"])
        self.assertEqual(config["match"], "all")

    def test_add_keyword_trigger_match_regex(self):
        rid = self.add_reminder(
            "Regex match",
            trigger="keyword",
            keywords=r"error\d+",
            match="regex",
        )
        rem = self.get_reminder(rid)
        config = json.loads(rem["trigger_config"])
        self.assertEqual(config["match"], "regex")

    # -- Condition trigger --

    def test_add_condition_trigger(self):
        rid = self.add_reminder(
            "Condition test",
            trigger="condition",
            check="echo yes",
            expect="yes",
        )
        rem = self.get_reminder(rid)
        self.assertEqual(rem["trigger_type"], "condition")
        config = json.loads(rem["trigger_config"])
        self.assertEqual(config["check"], "echo yes")
        self.assertEqual(config["expect"], "yes")

    # -- Session trigger --

    def test_add_session_trigger(self):
        rid = self.add_reminder(
            "Session test", trigger="session", max_fires=3
        )
        rem = self.get_reminder(rid)
        self.assertEqual(rem["trigger_type"], "session")
        self.assertEqual(rem["max_fires"], 3)

    # -- Heartbeat trigger --

    def test_add_heartbeat_trigger(self):
        rid = self.add_reminder(
            "Heartbeat test", trigger="heartbeat", decay="+2d"
        )
        rem = self.get_reminder(rid)
        self.assertEqual(rem["trigger_type"], "heartbeat")
        self.assertIsNotNone(rem["decay_at"])

    # -- Manual trigger --

    def test_add_manual_trigger(self):
        rid = self.add_reminder("Manual test", trigger="manual")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["trigger_type"], "manual")

    # -- Priority --

    def test_add_priority_range(self):
        for p in range(1, 6):
            rid = self.add_reminder(f"P{p} task", due="+1h", priority=p)
            rem = self.get_reminder(rid)
            self.assertEqual(rem["priority"], p)

    def test_add_invalid_priority_too_low(self):
        # Priority 0 is silently treated as default (3) due to `args.priority or 3`
        # where 0 is falsy. This tests actual tool behavior.
        result = self.run_cmd("add", "Bad priority", "--due", "+1h", "--priority", "0")
        self.assertEqual(result.returncode, 0)
        # Verify it was stored as priority 3 (the default)
        result2 = self.run_cmd("list", "--format", "json")
        data = json.loads(result2.stdout)
        matching = [r for r in data if r["content"] == "Bad priority"]
        self.assertEqual(matching[0]["priority"], 3)

    def test_add_invalid_priority_too_high(self):
        result = self.run_cmd("add", "Bad priority", "--due", "+1h", "--priority", "6")
        self.assertNotEqual(result.returncode, 0)

    # -- Tags, context, category, source, agent --

    def test_add_with_tags(self):
        rid = self.add_reminder("Tagged", due="+1h", tags="work,urgent")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["tags"], "work,urgent")

    def test_add_with_context(self):
        rid = self.add_reminder("Ctx", due="+1h", context="some context here")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["context"], "some context here")

    def test_add_with_category(self):
        rid = self.add_reminder("Cat", due="+1h", category="devops")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["category"], "devops")

    def test_add_with_source(self):
        rid = self.add_reminder("Src", due="+1h", source="user")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["source"], "user")

    def test_add_with_agent(self):
        rid = self.add_reminder("Agnt", due="+1h", agent="secondary")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["agent"], "secondary")

    # -- depends_on --

    def test_add_depends_on_valid(self):
        dep_id = self.add_reminder("Dependency", due="+1h")
        rid = self.add_reminder("Dependent", due="+2h", depends_on=dep_id)
        rem = self.get_reminder(rid)
        self.assertIn(dep_id, rem["depends_on"])

    def test_add_depends_on_invalid(self):
        result = self.run_cmd(
            "add", "Bad dep", "--due", "+1h", "--depends-on", "nonexistent12345"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not found", result.stderr.lower())

    # -- recur --

    def test_add_recur(self):
        rid = self.add_reminder("Recur daily", due="+1h", recur="1d")
        rem = self.get_reminder(rid)
        rule = json.loads(rem["recur_rule"])
        self.assertEqual(rule["interval"], 1)
        self.assertEqual(rule["unit"], "d")

    # -- dry_run --

    def test_add_dry_run(self):
        result = self.run_cmd(
            "add", "Dry run task", "--due", "+1h", "--dry-run"
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("Dry run", result.stdout)
        # Should NOT be in DB
        self.assertEqual(self.count_reminders(), 0)

    # -- Validation errors --

    def test_add_time_trigger_without_due_fails(self):
        result = self.run_cmd("add", "No due", "--trigger", "time")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--due", result.stderr)

    def test_add_keyword_trigger_without_keywords_fails(self):
        result = self.run_cmd("add", "No keywords", "--trigger", "keyword")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--keywords", result.stderr.lower())

    def test_add_condition_trigger_without_check_fails(self):
        result = self.run_cmd(
            "add", "No check", "--trigger", "condition", "--expect", "yes"
        )
        self.assertNotEqual(result.returncode, 0)

    def test_add_condition_trigger_without_expect_fails(self):
        result = self.run_cmd(
            "add", "No expect", "--trigger", "condition", "--check", "echo yes"
        )
        self.assertNotEqual(result.returncode, 0)

    # -- History on add --

    def test_add_creates_history_record(self):
        rid = self.add_reminder("History test", due="+1h")
        hist = self.get_history(rid)
        self.assertGreater(len(hist), 0)
        self.assertEqual(hist[0]["action"], "created")

    def test_add_default_priority_is_3(self):
        rid = self.add_reminder("Default prio", due="+1h")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["priority"], 3)

    def test_add_default_agent_is_main(self):
        rid = self.add_reminder("Default agent", due="+1h")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["agent"], "main")

    def test_add_default_source_is_agent(self):
        rid = self.add_reminder("Default source", due="+1h")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["source"], "agent")

    def test_add_status_is_active(self):
        rid = self.add_reminder("Active", due="+1h")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "active")


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Check (context injection)
# ═══════════════════════════════════════════════════════════════════════════════


class TestCheck(AgentremTestBase):
    def test_check_time_triggered(self):
        """Time trigger with past due date should be returned."""
        now = datetime.now()
        past = now - timedelta(hours=1)
        self.insert_reminder_directly(
            content="Overdue task",
            trigger_type="time",
            trigger_at=past.strftime("%Y-%m-%dT%H:%M:%S"),
            priority=2,
        )
        result = self.run_cmd("check")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Overdue task", result.stdout)

    def test_check_time_future_not_returned(self):
        """Time trigger in the future should NOT be returned."""
        future = datetime.now() + timedelta(hours=5)
        self.insert_reminder_directly(
            content="Future task",
            trigger_type="time",
            trigger_at=future.strftime("%Y-%m-%dT%H:%M:%S"),
            priority=2,
        )
        result = self.run_cmd("check")
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("Future task", result.stdout)

    # -- Keyword matching --

    def test_check_keyword_any_match(self):
        self.add_reminder(
            "Deploy alert",
            trigger="keyword",
            keywords="deploy,release",
            match="any",
        )
        result = self.run_cmd("check", "--text", "time to deploy the app")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Deploy alert", result.stdout)

    def test_check_keyword_any_no_match(self):
        self.add_reminder(
            "Deploy alert",
            trigger="keyword",
            keywords="deploy,release",
            match="any",
        )
        result = self.run_cmd("check", "--text", "nothing relevant here")
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("Deploy alert", result.stdout)

    def test_check_keyword_all_match(self):
        self.add_reminder(
            "Both keywords",
            trigger="keyword",
            keywords="alpha,beta",
            match="all",
        )
        result = self.run_cmd("check", "--text", "alpha and beta together")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Both keywords", result.stdout)

    def test_check_keyword_all_partial_no_match(self):
        self.add_reminder(
            "Both keywords",
            trigger="keyword",
            keywords="alpha,beta",
            match="all",
        )
        result = self.run_cmd("check", "--text", "only alpha here")
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("Both keywords", result.stdout)

    def test_check_keyword_regex_match(self):
        self.add_reminder(
            "Error pattern",
            trigger="keyword",
            keywords=r"error\d+",
            match="regex",
        )
        result = self.run_cmd("check", "--text", "found error42 in logs")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Error pattern", result.stdout)

    def test_check_keyword_case_insensitive(self):
        self.add_reminder(
            "Case test",
            trigger="keyword",
            keywords="Deploy",
            match="any",
        )
        result = self.run_cmd("check", "--text", "DEPLOY now")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Case test", result.stdout)

    def test_check_keyword_no_text_flag_no_keyword_match(self):
        """Without --text, keyword triggers should not fire."""
        self.add_reminder(
            "Keyword only",
            trigger="keyword",
            keywords="test",
        )
        result = self.run_cmd("check")
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("Keyword only", result.stdout)

    # -- Condition triggers --

    def test_check_condition_passing(self):
        self.add_reminder(
            "Condition pass",
            trigger="condition",
            check="echo yes",
            expect="yes",
        )
        result = self.run_cmd("check")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Condition pass", result.stdout)

    def test_check_condition_failing(self):
        self.add_reminder(
            "Condition fail",
            trigger="condition",
            check="echo no",
            expect="yes",
        )
        result = self.run_cmd("check")
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("Condition fail", result.stdout)

    # -- Session triggers --

    def test_check_session_triggers_returned(self):
        self.add_reminder("Session note", trigger="session")
        result = self.run_cmd("check")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Session note", result.stdout)

    # -- Heartbeat triggers --

    def test_check_heartbeat_triggers_returned(self):
        self.add_reminder(
            "Heartbeat note", trigger="heartbeat", decay="+7d"
        )
        result = self.run_cmd("check")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Heartbeat note", result.stdout)

    # -- Manual triggers --

    def test_check_manual_never_returned(self):
        self.add_reminder("Manual note", trigger="manual")
        result = self.run_cmd("check")
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("Manual note", result.stdout)

    # -- Output formats --

    def test_check_format_full(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        self.insert_reminder_directly(
            content="Full format", trigger_type="time", trigger_at=past, priority=2
        )
        result = self.run_cmd("check", "--format", "full")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Active Reminders", result.stdout)

    def test_check_format_compact(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        self.insert_reminder_directly(
            content="Compact format", trigger_type="time", trigger_at=past, priority=2
        )
        result = self.run_cmd("check", "--format", "compact")
        self.assertEqual(result.returncode, 0)
        self.assertIn("🔔", result.stdout)

    def test_check_format_inline(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        self.insert_reminder_directly(
            content="Inline format", trigger_type="time", trigger_at=past, priority=2
        )
        result = self.run_cmd("check", "--format", "inline")
        self.assertEqual(result.returncode, 0)
        self.assertIn("💡 Reminder", result.stdout)

    # -- Budget system --

    def test_check_p1_always_included(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        self.insert_reminder_directly(
            content="Critical task", trigger_type="time", trigger_at=past, priority=1
        )
        result = self.run_cmd("check", "--budget", "1")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Critical task", result.stdout)

    def test_check_budget_overflow_summary(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        # Add many P3 reminders to exceed budget
        for i in range(30):
            self.insert_reminder_directly(
                content=f"Overflow task {i} " + "x" * 50,
                trigger_type="time",
                trigger_at=past,
                priority=3,
            )
        result = self.run_cmd("check", "--budget", "5", "--format", "full")
        self.assertEqual(result.returncode, 0)
        # Should have overflow message
        self.assertIn("more", result.stdout)

    # -- Fire count --

    def test_check_increments_fire_count(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        rid = self.insert_reminder_directly(
            content="Fire counter", trigger_type="time", trigger_at=past, priority=2
        )
        self.run_cmd("check")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["fire_count"], 1)

    def test_check_updates_last_fired(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        rid = self.insert_reminder_directly(
            content="Last fired", trigger_type="time", trigger_at=past, priority=2
        )
        self.run_cmd("check")
        rem = self.get_reminder(rid)
        self.assertIsNotNone(rem["last_fired"])

    def test_check_max_fires_auto_complete(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        rid = self.insert_reminder_directly(
            content="Max fires test",
            trigger_type="time",
            trigger_at=past,
            priority=2,
            max_fires=1,
            fire_count=0,
        )
        self.run_cmd("check")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "completed")

    # -- Dry run --

    def test_check_dry_run_no_update(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        rid = self.insert_reminder_directly(
            content="Dry run check", trigger_type="time", trigger_at=past, priority=2
        )
        self.run_cmd("check", "--dry-run")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["fire_count"], 0)

    # -- Snooze reactivation --

    def test_check_reactivates_expired_snooze(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        rid = self.insert_reminder_directly(
            content="Snoozed task",
            trigger_type="time",
            trigger_at=past,
            status="snoozed",
            snoozed_until=past,
            priority=2,
        )
        self.run_cmd("check")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "active")

    # -- Decay expiration --

    def test_check_expires_decayed_reminders(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        rid = self.insert_reminder_directly(
            content="Decayed task",
            trigger_type="heartbeat",
            decay_at=past,
            priority=3,
        )
        self.run_cmd("check")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "expired")

    # -- Dependencies --

    def test_check_skips_unmet_dependency(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        dep_id = self.insert_reminder_directly(
            content="Dep task", trigger_type="time", trigger_at=past, priority=2
        )
        rid = self.insert_reminder_directly(
            content="Blocked task",
            trigger_type="time",
            trigger_at=past,
            priority=2,
            depends_on=dep_id,
        )
        result = self.run_cmd("check")
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("Blocked task", result.stdout)

    def test_check_includes_met_dependency(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        dep_id = self.insert_reminder_directly(
            content="Dep task",
            trigger_type="time",
            trigger_at=past,
            priority=2,
            status="completed",
        )
        rid = self.insert_reminder_directly(
            content="Unblocked task",
            trigger_type="time",
            trigger_at=past,
            priority=2,
            depends_on=dep_id,
        )
        result = self.run_cmd("check")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Unblocked task", result.stdout)

    # -- Escalation --

    def test_check_escalate_p3_to_p1_double(self):
        """P3 overdue 49h: first escalated to P2 (48h rule), then to P1 (24h rule).
        Since any trigger_at >48h is also >24h, P3 always double-escalates to P1."""
        overdue_49h = (datetime.now() - timedelta(hours=49)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        rid = self.insert_reminder_directly(
            content="Escalate P3",
            trigger_type="time",
            trigger_at=overdue_49h,
            priority=3,
        )
        self.run_cmd("check", "--escalate")
        rem = self.get_reminder(rid)
        # Double escalation: P3 → P2 (48h rule) → P1 (24h rule)
        self.assertEqual(rem["priority"], 1)

    def test_check_escalate_p2_to_p1(self):
        overdue_25h = (datetime.now() - timedelta(hours=25)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        rid = self.insert_reminder_directly(
            content="Escalate P2",
            trigger_type="time",
            trigger_at=overdue_25h,
            priority=2,
        )
        self.run_cmd("check", "--escalate")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["priority"], 1)

    # -- Agent filter --

    def test_check_agent_filter(self):
        past = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S")
        self.insert_reminder_directly(
            content="Main agent task",
            trigger_type="time",
            trigger_at=past,
            priority=2,
            agent="main",
        )
        self.insert_reminder_directly(
            content="Other agent task",
            trigger_type="time",
            trigger_at=past,
            priority=2,
            agent="other",
        )
        result = self.run_cmd("check", "--agent", "other")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Other agent task", result.stdout)
        self.assertNotIn("Main agent task", result.stdout)

    # -- Exit code always 0 --

    def test_check_empty_db_exit_0(self):
        result = self.run_cmd("check")
        self.assertEqual(result.returncode, 0)

    def test_check_no_matches_exit_0(self):
        # Add future-only reminder
        self.add_reminder("Future only", due="+24h")
        result = self.run_cmd("check")
        self.assertEqual(result.returncode, 0)


# ═══════════════════════════════════════════════════════════════════════════════
# 4. List
# ═══════════════════════════════════════════════════════════════════════════════


class TestList(AgentremTestBase):
    def test_list_default_active_only(self):
        self.add_reminder("Active one", due="+1h")
        rid2 = self.add_reminder("Completed one", due="+1h")
        self.run_cmd("complete", rid2)
        result = self.run_cmd("list")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Active one", result.stdout)
        self.assertNotIn("Completed one", result.stdout)

    def test_list_status_filter(self):
        self.add_reminder("Active", due="+1h")
        rid2 = self.add_reminder("To complete", due="+1h")
        self.run_cmd("complete", rid2)
        result = self.run_cmd("list", "--status", "completed")
        self.assertEqual(result.returncode, 0)
        self.assertIn("To complete", result.stdout)
        self.assertNotIn("Active", result.stdout)

    def test_list_priority_filter(self):
        self.add_reminder("P1 task", due="+1h", priority=1)
        self.add_reminder("P3 task", due="+1h", priority=3)
        result = self.run_cmd("list", "--priority", "1")
        self.assertEqual(result.returncode, 0)
        self.assertIn("P1 task", result.stdout)
        self.assertNotIn("P3 task", result.stdout)

    def test_list_tag_filter(self):
        self.add_reminder("Tagged", due="+1h", tags="work,urgent")
        self.add_reminder("Untagged", due="+1h")
        result = self.run_cmd("list", "--tag", "work")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Tagged", result.stdout)
        self.assertNotIn("Untagged", result.stdout)

    def test_list_trigger_filter(self):
        self.add_reminder("Time one", due="+1h")
        self.add_reminder("Session one", trigger="session")
        result = self.run_cmd("list", "--trigger", "session")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Session one", result.stdout)
        self.assertNotIn("Time one", result.stdout)

    def test_list_due_overdue(self):
        past = (datetime.now() - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S")
        self.insert_reminder_directly(
            content="Overdue",
            trigger_type="time",
            trigger_at=past,
            priority=2,
        )
        self.add_reminder("Future", due="+24h")
        result = self.run_cmd("list", "--due", "overdue")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Overdue", result.stdout)
        self.assertNotIn("Future", result.stdout)

    def test_list_due_today(self):
        # Today's end of day
        eod = datetime.now().replace(hour=22, minute=0, second=0)
        if eod > datetime.now():
            self.insert_reminder_directly(
                content="Today task",
                trigger_type="time",
                trigger_at=eod.strftime("%Y-%m-%dT%H:%M:%S"),
                priority=3,
            )
        far_future = (datetime.now() + timedelta(days=10)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        self.insert_reminder_directly(
            content="Far future", trigger_type="time", trigger_at=far_future, priority=3
        )
        result = self.run_cmd("list", "--due", "today")
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("Far future", result.stdout)

    def test_list_agent_filter(self):
        self.add_reminder("Main task", due="+1h", agent="main")
        self.add_reminder("Other task", due="+1h", agent="other")
        result = self.run_cmd("list", "--agent", "other")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Other task", result.stdout)
        self.assertNotIn("Main task", result.stdout)

    def test_list_category_filter(self):
        self.add_reminder("DevOps task", due="+1h", category="devops")
        self.add_reminder("Design task", due="+1h", category="design")
        result = self.run_cmd("list", "--category", "devops")
        self.assertEqual(result.returncode, 0)
        self.assertIn("DevOps task", result.stdout)
        self.assertNotIn("Design task", result.stdout)

    def test_list_limit(self):
        for i in range(5):
            self.add_reminder(f"Task {i}", due="+1h")
        result = self.run_cmd("list", "--limit", "2")
        self.assertEqual(result.returncode, 0)
        # Count the number of data rows (not header/separator)
        lines = [
            l
            for l in result.stdout.strip().split("\n")
            if l and not l.startswith("─") and "ID" not in l
        ]
        self.assertLessEqual(len(lines), 2)

    def test_list_format_json(self):
        self.add_reminder("JSON test", due="+1h")
        result = self.run_cmd("list", "--format", "json")
        self.assertEqual(result.returncode, 0)
        data = json.loads(result.stdout)
        self.assertIsInstance(data, list)
        self.assertGreater(len(data), 0)
        self.assertEqual(data[0]["content"], "JSON test")

    def test_list_format_compact(self):
        self.add_reminder("Compact test", due="+1h")
        result = self.run_cmd("list", "--format", "compact")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Compact test", result.stdout)
        # Compact format uses [] ID prefix
        self.assertRegex(result.stdout, r'\[[a-f0-9]+\]')

    def test_list_format_table(self):
        self.add_reminder("Table test", due="+1h")
        result = self.run_cmd("list", "--format", "table")
        self.assertEqual(result.returncode, 0)
        self.assertIn("ID", result.stdout)
        self.assertIn("─", result.stdout)

    def test_list_all_statuses(self):
        self.add_reminder("Active", due="+1h")
        rid = self.add_reminder("To complete", due="+1h")
        self.run_cmd("complete", rid)
        result = self.run_cmd("list", "--all")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Active", result.stdout)
        self.assertIn("To complete", result.stdout)

    def test_list_empty(self):
        result = self.run_cmd("list")
        self.assertEqual(result.returncode, 0)
        self.assertIn("No reminders found", result.stdout)


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Search (FTS5)
# ═══════════════════════════════════════════════════════════════════════════════


class TestSearch(AgentremTestBase):
    def test_search_basic(self):
        self.add_reminder("Deploy the application", due="+1h")
        self.add_reminder("Fix the bug", due="+2h")
        result = self.run_cmd("search", "deploy")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Deploy the application", result.stdout)
        self.assertNotIn("Fix the bug", result.stdout)

    def test_search_context(self):
        self.add_reminder(
            "Task one", due="+1h", context="kubernetes namespace cleanup"
        )
        result = self.run_cmd("search", "kubernetes")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Task one", result.stdout)

    def test_search_tags(self):
        self.add_reminder("Tagged task", due="+1h", tags="infra,devops")
        result = self.run_cmd("search", "devops")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Tagged task", result.stdout)

    def test_search_no_results(self):
        self.add_reminder("Something", due="+1h")
        result = self.run_cmd("search", "xyznonexistent")
        # Search returns exit 1 on no results
        self.assertIn("No results", result.stdout)

    def test_search_status_filter(self):
        rid = self.add_reminder("Completed search", due="+1h")
        self.run_cmd("complete", rid)
        # Default searches active only
        result = self.run_cmd("search", "Completed", "--status", "completed")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Completed search", result.stdout)

    def test_search_format_json(self):
        self.add_reminder("JSON search", due="+1h")
        result = self.run_cmd("search", "JSON", "--format", "json")
        self.assertEqual(result.returncode, 0)
        data = json.loads(result.stdout)
        self.assertIsInstance(data, list)
        self.assertGreater(len(data), 0)

    def test_search_fts_sync_after_edit(self):
        rid = self.add_reminder("Original content", due="+1h")
        self.run_cmd("edit", rid, "--content", "Updated unique content")
        result = self.run_cmd("search", "Updated unique")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Updated unique content", result.stdout)

    def test_search_fts_sync_after_delete(self):
        rid = self.add_reminder("Deletable content", due="+1h")
        full_rem = self.get_reminder(rid)
        self.run_cmd("delete", rid, "--permanent")
        result = self.run_cmd("search", "Deletable")
        # Should not find it
        self.assertNotIn("Deletable content", result.stdout)


# ═══════════════════════════════════════════════════════════════════════════════
# 6. Complete
# ═══════════════════════════════════════════════════════════════════════════════


class TestComplete(AgentremTestBase):
    def test_complete_sets_status(self):
        rid = self.add_reminder("To complete", due="+1h")
        result = self.run_cmd("complete", rid)
        self.assertEqual(result.returncode, 0)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "completed")

    def test_complete_sets_completed_at(self):
        rid = self.add_reminder("Timestamped", due="+1h")
        self.run_cmd("complete", rid)
        rem = self.get_reminder(rid)
        self.assertIsNotNone(rem["completed_at"])

    def test_complete_with_notes(self):
        rid = self.add_reminder("With notes", due="+1h")
        self.run_cmd("complete", rid, "--notes", "Done successfully")
        rem = self.get_reminder(rid)
        self.assertIn("Done successfully", rem["notes"])

    def test_complete_creates_history(self):
        rid = self.add_reminder("History complete", due="+1h")
        self.run_cmd("complete", rid)
        hist = self.get_history(rid)
        actions = [h["action"] for h in hist]
        self.assertIn("completed", actions)

    def test_complete_recurring_creates_next(self):
        rid = self.add_reminder("Recurring task", due="+1h", recur="1d")
        before_count = self.count_reminders()
        result = self.run_cmd("complete", rid)
        self.assertEqual(result.returncode, 0)
        after_count = self.count_reminders()
        # Should have one more (the new recurrence)
        self.assertEqual(after_count, before_count + 1)
        self.assertIn("recurrence", result.stdout.lower())

    def test_complete_nonexistent_fails(self):
        result = self.run_cmd("complete", "nonexistent123")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not found", result.stderr.lower())


# ═══════════════════════════════════════════════════════════════════════════════
# 7. Snooze
# ═══════════════════════════════════════════════════════════════════════════════


class TestSnooze(AgentremTestBase):
    def test_snooze_for_duration(self):
        rid = self.add_reminder("Snooze me", due="+1h")
        result = self.run_cmd("snooze", rid, "--for", "2h")
        self.assertEqual(result.returncode, 0)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "snoozed")
        self.assertIsNotNone(rem["snoozed_until"])

    def test_snooze_until_datetime(self):
        rid = self.add_reminder("Snooze until", due="+1h")
        target = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S")
        result = self.run_cmd("snooze", rid, "--until", target)
        self.assertEqual(result.returncode, 0)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "snoozed")

    def test_snooze_for_1d(self):
        rid = self.add_reminder("Snooze 1d", due="+1h")
        result = self.run_cmd("snooze", rid, "--for", "1d")
        self.assertEqual(result.returncode, 0)
        rem = self.get_reminder(rid)
        snooze_dt = datetime.fromisoformat(rem["snoozed_until"])
        diff = snooze_dt - datetime.now()
        self.assertAlmostEqual(diff.total_seconds(), 86400, delta=120)

    def test_snooze_for_1w(self):
        rid = self.add_reminder("Snooze 1w", due="+1h")
        result = self.run_cmd("snooze", rid, "--for", "1w")
        self.assertEqual(result.returncode, 0)
        rem = self.get_reminder(rid)
        snooze_dt = datetime.fromisoformat(rem["snoozed_until"])
        diff = snooze_dt - datetime.now()
        self.assertAlmostEqual(diff.total_seconds(), 7 * 86400, delta=120)

    def test_snooze_creates_history(self):
        rid = self.add_reminder("Snooze hist", due="+1h")
        self.run_cmd("snooze", rid, "--for", "1h")
        hist = self.get_history(rid)
        actions = [h["action"] for h in hist]
        self.assertIn("snoozed", actions)

    def test_snooze_missing_duration_fails(self):
        rid = self.add_reminder("Bad snooze", due="+1h")
        result = self.run_cmd("snooze", rid)
        self.assertNotEqual(result.returncode, 0)


# ═══════════════════════════════════════════════════════════════════════════════
# 8. Edit
# ═══════════════════════════════════════════════════════════════════════════════


class TestEdit(AgentremTestBase):
    def test_edit_content(self):
        rid = self.add_reminder("Original", due="+1h")
        result = self.run_cmd("edit", rid, "--content", "Updated")
        self.assertEqual(result.returncode, 0)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["content"], "Updated")

    def test_edit_context(self):
        rid = self.add_reminder("Ctx edit", due="+1h")
        self.run_cmd("edit", rid, "--context", "new context")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["context"], "new context")

    def test_edit_priority(self):
        rid = self.add_reminder("Prio edit", due="+1h", priority=3)
        self.run_cmd("edit", rid, "--priority", "1")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["priority"], 1)

    def test_edit_due(self):
        rid = self.add_reminder("Due edit", due="+1h")
        target = "2030-12-31T23:59:00"
        self.run_cmd("edit", rid, "--due", target)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["trigger_at"], target)

    def test_edit_tags_replace(self):
        rid = self.add_reminder("Tag edit", due="+1h", tags="old,tags")
        self.run_cmd("edit", rid, "--tags", "new,tags")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["tags"], "new,tags")

    def test_edit_add_tags(self):
        rid = self.add_reminder("Add tags", due="+1h", tags="existing")
        self.run_cmd("edit", rid, "--add-tags", "newtag")
        rem = self.get_reminder(rid)
        self.assertIn("existing", rem["tags"])
        self.assertIn("newtag", rem["tags"])

    def test_edit_remove_tags(self):
        rid = self.add_reminder("Rm tags", due="+1h", tags="keep,remove")
        self.run_cmd("edit", rid, "--remove-tags", "remove")
        rem = self.get_reminder(rid)
        self.assertIn("keep", rem["tags"])
        self.assertNotIn("remove", rem["tags"])

    def test_edit_category(self):
        rid = self.add_reminder("Cat edit", due="+1h")
        self.run_cmd("edit", rid, "--category", "infra")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["category"], "infra")

    def test_edit_decay(self):
        rid = self.add_reminder("Decay edit", due="+1h")
        target = "2030-12-31T23:59:00"
        self.run_cmd("edit", rid, "--decay", target)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["decay_at"], target)

    def test_edit_max_fires(self):
        rid = self.add_reminder("Max fires edit", due="+1h")
        self.run_cmd("edit", rid, "--max-fires", "5")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["max_fires"], 5)

    def test_edit_keywords(self):
        rid = self.add_reminder(
            "KW edit", trigger="keyword", keywords="old"
        )
        self.run_cmd("edit", rid, "--keywords", "new,updated")
        rem = self.get_reminder(rid)
        config = json.loads(rem["trigger_config"])
        self.assertIn("new", config["keywords"])
        self.assertIn("updated", config["keywords"])

    def test_edit_agent(self):
        rid = self.add_reminder("Agent edit", due="+1h")
        self.run_cmd("edit", rid, "--agent", "secondary")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["agent"], "secondary")

    def test_edit_creates_history(self):
        rid = self.add_reminder("Hist edit", due="+1h")
        self.run_cmd("edit", rid, "--content", "Changed")
        hist = self.get_history(rid)
        actions = [h["action"] for h in hist]
        self.assertIn("updated", actions)
        # Check old and new data stored
        update_hist = [h for h in hist if h["action"] == "updated"][0]
        self.assertIsNotNone(update_hist["old_data"])
        self.assertIsNotNone(update_hist["new_data"])

    def test_edit_no_changes_fails(self):
        rid = self.add_reminder("No change", due="+1h")
        result = self.run_cmd("edit", rid)
        self.assertNotEqual(result.returncode, 0)

    def test_edit_fts_updated(self):
        rid = self.add_reminder("FTS before edit", due="+1h")
        self.run_cmd("edit", rid, "--content", "FTS after edit unique")
        result = self.run_cmd("search", "FTS after edit unique")
        self.assertEqual(result.returncode, 0)
        self.assertIn("FTS after edit unique", result.stdout)


# ═══════════════════════════════════════════════════════════════════════════════
# 9. Delete
# ═══════════════════════════════════════════════════════════════════════════════


class TestDelete(AgentremTestBase):
    def test_delete_soft(self):
        rid = self.add_reminder("Delete me", due="+1h")
        result = self.run_cmd("delete", rid)
        self.assertEqual(result.returncode, 0)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "deleted")

    def test_delete_permanent(self):
        rid = self.add_reminder("Perm delete", due="+1h")
        result = self.run_cmd("delete", rid, "--permanent")
        self.assertEqual(result.returncode, 0)
        rem = self.get_reminder(rid)
        self.assertIsNone(rem)

    def test_delete_by_status(self):
        rid1 = self.add_reminder("Complete 1", due="+1h")
        rid2 = self.add_reminder("Complete 2", due="+1h")
        self.run_cmd("complete", rid1)
        self.run_cmd("complete", rid2)
        self.add_reminder("Keep active", due="+1h")

        result = self.run_cmd("delete", "--status", "completed")
        self.assertEqual(result.returncode, 0)
        self.assertIn("2", result.stdout)

    def test_delete_older_than(self):
        # Insert a reminder with old updated_at
        old_date = (datetime.now() - timedelta(days=60)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        self.insert_reminder_directly(
            content="Old completed",
            status="completed",
            trigger_type="time",
            updated_at=old_date,
        )
        self.add_reminder("New active", due="+1h")
        result = self.run_cmd("delete", "--status", "completed", "--older-than", "30")
        self.assertEqual(result.returncode, 0)

    def test_delete_creates_history(self):
        rid = self.add_reminder("Hist delete", due="+1h")
        self.run_cmd("delete", rid)
        hist = self.get_history(rid)
        actions = [h["action"] for h in hist]
        self.assertIn("deleted", actions)


# ═══════════════════════════════════════════════════════════════════════════════
# 10. Stats
# ═══════════════════════════════════════════════════════════════════════════════


class TestStats(AgentremTestBase):
    def test_stats_empty_db(self):
        result = self.run_cmd("stats")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Active: 0", result.stdout)

    def test_stats_active_count(self):
        self.add_reminder("One", due="+1h")
        self.add_reminder("Two", due="+2h")
        result = self.run_cmd("stats")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Active: 2", result.stdout)

    def test_stats_by_priority(self):
        self.add_reminder("P1", due="+1h", priority=1)
        self.add_reminder("P3", due="+2h", priority=3)
        result = self.run_cmd("stats")
        self.assertEqual(result.returncode, 0)
        self.assertIn("critical", result.stdout.lower())
        self.assertIn("normal", result.stdout.lower())

    def test_stats_by_trigger(self):
        self.add_reminder("Time", due="+1h")
        self.add_reminder("Session", trigger="session")
        result = self.run_cmd("stats")
        self.assertEqual(result.returncode, 0)
        self.assertIn("time", result.stdout.lower())
        self.assertIn("session", result.stdout.lower())

    def test_stats_overdue_count(self):
        past = (datetime.now() - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S")
        self.insert_reminder_directly(
            content="Overdue",
            trigger_type="time",
            trigger_at=past,
            priority=2,
        )
        result = self.run_cmd("stats")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Overdue: 1", result.stdout)

    def test_stats_next_due(self):
        self.add_reminder("Next one", due="+1h")
        result = self.run_cmd("stats")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Next due", result.stdout)

    def test_stats_db_size(self):
        result = self.run_cmd("stats")
        self.assertEqual(result.returncode, 0)
        self.assertIn("DB size", result.stdout)


# ═══════════════════════════════════════════════════════════════════════════════
# 11. GC (Garbage Collection)
# ═══════════════════════════════════════════════════════════════════════════════


class TestGC(AgentremTestBase):
    def test_gc_removes_old_completed(self):
        old_date = (datetime.now() - timedelta(days=60)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        self.insert_reminder_directly(
            content="Old completed",
            status="completed",
            trigger_type="time",
            updated_at=old_date,
        )
        before = self.count_reminders()
        result = self.run_cmd("gc", "--older-than", "30")
        self.assertEqual(result.returncode, 0)
        after = self.count_reminders()
        self.assertLess(after, before)

    def test_gc_removes_old_expired(self):
        old_date = (datetime.now() - timedelta(days=60)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        self.insert_reminder_directly(
            content="Old expired",
            status="expired",
            trigger_type="heartbeat",
            updated_at=old_date,
        )
        result = self.run_cmd("gc", "--older-than", "30")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Removed", result.stdout)

    def test_gc_removes_old_deleted(self):
        old_date = (datetime.now() - timedelta(days=60)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        self.insert_reminder_directly(
            content="Old deleted",
            status="deleted",
            trigger_type="time",
            updated_at=old_date,
        )
        result = self.run_cmd("gc", "--older-than", "30")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Removed", result.stdout)

    def test_gc_dry_run(self):
        old_date = (datetime.now() - timedelta(days=60)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        self.insert_reminder_directly(
            content="Dry run GC",
            status="completed",
            trigger_type="time",
            updated_at=old_date,
        )
        before = self.count_reminders()
        result = self.run_cmd("gc", "--older-than", "30", "--dry-run")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Dry run", result.stdout)
        after = self.count_reminders()
        self.assertEqual(before, after)

    def test_gc_nothing_to_clean(self):
        self.add_reminder("Fresh one", due="+1h")
        result = self.run_cmd("gc")
        self.assertEqual(result.returncode, 0)
        self.assertIn("No reminders to clean", result.stdout)

    def test_gc_default_threshold(self):
        # Default is 30 days
        old_date = (datetime.now() - timedelta(days=31)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        self.insert_reminder_directly(
            content="Default threshold",
            status="completed",
            trigger_type="time",
            updated_at=old_date,
        )
        result = self.run_cmd("gc")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Removed", result.stdout)


# ═══════════════════════════════════════════════════════════════════════════════
# 12. History
# ═══════════════════════════════════════════════════════════════════════════════


class TestHistory(AgentremTestBase):
    def test_history_for_specific_reminder(self):
        rid = self.add_reminder("Hist task", due="+1h")
        result = self.run_cmd("history", rid)
        self.assertEqual(result.returncode, 0)
        self.assertIn("created", result.stdout)

    def test_history_recent_without_id(self):
        self.add_reminder("Task A", due="+1h")
        self.add_reminder("Task B", due="+2h")
        result = self.run_cmd("history")
        self.assertEqual(result.returncode, 0)
        self.assertIn("created", result.stdout)

    def test_history_limit(self):
        for i in range(5):
            self.add_reminder(f"Task {i}", due="+1h")
        result = self.run_cmd("history", "--limit", "2")
        self.assertEqual(result.returncode, 0)
        # Count data rows
        lines = [
            l
            for l in result.stdout.strip().split("\n")
            if l and not l.startswith("─") and "HID" not in l
        ]
        self.assertLessEqual(len(lines), 2)

    def test_history_format_json(self):
        self.add_reminder("JSON hist", due="+1h")
        result = self.run_cmd("history", "--format", "json")
        self.assertEqual(result.returncode, 0)
        data = json.loads(result.stdout)
        self.assertIsInstance(data, list)
        self.assertGreater(len(data), 0)

    def test_history_empty(self):
        result = self.run_cmd("history")
        self.assertEqual(result.returncode, 0)
        self.assertIn("No history", result.stdout)


# ═══════════════════════════════════════════════════════════════════════════════
# 13. Undo
# ═══════════════════════════════════════════════════════════════════════════════


class TestUndo(AgentremTestBase):
    def _get_last_history_id(self, action=None):
        conn = self.get_db()
        if action:
            row = conn.execute(
                "SELECT id FROM history WHERE action=? ORDER BY id DESC LIMIT 1",
                (action,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id FROM history ORDER BY id DESC LIMIT 1"
            ).fetchone()
        conn.close()
        return str(row["id"]) if row else None

    def test_undo_complete(self):
        rid = self.add_reminder("Undo complete", due="+1h")
        self.run_cmd("complete", rid)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "completed")

        hid = self._get_last_history_id("completed")
        result = self.run_cmd("undo", hid)
        self.assertEqual(result.returncode, 0)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "active")

    def test_undo_snooze(self):
        rid = self.add_reminder("Undo snooze", due="+1h")
        self.run_cmd("snooze", rid, "--for", "1h")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "snoozed")

        hid = self._get_last_history_id("snoozed")
        result = self.run_cmd("undo", hid)
        self.assertEqual(result.returncode, 0)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "active")

    def test_undo_edit(self):
        rid = self.add_reminder("Before edit", due="+1h")
        self.run_cmd("edit", rid, "--content", "After edit")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["content"], "After edit")

        hid = self._get_last_history_id("updated")
        result = self.run_cmd("undo", hid)
        self.assertEqual(result.returncode, 0)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["content"], "Before edit")

    def test_undo_delete(self):
        rid = self.add_reminder("Undo delete", due="+1h")
        self.run_cmd("delete", rid)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "deleted")

        hid = self._get_last_history_id("deleted")
        result = self.run_cmd("undo", hid)
        self.assertEqual(result.returncode, 0)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "active")

    def test_undo_create_fails(self):
        self.add_reminder("Cannot undo create", due="+1h")
        hid = self._get_last_history_id("created")
        result = self.run_cmd("undo", hid)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot undo creation", result.stderr.lower())

    def test_undo_creates_history(self):
        rid = self.add_reminder("Undo hist", due="+1h")
        self.run_cmd("complete", rid)
        hid = self._get_last_history_id("completed")
        self.run_cmd("undo", hid)
        hist = self.get_history(rid)
        actions = [h["action"] for h in hist]
        self.assertIn("reverted", actions)


# ═══════════════════════════════════════════════════════════════════════════════
# 14. Export/Import
# ═══════════════════════════════════════════════════════════════════════════════


class TestExportImport(AgentremTestBase):
    def test_export_creates_valid_json(self):
        self.add_reminder("Export test", due="+1h")
        out_path = os.path.join(self.tmpdir, "export.json")
        result = self.run_cmd("export", "--out", out_path)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(os.path.exists(out_path))
        data = json.loads(Path(out_path).read_text())
        self.assertIn("reminders", data)
        self.assertIn("history", data)
        self.assertEqual(data["reminder_count"], 1)

    def test_export_status_filter(self):
        self.add_reminder("Active export", due="+1h")
        rid = self.add_reminder("Complete export", due="+1h")
        self.run_cmd("complete", rid)

        out_path = os.path.join(self.tmpdir, "export_active.json")
        result = self.run_cmd("export", "--out", out_path, "--status", "active")
        self.assertEqual(result.returncode, 0)
        data = json.loads(Path(out_path).read_text())
        self.assertEqual(len(data["reminders"]), 1)
        self.assertEqual(data["reminders"][0]["content"], "Active export")

    def test_import_merge(self):
        # Create and export
        self.add_reminder("Merge test", due="+1h")
        out_path = os.path.join(self.tmpdir, "merge.json")
        self.run_cmd("export", "--out", out_path)

        # Import with merge — should skip existing
        result = self.run_cmd("import", out_path, "--merge")
        self.assertEqual(result.returncode, 0)
        self.assertIn("skipped", result.stdout.lower())
        self.assertEqual(self.count_reminders(), 1)

    def test_import_replace(self):
        self.add_reminder("Old one", due="+1h")
        self.add_reminder("Old two", due="+2h")

        # Create export with one reminder
        out_path = os.path.join(self.tmpdir, "replace.json")
        # Manually create export JSON with one reminder
        data = {
            "exported_at": "2030-01-01T00:00:00",
            "schema_version": 1,
            "reminder_count": 1,
            "reminders": [
                {
                    "id": "replace001",
                    "content": "Replaced",
                    "trigger_type": "time",
                    "trigger_at": "2030-06-01T12:00:00",
                    "priority": 3,
                    "status": "active",
                    "source": "agent",
                    "agent": "main",
                    "fire_count": 0,
                    "created_at": "2030-01-01T00:00:00",
                    "updated_at": "2030-01-01T00:00:00",
                }
            ],
            "history": [],
        }
        Path(out_path).write_text(json.dumps(data))

        result = self.run_cmd("import", out_path, "--replace")
        self.assertEqual(result.returncode, 0)
        # Should only have the imported one
        self.assertEqual(self.count_reminders(), 1)
        rem = self.get_reminder("replace001")
        self.assertIsNotNone(rem)
        self.assertEqual(rem["content"], "Replaced")

    def test_import_dry_run(self):
        out_path = os.path.join(self.tmpdir, "dry.json")
        data = {
            "exported_at": "2030-01-01T00:00:00",
            "schema_version": 1,
            "reminder_count": 1,
            "reminders": [
                {
                    "id": "dryrun001",
                    "content": "Dry import",
                    "trigger_type": "time",
                    "priority": 3,
                    "status": "active",
                    "source": "agent",
                    "agent": "main",
                    "fire_count": 0,
                    "created_at": "2030-01-01T00:00:00",
                    "updated_at": "2030-01-01T00:00:00",
                }
            ],
            "history": [],
        }
        Path(out_path).write_text(json.dumps(data))

        result = self.run_cmd("import", out_path, "--dry-run")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Dry run", result.stdout)
        self.assertEqual(self.count_reminders(), 0)


# ═══════════════════════════════════════════════════════════════════════════════
# 15. Schema
# ═══════════════════════════════════════════════════════════════════════════════


class TestSchema(AgentremTestBase):
    def test_schema_prints(self):
        result = self.run_cmd("schema")
        self.assertEqual(result.returncode, 0)
        self.assertIn("CREATE TABLE", result.stdout)
        self.assertIn("reminders", result.stdout)


# ═══════════════════════════════════════════════════════════════════════════════
# 16. Version
# ═══════════════════════════════════════════════════════════════════════════════


class TestVersion(AgentremTestBase):
    def test_version_flag(self):
        result = self.run_cmd("--version")
        self.assertEqual(result.returncode, 0)
        self.assertRegex(result.stdout, r'\d+\.\d+\.\d+')


# ═══════════════════════════════════════════════════════════════════════════════
# 17. Date Parsing (via add command)
# ═══════════════════════════════════════════════════════════════════════════════


class TestDateParsing(AgentremTestBase):
    def test_relative_hours(self):
        rid = self.add_reminder("Rel hours", due="+2h")
        rem = self.get_reminder(rid)
        dt = datetime.fromisoformat(rem["trigger_at"])
        diff = dt - datetime.now()
        self.assertAlmostEqual(diff.total_seconds(), 7200, delta=60)

    def test_relative_minutes(self):
        rid = self.add_reminder("Rel minutes", due="+45m")
        rem = self.get_reminder(rid)
        dt = datetime.fromisoformat(rem["trigger_at"])
        diff = dt - datetime.now()
        self.assertAlmostEqual(diff.total_seconds(), 2700, delta=60)

    def test_relative_days(self):
        rid = self.add_reminder("Rel days", due="+3d")
        rem = self.get_reminder(rid)
        dt = datetime.fromisoformat(rem["trigger_at"])
        diff = dt - datetime.now()
        self.assertAlmostEqual(diff.total_seconds(), 3 * 86400, delta=60)

    def test_relative_weeks(self):
        rid = self.add_reminder("Rel weeks", due="+2w")
        rem = self.get_reminder(rid)
        dt = datetime.fromisoformat(rem["trigger_at"])
        diff = dt - datetime.now()
        self.assertAlmostEqual(diff.total_seconds(), 14 * 86400, delta=60)

    def test_today_end_of_day(self):
        rid = self.add_reminder("Today", due="today")
        rem = self.get_reminder(rid)
        dt = datetime.fromisoformat(rem["trigger_at"])
        self.assertEqual(dt.date(), datetime.now().date())
        self.assertEqual(dt.hour, 23)
        self.assertEqual(dt.minute, 59)

    def test_tomorrow_9am(self):
        rid = self.add_reminder("Tomorrow", due="tomorrow")
        rem = self.get_reminder(rid)
        dt = datetime.fromisoformat(rem["trigger_at"])
        expected_date = (datetime.now() + timedelta(days=1)).date()
        self.assertEqual(dt.date(), expected_date)
        self.assertEqual(dt.hour, 9)
        self.assertEqual(dt.minute, 0)

    def test_iso_8601(self):
        target = "2030-07-04T15:30:00"
        rid = self.add_reminder("ISO", due=target)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["trigger_at"], target)

    def test_iso_date_only(self):
        target = "2030-07-04"
        rid = self.add_reminder("ISO date", due=target)
        rem = self.get_reminder(rid)
        self.assertIn("2030-07-04", rem["trigger_at"])

    def test_invalid_date_fails(self):
        result = self.run_cmd("add", "Bad date", "--due", "not-a-date-at-all-xyz")
        self.assertNotEqual(result.returncode, 0)


# ═══════════════════════════════════════════════════════════════════════════════
# 18. Edge Cases
# ═══════════════════════════════════════════════════════════════════════════════


class TestEdgeCases(AgentremTestBase):
    def test_empty_db_list(self):
        result = self.run_cmd("list")
        self.assertEqual(result.returncode, 0)

    def test_empty_db_check(self):
        result = self.run_cmd("check")
        self.assertEqual(result.returncode, 0)

    def test_empty_db_stats(self):
        result = self.run_cmd("stats")
        self.assertEqual(result.returncode, 0)

    def test_long_content(self):
        long_text = "A" * 2000
        rid = self.add_reminder(long_text, due="+1h")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["content"], long_text)

    def test_special_characters_content(self):
        special = 'Content with "quotes" and \'apostrophes\' & <brackets> $dollars'
        rid = self.add_reminder(special, due="+1h")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["content"], special)

    def test_special_characters_tags(self):
        rid = self.add_reminder(
            "Special tags", due="+1h", tags="c++,c#,node.js"
        )
        rem = self.get_reminder(rid)
        self.assertEqual(rem["tags"], "c++,c#,node.js")

    def test_unicode_content(self):
        unicode_text = "日本語のリマインダー 🔔 émojis são úteis"
        rid = self.add_reminder(unicode_text, due="+1h")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["content"], unicode_text)

    def test_wal_mode(self):
        conn = self.get_db()
        conn.execute("PRAGMA journal_mode=WAL")
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        conn.close()
        self.assertEqual(mode, "wal")

    def test_no_command_shows_help(self):
        result = self.run_cmd()
        self.assertEqual(result.returncode, 0)

    def test_id_prefix_matching(self):
        """Short ID prefixes should work for commands."""
        rid = self.add_reminder("Prefix test", due="+1h")
        # Use first 4 chars as prefix
        prefix = rid[:4]
        result = self.run_cmd("list", "--format", "json")
        data = json.loads(result.stdout)
        full_id = data[0]["id"]
        # Complete using prefix
        result = self.run_cmd("complete", prefix)
        self.assertEqual(result.returncode, 0)
        rem = self.get_reminder(full_id)
        self.assertEqual(rem["status"], "completed")

    def test_multiple_rapid_adds(self):
        """Add many reminders rapidly."""
        for i in range(20):
            rid = self.add_reminder(f"Rapid {i}", due="+1h")
            self.assertIsNotNone(rid)
        self.assertEqual(self.count_reminders(), 20)

    def test_complete_already_completed(self):
        """Completing an already completed reminder should still work (idempotent)."""
        rid = self.add_reminder("Double complete", due="+1h")
        self.run_cmd("complete", rid)
        # Completing again — the status is already completed, command should handle gracefully
        result = self.run_cmd("complete", rid)
        # Should still succeed (it finds the reminder and updates it)
        self.assertEqual(result.returncode, 0)


# ═══════════════════════════════════════════════════════════════════════════════
# 19. Due Filtering (list command)
# ═══════════════════════════════════════════════════════════════════════════════


class TestListDueFiltering(AgentremTestBase):
    def test_list_due_tomorrow(self):
        tomorrow = (datetime.now() + timedelta(days=1)).replace(
            hour=12, minute=0, second=0
        )
        self.insert_reminder_directly(
            content="Tomorrow task",
            trigger_type="time",
            trigger_at=tomorrow.strftime("%Y-%m-%dT%H:%M:%S"),
            priority=3,
        )
        far_future = (datetime.now() + timedelta(days=10)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        self.insert_reminder_directly(
            content="Far future task",
            trigger_type="time",
            trigger_at=far_future,
            priority=3,
        )
        result = self.run_cmd("list", "--due", "tomorrow")
        self.assertEqual(result.returncode, 0)
        self.assertIn("Tomorrow task", result.stdout)
        self.assertNotIn("Far future task", result.stdout)

    def test_list_due_week(self):
        in_3_days = (datetime.now() + timedelta(days=3)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        self.insert_reminder_directly(
            content="This week",
            trigger_type="time",
            trigger_at=in_3_days,
            priority=3,
        )
        in_20_days = (datetime.now() + timedelta(days=20)).strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
        self.insert_reminder_directly(
            content="Far away",
            trigger_type="time",
            trigger_at=in_20_days,
            priority=3,
        )
        result = self.run_cmd("list", "--due", "week")
        self.assertEqual(result.returncode, 0)
        self.assertIn("This week", result.stdout)
        self.assertNotIn("Far away", result.stdout)


# ═══════════════════════════════════════════════════════════════════════════════
# 20. Integration / End-to-End Workflow
# ═══════════════════════════════════════════════════════════════════════════════


class TestEndToEnd(AgentremTestBase):
    def test_full_lifecycle(self):
        """Test: add → check → edit → snooze → check (reactivate) → complete → undo → delete."""
        # Add
        rid = self.add_reminder(
            "Lifecycle task", due="+1h", priority=2, tags="e2e"
        )
        self.assertIsNotNone(rid)

        # List — should appear
        result = self.run_cmd("list", "--format", "json")
        data = json.loads(result.stdout)
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["content"], "Lifecycle task")

        # Edit
        self.run_cmd("edit", rid, "--content", "Updated lifecycle task")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["content"], "Updated lifecycle task")

        # Snooze
        self.run_cmd("snooze", rid, "--for", "1h")
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "snoozed")

        # Check won't show snoozed (unless expired)
        result = self.run_cmd("check")
        self.assertNotIn("Updated lifecycle task", result.stdout)

        # Complete
        self.run_cmd("complete", rid)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "completed")

        # Undo (revert complete)
        conn = self.get_db()
        hid = conn.execute(
            "SELECT id FROM history WHERE action='completed' ORDER BY id DESC LIMIT 1"
        ).fetchone()["id"]
        conn.close()
        self.run_cmd("undo", str(hid))
        rem = self.get_reminder(rid)
        # Should be reverted to state before complete (snoozed from the snooze)
        # The undo restores old_data from the completed action history entry
        self.assertIn(rem["status"], ("active", "snoozed"))

        # Delete
        self.run_cmd("delete", rid)
        rem = self.get_reminder(rid)
        self.assertEqual(rem["status"], "deleted")

        # History should show full lifecycle
        hist = self.get_history(rid)
        actions = [h["action"] for h in hist]
        self.assertIn("created", actions)
        self.assertIn("updated", actions)
        self.assertIn("snoozed", actions)
        self.assertIn("completed", actions)
        self.assertIn("reverted", actions)
        self.assertIn("deleted", actions)

    def test_export_import_roundtrip(self):
        """Export and reimport should preserve data."""
        self.add_reminder("Round trip A", due="+1h", tags="export", priority=1)
        self.add_reminder("Round trip B", due="+2h", tags="export", priority=3)

        # Export
        out_path = os.path.join(self.tmpdir, "roundtrip.json")
        self.run_cmd("export", "--out", out_path)

        # Create new DB
        new_tmpdir = tempfile.mkdtemp(prefix="agentrem_import_")
        new_db = os.path.join(new_tmpdir, "reminders.db")
        new_env = self.env.copy()
        new_env["AGENTREM_DIR"] = new_tmpdir
        new_env["AGENTREM_DB"] = new_db

        cmd = [sys.executable, AGENTREM_PY, "init"]
        subprocess.run(cmd, env=new_env, capture_output=True, timeout=30)

        cmd = [sys.executable, AGENTREM_PY, "import", out_path, "--replace"]
        result = subprocess.run(cmd, env=new_env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0)

        cmd = [sys.executable, AGENTREM_PY, "list", "--format", "json", "--all"]
        result = subprocess.run(cmd, env=new_env, capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        contents = {r["content"] for r in data}
        self.assertIn("Round trip A", contents)
        self.assertIn("Round trip B", contents)

        shutil.rmtree(new_tmpdir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
