#!/usr/bin/env python3
"""
Second pass over an already-produced ghl_icp_export.py CSV (12/09/2026,
Kris's follow-up ask) — no GHL API calls, just reads the CSV that's
already on disk. Two things:
  1. A separate CSV of just the converted rows (60 out of 65,222 on the
     first real run) -- much faster first look than scrolling the full
     export.
  2. A breakdown of qualification_call_count/sales_call_count among the
     converted rows -- did they need a qualification call before closing,
     a sales call, both, or (rare, but real if GHL data is incomplete for
     that contact) neither.

Remember what qualification_call_count/sales_call_count actually mean
here (see ghl_icp_export.py's own header): 0/1 "reached that stage at
least once" flags, not true call counts -- so this breakdown answers
"how many converted clients had NO qualification call on record before
closing," not "how many qualification calls did they have."

Usage:
    python ghl_icp_analyze.py --in icp_export.csv --converted-out icp_export_converted.csv
"""
import argparse
import csv
import sys


def read_icp_rows_(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def is_converted_(row):
    """Pure. csv.DictWriter wrote Python's bool True/False as the literal strings
    "True"/"False" -- this is the one place that string gets turned back into a
    real boolean check, so every other function here works with real rows, not
    string comparisons scattered around."""
    return str(row.get("converted", "")).strip() == "True"


def filter_converted_rows_(rows):
    """Pure."""
    return [r for r in rows if is_converted_(r)]


def call_count_breakdown_(rows):
    """Pure. {(qualification_call_count, sales_call_count): count}, keys as the
    real (0/1, 0/1) int pairs -- e.g. (1, 1) is "reached both," (0, 1) is
    "sales call only, no qualification call on record," etc. Missing/malformed
    values in a row read as 0 rather than crashing the whole breakdown over one
    bad row."""
    breakdown = {}
    for row in rows:
        try:
            qual = int(row.get("qualification_call_count") or 0)
        except ValueError:
            qual = 0
        try:
            sales = int(row.get("sales_call_count") or 0)
        except ValueError:
            sales = 0
        key = (qual, sales)
        breakdown[key] = breakdown.get(key, 0) + 1
    return breakdown


def format_breakdown_(breakdown, total):
    """Pure. Human-readable lines, most-common combo first."""
    labels = {
        (1, 1): "reached BOTH a qualification call and a sales call",
        (1, 0): "reached a qualification call only (no sales call stage on record)",
        (0, 1): "reached a sales call only (no qualification call stage on record)",
        (0, 0): "reached NEITHER stage on record (converted via some other path, or incomplete GHL data)",
    }
    lines = []
    for key, count in sorted(breakdown.items(), key=lambda kv: -kv[1]):
        pct = round(100 * count / total, 1) if total else 0
        label = labels.get(key, f"qualification={key[0]}, sales_call={key[1]}")
        lines.append(f"  {count} ({pct}%) — {label}")
    return lines


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--in", dest="in_path", default="icp_export.csv", help="Input CSV from ghl_icp_export.py")
    parser.add_argument("--converted-out", default="icp_export_converted.csv",
                         help="Output CSV of just the converted rows (default: icp_export_converted.csv)")
    args = parser.parse_args()

    rows = read_icp_rows_(args.in_path)
    converted = filter_converted_rows_(rows)

    if not rows:
        print(f"{args.in_path} has no rows -- nothing to analyze.", file=sys.stderr)
        sys.exit(1)

    fieldnames = list(rows[0].keys())
    with open(args.converted_out, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(converted)

    print(f"{len(converted)} converted row(s) written to {args.converted_out} "
          f"(out of {len(rows)} total, {round(100 * len(converted) / len(rows), 2)}%).")
    print()
    print(f"Qualification/sales-call breakdown among the {len(converted)} converted contact(s):")
    for line in format_breakdown_(call_count_breakdown_(converted), len(converted)):
        print(line)


if __name__ == "__main__":
    main()
