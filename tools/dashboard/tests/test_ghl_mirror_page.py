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


def _seed_contact(conn, ghl_id, name, email, tags=None, synced_at="2026-01-01T00:00:00+00:00", date_added=None):
    # date_added defaults to "now" so a bare _seed_contact() call never trips
    # app_module.GHL_MIRROR_STALE_DAYS's default filter by accident -- tests
    # that specifically exercise staleness pass an explicit old date_added.
    date_added = date_added or datetime.now(timezone.utc).isoformat()
    raw = {"id": ghl_id, "name": name, "email": email, "tags": tags or [], "dateAdded": date_added, "dateUpdated": date_added}
    contact = ghl_mirror.normalize_contact(raw, synced_at)
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
        # include_old=True: a contact with no opportunity at all is exactly
        # what the default filter now hides (see TestGhlMirrorRegressions'
        # own tests for that) -- this test is only about the render/shape
        # when one is force-shown, not about the filter itself.
        _seed_contact(conn, "c1", "No Opp Guy", "noopp@example.com")
        results = app_module.ghl_mirror_contacts(include_old=True)
        assert results[0]["opportunity"] is None

    def test_search_filters_by_name_or_email(self, conn):
        _seed_contact(conn, "c1", "Jane Doe", "jane@example.com")
        _seed_contact(conn, "c2", "John Smith", "john@otherdomain.com")
        results = app_module.ghl_mirror_contacts(search="jane", include_old=True)
        assert [c["name"] for c in results] == ["Jane Doe"]

        results = app_module.ghl_mirror_contacts(search="otherdomain", include_old=True)
        assert [c["name"] for c in results] == ["John Smith"]


class TestGhlMirrorContactsSort:
    def test_sort_by_value_desc_puts_the_highest_value_opportunity_first(self, conn):
        _seed_contact(conn, "c1", "Low Value", "low@example.com")
        _seed_contact(conn, "c2", "High Value", "high@example.com")
        _seed_opportunity(conn, "o1", "c1", "Booked", 100.0, "2026-01-01T00:00:00")
        _seed_opportunity(conn, "o2", "c2", "Booked", 900.0, "2026-01-01T00:00:00")
        results = app_module.ghl_mirror_contacts(sort="value", direction="desc")
        assert [c["name"] for c in results] == ["High Value", "Low Value"]

    def test_sort_by_added_asc_puts_the_oldest_contact_first(self, conn):
        recent = datetime.now(timezone.utc).isoformat()
        older = "2026-01-01T00:00:00+00:00"
        _seed_contact(conn, "c1", "Newer", "newer@example.com", date_added=recent)
        _seed_contact(conn, "c2", "Older", "older@example.com", date_added=older)
        _seed_opportunity(conn, "o1", "c1", "Booked", 0, recent)
        _seed_opportunity(conn, "o2", "c2", "Booked", 0, older)
        results = app_module.ghl_mirror_contacts(sort="added", direction="asc", include_old=True)
        assert [c["name"] for c in results] == ["Older", "Newer"]

    def test_unrecognized_sort_value_falls_back_to_name_instead_of_crashing(self, conn):
        _seed_contact(conn, "c1", "Amy Apple", "amy@example.com")
        _seed_contact(conn, "c2", "Zach Zebra", "zach@example.com")
        results = app_module.ghl_mirror_contacts(sort="'; DROP TABLE ghl_contacts; --", include_old=True)
        assert [c["name"] for c in results] == ["Amy Apple", "Zach Zebra"]


class TestGhlMirrorContactDetail:
    def test_returns_none_for_an_unknown_contact(self, conn):
        assert app_module.ghl_mirror_contact_detail("nope") is None

    def test_returns_full_record_with_all_tags_and_all_opportunities(self, conn):
        _seed_contact(conn, "c1", "Jane Doe", "jane@example.com", tags=["vip", "podcast-guest"])
        _seed_opportunity(conn, "o1", "c1", "Booked", 100.0, "2026-01-01T00:00:00")
        _seed_opportunity(conn, "o2", "c1", "Closed Won", 500.0, "2026-02-01T00:00:00")

        detail = app_module.ghl_mirror_contact_detail("c1")
        assert detail["name"] == "Jane Doe"
        assert set(detail["tags"]) == {"vip", "podcast-guest"}
        assert len(detail["opportunities"]) == 2, "must show EVERY opportunity, not just the latest"
        assert {o["pipeline_stage_name"] for o in detail["opportunities"]} == {"Booked", "Closed Won"}
        assert detail["appointments"] == []

    def test_includes_each_opportunitys_observed_stage_history(self, conn):
        _seed_contact(conn, "c1", "Jane Doe", "jane@example.com")
        ghl_mirror.upsert_opportunities(conn, [{
            "ghl_id": "o1", "contact_ghl_id": "c1", "pipeline_id": "p1",
            "pipeline_stage_id": "s1", "pipeline_stage_name": "New",
            "status": "open", "monetary_value": 0,
            "date_added": "2026-01-01", "date_updated": "2026-01-01",
            "last_status_change_at": "2026-01-01", "synced_at": "t1",
        }], "t1")
        ghl_mirror.upsert_opportunities(conn, [{
            "ghl_id": "o1", "contact_ghl_id": "c1", "pipeline_id": "p1",
            "pipeline_stage_id": "s2", "pipeline_stage_name": "Booked",
            "status": "open", "monetary_value": 0,
            "date_added": "2026-01-01", "date_updated": "2026-02-01",
            "last_status_change_at": "2026-02-01", "synced_at": "t2",
        }], "t2")
        detail = app_module.ghl_mirror_contact_detail("c1")
        assert detail["opportunities"][0]["stage_history"] == [
            {"opportunity_ghl_id": "o1", "from_stage_id": "s1", "to_stage_id": "s2", "observed_at": "t2"}
        ]


class TestGhlMirrorPipelineHelpers:
    def test_pipeline_columns_come_back_in_ghls_own_order_not_alphabetical(self, conn):
        ghl_mirror.upsert_pipelines(conn, [
            {"id": "p1", "name": "Sales Pipeline", "stages": [{"id": "s2", "name": "Zzz Stage"}, {"id": "s1", "name": "Aaa Stage"}]},
        ])
        columns = app_module.ghl_mirror_pipeline_columns()
        assert columns == [{
            "pipeline_id": "p1", "pipeline_name": "Sales Pipeline",
            "stages": [{"stage_id": "s2", "stage_name": "Zzz Stage"}, {"stage_id": "s1", "stage_name": "Aaa Stage"}],
        }]

    def test_pipeline_board_groups_contacts_by_stage(self, conn):
        ghl_mirror.upsert_pipelines(conn, [
            {"id": "p1", "name": "Sales Pipeline", "stages": [{"id": "s1", "name": "New"}, {"id": "s2", "name": "Booked"}]},
        ])
        _seed_contact(conn, "c1", "Jane Doe", "jane@example.com")
        _seed_contact(conn, "c2", "John Smith", "john@example.com")
        ghl_mirror.upsert_opportunities(conn, [{
            "ghl_id": "o1", "contact_ghl_id": "c1", "pipeline_id": "p1",
            "pipeline_stage_id": "s1", "pipeline_stage_name": "New",
            "status": "open", "monetary_value": 0,
            "date_added": "2026-01-01", "date_updated": datetime.now(timezone.utc).isoformat(),
            "last_status_change_at": "2026-01-01", "synced_at": "t1",
        }], "t1")
        ghl_mirror.upsert_opportunities(conn, [{
            "ghl_id": "o2", "contact_ghl_id": "c2", "pipeline_id": "p1",
            "pipeline_stage_id": "s2", "pipeline_stage_name": "Booked",
            "status": "open", "monetary_value": 0,
            "date_added": "2026-01-01", "date_updated": datetime.now(timezone.utc).isoformat(),
            "last_status_change_at": "2026-01-01", "synced_at": "t1",
        }], "t1")
        board = app_module.ghl_mirror_pipeline_board("p1")
        assert [c["name"] for c in board["s1"]] == ["Jane Doe"]
        assert [c["name"] for c in board["s2"]] == ["John Smith"]


class TestGhlMirrorRoutes:
    def test_contact_detail_page_renders(self, client, db_path, conn):
        _seed_contact(conn, "c1", "Jane Doe", "jane@example.com", tags=["vip"])
        _seed_opportunity(conn, "o1", "c1", "Booked", 250.0, "2026-01-01T00:00:00")
        resp = client.get("/ghl-mirror/c1")
        assert resp.status_code == 200
        assert "Jane Doe" in resp.text
        assert "Booked" in resp.text

    def test_contact_detail_page_404s_for_unknown_contact(self, client, db_path):
        resp = client.get("/ghl-mirror/nope")
        assert resp.status_code == 404

    def test_pipeline_page_renders_with_no_pipelines_mirrored(self, client, db_path):
        resp = client.get("/ghl-mirror/pipeline")
        assert resp.status_code == 200
        assert "No pipelines mirrored yet" in resp.text

    def test_pipeline_page_renders_columns_and_cards(self, client, db_path, conn):
        ghl_mirror.upsert_pipelines(conn, [
            {"id": "p1", "name": "Sales Pipeline", "stages": [{"id": "s1", "name": "New"}]},
        ])
        _seed_contact(conn, "c1", "Jane Doe", "jane@example.com")
        ghl_mirror.upsert_opportunities(conn, [{
            "ghl_id": "o1", "contact_ghl_id": "c1", "pipeline_id": "p1",
            "pipeline_stage_id": "s1", "pipeline_stage_name": "New",
            "status": "open", "monetary_value": 0,
            "date_added": "2026-01-01", "date_updated": datetime.now(timezone.utc).isoformat(),
            "last_status_change_at": "2026-01-01", "synced_at": "t1",
        }], "t1")
        resp = client.get("/ghl-mirror/pipeline")
        assert resp.status_code == 200
        assert "Sales Pipeline" in resp.text
        assert "Jane Doe" in resp.text


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


class TestGhlMirrorRegressions:
    """Bugs found by code review (11/09/2026), fixed the same day."""

    def test_search_escapes_like_wildcards(self, conn):
        _seed_contact(conn, "c1", "Jane Doe", "jane@example.com")
        _seed_contact(conn, "c2", "John Smith", "john@example.com")
        # A literal underscore/percent in the search box must not act as a
        # LIKE wildcard and match everyone.
        assert app_module.ghl_mirror_contacts(search="_") == []
        assert app_module.ghl_mirror_contacts(search="%") == []

    def test_tag_containing_a_comma_is_not_split_into_two_tags(self, conn):
        _seed_contact(conn, "c1", "Jane Doe", "jane@example.com", tags=["high value, referral"])
        results = app_module.ghl_mirror_contacts(include_old=True)
        assert results[0]["tags"] == ["high value, referral"]

    def test_freshness_survives_a_null_sync_meta_value(self, conn):
        # fromisoformat(None) raises TypeError (not ValueError) -- must still
        # degrade to "never synced", not 500. (An int value doesn't reach
        # this path: sync_meta.value has TEXT affinity, so SQLite coerces an
        # inserted int to its string form before fromisoformat ever sees it
        # -- NULL is the real way a non-string value reaches this code.)
        conn.execute("DELETE FROM sync_meta WHERE key = 'ghl_last_synced_at'")
        conn.execute("INSERT INTO sync_meta (key, value) VALUES ('ghl_last_synced_at', NULL)")
        conn.commit()
        result = app_module.ghl_freshness_status()
        assert result["level"] == "stale"
        assert result["last_synced_at"] is None

    def test_contacts_are_capped_at_the_limit(self, conn):
        for i in range(5):
            _seed_contact(conn, f"c{i}", f"Person {i}", f"p{i}@example.com")
        assert len(app_module.ghl_mirror_contacts(limit=3, include_old=True)) == 3

    def test_blank_name_contacts_sort_to_the_end_not_the_start(self, conn):
        # Real bug, confirmed live (11/09/2026): thousands of genuinely
        # nameless contacts (incomplete lead-ad submissions) sorted FIRST
        # under a plain ORDER BY name, since an empty string sorts before
        # any real name -- the default view was 100% junk on page 1.
        _seed_contact(conn, "c1", "", "noname@example.com")
        _seed_contact(conn, "c2", "Zach Zebra", "zach@example.com")
        _seed_contact(conn, "c3", "Amy Apple", "amy@example.com")
        results = app_module.ghl_mirror_contacts(include_old=True)
        names = [c["name"] for c in results]
        assert names == ["Amy Apple", "Zach Zebra", ""], \
            "real-named contacts must sort before the blank-name one, not after"

    def test_stale_contacts_hidden_by_default_but_shown_with_include_old(self, conn):
        # Kris's own call, 11/09/2026, looking at the real synced data:
        # "anything older than a year is probably garbage." Default view
        # must hide a contact whose most recent touch is older than
        # GHL_MIRROR_STALE_DAYS; include_old=True must show it again. Both
        # contacts get a real opportunity so this isolates the DATE check
        # specifically, not the separate "has no opportunity at all" check.
        from datetime import datetime, timedelta, timezone
        old_date = (datetime.now(timezone.utc) - timedelta(days=400)).isoformat()
        recent_date = datetime.now(timezone.utc).isoformat()
        _seed_contact(conn, "old1", "Old Stale Guy", "old@example.com", date_added=old_date)
        _seed_contact(conn, "new1", "Fresh New Guy", "new@example.com", date_added=recent_date)
        _seed_opportunity(conn, "o1", "old1", "Booked", 0, old_date)
        _seed_opportunity(conn, "o2", "new1", "Booked", 0, recent_date)

        default_results = app_module.ghl_mirror_contacts()
        assert [c["name"] for c in default_results] == ["Fresh New Guy"]

        all_results = app_module.ghl_mirror_contacts(include_old=True)
        assert {c["name"] for c in all_results} == {"Fresh New Guy", "Old Stale Guy"}

    def test_contacts_with_no_opportunity_at_all_are_hidden_by_default(self, conn):
        # Kris's own read of the real data, 11/09/2026: company names and
        # cold-outreach-tagged contacts ("denise - ...", "terri lam title")
        # with NO opportunity at all are almost certainly a separate
        # prospecting list living in the same GHL account, not real
        # coaching leads -- even with a perfectly fresh date_added.
        recent_date = datetime.now(timezone.utc).isoformat()
        _seed_contact(conn, "noopp1", "AAA Insurance", "noopp@example.com", date_added=recent_date)
        _seed_contact(conn, "hasopp1", "Real Lead", "real@example.com", date_added=recent_date)
        _seed_opportunity(conn, "o1", "hasopp1", "Booked", 0, recent_date)

        default_results = app_module.ghl_mirror_contacts()
        assert [c["name"] for c in default_results] == ["Real Lead"]

        all_results = app_module.ghl_mirror_contacts(include_old=True)
        assert {c["name"] for c in all_results} == {"Real Lead", "AAA Insurance"}

    def test_stale_count_matches_what_the_default_view_hides(self, conn):
        from datetime import datetime, timedelta, timezone
        old_date = (datetime.now(timezone.utc) - timedelta(days=400)).isoformat()
        _seed_contact(conn, "old1", "Old Stale Guy", "old@example.com", date_added=old_date)
        _seed_contact(conn, "old2", "Old Stale Two", "old2@example.com", date_added=old_date)
        assert app_module.ghl_mirror_stale_count() == 2
        assert app_module.ghl_mirror_stale_count(search="Old Stale Guy") == 1
