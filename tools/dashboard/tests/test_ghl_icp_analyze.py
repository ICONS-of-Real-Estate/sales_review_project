"""
Tests for ghl_icp_analyze.py's pure logic -- the converted-only CSV split +
qualification/sales-call breakdown, run against an already-produced
ghl_icp_export.py CSV (12/09/2026, Kris's follow-up ask after the first
real export: 60 converted out of 65,222 contacts).
"""
import csv
import sys

import pytest

import ghl_icp_analyze as analyze


def _row(contact_id, converted, qual, sales, **overrides):
    row = {
        "contact_id": contact_id, "full_name": f"Contact {contact_id}", "email": f"{contact_id}@example.com",
        "phone": "5551234567", "first_call_date": "2026-01-01",
        "qualification_call_count": str(qual), "sales_call_count": str(sales),
        "total_call_count": str(qual + sales), "opportunity_count": "1",
        "pipeline_name": "Sales Pipeline", "pipeline_stage": "Closed Won" if converted else "Sales Call Taken",
        "converted": "True" if converted else "False",
        "close_date": "2026-02-01" if converted else "", "lost_date": "", "days_since_last_activity": "5",
    }
    row.update(overrides)
    return row


class TestIsConverted:
    def test_true_string_is_converted(self):
        assert analyze.is_converted_({"converted": "True"}) is True

    def test_false_string_is_not_converted(self):
        assert analyze.is_converted_({"converted": "False"}) is False

    def test_missing_or_blank_is_not_converted(self):
        assert analyze.is_converted_({}) is False
        assert analyze.is_converted_({"converted": ""}) is False


class TestFilterConvertedRows:
    def test_keeps_only_converted_rows(self):
        rows = [_row("c1", True, 1, 1), _row("c2", False, 1, 1), _row("c3", True, 0, 1)]
        result = analyze.filter_converted_rows_(rows)
        assert [r["contact_id"] for r in result] == ["c1", "c3"]

    def test_empty_input_returns_empty_list(self):
        assert analyze.filter_converted_rows_([]) == []


class TestCallCountBreakdown:
    def test_groups_by_qualification_and_sales_call_flag_pairs(self):
        rows = [
            _row("c1", True, 1, 1),
            _row("c2", True, 1, 1),
            _row("c3", True, 1, 0),
            _row("c4", True, 0, 1),
            _row("c5", True, 0, 0),
        ]
        breakdown = analyze.call_count_breakdown_(rows)
        assert breakdown == {(1, 1): 2, (1, 0): 1, (0, 1): 1, (0, 0): 1}

    def test_missing_or_malformed_count_reads_as_zero_not_a_crash(self):
        rows = [_row("c1", True, 1, 1, qualification_call_count="", sales_call_count="not a number")]
        breakdown = analyze.call_count_breakdown_(rows)
        assert breakdown == {(0, 0): 1}

    def test_empty_input_returns_empty_dict(self):
        assert analyze.call_count_breakdown_([]) == {}


class TestFormatBreakdown:
    def test_orders_most_common_combo_first_with_percentages(self):
        breakdown = {(1, 1): 3, (0, 1): 1}
        lines = analyze.format_breakdown_(breakdown, total=4)
        assert lines[0].startswith("  3 (75.0%)")
        assert "BOTH" in lines[0]
        assert lines[1].startswith("  1 (25.0%)")

    def test_zero_total_never_divides_by_zero(self):
        lines = analyze.format_breakdown_({}, total=0)
        assert lines == []


class TestMain:
    def test_writes_converted_only_csv_with_the_same_columns_as_the_input(self, tmp_path, capsys):
        in_path = tmp_path / "icp_export.csv"
        out_path = tmp_path / "icp_export_converted.csv"
        rows = [_row("c1", True, 1, 1), _row("c2", False, 1, 1), _row("c3", True, 0, 1)]
        with open(in_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)

        old_argv = sys.argv
        sys.argv = ["ghl_icp_analyze.py", "--in", str(in_path), "--converted-out", str(out_path)]
        try:
            analyze.main()
        finally:
            sys.argv = old_argv

        with open(out_path, newline="") as f:
            out_rows = list(csv.DictReader(f))
        assert [r["contact_id"] for r in out_rows] == ["c1", "c3"]

        printed = capsys.readouterr().out
        assert "2 converted row(s) written" in printed
        assert "out of 3 total" in printed

    def test_exits_with_an_error_on_a_completely_empty_input_csv(self, tmp_path):
        in_path = tmp_path / "empty.csv"
        in_path.write_text("")
        out_path = tmp_path / "out.csv"
        old_argv = sys.argv
        sys.argv = ["ghl_icp_analyze.py", "--in", str(in_path), "--converted-out", str(out_path)]
        try:
            with pytest.raises(SystemExit):
                analyze.main()
        finally:
            sys.argv = old_argv
