"""
Tests for ghl_icp_characterize.py's pure logic -- the final ICP report over
the GHL/Stripe joined CSV (12/09/2026), reporting real revenue distributions
rather than deciding the ICP itself.
"""
import csv
import sys

import pytest

import ghl_icp_characterize as characterize


def _row(contact_id, revenue, has_history=True, **overrides):
    row = {
        "contact_id": contact_id, "full_name": f"Contact {contact_id}", "email": f"{contact_id}@example.com",
        "converted": "True", "pipeline_name": "Sales Pipeline",
        "qualification_call_count": "0", "sales_call_count": "0",
        "first_call_date": "2026-01-01", "close_date": "2026-02-01",
        "has_stripe_history": "True" if has_history else "False",
        "total_net_revenue": str(revenue), "plan_labels": "",
    }
    row.update(overrides)
    return row


class TestParseHelpers:
    def test_parse_float_reads_malformed_as_default(self):
        assert characterize.parse_float_("not a number") == 0.0
        assert characterize.parse_float_("") == 0.0
        assert characterize.parse_float_("250.5") == 250.5

    def test_parse_int_reads_malformed_as_default(self):
        assert characterize.parse_int_("not a number") == 0
        assert characterize.parse_int_("3") == 3

    def test_parse_iso_date_reads_malformed_as_none(self):
        assert characterize.parse_iso_date_("not a date") is None
        assert characterize.parse_iso_date_("") is None
        assert characterize.parse_iso_date_("2026-01-08").isoformat() == "2026-01-08"


class TestPayingRows:
    def test_keeps_only_rows_with_real_positive_revenue(self):
        rows = [
            _row("c1", 100, has_history=True),
            _row("c2", 0, has_history=True),
            _row("c3", 100, has_history=False),
        ]
        result = characterize.paying_rows_(rows)
        assert [r["contact_id"] for r in result] == ["c1"]


class TestRevenueStats:
    def test_computes_count_total_mean_median_min_max(self):
        rows = [_row("c1", 100), _row("c2", 200), _row("c3", 300)]
        stats = characterize.revenue_stats_(rows)
        assert stats == {"count": 3, "total": 600.0, "mean": 200.0, "median": 200.0, "min": 100.0, "max": 300.0}

    def test_empty_input_gives_zeroed_stats_not_a_crash(self):
        stats = characterize.revenue_stats_([])
        assert stats == {"count": 0, "total": 0.0, "mean": 0.0, "median": 0.0, "min": 0.0, "max": 0.0}


class TestRevenueByField:
    def test_groups_and_sums_by_field_value(self):
        rows = [
            _row("c1", 100, pipeline_name="Sales Pipeline"),
            _row("c2", 200, pipeline_name="Sales Pipeline"),
            _row("c3", 50, pipeline_name="ICONS Podcast"),
        ]
        result = characterize.revenue_by_field_(rows, "pipeline_name")
        assert result == {
            "Sales Pipeline": {"count": 2, "total": 300.0, "mean": 150.0},
            "ICONS Podcast": {"count": 1, "total": 50.0, "mean": 50.0},
        }

    def test_blank_field_value_groups_under_blank_label(self):
        rows = [_row("c1", 100, pipeline_name="")]
        result = characterize.revenue_by_field_(rows, "pipeline_name")
        assert "(blank)" in result


class TestRevenueByCallCountBucket:
    def test_buckets_by_had_qualification_and_had_sales_call(self):
        rows = [
            _row("c1", 100, qualification_call_count="1", sales_call_count="1"),
            _row("c2", 200, qualification_call_count="1", sales_call_count="0"),
            _row("c3", 50, qualification_call_count="0", sales_call_count="0"),
        ]
        result = characterize.revenue_by_call_count_bucket_(rows)
        assert result[(True, True)] == {"count": 1, "total": 100.0, "mean": 100.0}
        assert result[(True, False)] == {"count": 1, "total": 200.0, "mean": 200.0}
        assert result[(False, False)] == {"count": 1, "total": 50.0, "mean": 50.0}

    def test_treats_any_positive_count_as_had_the_call_not_just_exactly_one(self):
        rows = [_row("c1", 100, qualification_call_count="3", sales_call_count="2")]
        result = characterize.revenue_by_call_count_bucket_(rows)
        assert (True, True) in result


class TestSalesCycleDays:
    def test_computes_days_between_first_call_and_close(self):
        rows = [_row("c1", 100, first_call_date="2026-01-01", close_date="2026-01-31")]
        assert characterize.sales_cycle_days_(rows) == [30]

    def test_drops_rows_with_missing_or_unparseable_dates(self):
        rows = [
            _row("c1", 100, first_call_date="", close_date="2026-01-31"),
            _row("c2", 100, first_call_date="2026-01-01", close_date=""),
            _row("c3", 100, first_call_date="not a date", close_date="2026-01-31"),
        ]
        assert characterize.sales_cycle_days_(rows) == []

    def test_drops_rows_where_close_is_before_first_call(self):
        # A real data inconsistency shouldn't produce a negative "sales cycle."
        rows = [_row("c1", 100, first_call_date="2026-02-01", close_date="2026-01-01")]
        assert characterize.sales_cycle_days_(rows) == []


class TestTopPlanLabelsByRevenue:
    def test_splits_semicolon_joined_labels_and_sums_full_row_revenue_per_label(self):
        rows = [
            _row("c1", 100, plan_labels="ICONIC; Podcast Production"),
            _row("c2", 200, plan_labels="ICONIC"),
        ]
        result = dict(characterize.top_plan_labels_by_revenue_(rows))
        assert result["ICONIC"] == {"count": 2, "total": 300.0}
        assert result["Podcast Production"] == {"count": 1, "total": 100.0}

    def test_respects_top_n_and_sorts_by_total_descending(self):
        rows = [_row("c1", 500, plan_labels="A"), _row("c2", 100, plan_labels="B"), _row("c3", 50, plan_labels="C")]
        result = characterize.top_plan_labels_by_revenue_(rows, top_n=2)
        assert [label for label, _ in result] == ["A", "B"]

    def test_blank_plan_labels_contribute_nothing(self):
        rows = [_row("c1", 100, plan_labels="")]
        assert characterize.top_plan_labels_by_revenue_(rows) == []


class TestMain:
    def test_prints_a_full_report_without_crashing(self, tmp_path, capsys):
        in_path = tmp_path / "joined.csv"
        rows = [_row("c1", 100), _row("c2", 200, qualification_call_count="1")]
        with open(in_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)

        old_argv = sys.argv
        sys.argv = ["ghl_icp_characterize.py", "--in", str(in_path)]
        try:
            characterize.main()
        finally:
            sys.argv = old_argv

        printed = capsys.readouterr().out
        assert "REVENUE" in printed
        assert "$300.00" in printed  # total across the two paying rows

    def test_exits_with_an_error_on_a_completely_empty_input_csv(self, tmp_path):
        in_path = tmp_path / "empty.csv"
        in_path.write_text("")
        old_argv = sys.argv
        sys.argv = ["ghl_icp_characterize.py", "--in", str(in_path)]
        try:
            with pytest.raises(SystemExit):
                characterize.main()
        finally:
            sys.argv = old_argv
