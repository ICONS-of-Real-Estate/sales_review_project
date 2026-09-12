#!/usr/bin/env python3
"""
The actual client-ICP characterization (12/09/2026) -- the payoff of the
whole export/join chain (ghl_icp_export.py -> ghl_icp_stripe_join.py ->
this file). Reads the final joined CSV and answers the real question Kris
asked for: what does a real, paying, high-value ICONS client actually look
like, based on real revenue and real call history -- not guesses.

No API calls, no credentials -- pure read of an already-produced CSV.

WHAT THIS DELIBERATELY DOES NOT DO: it does not decide who our "ideal
customer" is by itself. It reports real distributions (revenue by
qualification/sales-call count, revenue by pipeline, sales-cycle length,
top-revenue plans) so a human draws the actual conclusion from real
numbers -- same "evidence over assumption" discipline as the rest of this
project.

Usage:
    python ghl_icp_characterize.py --in icp_stripe_joined.csv
"""
import argparse
import csv
import statistics
import sys
from datetime import date


def read_csv_rows_(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def parse_float_(value, default=0.0):
    """Pure. Malformed/blank reads as default rather than crashing on one bad row."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_int_(value, default=0):
    """Pure. Same convention as parse_float_."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_iso_date_(value):
    """Pure. None on anything unparseable -- ghl_icp_export.py writes plain
    YYYY-MM-DD strings (see its own _iso_to_datetime + .date().isoformat()),
    never a full timestamp, so date.fromisoformat is the right parse here."""
    if not value:
        return None
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError:
        return None


def paying_rows_(rows):
    """Pure. Rows with real, positive revenue collected -- the actual ICP
    population. A GHL contact marked converted but with $0 net revenue (a
    fully-refunded customer, or a Stripe match we couldn't confirm) is
    deliberately excluded here: this report is about who really paid, not
    who GHL calls "converted.\""""
    return [r for r in rows if r.get("has_stripe_history") == "True" and parse_float_(r.get("total_net_revenue")) > 0]


def revenue_stats_(rows):
    """Pure. {count, total, mean, median, min, max} across total_net_revenue --
    real dollar figures, so a caller can quote a real range, not just an average
    that could be skewed by one $40k outlier."""
    revenues = [parse_float_(r.get("total_net_revenue")) for r in rows]
    if not revenues:
        return {"count": 0, "total": 0.0, "mean": 0.0, "median": 0.0, "min": 0.0, "max": 0.0}
    return {
        "count": len(revenues),
        "total": round(sum(revenues), 2),
        "mean": round(statistics.mean(revenues), 2),
        "median": round(statistics.median(revenues), 2),
        "min": round(min(revenues), 2),
        "max": round(max(revenues), 2),
    }


def revenue_by_field_(rows, field):
    """Pure. {field_value: {count, total, mean}} -- groups paying rows by any
    single field (pipeline_name, or a plan_labels bucket a caller precomputes),
    sorted by total revenue descending by the caller, not here."""
    grouped = {}
    for row in rows:
        key = str(row.get(field) or "(blank)")
        grouped.setdefault(key, []).append(parse_float_(row.get("total_net_revenue")))
    return {
        key: {"count": len(values), "total": round(sum(values), 2), "mean": round(statistics.mean(values), 2)}
        for key, values in grouped.items()
    }


def revenue_by_call_count_bucket_(rows):
    """Pure. Buckets paying rows by (had a qualification call?, had a sales
    call?) -- answers "does going through a qualification/sales call
    correlate with paying more," using the SAME 0/1 reached-stage semantics
    ghl_icp_export.py already documents (a true count isn't available for
    the full 65k-contact export, only for the 60 converted contacts via
    ghl_icp_converted_appointments.py -- this report works across whichever
    file it's pointed at)."""
    buckets = {}
    for row in rows:
        had_qualification = parse_int_(row.get("qualification_call_count")) > 0
        had_sales_call = parse_int_(row.get("sales_call_count")) > 0
        key = (had_qualification, had_sales_call)
        buckets.setdefault(key, []).append(parse_float_(row.get("total_net_revenue")))
    return {
        key: {"count": len(values), "total": round(sum(values), 2), "mean": round(statistics.mean(values), 2)}
        for key, values in buckets.items()
    }


def sales_cycle_days_(rows):
    """Pure. List of (close_date - first_call_date).days for rows where both
    parse -- real elapsed days, so a caller can report a median sales cycle,
    not guess at one. Rows with an unparseable or missing date are dropped,
    never coerced to a fake 0."""
    days = []
    for row in rows:
        first_call = parse_iso_date_(row.get("first_call_date"))
        close = parse_iso_date_(row.get("close_date"))
        if first_call and close and close >= first_call:
            days.append((close - first_call).days)
    return days


def top_plan_labels_by_revenue_(rows, top_n=10):
    """Pure. Splits each row's semicolon-joined plan_labels (stripe_billing_summary.py's
    format) into individual labels, then sums revenue per label -- a contact with 2
    plan labels contributes their FULL row revenue to each label's total (a row's
    revenue isn't divisible across plans, so this deliberately answers "which plans
    tend to appear on high-revenue accounts," not "revenue attributable to a plan
    in isolation"). Returns the top_n labels sorted by total revenue, descending."""
    totals = {}
    for row in rows:
        revenue = parse_float_(row.get("total_net_revenue"))
        labels = [label.strip() for label in str(row.get("plan_labels") or "").split(";") if label.strip()]
        for label in labels:
            totals.setdefault(label, {"count": 0, "total": 0.0})
            totals[label]["count"] += 1
            totals[label]["total"] += revenue
    for label in totals:
        totals[label]["total"] = round(totals[label]["total"], 2)
    return sorted(totals.items(), key=lambda kv: -kv[1]["total"])[:top_n]


def format_currency_(value):
    return f"${value:,.2f}"


def print_report_(rows):
    paying = paying_rows_(rows)
    print(f"Total rows in input: {len(rows)}")
    print(f"Paying contacts (has_stripe_history + real revenue > $0): {len(paying)}")
    print()

    stats = revenue_stats_(paying)
    print("=== REVENUE ===")
    print(f"  Total real revenue: {format_currency_(stats['total'])}")
    print(f"  Mean per paying contact: {format_currency_(stats['mean'])}")
    print(f"  Median per paying contact: {format_currency_(stats['median'])}")
    print(f"  Range: {format_currency_(stats['min'])} - {format_currency_(stats['max'])}")
    print()

    print("=== REVENUE BY PIPELINE ===")
    by_pipeline = revenue_by_field_(paying, "pipeline_name")
    for name, s in sorted(by_pipeline.items(), key=lambda kv: -kv[1]["total"]):
        print(f"  {name}: {s['count']} contact(s), {format_currency_(s['total'])} total, "
              f"{format_currency_(s['mean'])} avg")
    print()

    print("=== REVENUE BY QUALIFICATION/SALES CALL HISTORY ===")
    by_bucket = revenue_by_call_count_bucket_(paying)
    labels = {
        (True, True): "Had BOTH a qualification call and a sales call",
        (True, False): "Had a qualification call only",
        (False, True): "Had a sales call only",
        (False, False): "Had NEITHER on record",
    }
    for key, s in sorted(by_bucket.items(), key=lambda kv: -kv[1]["mean"]):
        print(f"  {labels.get(key, key)}: {s['count']} contact(s), {format_currency_(s['total'])} total, "
              f"{format_currency_(s['mean'])} avg")
    print()

    cycle_days = sales_cycle_days_(paying)
    print("=== SALES CYCLE LENGTH (first call -> close, days) ===")
    if cycle_days:
        print(f"  {len(cycle_days)} contact(s) with both dates on record")
        print(f"  Median: {statistics.median(cycle_days):.0f} days")
        print(f"  Mean: {statistics.mean(cycle_days):.1f} days")
        print(f"  Range: {min(cycle_days)} - {max(cycle_days)} days")
    else:
        print("  No rows had both a parseable first_call_date and close_date.")
    print()

    print("=== TOP PLANS BY TOTAL REVENUE (of the accounts carrying that plan) ===")
    for label, s in top_plan_labels_by_revenue_(paying):
        print(f"  {label}: {s['count']} account(s), {format_currency_(s['total'])} total")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--in", dest="in_path", required=True,
                         help="Joined CSV from ghl_icp_stripe_join.py")
    args = parser.parse_args()

    rows = read_csv_rows_(args.in_path)
    if not rows:
        print(f"{args.in_path} has no rows -- nothing to characterize.", file=sys.stderr)
        sys.exit(1)

    print_report_(rows)


if __name__ == "__main__":
    main()
