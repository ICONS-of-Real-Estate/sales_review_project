"""
Unit tests for sheets_write.py — the one module that writes anything back to
the spreadsheet (Tomás's Approve/Reject/Needs-More-Info decisions from
/review). No real Sheets API needed: write_decision() takes an injectable
`service` so these never touch the network or a real credential file.
"""
from unittest.mock import MagicMock

import pytest

import sheets_write


def _mock_service():
    service = MagicMock()
    return service


def _batch_calls(service):
    """Returns the list of {range, values} dicts passed to batchUpdate's
    body["data"] on the (single) call made."""
    call = service.spreadsheets.return_value.values.return_value.batchUpdate
    _, kwargs = call.call_args
    return kwargs["body"]["data"], call


class TestWriteDecision:
    def test_approve_ticks_only_the_approve_column(self):
        service = _mock_service()
        sheets_write.write_decision("crm_organization_review", 5, "approve", service=service)
        data, call = _batch_calls(service)
        by_range = {d["range"]: d["values"][0][0] for d in data}
        assert by_range["'CRM Organization Review'!F5"] is True
        assert by_range["'CRM Organization Review'!G5"] is False
        assert by_range["'CRM Organization Review'!I5"] is False
        call.return_value.execute.assert_called_once()

    def test_reject_ticks_only_the_reject_column(self):
        service = _mock_service()
        sheets_write.write_decision("crm_organization_review", 12, "reject", service=service)
        data, _ = _batch_calls(service)
        by_range = {d["range"]: d["values"][0][0] for d in data}
        assert by_range["'CRM Organization Review'!F12"] is False
        assert by_range["'CRM Organization Review'!G12"] is True
        assert by_range["'CRM Organization Review'!I12"] is False

    def test_unsure_ticks_only_the_needs_more_info_column(self):
        """Kris, 06/09/2026: "Add another button. Don't know...so that if
        he doesn't understand he can just hit that." — the third decision,
        written to column I (non-adjacent to F:G — Dedupe Key sits at H)."""
        service = _mock_service()
        sheets_write.write_decision("crm_organization_review", 7, "unsure", service=service)
        data, _ = _batch_calls(service)
        by_range = {d["range"]: d["values"][0][0] for d in data}
        assert by_range["'CRM Organization Review'!F7"] is False
        assert by_range["'CRM Organization Review'!G7"] is False
        assert by_range["'CRM Organization Review'!I7"] is True

    def test_lead_reconciliation_uses_its_own_sheet_and_columns(self):
        """Different sheet, different decision columns (I/J/L, not F/G/I) —
        confirms DECISION_RANGES is actually consulted per-table, not
        hardcoded to the CRM Organization Review shape."""
        service = _mock_service()
        sheets_write.write_decision("lead_reconciliation", 40, "approve", service=service)
        data, _ = _batch_calls(service)
        by_range = {d["range"]: d["values"][0][0] for d in data}
        assert by_range["'Lead Reconciliation - All'!I40"] is True
        assert by_range["'Lead Reconciliation - All'!J40"] is False
        assert by_range["'Lead Reconciliation - All'!L40"] is False

    def test_unknown_decision_raises_rather_than_writing_somewhere_wrong(self):
        service = _mock_service()
        with pytest.raises(ValueError):
            sheets_write.write_decision("crm_organization_review", 1, "maybe", service=service)
        service.spreadsheets.return_value.values.return_value.batchUpdate.assert_not_called()

    def test_unknown_table_raises_rather_than_writing_somewhere_wrong(self):
        service = _mock_service()
        with pytest.raises(ValueError):
            sheets_write.write_decision("some_typo", 1, "approve", service=service)
        service.spreadsheets.return_value.values.return_value.batchUpdate.assert_not_called()

    def test_api_failure_propagates_rather_than_being_swallowed(self):
        """A caller (app.py's /review/decide) needs to know a write failed —
        e.g. the service account only has Viewer, not Editor, on the sheet —
        rather than being told the decision saved when it didn't."""
        service = _mock_service()
        service.spreadsheets.return_value.values.return_value.batchUpdate.return_value.execute.side_effect = (
            Exception("403 The caller does not have permission")
        )
        with pytest.raises(Exception, match="403"):
            sheets_write.write_decision("crm_organization_review", 5, "approve", service=service)


class TestClearDecision:
    def test_clears_all_three_columns(self):
        service = _mock_service()
        sheets_write.clear_decision("crm_organization_review", 5, service=service)
        data, call = _batch_calls(service)
        by_range = {d["range"]: d["values"][0][0] for d in data}
        assert by_range["'CRM Organization Review'!F5"] is False
        assert by_range["'CRM Organization Review'!G5"] is False
        assert by_range["'CRM Organization Review'!I5"] is False
        call.return_value.execute.assert_called_once()


class TestWriteTrainingPriorityOverride:
    """Kris's ask (07/09/2026): Tomás can override the auto-computed weekly
    training focus for one rep from the dashboard. Append-only — Phase1_
    ComplianceCheck.gs's findTrainingPriorityOverride_ reads the LAST row
    matching (rep, week_start), so a new override just needs to be appended
    after any older one for the same week to win."""

    def _service_with_existing_sheet(self):
        service = _mock_service()
        service.spreadsheets.return_value.get.return_value.execute.return_value = {
            "sheets": [{"properties": {"title": "Training Priority Overrides"}}]
        }
        return service

    def test_appends_a_row_with_rep_week_priority_and_who_set_it(self):
        service = self._service_with_existing_sheet()
        sheets_write.write_training_priority_override("Sean", "07/09/2026", "Discovery", "tomas@iconsofrealestate.com", service=service)
        append_call = service.spreadsheets.return_value.values.return_value.append
        _, kwargs = append_call.call_args
        assert kwargs["range"] == "'Training Priority Overrides'!A:E"
        row = kwargs["body"]["values"][0]
        assert row[0] == "Sean"
        assert row[1] == "07/09/2026"
        assert row[2] == "Discovery"
        assert row[3] == "tomas@iconsofrealestate.com"
        append_call.return_value.execute.assert_called_once()

    def test_creates_the_sheet_and_header_row_if_it_does_not_exist_yet(self):
        """Tomás using the dashboard must not depend on Apps Script's Tuesday
        job having run at least once first."""
        service = _mock_service()
        service.spreadsheets.return_value.get.return_value.execute.return_value = {"sheets": []}
        sheets_write.write_training_priority_override("Sean", "07/09/2026", "Discovery", "tomas@iconsofrealestate.com", service=service)
        add_sheet_call = service.spreadsheets.return_value.batchUpdate
        _, kwargs = add_sheet_call.call_args
        assert kwargs["body"]["requests"][0]["addSheet"]["properties"]["title"] == "Training Priority Overrides"
        header_call = service.spreadsheets.return_value.values.return_value.update
        _, header_kwargs = header_call.call_args
        assert header_kwargs["body"]["values"][0] == sheets_write.TRAINING_PRIORITY_OVERRIDES_HEADERS

    def test_does_not_recreate_the_sheet_if_it_already_exists(self):
        service = self._service_with_existing_sheet()
        sheets_write.write_training_priority_override("Sean", "07/09/2026", "Discovery", "tomas@iconsofrealestate.com", service=service)
        service.spreadsheets.return_value.batchUpdate.assert_not_called()

    def test_blank_priority_raises_rather_than_writing_an_empty_override(self):
        service = self._service_with_existing_sheet()
        with pytest.raises(ValueError):
            sheets_write.write_training_priority_override("Sean", "07/09/2026", "   ", "tomas@iconsofrealestate.com", service=service)
        service.spreadsheets.return_value.values.return_value.append.assert_not_called()

    def test_api_failure_propagates_rather_than_being_swallowed(self):
        service = self._service_with_existing_sheet()
        service.spreadsheets.return_value.values.return_value.append.return_value.execute.side_effect = (
            Exception("403 The caller does not have permission")
        )
        with pytest.raises(Exception, match="403"):
            sheets_write.write_training_priority_override("Sean", "07/09/2026", "Discovery", "tomas@iconsofrealestate.com", service=service)


class TestWriteReengagementOverride:
    """Kris's ask (07/09/2026): a rep can Cancel or Lower Priority one of
    their own stalled leads from /reps/{rep}/leads. Append-only — Phase17_
    SeanFollowUpAutomation.gs's getReengagementOverrideActions_ reads the
    LAST row per (rep, lead), so a later 'active' row un-cancels/
    un-deprioritizes without destroying history."""

    def _service_with_existing_sheet(self):
        service = _mock_service()
        service.spreadsheets.return_value.get.return_value.execute.return_value = {
            "sheets": [{"properties": {"title": "Re-engagement Overrides"}}]
        }
        return service

    def test_appends_a_row_with_rep_lead_action_and_who_set_it(self):
        service = self._service_with_existing_sheet()
        sheets_write.write_reengagement_override(
            "Bens", "lead@example.com", "Some Lead", "cancelled", "bens@iconsofrealestate.com", service=service
        )
        append_call = service.spreadsheets.return_value.values.return_value.append
        _, kwargs = append_call.call_args
        assert kwargs["range"] == "'Re-engagement Overrides'!A:F"
        row = kwargs["body"]["values"][0]
        assert row[:5] == ["Bens", "lead@example.com", "Some Lead", "cancelled", "bens@iconsofrealestate.com"]
        append_call.return_value.execute.assert_called_once()

    def test_creates_the_sheet_and_header_row_if_it_does_not_exist_yet(self):
        service = _mock_service()
        service.spreadsheets.return_value.get.return_value.execute.return_value = {"sheets": []}
        sheets_write.write_reengagement_override(
            "Bens", "lead@example.com", "Some Lead", "cancelled", "bens@iconsofrealestate.com", service=service
        )
        add_sheet_call = service.spreadsheets.return_value.batchUpdate
        _, kwargs = add_sheet_call.call_args
        assert kwargs["body"]["requests"][0]["addSheet"]["properties"]["title"] == "Re-engagement Overrides"
        header_call = service.spreadsheets.return_value.values.return_value.update
        _, header_kwargs = header_call.call_args
        assert header_kwargs["body"]["values"][0] == sheets_write.REENGAGEMENT_OVERRIDES_HEADERS

    def test_does_not_recreate_the_sheet_if_it_already_exists(self):
        service = self._service_with_existing_sheet()
        sheets_write.write_reengagement_override(
            "Bens", "lead@example.com", "Some Lead", "cancelled", "bens@iconsofrealestate.com", service=service
        )
        service.spreadsheets.return_value.batchUpdate.assert_not_called()

    def test_unknown_action_raises_rather_than_writing_somewhere_wrong(self):
        service = self._service_with_existing_sheet()
        with pytest.raises(ValueError):
            sheets_write.write_reengagement_override(
                "Bens", "lead@example.com", "Some Lead", "nonsense", "bens@iconsofrealestate.com", service=service
            )
        service.spreadsheets.return_value.values.return_value.append.assert_not_called()

    def test_blank_rep_raises_rather_than_writing_an_orphaned_override(self):
        service = self._service_with_existing_sheet()
        with pytest.raises(ValueError):
            sheets_write.write_reengagement_override(
                "   ", "lead@example.com", "Some Lead", "cancelled", "bens@iconsofrealestate.com", service=service
            )
        service.spreadsheets.return_value.values.return_value.append.assert_not_called()

    def test_api_failure_propagates_rather_than_being_swallowed(self):
        service = self._service_with_existing_sheet()
        service.spreadsheets.return_value.values.return_value.append.return_value.execute.side_effect = (
            Exception("403 The caller does not have permission")
        )
        with pytest.raises(Exception, match="403"):
            sheets_write.write_reengagement_override(
                "Bens", "lead@example.com", "Some Lead", "cancelled", "bens@iconsofrealestate.com", service=service
            )
