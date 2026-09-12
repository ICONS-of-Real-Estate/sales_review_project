"""
Tests for stripe_billing_summary.py's pure logic -- per-customer revenue
summary from a Stripe Payments CSV export, aggregated by email (12/09/2026,
the Stripe half of Kris's client-ICP join, against a real "Stripe Payments
ICONS filtered" export: 1,907 payment rows, 201 distinct Customer Email
values, real Amount values already in dollars not cents).
"""
import csv
import sys

import pytest

import stripe_billing_summary as summary


def _row(customer_id, email, amount, status, **overrides):
    row = {
        "id": "ch_1", "Created date (UTC)": "2026-07-24 15:21:32", "Amount": str(amount),
        "Amount Refunded": "", "Currency": "usd", "Status": status, "Description": "Subscription update",
        "Customer ID": customer_id, "Customer Description": "", "Customer Email": email,
    }
    row.update(overrides)
    return row


class TestNormalizeStripeEmail:
    def test_lowercases_and_strips(self):
        assert summary.normalize_stripe_email_("  Jane@Example.com ") == "jane@example.com"

    def test_none_or_missing_reads_as_empty_string(self):
        assert summary.normalize_stripe_email_(None) == ""
        assert summary.normalize_stripe_email_({}.get("email")) == ""


class TestNetRevenueForRow:
    def test_paid_row_with_no_refund_is_full_amount(self):
        row = _row("cus_1", "a@example.com", "250", "Paid")
        assert summary.net_revenue_for_row_(row) == 250.0

    def test_paid_row_with_partial_refund_nets_the_difference(self):
        # Real case sampled live: stella.topseller@gmail.com, Amount 2053.82,
        # Amount Refunded 1026.91, Status Paid.
        row = _row("cus_1", "a@example.com", "2053.82", "Paid", **{"Amount Refunded": "1026.91"})
        assert summary.net_revenue_for_row_(row) == pytest.approx(1026.91)

    def test_fully_refunded_status_nets_to_zero(self):
        row = _row("cus_1", "a@example.com", "87", "Refunded", **{"Amount Refunded": "87"})
        assert summary.net_revenue_for_row_(row) == 0.0

    def test_failed_status_contributes_zero_regardless_of_amount(self):
        row = _row("cus_1", "a@example.com", "997", "Failed")
        assert summary.net_revenue_for_row_(row) == 0.0

    def test_malformed_amount_reads_as_zero_not_a_crash(self):
        row = _row("cus_1", "a@example.com", "not a number", "Paid")
        assert summary.net_revenue_for_row_(row) == 0.0


class TestPlanLabelForRow:
    def test_structured_product_description_is_a_plan_label(self):
        row = _row("cus_1", "a@example.com", "100", "Paid", Description="Product: ICONIC (per month)")
        assert summary.plan_label_for_row_(row) == "Product: ICONIC (per month)"

    def test_generic_subscription_lifecycle_text_is_not_a_plan_label(self):
        for desc in ("Subscription update", "Subscription creation", "Payment for Invoice", ""):
            row = _row("cus_1", "a@example.com", "100", "Paid", Description=desc)
            assert summary.plan_label_for_row_(row) is None


class TestGroupStripeRowsByEmail:
    def test_groups_by_normalized_email(self):
        rows = [
            _row("cus_1", "Jane@Example.com", "100", "Paid"),
            _row("cus_1", "jane@example.com", "100", "Paid"),
            _row("cus_2", "other@example.com", "50", "Paid"),
        ]
        grouped = summary.group_stripe_rows_by_email_(rows)
        assert len(grouped["jane@example.com"]) == 2
        assert len(grouped["other@example.com"]) == 1

    def test_rows_with_no_email_are_dropped(self):
        rows = [_row("cus_1", "", "100", "Paid")]
        assert summary.group_stripe_rows_by_email_(rows) == {}


class TestSummarizeCustomerRows:
    def test_multiple_customer_ids_for_one_email_are_all_kept(self):
        # Real case sampled live: jesse@jessecarlson.com mapped to 4 distinct
        # Stripe Customer IDs (re-subscriptions) -- must not silently drop any.
        rows = [
            _row("cus_a", "a@example.com", "100", "Paid"),
            _row("cus_b", "a@example.com", "50", "Paid"),
        ]
        result = summary.summarize_customer_rows_(rows)
        assert result["stripe_customer_ids"] == "cus_a;cus_b"

    def test_total_net_revenue_sums_across_paid_and_refunded_rows(self):
        rows = [
            _row("cus_1", "a@example.com", "100", "Paid"),
            _row("cus_1", "a@example.com", "200", "Paid", **{"Amount Refunded": "50"}),
            _row("cus_1", "a@example.com", "997", "Failed"),
        ]
        result = summary.summarize_customer_rows_(rows)
        assert result["total_net_revenue"] == 250.0

    def test_payment_counts_split_by_status(self):
        rows = [
            _row("cus_1", "a@example.com", "100", "Paid"),
            _row("cus_1", "a@example.com", "100", "Paid"),
            _row("cus_1", "a@example.com", "50", "Refunded"),
            _row("cus_1", "a@example.com", "0", "Failed"),
            _row("cus_1", "a@example.com", "0", "canceled"),
        ]
        result = summary.summarize_customer_rows_(rows)
        assert result["completed_payment_count"] == 2
        assert result["refunded_payment_count"] == 1
        assert result["failed_payment_count"] == 2

    def test_first_and_last_payment_date_are_earliest_and_latest_paid_dates(self):
        rows = [
            _row("cus_1", "a@example.com", "100", "Paid", **{"Created date (UTC)": "2026-07-24 15:21:32"}),
            _row("cus_1", "a@example.com", "100", "Paid", **{"Created date (UTC)": "2026-01-01 00:00:00"}),
            # A Failed row's date must never count -- it never actually collected money.
            _row("cus_1", "a@example.com", "100", "Failed", **{"Created date (UTC)": "2025-01-01 00:00:00"}),
        ]
        result = summary.summarize_customer_rows_(rows)
        assert result["first_payment_date"] == "2026-01-01 00:00:00"
        assert result["last_payment_date"] == "2026-07-24 15:21:32"

    def test_plan_labels_deduped_and_ordered_by_first_occurrence(self):
        rows = [
            _row("cus_1", "a@example.com", "100", "Paid", Description="Product: ICONIC (per month)"),
            _row("cus_1", "a@example.com", "100", "Paid", Description="Subscription update"),
            _row("cus_1", "a@example.com", "100", "Paid", Description="Product: ICONIC (per month)"),
            _row("cus_1", "a@example.com", "100", "Paid", Description="Product: Basic of the Basic (per month)"),
        ]
        result = summary.summarize_customer_rows_(rows)
        assert result["plan_labels"] == "Product: ICONIC (per month); Product: Basic of the Basic (per month)"

    def test_no_paid_or_refunded_rows_gives_blank_dates_and_zero_revenue(self):
        rows = [_row("cus_1", "a@example.com", "100", "Failed")]
        result = summary.summarize_customer_rows_(rows)
        assert result["total_net_revenue"] == 0.0
        assert result["first_payment_date"] == ""
        assert result["last_payment_date"] == ""


class TestBuildSummaryRows:
    def test_one_row_per_distinct_email_sorted(self):
        rows = [
            _row("cus_2", "b@example.com", "100", "Paid"),
            _row("cus_1", "a@example.com", "100", "Paid"),
        ]
        out_rows = summary.build_summary_rows_(rows)
        assert [r["email"] for r in out_rows] == ["a@example.com", "b@example.com"]


class TestMain:
    def test_writes_summary_csv_with_expected_columns(self, tmp_path, capsys):
        in_path = tmp_path / "stripe.csv"
        out_path = tmp_path / "summary.csv"
        rows = [_row("cus_1", "a@example.com", "100", "Paid"), _row("cus_1", "a@example.com", "50", "Failed")]
        with open(in_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)

        old_argv = sys.argv
        sys.argv = ["stripe_billing_summary.py", "--in", str(in_path), "--out", str(out_path)]
        try:
            summary.main()
        finally:
            sys.argv = old_argv

        with open(out_path, newline="") as f:
            out_rows = list(csv.DictReader(f))
        assert out_rows[0]["email"] == "a@example.com"
        assert out_rows[0]["total_net_revenue"] == "100.0"

        printed = capsys.readouterr().out
        assert "Wrote 1 customer row(s)" in printed

    def test_exits_with_an_error_on_a_completely_empty_input_csv(self, tmp_path):
        in_path = tmp_path / "empty.csv"
        in_path.write_text("")
        old_argv = sys.argv
        sys.argv = ["stripe_billing_summary.py", "--in", str(in_path), "--out", str(tmp_path / "out.csv")]
        try:
            with pytest.raises(SystemExit):
                summary.main()
        finally:
            sys.argv = old_argv
