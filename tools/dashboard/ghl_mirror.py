#!/usr/bin/env python3
"""
Step 1 groundwork for GHL_REPLACEMENT_ANALYSIS.md's proposed shape (§7):
a read-only mirror of GHL's contacts/opportunities/tags/appointments into
the same SQLite file the dashboard already reads (dashboard.db). Nothing
in this file writes to GHL, ever — see that doc's §7 point "the store is a
read-only mirror" and the Sequenced Plan's own Step 1 description.

NOT SCHEDULED YET, ON PURPOSE. GHL_REPLACEMENT_ANALYSIS.md §8's Step 0
gate ("do not build Step 1+ before Step 0's Twilio/SMS answer") is about
sizing the FULL replacement, not this narrow mirror — Kris asked to start
this "whilst we are waiting" (11/09/2026) — but this module still refuses
to run for real (see main()'s guard below) until:
  1. A GHL Private Integration token with contacts.readonly +
     opportunities.readonly scopes is in GHL_API_TOKEN (env var or
     tools/dashboard/.env — same pattern as service_account.json, see
     README.md), and GHL_LOCATION_ID is set.
  2. A human runs `python ghl_mirror.py --dry-run` first and reads the
     output, then re-runs without --dry-run and reviews what actually
     landed in dashboard.db, before this is ever put on a cron
     (tools/deploy/setup_dashboard.sh's timer pattern) — same
     preview-before-live discipline every Apps Script phase in this
     project already follows (CLAUDE.md).

Field names below are NOT guessed cold — they're the same ones this
project's own Apps Script GHL integration (Phase9_GhlSync.gs,
Phase13_LeadReconciliation.gs, Phase15_CrmOrganizationReview.gs,
Phase14_GhlStageTriage.gs) already confirmed live against the real API:
contact.id/name/firstName/lastName/tags, opportunity.id/pipelineId/
pipelineStageId/monetaryValue/updatedAt/lastStatusChangeAt/dateAdded, and
the /contacts/, /contacts/{id}/appointments, /opportunities/search
endpoints. Anywhere this module needs a field NONE of those files has
touched yet (opportunity.contactId, opportunity.status, contact.email/
phone/source — plausible from GHL's own docs but not yet seen in a real
response from THIS account), it's marked UNVERIFIED below so the first
real run is deliberately the verification step, not a silent assumption —
same contract as ghlApiGet_'s own header comment (Phase9_GhlSync.gs).
"""
import argparse
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = os.environ.get("DASHBOARD_DB_PATH", str(BASE_DIR / "dashboard.db"))

GHL_API_BASE = os.environ.get("GHL_API_BASE", "https://services.leadconnectorhq.com")
GHL_API_VERSION = os.environ.get("GHL_API_VERSION", "2021-07-28")  # matches GHL_CONFIG.API_VERSION, Phase9_GhlSync.gs
GHL_API_TOKEN = os.environ.get("GHL_API_TOKEN")  # Private Integration token; contacts.readonly + opportunities.readonly
GHL_LOCATION_ID = os.environ.get("GHL_LOCATION_ID")

PAGE_LIMIT = 100


def init_ghl_schema(conn):
    """Additive to sync.py's init_schema — call both against the same
    connection. Reuses that file's existing `sync_meta` table for
    last-synced bookkeeping (key 'ghl_last_synced_at') rather than a
    second one, same "one meta table" convention already in place there.
    """
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS ghl_contacts (
            ghl_id TEXT PRIMARY KEY,
            name TEXT, first_name TEXT, last_name TEXT,
            email TEXT, phone TEXT, source TEXT, owner_id TEXT,
            date_added TEXT, date_updated TEXT, synced_at TEXT
        );
        CREATE TABLE IF NOT EXISTS ghl_contact_tags (
            contact_ghl_id TEXT, tag TEXT,
            PRIMARY KEY (contact_ghl_id, tag)
        );
        CREATE TABLE IF NOT EXISTS ghl_opportunities (
            ghl_id TEXT PRIMARY KEY,
            contact_ghl_id TEXT,
            pipeline_id TEXT, pipeline_stage_id TEXT, pipeline_stage_name TEXT,
            status TEXT, monetary_value REAL,
            date_added TEXT, date_updated TEXT, last_status_change_at TEXT,
            synced_at TEXT
        );
        -- The one thing GHL itself doesn't retain (GHL_REPLACEMENT_ANALYSIS.md
        -- §7 point 2) -- but only from whenever this importer FIRST sees an
        -- opportunity onward. A row here means "we personally observed this
        -- opportunity's stage change between two of our own sync runs," not
        -- "this is the opportunity's complete history since it was created."
        CREATE TABLE IF NOT EXISTS ghl_opportunity_stage_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            opportunity_ghl_id TEXT,
            from_stage_id TEXT, to_stage_id TEXT,
            observed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS ghl_appointments (
            ghl_id TEXT PRIMARY KEY,
            contact_ghl_id TEXT, calendar_id TEXT, title TEXT,
            start_time TEXT, end_time TEXT, status TEXT,
            synced_at TEXT
        );
        CREATE TABLE IF NOT EXISTS sync_meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        """
    )
    conn.commit()


def normalize_contact(raw, synced_at):
    """Pure — real GHL contact JSON in, our row shape out. `name`/
    `firstName`/`lastName`/`id` are confirmed-live field names (see module
    header); `email`/`phone`/`source`/`dateAdded`/`dateUpdated`/`tags` are
    UNVERIFIED against this account specifically, but match GHL's own v2
    API docs and are the obvious candidates -- flagged here, not silently
    trusted, exactly so a real run's first mismatch is easy to find.
    """
    return {
        "ghl_id": raw.get("id"),
        "name": raw.get("name") or ((raw.get("firstName") or "") + " " + (raw.get("lastName") or "")).strip(),
        "first_name": raw.get("firstName"),
        "last_name": raw.get("lastName"),
        "email": raw.get("email"),  # UNVERIFIED
        "phone": raw.get("phone"),  # UNVERIFIED
        "source": raw.get("source"),  # UNVERIFIED
        "owner_id": raw.get("assignedTo"),  # UNVERIFIED
        "date_added": raw.get("dateAdded"),  # UNVERIFIED
        "date_updated": raw.get("dateUpdated"),  # UNVERIFIED
        "synced_at": synced_at,
        "tags": [t for t in (raw.get("tags") or []) if t],  # UNVERIFIED shape (assumed list of strings)
    }


def normalize_opportunity(raw, synced_at):
    """Pure — same contract as normalize_contact. Confirmed live (11/09/2026,
    real --inspect output against this account): id/name/monetaryValue/
    pipelineId/pipelineStageId/status/source/contactId/createdAt/updatedAt/
    lastStatusChangeAt, plus a nested `contact` object (id/name/companyName/
    email/phone/tags/score) attached to every opportunity. contactId's
    UNVERIFIED flag is now resolved -- it's real. `date_added` used to read
    `dateAdded`, which doesn't exist on an opportunity at all (that's a
    CONTACT field) -- opportunities use `createdAt`. pipeline_stage_name
    resolution still needs a pipelines lookup (see resolve_stage_name below),
    same as Phase14_GhlStageTriage.gs/Phase15_CrmOrganizationReview.gs
    already do against a fetched pipelines list.
    """
    return {
        "ghl_id": raw.get("id"),
        "contact_ghl_id": raw.get("contactId"),
        "pipeline_id": raw.get("pipelineId"),
        "pipeline_stage_id": raw.get("pipelineStageId"),
        "pipeline_stage_name": None,  # filled by resolve_stage_name, needs the pipelines list
        "status": raw.get("status"),
        "monetary_value": raw.get("monetaryValue"),
        "date_added": raw.get("createdAt"),
        "date_updated": raw.get("updatedAt"),
        "last_status_change_at": raw.get("lastStatusChangeAt"),
        "synced_at": synced_at,
    }


def resolve_stage_name(pipelines, pipeline_id, stage_id):
    """Same lookup Phase14_GhlStageTriage.gs/Phase15_CrmOrganizationReview.gs
    already do live: `pipelines` is the raw list from GET /opportunities/pipelines
    (each with its own `stages` list of {id, name}). Returns the stage id
    itself if no match, same "never blank, worst case shows the raw id"
    fallback those two files use.
    """
    pipeline = next((p for p in pipelines if p.get("id") == pipeline_id), None)
    stages = (pipeline or {}).get("stages") or []
    stage = next((s for s in stages if s.get("id") == stage_id), None)
    return (stage or {}).get("name") or stage_id


def upsert_contacts(conn, contacts):
    """contacts: list of normalize_contact() output dicts. Replaces each
    contact's tag membership wholesale (delete-then-insert) rather than
    diffing, since GHL's own tag list on the contact IS the current truth
    -- there's no "did the tag change" signal worth keeping, unlike stage
    history below, where the CHANGE itself is the point."""
    for c in contacts:
        conn.execute(
            """
            INSERT INTO ghl_contacts (ghl_id, name, first_name, last_name, email, phone,
                source, owner_id, date_added, date_updated, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ghl_id) DO UPDATE SET
                name=excluded.name, first_name=excluded.first_name, last_name=excluded.last_name,
                email=excluded.email, phone=excluded.phone, source=excluded.source,
                owner_id=excluded.owner_id, date_added=excluded.date_added,
                date_updated=excluded.date_updated, synced_at=excluded.synced_at
            """,
            (c["ghl_id"], c["name"], c["first_name"], c["last_name"], c["email"], c["phone"],
             c["source"], c["owner_id"], c["date_added"], c["date_updated"], c["synced_at"]),
        )
        conn.execute("DELETE FROM ghl_contact_tags WHERE contact_ghl_id = ?", (c["ghl_id"],))
        conn.executemany(
            "INSERT OR IGNORE INTO ghl_contact_tags (contact_ghl_id, tag) VALUES (?, ?)",
            [(c["ghl_id"], tag) for tag in c.get("tags", [])],
        )
    conn.commit()


def upsert_opportunities(conn, opportunities, observed_at):
    """opportunities: list of normalize_opportunity() output dicts, with
    pipeline_stage_name already filled in by the caller (resolve_stage_name).
    Records a ghl_opportunity_stage_history row whenever an opportunity
    ALREADY in our mirror shows a different pipeline_stage_id than last
    sync -- a brand-new opportunity (not yet in ghl_opportunities) never
    gets a history row for its initial stage, same "we only know what we
    personally observed" honesty as the module header's stage-history note.
    """
    for o in opportunities:
        existing = conn.execute(
            "SELECT pipeline_stage_id FROM ghl_opportunities WHERE ghl_id = ?", (o["ghl_id"],)
        ).fetchone()
        if existing is not None and existing[0] != o["pipeline_stage_id"]:
            conn.execute(
                """
                INSERT INTO ghl_opportunity_stage_history
                    (opportunity_ghl_id, from_stage_id, to_stage_id, observed_at)
                VALUES (?, ?, ?, ?)
                """,
                (o["ghl_id"], existing[0], o["pipeline_stage_id"], observed_at),
            )
        conn.execute(
            """
            INSERT INTO ghl_opportunities (ghl_id, contact_ghl_id, pipeline_id, pipeline_stage_id,
                pipeline_stage_name, status, monetary_value, date_added, date_updated,
                last_status_change_at, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ghl_id) DO UPDATE SET
                contact_ghl_id=excluded.contact_ghl_id, pipeline_id=excluded.pipeline_id,
                pipeline_stage_id=excluded.pipeline_stage_id, pipeline_stage_name=excluded.pipeline_stage_name,
                status=excluded.status, monetary_value=excluded.monetary_value,
                date_added=excluded.date_added, date_updated=excluded.date_updated,
                last_status_change_at=excluded.last_status_change_at, synced_at=excluded.synced_at
            """,
            (o["ghl_id"], o["contact_ghl_id"], o["pipeline_id"], o["pipeline_stage_id"],
             o["pipeline_stage_name"], o["status"], o["monetary_value"], o["date_added"],
             o["date_updated"], o["last_status_change_at"], o["synced_at"]),
        )
    conn.commit()


def upsert_appointments(conn, appointments, synced_at):
    """appointments: list of {ghl_id, contact_ghl_id, calendar_id, title,
    start_time, end_time, status} -- shape from GET /contacts/{id}/appointments
    (endpoint confirmed live, Phase9_GhlSync.gs's probeContact_-style calls;
    exact field names inside each appointment object UNVERIFIED, same
    caveat as normalize_contact/normalize_opportunity above)."""
    for a in appointments:
        conn.execute(
            """
            INSERT INTO ghl_appointments (ghl_id, contact_ghl_id, calendar_id, title,
                start_time, end_time, status, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ghl_id) DO UPDATE SET
                contact_ghl_id=excluded.contact_ghl_id, calendar_id=excluded.calendar_id,
                title=excluded.title, start_time=excluded.start_time, end_time=excluded.end_time,
                status=excluded.status, synced_at=excluded.synced_at
            """,
            (a["ghl_id"], a["contact_ghl_id"], a["calendar_id"], a["title"],
             a["start_time"], a["end_time"], a["status"], synced_at),
        )
    conn.commit()


def _ghl_client():
    import httpx  # imported here, not at module top, so tests exercising the pure functions
                   # above never need httpx importable / GHL creds set at all.

    if not GHL_API_TOKEN:
        raise RuntimeError("GHL_API_TOKEN is not set -- see this module's own docstring.")
    return httpx.Client(
        base_url=GHL_API_BASE,
        headers={
            "Authorization": "Bearer " + GHL_API_TOKEN,
            "Version": GHL_API_VERSION,
            "Accept": "application/json",
        },
        timeout=30.0,
    )


def _dateadded_to_epoch_millis(dateadded):
    """GHL's `dateAdded` on a contact is an ISO-8601 string
    ("2026-09-08T20:12:50.819Z"), but the /contacts/ endpoint's own
    `startAfter` cursor param wants that SAME instant as a millisecond
    epoch integer, not the ISO string itself. Real bug, confirmed live
    (11/09/2026): sending the raw ISO string as `startAfter` 422'd on the
    very first paginated request -- this is the fix, not a guess."""
    iso = dateadded.replace("Z", "+00:00") if dateadded.endswith("Z") else dateadded
    return int(datetime.fromisoformat(iso).timestamp() * 1000)


def fetch_all_contacts(client, location_id, log_every=10):
    """Paginated GET /contacts/, confirmed-live endpoint shape
    (ghlSearchContactByName_, Phase9_GhlSync.gs) -- `query` param omitted
    here since we want everyone, not a name match. Pagination params
    (startAfterId/startAfter) are GHL's own documented cursor style for
    this endpoint; startAfter must be a millisecond epoch integer (see
    _dateadded_to_epoch_millis's own header for why -- confirmed live,
    the ISO string 422'd).

    Prints progress every `log_every` pages -- real feedback, 11/09/2026:
    this account has 65,000+ contacts (650+ pages at PAGE_LIMIT=100), and
    with zero output between the start and the final count, a genuine
    multi-minute fetch looked identical to a hang. `log_every` is a
    parameter, not a hardcoded stderr call, so tests can pass a value that
    never fires without needing to mock print()."""
    contacts = []
    start_after_id = None
    start_after = None
    page_num = 0
    while True:
        page_num += 1
        params = {"locationId": location_id, "limit": PAGE_LIMIT}
        if start_after_id:
            params["startAfterId"] = start_after_id
            params["startAfter"] = start_after
        resp = client.get("/contacts/", params=params)
        resp.raise_for_status()
        body = resp.json()
        page = body.get("contacts") or body.get("data") or []
        if not page:
            break
        contacts.extend(page)
        if page_num % log_every == 0:
            print(f"  fetch_all_contacts: {len(contacts)} contact(s) so far (page {page_num})...", file=sys.stderr)
        if len(page) < PAGE_LIMIT:
            break
        start_after_id = page[-1].get("id")
        last_date_added = page[-1].get("dateAdded")
        start_after = _dateadded_to_epoch_millis(last_date_added) if last_date_added else None
    print(f"fetch_all_contacts: done, {len(contacts)} contact(s) total.", file=sys.stderr)
    return contacts


def fetch_all_pipelines(client, location_id):
    """GET /opportunities/pipelines -- same endpoint Phase14_GhlStageTriage.gs/
    Phase15_CrmOrganizationReview.gs already fetch live for their own stage
    lookups."""
    resp = client.get("/opportunities/pipelines", params={"locationId": location_id})
    resp.raise_for_status()
    return resp.json().get("pipelines") or []


def fetch_all_opportunities(client, location_id, log_every=10):
    """Paginated GET /opportunities/search -- confirmed-live endpoint
    (Phase14_GhlStageTriage.gs line ~209). `page`-based pagination per
    that file's own usage. Same periodic progress print as
    fetch_all_contacts, for the same reason -- see that function's own
    header."""
    opportunities = []
    page = 1
    while True:
        resp = client.get(
            "/opportunities/search",
            params={"location_id": location_id, "limit": PAGE_LIMIT, "page": page},
        )
        resp.raise_for_status()
        body = resp.json()
        batch = body.get("opportunities") or body.get("data") or []
        if not batch:
            break
        opportunities.extend(batch)
        if page % log_every == 0:
            print(f"  fetch_all_opportunities: {len(opportunities)} opportunity(ies) so far (page {page})...", file=sys.stderr)
        if len(batch) < PAGE_LIMIT:
            break
        page += 1
    print(f"fetch_all_opportunities: done, {len(opportunities)} opportunity(ies) total.", file=sys.stderr)
    return opportunities


def run_sync(conn, client, location_id, synced_at):
    """Orchestrates one full read-only pass: contacts, then opportunities
    (with stage-name resolution via pipelines), then appointments per
    contact. Returns a dict of counts for the caller to log -- no MailApp/
    Slack notification here, this is a batch job meant to run under
    tools/deploy's existing systemd timer pattern, same as sync.py."""
    raw_contacts = fetch_all_contacts(client, location_id)
    contacts = [normalize_contact(c, synced_at) for c in raw_contacts]
    upsert_contacts(conn, contacts)

    pipelines = fetch_all_pipelines(client, location_id)
    raw_opps = fetch_all_opportunities(client, location_id)
    opportunities = []
    for raw in raw_opps:
        opp = normalize_opportunity(raw, synced_at)
        opp["pipeline_stage_name"] = resolve_stage_name(pipelines, opp["pipeline_id"], opp["pipeline_stage_id"])
        opportunities.append(opp)
    upsert_opportunities(conn, opportunities, synced_at)

    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES ('ghl_last_synced_at', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (synced_at,),
    )
    conn.commit()

    return {"contacts": len(contacts), "opportunities": len(opportunities)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Fetch and print counts only -- writes nothing to dashboard.db.",
    )
    parser.add_argument(
        "--inspect", action="store_true",
        help="Fetch just ONE page of contacts and opportunities and pretty-print the first raw "
             "record of each -- diagnostic for confirming real field names against this account's "
             "actual API response shape, without doing a full 65k+ fetch. Writes nothing.",
    )
    args = parser.parse_args()

    if not GHL_API_TOKEN or not GHL_LOCATION_ID:
        print(
            "GHL_API_TOKEN and/or GHL_LOCATION_ID are not set. This module is Step 1 groundwork, "
            "not yet scheduled -- see its own docstring for the setup steps before running for real.",
            file=sys.stderr,
        )
        sys.exit(1)

    synced_at = datetime.now(timezone.utc).isoformat()
    client = _ghl_client()
    try:
        if args.inspect:
            import json as _json
            resp = client.get("/contacts/", params={"locationId": GHL_LOCATION_ID, "limit": 1})
            resp.raise_for_status()
            body = resp.json()
            contacts_page = body.get("contacts") or body.get("data") or []
            print("=== raw /contacts/ response top-level keys ===")
            print(list(body.keys()))
            print("=== raw first contact record ===")
            print(_json.dumps(contacts_page[0] if contacts_page else {}, indent=2, default=str))

            opp_resp = client.get(
                "/opportunities/search",
                params={"location_id": GHL_LOCATION_ID, "limit": 1, "page": 1},
            )
            opp_resp.raise_for_status()
            opp_body = opp_resp.json()
            opps_page = opp_body.get("opportunities") or opp_body.get("data") or []
            print("=== raw /opportunities/search response top-level keys ===")
            print(list(opp_body.keys()))
            print("=== raw first opportunity record ===")
            print(_json.dumps(opps_page[0] if opps_page else {}, indent=2, default=str))
            return
        if args.dry_run:
            raw_contacts = fetch_all_contacts(client, GHL_LOCATION_ID)
            raw_opps = fetch_all_opportunities(client, GHL_LOCATION_ID)
            print(f"--dry-run: would upsert {len(raw_contacts)} contact(s), {len(raw_opps)} opportunity(ies). "
                  "Nothing written.")
            return
        conn = sqlite3.connect(DB_PATH)
        init_ghl_schema(conn)
        counts = run_sync(conn, client, GHL_LOCATION_ID, synced_at)
        conn.close()
        print(f"ghl_mirror: synced {counts['contacts']} contact(s), {counts['opportunities']} opportunity(ies) "
              f"into {DB_PATH} at {synced_at}.")
    finally:
        client.close()


if __name__ == "__main__":
    main()
