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
from datetime import datetime, timedelta, timezone
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

TRAINING_PRIORITY_OVERRIDES_TAB = "Training Priority Overrides"
# Must match TRAINING_PRIORITY_OVERRIDES_HEADERS in Phase1_ComplianceCheck.gs
# (and sheets_write.py's own copy of the same constant, which is what
# actually writes rows here). Read-only mirror: the dashboard shows Tomás
# what's currently set, but /reps/{rep}/priority-override (app.py) writes
# through sheets_write.py, same "one write path" rule every other writable
# tab in this file follows.
TRAINING_PRIORITY_OVERRIDES_COLUMNS = {
    "Rep": "rep",
    "Week Start": "week_start",
    "Priority": "priority",
    "Set By": "set_by",
    "Set At": "set_at",
}

# Must match REENGAGEMENT_OVERRIDES_HEADERS in Phase17_SeanFollowUpAutomation.gs
# (and sheets_write.py's own copy, which is what actually writes rows here).
# Read-only mirror: /reps/{rep}/leads (app.py) shows the current action per
# lead, but the Cancel/Lower Priority/Reactivate buttons write through
# sheets_write.write_reengagement_override, same one-write-path rule as
# every other writable tab in this file.
REENGAGEMENT_OVERRIDES_TAB = "Re-engagement Overrides"
REENGAGEMENT_OVERRIDES_COLUMNS = {
    "Rep": "rep",
    "Lead Email": "lead_email",
    "Lead Name": "lead_name",
    "Action": "action",
    "Set By": "set_by",
    "Set At": "set_at",
}

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
    # Added 07/09/2026 for the rep roster stats Kris asked for: "closing
    # rate... book the second calls... average time length" — Booking
    # Decision Appropriate is the existing "did this call correctly result
    # in booking (or not booking) the right next call" dimension
    # (Phase2_CallScoring.gs's deriveBookingDecisionFields_ — only 'shared'/
    # 'sean' variants score it; blank elsewhere, read as "no signal" not a
    # failure). Call Length (Minutes) is the real measured call duration
    # (extractCallLengthMinutes_, same file) — blank on any transcript from
    # before that was tracked.
    "Flag: Booking Decision Appropriate": "flag_booking_decision_appropriate",
    "Call Length (Minutes)": "call_length_minutes",
    # Added 08/09/2026. These four have existed in the Sales Call Log since
    # the discovery/delivery rubric shipped (Phase2_CallScoring.gs's
    # deriveDiscoveryFields_/deriveDeliveryFields_), but were never added
    # here — so the dashboard mirror has never carried them at all, and no
    # dashboard page could show discovery or delivery even when the sheet
    # had it. Found while chasing "Tomas is meant to be training discovery"
    # (Kris, 08/09/2026). Tri-state like flag_booking_decision_appropriate:
    # blank means "not graded on this call", never a pass and never a
    # failure — see NULLABLE_BOOLEAN_COLUMNS below.
    "Flag: Discovery Adequate": "flag_discovery_adequate",
    "Discovery Gaps": "discovery_gaps",
    "Flag: Delivery Effective": "flag_delivery_effective",
    "Delivery Gaps": "delivery_gaps",
}

# Bens doesn't take Sales Calls (CLAUDE.md "Who does what") — his real
# conversion metric is QC booking off his podcast recordings, tracked in his
# own long-standing "Icons Podcast Recordings" tab (same shared spreadsheet),
# not the Sales Call Log. Column layout confirmed live from the spreadsheet,
# documented in CLAUDE.md.
BENS_PODCAST_TRACKER_TAB = "Icons Podcast Recordings"
BENS_PODCAST_TRACKER_COLUMNS = {
    "Name": "name",
    "Email": "email",
    "Source": "source",
    "Booked": "booked",
    "Booking Date": "booking_date",
    "Recording Date": "recording_date",
    "Recording Done": "recording_done",
    "QC Booked": "qc_booked",
    "QC Date": "qc_date",
    "QC Show Up": "qc_show_up",
    "SC Booked": "sc_booked",
    "SC Date": "sc_date",
    "SC Show Up": "sc_show_up",
    "Sale": "sale",
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
# "Needs More Info" added 06/09/2026 — Kris: "Add another button. Don't
# know...so that if he doesn't understand he can just hit that." A third
# decision alongside Approve/Reject.
CRM_ORGANIZATION_REVIEW_COLUMNS = {
    "Timestamp": "timestamp",
    "Category": "category",
    "Finding": "finding",
    "Evidence": "evidence",
    "Suggested Action": "suggested_action",
    "Approve": "approve",
    "Reject": "reject",
    "Dedupe Key": "dedupe_key",
    "Needs More Info": "needs_more_info",
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
    "Needs More Info": "needs_more_info",
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
    "needs_more_info",
    "recording_done",
    "qc_booked",
    "qc_show_up",
    "sc_booked",
    "sc_show_up",
    "sale",
}
# Tri-state, unlike BOOLEAN_COLUMNS above: a blank cell means "not scored on
# this call" (e.g. Booking Decision Appropriate is only scored on 'shared'/
# 'sean' variants — Phase2_CallScoring.gs's deriveBookingDecisionFields_),
# NOT a false verdict. Coercing blank through to_bool() (like BOOLEAN_COLUMNS
# does) would silently count "never scored" rows as "scored inappropriate,"
# corrupting any rate computed from this column — same "no signal != false"
# bug class Phase5_WeeklyScorecard.gs's own isExplicitlyFalse_ exists to
# avoid. Stored as NULL/1/0 instead of always 1/0.
# Discovery/delivery are tri-state for the same reason and then some: the QC
# rubric legitimately never scores some discovery keys, and a row scored
# before those columns existed has a blank. Apps Script's own reader
# (trainingElementFlagsForRow_, Phase1_ComplianceCheck.gs) treats blank as
# "not graded" — the mirror must agree, or the dashboard and the weekly
# playbook email will disagree about the same call.
NULLABLE_BOOLEAN_COLUMNS = {
    "flag_booking_decision_appropriate",
    "flag_discovery_adequate",
    "flag_delivery_effective",
}
INT_COLUMNS = {
    "call_quality_score", "severity", "queue_age", "nag_count", "calls_this_week",
    "missing_outcome_disposition", "sheet_row",
}
FLOAT_COLUMNS = {
    "weekly_avg_score", "rolling_4_week_avg", "historic_avg_before_week", "worst_call_score",
    "call_length_minutes",
}


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


SHEETS_SERIAL_EPOCH = datetime(1899, 12, 30)


def sheets_serial_to_iso_date(serial):
    """Converts a Sheets/Excel date serial (days since 1899-12-30, per
    valueRenderOption=UNFORMATTED_VALUE + dateTimeRenderOption=SERIAL_NUMBER)
    into an unambiguous 'YYYY-MM-DD' string. Returns None on anything that
    isn't a plain number (a blank cell, or genuine free text in a column that
    isn't always a real Date-typed cell) — caller falls back to the original
    FORMATTED_VALUE string in that case rather than losing the row."""
    try:
        serial = float(serial)
    except (TypeError, ValueError):
        return None
    return (SHEETS_SERIAL_EPOCH + timedelta(days=serial)).date().isoformat()


def fetch_tab(service, tab_name, date_columns=()):
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

    date_columns (S8, real bug found live 09/09/2026 — Kris, looking at
    Bens' dashboard page: "The dates are wrong. It's only September."):
    FORMATTED_VALUE (the default render option, used above for everything)
    returns each cell exactly as Sheets DISPLAYS it, which follows the
    SPREADSHEET's own locale/number-format setting — not this project's
    documented DD/MM/YYYY convention (brief.txt §2). Every date-writing path
    in Phase2_CallScoring.gs writes a real JS Date object, so what actually
    comes back for "8/12/2026" depends on whether the live spreadsheet's
    locale renders that as 8 December or 12 August — parse_call_date
    (app.py) assumes DD/MM first per the documented convention, and if the
    live sheet is actually formatting M/D (a very common default), every
    two-digit-day-and-month date gets silently misread: Chad Davis's real
    12 August QC call rendered as "8 Dec", a real 11 June call as "6 Nov" —
    wrong, and specifically wrong in the direction of reading as a FUTURE
    date, which is how Kris caught it (no real call could be in November
    when it's only September).

    The only way to sidestep the locale guess entirely: ask the Sheets API
    for the cell's raw serial number instead of its locale-formatted string
    (valueRenderOption=UNFORMATTED_VALUE, dateTimeRenderOption=SERIAL_NUMBER)
    for whichever columns are named in date_columns, and convert that number
    ourselves via sheets_serial_to_iso_date — no locale involved at all. A
    second, cheap fetch of the same range (same for every date column at
    once) rather than special-casing each one; skipped when date_columns is
    empty so tabs with no real Date-typed columns (the free-text "May 20"
    style dates on Bens' own podcast tracker, brief.txt §A — never DD/MM/YYYY
    to begin with) don't pay for a fetch they can't use anyway.
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

    serial_rows = []
    if date_columns and any(c in header for c in date_columns):
        try:
            serial_resp = (
                service.spreadsheets()
                .values()
                .get(
                    spreadsheetId=SHEET_ID,
                    range=f"'{tab_name}'",
                    valueRenderOption="UNFORMATTED_VALUE",
                    dateTimeRenderOption="SERIAL_NUMBER",
                )
                .execute()
            )
            serial_rows = serial_resp.get("values", [])
        except Exception as e:
            # Best-effort: fall back to the FORMATTED_VALUE string for every
            # date cell this cycle (the pre-existing, imperfect behavior)
            # rather than failing the whole tab over a second, non-essential
            # fetch.
            print(f"WARNING: could not fetch unambiguous dates for '{tab_name}' — falling back to locale-formatted "
                  f"strings this cycle: {e}", file=sys.stderr)

    date_col_indexes = [header.index(c) for c in date_columns if c in header]

    out = []
    skipped = 0
    # sheet_row is the row's real 1-indexed position in the spreadsheet
    # (row 1 is the header, so the first data row is 2) — stamped onto every
    # row as "__sheet_row__" so a caller that needs to write back to this
    # exact row later (sheets_write.py, for /review's Approve/Reject) doesn't
    # have to re-derive it. Not a real header, so it never collides with an
    # actual column name; tables that don't map it (columns_map has no
    # "__sheet_row__" key) simply ignore it.
    for row_index, raw in enumerate(rows[1:]):
        sheet_row = row_index + 2
        padded = raw + [""] * (len(header) - len(raw))
        if not str(padded[0]).strip():
            skipped += 1
            continue
        # Overwrite each date column's locale-ambiguous FORMATTED_VALUE
        # string with the unambiguous serial-number conversion, when the
        # second fetch found a real number there — see date_columns' own
        # comment above. serial_rows can be shorter than rows (Sheets omits
        # trailing empty cells independently per request) or missing this
        # row entirely if it was added between the two fetches; both are
        # just "no serial available this row," never an error.
        # +1: serial_rows still has its own header row at index 0, same
        # shape as `rows` — row_index is 0-based into rows[1:].
        serial_raw = serial_rows[row_index + 1] if row_index + 1 < len(serial_rows) else []
        for idx in date_col_indexes:
            if idx >= len(serial_raw):
                continue
            iso = sheets_serial_to_iso_date(serial_raw[idx])
            if iso:
                padded[idx] = iso
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
            primary_failure_mode TEXT, flag_framework_explained INTEGER, framework_gaps TEXT,
            flag_booking_decision_appropriate INTEGER, call_length_minutes REAL,
            flag_discovery_adequate INTEGER, discovery_gaps TEXT,
            flag_delivery_effective INTEGER, delivery_gaps TEXT
        );
        CREATE TABLE IF NOT EXISTS bens_podcast_tracker (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT, email TEXT, source TEXT, booked TEXT, booking_date TEXT,
            recording_date TEXT, recording_done INTEGER, qc_booked INTEGER, qc_date TEXT,
            qc_show_up INTEGER, sc_booked INTEGER, sc_date TEXT, sc_show_up INTEGER, sale INTEGER
        );
        CREATE TABLE IF NOT EXISTS training_priority_overrides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rep TEXT, week_start TEXT, priority TEXT, set_by TEXT, set_at TEXT
        );
        CREATE TABLE IF NOT EXISTS reengagement_overrides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rep TEXT, lead_email TEXT, lead_name TEXT, action TEXT, set_by TEXT, set_at TEXT
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
            suggested_action TEXT, approve INTEGER, reject INTEGER,
            dedupe_key TEXT, needs_more_info INTEGER
        );
        CREATE TABLE IF NOT EXISTS lead_reconciliation (
            sheet_row INTEGER PRIMARY KEY,
            timestamp TEXT, name TEXT, email TEXT, status TEXT, sources TEXT,
            likely_noise INTEGER, noise_reason TEXT, ambiguous_matches TEXT,
            real_lead INTEGER, not_real_lead INTEGER, dedupe_key TEXT,
            needs_more_info INTEGER
        );
        -- Kris, 06/09/2026: "Add to be able to review all the changes in
        -- the interface with an UNDO and UNDO ALL button" — an audit trail
        -- of every Approve/Reject made through /review, so /review/history
        -- can show what happened and undo it. Deliberately NOT one of the
        -- tables sync.py's main() refreshes from the Sheet every cycle
        -- (see the `tabs` dict below) — this is dashboard-local history,
        -- not sheet-derived data, and a full-refresh cycle must never wipe
        -- it. `label` snapshots a human-readable description of what was
        -- decided at decide-time, so history reads correctly even if the
        -- underlying sheet row's own text later changes or the row is gone.
        CREATE TABLE IF NOT EXISTS review_decisions_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT, sheet_row INTEGER, decision TEXT, label TEXT,
            decided_by TEXT, decided_at TEXT, undone INTEGER DEFAULT 0
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
    # 06/09/2026: crm_organization_review never had a dedupe_key column at
    # all (added to the Sheet the same day Phase15_CrmOrganizationReview.gs
    # gained its own dedupe check, but missed here) — and both review
    # tables gained "Needs More Info" alongside Approve/Reject.
    _add_column_if_missing(conn, "crm_organization_review", "dedupe_key", "TEXT")
    _add_column_if_missing(conn, "crm_organization_review", "needs_more_info", "INTEGER")
    _add_column_if_missing(conn, "lead_reconciliation", "needs_more_info", "INTEGER")
    # 07/09/2026: rep roster stats (closing rate, booking rate, call length).
    _add_column_if_missing(conn, "sales_call_log", "flag_booking_decision_appropriate", "INTEGER")
    _add_column_if_missing(conn, "sales_call_log", "flag_discovery_adequate", "INTEGER")
    _add_column_if_missing(conn, "sales_call_log", "discovery_gaps", "TEXT")
    _add_column_if_missing(conn, "sales_call_log", "flag_delivery_effective", "INTEGER")
    _add_column_if_missing(conn, "sales_call_log", "delivery_gaps", "TEXT")
    _add_column_if_missing(conn, "sales_call_log", "call_length_minutes", "REAL")
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
            elif col in NULLABLE_BOOLEAN_COLUMNS:
                v = int(to_bool(v)) if str(v).strip() != "" else None
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
        "bens_podcast_tracker": (BENS_PODCAST_TRACKER_TAB, BENS_PODCAST_TRACKER_COLUMNS),
        "training_priority_overrides": (TRAINING_PRIORITY_OVERRIDES_TAB, TRAINING_PRIORITY_OVERRIDES_COLUMNS),
        "reengagement_overrides": (REENGAGEMENT_OVERRIDES_TAB, REENGAGEMENT_OVERRIDES_COLUMNS),
    }
    # Which sheet-header columns need the unambiguous-serial-number treatment
    # (fetch_tab's date_columns param — see its own comment). Only "Call
    # Date" today: it's the one real Date-typed column app.py actually
    # parses/sorts/charts on. The podcast tracker's Booking/Recording/QC/SC
    # Date columns are known free text ("May 20", brief.txt §A) and were
    # never DD/MM/YYYY to begin with, so there's nothing for this to fix
    # there — listing them here would just be a wasted extra fetch.
    date_columns_by_table = {"sales_call_log": ("Call Date",)}

    try:
        counts = {}
        for table, (tab_name, columns_map) in tabs.items():
            rows = fetch_tab(service, tab_name, date_columns=date_columns_by_table.get(table, ()))
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
