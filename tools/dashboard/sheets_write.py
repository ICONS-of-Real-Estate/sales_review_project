#!/usr/bin/env python3
"""
The one place this dashboard writes anything back to Google Sheets.

Everything else in tools/dashboard/ (sync.py, app.py) is deliberately
read-only, per DASHBOARD_RESEARCH_REPORT.md — the dashboard mirrors the
sheet, it never talks to Apps Script or edits the sheet itself. /review
(app.py) is the one exception: it lets Tomás tick the same Approve/Reject/
Needs More Info (or "Real Lead"/"Not a real lead"/"Needs More Info")
checkboxes from the dashboard that he could otherwise only tick by opening
the spreadsheet directly — Kris's ask (06/09/2026): "make it easy for
him," a big green/red button instead of hunting through hundreds of rows,
later extended with a third "Don't know" button ("Add another button...so
that if he doesn't understand he can just hit that. Then afterwards, you
can do an analysis and give him more information"). This module is what
actually flips those checkboxes; nothing else in this codebase writes to
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
can write to the sheet" stays limited to these decision columns only.
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

DECISIONS = ("approve", "reject", "unsure")

# Which sheet + which column holds each of the three decision checkboxes,
# for each review table this dashboard mirrors (sync.py). "Needs More Info"
# was appended at the END of both sheets (06/09/2026), after the existing
# Dedupe Key column — deliberately non-adjacent to Approve/Reject, so these
# three columns can't be written with one contiguous range the way the
# original two-column version could; see the two column letters skipped
# below (Dedupe Key sits between Reject/Not-a-real-lead and Needs More Info
# on both sheets). Column letters must match
# LEAD_RECONCILIATION_REVIEW_HEADERS_ / CRM_ORGANIZATION_REVIEW_HEADERS_ in
# Phase13_LeadReconciliation.gs / Phase15_CrmOrganizationReview.gs exactly —
# if either header list changes column order, update this too.
DECISION_RANGES = {
    "crm_organization_review": {
        "sheet_name": "CRM Organization Review",
        "columns": {"approve": "F", "reject": "G", "unsure": "I"},  # H is Dedupe Key
    },
    "lead_reconciliation": {
        "sheet_name": "Lead Reconciliation - All",
        "columns": {"approve": "I", "reject": "J", "unsure": "L"},  # K is Dedupe Key
    },
}


def sheets_write_client():
    creds = service_account.Credentials.from_service_account_file(
        SERVICE_ACCOUNT_FILE, scopes=WRITE_SCOPES
    )
    return build("sheets", "v4", credentials=creds)


def write_decision(table, sheet_row, decision, service=None):
    """Ticks exactly one of the three decision checkboxes on one row and
    clears the other two, on the sheet `table` maps to. `decision` is one of
    "approve", "reject", or "unsure" ("unsure" = the "Needs More Info"/
    "Don't know" button). Real booleans are sent (not the strings "TRUE"/
    "FALSE") so the cells render as ticked/unticked checkboxes exactly like
    a human clicking them in the Sheet, not literal text.

    Uses one batchUpdate call rather than three separate requests, since the
    three columns aren't adjacent (Dedupe Key sits between Reject/Not-a-
    real-lead and Needs More Info on both sheets) — still a single API call
    either way.

    `service` is injectable for tests; production callers never pass it.
    Raises on any API failure (auth, permission, network) rather than
    swallowing it — app.py surfaces that to the person clicking the button
    instead of pretending the write succeeded when it didn't.
    """
    if decision not in DECISIONS:
        raise ValueError(f"Unknown decision {decision!r} — must be one of {DECISIONS}.")
    _write_checkboxes(table, sheet_row, {key: key == decision for key in DECISIONS}, service=service)


def clear_decision(table, sheet_row, service=None):
    """Undoes a decision: unticks all three checkboxes on one row, putting it
    back to "undecided" so it reappears in /review's queue. Used by
    /review/undo and /review/undo_all (app.py) — see review_decisions_log's
    own comment in sync.py for why an undo needs its own audit trail rather
    than just re-deriving "undecided" from the sheet."""
    _write_checkboxes(table, sheet_row, {key: False for key in DECISIONS}, service=service)


def _write_checkboxes(table, sheet_row, values_by_decision, service=None):
    if table not in DECISION_RANGES:
        raise ValueError(f"Unknown review table {table!r} — not in DECISION_RANGES.")
    spec = DECISION_RANGES[table]
    client = service or sheets_write_client()
    data = [
        {
            "range": f"'{spec['sheet_name']}'!{col}{sheet_row}",
            "values": [[values_by_decision[key]]],
        }
        for key, col in spec["columns"].items()
    ]
    client.spreadsheets().values().batchUpdate(
        spreadsheetId=SHEET_ID,
        body={"valueInputOption": "RAW", "data": data},
    ).execute()
