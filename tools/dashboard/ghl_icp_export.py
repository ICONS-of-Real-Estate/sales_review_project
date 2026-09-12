#!/usr/bin/env python3
"""
One-off CSV export for the client-ICP analysis Kris asked for (12/09/2026):
one row per GHL contact, with enough call/pipeline history to join against
Stripe billing data. Read-only against GHL — writes a local CSV file only,
nothing to dashboard.db, nothing back to GHL.

TWO REAL FINDINGS FROM THE LIVE DATA, CONFIRMED BEFORE WRITING THIS FILE
(not guessed — see GHL_PIPELINE_MAP.md, an API-verified pipeline/stage
survey, and GHL_REPLACEMENT_ANALYSIS.md §2.3):

1. Qualification vs. Sales Call is a PIPELINE STAGE NAME, not a tag or
   custom field. Every pipeline in this account spells it out literally —
   "Qualification Call Booked/Taken/...", "Sales Call Booked/Taken/...",
   and ICONS Podcast additionally has "Discovery Call" and "2nd/Second
   Sales Call" stages. classify_pipeline_stages_ below matches on those
   substrings (case-insensitive) against the real stage names returned by
   GET /opportunities/pipelines — never a hardcoded stage-ID list, so a
   pipeline rename doesn't silently break this. Re-run against a fresh
   fetch_all_pipelines() call before trusting this at export time —
   GHL_PIPELINE_MAP.md's survey is from 28/08/2026 and stage names can be
   renamed in the GHL UI any time.

2. GHL's opportunity object is NOT a call log — it stores the current/
   furthest stage a contact reached, not how many times a call happened.
   This codebase has never called a GHL /calls endpoint (confirmed,
   GHL_REPLACEMENT_ANALYSIS.md §2.3); real sales calls/QCs happen on Zoom,
   not inside GHL. So qualification_call_count/sales_call_count below are
   **0/1 "reached that stage at least once" flags**, not true counts — a
   true count would need the appointments endpoint (one extra API call per
   contact, ~65k+ calls total, and its calendarId/title fields are
   unverified against real data) — Kris's own call (12/09/2026): use the
   cheap flag, not the expensive/unverified true count, for this pass.

DECISIONS CONFIRMED WITH KRIS (12/09/2026), so the extraction logic below
isn't silently picking an answer to something genuinely ambiguous in the
data:
  - Multi-pipeline contacts: UNIONED. One row per contact; counts/converted
    are computed by combining every opportunity across every pipeline that
    contact has, not just one arbitrarily picked pipeline.
  - "Lost": only the ICONS Podcast pipeline has an explicit "Closed lost"
    stage — the other 4 have no terminal lost state at all, just staleness
    in an open stage. lost_date is populated ONLY from a real Closed-lost
    stage (never fabricated for the other 4); days_since_last_activity is
    exported instead so Kris can pick his own staleness cutoff at analysis
    time rather than have one baked in here.

Usage:
    cd tools/dashboard && source .venv/bin/activate
    python ghl_icp_export.py --out icp_export.csv
    python ghl_icp_export.py --out icp_export_sample.csv --limit 200   # small sample first
"""
import argparse
import csv
import re
import sys
from datetime import datetime, timezone

import ghl_mirror

QUALIFICATION_STAGE_PATTERN = re.compile(r"qualification call", re.IGNORECASE)
SALES_CALL_STAGE_PATTERN = re.compile(r"sales call", re.IGNORECASE)
CLOSED_WON_STAGE_PATTERN = re.compile(r"closed won", re.IGNORECASE)
CLOSED_LOST_STAGE_PATTERN = re.compile(r"closed lost", re.IGNORECASE)

CSV_COLUMNS = [
    "contact_id", "full_name", "email", "phone",
    "first_call_date", "qualification_call_count", "sales_call_count", "total_call_count",
    "opportunity_count", "pipeline_name", "pipeline_stage",
    "converted", "close_date", "lost_date", "days_since_last_activity",
]


def normalize_email_(email):
    """Pure. Lowercase + stripped, so the Stripe join key actually matches — Stripe almost
    certainly stores email lowercase/trimmed too, and GHL's own casing is inconsistent."""
    return str(email or "").strip().lower()


def normalize_phone_(phone):
    """Pure. Digits only (drops +, spaces, dashes, parens) — same reasoning as normalize_email_:
    a join key has to match on FORM, not just on being "the same number" to a human reader."""
    return re.sub(r"\D", "", str(phone or ""))


def classify_pipeline_stages_(pipelines):
    """Pure. stage_id -> {pipeline_id, pipeline_name, stage_name, is_qualification,
    is_sales_call, is_closed_won, is_closed_lost} — built fresh from a real
    GET /opportunities/pipelines response every call, never a hardcoded ID
    list (see this file's own header for why: names/IDs can be renamed,
    and IDs differ per pipeline even for "the same" stage concept)."""
    lookup = {}
    for pipeline in pipelines or []:
        pipeline_id = pipeline.get("id")
        pipeline_name = pipeline.get("name") or ""
        for stage in pipeline.get("stages") or []:
            stage_id = stage.get("id")
            stage_name = stage.get("name") or ""
            lookup[stage_id] = {
                "pipeline_id": pipeline_id,
                "pipeline_name": pipeline_name,
                "stage_name": stage_name,
                "is_qualification": bool(QUALIFICATION_STAGE_PATTERN.search(stage_name)),
                "is_sales_call": bool(SALES_CALL_STAGE_PATTERN.search(stage_name)),
                "is_closed_won": bool(CLOSED_WON_STAGE_PATTERN.search(stage_name)),
                "is_closed_lost": bool(CLOSED_LOST_STAGE_PATTERN.search(stage_name)),
            }
    return lookup


def group_opportunities_by_contact_(opportunities):
    """Pure. contact_id -> [raw opportunity dict, ...], preserving every opportunity
    (never picks one) — the union-across-pipelines decision needs all of them."""
    by_contact = {}
    for opp in opportunities or []:
        contact_id = opp.get("contactId")
        if not contact_id:
            continue
        by_contact.setdefault(contact_id, []).append(opp)
    return by_contact


def _iso_to_datetime(value):
    """None on anything unparseable — never raises, since a single malformed
    date on one of 65k+ contacts must not crash the whole export."""
    if not value:
        return None
    try:
        iso = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(iso)
    except (ValueError, TypeError):
        return None


def build_contact_icp_row_(contact, contact_opportunities, stage_lookup, now=None):
    """Pure. One CSV row for one contact, given ITS OWN opportunities already
    resolved by group_opportunities_by_contact_ and the pipeline stage
    lookup from classify_pipeline_stages_. `now` is injectable so tests
    don't depend on the real clock. See this file's own header for what
    qualification_call_count/sales_call_count/lost_date really mean and why
    (0/1 reached-stage flags; lost_date only from a real Closed-lost stage).
    """
    now = now or datetime.now(timezone.utc)

    stage_infos = []
    for opp in contact_opportunities:
        info = stage_lookup.get(opp.get("pipelineStageId"))
        if info is None:
            continue  # a stage ID this pipeline fetch didn't resolve -- skip rather than guess
        created = _iso_to_datetime(opp.get("createdAt"))
        updated = _iso_to_datetime(opp.get("updatedAt")) or created
        stage_infos.append({"info": info, "created": created, "updated": updated})

    qualification_reached = any(s["info"]["is_qualification"] for s in stage_infos)
    sales_call_reached = any(s["info"]["is_sales_call"] for s in stage_infos)
    won = [s for s in stage_infos if s["info"]["is_closed_won"]]
    lost = [s for s in stage_infos if s["info"]["is_closed_lost"]]

    created_dates = [s["created"] for s in stage_infos if s["created"]]
    updated_dates = [s["updated"] for s in stage_infos if s["updated"]]

    _epoch = datetime.min.replace(tzinfo=timezone.utc)  # tz-aware sentinel -- everything parsed here carries a tz
    most_recent = max(stage_infos, key=lambda s: s["updated"] or s["created"] or _epoch) if stage_infos else None
    won_dates = sorted(s["updated"] for s in won if s["updated"])
    lost_dates = sorted(s["updated"] for s in lost if s["updated"])

    last_activity = max(updated_dates) if updated_dates else _iso_to_datetime(contact.get("dateUpdated"))
    days_since_last_activity = (now - last_activity).days if last_activity else ""

    first = contact.get("firstNameRaw") or contact.get("firstName") or ""
    last = contact.get("lastNameRaw") or contact.get("lastName") or ""
    full_name = (first + " " + last).strip() or contact.get("contactName") or ""

    return {
        "contact_id": contact.get("id"),
        "full_name": full_name,
        "email": normalize_email_(contact.get("email")),
        "phone": normalize_phone_(contact.get("phone")),
        "first_call_date": created_dates and min(created_dates).date().isoformat() or "",
        "qualification_call_count": int(qualification_reached),
        "sales_call_count": int(sales_call_reached),
        "total_call_count": int(qualification_reached) + int(sales_call_reached),
        "opportunity_count": len(contact_opportunities),
        "pipeline_name": most_recent["info"]["pipeline_name"] if most_recent else "",
        "pipeline_stage": most_recent["info"]["stage_name"] if most_recent else "",
        "converted": bool(won),
        "close_date": won_dates and won_dates[0].date().isoformat() or "",
        "lost_date": lost_dates and lost_dates[0].date().isoformat() or "",
        "days_since_last_activity": days_since_last_activity,
    }


def build_icp_rows_(contacts, opportunities, pipelines, now=None):
    """Pure. One row per contact, INCLUDING a contact with zero opportunities
    (0 counts, blank dates) — a no-show/never-booked contact is real ICP
    signal, never dropped."""
    stage_lookup = classify_pipeline_stages_(pipelines)
    opps_by_contact = group_opportunities_by_contact_(opportunities)
    return [
        build_contact_icp_row_(contact, opps_by_contact.get(contact.get("id"), []), stage_lookup, now=now)
        for contact in contacts
    ]


def write_icp_csv_(rows, path):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="icp_export.csv", help="Output CSV path (default: icp_export.csv)")
    parser.add_argument("--limit", type=int, default=None,
                         help="Cap the number of contacts processed (for a quick sample run before the full export)")
    args = parser.parse_args()

    if not ghl_mirror.GHL_API_TOKEN or not ghl_mirror.GHL_LOCATION_ID:
        print("GHL_API_TOKEN and/or GHL_LOCATION_ID are not set -- see ghl_mirror.py's own docstring for setup.",
              file=sys.stderr)
        sys.exit(1)

    client = ghl_mirror._ghl_client()
    try:
        print("Fetching pipelines...", file=sys.stderr)
        pipelines = ghl_mirror.fetch_all_pipelines(client, ghl_mirror.GHL_LOCATION_ID)
        stage_lookup = classify_pipeline_stages_(pipelines)
        qual_stages = sorted({v["stage_name"] for v in stage_lookup.values() if v["is_qualification"]})
        sales_stages = sorted({v["stage_name"] for v in stage_lookup.values() if v["is_sales_call"]})
        print(f"  {len(pipelines)} pipeline(s). Qualification-matching stages: {qual_stages}", file=sys.stderr)
        print(f"  Sales-call-matching stages: {sales_stages}", file=sys.stderr)

        print("Fetching contacts (this can take a while for a large account)...", file=sys.stderr)
        contacts = ghl_mirror.fetch_all_contacts(client, ghl_mirror.GHL_LOCATION_ID)
        if args.limit:
            contacts = contacts[:args.limit]
        print(f"  {len(contacts)} contact(s) to export.", file=sys.stderr)

        print("Fetching opportunities...", file=sys.stderr)
        opportunities = ghl_mirror.fetch_all_opportunities(client, ghl_mirror.GHL_LOCATION_ID)
        print(f"  {len(opportunities)} opportunity(ies) fetched.", file=sys.stderr)
    finally:
        client.close()

    rows = build_icp_rows_(contacts, opportunities, pipelines)
    write_icp_csv_(rows, args.out)
    converted_count = sum(1 for r in rows if r["converted"])
    print(f"Wrote {len(rows)} row(s) to {args.out} ({converted_count} converted, "
          f"{len(rows) - converted_count} not).", file=sys.stderr)


if __name__ == "__main__":
    main()
