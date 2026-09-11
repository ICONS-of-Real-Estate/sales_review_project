"""
Tests for the /ghl-mirror read surface (app.py's ghl_mirror_contacts() query
+ route) — GHL_REPLACEMENT_ANALYSIS.md Step 2. Seeds ghl_mirror.py's own
tables directly via its upsert functions, same "seed through the real
write path, not hand-crafted INSERTs" discipline the rest of this test
suite already follows for sales_call_log (see conftest.py's insert_call).
"""
from datetime import datetime, timezone

import app as app_module
import ghl_mirror


def _seed_contact(conn, ghl_id, name, email, tags=None, synced_at="2026-01-01T00:00:00+00:00"):
    contact = ghl_mirror.normalize_contact({"id": ghl_id, "name": name, "email": email, "tags": tags or []}, synced_at)
    ghl_mirror.upsert_contacts(conn, [contact])


def _seed_opportunity(conn, ghl_id, contact_ghl_id, stage_name, monetary_value, date_updated, synced_at="2026-01-01T00:00:00+00:00"):
    opp = {
        "ghl_id": ghl_id, "contact_ghl_id": contact_ghl_id, "pipeline_id": "p1",
        "pipeline_stage_id": stage_name.lower(), "pipeline_stage_name": stage_name,
        "status": "open", "monetary_value": monetary_value,
        "date_added": date_updated, "date_updated": date_updated,
        "last_status_change_at": date_updated, "synced_at": synced_at,
    }
    ghl_mirror.upsert_opportunities(conn, [opp], synced_at)


class TestGhlMirrorContactsQuery:
    def test_returns_contacts_with_tags_and_latest_opportunity(self, conn):
        _seed_contact(conn, "c1", "Jane Doe", "jane@example.com", tags=["vip", "podcast-guest"])
        _seed_opportunity(conn, "o1", "c1", "Booked", 100.0, "2026-01-01T00:00:00")
        _seed_opportunity(conn, "o2", "c1", "Closed Won", 500.0, "2026-02-01T00:00:00")

        results = app_module.ghl_mirror_contacts()
        assert len(results) == 1
        c = results[0]
        assert c["name"] == "Jane Doe"
        assert set(c["tags"]) == {"vip", "podcast-guest"}
        assert c["opportunity"]["pipeline_stage_name"] == "Closed Won", "must pick the MOST RECENT opportunity by date_updated"

    def test_contact_with_no_opportunity_shows_none_not_a_crash(self, conn):
        _seed_contact(conn, "c1", "No Opp Guy", "noopp@example.com")
        results = app_module.ghl_mirror_contacts()
        assert results[0]["opportunity"] is None

    def test_search_filters_by_name_or_email(self, conn):
        _seed_contact(conn, "c1", "Jane Doe", "jane@example.com")
        _seed_contact(conn, "c2", "John Smith", "john@otherdomain.com")
        results = app_module.ghl_mirror_contacts(search="jane")
        assert [c["name"] for c in results] == ["Jane Doe"]

        results = app_module.ghl_mirror_contacts(search="otherdomain")
        assert [c["name"] for c in results] == ["John Smith"]


class TestGhlMirrorPage:
    def test_renders_empty_state_when_nothing_synced(self, client, db_path):
        resp = client.get("/ghl-mirror")
        assert resp.status_code == 200
        assert "Nothing mirrored yet" in resp.text

    def test_renders_contacts_and_search(self, client, db_path, conn):
        _seed_contact(conn, "c1", "Jane Doe", "jane@example.com", tags=["vip"])
        _seed_opportunity(conn, "o1", "c1", "Booked", 250.0, "2026-01-01T00:00:00")

        resp = client.get("/ghl-mirror")
        assert resp.status_code == 200
        assert "Jane Doe" in resp.text
        assert "Booked" in resp.text
        assert "vip" in resp.text

        resp = client.get("/ghl-mirror", params={"search": "nobody"})
        assert resp.status_code == 200
        assert "Jane Doe" not in resp.text
        assert "No contacts match" in resp.text

    def test_freshness_reads_ghl_specific_sync_meta_key(self, client, db_path, conn):
        conn.execute(
            "INSERT INTO sync_meta (key, value) VALUES ('ghl_last_synced_at', ?)",
            (datetime.now(timezone.utc).isoformat(),),
        )
        conn.commit()
        resp = client.get("/ghl-mirror")
        assert resp.status_code == 200
        assert "Never synced" not in resp.text
