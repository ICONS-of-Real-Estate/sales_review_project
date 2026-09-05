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


# ---------------------------------------------------------------------------
# /review — Kris, 06/09/2026: "put it in an interface with a GREEN / RED
# button for [Tomás] to quickly review each?" One card at a time from
# crm_organization_review / lead_reconciliation, Approve/Reject writes back
# to the sheet via sheets_write.py (mocked below — no real network/creds).
# ---------------------------------------------------------------------------


def _insert_crm_row(conn, sheet_row=2, approve=0, reject=0, **overrides):
    row = {
        "sheet_row": sheet_row, "timestamp": "9/6/2026", "category": "Pipeline health",
        "finding": "Test finding", "evidence": "Test evidence", "suggested_action": "Test action",
        "approve": approve, "reject": reject,
    }
    row.update(overrides)
    cols = list(row.keys())
    conn.execute(
        f"INSERT INTO crm_organization_review ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})",
        [row[c] for c in cols],
    )


def _insert_lead_row(conn, sheet_row=2, real_lead=0, not_real_lead=0, likely_noise=0, **overrides):
    row = {
        "sheet_row": sheet_row, "timestamp": "9/6/2026", "name": "Test Lead", "email": "",
        "status": "not_found", "sources": "Sales Call Log:5", "likely_noise": likely_noise,
        "noise_reason": "", "ambiguous_matches": "", "real_lead": real_lead,
        "not_real_lead": not_real_lead, "dedupe_key": "name:test lead",
    }
    row.update(overrides)
    cols = list(row.keys())
    conn.execute(
        f"INSERT INTO lead_reconciliation ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})",
        [row[c] for c in cols],
    )


def test_review_index_renders_on_empty_db(client, db_path):
    resp = client.get("/review")
    assert resp.status_code == 200
    assert "0" in resp.text


def test_review_index_shows_counts_for_both_queues(client, db_path, conn):
    _insert_crm_row(conn, sheet_row=2)
    _insert_crm_row(conn, sheet_row=3)
    _insert_lead_row(conn, sheet_row=2)
    conn.commit()
    resp = client.get("/review")
    assert resp.status_code == 200
    assert "CRM findings pending review" in resp.text
    assert "Leads pending review" in resp.text


def test_review_crm_page_renders_on_empty_db(client, db_path):
    resp = client.get("/review/crm")
    assert resp.status_code == 200
    assert "Nothing left to review" in resp.text


def test_review_crm_page_shows_first_undecided_finding(client, db_path, conn):
    _insert_crm_row(conn, sheet_row=2, finding="Cold Calling 2 is 100% stuck")
    conn.commit()
    resp = client.get("/review/crm")
    assert resp.status_code == 200
    assert "Cold Calling 2 is 100% stuck" in resp.text
    assert "1 left to review" in resp.text


def test_review_crm_page_skips_already_decided_rows(client, db_path, conn):
    _insert_crm_row(conn, sheet_row=2, finding="Already approved", approve=1)
    _insert_crm_row(conn, sheet_row=3, finding="Still pending")
    conn.commit()
    resp = client.get("/review/crm")
    assert "Still pending" in resp.text
    assert "Already approved" not in resp.text


def test_review_leads_page_renders_on_empty_db(client, db_path):
    resp = client.get("/review/leads")
    assert resp.status_code == 200
    assert "Nothing left to review" in resp.text


def test_review_leads_page_candidates_view_filters_out_noise_by_default(client, db_path, conn):
    _insert_lead_row(conn, sheet_row=2, name="Noise Lead", likely_noise=1, noise_reason="newsletter, not a lead")
    conn.commit()
    resp = client.get("/review/leads")
    assert "Nothing left to review" in resp.text
    assert "more filtered out as likely noise" in resp.text


def test_review_leads_page_show_everything_includes_noise(client, db_path, conn):
    _insert_lead_row(conn, sheet_row=2, name="Noise Lead", likely_noise=1, noise_reason="newsletter, not a lead")
    conn.commit()
    resp = client.get("/review/leads?only_candidates=0")
    assert "Noise Lead" in resp.text


def test_review_crm_page_ignores_lead_reconciliation_rows(client, db_path, conn):
    """The whole point of the split (Kris, 06/09/2026): a pending lead must
    never show up on the CRM queue, and vice versa."""
    _insert_lead_row(conn, sheet_row=2, name="Some Lead")
    conn.commit()
    resp = client.get("/review/crm")
    assert "Some Lead" not in resp.text
    assert "Nothing left to review" in resp.text


def test_review_decide_approve_writes_to_sheet_and_updates_mirror(client, db_path, conn, monkeypatch):
    _insert_crm_row(conn, sheet_row=2, finding="Test finding")
    conn.commit()

    calls = []
    monkeypatch.setattr(
        app_module.sheets_write, "write_decision",
        lambda table, sheet_row, approve: calls.append((table, sheet_row, approve)),
    )
    resp = client.post(
        "/review/decide",
        data={"table": "crm_organization_review", "sheet_row": 2, "decision": "approve", "only_candidates": "1"},
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert resp.headers["location"] == "/review/crm"
    assert calls == [("crm_organization_review", 2, True)]

    row = conn.execute("SELECT approve, reject FROM crm_organization_review WHERE sheet_row = 2").fetchone()
    assert row == (1, 0)


def test_review_decide_reject_updates_lead_reconciliation_columns(client, db_path, conn, monkeypatch):
    _insert_lead_row(conn, sheet_row=9)
    conn.commit()

    monkeypatch.setattr(app_module.sheets_write, "write_decision", lambda table, sheet_row, approve: None)
    resp = client.post(
        "/review/decide",
        data={"table": "lead_reconciliation", "sheet_row": 9, "decision": "reject", "only_candidates": "1"},
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert resp.headers["location"] == "/review/leads?only_candidates=1"
    row = conn.execute("SELECT real_lead, not_real_lead FROM lead_reconciliation WHERE sheet_row = 9").fetchone()
    assert row == (0, 1)


def test_review_decide_unknown_table_is_rejected(client, db_path):
    resp = client.post(
        "/review/decide",
        data={"table": "some_typo", "sheet_row": 2, "decision": "approve", "only_candidates": "1"},
    )
    assert resp.status_code == 400


def test_review_decide_surfaces_sheet_write_failure_instead_of_pretending_success(client, db_path, conn, monkeypatch):
    """A missed write must not report success — that's the one thing this
    whole page exists to make happen reliably."""
    _insert_crm_row(conn, sheet_row=2)
    conn.commit()

    def _boom(table, sheet_row, approve):
        raise Exception("403 The caller does not have permission")

    monkeypatch.setattr(app_module.sheets_write, "write_decision", _boom)
    resp = client.post(
        "/review/decide",
        data={"table": "crm_organization_review", "sheet_row": 2, "decision": "approve", "only_candidates": "1"},
    )
    assert resp.status_code == 500
    assert "Could not save" in resp.text
    # And the local mirror must NOT have been updated as if it succeeded.
    row = conn.execute("SELECT approve, reject FROM crm_organization_review WHERE sheet_row = 2").fetchone()
    assert row == (0, 0)


def test_review_decide_failure_message_is_html_escaped_and_visible(client, db_path, conn, monkeypatch):
    """Real bug found live (06/09/2026): the error page showed nothing after
    "Could not save that decision to the spreadsheet:" — the exception text
    wasn't HTML-escaped, so a message containing something that looks like a
    tag (Google API error bodies can) rendered as invisible markup instead
    of visible text. The actual error text must always be readable, and
    never accidentally executed as HTML."""
    _insert_crm_row(conn, sheet_row=2)
    conn.commit()

    def _boom(table, sheet_row, approve):
        raise Exception("<permission denied> caller lacks Editor access & scope=spreadsheets")

    monkeypatch.setattr(app_module.sheets_write, "write_decision", _boom)
    resp = client.post(
        "/review/decide",
        data={"table": "crm_organization_review", "sheet_row": 2, "decision": "approve", "only_candidates": "1"},
    )
    assert resp.status_code == 500
    assert "&lt;permission denied&gt;" in resp.text
    assert "&amp;" in resp.text
    assert "<permission denied>" not in resp.text  # must never appear unescaped


# ---------------------------------------------------------------------------
# /review/history, /review/undo, /review/undo_all — Kris, 06/09/2026: "Add to
# be able to review all the changes in the interface with an UNDO and UNDO
# ALL button." Every decide writes a review_decisions_log row; undo clears
# both sheet checkboxes and marks the log entry undone.
# ---------------------------------------------------------------------------


def test_review_decide_logs_the_decision(client, db_path, conn, monkeypatch):
    _insert_crm_row(conn, sheet_row=2, category="Pipeline health", finding="Cold Calling 2 stuck")
    conn.commit()
    monkeypatch.setattr(app_module.sheets_write, "write_decision", lambda table, sheet_row, approve: None)

    client.post(
        "/review/decide",
        data={"table": "crm_organization_review", "sheet_row": 2, "decision": "approve", "only_candidates": "1"},
    )

    row = conn.execute(
        "SELECT table_name, sheet_row, decision, label, undone FROM review_decisions_log"
    ).fetchone()
    assert row == ("crm_organization_review", 2, "approve", "Pipeline health: Cold Calling 2 stuck", 0)


def test_review_decide_does_not_log_a_failed_write(client, db_path, conn, monkeypatch):
    """A decision that never reached the sheet must not show up in history
    as if it happened — that would make Undo lie about what it's undoing."""
    _insert_crm_row(conn, sheet_row=2)
    conn.commit()

    def _boom(table, sheet_row, approve):
        raise Exception("boom")

    monkeypatch.setattr(app_module.sheets_write, "write_decision", _boom)
    client.post(
        "/review/decide",
        data={"table": "crm_organization_review", "sheet_row": 2, "decision": "approve", "only_candidates": "1"},
    )
    count = conn.execute("SELECT COUNT(*) FROM review_decisions_log").fetchone()[0]
    assert count == 0


def test_review_history_page_renders_on_empty_db(client, db_path):
    resp = client.get("/review/history")
    assert resp.status_code == 200
    assert "No decisions made yet" in resp.text


def test_review_history_page_lists_logged_decisions(client, db_path, conn):
    conn.execute(
        "INSERT INTO review_decisions_log (table_name, sheet_row, decision, label, decided_by, decided_at, undone) "
        "VALUES ('crm_organization_review', 2, 'approve', 'Test finding', 'kris@iconsofrealestate.com', '2026-09-06T12:00:00', 0)"
    )
    conn.commit()
    resp = client.get("/review/history")
    assert "Test finding" in resp.text
    assert "kris@iconsofrealestate.com" in resp.text


def test_review_undo_clears_sheet_and_mirror_and_marks_log_undone(client, db_path, conn, monkeypatch):
    _insert_crm_row(conn, sheet_row=2, approve=1, reject=0)
    cur = conn.execute(
        "INSERT INTO review_decisions_log (table_name, sheet_row, decision, label, decided_by, decided_at, undone) "
        "VALUES ('crm_organization_review', 2, 'approve', 'Test finding', 'kris@iconsofrealestate.com', '2026-09-06T12:00:00', 0)"
    )
    log_id = cur.lastrowid
    conn.commit()

    calls = []
    monkeypatch.setattr(
        app_module.sheets_write, "clear_decision",
        lambda table, sheet_row: calls.append((table, sheet_row)),
    )
    resp = client.post("/review/undo", data={"log_id": log_id}, follow_redirects=False)
    assert resp.status_code == 303
    assert calls == [("crm_organization_review", 2)]

    mirror = conn.execute("SELECT approve, reject FROM crm_organization_review WHERE sheet_row = 2").fetchone()
    assert mirror == (0, 0)
    undone = conn.execute("SELECT undone FROM review_decisions_log WHERE id = ?", (log_id,)).fetchone()[0]
    assert undone == 1


def test_review_undo_already_undone_is_a_no_op(client, db_path, conn, monkeypatch):
    cur = conn.execute(
        "INSERT INTO review_decisions_log (table_name, sheet_row, decision, label, decided_by, decided_at, undone) "
        "VALUES ('crm_organization_review', 2, 'approve', 'Test finding', 'kris@iconsofrealestate.com', '2026-09-06T12:00:00', 1)"
    )
    log_id = cur.lastrowid
    conn.commit()

    calls = []
    monkeypatch.setattr(app_module.sheets_write, "clear_decision", lambda table, sheet_row: calls.append(1))
    resp = client.post("/review/undo", data={"log_id": log_id}, follow_redirects=False)
    assert resp.status_code == 303
    assert calls == []  # never even attempted a second sheet write


def test_review_undo_failure_does_not_mark_the_log_entry_undone(client, db_path, conn, monkeypatch):
    _insert_crm_row(conn, sheet_row=2, approve=1, reject=0)
    cur = conn.execute(
        "INSERT INTO review_decisions_log (table_name, sheet_row, decision, label, decided_by, decided_at, undone) "
        "VALUES ('crm_organization_review', 2, 'approve', 'Test finding', 'kris@iconsofrealestate.com', '2026-09-06T12:00:00', 0)"
    )
    log_id = cur.lastrowid
    conn.commit()

    def _boom(table, sheet_row):
        raise Exception("403 no permission")

    monkeypatch.setattr(app_module.sheets_write, "clear_decision", _boom)
    resp = client.post("/review/undo", data={"log_id": log_id})
    assert resp.status_code == 500

    undone = conn.execute("SELECT undone FROM review_decisions_log WHERE id = ?", (log_id,)).fetchone()[0]
    assert undone == 0
    mirror = conn.execute("SELECT approve, reject FROM crm_organization_review WHERE sheet_row = 2").fetchone()
    assert mirror == (1, 0)  # untouched — the failed undo must not silently revert the mirror either


def test_review_undo_all_reverts_every_active_decision(client, db_path, conn, monkeypatch):
    _insert_crm_row(conn, sheet_row=2, approve=1, reject=0)
    _insert_crm_row(conn, sheet_row=3, approve=0, reject=1)
    for sheet_row, decision in ((2, "approve"), (3, "reject")):
        conn.execute(
            "INSERT INTO review_decisions_log (table_name, sheet_row, decision, label, decided_by, decided_at, undone) "
            "VALUES ('crm_organization_review', ?, ?, 'Test finding', 'kris@iconsofrealestate.com', '2026-09-06T12:00:00', 0)",
            (sheet_row, decision),
        )
    conn.commit()

    calls = []
    monkeypatch.setattr(
        app_module.sheets_write, "clear_decision",
        lambda table, sheet_row: calls.append((table, sheet_row)),
    )
    resp = client.post("/review/undo_all", follow_redirects=False)
    assert resp.status_code == 303
    assert sorted(calls) == [("crm_organization_review", 2), ("crm_organization_review", 3)]

    rows = conn.execute("SELECT sheet_row, approve, reject FROM crm_organization_review ORDER BY sheet_row").fetchall()
    assert rows == [(2, 0, 0), (3, 0, 0)]
    undone_count = conn.execute("SELECT COUNT(*) FROM review_decisions_log WHERE undone = 1").fetchone()[0]
    assert undone_count == 2


def test_review_undo_all_reports_partial_failure_and_leaves_that_row_active(client, db_path, conn, monkeypatch):
    _insert_crm_row(conn, sheet_row=2, approve=1, reject=0)
    _insert_crm_row(conn, sheet_row=3, approve=1, reject=0)
    for sheet_row in (2, 3):
        conn.execute(
            "INSERT INTO review_decisions_log (table_name, sheet_row, decision, label, decided_by, decided_at, undone) "
            "VALUES ('crm_organization_review', ?, 'approve', 'Test finding', 'kris@iconsofrealestate.com', '2026-09-06T12:00:00', 0)",
            (sheet_row,),
        )
    conn.commit()

    def _flaky(table, sheet_row):
        if sheet_row == 3:
            raise Exception("boom")

    monkeypatch.setattr(app_module.sheets_write, "clear_decision", _flaky)
    resp = client.post("/review/undo_all", follow_redirects=False)
    assert resp.status_code == 303
    assert "message=" in resp.headers["location"]

    statuses = dict(conn.execute(
        "SELECT sheet_row, undone FROM review_decisions_log ORDER BY sheet_row"
    ).fetchall())
    assert statuses == {2: 1, 3: 0}  # row 2 undone, row 3's failure left it active
    row3 = conn.execute("SELECT approve, reject FROM crm_organization_review WHERE sheet_row = 3").fetchone()
    assert row3 == (1, 0)  # untouched since its undo failed


# ---------------------------------------------------------------------------
# lead_related_calls / /review/leads — Kris, 06/09/2026: "Need information
# on the leads too. He can't make a decision on this." A bare name and a
# "Sales Call Log:3" source citation isn't enough context — pull the actual
# matching call(s) from sales_call_log so Tomás can recognize who it is.
# ---------------------------------------------------------------------------


def test_lead_related_calls_matches_case_and_whitespace_insensitively(client, db_path, conn):
    insert_call(conn, prospect_name="  Lucy Quinones  ", rep="Sean", call_date="03/03/2026")
    conn.commit()
    calls = app_module.lead_related_calls("lucy quinones")
    assert len(calls) == 1
    assert calls[0]["rep"] == "Sean"


def test_lead_related_calls_returns_empty_for_blank_name(client, db_path):
    assert app_module.lead_related_calls("") == []
    assert app_module.lead_related_calls(None) == []


def test_lead_related_calls_returns_empty_when_nothing_matches(client, db_path, conn):
    insert_call(conn, prospect_name="Someone Else")
    conn.commit()
    assert app_module.lead_related_calls("Lucy Quinones") == []


def test_lead_related_calls_sorts_most_recent_first(client, db_path, conn):
    insert_call(conn, prospect_name="Repeat Caller", call_date="01/01/2026", rep="Alice")
    insert_call(conn, prospect_name="Repeat Caller", call_date="15/03/2026", rep="Bob")
    conn.commit()
    calls = app_module.lead_related_calls("Repeat Caller")
    assert [c["rep"] for c in calls] == ["Bob", "Alice"]


def test_review_leads_page_shows_related_call_context_for_the_visible_card(client, db_path, conn):
    _insert_lead_row(conn, sheet_row=2, name="Lucy Quinones")
    insert_call(
        conn, prospect_name="Lucy Quinones", rep="Sean", call_date="03/03/2026",
        call_type="Sales Call", outcome_disposition="Follow-up", call_quality_score=4,
        ai_feedback_summary="Distinctive feedback text for this call.",
    )
    conn.commit()
    resp = client.get("/review/leads")
    assert resp.status_code == 200
    assert "call(s) in the Sales Call Log for this name" in resp.text
    assert "Sean" in resp.text
    assert "Distinctive feedback text for this call." in resp.text


def test_review_leads_page_shows_fallback_message_when_no_related_call_found(client, db_path, conn):
    _insert_lead_row(conn, sheet_row=2, name="Nobody Anywhere")
    conn.commit()
    resp = client.get("/review/leads")
    assert "No matching Sales Call Log entry found" in resp.text
