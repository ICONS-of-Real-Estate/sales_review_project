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
    def test_prefers_raw_cased_first_last_over_the_lowercase_normalized_fields(self):
        # Real bug, confirmed live (11/09/2026): GHL's firstName/lastName are
        # lowercase-normalized ("saiyid"); firstNameRaw/lastNameRaw preserve
        # real casing ("Saiyid"). Every synced contact rendered lowercase on
        # /ghl-mirror until this preferred the Raw fields.
        raw = {"id": "c1", "firstName": "jane", "lastName": "doe", "firstNameRaw": "Jane", "lastNameRaw": "Doe"}
        assert ghl_mirror.normalize_contact(raw, "t")["name"] == "Jane Doe"

    def test_falls_back_to_lowercase_first_last_then_contactName_then_name(self):
        # No /contacts/ record actually has a top-level `name` field (that
        # only exists on an opportunity) -- contactName is the real
        # last-resort fallback, `name` kept only in case some other caller
        # ever hands this function a record shaped differently.
        assert ghl_mirror.normalize_contact({"id": "c1", "firstName": "Jane", "lastName": "Doe"}, "t")["name"] == "Jane Doe"
        assert ghl_mirror.normalize_contact({"id": "c1", "contactName": "jane doe jr"}, "t")["name"] == "jane doe jr"
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


class TestUpsertPipelines:
    def test_persists_pipeline_and_stage_order(self, conn):
        pipelines = [
            {"id": "p1", "name": "Sales Pipeline", "stages": [{"id": "s1", "name": "New"}, {"id": "s2", "name": "Booked"}]},
            {"id": "p2", "name": "Podcast Pipeline", "stages": [{"id": "s3", "name": "Recorded"}]},
        ]
        ghl_mirror.upsert_pipelines(conn, pipelines)
        rows = conn.execute(
            "SELECT pipeline_id, pipeline_name, pipeline_order, stage_id, stage_name, stage_order "
            "FROM ghl_pipelines ORDER BY pipeline_order, stage_order"
        ).fetchall()
        assert rows == [
            ("p1", "Sales Pipeline", 0, "s1", "New", 0),
            ("p1", "Sales Pipeline", 0, "s2", "Booked", 1),
            ("p2", "Podcast Pipeline", 1, "s3", "Recorded", 0),
        ]

    def test_re_syncing_replaces_the_old_list_wholesale(self, conn):
        # A stage renamed or removed in GHL itself must disappear here too --
        # same "GHL's own current list is the truth" contract as
        # upsert_contacts' tag replacement.
        ghl_mirror.upsert_pipelines(conn, [{"id": "p1", "name": "Old", "stages": [{"id": "s1", "name": "Stage A"}]}])
        ghl_mirror.upsert_pipelines(conn, [{"id": "p2", "name": "New", "stages": [{"id": "s9", "name": "Stage B"}]}])
        rows = conn.execute("SELECT pipeline_id, stage_id FROM ghl_pipelines").fetchall()
        assert rows == [("p2", "s9")]


class TestMainGuard:
    def test_main_refuses_to_run_without_a_token_or_location_configured(self, monkeypatch, capsys):
        monkeypatch.setattr(ghl_mirror, "GHL_API_TOKEN", None)
        monkeypatch.setattr(ghl_mirror, "GHL_LOCATION_ID", None)
        monkeypatch.setattr("sys.argv", ["ghl_mirror.py"])
        with pytest.raises(SystemExit) as exc_info:
            ghl_mirror.main()
        assert exc_info.value.code == 1


class TestDateAddedToEpochMillis:
    def test_converts_iso_z_suffix_to_millisecond_epoch(self):
        # Real bug, confirmed live (11/09/2026): sending the raw ISO string
        # as the /contacts/ endpoint's `startAfter` param 422'd -- it wants
        # a millisecond epoch integer for the same instant.
        result = ghl_mirror._dateadded_to_epoch_millis("2026-09-08T20:12:50.819Z")
        assert isinstance(result, int)
        # Round-trip: converting back must land on the same UTC instant.
        from datetime import datetime, timezone
        back = datetime.fromtimestamp(result / 1000, tz=timezone.utc)
        assert back.year == 2026 and back.month == 9 and back.day == 8
        assert back.hour == 20 and back.minute == 12 and back.second == 50


class TestFetchAllContactsPagination:
    def test_second_page_request_sends_startafter_as_an_epoch_int_not_the_raw_iso_string(self):
        """The real regression this fixes: the second paginated request
        used to pass the raw ISO dateAdded string as `startAfter`, which
        GHL's API rejects with a 422."""
        page1 = {"contacts": [{"id": f"c{i}", "dateAdded": "2026-09-08T20:12:50.819Z"} for i in range(100)]}
        page2 = {"contacts": [{"id": "c100", "dateAdded": "2026-09-09T00:00:00.000Z"}]}
        calls = []

        class FakeResponse:
            def __init__(self, body):
                self._body = body

            def raise_for_status(self):
                pass

            def json(self):
                return self._body

        class FakeClient:
            def get(self, path, params):
                calls.append(params)
                return FakeResponse(page1 if len(calls) == 1 else page2)

        result = ghl_mirror.fetch_all_contacts(FakeClient(), "loc1")
        assert len(result) == 101
        assert len(calls) == 2
        assert "startAfter" not in calls[0]
        assert isinstance(calls[1]["startAfter"], int), \
            "startAfter on the second request must be an epoch-millis int, not the raw ISO dateAdded string"


class TestFetchProgressLogging:
    """Kris's feedback, 11/09/2026: a real run against 65,000+ contacts
    (650+ pages) produced zero output until the very end and looked hung.
    These confirm progress prints actually fire during a long fetch."""

    def _paged_client(self, total_pages, page_size=100):
        class FakeResponse:
            def __init__(self, body):
                self._body = body

            def raise_for_status(self):
                pass

            def json(self):
                return self._body

        class FakeClient:
            def __init__(self):
                self.calls = 0

            def get(self, path, params):
                self.calls += 1
                page_num = self.calls
                if page_num > total_pages:
                    return FakeResponse({"contacts": [], "opportunities": []})
                size = page_size if page_num < total_pages else 1  # last page short, ends the loop
                items = [{"id": f"x{page_num}-{i}", "dateAdded": "2026-01-01T00:00:00.000Z"} for i in range(size)]
                return FakeResponse({"contacts": items, "opportunities": items})

        return FakeClient()

    def test_fetch_all_contacts_logs_progress_every_log_every_pages(self, capsys):
        client = self._paged_client(total_pages=3)
        ghl_mirror.fetch_all_contacts(client, "loc1", log_every=1)
        err = capsys.readouterr().err
        assert "page 1" in err and "page 2" in err
        assert "done, " in err

    def test_fetch_all_contacts_prints_nothing_mid_fetch_when_log_every_exceeds_page_count(self, capsys):
        client = self._paged_client(total_pages=2)
        ghl_mirror.fetch_all_contacts(client, "loc1", log_every=100)
        err = capsys.readouterr().err
        assert "so far" not in err, "must not print a progress line before log_every pages have gone by"
        assert "done, " in err, "the final summary must still print regardless of log_every"

    def test_fetch_all_opportunities_logs_progress_every_log_every_pages(self, capsys):
        client = self._paged_client(total_pages=3)
        ghl_mirror.fetch_all_opportunities(client, "loc1", log_every=1)
        err = capsys.readouterr().err
        assert "page 1" in err and "page 2" in err
        assert "done, " in err


class TestNormalizeOpportunity:
    def test_maps_real_ghl_response_shape(self):
        # Real --inspect output against the live account, 11/09/2026.
        raw = {
            "id": "D5TCi6Ys6SSq0ZGx71BX",
            "name": "Destiney “Alaska” Baker",
            "monetaryValue": 0,
            "pipelineId": "M7O9ZsPmczMyS7oP9m85",
            "pipelineStageId": "56c8783b-c960-43a4-90fe-db5581725326",
            "status": "open",
            "source": "Podcast Chat with Joana - Qualification Call",
            "lastStatusChangeAt": "2026-09-11T12:23:23.948Z",
            "createdAt": "2026-09-11T12:23:23.947Z",
            "updatedAt": "2026-09-11T12:23:23.947Z",
            "contactId": "lzhOk1GY985D1IY2id2S",
            "contact": {
                "id": "lzhOk1GY985D1IY2id2S", "name": "Destiney “Alaska” Baker",
                "email": "dbaker@paraclerealty.com", "phone": "+18036051427",
                "tags": ["calendar booked call"],
            },
        }
        result = ghl_mirror.normalize_opportunity(raw, "t1")
        assert result["ghl_id"] == "D5TCi6Ys6SSq0ZGx71BX"
        assert result["contact_ghl_id"] == "lzhOk1GY985D1IY2id2S"
        assert result["pipeline_id"] == "M7O9ZsPmczMyS7oP9m85"
        assert result["pipeline_stage_id"] == "56c8783b-c960-43a4-90fe-db5581725326"
        assert result["status"] == "open"
        assert result["monetary_value"] == 0
        # Real bug, confirmed live: opportunities have no `dateAdded` field at
        # all (that's a contact field) -- they use `createdAt`.
        assert result["date_added"] == "2026-09-11T12:23:23.947Z"
        assert result["date_updated"] == "2026-09-11T12:23:23.947Z"
        assert result["last_status_change_at"] == "2026-09-11T12:23:23.948Z"
