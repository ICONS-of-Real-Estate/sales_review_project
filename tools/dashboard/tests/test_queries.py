"""
Tests for app.py's DB-backed business logic functions, against the shared
seeded_db fixture (see conftest.py for exactly what's in it).
"""
import sqlite3

import app as app_module
from conftest import insert_call


class TestFreshnessStatus:
    def test_no_sync_meta_row_is_stale(self, db_path):
        status = app_module.freshness_status()
        assert status["level"] == "stale"
        assert status["last_synced_at"] is None

    def test_recent_sync_is_ok(self, seeded_db):
        # seeded_db writes last_synced_at as "now", well under the 15-min warn threshold.
        status = app_module.freshness_status()
        assert status["level"] == "ok"
        assert status["age_minutes"] < 1


class TestRepSummary:
    def test_aggregates_per_rep(self, seeded_db):
        summary = {r["rep"]: r for r in app_module.rep_summary()}
        assert set(summary.keys()) == {"Alice", "Bob", "Carol"}

        alice = summary["Alice"]
        # Alice: Rebecca (4, close=1), Kit (3, close=1), Camryn (4, close=0) = 3 calls
        assert alice["total_calls"] == 3
        assert alice["avg_score"] == round((4 + 3 + 4) / 3, 2)
        assert alice["pct_asked_for_close"] == round(100 * 2 / 3)

    def test_excludes_blank_rep(self, db_path, conn):
        insert_call(conn, rep="", prospect_name="No Rep")
        insert_call(conn, rep="Alice", prospect_name="Has Rep")
        conn.commit()
        summary = app_module.rep_summary()
        assert [r["rep"] for r in summary] == ["Alice"]

    def test_manual_review_count(self, seeded_db):
        summary = {r["rep"]: r for r in app_module.rep_summary()}
        # Bob has Nicole Freed (flagged) and Joseph Brandley (flagged) = 2
        assert summary["Bob"]["manual_review_count"] == 2


class TestFailureModeBreakdown:
    def test_counts_by_mode_excluding_none(self, seeded_db):
        breakdown = {r["mode"]: r["count"] for r in app_module.failure_mode_breakdown()}
        assert breakdown.get("no_close_ask") == 1
        assert breakdown.get("objections_missed") == 1
        # "none" is a real value in the fixture but must not be excluded by
        # the "!= ''" filter — it's a legitimate failure_mode value, not blank.
        assert "none" in breakdown


class TestScoreOverTime:
    def test_continuous_weekly_buckets_with_nulls_for_gaps(self, seeded_db):
        data = app_module.score_over_time("week")
        alice = next(s for s in data["series"] if s["rep"] == "Alice")
        # Alice has calls in the week of 06/07 and 13/07, and 21/07 (week of 20/07).
        assert len(alice["data"]) == len(data["labels"])
        assert all(v is None or isinstance(v, float) for v in alice["data"])

    def test_all_granularity_collapses_to_one_bucket(self, seeded_db):
        data = app_module.score_over_time("all")
        assert data["labels"] == ["All time"]
        for s in data["series"]:
            assert len(s["data"]) == 1

    def test_empty_db_returns_empty_series(self, db_path):
        data = app_module.score_over_time("week")
        assert data == {"labels": [], "series": []}

    def test_null_scores_excluded_from_average(self, db_path, conn):
        # No Match Guy-style row: call_quality_score NULL must not blow up the average.
        insert_call(conn, rep="Dave", call_date="01/07/2026", call_quality_score=None)
        insert_call(conn, rep="Dave", call_date="01/07/2026", call_quality_score=4)
        conn.commit()
        data = app_module.score_over_time("week")
        dave = next(s for s in data["series"] if s["rep"] == "Dave")
        assert 4 in dave["data"]


class TestTrendAlerts:
    def test_flags_score_below_floor(self, db_path, conn):
        insert_call(conn, rep="Eve", call_date="01/07/2026", call_quality_score=1)
        conn.commit()
        alerts = app_module.trend_alerts(low_score_floor=2.5)
        assert any(a["rep"] == "Eve" for a in alerts)

    def test_flags_week_over_week_drop(self, db_path, conn):
        insert_call(conn, rep="Frank", call_date="01/07/2026", call_quality_score=5)
        insert_call(conn, rep="Frank", call_date="08/07/2026", call_quality_score=3)
        conn.commit()
        alerts = app_module.trend_alerts(threshold_drop=1.0, low_score_floor=0)
        frank_alerts = [a for a in alerts if a["rep"] == "Frank"]
        assert len(frank_alerts) == 1
        assert "dropped" in frank_alerts[0]["message"]

    def test_no_alert_for_stable_or_improving_scores(self, db_path, conn):
        insert_call(conn, rep="Grace", call_date="01/07/2026", call_quality_score=4)
        insert_call(conn, rep="Grace", call_date="08/07/2026", call_quality_score=5)
        conn.commit()
        alerts = app_module.trend_alerts(threshold_drop=1.0, low_score_floor=0)
        assert not any(a["rep"] == "Grace" for a in alerts)


class TestGetLeads:
    def test_filters_by_verdict(self, seeded_db):
        leads = app_module.get_leads(verdict="not_a_fit")
        assert len(leads) == 1
        assert leads[0]["prospect_name"] == "Joseph Brandley"

    def test_filters_by_rep_and_failure_mode_combined(self, seeded_db):
        leads = app_module.get_leads(rep="Alice", failure_mode="objections_missed")
        assert [l["prospect_name"] for l in leads] == ["Kit Corney"]

    def test_sorted_most_recent_first(self, seeded_db):
        leads = app_module.get_leads(rep="Alice")
        dates = [l["call_date"] for l in leads]
        assert dates == sorted(dates, key=app_module.parse_call_date, reverse=True)


class TestPipelineHealth:
    def test_counts_no_match_and_fallback(self, seeded_db):
        health = app_module.pipeline_health()
        assert health["unmatched"] == 1
        assert health["fallback_matched"] == 1


class TestReviewQueue:
    def test_only_unreviewed_flagged_rows(self, seeded_db):
        queue = app_module.review_queue()
        names = {r["prospect_name"] for r in queue}
        # Nicole Freed and Joseph Brandley are flagged and NOT reviewed.
        assert "Nicole Freed" in names
        assert "Joseph Brandley" in names
        # Chad Davis and Camryn Cisneros ARE reviewed (reviewed_by_kris='TRUE') — excluded.
        assert "Chad Davis" not in names
        assert "Camryn Cisneros" not in names

    def test_sorted_by_severity_then_queue_age_descending(self, seeded_db):
        queue = app_module.review_queue()
        severities = [r["severity"] for r in queue]
        assert severities == sorted(severities, reverse=True)

    def test_rep_filter(self, seeded_db):
        queue = app_module.review_queue(rep="Bob")
        assert all(r["rep"] == "Bob" for r in queue)
        assert len(queue) == 2


class TestCalibrationAgreement:
    def test_no_judged_rows_returns_none_pct(self, db_path):
        result = app_module.calibration_agreement()
        assert result == {"judged": 0, "agree": 0, "pct": None}

    def test_agreement_percentage(self, seeded_db):
        # Chad Davis: model flagged=1, Kris said Yes -> agree.
        # Camryn Cisneros: model flagged=1, Kris said No -> disagree.
        result = app_module.calibration_agreement()
        assert result["judged"] == 2
        assert result["agree"] == 1
        assert result["pct"] == 50


class TestAllRepsList:
    def test_distinct_sorted_reps(self, seeded_db):
        assert app_module.all_reps_list() == ["Alice", "Bob", "Carol"]


class TestFilteredCalls:
    def test_no_filters_returns_everything_up_to_limit(self, seeded_db):
        calls = app_module.filtered_calls(limit=3)
        assert len(calls) == 3

    def test_rep_filter(self, seeded_db):
        calls = app_module.filtered_calls(rep="Carol")
        assert all(c["rep"] == "Carol" for c in calls)
        assert len(calls) == 3

    def test_score_range_filter(self, seeded_db):
        calls = app_module.filtered_calls(min_score=4, max_score=5)
        assert all(4 <= c["call_quality_score"] <= 5 for c in calls)

    def test_asked_for_close_filter(self, seeded_db):
        calls = app_module.filtered_calls(asked_for_close="no")
        names = {c["prospect_name"] for c in calls}
        assert "Nicole Freed" in names
        assert "Rebecca Stewart" not in names

    def test_match_method_filter(self, seeded_db):
        calls = app_module.filtered_calls(match_method="fallback_heuristic")
        assert [c["prospect_name"] for c in calls] == ["Heather Gorney"]

    def test_fts_search_finds_matching_summary(self, seeded_db):
        calls = app_module.filtered_calls(q="discovery")
        names = {c["prospect_name"] for c in calls}
        assert "Rebecca Stewart" in names
        assert "Crystal Gargiulo" in names
        assert "Nicole Freed" not in names

    def test_fts_search_combined_with_rep_filter(self, seeded_db):
        # Both Crystal Gargiulo's and Chad Davis's summaries mention
        # "discovery" and both are Carol's calls — the rep filter narrows
        # rep, not which of Carol's own matches come back.
        calls = app_module.filtered_calls(q="discovery", rep="Carol")
        assert {c["prospect_name"] for c in calls} == {"Crystal Gargiulo", "Chad Davis"}

    def test_malformed_fts_query_fails_soft(self, seeded_db):
        # An unbalanced quote is invalid FTS5 MATCH syntax — must return an
        # empty list, not raise sqlite3.OperationalError up to the caller.
        calls = app_module.filtered_calls(q='"unbalanced')
        assert calls == []


class TestRepDetail:
    def test_returns_only_that_reps_calls_most_recent_first(self, seeded_db):
        calls = app_module.rep_detail("Alice")
        assert len(calls) == 3
        dates = [c["call_date"] for c in calls]
        assert dates == sorted(dates, key=app_module.parse_call_date, reverse=True)


class TestLeaderboard:
    def test_excludes_reps_with_no_scored_calls(self, db_path, conn):
        insert_call(conn, rep="Henry", call_quality_score=None)
        conn.commit()
        board = app_module.leaderboard()
        assert not any(r["rep"] == "Henry" for r in board)

    def test_sorted_best_first(self, seeded_db):
        board = app_module.leaderboard()
        avgs = [r["avg_score"] for r in board]
        assert avgs == sorted(avgs, reverse=True)
