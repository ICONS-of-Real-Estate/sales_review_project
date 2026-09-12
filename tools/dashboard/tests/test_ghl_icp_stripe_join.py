"""
Tests for ghl_icp_stripe_join.py's pure logic -- the final LEFT join of the
GHL ICP export against the Stripe per-customer revenue summary, matched by
email (12/09/2026, the last step of Kris's client-ICP analysis).
"""
import csv
import sys

import pytest

import ghl_icp_stripe_join as join


def _ghl_row(contact_id, email, **overrides):
    row = {"contact_id": contact_id, "full_name": f"Contact {contact_id}", "email": email, "converted": "True"}
    row.update(overrides)
    return row


def _stripe_row(email, revenue, **overrides):
    row = {
        "email": email, "stripe_customer_ids": "cus_1", "total_net_revenue": str(revenue),
        "completed_payment_count": "1", "refunded_payment_count": "0", "failed_payment_count": "0",
        "first_payment_date": "2026-01-01 00:00:00", "last_payment_date": "2026-01-01 00:00:00",
        "plan_labels": "Product: ICONIC (per month)",
    }
    row.update(overrides)
    return row


class TestNormalizeJoinEmail:
    def test_lowercases_and_strips(self):
        assert join.normalize_join_email_("  Jane@Example.com ") == "jane@example.com"


class TestIndexStripeRowsByEmail:
    def test_indexes_by_normalized_email(self):
        rows = [_stripe_row("Jane@Example.com", 100)]
        indexed = join.index_stripe_rows_by_email_(rows)
        assert "jane@example.com" in indexed


class TestJoinGhlRowWithStripe:
    def test_matched_row_carries_stripe_fields_and_true_flag(self):
        ghl_row = _ghl_row("c1", "jane@example.com")
        stripe_by_email = join.index_stripe_rows_by_email_([_stripe_row("jane@example.com", 250)])
        joined = join.join_ghl_row_with_stripe_(ghl_row, stripe_by_email)
        assert joined["has_stripe_history"] is True
        assert joined["total_net_revenue"] == "250"
        assert joined["contact_id"] == "c1"

    def test_unmatched_row_gets_blank_stripe_fields_and_false_flag(self):
        ghl_row = _ghl_row("c1", "nobody@example.com")
        joined = join.join_ghl_row_with_stripe_(ghl_row, {})
        assert joined["has_stripe_history"] is False
        assert joined["total_net_revenue"] == ""
        assert joined["plan_labels"] == ""

    def test_match_is_case_insensitive(self):
        ghl_row = _ghl_row("c1", "Jane@Example.com")
        stripe_by_email = join.index_stripe_rows_by_email_([_stripe_row("jane@example.com", 250)])
        joined = join.join_ghl_row_with_stripe_(ghl_row, stripe_by_email)
        assert joined["has_stripe_history"] is True


class TestBuildJoinedRows:
    def test_every_ghl_row_produces_exactly_one_output_row(self):
        ghl_rows = [_ghl_row("c1", "jane@example.com"), _ghl_row("c2", "nobody@example.com")]
        stripe_rows = [_stripe_row("jane@example.com", 250)]
        joined = join.build_joined_rows_(ghl_rows, stripe_rows)
        assert len(joined) == 2
        assert joined[0]["has_stripe_history"] is True
        assert joined[1]["has_stripe_history"] is False

    def test_stripe_only_rows_with_no_ghl_match_are_not_added(self):
        # LEFT join, GHL side authoritative -- a Stripe customer with no GHL
        # contact record must not appear in the output at all.
        ghl_rows = [_ghl_row("c1", "jane@example.com")]
        stripe_rows = [_stripe_row("jane@example.com", 250), _stripe_row("someoneelse@example.com", 500)]
        joined = join.build_joined_rows_(ghl_rows, stripe_rows)
        assert len(joined) == 1


class TestMain:
    def test_writes_joined_csv_and_reports_match_counts(self, tmp_path, capsys):
        ghl_path = tmp_path / "ghl.csv"
        stripe_path = tmp_path / "stripe.csv"
        out_path = tmp_path / "joined.csv"

        ghl_rows = [_ghl_row("c1", "jane@example.com"), _ghl_row("c2", "nobody@example.com")]
        with open(ghl_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(ghl_rows[0].keys()))
            writer.writeheader()
            writer.writerows(ghl_rows)

        stripe_rows = [_stripe_row("jane@example.com", 250)]
        with open(stripe_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(stripe_rows[0].keys()))
            writer.writeheader()
            writer.writerows(stripe_rows)

        old_argv = sys.argv
        sys.argv = ["ghl_icp_stripe_join.py", "--ghl-in", str(ghl_path), "--stripe-in", str(stripe_path), "--out", str(out_path)]
        try:
            join.main()
        finally:
            sys.argv = old_argv

        with open(out_path, newline="") as f:
            out_rows = list(csv.DictReader(f))
        assert len(out_rows) == 2

        printed = capsys.readouterr().out
        assert "1 matched a Stripe customer" in printed
        assert "1 did not" in printed

    def test_exits_with_an_error_on_a_completely_empty_ghl_csv(self, tmp_path):
        ghl_path = tmp_path / "empty.csv"
        ghl_path.write_text("")
        stripe_path = tmp_path / "stripe.csv"
        stripe_path.write_text("email,total_net_revenue\n")
        old_argv = sys.argv
        sys.argv = ["ghl_icp_stripe_join.py", "--ghl-in", str(ghl_path), "--stripe-in", str(stripe_path),
                    "--out", str(tmp_path / "out.csv")]
        try:
            with pytest.raises(SystemExit):
                join.main()
        finally:
            sys.argv = old_argv
