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

    def test_missing_tab_returns_empty_list_not_raise(self):
        service = MagicMock()
        service.spreadsheets.return_value.values.return_value.get.return_value.execute.side_effect = Exception("not found")
        assert sync.fetch_tab(service, "Nonexistent Tab") == []
