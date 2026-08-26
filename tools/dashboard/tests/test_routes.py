"""
End-to-end-ish tests for every route in app.py, via FastAPI's TestClient.
DASHBOARD_REQUIRE_LOGIN=false (set in conftest.py before app is imported)
means RequireLoginMiddleware no-ops, so these don't need a real OAuth flow.
"""
import app as app_module
from conftest import insert_call


def test_healthz_is_public_and_ok(client, db_path):
    resp = client.get("/healthz")
    assert resp.status_code == 200


def test_overview_page_renders(client, seeded_db):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "Alice" in resp.text
    assert b"<html" in resp.content.lower() or "<!doctype" in resp.text.lower() or "<div" in resp.text


def test_overview_page_renders_with_empty_db(client, db_path):
    # Day one, before sync.py has ever run — must not 500.
    resp = client.get("/")
    assert resp.status_code == 200


def test_rep_detail_page_renders(client, seeded_db):
    resp = client.get("/reps/Alice")
    assert resp.status_code == 200
    assert "Rebecca Stewart" in resp.text


def test_rep_detail_page_for_unknown_rep_still_200s(client, seeded_db):
    # No calls for this rep — should render an empty state, not error.
    resp = client.get("/reps/Nobody")
    assert resp.status_code == 200


def test_calls_page_renders(client, seeded_db):
    resp = client.get("/calls")
    assert resp.status_code == 200
    assert "Rebecca Stewart" in resp.text


def test_calls_page_with_filters(client, seeded_db):
    resp = client.get("/calls", params={"rep": "Bob", "min_score": 1, "max_score": 2})
    assert resp.status_code == 200
    assert "Nicole Freed" in resp.text


def test_calls_page_with_blank_score_filters_does_not_422(client, seeded_db):
    # Real bug (P1): a filter form submits min_score=/max_score= (empty
    # string, not an omitted param) when those fields are left blank —
    # previously typed as `int`, FastAPI rejected that with a 422.
    resp = client.get("/calls", params={"rep": "Bob", "min_score": "", "max_score": ""})
    assert resp.status_code == 200
    assert "Nicole Freed" in resp.text


def test_calls_page_with_search_query(client, seeded_db):
    resp = client.get("/calls", params={"q": "discovery"})
    assert resp.status_code == 200


def test_queue_page_renders(client, seeded_db):
    resp = client.get("/queue")
    assert resp.status_code == 200
    assert "Nicole Freed" in resp.text
    assert "Chad Davis" not in resp.text  # already reviewed


def test_queue_page_with_rep_filter(client, seeded_db):
    resp = client.get("/queue", params={"rep": "Bob"})
    assert resp.status_code == 200


def test_training_page_renders_including_playbooks(client, seeded_db):
    resp = client.get("/training")
    assert resp.status_code == 200
    # Playbooks are read from the real repo files (REPO_ROOT is not
    # monkeypatched — deliberately, so this is a real integration check
    # that render_playbook() and the templates it feeds actually agree).
    assert "Playbooks" in resp.text


def test_training_page_search(client, seeded_db):
    resp = client.get("/training", params={"q": "objection"})
    assert resp.status_code == 200


def test_charts_page_renders(client, seeded_db):
    resp = client.get("/charts")
    assert resp.status_code == 200


def test_api_charts_default_granularity(client, seeded_db):
    resp = client.get("/api/charts")
    assert resp.status_code == 200
    body = resp.json()
    assert "score_over_time" in body
    assert "rep_summary" in body


def test_api_charts_invalid_granularity_falls_back_to_week(client, seeded_db):
    # Must not 422/500 on a bad query param — falls back silently per app.py.
    resp = client.get("/api/charts", params={"granularity": "fortnight"})
    assert resp.status_code == 200


def test_api_charts_all_granularities(client, seeded_db):
    for g in ("day", "week", "month", "year", "all"):
        resp = client.get("/api/charts", params={"granularity": g})
        assert resp.status_code == 200, g


def test_api_leads_endpoint(client, seeded_db):
    resp = client.get("/api/leads", params={"rep": "Alice"})
    assert resp.status_code == 200
    leads = resp.json()["leads"]
    assert all(l["rep"] == "Alice" for l in leads)


def test_api_leads_with_no_filters_returns_everything(client, seeded_db):
    resp = client.get("/api/leads")
    assert resp.status_code == 200
    assert len(resp.json()["leads"]) == 9


def test_require_login_gate_redirects_when_enabled(client, seeded_db, monkeypatch):
    """The one thing every other test in this file deliberately disables:
    confirm RequireLoginMiddleware actually redirects to /login when
    DASHBOARD_REQUIRE_LOGIN is left at its true default."""
    monkeypatch.setenv("DASHBOARD_REQUIRE_LOGIN", "true")
    resp = client.get("/", follow_redirects=False)
    assert resp.status_code in (302, 303, 307)
    assert resp.headers["location"] == "/login"


def test_require_login_gate_allows_public_paths(client, seeded_db, monkeypatch):
    monkeypatch.setenv("DASHBOARD_REQUIRE_LOGIN", "true")
    resp = client.get("/healthz")
    assert resp.status_code == 200


def test_overview_shows_outcome_coverage_and_averages(client, db_path, conn):
    insert_call(conn, rep="Alice", outcome_disposition="Sold", call_quality_score=5)
    insert_call(conn, rep="Alice", outcome_disposition="", call_quality_score=2)
    conn.commit()
    resp = client.get("/")
    assert resp.status_code == 200
    assert "Outcome vs. score" in resp.text
    assert "Sold" in resp.text
    # The coverage gap must be linked, not just counted — it is the number
    # anyone is meant to act on while the column is still mostly empty.
    assert f"/calls?outcome_disposition={app_module.OUTCOME_MISSING}" in resp.text


def test_overview_explains_itself_when_no_outcomes_logged(client, seeded_db):
    # The live state this shipped into: nothing logged anywhere. Must render
    # an explanation, not an empty table implying there is no data pipeline.
    resp = client.get("/")
    assert resp.status_code == 200
    assert "No outcomes logged yet" in resp.text


def test_calls_page_filters_by_outcome(client, db_path, conn):
    insert_call(conn, prospect_name="Sold One", outcome_disposition="Sold")
    insert_call(conn, prospect_name="Lost One", outcome_disposition="Not Sold")
    conn.commit()
    resp = client.get("/calls?outcome_disposition=Sold")
    assert resp.status_code == 200
    assert "Sold One" in resp.text
    assert "Lost One" not in resp.text


def test_calls_page_filters_to_calls_missing_an_outcome(client, db_path, conn):
    insert_call(conn, prospect_name="Logged", outcome_disposition="Sold")
    insert_call(conn, prospect_name="Unlogged", outcome_disposition="")
    conn.commit()
    resp = client.get(f"/calls?outcome_disposition={app_module.OUTCOME_MISSING}")
    assert resp.status_code == 200
    assert "Unlogged" in resp.text
    assert "Logged" not in resp.text


def test_rep_detail_shows_that_reps_outcomes_only(client, db_path, conn):
    insert_call(conn, rep="Alice", outcome_disposition="Sold", call_quality_score=5)
    insert_call(conn, rep="Bob", outcome_disposition="No-show", call_quality_score=1)
    conn.commit()
    resp = client.get("/reps/Alice")
    assert resp.status_code == 200
    assert "Sold" in resp.text
    assert "No-show" not in resp.text


def test_rep_detail_shows_weekly_history_in_order(client, db_path, conn):
    conn.execute(
        "INSERT INTO scorecard_history (rep, week_start, week_end, calls_this_week, weekly_avg_score, "
        "rolling_4_week_avg, historic_avg_before_week, priority_to_improve, worst_call, worst_call_score, "
        "missing_outcome_disposition, sent_at) VALUES "
        "('Alice', '2026-08-17', '2026-08-23', 5, 3.2, 3.0, 2.9, 'Ask for the close', 'Bad Call', 1, 2, 'x'), "
        "('Alice', '2026-08-10', '2026-08-16', 4, 2.5, 2.8, 2.9, 'Handle objections', 'Worse Call', 1, 3, 'x')"
    )
    conn.commit()
    resp = client.get("/reps/Alice")
    assert resp.status_code == 200
    assert "Weekly history" in resp.text
    # Oldest week first (chronological, left-to-right reading of progress).
    assert resp.text.index("2026-08-10") < resp.text.index("2026-08-17")


def test_rep_detail_shows_no_weekly_history_section_when_none_sent_yet(client, db_path, conn):
    insert_call(conn, rep="Alice")
    conn.commit()
    resp = client.get("/reps/Alice")
    assert "Weekly history" not in resp.text


def test_rep_detail_shows_that_reps_own_playbook_not_the_whole_list(client, db_path):
    # REPO_ROOT is not mocked here — this is a real integration check that
    # rep_playbook() actually finds Sean's real playbook file and only his.
    resp = client.get("/reps/Sean")
    assert resp.status_code == 200
    assert "Objection Handling Playbook — Sean" in resp.text
    assert "Objection Handling Playbook — Bens" not in resp.text


def test_rep_detail_shows_joanas_own_playbook(client, db_path):
    # v1 built 25/08/2026 from her real flagged calls — real integration
    # check, same as the Sean one above.
    resp = client.get("/reps/Joana")
    assert resp.status_code == 200
    assert "Objection Handling Playbook — Joana" in resp.text
    assert "No objection-handling playbook exists" not in resp.text


def test_rep_detail_shows_missing_playbook_notice_for_a_rep_with_none(client, db_path):
    resp = client.get("/reps/SomeoneElse")
    assert resp.status_code == 200
    assert "No objection-handling playbook exists for SomeoneElse yet." in resp.text


def test_outcome_pages_render_on_empty_db(client, db_path):
    # Day one, before sync.py has ever run.
    for url in ("/", "/calls", f"/calls?outcome_disposition={app_module.OUTCOME_MISSING}", "/reps/Nobody"):
        assert client.get(url).status_code == 200


def test_overview_shows_framework_coverage_and_gaps(client, db_path, conn):
    insert_call(conn, rep="Alice", flag_framework_explained=1, framework_gaps="")
    insert_call(conn, rep="Alice", flag_framework_explained=0, framework_gaps="recruit agents")
    conn.commit()
    resp = client.get("/")
    assert resp.status_code == 200
    assert "Framework explanation gaps" in resp.text
    assert "recruit agents" in resp.text
    assert f"/calls?rep=Alice&framework_explained=yes" in resp.text


def test_calls_page_filters_by_framework_explained(client, db_path, conn):
    insert_call(conn, prospect_name="Covered", flag_framework_explained=1)
    insert_call(conn, prospect_name="Gap", flag_framework_explained=0, framework_gaps="sell more houses")
    conn.commit()
    resp = client.get("/calls?framework_explained=no")
    assert resp.status_code == 200
    assert "Gap" in resp.text
    assert "Covered" not in resp.text


def test_rep_detail_shows_framework_gaps_card(client, db_path, conn):
    insert_call(conn, rep="Alice", flag_framework_explained=0, framework_gaps="recruit agents")
    conn.commit()
    resp = client.get("/reps/Alice")
    assert resp.status_code == 200
    assert "Framework explanation gaps" in resp.text
    assert "recruit agents" in resp.text


def test_training_page_shows_framework_drill(client, db_path, conn):
    conn.execute(
        "INSERT INTO training_assignments (rep, training_framework_json, last_updated) VALUES (?, ?, ?)",
        ("Alice", '[{"topic": "number_one_podcast", "note": "lead with the city angle"}]', "2026-08-25"),
    )
    conn.commit()
    resp = client.get("/training")
    assert resp.status_code == 200
    assert "#1 podcast in your city" in resp.text
    assert "lead with the city angle" in resp.text


def test_framework_pages_render_on_empty_db(client, db_path):
    for url in ("/", "/calls", "/calls?framework_explained=no", "/reps/Nobody", "/training"):
        assert client.get(url).status_code == 200
