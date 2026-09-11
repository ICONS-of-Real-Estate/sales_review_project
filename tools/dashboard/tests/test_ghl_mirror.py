"""
Unit tests for ghl_mirror.py's pure normalization/upsert logic. No real GHL
API calls or httpx import needed for any of these -- see that module's own
_ghl_client() comment on why httpx is imported lazily. Exercises exactly the
same "real bug would show up here" cases the rest of this project's test
discipline demands: an opportunity changing stage between two syncs, a
contact's tags being fully replaced (not just added to), and a brand-new
opportunity NOT generating a spurious history row for its initial stage.
"""
import sqlite3

import pytest

import ghl_mirror


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:")
    ghl_mirror.init_ghl_schema(c)
    yield c
    c.close()


class TestNormalizeContact:
    def test_prefers_name_field_but_falls_back_to_first_plus_last(self):
        assert ghl_mirror.normalize_contact({"id": "c1", "firstName": "Jane", "lastName": "Doe"}, "t")["name"] == "Jane Doe"
        assert ghl_mirror.normalize_contact({"id": "c1", "name": "Jane Doe Jr"}, "t")["name"] == "Jane Doe Jr"

    def test_tags_defaults_to_empty_list_and_drops_falsy_entries(self):
        assert ghl_mirror.normalize_contact({"id": "c1"}, "t")["tags"] == []
        assert ghl_mirror.normalize_contact({"id": "c1", "tags": ["vip", "", None, "lead"]}, "t")["tags"] == ["vip", "lead"]


class TestResolveStageName:
    def test_finds_stage_name_across_the_right_pipeline(self):
        pipelines = [
            {"id": "p1", "stages": [{"id": "s1", "name": "New"}, {"id": "s2", "name": "Booked"}]},
            {"id": "p2", "stages": [{"id": "s1", "name": "Different pipeline, same stage id"}]},
        ]
        assert ghl_mirror.resolve_stage_name(pipelines, "p1", "s2") == "Booked"

    def test_falls_back_to_the_raw_stage_id_when_nothing_matches(self):
        assert ghl_mirror.resolve_stage_name([], "p1", "s2") == "s2"


class TestUpsertContacts:
    def test_insert_then_update_replaces_fields_and_tags_wholesale(self, conn):
        c1 = ghl_mirror.normalize_contact({"id": "c1", "name": "Jane Doe", "tags": ["vip"]}, "t1")
        ghl_mirror.upsert_contacts(conn, [c1])
        row = conn.execute("SELECT name FROM ghl_contacts WHERE ghl_id = 'c1'").fetchone()
        assert row[0] == "Jane Doe"
        tags = {r[0] for r in conn.execute("SELECT tag FROM ghl_contact_tags WHERE contact_ghl_id = 'c1'")}
        assert tags == {"vip"}

        c1_updated = ghl_mirror.normalize_contact({"id": "c1", "name": "Jane D.", "tags": ["lead"]}, "t2")
        ghl_mirror.upsert_contacts(conn, [c1_updated])
        row = conn.execute("SELECT name, synced_at FROM ghl_contacts WHERE ghl_id = 'c1'").fetchone()
        assert row == ("Jane D.", "t2")
        tags = {r[0] for r in conn.execute("SELECT tag FROM ghl_contact_tags WHERE contact_ghl_id = 'c1'")}
        assert tags == {"lead"}, "the old 'vip' tag must be gone, not just 'lead' added alongside it"

        assert conn.execute("SELECT COUNT(*) FROM ghl_contacts").fetchone()[0] == 1, \
            "must be an update, not a second row"


class TestUpsertOpportunities:
    def _opp(self, ghl_id, stage_id, synced_at):
        return {
            "ghl_id": ghl_id, "contact_ghl_id": "c1", "pipeline_id": "p1",
            "pipeline_stage_id": stage_id, "pipeline_stage_name": stage_id,
            "status": "open", "monetary_value": 100.0,
            "date_added": "2026-01-01", "date_updated": "2026-01-01",
            "last_status_change_at": "2026-01-01", "synced_at": synced_at,
        }

    def test_a_brand_new_opportunity_gets_no_stage_history_row(self, conn):
        ghl_mirror.upsert_opportunities(conn, [self._opp("o1", "s1", "t1")], "t1")
        history = conn.execute("SELECT * FROM ghl_opportunity_stage_history").fetchall()
        assert history == [], "we never observed this opportunity BEFORE this sync, so there's no real change to log"

    def test_a_real_stage_change_between_two_syncs_is_recorded(self, conn):
        ghl_mirror.upsert_opportunities(conn, [self._opp("o1", "s1", "t1")], "t1")
        ghl_mirror.upsert_opportunities(conn, [self._opp("o1", "s2", "t2")], "t2")
        history = conn.execute(
            "SELECT from_stage_id, to_stage_id, observed_at FROM ghl_opportunity_stage_history"
        ).fetchall()
        assert history == [("s1", "s2", "t2")]

        current = conn.execute("SELECT pipeline_stage_id FROM ghl_opportunities WHERE ghl_id = 'o1'").fetchone()
        assert current[0] == "s2"

    def test_re_syncing_the_same_stage_records_no_spurious_history(self, conn):
        ghl_mirror.upsert_opportunities(conn, [self._opp("o1", "s1", "t1")], "t1")
        ghl_mirror.upsert_opportunities(conn, [self._opp("o1", "s1", "t2")], "t2")
        history = conn.execute("SELECT * FROM ghl_opportunity_stage_history").fetchall()
        assert history == [], "same stage on re-sync must not look like a change"


class TestUpsertAppointments:
    def test_insert_then_update_by_ghl_id(self, conn):
        appt = {"ghl_id": "a1", "contact_ghl_id": "c1", "calendar_id": "cal1", "title": "Discovery",
                "start_time": "2026-01-01T10:00:00Z", "end_time": "2026-01-01T10:30:00Z", "status": "confirmed"}
        ghl_mirror.upsert_appointments(conn, [appt], "t1")
        appt["status"] = "showed"
        ghl_mirror.upsert_appointments(conn, [appt], "t2")
        row = conn.execute("SELECT status, synced_at FROM ghl_appointments WHERE ghl_id = 'a1'").fetchone()
        assert row == ("showed", "t2")
        assert conn.execute("SELECT COUNT(*) FROM ghl_appointments").fetchone()[0] == 1


class TestMainGuard:
    def test_main_refuses_to_run_without_a_token_or_location_configured(self, monkeypatch, capsys):
        monkeypatch.setattr(ghl_mirror, "GHL_API_TOKEN", None)
        monkeypatch.setattr(ghl_mirror, "GHL_LOCATION_ID", None)
        monkeypatch.setattr("sys.argv", ["ghl_mirror.py"])
        with pytest.raises(SystemExit) as exc_info:
            ghl_mirror.main()
        assert exc_info.value.code == 1
