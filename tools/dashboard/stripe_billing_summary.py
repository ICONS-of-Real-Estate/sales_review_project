#!/usr/bin/env python3
"""
Per-customer revenue summary from a Stripe Payments CSV export (12/09/2026,
the Stripe side of Kris's client-ICP join) -- no Stripe API calls, just reads
a CSV already exported from the Stripe Dashboard (Payments report). No API
key/credentials involved.

REAL SHAPE CONFIRMED (12/09/2026, against Kris's own
"Stripe Payments ICONS filtered" export, 1,907 payment rows, 201 distinct
Customer Email values, 245 distinct Customer ID values):

1. Amount/Amount Refunded are REAL DOLLARS, not cents -- e.g. "902.32",
   "1247" -- unlike the raw Stripe API, which returns cents. Don't divide
   by 100.

2. Status is a human string, not Stripe's raw API enum -- real values seen:
   "Paid", "Failed", "requires_payment_method", "canceled", "Refunded",
   "requires_confirmation". Only "Paid" and "Refunded" ever actually
   collected money (net revenue = Amount - Amount Refunded works for both --
   a fully-Refunded row nets to 0 automatically since Amount == Amount
   Refunded there; a "Paid" row can have a nonzero partial refund too,
   confirmed live on 3 real rows). Every other status is an attempt that
   never collected money, so it contributes 0 revenue but still counts
   toward failed_payment_count -- a customer with 5 failed charges and 1
   real one shouldn't look "clean."

3. One email can map to MULTIPLE Stripe Customer IDs (21 real cases, e.g.
   re-subscribing after a cancellation creates a new customer object) --
   this file aggregates by EMAIL, not Customer ID, and keeps every
   Customer ID seen for reference, so a re-subscription doesn't silently
   split one real customer's history into two rows.

4. "plan (metadata)"/"title (metadata)" columns are almost entirely blank
   (17/1907 rows) -- not a usable plan-label source at this data's actual
   fill rate. "Description" is far better populated and mostly structured
   ("Product: ICONIC (per month)", "Basic with Guest Booking Package:
   $799... + $747 per month") -- used here instead. "Customer Description"
   was deliberately NOT used for plan labels: real values there include
   multi-paragraph internal account notes (e.g. a client-pause explanation
   with someone's name in it), not just plan names -- pulling from that
   column would leak internal notes into an ICP export.

Usage:
    python stripe_billing_summary.py --in stripe_payments.csv --out stripe_customer_summary.csv
"""
import argparse
import csv
import sys

# Real Description values seen that carry no plan info at all -- generic
# Stripe subscription lifecycle text, not what plan the customer is on.
GENERIC_DESCRIPTIONS_ = {
    "", "Subscription update", "Subscription creation", "Payment for Invoice",
    "Please Enter Amount on Invoice",
}

PAID_STATUSES_ = {"Paid", "Refunded"}

OUTPUT_COLUMNS = [
    "email", "stripe_customer_ids", "total_net_revenue",
    "completed_payment_count", "refunded_payment_count", "failed_payment_count",
    "first_payment_date", "last_payment_date", "plan_labels",
]


def normalize_stripe_email_(email):
    """Pure. Same normalization as ghl_icp_export.py's normalize_email_ --
    the join key has to match on FORM, not just meaning."""
    return str(email or "").strip().lower()


def read_stripe_rows_(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def net_revenue_for_row_(row):
    """Pure. Amount - Amount Refunded for a row that actually collected money
    (Paid or Refunded status) -- 0 for anything else (Failed, canceled,
    requires_*), since those never collected a cent regardless of what
    Amount says was attempted. Malformed numeric fields read as 0 rather
    than crashing the whole summary over one bad row."""
    if row.get("Status") not in PAID_STATUSES_:
        return 0.0
    try:
        amount = float(row.get("Amount") or 0)
    except ValueError:
        amount = 0.0
    try:
        refunded = float(row.get("Amount Refunded") or 0)
    except ValueError:
        refunded = 0.0
    return amount - refunded


def plan_label_for_row_(row):
    """Pure. Returns a usable plan label from Description, or None when
    Description is blank/generic (see GENERIC_DESCRIPTIONS_ above) -- never
    reads from Customer Description (see module docstring point 4)."""
    desc = str(row.get("Description") or "").strip()
    if desc in GENERIC_DESCRIPTIONS_:
        return None
    return desc


def group_stripe_rows_by_email_(rows):
    """Pure. {normalized_email: [row, ...]} -- drops rows with no email at
    all (52 real rows, mostly incomplete/requires_confirmation attempts that
    never reached a real customer record) since there's no join key for them."""
    grouped = {}
    for row in rows:
        email = normalize_stripe_email_(row.get("Customer Email"))
        if not email:
            continue
        grouped.setdefault(email, []).append(row)
    return grouped


def summarize_customer_rows_(rows):
    """Pure. One email's worth of Stripe payment rows -> the summary fields.
    total_net_revenue is a TRUE dollar total (real revenue collected, net of
    refunds), not a 0/1 flag -- see module docstring point 1-2."""
    customer_ids = sorted({row.get("Customer ID") for row in rows if row.get("Customer ID")})
    completed = [row for row in rows if row.get("Status") == "Paid"]
    refunded = [row for row in rows if row.get("Status") == "Refunded"]
    failed = [row for row in rows if row.get("Status") not in PAID_STATUSES_]

    total_net_revenue = round(sum(net_revenue_for_row_(row) for row in rows), 2)

    dates = sorted(
        str(row.get("Created date (UTC)") or "")
        for row in rows if row.get("Status") in PAID_STATUSES_ and row.get("Created date (UTC)")
    )

    plan_labels = []
    for row in rows:
        label = plan_label_for_row_(row)
        if label and label not in plan_labels:
            plan_labels.append(label)

    return {
        "stripe_customer_ids": ";".join(customer_ids),
        "total_net_revenue": total_net_revenue,
        "completed_payment_count": len(completed),
        "refunded_payment_count": len(refunded),
        "failed_payment_count": len(failed),
        "first_payment_date": dates[0] if dates else "",
        "last_payment_date": dates[-1] if dates else "",
        "plan_labels": "; ".join(plan_labels),
    }


def build_summary_rows_(rows):
    """Pure. One row per distinct customer email, sorted by email for a
    stable/diffable output file."""
    grouped = group_stripe_rows_by_email_(rows)
    out_rows = []
    for email in sorted(grouped):
        summary = summarize_customer_rows_(grouped[email])
        out_rows.append({"email": email, **summary})
    return out_rows


def write_summary_csv_(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--in", dest="in_path", required=True, help="Stripe Payments CSV export")
    parser.add_argument("--out", default="stripe_customer_summary.csv",
                         help="Output CSV, one row per distinct customer email (default: stripe_customer_summary.csv)")
    args = parser.parse_args()

    rows = read_stripe_rows_(args.in_path)
    if not rows:
        print(f"{args.in_path} has no rows -- nothing to summarize.", file=sys.stderr)
        sys.exit(1)

    out_rows = build_summary_rows_(rows)
    write_summary_csv_(args.out, out_rows)

    skipped = sum(1 for row in rows if not normalize_stripe_email_(row.get("Customer Email")))
    print(f"Wrote {len(out_rows)} customer row(s) to {args.out} "
          f"(from {len(rows)} payment row(s), {skipped} with no Customer Email skipped).")


if __name__ == "__main__":
    main()
