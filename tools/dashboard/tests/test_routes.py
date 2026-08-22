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
