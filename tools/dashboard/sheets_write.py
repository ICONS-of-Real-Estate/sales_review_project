#!/usr/bin/env python3
"""
The one place this dashboard writes anything back to Google Sheets.

Everything else in tools/dashboard/ (sync.py, app.py) is deliberately
read-only, per DASHBOARD_RESEARCH_REPORT.md — the dashboard mirrors the
sheet, it never talks to Apps Script or edits the sheet itself. /review
(app.py) is the one exception: it lets Tomás tick the same Approve/Reject
(or "Real Lead"/"Not a real lead") checkboxes from the dashboard that he
could otherwise only tick by opening the spreadsheet directly — Kris's ask
(06/09/2026): "make it easy for him," a big green/red button instead of
hunting through hundreds of rows. This module is what actually flips those
checkboxes; nothing else in this codebase writes to
"CRM Organization Review" or "Lead Reconciliation - All" except the Apps
Script phases that create the findings in the first place
(Phase15_CrmOrganizationReview.gs / Phase13_LeadReconciliation.gs).

SETUP (one-time, in addition to sync.py's own service-account setup — see
README.md): the SAME service account used for the read-only sync must also
be shared on the spreadsheet as EDITOR, not just Viewer. Sharing it Viewer
(sync.py's requirement) is not enough for this module — every write here
will fail with a 403 until that's done. This is exactly the kind of scope
gap seen before with the GHL Private Integration token (05/09/2026) —
expect a clear permission error in the dashboard UI if this step is missed,
not a silent no-op (write_decision lets the API's own error propagate).

Read-only sync (sync.py) intentionally keeps its own narrower
'spreadsheets.readonly' scope — this module is separate so a bug here can
never accidentally touch the read path, and so the blast radius of "what
can write to the sheet" stays limited to these two decision columns only.
"""
import os
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build

BASE_DIR = Path(__file__).resolve().parent

SHEET_ID = os.environ.get("DASHBOARD_SHEET_ID", "1bK0VbgP3xdK5LhfYqO0fps9ivJzPDn3fsDcsl1dEBM4")
SERVICE_ACCOUNT_FILE = os.environ.get(
    "DASHBOARD_SERVICE_ACCOUNT_FILE", str(BASE_DIR / "service_account.json")
)
WRITE_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

# Which sheet + which two adjacent columns hold the decision checkboxes for
# each review table this dashboard mirrors (sync.py). Column letters must
# match LEAD_RECONCILIATION_REVIEW_HEADERS_ / CRM_ORGANIZATION_REVIEW_HEADERS_
# in Phase13_LeadReconciliation.gs / Phase15_CrmOrganizationReview.gs exactly
# — if either header list changes column order, update this too.
DECISION_RANGES = {
    "crm_organization_review": {
        "sheet_name": "CRM Organization Review",
        "start_col": "F",  # Approve
        "end_col": "G",  # Reject
    },
    "lead_reconciliation": {
        "sheet_name": "Lead Reconciliation - All",
        "start_col": "I",  # Real Lead — add to CRM
        "end_col": "J",  # Not a real lead
    },
}


def sheets_write_client():
    creds = service_account.Credentials.from_service_account_file(
        SERVICE_ACCOUNT_FILE, scopes=WRITE_SCOPES
    )
    return build("sheets", "v4", credentials=creds)


def write_decision(table, sheet_row, approve, service=None):
    """Ticks exactly one of the two decision checkboxes on one row and clears
    the other, on the sheet `table` maps to. `approve=True` ticks the first
    column (Approve / Real Lead — add to CRM); `approve=False` ticks the
    second (Reject / Not a real lead). Real booleans are sent (not the
    strings "TRUE"/"FALSE") so the cells render as ticked/unticked checkboxes
    exactly like a human clicking them in the Sheet, not literal text.

    `service` is injectable for tests; production callers never pass it.
    Raises on any API failure (auth, permission, network) rather than
    swallowing it — app.py surfaces that to the person clicking the button
    instead of pretending the write succeeded when it didn't.
    """
    _write_checkboxes(table, sheet_row, [approve, not approve], service=service)


def clear_decision(table, sheet_row, service=None):
    """Undoes a decision: unticks BOTH checkboxes on one row, putting it back
    to "undecided" so it reappears in /review's queue. Used by /review/undo
    and /review/undo_all (app.py) — see review_decisions_log's own comment
    in sync.py for why an undo needs its own audit trail rather than just
    re-deriving "undecided" from the sheet."""
    _write_checkboxes(table, sheet_row, [False, False], service=service)


def _write_checkboxes(table, sheet_row, values, service=None):
    if table not in DECISION_RANGES:
        raise ValueError(f"Unknown review table {table!r} — not in DECISION_RANGES.")
    spec = DECISION_RANGES[table]
    client = service or sheets_write_client()
    range_ = f"'{spec['sheet_name']}'!{spec['start_col']}{sheet_row}:{spec['end_col']}{sheet_row}"
    client.spreadsheets().values().update(
        spreadsheetId=SHEET_ID,
        range=range_,
        valueInputOption="RAW",
        body={"values": [values]},
    ).execute()
