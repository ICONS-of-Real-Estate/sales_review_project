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

# Sheet header name -> SQLite column name, looked up by name rather than
# position — a reordered or newly-inserted column in the Sheet (which has
# happened before per SALES_CALL_LOG_HEADERS's own comments about additive
# columns) doesn't silently corrupt the mirror. Must match
# Phase1_ComplianceCheck.gs's SALES_CALL_LOG_HEADERS exactly.
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
    "Reviewed By Kris": "reviewed_by_kris",
    "Queue Age": "queue_age",
    "Kris Manual Review Verdict": "kris_manual_review_verdict",
    "Primary Failure Mode": "primary_failure_mode",
}

# Must match TRAINING_ASSIGNMENTS_HEADERS in Phase6_TrainingCallReview.gs.
TRAINING_ASSIGNMENTS_COLUMNS = {
    "Rep": "rep",
    "Training Objections (JSON)": "training_objections_json",
    "Close Ask Drill (JSON)": "close_ask_drill_json",
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

BOOLEAN_COLUMNS = {
    "outcome_logged",
    "flag_asked_for_close",
    "flag_objections_handled",
    "manual_review_recommended",
}
INT_COLUMNS = {"call_quality_score", "severity", "queue_age", "nag_count"}


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
    renamed/missing tab degrades the dashboard instead of killing the sync."""
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
        out.append(dict(zip(header, padded)))
    return out


def to_bool(v):
    return str(v).strip().upper() in ("TRUE", "YES", "1", "✓")


def to_int_or_none(v):
    try:
        return int(str(v).strip())
    except (ValueError, TypeError):
        return None


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
            primary_failure_mode TEXT
        );
        CREATE TABLE IF NOT EXISTS training_assignments (
            rep TEXT PRIMARY KEY,
            training_objections_json TEXT,
            close_ask_drill_json TEXT,
            last_updated TEXT
        );
        CREATE TABLE IF NOT EXISTS daily_practice_followups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rep TEXT, assignment_date TEXT, thread_id TEXT, status TEXT,
            last_nag_at TEXT, nag_count INTEGER
        );
        CREATE TABLE IF NOT EXISTS sync_meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        """
    )
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

    replace_table(conn, "sales_call_log", SALES_CALL_LOG_COLUMNS, call_log_rows)
    replace_table(conn, "training_assignments", TRAINING_ASSIGNMENTS_COLUMNS, training_rows)
    replace_table(conn, "daily_practice_followups", DAILY_PRACTICE_FOLLOWUP_COLUMNS, practice_rows)
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
        f"{len(practice_rows)} daily-practice-followup row(s) into {DB_PATH}"
    )


if __name__ == "__main__":
    main()
