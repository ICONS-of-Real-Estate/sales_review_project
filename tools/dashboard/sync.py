#!/usr/bin/env python3
"""
Pulls the "Sales Call Log" and "Training Assignments" tabs from the shared
Google Sheet into a local SQLite mirror the dashboard app reads from.

The Sheet stays the system of record (see DASHBOARD_RESEARCH_REPORT.md §1.2
for why: 8 Apps Script phases read/write it, and Phase 2 is mid-calibration
against it). This file's output is disposable, rebuildable derived data —
if dashboard.db is ever wrong or corrupt, delete it and re-run this script;
nothing is lost.

Auth: a read-only service-account JSON key, with the service account's
email shared as Viewer on the spreadsheet. Deliberately NOT the
transcription pipeline's user OAuth token.json — see
DASHBOARD_RESEARCH_REPORT.md §3.1 for why that pattern doesn't belong here
(a user refresh token can be revoked out from under the server and needs a
browser on an authorized machine to re-mint; a service account key does
not). See README.md in this directory for how to create one.

Run on a schedule via sales-dashboard-sync.timer (tools/deploy/setup_dashboard.sh)
— every 5-15 minutes is plenty at this data volume (~400 rows total).
"""
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build

BASE_DIR = Path(__file__).resolve().parent

# The Sales Call Log spreadsheet ID — same one Phase1_ComplianceCheck.gs's
# CONFIG.REPS entries point at. Override via env var if that ever changes.
SHEET_ID = os.environ.get("DASHBOARD_SHEET_ID", "1bK0VbgP3xdK5LhfYqO0fps9ivJzPDn3fsDcsl1dEBM4")
SERVICE_ACCOUNT_FILE = os.environ.get(
    "DASHBOARD_SERVICE_ACCOUNT_FILE", str(BASE_DIR / "service_account.json")
)
DB_PATH = os.environ.get("DASHBOARD_DB_PATH", str(BASE_DIR / "dashboard.db"))

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

SALES_CALL_LOG_TAB = "Sales Call Log"
TRAINING_ASSIGNMENTS_TAB = "Training Assignments"
DAILY_PRACTICE_FOLLOWUP_TAB = "Daily Practice Follow-ups"
SCORECARD_HISTORY_TAB = "Scorecard History"

# Sheet header name -> SQLite column name, looked up by name rather than
# position — a reordered or newly-inserted column in the Sheet (which has
# happened before per SALES_CALL_LOG_HEADERS's own comments about additive
# columns) doesn't silently corrupt the mirror. Must match
# Phase1_ComplianceCheck.gs's SALES_CALL_LOG_HEADERS exactly.
# Left side must match SALES_CALL_LOG_HEADERS in Phase1_ComplianceCheck.gs exactly (sheet header
# text); right side is this table's own SQLite column name and doesn't need to match the sheet
# header — e.g. "Reviewed By" (renamed 25/08/2026, both Kris and Tomás review calls now) still maps
# to the DB column reviewed_by_kris to avoid touching every query/route/template that already
# references it by that name.
SALES_CALL_LOG_COLUMNS = {
    "Prospect Name": "prospect_name",
    "Prospect Email": "prospect_email",
    "Source": "source",
    "Call Date": "call_date",
    "Rep": "rep",
    "Call Type": "call_type",
    "Outcome Logged": "outcome_logged",
    "Outcome Disposition": "outcome_disposition",
    "Calendar Event ID": "calendar_event_id",
    "Riverside Recording ID": "riverside_recording_id",
    "Transcript URL": "transcript_url",
    "Match Method": "match_method",
    "Lead Quality Verdict": "lead_quality_verdict",
    "Call Quality Score": "call_quality_score",
    "Flag: Asked For Close": "flag_asked_for_close",
    "Flag: Objections Handled": "flag_objections_handled",
    "Manual Review Recommended": "manual_review_recommended",
    "Severity": "severity",
    "AI Feedback Summary": "ai_feedback_summary",
    "Reviewed By": "reviewed_by_kris",
    "Queue Age": "queue_age",
    "Kris Manual Review Verdict": "kris_manual_review_verdict",
    "Primary Failure Mode": "primary_failure_mode",
    "Flag: Framework Explained": "flag_framework_explained",
    "Framework Gaps": "framework_gaps",
}

# Must match TRAINING_ASSIGNMENTS_HEADERS in Phase6_TrainingCallReview.gs.
TRAINING_ASSIGNMENTS_COLUMNS = {
    "Rep": "rep",
    "Training Objections (JSON)": "training_objections_json",
    "Close Ask Drill (JSON)": "close_ask_drill_json",
    "Training Framework (JSON)": "training_framework_json",
    "Last Updated": "last_updated",
}

# Must match DAILY_PRACTICE_FOLLOWUP_HEADERS in Phase7_DailySelfPractice.gs.
# One row per rep per assignment day — this is the only place "did today's
# drill actually get done" is visible at all outside Apps Script.
DAILY_PRACTICE_FOLLOWUP_COLUMNS = {
    "Rep": "rep",
    "Assignment Date (YYMMDD)": "assignment_date",
    "Thread ID": "thread_id",
    "Status": "status",
    "Last Nag At": "last_nag_at",
    "Nag Count": "nag_count",
}

# Must match SCORECARD_HISTORY_HEADERS in Phase5_WeeklyScorecard.gs. Purely
# additive on the .gs side (appended only on a real, non-preview send) — see
# that file's own comments for why this tab exists (the scorecard used to
# only ever go out as an email, with no queryable history of past weeks).
SCORECARD_HISTORY_COLUMNS = {
    "Rep": "rep",
    "Week Start": "week_start",
    "Week End": "week_end",
    "Calls This Week": "calls_this_week",
    "Weekly Avg Score": "weekly_avg_score",
    "Rolling 4-Week Avg": "rolling_4_week_avg",
    "Historic Avg (before this week)": "historic_avg_before_week",
    "Priority To Improve": "priority_to_improve",
    "Worst Call": "worst_call",
    "Worst Call Score": "worst_call_score",
    "Missing Outcome Disposition": "missing_outcome_disposition",
    "Sent At": "sent_at",
}

BOOLEAN_COLUMNS = {
    "outcome_logged",
    "flag_asked_for_close",
    "flag_objections_handled",
    "manual_review_recommended",
    "flag_framework_explained",
}
INT_COLUMNS = {"call_quality_score", "severity", "queue_age", "nag_count", "calls_this_week", "missing_outcome_disposition"}
FLOAT_COLUMNS = {"weekly_avg_score", "rolling_4_week_avg", "historic_avg_before_week", "worst_call_score"}


def sheets_client():
    import os
    from google.oauth2.credentials import Credentials
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    base_dir = os.path.dirname(os.path.abspath(__file__))
    sa_path = os.path.join(base_dir, 'service_account.json')
    token_path = os.path.abspath(os.path.join(base_dir, '..', 'token.json'))

    if os.path.exists(sa_path):
        creds = service_account.Credentials.from_service_account_file(
            sa_path, scopes=['https://www.googleapis.com/auth/spreadsheets.readonly']
        )
    elif os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path)
    else:
        raise FileNotFoundError(f'Neither {sa_path} nor {token_path} exists.')

    return build('sheets', 'v4', credentials=creds)


def fetch_tab(service, tab_name):
    """Returns list[dict] keyed by header name. Empty list if the tab is missing
    or has no data rows — logged as a warning, never a hard failure, so a
    renamed/missing tab degrades the dashboard instead of killing the sync.

    Skips any row whose first column is blank. Real incident live (25/08/2026):
    the live "Sales Call Log" sheet turned out to have a ~995-row gap of
    genuinely empty rows above the real data (rows 2 through ~996, real calls
    starting around row 997) — A1:Z20000 pulls those in just like real rows,
    and since checkbox/dropdown columns like "Outcome Logged" write an actual
    FALSE into every row in their validated range regardless of whether the
    row has any real data, those rows aren't blank across every column, just
    the identifying one. The dashboard was showing ~995 "(unnamed)" ghost
    calls because of this. Column A is "Prospect Name" for the call log and
    "Rep" for the other two synced tabs — always the one column a real row
    can't be blank on — same convention Phase1_ComplianceCheck.gs's
    setupSalesCallLog() already uses to detect a real vs. placeholder row.
    """
    try:
        resp = (
            service.spreadsheets()
            .values()
            .get(spreadsheetId=SHEET_ID, range=f"'{tab_name}'!A1:Z20000")
            .execute()
        )
    except Exception as e:
        print(f"WARNING: could not read tab '{tab_name}': {e}", file=sys.stderr)
        return []
    rows = resp.get("values", [])
    if not rows:
        return []
    header = rows[0]
    out = []
    for raw in rows[1:]:
        padded = raw + [""] * (len(header) - len(raw))
        if not str(padded[0]).strip():
            continue
        out.append(dict(zip(header, padded)))
    return out


def to_bool(v):
    return str(v).strip().upper() in ("TRUE", "YES", "1", "✓")


def to_int_or_none(v):
    try:
        return int(str(v).strip())
    except (ValueError, TypeError):
        return None


def to_float_or_none(v):
    try:
        return float(str(v).strip())
    except (ValueError, TypeError):
        return None


def _add_column_if_missing(conn, table, column, coltype):
    """ALTER TABLE ADD COLUMN, guarded — CREATE TABLE IF NOT EXISTS is a no-op
    against a table that already exists (e.g. the live VPS's dashboard.db),
    so a column added to the schema above only reaches an already-deployed
    database through this. PRAGMA table_info is checked explicitly rather
    than swallowing sqlite3's "duplicate column" error, so a genuinely
    unexpected ALTER TABLE failure (a locked db, a real syntax error) still
    surfaces instead of being silently absorbed."""
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")


def init_schema(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS sales_call_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prospect_name TEXT, prospect_email TEXT, source TEXT, call_date TEXT,
            rep TEXT, call_type TEXT, outcome_logged INTEGER, outcome_disposition TEXT,
            calendar_event_id TEXT, riverside_recording_id TEXT, transcript_url TEXT,
            match_method TEXT, lead_quality_verdict TEXT, call_quality_score INTEGER,
            flag_asked_for_close INTEGER, flag_objections_handled INTEGER,
            manual_review_recommended INTEGER, severity INTEGER, ai_feedback_summary TEXT,
            reviewed_by_kris TEXT, queue_age INTEGER, kris_manual_review_verdict TEXT,
            primary_failure_mode TEXT, flag_framework_explained INTEGER, framework_gaps TEXT
        );
        CREATE TABLE IF NOT EXISTS training_assignments (
            rep TEXT PRIMARY KEY,
            training_objections_json TEXT,
            close_ask_drill_json TEXT,
            training_framework_json TEXT,
            last_updated TEXT
        );
        CREATE TABLE IF NOT EXISTS daily_practice_followups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rep TEXT, assignment_date TEXT, thread_id TEXT, status TEXT,
            last_nag_at TEXT, nag_count INTEGER
        );
        CREATE TABLE IF NOT EXISTS scorecard_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rep TEXT, week_start TEXT, week_end TEXT, calls_this_week INTEGER,
            weekly_avg_score REAL, rolling_4_week_avg REAL, historic_avg_before_week REAL,
            priority_to_improve TEXT, worst_call TEXT, worst_call_score REAL,
            missing_outcome_disposition INTEGER, sent_at TEXT
        );
        CREATE TABLE IF NOT EXISTS sync_meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        """
    )
    # Migrate an already-existing database (see _add_column_if_missing) —
    # both columns added 25/08/2026 alongside the framework-explanation
    # scoring dimension (Phase2_CallGradingSOP.md SS3D).
    _add_column_if_missing(conn, "sales_call_log", "flag_framework_explained", "INTEGER")
    _add_column_if_missing(conn, "sales_call_log", "framework_gaps", "TEXT")
    _add_column_if_missing(conn, "training_assignments", "training_framework_json", "TEXT")
    conn.commit()


def rebuild_call_search_index(conn):
    """FTS5 index over every call's AI Feedback Summary — separate from
    playbooks.py's own FTS5 table (that one indexes the 3 curated markdown
    playbooks and is rebuilt at app startup since its source is repo files;
    this one indexes live call data and must be rebuilt every sync cycle
    instead, here, right after sales_call_log itself is refreshed)."""
    conn.executescript(
        """
        DROP TABLE IF EXISTS call_search;
        CREATE VIRTUAL TABLE call_search USING fts5(
            call_id UNINDEXED, prospect_name, rep, call_date UNINDEXED, body
        );
        """
    )
    rows = conn.execute(
        "SELECT id, prospect_name, rep, call_date, ai_feedback_summary FROM sales_call_log "
        "WHERE ai_feedback_summary IS NOT NULL AND ai_feedback_summary != ''"
    ).fetchall()
    for call_id, prospect_name, rep, call_date, summary in rows:
        conn.execute(
            "INSERT INTO call_search (call_id, prospect_name, rep, call_date, body) VALUES (?, ?, ?, ?, ?)",
            (call_id, prospect_name or "", rep or "", call_date or "", summary),
        )
    conn.commit()


def replace_table(conn, table, columns_map, rows):
    """Full-refresh a table: delete everything, reinsert from the current
    sheet pull. Safe at this data volume (~400 rows) and much simpler than
    diffing — see DASHBOARD_RESEARCH_REPORT.md §1.2 on the mirror being
    disposable/rebuildable rather than something to carefully upsert."""
    cols = list(columns_map.values())
    conn.execute(f"DELETE FROM {table}")
    placeholders = ",".join("?" for _ in cols)
    for r in rows:
        values = []
        for sheet_name, col in columns_map.items():
            v = r.get(sheet_name, "")
            if col in BOOLEAN_COLUMNS:
                v = int(to_bool(v))
            elif col in INT_COLUMNS:
                v = to_int_or_none(v)
            elif col in FLOAT_COLUMNS:
                v = to_float_or_none(v)
            values.append(v)
        conn.execute(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({placeholders})", values)
    conn.commit()


def main():
    conn = sqlite3.connect(DB_PATH)
    init_schema(conn)

    service = sheets_client()
    call_log_rows = fetch_tab(service, SALES_CALL_LOG_TAB)
    training_rows = fetch_tab(service, TRAINING_ASSIGNMENTS_TAB)
    practice_rows = fetch_tab(service, DAILY_PRACTICE_FOLLOWUP_TAB)
    scorecard_history_rows = fetch_tab(service, SCORECARD_HISTORY_TAB)

    replace_table(conn, "sales_call_log", SALES_CALL_LOG_COLUMNS, call_log_rows)
    replace_table(conn, "training_assignments", TRAINING_ASSIGNMENTS_COLUMNS, training_rows)
    replace_table(conn, "daily_practice_followups", DAILY_PRACTICE_FOLLOWUP_COLUMNS, practice_rows)
    replace_table(conn, "scorecard_history", SCORECARD_HISTORY_COLUMNS, scorecard_history_rows)
    rebuild_call_search_index(conn)

    conn.execute(
        "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_synced_at', ?)",
        (datetime.now(timezone.utc).isoformat(),),
    )
    conn.commit()
    conn.close()

    print(
        f"Synced {len(call_log_rows)} call-log row(s), "
        f"{len(training_rows)} training-assignment row(s), "
        f"{len(practice_rows)} daily-practice-followup row(s), "
        f"{len(scorecard_history_rows)} scorecard-history row(s) into {DB_PATH}"
    )


if __name__ == "__main__":
    main()
