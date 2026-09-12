#!/usr/bin/env python3
"""
Real qualification/sales-call history for just the CONVERTED contacts
(12/09/2026 follow-up) -- fixes a real bug found in the first real export:
ghl_icp_export.py's qualification_call_count/sales_call_count only ever
look at an opportunity's CURRENT pipelineStageId, but GHL overwrites that
field every time an opportunity advances (Qualification Call Booked ->
Sales Call Taken -> Closed Won is the SAME opportunity record, its stage
field just gets overwritten each time). So by the time an opportunity is
Closed Won, there's no trace left that it ever passed through a
qualification or sales call stage -- confirmed live: 56 of the first 60
real converted contacts (93.3%) read as "reached neither stage," which is
almost certainly a measurement artifact, not reality.

The fix: GET /contacts/{id}/appointments is a real per-event record (each
booked call is its own object, never overwritten the way opportunity
stage is) -- see ghl_mirror.py's own header for why this wasn't used for
the FULL 65k-contact export (one API call per contact, cost-prohibitive
at that scale, and the field shape was unverified). Neither problem
applies to just the converted group: 60 contacts is 60 API calls, and
this file's own --inspect mode samples the real shape before trusting it
for classification.

Real shapes sampled live (12/09/2026, --inspect against 3 real converted
contacts): a "title" field really is there, e.g. "Podcast Qualification
Call / Amanda LeGault and ICONS of Real Estate" (matches
QUALIFICATION_TITLE_PATTERN fine, substring match). But the podcast
funnel's actual closing call is titled "Starting A Podcast / {name} and
{team member}" -- no literal "Sales Call" text at all. Confirmed with
Kris (12/09/2026): that IS the real closing/sales conversation for this
funnel, just not named that -- STARTING_A_PODCAST_TITLE_PATTERN below
counts it as a sales call, same as a literally-titled one.

Usage:
    python ghl_icp_converted_appointments.py --inspect       # print every real appointment payload, write nothing
    python ghl_icp_converted_appointments.py                  # fetch for every row in --in, write --out
"""
import argparse
import csv
import re
import sys

import ghl_mirror

QUALIFICATION_TITLE_PATTERN = re.compile(r"qualification call", re.IGNORECASE)
SALES_CALL_TITLE_PATTERN = re.compile(r"sales call", re.IGNORECASE)
# The ICONS Podcast funnel's real closing call -- confirmed with Kris
# (12/09/2026) it functions as the sales call despite the non-literal title.
STARTING_A_PODCAST_TITLE_PATTERN = re.compile(r"starting a podcast", re.IGNORECASE)

OUTPUT_COLUMNS = [
    "contact_id", "full_name", "email", "phone",
    "appointment_count", "qualification_call_count", "sales_call_count",
    "first_appointment_date", "converted", "close_date",
]


def read_converted_rows_(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def fetch_appointments_for_contact_(client, contact_id):
    """Real API call -- GET /contacts/{id}/appointments, same endpoint
    ghl_mirror.py's own upsert_appointments already has a schema for, but
    whose real field shape this codebase has never actually sampled (see
    that file's own UNVERIFIED note). Never raises for one bad contact --
    logs and returns [] instead, so one failure doesn't kill the other 59."""
    resp = ghl_mirror._get_with_retry(client, f"/contacts/{contact_id}/appointments")
    if resp.status_code != 200:
        print(f"  contact {contact_id}: HTTP {resp.status_code} fetching appointments -- treating as 0.",
              file=sys.stderr)
        return []
    body = resp.json()
    return body.get("events") or body.get("appointments") or body.get("data") or []


def classify_appointment_(appointment):
    """Pure. Matches the SAME "literal stage-name substring" approach
    ghl_icp_export.py's classify_pipeline_stages_ already uses, applied to
    whatever text field the appointment actually carries -- title first,
    falling back to a calendar name if the appointment object provides one
    under that key instead. Returns {is_qualification, is_sales_call},
    both False for an appointment with no matching text at all (never
    guesses)."""
    text = str(appointment.get("title") or appointment.get("calendarName") or appointment.get("name") or "")
    return {
        "is_qualification": bool(QUALIFICATION_TITLE_PATTERN.search(text)),
        "is_sales_call": bool(SALES_CALL_TITLE_PATTERN.search(text)) or bool(STARTING_A_PODCAST_TITLE_PATTERN.search(text)),
    }


def summarize_contact_appointments_(appointments):
    """Pure. TRUE counts this time (not the 0/1 flag ghl_icp_export.py had to
    settle for) -- appointments are real per-event records, so counting them
    is honest, unlike counting opportunity-stage visits."""
    classified = [classify_appointment_(a) for a in appointments]
    dates = sorted(
        str(a.get("startTime") or a.get("startDate") or a.get("date") or "")
        for a in appointments if (a.get("startTime") or a.get("startDate") or a.get("date"))
    )
    return {
        "appointment_count": len(appointments),
        "qualification_call_count": sum(1 for c in classified if c["is_qualification"]),
        "sales_call_count": sum(1 for c in classified if c["is_sales_call"]),
        "first_appointment_date": dates[0] if dates else "",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--in", dest="in_path", default="icp_export_converted.csv",
                         help="Converted-only CSV from ghl_icp_analyze.py")
    parser.add_argument("--out", default="icp_export_converted_appointments.csv",
                         help="Output CSV with real appointment-based counts")
    parser.add_argument("--inspect", action="store_true",
                         help="Print the raw appointments payload for the first 3 contacts and exit -- writes "
                              "nothing. Run this FIRST to confirm what fields a real appointment actually has "
                              "before trusting the title-matching classification.")
    parser.add_argument("--list-titles", action="store_true",
                         help="Fetch appointments for every row in --in and print every DISTINCT title seen, "
                              "with a count and how each one currently classifies -- writes nothing. Run this "
                              "when the qualification/sales-call breakdown looks off (a real gap found live, "
                              "12/09/2026: only 3 contacts' worth of real titles had ever been sampled before "
                              "classifying all 60 -- 'reached neither stage' jumped to 55%% once real appointment "
                              "counts came in, meaning real appointments exist that neither pattern matches).")
    args = parser.parse_args()

    if not ghl_mirror.GHL_API_TOKEN or not ghl_mirror.GHL_LOCATION_ID:
        print("GHL_API_TOKEN and/or GHL_LOCATION_ID are not set -- see ghl_mirror.py's own docstring for setup.",
              file=sys.stderr)
        sys.exit(1)

    rows = read_converted_rows_(args.in_path)
    if not rows:
        print(f"{args.in_path} has no rows -- nothing to fetch.", file=sys.stderr)
        sys.exit(1)

    client = ghl_mirror._ghl_client()
    try:
        if args.inspect:
            import json
            for row in rows[:3]:
                appointments = fetch_appointments_for_contact_(client, row["contact_id"])
                print(f"=== contact {row['contact_id']} ({row.get('full_name')}) -- "
                      f"{len(appointments)} appointment(s) ===")
                print(json.dumps(appointments, indent=2, default=str))
            return

        if args.list_titles:
            title_counts = {}
            for i, row in enumerate(rows, start=1):
                appointments = fetch_appointments_for_contact_(client, row["contact_id"])
                for a in appointments:
                    title = str(a.get("title") or a.get("calendarName") or a.get("name") or "(no title field at all)")
                    title_counts[title] = title_counts.get(title, 0) + 1
                if i % 10 == 0:
                    print(f"  {i}/{len(rows)} contact(s) scanned...", file=sys.stderr)
            print(f"\n{len(title_counts)} distinct appointment title(s) across {len(rows)} contact(s):\n")
            for title, count in sorted(title_counts.items(), key=lambda kv: -kv[1]):
                classification = classify_appointment_({"title": title})
                tag = ("qualification" if classification["is_qualification"] else
                       "sales_call" if classification["is_sales_call"] else "UNCLASSIFIED")
                print(f"  {count:>3}x [{tag:>13}] {title}")
            return

        out_rows = []
        for i, row in enumerate(rows, start=1):
            appointments = fetch_appointments_for_contact_(client, row["contact_id"])
            summary = summarize_contact_appointments_(appointments)
            out_rows.append({
                "contact_id": row["contact_id"], "full_name": row.get("full_name", ""),
                "email": row.get("email", ""), "phone": row.get("phone", ""),
                "appointment_count": summary["appointment_count"],
                "qualification_call_count": summary["qualification_call_count"],
                "sales_call_count": summary["sales_call_count"],
                "first_appointment_date": summary["first_appointment_date"],
                "converted": row.get("converted", ""), "close_date": row.get("close_date", ""),
            })
            if i % 10 == 0:
                print(f"  {i}/{len(rows)} contact(s) processed...", file=sys.stderr)
    finally:
        client.close()

    with open(args.out, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        writer.writerows(out_rows)

    zero_appointment_count = sum(1 for r in out_rows if r["appointment_count"] == 0)
    print(f"Wrote {len(out_rows)} row(s) to {args.out} ({zero_appointment_count} with zero appointments found).")


if __name__ == "__main__":
    main()
