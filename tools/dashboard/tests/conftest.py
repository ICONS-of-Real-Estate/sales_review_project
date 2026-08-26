"""
Shared fixtures for the dashboard test suite.

app.py reads DASHBOARD_DB_PATH / DASHBOARD_REQUIRE_LOGIN once at import time
into module-level globals (DB_PATH) or checks os.environ live per-request
(RequireLoginMiddleware). Rather than re-importing the module per test (slow,
and re-triggers the playbook reindex + OAuth client registration each time),
every test instead monkeypatches app.DB_PATH directly at the start of each
test to point at that test's own throwaway SQLite file — get_conn() always
reads the current value of that global, so this is enough to fully isolate
tests from each other and from a real dashboard.db on disk.
"""
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
DASHBOARD_DIR = TESTS_DIR.parent
sys.path.insert(0, str(DASHBOARD_DIR))

# Must be set before `import app` — auth.py/app.py read these at import time
# (OAuth client registration, RequireLoginMiddleware's default). None of this
# needs to be a *real* OAuth client: register() only stores config, it
# doesn't call out to Google until a login is actually attempted, which no
# test here does. app.py also connects to DASHBOARD_DB_PATH once at import
# (reindex_playbooks) before any per-test fixture runs, so this needs to
# point somewhere real and disposable — the system temp dir, never inside
# the repo, so a stray db file never ends up committed.
os.environ.setdefault("DASHBOARD_REQUIRE_LOGIN", "false")
os.environ.setdefault(
    "DASHBOARD_DB_PATH", os.path.join(tempfile.gettempdir(), "dashboard_test_import_time.db")
)

import app as app_module  # noqa: E402
import sync  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# Sensible defaults for every column `sync.init_schema`'s sales_call_log
# table has, in the order sync.py/app.py expect them. Individual tests only
# need to pass the columns they actually care about to insert_call().
_CALL_DEFAULTS = {
    "prospect_name": "Test Prospect",
    "prospect_email": "",
    "source": "",
    "call_date": "01/07/2026",
    "rep": "Alice",
    "call_type": "Sales Call",
    "outcome_logged": 1,
    "outcome_disposition": "",
    "calendar_event_id": "",
    "riverside_recording_id": "",
    "transcript_url": "",
    "match_method": "exact_key",
    "lead_quality_verdict": "good_to_book",
    "call_quality_score": 3,
    "flag_asked_for_close": 0,
    "flag_objections_handled": 0,
    "manual_review_recommended": 0,
    "severity": 1,
    "ai_feedback_summary": "",
    "reviewed_by_kris": "",
    "queue_age": 0,
    "kris_manual_review_verdict": "",
    "primary_failure_mode": "none",
    "flag_framework_explained": 1,
    "framework_gaps": "",
}


def insert_call(conn, **overrides):
    """Inserts one sales_call_log row, defaults filled in from
    _CALL_DEFAULTS, and returns the new row's id."""
    row = {**_CALL_DEFAULTS, **overrides}
    cols = list(row.keys())
    placeholders = ",".join("?" for _ in cols)
    cur = conn.execute(
        f"INSERT INTO sales_call_log ({','.join(cols)}) VALUES ({placeholders})",
        [row[c] for c in cols],
    )
    return cur.lastrowid


@pytest.fixture()
def db_path(tmp_path, monkeypatch):
    """A fresh, schema-only SQLite file per test, with app.py (and sync.py,
    for tests that exercise its own functions directly) pointed at it."""
    path = tmp_path / "dashboard.db"
    conn = sqlite3.connect(str(path))
    sync.init_schema(conn)
    conn.close()
    monkeypatch.setattr(app_module, "DB_PATH", str(path))
    monkeypatch.setattr(sync, "DB_PATH", str(path))
    return path


@pytest.fixture()
def conn(db_path):
    """A raw connection to the per-test db, for tests that want to seed rows
    directly rather than through the shared seeded_db fixture below."""
    c = sqlite3.connect(str(db_path))
    yield c
    c.close()


@pytest.fixture()
def seeded_db(db_path):
    """A realistic small mix of calls across 3 reps and several weeks —
    the shared fixture most query/route tests build on. Deliberately
    includes at least one row exercising each of: both lead-quality
    verdicts, a manual-review-pending row, an already-reviewed row (for
    calibration_agreement), a no_match/fallback_heuristic pipeline-health
    row, and a distinctive feedback-summary phrase for FTS search tests."""
    c = sqlite3.connect(str(db_path))
    c.execute(
        "INSERT INTO sync_meta (key, value) VALUES ('last_synced_at', ?)",
        (datetime.now(timezone.utc).isoformat(),),
    )

    # Week of 06/07/2026 (Mon 06 Jul)
    insert_call(c, prospect_name="Rebecca Stewart", rep="Alice", call_date="06/07/2026",
                call_quality_score=4, flag_asked_for_close=1, flag_objections_handled=1,
                ai_feedback_summary="Strong discovery, handled the price objection well.")
    insert_call(c, prospect_name="Nicole Freed", rep="Bob", call_date="07/07/2026",
                call_quality_score=2, flag_asked_for_close=0, flag_objections_handled=0,
                manual_review_recommended=1, severity=4, queue_age=3,
                primary_failure_mode="no_close_ask",
                ai_feedback_summary="Never actually asked for the close.")
    insert_call(c, prospect_name="Crystal Gargiulo", rep="Carol", call_date="08/07/2026",
                call_quality_score=5, flag_asked_for_close=1, flag_objections_handled=1,
                lead_quality_verdict="good_to_book",
                ai_feedback_summary="Excellent discovery and a clean close.")

    # Week of 13/07/2026
    insert_call(c, prospect_name="Kit Corney", rep="Alice", call_date="13/07/2026",
                call_quality_score=3, flag_asked_for_close=1, flag_objections_handled=0,
                primary_failure_mode="objections_missed",
                ai_feedback_summary="Asked for the close but missed an objection.")
    insert_call(c, prospect_name="Joseph Brandley", rep="Bob", call_date="14/07/2026",
                call_quality_score=1, lead_quality_verdict="not_a_fit",
                manual_review_recommended=1, severity=5, queue_age=1,
                kris_manual_review_verdict="",
                ai_feedback_summary="Poor lead, should not have been booked.")

    # Week of 20/07/2026 — already reviewed by Kris, agreeing with the model
    insert_call(c, prospect_name="Chad Davis", rep="Carol", call_date="20/07/2026",
                call_quality_score=2, manual_review_recommended=1, severity=3,
                reviewed_by_kris="TRUE", kris_manual_review_verdict="Yes",
                ai_feedback_summary="Weak discovery throughout.")
    # ...and one where Kris disagreed with the model (for calibration <100%)
    insert_call(c, prospect_name="Camryn Cisneros", rep="Alice", call_date="21/07/2026",
                call_quality_score=4, manual_review_recommended=1, severity=2,
                reviewed_by_kris="TRUE", kris_manual_review_verdict="No",
                ai_feedback_summary="Flagged automatically but actually fine.")

    # Pipeline-health rows: one unmatched, one fallback-matched
    insert_call(c, prospect_name="No Match Guy", rep="Bob", call_date="22/07/2026",
                match_method="no_match", call_quality_score=None,
                ai_feedback_summary="")
    insert_call(c, prospect_name="Heather Gorney", rep="Carol", call_date="05/08/2026",
                match_method="fallback_heuristic", call_quality_score=3,
                ai_feedback_summary="Legacy backfill row, name/date matched only.")

    c.commit()
    sync.rebuild_call_search_index(c)
    c.commit()  # replace_table/rebuild_call_search_index no longer commit internally (S7) — callers must
    c.close()
    return db_path


@pytest.fixture()
def client(db_path):
    """FastAPI TestClient wired to the per-test empty db. Depend on
    seeded_db in the test itself (fixtures don't need to depend on each
    other explicitly here — both just monkeypatch the same DB_PATH) when a
    route needs actual data to render."""
    return TestClient(app_module.app)
