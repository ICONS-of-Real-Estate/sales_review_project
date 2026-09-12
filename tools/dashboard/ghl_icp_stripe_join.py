#!/usr/bin/env python3
"""
Final join for the client-ICP analysis (12/09/2026): one row per GHL contact
(from ghl_icp_export.py's CSV) with that contact's real Stripe revenue
history (from stripe_billing_summary.py's CSV) attached, matched by email.
No API calls, no GHL/Stripe credentials -- both inputs are already-produced
local CSVs.

Both sides already normalize email the same way (lowercase + stripped --
ghl_icp_export.py's normalize_email_, stripe_billing_summary.py's
normalize_stripe_email_), so the join key just needs the same normalization
applied again here in case either CSV was hand-edited after export.

LEFT join, GHL side is authoritative: every GHL contact appears exactly
once, whether or not Stripe has a matching row for them. A GHL contact with
no Stripe match gets blank revenue fields and has_stripe_history=False --
that's a real, meaningful signal for the ICP analysis (converted in GHL but
never actually billed, or billed under a different email), not a bug to
paper over.

Usage:
    python ghl_icp_stripe_join.py --ghl-in icp_export_converted_appointments.csv \\
        --stripe-in stripe_customer_summary.csv --out icp_stripe_joined.csv
"""
import argparse
import csv
import sys

STRIPE_JOIN_COLUMNS = [
    "stripe_customer_ids", "total_net_revenue", "completed_payment_count",
    "refunded_payment_count", "failed_payment_count", "first_payment_date",
    "last_payment_date", "plan_labels",
]

BLANK_STRIPE_ROW_ = {
    "stripe_customer_ids": "", "total_net_revenue": "", "completed_payment_count": "",
    "refunded_payment_count": "", "failed_payment_count": "", "first_payment_date": "",
    "last_payment_date": "", "plan_labels": "",
}


def normalize_join_email_(email):
    """Pure. Same normalization both source CSVs already applied on export --
    re-applied here so the join is robust to a hand-edited input file."""
    return str(email or "").strip().lower()


def read_csv_rows_(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def index_stripe_rows_by_email_(stripe_rows):
    """Pure. {normalized_email: row} -- stripe_billing_summary.py's output
    already has one row per distinct email, so no aggregation needed here,
    just a lookup index."""
    return {normalize_join_email_(row.get("email")): row for row in stripe_rows}


def join_ghl_row_with_stripe_(ghl_row, stripe_by_email):
    """Pure. One joined row: every GHL field kept as-is, plus the Stripe
    columns (blank + has_stripe_history=False when no match)."""
    email = normalize_join_email_(ghl_row.get("email"))
    stripe_row = stripe_by_email.get(email)
    joined = dict(ghl_row)
    if stripe_row:
        joined["has_stripe_history"] = True
        for col in STRIPE_JOIN_COLUMNS:
            joined[col] = stripe_row.get(col, "")
    else:
        joined["has_stripe_history"] = False
        joined.update(BLANK_STRIPE_ROW_)
    return joined


def build_joined_rows_(ghl_rows, stripe_rows):
    """Pure. LEFT join on email -- every ghl_row produces exactly one output row."""
    stripe_by_email = index_stripe_rows_by_email_(stripe_rows)
    return [join_ghl_row_with_stripe_(row, stripe_by_email) for row in ghl_rows]


def write_joined_csv_(path, rows, ghl_fieldnames):
    fieldnames = ghl_fieldnames + ["has_stripe_history"] + STRIPE_JOIN_COLUMNS
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ghl-in", required=True, help="GHL ICP export CSV (ghl_icp_export.py's output, "
                                                          "or its converted-only/appointments variants)")
    parser.add_argument("--stripe-in", required=True, help="Stripe customer summary CSV (stripe_billing_summary.py's output)")
    parser.add_argument("--out", default="icp_stripe_joined.csv", help="Output CSV (default: icp_stripe_joined.csv)")
    args = parser.parse_args()

    ghl_rows = read_csv_rows_(args.ghl_in)
    if not ghl_rows:
        print(f"{args.ghl_in} has no rows -- nothing to join.", file=sys.stderr)
        sys.exit(1)
    stripe_rows = read_csv_rows_(args.stripe_in)

    joined = build_joined_rows_(ghl_rows, stripe_rows)
    write_joined_csv_(args.out, joined, list(ghl_rows[0].keys()))

    matched = sum(1 for row in joined if row["has_stripe_history"])
    print(f"Wrote {len(joined)} row(s) to {args.out} "
          f"({matched} matched a Stripe customer by email, {len(joined) - matched} did not).")


if __name__ == "__main__":
    main()
