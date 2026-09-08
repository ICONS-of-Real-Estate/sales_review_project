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


def _mock_service_with_serials(formatted_values, serial_values):
    """A service mock whose .get() responds differently depending on
    whether valueRenderOption=UNFORMATTED_VALUE was requested — the shape
    fetch_tab's date_columns handling actually depends on: one call for the
    normal FORMATTED_VALUE pull, a second for the unambiguous serial-number
    one."""
    service = MagicMock()

    def get(spreadsheetId, range, **kwargs):
        execute_mock = MagicMock()
        if kwargs.get("valueRenderOption") == "UNFORMATTED_VALUE":
            execute_mock.execute.return_value = {"values": serial_values}
        else:
            execute_mock.execute.return_value = {"values": formatted_values}
        return execute_mock

    service.spreadsheets.return_value.values.return_value.get.side_effect = get
    return service


class TestFetchTabDateColumns:
    """Real bug found live 09/09/2026 — Kris, looking at Bens' dashboard
    page: "The dates are wrong. It's only September." FORMATTED_VALUE
    returns whatever string Sheets displays a date cell as, which follows
    the live spreadsheet's own locale — not this project's documented
    DD/MM/YYYY convention (brief.txt §2, parse_call_date in app.py). A real
    12 August 2026 call, displayed by a US-locale spreadsheet as "8/12/2026",
    gets read by parse_call_date's DD/MM-first guess as 8 December — a
    fabricated FUTURE date. sheets_serial_to_iso_date + fetch_tab's
    date_columns param sidestep the locale guess entirely by asking the
    Sheets API for the cell's raw serial number instead."""

    def test_sheets_serial_to_iso_date_matches_the_real_epoch(self):
        # 12 August 2026 = 46246 days after the Sheets/Excel epoch (30 Dec 1899).
        assert sync.sheets_serial_to_iso_date(46246) == "2026-08-12"

    def test_sheets_serial_to_iso_date_returns_none_for_non_numeric_cells(self):
        # A blank cell, or genuine free text — never fabricate a date.
        assert sync.sheets_serial_to_iso_date("") is None
        assert sync.sheets_serial_to_iso_date("TBD") is None

    def test_date_column_is_overwritten_with_the_unambiguous_iso_value(self):
        # The FORMATTED_VALUE response is deliberately the locale-ambiguous,
        # WRONG-looking string a US-locale spreadsheet would hand back for
        # 12 August 2026 — reading it DD/MM-first (the code's old-and-only
        # behavior) would misparse this as 8 December.
        formatted = [
            ["Prospect Name", "Call Date", "Rep"],
            ["Chad Davis", "8/12/2026", "Bens"],
        ]
        serials = [
            ["Prospect Name", "Call Date", "Rep"],
            ["Chad Davis", 46246, "Bens"],
        ]
        service = _mock_service_with_serials(formatted, serials)
        rows = sync.fetch_tab(service, "Sales Call Log", date_columns=("Call Date",))
        assert rows[0]["Call Date"] == "2026-08-12"

    def test_no_date_columns_requested_skips_the_second_fetch_entirely(self):
        """Tabs with no real Date-typed column (date_columns=(), the default)
        must not pay for a fetch they can't use — asserted by making the
        UNFORMATTED_VALUE branch return something that would fail the
        assertion below if it were ever actually used."""
        formatted = [["Prospect Name", "Call Date"], ["Chad Davis", "8/12/2026"]]
        serials = [["Prospect Name", "Call Date"], ["Chad Davis", "WRONG-IF-USED"]]
        service = _mock_service_with_serials(formatted, serials)
        rows = sync.fetch_tab(service, "Sales Call Log")
        assert rows[0]["Call Date"] == "8/12/2026"

    def test_a_row_added_between_the_two_fetches_falls_back_to_the_formatted_string_not_a_crash(self):
        """serial_rows can legitimately be shorter than rows — real Sheets
        API behavior when the two calls don't see byte-identical state, not
        something that should ever raise."""
        formatted = [
            ["Prospect Name", "Call Date"],
            ["Chad Davis", "8/12/2026"],
            ["New Row Mid-Sync", "9/1/2026"],
        ]
        serials = [["Prospect Name", "Call Date"], ["Chad Davis", 46246]]
        service = _mock_service_with_serials(formatted, serials)
        rows = sync.fetch_tab(service, "Sales Call Log", date_columns=("Call Date",))
        assert rows[0]["Call Date"] == "2026-08-12"
        assert rows[1]["Call Date"] == "9/1/2026"  # fallback — no serial available for this row


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


class TestNullableBooleanColumns:
    """flag_booking_decision_appropriate (07/09/2026, rep roster stats) is
    only scored on 'shared'/'sean' rubric variants — a blank cell means "not
    scored on this call," not a false verdict. Regular BOOLEAN_COLUMNS
    coerce blank to False via to_bool(), which would corrupt any rate
    computed from this column by silently counting "never scored" rows as
    "scored inappropriate" — same "no signal != false" bug class
    Phase5_WeeklyScorecard.gs's isExplicitlyFalse_ exists to avoid."""

    def test_blank_cell_stores_null_not_false(self, conn):
        rows = [{"Prospect Name": "QC Call", "Flag: Booking Decision Appropriate": ""}]
        sync.replace_table(
            conn, "sales_call_log",
            {"Prospect Name": "prospect_name", "Flag: Booking Decision Appropriate": "flag_booking_decision_appropriate"},
            rows,
        )
        conn.commit()
        stored = conn.execute("SELECT flag_booking_decision_appropriate FROM sales_call_log").fetchone()[0]
        assert stored is None

    def test_true_and_false_cells_still_store_as_1_and_0(self, conn):
        rows = [
            {"Prospect Name": "Good Call", "Flag: Booking Decision Appropriate": "TRUE"},
            {"Prospect Name": "Bad Call", "Flag: Booking Decision Appropriate": "FALSE"},
        ]
        sync.replace_table(
            conn, "sales_call_log",
            {"Prospect Name": "prospect_name", "Flag: Booking Decision Appropriate": "flag_booking_decision_appropriate"},
            rows,
        )
        conn.commit()
        stored = conn.execute(
            "SELECT prospect_name, flag_booking_decision_appropriate FROM sales_call_log ORDER BY prospect_name"
        ).fetchall()
        assert stored == [("Bad Call", 0), ("Good Call", 1)]


class TestBensPodcastTrackerSchema:
    """Bens doesn't take Sales Calls (CLAUDE.md) — his real conversion metric
    (QC booking rate off his podcast recordings) lives in his own "Icons
    Podcast Recordings" tab, not the Sales Call Log, so it gets its own
    mirrored table (07/09/2026, per Kris's ask: "Bens booking QCs")."""

    def test_round_trips_through_replace_table(self, conn):
        rows = [{
            "Name": "Earl Fields", "Email": "easyf68@aol.com", "Source": "No Show QC",
            "Booked": "Bens", "Booking Date": "May 13", "Recording Date": "May 20",
            "Recording Done": "TRUE", "QC Booked": "TRUE", "QC Date": "",
            "QC Show Up": "FALSE", "SC Booked": "FALSE", "SC Date": "", "SC Show Up": "FALSE",
            "Sale": "FALSE",
        }]
        sync.replace_table(conn, "bens_podcast_tracker", sync.BENS_PODCAST_TRACKER_COLUMNS, rows)
        conn.commit()
        stored = conn.execute(
            "SELECT name, recording_done, qc_booked, qc_show_up FROM bens_podcast_tracker"
        ).fetchone()
        assert stored == ("Earl Fields", 1, 1, 0)
