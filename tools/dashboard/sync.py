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
# Written by Phase15_CrmOrganizationReview.gs / Phase13_LeadReconciliation.gs
# (both read-only against GHL — see those files). Synced here so /review can
# show Tomás's pending findings without him opening the spreadsheet at all;
# his Approve/Reject decision on /review writes back through sheets_write.py,
# not through this (read-only) sync.
CRM_ORGANIZATION_REVIEW_TAB = "CRM Organization Review"
LEAD_RECONCILIATION_TAB = "Lead Reconciliation - All"

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
    "Matched File": "matched_file",
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

# Must match CRM_ORGANIZATION_REVIEW_HEADERS_ in Phase15_CrmOrganizationReview.gs.
# "__sheet_row__" isn't a real sheet column — fetch_tab stamps it onto every
# row (see its own comment) with the row's actual spreadsheet row number, and
# it's mapped here into a real sheet_row column so /review's write-back
# (sheets_write.py) knows exactly which row to update.
CRM_ORGANIZATION_REVIEW_COLUMNS = {
    "Timestamp": "timestamp",
    "Category": "category",
    "Finding": "finding",
    "Evidence": "evidence",
    "Suggested Action": "suggested_action",
    "Approve": "approve",
    "Reject": "reject",
    "__sheet_row__": "sheet_row",
}

# Must match LEAD_RECONCILIATION_REVIEW_HEADERS_ in Phase13_LeadReconciliation.gs.
LEAD_RECONCILIATION_COLUMNS = {
    "Timestamp": "timestamp",
    "Name": "name",
    "Email": "email",
    "Status": "status",
    "Sources": "sources",
    "Likely Noise": "likely_noise",
    "Noise Reason": "noise_reason",
    "Ambiguous GHL Matches": "ambiguous_matches",
    "Real Lead — add to CRM": "real_lead",
    "Not a real lead": "not_real_lead",
    "Dedupe Key": "dedupe_key",
    "__sheet_row__": "sheet_row",
}

BOOLEAN_COLUMNS = {
    "outcome_logged",
    "flag_asked_for_close",
    "flag_objections_handled",
    "manual_review_recommended",
    "flag_framework_explained",
    "approve",
    "reject",
    "likely_noise",
    "real_lead",
    "not_real_lead",
}
INT_COLUMNS = {
    "call_quality_score", "severity", "queue_age", "nag_count", "calls_this_week",
    "missing_outcome_disposition", "sheet_row",
}
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
    """Returns list[dict] keyed by header name, or None on a genuine fetch
    failure (see below) so the caller can tell "this tab really has zero
    rows" apart from "we couldn't read it this cycle."

    Real bug (C-09/S1): this used to return [] for BOTH a tab that
    legitimately has no rows AND a transient fetch failure (network blip,
    expired credentials, a rate limit) — and main()/replace_table() DELETEs
    the existing table before reinserting, so a single flaky sync cycle
    silently wiped the live mirror to empty instead of leaving the last-good
    data in place. Only a confirmed "this tab doesn't exist" (HttpError 400,
    "Unable to parse range" — e.g. Training Assignments before Phase 6's
    first real run ever creates it) is treated as genuinely empty; every
    other exception is a real failure that must NOT touch the table (S2 —
    this is also the exact shape of the live Training Assignments HttpError
    400 seen 26/08/2026, which was the tab simply not existing yet, not a
    transient error, and is the reason this distinction exists at all).

    Not just A1:Z20000 (S3): a bare 'tab_name' range asks the Sheets API for
    the tab's own full used range, so a column added past Z (this sheet has
    already grown additively more than once — see SALES_CALL_LOG_COLUMNS's
    own header comment) is never silently truncated out of the pull.

    Skips any row whose first column is blank, logging how many were
    skipped (S4) — a renamed/blanked identifying column would otherwise
    silently drop every row with no signal at all, rather than just the
    known/expected gap. Real incident live (25/08/2026): the live "Sales
    Call Log" sheet turned out to have a ~995-row gap of genuinely empty
    rows above the real data (rows 2 through ~996, real calls starting
    around row 997) — and since checkbox/dropdown columns like "Outcome
    Logged" write an actual FALSE into every row in their validated range
    regardless of whether the row has any real data, those rows aren't
    blank across every column, just the identifying one. The dashboard was
    showing ~995 "(unnamed)" ghost calls because of this. Column A is
    "Prospect Name" for the call log and "Rep" for the other two synced
    tabs — always the one column a real row can't be blank on — same
    convention Phase1_ComplianceCheck.gs's setupSalesCallLog() already uses
    to detect a real vs. placeholder row.
    """
    try:
        resp = (
            service.spreadsheets()
            .values()
            .get(spreadsheetId=SHEET_ID, range=f"'{tab_name}'")
            .execute()
        )
    except Exception as e:
        from googleapiclient.errors import HttpError

        if isinstance(e, HttpError) and e.resp.status == 400 and "Unable to parse range" in str(e):
            print(f"NOTE: tab '{tab_name}' does not exist yet — treating as genuinely empty.", file=sys.stderr)
            return []
        print(f"ERROR: could not read tab '{tab_name}' — leaving its existing mirrored data untouched: {e}", file=sys.stderr)
        return None
    rows = resp.get("values", [])
    if not rows:
        return []
    header = rows[0]
    out = []
    skipped = 0
    # sheet_row is the row's real 1-indexed position in the spreadsheet
    # (row 1 is the header, so the first data row is 2) — stamped onto every
    # row as "__sheet_row__" so a caller that needs to write back to this
    # exact row later (sheets_write.py, for /review's Approve/Reject) doesn't
    # have to re-derive it. Not a real header, so it never collides with an
    # actual column name; tables that don't map it (columns_map has no
    # "__sheet_row__" key) simply ignore it.
    for sheet_row, raw in enumerate(rows[1:], start=2):
        padded = raw + [""] * (len(header) - len(raw))
        if not str(padded[0]).strip():
            skipped += 1
            continue
        record = dict(zip(header, padded))
        record["__sheet_row__"] = sheet_row
        out.append(record)
    if skipped:
        print(f"NOTE: tab '{tab_name}' — skipped {skipped} row(s) blank in column A (placeholder/gap rows).", file=sys.stderr)
    return out


def to_bool(v):
    return str(v).strip().upper() in ("TRUE", "YES", "1", "✓")


def to_int_or_none(v, column=None, warnings=None):
    s = str(v).strip()
    try:
        return int(s)
    except (ValueError, TypeError):
        if s and warnings is not None:
            warnings.append(f"{column}={v!r}")
        return None


def to_float_or_none(v, column=None, warnings=None):
    s = str(v).strip()
    try:
        return float(s)
    except (ValueError, TypeError):
        if s and warnings is not None:
            warnings.append(f"{column}={v!r}")
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
            last_nag_at TEXT, nag_count INTEGER, matched_file TEXT
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
        CREATE TABLE IF NOT EXISTS crm_organization_review (
            sheet_row INTEGER PRIMARY KEY,
            timestamp TEXT, category TEXT, finding TEXT, evidence TEXT,
            suggested_action TEXT, approve INTEGER, reject INTEGER
        );
        CREATE TABLE IF NOT EXISTS lead_reconciliation (
            sheet_row INTEGER PRIMARY KEY,
            timestamp TEXT, name TEXT, email TEXT, status TEXT, sources TEXT,
            likely_noise INTEGER, noise_reason TEXT, ambiguous_matches TEXT,
            real_lead INTEGER, not_real_lead INTEGER, dedupe_key TEXT
        );
        """
    )
    # Migrate an already-existing database (see _add_column_if_missing) —
    # both columns added 25/08/2026 alongside the framework-explanation
    # scoring dimension (Phase2_CallGradingSOP.md SS3D).
    _add_column_if_missing(conn, "sales_call_log", "flag_framework_explained", "INTEGER")
    _add_column_if_missing(conn, "sales_call_log", "framework_gaps", "TEXT")
    _add_column_if_missing(conn, "training_assignments", "training_framework_json", "TEXT")
    # 28/08/2026: "Matched File" pins whichever file a Daily Practice
    # Follow-ups row claimed, so a late-submission match can't be reused by
    # a different assignment day (Phase7_DailySelfPractice.gs).
    _add_column_if_missing(conn, "daily_practice_followups", "matched_file", "TEXT")
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
    # NOT committed here (S7) — main() does one commit for the whole cycle.


def replace_table(conn, table, columns_map, rows):
    """Full-refresh a table: delete everything, reinsert from the current
    sheet pull. Safe at this data volume (~400 rows) and much simpler than
    diffing — see DASHBOARD_RESEARCH_REPORT.md §1.2 on the mirror being
    disposable/rebuildable rather than something to carefully upsert.

    NOT committed here (S7) — main() commits once, after every table has
    been rebuilt, so a crash or exception partway through a sync cycle rolls
    back to the last-good state instead of leaving some tables refreshed and
    others stale/wiped.

    Every int/float conversion failure is collected and logged as one
    summary line per table (S5/S6) — a manually-typed non-numeric value
    (e.g. "N/A" in Call Quality Score) used to become a silent NULL with no
    diagnostic trail at all.
    """
    cols = list(columns_map.values())
    conn.execute(f"DELETE FROM {table}")
    placeholders = ",".join("?" for _ in cols)
    conversion_warnings = []
    for r in rows:
        values = []
        for sheet_name, col in columns_map.items():
            v = r.get(sheet_name, "")
            if col in BOOLEAN_COLUMNS:
                v = int(to_bool(v))
            elif col in INT_COLUMNS:
                v = to_int_or_none(v, column=col, warnings=conversion_warnings)
            elif col in FLOAT_COLUMNS:
                v = to_float_or_none(v, column=col, warnings=conversion_warnings)
            values.append(v)
        conn.execute(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({placeholders})", values)
    if conversion_warnings:
        print(
            f"WARNING: {table} — {len(conversion_warnings)} value(s) failed int/float conversion "
            f"and were stored as NULL: {'; '.join(conversion_warnings[:10])}"
            + (f" ... and {len(conversion_warnings) - 10} more" if len(conversion_warnings) > 10 else ""),
            file=sys.stderr,
        )


def main():
    conn = sqlite3.connect(DB_PATH)
    init_schema(conn)
    conn.commit()  # schema/migration DDL lands regardless of whether the rest of this sync succeeds

    service = sheets_client()
    tabs = {
        "sales_call_log": (SALES_CALL_LOG_TAB, SALES_CALL_LOG_COLUMNS),
        "training_assignments": (TRAINING_ASSIGNMENTS_TAB, TRAINING_ASSIGNMENTS_COLUMNS),
        "daily_practice_followups": (DAILY_PRACTICE_FOLLOWUP_TAB, DAILY_PRACTICE_FOLLOWUP_COLUMNS),
        "scorecard_history": (SCORECARD_HISTORY_TAB, SCORECARD_HISTORY_COLUMNS),
        "crm_organization_review": (CRM_ORGANIZATION_REVIEW_TAB, CRM_ORGANIZATION_REVIEW_COLUMNS),
        "lead_reconciliation": (LEAD_RECONCILIATION_TAB, LEAD_RECONCILIATION_COLUMNS),
    }

    try:
        counts = {}
        for table, (tab_name, columns_map) in tabs.items():
            rows = fetch_tab(service, tab_name)
            if rows is None:
                # Genuine fetch failure (C-09/S1) — leave this table exactly as
                # it was from the last successful sync rather than wiping it.
                print(f"NOTE: {table} left untouched this cycle (fetch failed).", file=sys.stderr)
                continue
            replace_table(conn, table, columns_map, rows)
            counts[table] = len(rows)
        rebuild_call_search_index(conn)

        conn.execute(
            "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_synced_at', ?)",
            (datetime.now(timezone.utc).isoformat(),),
        )
        conn.commit()  # single commit for the whole cycle (S7) — a mid-cycle exception rolls everything back instead
    except Exception:
        conn.rollback()
        conn.close()
        raise
    conn.close()

    print(
        "Synced "
        + ", ".join(f"{counts[t]} {t} row(s)" for t in counts)
        + (" (some tabs skipped this cycle — see NOTE/ERROR lines above)" if len(counts) < len(tabs) else "")
        + f" into {DB_PATH}"
    )


if __name__ == "__main__":
    main()
