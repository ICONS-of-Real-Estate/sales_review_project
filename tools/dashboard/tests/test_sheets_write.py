"""
Unit tests for sheets_write.py — the one module that writes anything back to
the spreadsheet (Tomás's Approve/Reject decisions from /review). No real
Sheets API needed: write_decision() takes an injectable `service` so these
never touch the network or a real credential file.
"""
from unittest.mock import MagicMock

import pytest

import sheets_write


def _mock_service():
    service = MagicMock()
    return service


class TestWriteDecision:
    def test_approve_writes_true_false_to_the_right_range(self):
        service = _mock_service()
        sheets_write.write_decision("crm_organization_review", 5, True, service=service)
        call = service.spreadsheets.return_value.values.return_value.update
        _, kwargs = call.call_args
        assert kwargs["range"] == "'CRM Organization Review'!F5:G5"
        assert kwargs["body"] == {"values": [[True, False]]}
        call.return_value.execute.assert_called_once()

    def test_reject_writes_false_true(self):
        service = _mock_service()
        sheets_write.write_decision("crm_organization_review", 12, False, service=service)
        call = service.spreadsheets.return_value.values.return_value.update
        _, kwargs = call.call_args
        assert kwargs["body"] == {"values": [[False, True]]}

    def test_lead_reconciliation_uses_its_own_sheet_and_columns(self):
        """Different sheet, different decision columns (I:J, not F:G) —
        confirms DECISION_RANGES is actually consulted per-table, not
        hardcoded to the CRM Organization Review shape."""
        service = _mock_service()
        sheets_write.write_decision("lead_reconciliation", 40, True, service=service)
        call = service.spreadsheets.return_value.values.return_value.update
        _, kwargs = call.call_args
        assert kwargs["range"] == "'Lead Reconciliation - All'!I40:J40"

    def test_unknown_table_raises_rather_than_writing_somewhere_wrong(self):
        service = _mock_service()
        with pytest.raises(ValueError):
            sheets_write.write_decision("some_typo", 1, True, service=service)
        service.spreadsheets.return_value.values.return_value.update.assert_not_called()

    def test_api_failure_propagates_rather_than_being_swallowed(self):
        """A caller (app.py's /review/decide) needs to know a write failed —
        e.g. the service account only has Viewer, not Editor, on the sheet —
        rather than being told the decision saved when it didn't."""
        service = _mock_service()
        service.spreadsheets.return_value.values.return_value.update.return_value.execute.side_effect = (
            Exception("403 The caller does not have permission")
        )
        with pytest.raises(Exception, match="403"):
            sheets_write.write_decision("crm_organization_review", 5, True, service=service)
