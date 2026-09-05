"""
Unit tests for sync.py's fetch_tab row filtering — no real Sheets API needed,
just a mocked service object shaped like the real client's chained calls.

Real incident live (25/08/2026): the live "Sales Call Log" sheet had a
~995-row gap of genuinely empty rows above the real data, and fetch_tab
pulled every one of them in as a "(unnamed)" ghost call on the dashboard,
since only the identifying first column (Prospect Name / Rep) was ever
reliably blank on those rows — other columns like "Outcome Logged" write an
actual FALSE into every row in their validated range regardless of whether
the row has any real data.
"""
from unittest.mock import MagicMock

import httplib2
from googleapiclient.errors import HttpError

import sync


def _mock_service(values):
    """values: the raw 2D array Sheets API would return (header row + data rows)."""
    service = MagicMock()
    service.spreadsheets.return_value.values.return_value.get.return_value.execute.return_value = {
        "values": values
    }
    return service


class TestFetchTab:
    def test_skips_rows_with_blank_first_column(self):
        service = _mock_service([
            ["Prospect Name", "Rep"],
            ["Real Prospect", "Sean"],
            ["", "FALSE"],  # the shape of the ~995-row gap: blank name, but not every cell blank
            ["", ""],
        ])
        rows = sync.fetch_tab(service, "Sales Call Log")
        assert len(rows) == 1
        assert rows[0]["Prospect Name"] == "Real Prospect"

    def test_keeps_short_rows_padded_with_blanks(self):
        service = _mock_service([
            ["Prospect Name", "Rep", "Source"],
            ["Real Prospect", "Sean"],  # short row — Sheets omits trailing blank cells
        ])
        rows = sync.fetch_tab(service, "Sales Call Log")
        assert len(rows) == 1
        assert rows[0]["Source"] == ""

    def test_no_data_rows_returns_empty_list(self):
        service = _mock_service([["Prospect Name", "Rep"]])
        assert sync.fetch_tab(service, "Sales Call Log") == []

    def test_tab_that_does_not_exist_yet_returns_empty_list_not_none(self):
        """Real bug (C-09/S1) fixed here: a tab that genuinely doesn't exist yet
        (e.g. Training Assignments before Phase 6 has ever run) is a legitimate
        "no data" state, distinguishable from a transient fetch failure by the
        Sheets API's own "Unable to parse range" HttpError 400 — this is the
        actual live shape of the Training Assignments HttpError 400 incident
        (26/08/2026), which was the tab simply not existing yet."""
        service = MagicMock()
        resp = httplib2.Response({"status": 400})
        error = HttpError(resp, b'{"error": {"message": "Unable to parse range: Nonexistent Tab"}}')
        service.spreadsheets.return_value.values.return_value.get.return_value.execute.side_effect = error
        assert sync.fetch_tab(service, "Nonexistent Tab") == []

    def test_transient_fetch_failure_returns_none_not_empty_list(self):
        """Real bug (C-09/S1): a genuine fetch failure (network blip, expired
        credentials, rate limit — anything that ISN'T "tab doesn't exist") used
        to come back as [], and main()/replace_table() would then DELETE the
        existing table and reinsert zero rows — silently wiping the live
        mirror on a single flaky sync cycle. It must come back as None instead,
        so the caller knows to leave that table's existing data alone."""
        service = MagicMock()
        service.spreadsheets.return_value.values.return_value.get.return_value.execute.side_effect = Exception("connection reset")
        assert sync.fetch_tab(service, "Sales Call Log") is None

    def test_blank_row_skip_count_is_logged(self, capsys):
        service = _mock_service([
            ["Prospect Name", "Rep"],
            ["Real Prospect", "Sean"],
            ["", "FALSE"],
            ["", ""],
        ])
        sync.fetch_tab(service, "Sales Call Log")
        assert "skipped 2 row(s)" in capsys.readouterr().err


class TestReplaceTable:
    def test_conversion_failure_is_logged_not_silent(self, conn, capsys):
        """Real bug (S5/S6): a manually-typed non-numeric value in an int/float
        column (e.g. "N/A" in Call Quality Score) silently became a NULL with
        no diagnostic trail at all."""
        rows = [{"Prospect Name": "Bad Row", "Call Quality Score": "N/A"}]
        sync.replace_table(
            conn, "sales_call_log",
            {"Prospect Name": "prospect_name", "Call Quality Score": "call_quality_score"},
            rows,
        )
        conn.commit()
        stored = conn.execute("SELECT call_quality_score FROM sales_call_log").fetchone()[0]
        assert stored is None
        assert "call_quality_score='N/A'" in capsys.readouterr().err

    def test_blank_value_in_numeric_column_is_not_logged_as_a_conversion_failure(self, conn, capsys):
        """A genuinely blank cell converting to NULL is expected/routine, not
        a data-quality problem worth a warning — only a non-blank value that
        fails to parse should be flagged."""
        rows = [{"Prospect Name": "Blank Row", "Call Quality Score": ""}]
        sync.replace_table(
            conn, "sales_call_log",
            {"Prospect Name": "prospect_name", "Call Quality Score": "call_quality_score"},
            rows,
        )
        assert "WARNING" not in capsys.readouterr().err

    def test_does_not_commit_itself(self, db_path, conn):
        """Real bug (S7): replace_table used to commit after every table,
        so a crash partway through main()'s sync cycle left some tables
        refreshed and others stale — main() now does one commit for the
        whole cycle, which only works if replace_table itself never commits."""
        sync.replace_table(
            conn, "sales_call_log",
            {"Prospect Name": "prospect_name"},
            [{"Prospect Name": "Uncommitted Row"}],
        )
        # A second, independent connection to the same file must see nothing
        # yet — proof the write is still pending in conn's own transaction.
        import sqlite3
        other = sqlite3.connect(str(db_path))
        count = other.execute("SELECT COUNT(*) FROM sales_call_log").fetchone()[0]
        other.close()
        assert count == 0
        conn.rollback()


class TestSheetRowStamping:
    """06/09/2026: /review (app.py) needs to write Tomás's decision back to
    the exact spreadsheet row it came from — fetch_tab stamps each row with
    its real 1-indexed sheet row under "__sheet_row__" so that's never
    re-derived or guessed downstream."""

    def test_stamps_the_real_sheet_row_number_accounting_for_the_header(self):
        service = _mock_service([
            ["Timestamp", "Category", "Finding"],
            ["9/6/2026", "Pipeline health", "First finding"],
            ["9/6/2026", "Unrecognized assignee", "Second finding"],
        ])
        rows = sync.fetch_tab(service, "CRM Organization Review")
        assert rows[0]["__sheet_row__"] == 2
        assert rows[1]["__sheet_row__"] == 3

    def test_skipped_blank_rows_do_not_shift_sheet_row_numbering(self):
        """A skipped (blank first-column) row must not renumber the real
        rows around it — sheet_row has to match the actual spreadsheet row,
        not a position in the filtered output."""
        service = _mock_service([
            ["Timestamp", "Name"],
            ["9/6/2026", "Real Lead One"],
            ["", ""],
            ["9/6/2026", "Real Lead Two"],
        ])
        rows = sync.fetch_tab(service, "Lead Reconciliation - All")
        assert rows[0]["__sheet_row__"] == 2
        assert rows[1]["__sheet_row__"] == 4


class TestReviewTablesSchema:
    """crm_organization_review / lead_reconciliation are new mirrored tables
    (06/09/2026) backing /review — sheet_row is their primary key so
    replace_table's full-refresh (DELETE + reinsert every cycle) still works
    the same way every other synced table already does."""

    def test_crm_organization_review_round_trips_through_replace_table(self, conn):
        rows = [{
            "Timestamp": "9/6/2026", "Category": "Pipeline health", "Finding": "Test finding",
            "Evidence": "Test evidence", "Suggested Action": "Test action",
            "Approve": "FALSE", "Reject": "FALSE", "__sheet_row__": 2,
        }]
        sync.replace_table(conn, "crm_organization_review", sync.CRM_ORGANIZATION_REVIEW_COLUMNS, rows)
        conn.commit()
        stored = conn.execute(
            "SELECT sheet_row, finding, approve, reject FROM crm_organization_review"
        ).fetchone()
        assert stored == (2, "Test finding", 0, 0)

    def test_lead_reconciliation_round_trips_through_replace_table(self, conn):
        rows = [{
            "Timestamp": "9/6/2026", "Name": "Test Lead", "Email": "test@example.com",
            "Status": "not_found", "Sources": "Sales Call Log:5", "Likely Noise": "FALSE",
            "Noise Reason": "", "Ambiguous GHL Matches": "", "Real Lead — add to CRM": "TRUE",
            "Not a real lead": "FALSE", "Dedupe Key": "email:test@example.com", "__sheet_row__": 7,
        }]
        sync.replace_table(conn, "lead_reconciliation", sync.LEAD_RECONCILIATION_COLUMNS, rows)
        conn.commit()
        stored = conn.execute(
            "SELECT sheet_row, name, real_lead, not_real_lead FROM lead_reconciliation"
        ).fetchone()
        assert stored == (7, "Test Lead", 1, 0)
