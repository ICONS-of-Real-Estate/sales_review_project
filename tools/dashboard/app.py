#!/usr/bin/env python3
"""
Sales Review Dashboard — Phase A + charts (Phase B, partial) per
DASHBOARD_RESEARCH_REPORT.md §6.

Read-only team overview + trend charts, read from the local SQLite mirror
sync.py maintains. Still no auth — that's the rest of Phase B (Google OAuth
+ public access), not done yet. Charts render with a locally-vendored
Chart.js (tools/dashboard/static/chart.umd.min.js — no CDN, per the
report's CSP guidance).

Run with: uvicorn app:app --host <bind-host> --port 8000
(tools/deploy/setup_dashboard.sh installs this as sales-dashboard.service.)
"""
import html
import json
import os
import re
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware

import auth
import sheets_write
import sync
from playbooks import PLAYBOOKS, reindex_playbooks, render_playbook, search_playbooks

# Which PLAYBOOKS slug belongs on which rep's own /reps/{rep} page.
REP_TO_PLAYBOOK_SLUG = {"Bens": "bens", "Sean": "sean", "Joana": "joana", "Tomás": "tomas"}

BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent.parent
DB_PATH = os.environ.get("DASHBOARD_DB_PATH", str(BASE_DIR / "dashboard.db"))
FRESHNESS_WARN_MINUTES = int(os.environ.get("DASHBOARD_FRESHNESS_WARN_MINUTES", "15"))
FRESHNESS_STALE_MINUTES = int(os.environ.get("DASHBOARD_FRESHNESS_STALE_MINUTES", "60"))

app = FastAPI(title="Sales Review Dashboard")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

static_dir = BASE_DIR / "static"
static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


class RequireLoginMiddleware(BaseHTTPMiddleware):
    """Gates every route except auth.PUBLIC_PATHS + /static behind a
    session. Added AFTER SessionMiddleware below so it runs as the outer
    layer at request time — Starlette executes middleware in reverse
    registration order, so SessionMiddleware (registered second) wraps
    around this one and populates request.session before this dispatch
    runs. If DASHBOARD_REQUIRE_LOGIN=false (local dev, before OAuth
    credentials exist), this is a no-op — see setup instructions in
    tools/dashboard/README.md."""

    async def dispatch(self, request: Request, call_next):
        if os.environ.get("DASHBOARD_REQUIRE_LOGIN", "true").lower() == "false":
            return await call_next(request)
        path = request.url.path
        if path in auth.PUBLIC_PATHS or path.startswith("/static/"):
            return await call_next(request)
        if not request.session.get("user_email"):
            return RedirectResponse(url="/login")
        return await call_next(request)


_REQUIRE_LOGIN = os.environ.get("DASHBOARD_REQUIRE_LOGIN", "true").lower() != "false"
_SESSION_SECRET = os.environ.get("DASHBOARD_SESSION_SECRET")
if _SESSION_SECRET is None:
    if _REQUIRE_LOGIN:
        # Real bug (M-06): this used to silently fall back to a hardcoded,
        # public, checked-into-the-repo string
        # ("dev-only-insecure-secret-change-me") whenever the env var wasn't
        # set — on a fresh/rebuilt deployment that skipped this one setup
        # step, session cookies would be forgeable by anyone who has read
        # this file, with no error or warning at all. Fail closed instead:
        # refuse to start rather than serve real sessions signed with a
        # known secret. Local dev with DASHBOARD_REQUIRE_LOGIN=false (no
        # real sessions ever gated on this) is the one case allowed to fall
        # back, per tools/dashboard/README.md's setup instructions.
        raise RuntimeError(
            "DASHBOARD_SESSION_SECRET is not set. Generate one (see tools/dashboard/README.md, "
            "e.g. `python3 -c \"import secrets; print(secrets.token_hex(32))\"`) and set it in the "
            "environment before starting the app — refusing to start with an insecure default while "
            "DASHBOARD_REQUIRE_LOGIN is not \"false\"."
        )
    _SESSION_SECRET = "dev-only-insecure-secret-change-me"

app.add_middleware(RequireLoginMiddleware)
app.add_middleware(
    SessionMiddleware,
    secret_key=_SESSION_SECRET,
    same_site="lax",
)
app.include_router(auth.router)


def render(request: Request, name: str, context: dict):
    """templates.TemplateResponse, plus the logged-in user's email on every
    page (for the nav bar's "logged in as ..." + logout link) so every
    route doesn't have to remember to pass it themselves."""
    context = {**context, "user_email": request.session.get("user_email")}
    return templates.TemplateResponse(request, name, context)

# Real bug (M-04): sqlite3.connect() silently creates an empty file if
# DB_PATH doesn't exist yet — on a brand-new deployment where sync.py has
# never run, every route querying sales_call_log/etc. would 500 with "no
# such table" instead of rendering an empty/"no data yet" dashboard.
# init_schema is the same idempotent CREATE TABLE IF NOT EXISTS sync.py
# itself runs every cycle, so this is a no-op once a real sync has landed.
try:
    _startup_conn = sqlite3.connect(DB_PATH)
    sync.init_schema(_startup_conn)
    _startup_conn.close()
except Exception as e:
    print(f"WARNING: could not initialize schema at {DB_PATH}: {e}")

# Playbooks are files in the repo (only change on a git pull + restart, not
# on sync.py's timer), so index once at startup rather than on a schedule.
try:
    reindex_playbooks(DB_PATH, REPO_ROOT)
except Exception as e:
    print(f"WARNING: could not index playbooks: {e}")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def freshness_status():
    conn = get_conn()
    row = conn.execute(
        "SELECT value FROM sync_meta WHERE key = 'last_synced_at'"
    ).fetchone()
    conn.close()
    if not row:
        return {"last_synced_at": None, "age_minutes": None, "level": "stale"}
    try:
        last_synced_at = datetime.fromisoformat(row["value"])
    except ValueError:
        # A corrupted sync_meta value must not 500 the whole overview page —
        # report it the same as "never synced" instead.
        return {"last_synced_at": None, "age_minutes": None, "level": "stale"}
    age_minutes = (datetime.now(timezone.utc) - last_synced_at).total_seconds() / 60
    if age_minutes < FRESHNESS_WARN_MINUTES:
        level = "ok"
    elif age_minutes < FRESHNESS_STALE_MINUTES:
        level = "warn"
    else:
        level = "stale"
    return {"last_synced_at": last_synced_at, "age_minutes": age_minutes, "level": level}


def top_failure_mode_per_rep():
    """Kris's ask (07/09/2026): "what's their biggest failure" on the rep
    roster itself, not just the all-reps breakdown (failure_mode_breakdown()
    below) — one most-frequent Primary Failure Mode per rep, alphabetical
    tie-break for determinism (same convention as mostFrequent_ in
    Phase5_WeeklyScorecard.gs)."""
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT rep, primary_failure_mode, COUNT(*) AS n
        FROM sales_call_log
        WHERE rep IS NOT NULL AND rep != ''
          AND primary_failure_mode IS NOT NULL AND TRIM(primary_failure_mode) != ''
          AND LOWER(primary_failure_mode) != 'none'
        GROUP BY rep, primary_failure_mode
        ORDER BY rep, n DESC, primary_failure_mode ASC
        """
    ).fetchall()
    conn.close()
    top = {}
    for r in rows:
        top.setdefault(r["rep"], r["primary_failure_mode"])  # first row per rep, already ordered worst-first
    return top


def bens_qc_booking_stats():
    """Bens doesn't take Sales Calls (CLAUDE.md "Who does what") — Kris's
    ask (07/09/2026) named his real conversion metric explicitly: "Bens
    booking QCs." QC booking rate = QC Booked / Recording Done, from his own
    "Icons Podcast Recordings" tracker tab (bens_podcast_tracker), not the
    Sales Call Log. Denominator is recordings actually done, not every row
    (a row can exist before the recording itself has happened)."""
    conn = get_conn()
    row = conn.execute(
        """
        SELECT
            SUM(recording_done) AS recordings_done,
            SUM(CASE WHEN recording_done = 1 AND qc_booked = 1 THEN 1 ELSE 0 END) AS qc_booked_count
        FROM bens_podcast_tracker
        """
    ).fetchone()
    conn.close()
    recordings_done = row["recordings_done"] or 0
    return {
        "recordings_done": recordings_done,
        "qc_booked_count": row["qc_booked_count"] or 0,
        "pct_qc_booked": round(100 * (row["qc_booked_count"] or 0) / recordings_done) if recordings_done else None,
    }


def call_length_by_score(call_type):
    """Kris's ask (07/09/2026): "I've got a strong suspicion that the longer
    the call, the higher the close rate... min time, max time, average time
    for every level [Call Quality Score 1-5]." Split by call_type — QC and
    Sales Call ("qualification calls and closing calls" in his own words) —
    since combining them would mix two structurally different call lengths
    together and hide whatever real pattern exists in either one. Only calls
    with a measured length count (see extractCallLengthMinutes_'s own "no
    signal, never a fabricated 0" comment) — a score with zero measured
    calls simply doesn't appear, rather than showing a misleading blank row.
    Minutes are rounded for display; the underlying average is still a real
    mean, not a rounded-then-averaged approximation."""
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT
            call_quality_score AS score,
            COUNT(*) AS n,
            MIN(call_length_minutes) AS min_minutes,
            MAX(call_length_minutes) AS max_minutes,
            AVG(call_length_minutes) AS avg_minutes
        FROM sales_call_log
        WHERE call_type = ? AND call_quality_score IS NOT NULL AND call_length_minutes IS NOT NULL
        GROUP BY call_quality_score
        ORDER BY call_quality_score
        """,
        (call_type,),
    ).fetchall()
    conn.close()
    return [
        {
            "score": r["score"],
            "count": r["n"],
            "min_minutes": round(r["min_minutes"]),
            "max_minutes": round(r["max_minutes"]),
            "avg_minutes": round(r["avg_minutes"]),
        }
        for r in rows
    ]


def rep_summary():
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT
            rep,
            COUNT(*) AS total_calls,
            AVG(call_quality_score) AS avg_score,
            AVG(call_length_minutes) AS avg_call_length_minutes,
            SUM(CASE WHEN call_length_minutes IS NOT NULL THEN 1 ELSE 0 END) AS call_length_measured_count,
            SUM(flag_asked_for_close) AS asked_for_close_count,
            SUM(flag_objections_handled) AS objections_handled_count,
            SUM(manual_review_recommended) AS manual_review_count,
            SUM(CASE WHEN outcome_disposition IS NOT NULL AND TRIM(outcome_disposition) != ''
                     THEN 1 ELSE 0 END) AS outcome_logged_count,
            SUM(CASE WHEN LOWER(TRIM(outcome_disposition)) = 'sold' THEN 1 ELSE 0 END) AS sold_count,
            SUM(flag_framework_explained) AS framework_explained_count,
            -- flag_booking_decision_appropriate is tri-state (NULL = not scored on
            -- this call, e.g. a QC row — see sync.py's NULLABLE_BOOLEAN_COLUMNS
            -- comment). The rate below is deliberately of SCORED calls only, not
            -- total_calls, so a rep with mostly QCs doesn't read as having a
            -- crashed booking rate just because most of their calls were never
            -- scored on this dimension at all.
            SUM(CASE WHEN flag_booking_decision_appropriate IS NOT NULL THEN 1 ELSE 0 END) AS booking_decision_scored_count,
            SUM(CASE WHEN flag_booking_decision_appropriate = 1 THEN 1 ELSE 0 END) AS booking_decision_appropriate_count
        FROM sales_call_log
        WHERE rep IS NOT NULL AND rep != ''
        GROUP BY rep
        ORDER BY rep
        """
    ).fetchall()
    conn.close()

    top_failure = top_failure_mode_per_rep()
    bens_qc = bens_qc_booking_stats()

    summary = []
    for r in rows:
        total = r["total_calls"] or 0
        outcome_logged = r["outcome_logged_count"] or 0
        booking_scored = r["booking_decision_scored_count"] or 0
        entry = {
            "rep": r["rep"],
            "total_calls": total,
            "avg_score": round(r["avg_score"], 2) if r["avg_score"] is not None else None,
            "avg_call_length_minutes": (
                round(r["avg_call_length_minutes"]) if r["avg_call_length_minutes"] is not None else None
            ),
            "call_length_measured_count": r["call_length_measured_count"] or 0,
            "pct_asked_for_close": (
                round(100 * (r["asked_for_close_count"] or 0) / total) if total else None
            ),
            "pct_objections_handled": (
                round(100 * (r["objections_handled_count"] or 0) / total) if total else None
            ),
            "manual_review_count": r["manual_review_count"] or 0,
            "outcome_logged_count": outcome_logged,
            "pct_outcome_logged": round(100 * outcome_logged / total) if total else None,
            # Closing rate (Kris, 07/09/2026: "our closing rate is shit" —
            # the headline number this whole feature exists to surface). Of
            # calls with an outcome logged, not of every call, so it isn't
            # silently dragged down by unlogged calls the way "% of all
            # calls" would be. Coverage is visible right next to it
            # (pct_outcome_logged) so a low-coverage rep's rate reads as
            # provisional, not as gospel.
            "sold_count": r["sold_count"] or 0,
            "pct_closing_rate": round(100 * (r["sold_count"] or 0) / outcome_logged) if outcome_logged else None,
            "framework_explained_count": r["framework_explained_count"] or 0,
            "pct_framework_explained": (
                round(100 * (r["framework_explained_count"] or 0) / total) if total else None
            ),
            "booking_decision_scored_count": booking_scored,
            "pct_booking_decision_appropriate": (
                round(100 * (r["booking_decision_appropriate_count"] or 0) / booking_scored) if booking_scored else None
            ),
            "top_failure_mode": top_failure.get(r["rep"]),
        }
        if r["rep"] == "Bens":
            # Bens doesn't take Sales Calls — his closing-rate/booking-rate
            # cells above are meaningless (near-zero denominators), so the
            # template shows his own QC-booking metric instead wherever a
            # rep's row is rendered.
            entry["bens_qc_booking"] = bens_qc
        summary.append(entry)
    return summary


def failure_mode_breakdown():
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT primary_failure_mode, COUNT(*) AS n
        FROM sales_call_log
        WHERE primary_failure_mode IS NOT NULL AND primary_failure_mode != ''
        GROUP BY primary_failure_mode
        ORDER BY n DESC
        """
    ).fetchall()
    conn.close()
    return [{"mode": r["primary_failure_mode"], "count": r["n"]} for r in rows]


def framework_gap_breakdown(rep=""):
    """Which of the three framework components (recruit agents / #1 podcast
    in your city / sell more houses — Phase2_CallGradingSOP.md §3D) get
    missed most often. `framework_gaps` is a comma-joined string written by
    Apps Script's deriveFrameworkFields_ (Phase2_CallScoring.gs) from a fixed,
    system-generated vocabulary — unlike outcome_disposition this is never
    hand-typed, so no case-folding is needed, just a split and count. SQLite
    has no generic comma-split, so this is done in Python over the (small,
    ~hundreds of rows) result set rather than in SQL."""
    conn = get_conn()
    params = []
    where_rep = " AND rep = ?" if rep else ""
    if rep:
        params.append(rep)
    rows = conn.execute(
        "SELECT framework_gaps FROM sales_call_log "
        f"WHERE framework_gaps IS NOT NULL AND TRIM(framework_gaps) != ''{where_rep}",
        params,
    ).fetchall()
    conn.close()
    counts = {}
    for r in rows:
        for gap in r["framework_gaps"].split(","):
            gap = gap.strip()
            if gap:
                counts[gap] = counts.get(gap, 0) + 1
    return sorted(
        [{"gap": g, "count": n} for g, n in counts.items()],
        key=lambda x: x["count"],
        reverse=True,
    )


_DATE_PATTERNS = (
    # Project convention (brief.txt §2) is DD/MM/YYYY — try that first so an
    # ambiguous "05/08/2026" is read as 5 August, not May 8th. ISO and a
    # Sheets-style datetime-with-time are the other shapes actually seen in
    # this sheet (appendRow with a raw JS Date renders with a time part).
    "%d/%m/%Y",
    "%Y-%m-%d",
    "%d/%m/%Y %H:%M:%S",
    "%m/%d/%Y %H:%M:%S",
    # Real bug (P5): the Sheets API can also hand back a raw ISO datetime
    # (space-separated, or "T"-separated when the cell holds a genuine
    # datetime rather than a date-only value) — neither was tried, so those
    # rows silently dropped out of every chart/sort that depends on
    # parse_call_date returning non-None.
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
)


def parse_call_date(raw):
    """Best-effort parse of whatever string the Sheets API handed back for
    Call Date into a plain date — deliberately not timezone-aware, per
    DASHBOARD_RESEARCH_REPORT.md §5.1: a call date is a day, not an instant,
    and must render identically for every viewer regardless of timezone.
    Returns None on anything unparseable rather than raising, so one bad
    legacy row doesn't break the whole chart."""
    if not raw:
        return None
    raw = str(raw).strip()
    for fmt in _DATE_PATTERNS:
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


def _month_add(year, month, delta):
    idx = (year * 12 + (month - 1)) + delta
    return idx // 12, idx % 12 + 1


def _bucket_key_and_label(d, granularity):
    """Returns (sort_key, label) for the period `d` falls into. sort_key is
    always a (year, ...) tuple so buckets order correctly regardless of
    granularity."""
    if granularity == "day":
        return (d.year, d.month, d.day), d.strftime("%b %d")
    if granularity == "month":
        return (d.year, d.month), d.strftime("%b %Y")
    if granularity == "year":
        return (d.year,), str(d.year)
    if granularity == "all":
        return (0,), "All time"
    # default: week (Monday-start ISO week)
    week_start = d - timedelta(days=d.weekday())
    return (week_start.year, week_start.month, week_start.day), "Wk of " + week_start.strftime("%b %d")


def _all_bucket_keys(min_d, max_d, granularity):
    """Every bucket key between min_d and max_d inclusive, even ones with no
    data — this is what makes the x-axis reflect real elapsed time instead
    of silently compressing e.g. March next to November because nothing
    happened in between (the bug the team flagged 22/08/2026)."""
    if granularity == "all":
        return [((0,), "All time")]

    keys = []
    if granularity == "day":
        d = min_d
        while d <= max_d:
            keys.append(_bucket_key_and_label(d, "day"))
            d += timedelta(days=1)
    elif granularity == "week":
        d = min_d - timedelta(days=min_d.weekday())
        end = max_d - timedelta(days=max_d.weekday())
        while d <= end:
            keys.append(_bucket_key_and_label(d, "week"))
            d += timedelta(weeks=1)
    elif granularity == "month":
        y, m = min_d.year, min_d.month
        end_y, end_m = max_d.year, max_d.month
        while (y, m) <= (end_y, end_m):
            keys.append(_bucket_key_and_label(datetime(y, m, 1).date(), "month"))
            y, m = _month_add(y, m, 1)
    else:  # year
        for y in range(min_d.year, max_d.year + 1):
            keys.append(_bucket_key_and_label(datetime(y, 1, 1).date(), "year"))
    return keys


def score_over_time(granularity="week"):
    """Average call-quality score per rep, bucketed by `granularity`
    (day/week/month/year/all), for a line chart. Buckets are plain calendar
    periods of the call date itself — no timezone conversion, since Call
    Date is already a plain date (DASHBOARD_RESEARCH_REPORT.md §5.1).
    Includes every period in range even with no data, so the x-axis spacing
    reflects real elapsed time instead of jamming distant weeks together."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT rep, call_date, call_quality_score FROM sales_call_log "
        "WHERE rep IS NOT NULL AND rep != '' AND call_quality_score IS NOT NULL"
    ).fetchall()
    conn.close()

    parsed = []
    for r in rows:
        d = parse_call_date(r["call_date"])
        if d is not None:
            parsed.append((r["rep"], d, r["call_quality_score"]))

    if not parsed:
        return {"labels": [], "series": []}

    buckets = {}  # (rep, sort_key) -> [scores]
    all_labels_by_key = {}
    for rep, d, score in parsed:
        key, label = _bucket_key_and_label(d, granularity)
        buckets.setdefault((rep, key), []).append(score)
        all_labels_by_key[key] = label

    if granularity == "all":
        ordered_keys = [((0,), "All time")]
    else:
        min_d = min(d for _, d, _ in parsed)
        max_d = max(d for _, d, _ in parsed)
        ordered_keys = _all_bucket_keys(min_d, max_d, granularity)

    reps = sorted({rep for rep, _, _ in parsed})
    labels = [label for _, label in ordered_keys]
    series = []
    for rep in reps:
        data = []
        for key, _ in ordered_keys:
            scores = buckets.get((rep, key))
            data.append(round(sum(scores) / len(scores), 2) if scores else None)
        series.append({"rep": rep, "data": data})
    return {"labels": labels, "series": series}


def trend_alerts(threshold_drop=1.0, low_score_floor=2.5):
    """A rep's most recent scored week compared to the week before it —
    flags either a sharp week-over-week drop or an absolute score below
    the floor, so this shows up on Overview without anyone having to
    notice it on the chart themselves. Deliberately simple (two-week
    comparison, not a full statistical trend) — good enough to catch
    "something just got worse," which is the actual ask."""
    data = score_over_time("week")
    alerts = []
    for s in data["series"]:
        points = [(i, v) for i, v in enumerate(s["data"]) if v is not None]
        if not points:
            continue
        _, latest = points[-1]
        message = None
        if latest < low_score_floor:
            message = f"{s['rep']}'s most recent week averaged {latest} — below the {low_score_floor} floor."
        if len(points) >= 2:
            _, prev = points[-2]
            drop = round(prev - latest, 2)
            if drop >= threshold_drop:
                message = f"{s['rep']}'s score dropped {drop} points week-over-week ({prev} → {latest})."
        if message:
            alerts.append({"rep": s["rep"], "message": message})
    return alerts


def get_leads(verdict=None, failure_mode=None, rep=None, limit=200):
    """Backs the chart drill-down: clicking a lead-quality slice or a
    failure-mode bar fetches the actual calls behind that number, with the
    model's coaching summary as the closest available "why" — there's no
    separate Lead Quality Justification column synced today, only the
    combined AI Feedback Summary; a dedicated column could be added later
    if the summary text isn't specific enough."""
    conn = get_conn()
    clauses, params = [], []
    if verdict:
        clauses.append("lead_quality_verdict = ?")
        params.append(verdict)
    if failure_mode:
        clauses.append("primary_failure_mode = ?")
        params.append(failure_mode)
    if rep:
        clauses.append("rep = ?")
        params.append(rep)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = conn.execute(
        f"SELECT prospect_name, rep, call_date, call_type, lead_quality_verdict, "
        f"call_quality_score, primary_failure_mode, ai_feedback_summary, transcript_url "
        f"FROM sales_call_log {where}",
        params,
    ).fetchall()
    conn.close()

    leads = [dict(r) for r in rows]
    leads.sort(key=lambda x: parse_call_date(x["call_date"]) or datetime.min.date(), reverse=True)
    return leads[:limit]


def lead_quality_distribution():
    conn = get_conn()
    rows = conn.execute(
        "SELECT lead_quality_verdict, COUNT(*) AS n FROM sales_call_log "
        "WHERE lead_quality_verdict IS NOT NULL AND lead_quality_verdict != '' "
        "GROUP BY lead_quality_verdict"
    ).fetchall()
    conn.close()
    return [{"verdict": r["lead_quality_verdict"], "count": r["n"]} for r in rows]


def pipeline_health():
    """Surfaces the known transcription-failure pattern (SYSTEM_OVERVIEW.md
    §2) directly on the dashboard: rows scored from a blank/corrupted
    transcript, or calls with no transcript matched at all."""
    conn = get_conn()
    unmatched = conn.execute(
        "SELECT COUNT(*) AS n FROM sales_call_log WHERE match_method = 'no_match'"
    ).fetchone()["n"]
    fallback = conn.execute(
        "SELECT COUNT(*) AS n FROM sales_call_log WHERE match_method = 'fallback_heuristic'"
    ).fetchone()["n"]
    conn.close()
    return {"unmatched": unmatched, "fallback_matched": fallback}


# The Sales Call Log's "Outcome Disposition" column (Sold / Not Sold /
# Follow-up / No-show) has existed since Phase 0 but sat almost entirely
# empty until Phase 5's weekly scorecard started nudging reps to fill it in
# (Phase5_WeeklyScorecard.gs, commit 6f81eed). sync.py has always mirrored
# it into SQLite; nothing rendered it until now. It is the only column that
# closes the loop between what the AI *scored* a call and what actually
# happened on it, so the two things worth showing are (a) how much of it is
# actually filled in, and (b) average score per outcome.
OUTCOME_MISSING = "__none__"

_OUTCOME_LOGGED_SQL = "outcome_disposition IS NOT NULL AND TRIM(outcome_disposition) != ''"

# Keep in sync with Phase6_TrainingCallReview.gs's FRAMEWORK_TOPIC_LABELS_ —
# used to render training_assignments()'s framework_gaps_to_drill topics
# as human labels instead of raw snake_case.
FRAMEWORK_TOPIC_LABELS = {
    "recruit_agents": "Recruit agents",
    "number_one_podcast": "#1 podcast in your city",
    "sell_more_houses": "Sell more houses",
}


def outcome_breakdown(rep=""):
    """Distribution of logged outcomes, with the average call-quality score
    for each — the score-vs-outcome feedback loop. Also reports how many
    scored calls have no outcome logged at all, which for now is most of
    them: until that coverage number climbs, treat every average here as
    provisional rather than as evidence the rubric predicts revenue."""
    conn = get_conn()
    params = []
    where_rep = ""
    if rep:
        where_rep = " AND rep = ?"
        params.append(rep)
    rows = conn.execute(
        "SELECT TRIM(outcome_disposition) AS disposition, COUNT(*) AS n, "
        "AVG(call_quality_score) AS avg_score FROM sales_call_log "
        f"WHERE {_OUTCOME_LOGGED_SQL}{where_rep} "
        "GROUP BY TRIM(outcome_disposition) ORDER BY n DESC",
        params,
    ).fetchall()
    totals = conn.execute(
        "SELECT COUNT(*) AS total, "
        f"SUM(CASE WHEN {_OUTCOME_LOGGED_SQL} THEN 1 ELSE 0 END) AS logged "
        "FROM sales_call_log WHERE 1=1" + where_rep,
        params,
    ).fetchone()
    conn.close()

    # Reps type this by hand, so "Follow-up" and "follow-up" both show up.
    # Fold case-insensitively but keep the first (most common, since the
    # query is already count-ordered) spelling as the display label rather
    # than imposing a casing of our own on the sheet's own vocabulary.
    folded = {}
    order = []
    for r in rows:
        key = (r["disposition"] or "").lower()
        if key not in folded:
            folded[key] = {"disposition": r["disposition"], "count": 0, "_score_sum": 0.0, "_scored": 0}
            order.append(key)
        entry = folded[key]
        entry["count"] += r["n"]
        if r["avg_score"] is not None:
            entry["_score_sum"] += r["avg_score"] * r["n"]
            entry["_scored"] += r["n"]

    distribution = []
    for key in order:
        e = folded[key]
        distribution.append(
            {
                "disposition": e["disposition"],
                "count": e["count"],
                "avg_score": round(e["_score_sum"] / e["_scored"], 2) if e["_scored"] else None,
            }
        )
    distribution.sort(key=lambda d: d["count"], reverse=True)

    total = totals["total"] or 0
    logged = totals["logged"] or 0
    return {
        "distribution": distribution,
        "total": total,
        "logged": logged,
        "missing": total - logged,
        "pct_logged": round(100 * logged / total) if total else None,
    }


@app.get("/", response_class=HTMLResponse)
def overview(request: Request):
    conn = get_conn()
    total_calls = conn.execute("SELECT COUNT(*) AS n FROM sales_call_log").fetchone()["n"]
    conn.close()
    return render(
        request,
        "overview.html",
        {
            "active_page": "overview",
            "freshness": freshness_status(),
            "total_calls": total_calls,
            "reps": rep_summary(),
            "failure_modes": failure_mode_breakdown(),
            "pipeline": pipeline_health(),
            "alerts": trend_alerts(),
            "outcomes": outcome_breakdown(),
            "outcome_missing_key": OUTCOME_MISSING,
            "framework_gaps": framework_gap_breakdown(),
            "call_length_by_score_qc": call_length_by_score("QC"),
            "call_length_by_score_sales_call": call_length_by_score("Sales Call"),
        },
    )


def training_assignments():
    """Reads the "Training Assignments" tab mirror (Phase6_TrainingCallReview.gs)
    — the only way this state is visible outside Apps Script at all, since the
    live values are Script Properties no external API can read."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT rep, training_objections_json, close_ask_drill_json, training_framework_json, last_updated "
        "FROM training_assignments ORDER BY rep"
    ).fetchall()
    conn.close()

    out = []
    for r in rows:
        try:
            objections = json.loads(r["training_objections_json"]) if r["training_objections_json"] else []
        except (ValueError, TypeError):
            objections = []
        try:
            close_drill = json.loads(r["close_ask_drill_json"]) if r["close_ask_drill_json"] else None
        except (ValueError, TypeError):
            close_drill = None
        try:
            framework_drill = json.loads(r["training_framework_json"]) if r["training_framework_json"] else []
        except (ValueError, TypeError):
            framework_drill = []
        # Keep in sync with Phase6_TrainingCallReview.gs's FRAMEWORK_TOPIC_LABELS_.
        for f in framework_drill:
            f["label"] = FRAMEWORK_TOPIC_LABELS.get(f.get("topic"), f.get("topic"))
        out.append(
            {
                "rep": r["rep"],
                "objections": objections,
                "close_drill": close_drill,
                "framework_drill": framework_drill,
                "last_updated": r["last_updated"],
            }
        )
    return out


def daily_practice_status():
    """Phase 7's drill compliance (Daily Practice Follow-ups tab) — who's
    done today's assignment, who's overdue and how many times they've
    been nagged. Most-recent assignment per rep first."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT rep, assignment_date, status, last_nag_at, nag_count "
        "FROM daily_practice_followups ORDER BY assignment_date DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# QA_COACHING_RESEARCH_REPORT.md's "five things" #4: at 3-4 reps, a ranked
# cross-rep leaderboard structurally punishes whoever's last every single
# week, forever — there's no version of "last of 3" that isn't demoralizing,
# regardless of how much everyone actually improved. "Recent" here means each
# rep's own most recent N scored calls, not a calendar window, so a rep with
# a sparse call volume still gets a real comparison instead of an empty bucket.
LEADERBOARD_RECENT_CALLS = 10


def leaderboard():
    """Self-comparison, not cross-rep ranking: each rep's own recent average
    against their own prior average, so the number a rep sees is "am I
    improving on my own baseline" rather than "who's ahead of whom." Sorted
    alphabetically by rep — deliberately NOT by score or by improvement, so
    the list itself doesn't read as a ranking regardless of column order."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT rep, call_date, call_quality_score FROM sales_call_log "
        "WHERE rep IS NOT NULL AND rep != '' AND call_quality_score IS NOT NULL"
    ).fetchall()
    conn.close()

    by_rep = {}
    for r in rows:
        d = parse_call_date(r["call_date"])
        if d is None:
            continue
        by_rep.setdefault(r["rep"], []).append((d, r["call_quality_score"]))

    out = []
    for rep, calls in by_rep.items():
        calls.sort(key=lambda c: c[0])  # oldest first, so "recent" = the tail
        recent = calls[-LEADERBOARD_RECENT_CALLS:]
        prior = calls[:-LEADERBOARD_RECENT_CALLS] if len(calls) > LEADERBOARD_RECENT_CALLS else []
        recent_avg = round(sum(s for _, s in recent) / len(recent), 2) if recent else None
        prior_avg = round(sum(s for _, s in prior) / len(prior), 2) if prior else None
        delta = round(recent_avg - prior_avg, 2) if recent_avg is not None and prior_avg is not None else None
        out.append(
            {
                "rep": rep,
                "recent_avg": recent_avg,
                "recent_count": len(recent),
                "prior_avg": prior_avg,
                "prior_count": len(prior),
                "delta": delta,
                "total_calls": len(calls),
            }
        )
    out.sort(key=lambda r: r["rep"])
    return out


# Must match PARSE_FAILURE_MARKER_ in Phase2_CallScoring.gs exactly — the
# fixed feedback-summary prefix stamped on the fabricated placeholder row
# scoreTranscript_ writes when the judge model fails to return parseable
# JSON twice in a row. That row's own Primary Failure Mode is hardcoded to
# 'none' (a lie — it was never actually scored) and Lead Quality Verdict to
# 'good_to_book' (same reason) — Kris's real question on seeing one of
# these ("what needs to be done?") is answered by Phase2_CallScoring.gs's
# own previewFailedParseRows()/deleteFailedParseRows(): delete the
# placeholder row so the next scoring pass picks the transcript back up and
# scores it for real, rather than reading anything on this row as a genuine
# verdict.
PARSE_FAILURE_MARKER = "Automated scoring failed twice to return parseable JSON"

# Zoom's own recording-filename convention (GMTyyyyMMdd-HHMMSS_Recording...) —
# what tools/transcribe_*.py's file names look like before any name-matching
# happens. A Prospect Name still in this shape means no match (exact_key or
# fallback_heuristic) ever replaced it with a real name.
RAW_RECORDING_FILENAME_RE = re.compile(r"^GMT\d{8}-\d{6}")


def call_date_short(raw):
    """dd/MM/yyyy (or whatever parse_call_date already handles) rendered as
    'D Mon' (e.g. "2 Sep") — Kris's ask (08/09/2026): "Date can just be
    short 2nd Sep." Falls back to the raw string if it doesn't parse, so a
    genuinely malformed date still shows something rather than going blank."""
    d = parse_call_date(raw)
    return f"{d.day} {d.strftime('%b')}" if d else (raw or "—")


def rep_detail(rep, call_type=""):
    """`call_type` optionally restricts to one raw Call Type value (Kris's
    ask, 08/09/2026: "Split calls All / QC / Sales Call" tabs on the rep
    page) — matches the raw column, not _display_call_type's Tomás-specific
    "2nd Sales Call (Closing)" relabeling, since the tabs are meant to be
    the same three plain choices for every rep."""
    conn = get_conn()
    sql = (
        "SELECT prospect_name, call_date, call_type, lead_quality_verdict, call_quality_score, "
        "flag_asked_for_close, flag_objections_handled, primary_failure_mode, manual_review_recommended, "
        "ai_feedback_summary, transcript_url, outcome_disposition, flag_framework_explained, framework_gaps, "
        "match_method "
        "FROM sales_call_log WHERE rep = ?"
    )
    params = [rep]
    if call_type:
        sql += " AND call_type = ?"
        params.append(call_type)
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    calls = [dict(r) for r in rows]
    calls.sort(key=lambda c: parse_call_date(c["call_date"]) or datetime.min.date(), reverse=True)
    for c in calls:
        c["call_date_short"] = call_date_short(c["call_date"])
        c["full_feedback"] = c["ai_feedback_summary"]
        # A row scored for real can still legitimately have Primary Failure
        # Mode == 'none' (nothing was wrong) — only the parse-failure
        # placeholder's specific summary text means "this 'none' is fake."
        c["parse_failed"] = bool(c["ai_feedback_summary"]) and c["ai_feedback_summary"].startswith(PARSE_FAILURE_MARKER)
        # Kris's ask: "GMT20260818-... some don't have a name." Detected by
        # shape, not match_method — fallback_heuristic can still land a real
        # fuzzy-matched name, so match_method alone would over-flag those.
        # This only catches the specific case Kris saw: the raw Zoom
        # recording filename (GMTyyyyMMdd-HHMMSS_Recording...) was never
        # replaced with a real name at all, because nothing — heuristic
        # included — found one to match against.
        c["looks_like_raw_filename"] = bool(RAW_RECORDING_FILENAME_RE.match(c["prospect_name"] or ""))
    return calls


def review_queue(rep=""):
    """A simplified stand-in for Phase 2's actual clustering algorithm
    (buildReviewQueue() in Phase2_CallScoring.gs — capped-count x 1000 +
    top-3 severities, same-rep clustering for a 3-a-day sitting): every
    flagged-but-unreviewed call, sorted by severity then queue age, so
    Kris can see the real backlog without re-deriving Kris's own review
    order. Not a replacement for that function, just visibility into the
    same underlying rows."""
    conn = get_conn()
    sql = (
        "SELECT prospect_name, rep, call_date, call_type, severity, queue_age, "
        "primary_failure_mode, call_quality_score, ai_feedback_summary, transcript_url "
        "FROM sales_call_log "
        "WHERE manual_review_recommended = 1 "
        "AND (reviewed_by_kris IS NULL OR reviewed_by_kris = '' OR reviewed_by_kris = '0' OR reviewed_by_kris = 'FALSE')"
    )
    params = []
    if rep:
        sql += " AND rep = ?"
        params.append(rep)
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    rows = [dict(r) for r in rows]
    rows.sort(key=lambda r: (-(r["severity"] or 0), -(r["queue_age"] or 0)))
    return rows


def calibration_agreement():
    """Percent agreement between the model's manual_review_recommended and
    Kris's own Kris Manual Review Verdict, on rows she's actually judged —
    the same signal Phase 2's weekly calibration job tracks (SOP §7's
    80%-agreement go-live gate), surfaced here instead of only in an
    Apps Script log."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT manual_review_recommended, kris_manual_review_verdict FROM sales_call_log "
        "WHERE kris_manual_review_verdict IS NOT NULL AND kris_manual_review_verdict != ''"
    ).fetchall()
    conn.close()
    if not rows:
        return {"judged": 0, "agree": 0, "pct": None}
    agree = 0
    for r in rows:
        model_flagged = bool(r["manual_review_recommended"])
        kris_said_yes = str(r["kris_manual_review_verdict"]).strip().lower() == "yes"
        if model_flagged == kris_said_yes:
            agree += 1
    return {"judged": len(rows), "agree": agree, "pct": round(100 * agree / len(rows))}


def rep_scorecard_history(rep):
    """Week-by-week Scorecard History for one rep, oldest first (so a chart
    or table built from this reads left-to-right as time passing) — real
    per-week rows only, since appendScorecardHistoryRow_ (Phase5_WeeklyScorecard.gs)
    only ever writes on an actual send, never a preview."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT week_start, week_end, calls_this_week, weekly_avg_score, rolling_4_week_avg, "
        "historic_avg_before_week, priority_to_improve, worst_call, worst_call_score, "
        "missing_outcome_disposition, sent_at "
        "FROM scorecard_history WHERE rep = ? ORDER BY week_start ASC",
        (rep,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# Phase1_ComplianceCheck.gs's CONFIG.BUSINESS_TIMEZONE — the timezone every
# "week start" (Monday) in this whole project is computed in. Must match
# exactly, or a week-start label written here would never match the one
# Apps Script's getWeekBounds_ computes, and the override would silently
# never take effect.
BUSINESS_TIMEZONE = "America/New_York"

# Kris's ask (07/09/2026): a rep can only be trained on one of these three
# team-wide topics per WEEKLY_TRAINING_ROTATION_ (Phase1_ComplianceCheck.gs),
# or one of the four individual scored elements for a rep not on that
# rotation (Bens). The dashboard's dropdown offers all of them plus a free-
# text option — sheets_write.write_training_priority_override doesn't
# validate the value at all (Apps Script's own findTrainingPriorityOverride_/
# namedTrainingFocusFromRanking_ falls back gracefully to a bare label with
# no supporting call data if it doesn't recognize the text), so a typo here
# degrades rather than breaks.
TRAINING_PRIORITY_OPTIONS = [
    "Discovery",
    "Framework & Delivery",
    "Closing & Objection Handling",
    "Objection handling",
    "Asking for the money / the booking",
    "Delivery",
]


def current_week_start_label(now=None):
    """The Monday of the LAST COMPLETED Mon-Sun week, in BUSINESS_TIMEZONE,
    as dd/MM/yyyy — must match Phase1_ComplianceCheck.gs's
    getWeekBounds_(new Date(), tz).start exactly, since that's the value
    buildAndMaybeSendPlaybookReview_ actually looks an override up by
    (findTrainingPriorityOverride_) when building the training email: that
    email always covers last week's calls, never the still-in-progress
    current week, so "this week's priority" has to mean the week the
    email is ABOUT, not the calendar week the viewer happens to be sitting
    in when they set it.

    Real bug, live 08/09/2026 (Tomás: "I chose Discovery, but nothing
    changed" — then Kris, looking at the same mismatch from the other
    side: "Why objection handling sent when clearly it is marked
    discovery"): this used to return the CURRENT week's Monday (one week
    LATER than the value Apps Script actually reads), so an override set
    through the dashboard could never match the lookup Apps Script does
    when building that week's email — every override silently no-op'd,
    every single time, regardless of which day of the week it was set on.

    `now` is injectable (defaults to the real current time) so tests can
    pin a specific day of the week without monkeypatching datetime.now.
    """
    now = now or datetime.now(ZoneInfo(BUSINESS_TIMEZONE))
    this_monday = now.date() - timedelta(days=now.weekday())
    last_completed_week_start = this_monday - timedelta(days=7)
    return last_completed_week_start.strftime("%d/%m/%Y")


def current_training_priority_override(rep):
    """The LAST row in training_priority_overrides matching (rep, this
    week's Monday) — same "last write wins" convention as Phase1_
    ComplianceCheck.gs's findTrainingPriorityOverride_, so what's shown here
    always matches what Apps Script will actually use. None if Tomás hasn't
    set one for this week."""
    conn = get_conn()
    row = conn.execute(
        "SELECT priority, set_by, set_at FROM training_priority_overrides "
        "WHERE rep = ? AND week_start = ? ORDER BY id DESC LIMIT 1",
        (rep, current_week_start_label()),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


# Must mirror SEAN_FOLLOWUP_CONFIG.CADENCE2_REPS/CADENCE2_CALL_TYPES/
# CADENCE2_STEPS in Phase17_SeanFollowUpAutomation.gs exactly — this is a
# read-only Python re-derivation of that file's findLastRealCallPerLead_/
# cadence2ReengagementSchedule_ against the same Sales Call Log data (mirrored
# here via sync.py), for /reps/{rep}/leads (Kris's ask, 07/09/2026: "would be
# nice for each rep to be able to see a list of all their old leads, in order
# of priority"). If Cadence 2's config ever changes over there, update here too.
REENGAGEMENT_REPS = ["Bens", "Joana", "Sean", "Tomás"]
REENGAGEMENT_CALL_TYPES = ["QC", "Sales Call"]
REENGAGEMENT_STEPS = [
    ("1 week", 0, 7),
    ("1 month", 1, 0),
    ("3 months", 3, 0),
    ("6 months", 6, 0),
    ("12 months", 12, 0),
]


def reengagement_lead_key(email, name):
    """Same identity rule as reengagementLeadKey_ (Phase17_SeanFollowUpAutomation.gs):
    email when present (lowercased/trimmed), else the lowercased/trimmed name —
    good enough to group rows for one lead without a stable ID column."""
    email = (email or "").strip().lower()
    if email:
        return f"email:{email}"
    return f"name:{(name or '').strip().lower()}"


def _add_months_and_days(d, months, days):
    y, m = _month_add(d.year, d.month, months)
    # Clamp the day (e.g. Jan 31 + 1 month must not crash on Feb 31) — plain
    # calendar arithmetic, same tolerance as addMonthsAndDays_'s JS Date
    # auto-rollover, just explicit here since Python's date() rejects invalid
    # day-of-month instead of rolling over.
    import calendar

    day = min(d.day, calendar.monthrange(y, m)[1])
    return date(y, m, day) + timedelta(days=days)


def reengagement_schedule(last_call_date):
    """The full 1wk/1mo/3mo/6mo/12mo schedule for one lead, anchored to their
    last real call — mirrors cadence2ReengagementSchedule_. Pure."""
    return [
        {"label": label, "due_at": _add_months_and_days(last_call_date, months, days)}
        for label, months, days in REENGAGEMENT_STEPS
    ]


def last_real_call_per_lead(call_rows):
    """Pure. Mirrors findLastRealCallPerLead_ — for every (rep, lead) pair
    with at least one Cadence-2-eligible call, keeps only their single most
    recent one, excluding any lead already Sold. `call_rows` is a list of
    dicts with rep/call_type/call_date (a date)/prospect_name/prospect_email/
    outcome_disposition keys."""
    by_key = {}
    for row in call_rows:
        raw_rep = (row.get("rep") or "").strip()
        rep = next((r for r in REENGAGEMENT_REPS if r.lower() == raw_rep.lower()), None)
        if not rep:
            continue
        call_type = (row.get("call_type") or "").strip()
        if call_type not in REENGAGEMENT_CALL_TYPES:
            continue
        call_date = row.get("call_date")
        if not isinstance(call_date, date):
            continue
        lead_key = reengagement_lead_key(row.get("prospect_email"), row.get("prospect_name"))
        key = (rep, lead_key)
        existing = by_key.get(key)
        if existing is None or call_date > existing["call_date"]:
            by_key[key] = {
                "rep": rep,
                "lead_key": lead_key,
                "prospect_name": row.get("prospect_name") or "(unnamed)",
                "prospect_email": (row.get("prospect_email") or "").strip(),
                "call_type": call_type,
                "call_date": call_date,
                "outcome_disposition": (row.get("outcome_disposition") or "").strip(),
            }
    return [c for c in by_key.values() if c["outcome_disposition"].strip().lower() != "sold"]


def reengagement_leads_for_rep(rep, call_rows, override_actions, today=None):
    """Every one of `rep`'s stalled leads (from last_real_call_per_lead),
    each annotated with its current/next Cadence 2 step and override status,
    sorted so the rep sees what needs attention first: active leads by days
    stalled (most overdue first), then deprioritized leads (same order),
    then cancelled leads last. `override_actions` is {(rep, lead_key):
    action} — same shape write_reengagement_override's mirrored table
    produces (last row per rep+lead wins, computed by the caller)."""
    today = today or datetime.now(ZoneInfo(BUSINESS_TIMEZONE)).date()
    leads = []
    for c in last_real_call_per_lead(call_rows):
        if c["rep"] != rep:
            continue
        schedule = reengagement_schedule(c["call_date"])
        due_steps = [s for s in schedule if s["due_at"] <= today]
        upcoming_steps = [s for s in schedule if s["due_at"] > today]
        current_step = due_steps[-1] if due_steps else None
        next_step = upcoming_steps[0] if upcoming_steps else None
        action = override_actions.get((rep, c["lead_key"]), "active")
        leads.append(
            {
                "prospect_name": c["prospect_name"],
                "prospect_email": c["prospect_email"],
                "lead_key": c["lead_key"],
                "call_type": c["call_type"],
                "call_date": c["call_date"],
                "days_since_call": (today - c["call_date"]).days,
                "current_step": current_step["label"] if current_step else None,
                "next_step": next_step["label"] if next_step else None,
                "next_step_due_at": next_step["due_at"] if next_step else None,
                "action": action,
            }
        )
    status_rank = {"active": 0, "deprioritized": 1, "cancelled": 2}
    leads.sort(key=lambda item: (status_rank.get(item["action"], 0), -item["days_since_call"]))
    return leads


def reengagement_override_actions():
    """{(rep, lead_key): last action} across every rep — last row per
    (rep, lead_email/lead_name) wins, same "append-only, last write wins"
    convention as current_training_priority_override above."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT rep, lead_email, lead_name, action FROM reengagement_overrides ORDER BY id ASC"
    ).fetchall()
    conn.close()
    actions = {}
    for r in rows:
        if not r["rep"] or not r["action"]:
            continue
        actions[(r["rep"], reengagement_lead_key(r["lead_email"], r["lead_name"]))] = r["action"]
    return actions


def rep_call_rows_for_reengagement():
    """Every sales_call_log row shaped for last_real_call_per_lead, with
    Call Date already parsed into a real date (or None, filtered out by
    last_real_call_per_lead's own isinstance check)."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT rep, call_type, call_date, prospect_name, prospect_email, outcome_disposition FROM sales_call_log"
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        d = dict(r)
        d["call_date"] = parse_call_date(d["call_date"])
        out.append(d)
    return out


#  Kris's ask (08/09/2026): "The playbook needs to have a training plan for
#  Tomas on how to teach discovery." The fixed rep->playbook mapping below
#  is wrong for this — it's a one-doc-per-REP scheme built for objection
#  handling, which is what every rep who takes Sales Calls is trained on by
#  default, but discovery is a TOPIC, not a rep identity, and any rep can
#  have it as their priority for a given week. When that's this rep's
#  current override, show the discovery doc instead of their fixed one.
TOPIC_TO_PLAYBOOK_SLUG = {"discovery": "discovery"}


def topic_playbook_slug_for(rep, current_priority):
    """The topic playbook to show this rep, preferring THEIR OWN version of
    it over the shared one.

    Tomás, 08/09/2026, looking at the shared Discovery doc on Joana's page:
    "the playbook is not just about Joana, it's talking about Sean. And even
    the only example that it gives, it was about Sean. About the Frank
    Pirrone... this is Joana, so there's not really much to go for."

    So a rep with a per-rep topic doc gets that one ("discovery-sean"), and
    everyone else falls back to the shared doc ("discovery") — which is
    written to be genuinely generic rather than one rep's worked example.
    Returns None when the priority isn't a topic we have any doc for.
    """
    base = TOPIC_TO_PLAYBOOK_SLUG.get(str(current_priority or "").strip().lower())
    if not base:
        return None
    per_rep = f"{base}-{str(rep or '').strip().lower()}"
    if any(p["slug"] == per_rep for p in PLAYBOOKS):
        return per_rep
    return base


def rep_playbook(rep, current_priority=None):
    """The one PLAYBOOKS doc to show for this rep this week: their own topic
    doc if one exists, else the shared topic doc, else the fixed per-rep doc
    (REP_TO_PLAYBOOK_SLUG), else None — a single doc, not the full list
    /training used to dump on one combined page."""
    topic_slug = topic_playbook_slug_for(rep, current_priority)
    slug = topic_slug or REP_TO_PLAYBOOK_SLUG.get(rep)
    if not slug:
        return None
    pb = next((p for p in PLAYBOOKS if p["slug"] == slug), None)
    if not pb:
        return None
    try:
        sections = render_playbook(REPO_ROOT, pb["filename"])
    except FileNotFoundError:
        sections = None
    return {"slug": pb["slug"], "title": pb["title"], "sections": sections}


@app.get("/reps/{rep}", response_class=HTMLResponse)
def rep_detail_page(request: Request, rep: str, call_type: str = ""):
    calls = rep_detail(rep, call_type=call_type)
    total = len(calls)
    scored = [c for c in calls if c["call_quality_score"] is not None]
    avg_score = round(sum(c["call_quality_score"] for c in scored) / len(scored), 2) if scored else None
    priority_override = current_training_priority_override(rep)
    return render(
        request,
        "rep_detail.html",
        {
            "active_page": "",
            "freshness": freshness_status(),
            "rep": rep,
            "total": total,
            "avg_score": avg_score,
            "calls": calls,
            "call_type_filter": call_type,
            "score_over_time": _rep_score_series(rep),
            "outcomes": outcome_breakdown(rep),
            "outcome_missing_key": OUTCOME_MISSING,
            "framework_gaps": framework_gap_breakdown(rep),
            "scorecard_history": rep_scorecard_history(rep),
            "playbook": rep_playbook(rep, priority_override["priority"] if priority_override else None),
            "current_priority_override": priority_override,
            "training_priority_options": TRAINING_PRIORITY_OPTIONS,
            "reengagement_eligible": rep in REENGAGEMENT_REPS,
        },
    )


@app.post("/reps/{rep}/priority-override")
def set_priority_override(request: Request, rep: str, priority: str = Form(...)):
    """Kris's ask (07/09/2026): "every Tuesday morning... tell him what the
    priority is for each sales rep... if he does nothing, it goes with that.
    Otherwise, he can log into the interface and change it." This is that
    change: a one-week override of the auto-computed weekly training focus,
    written straight to the "Training Priority Overrides" sheet tab
    (sheets_write.py) that Phase1_ComplianceCheck.gs's weekly playbook review
    reads before falling back to its own auto-computed pick."""
    week_start = current_week_start_label()
    try:
        sheets_write.write_training_priority_override(
            rep, week_start, priority, request.session.get("user_email") or ""
        )
    except Exception as e:
        # Same "surface it, don't pretend it worked" rule as /review/decide —
        # this write is the one thing this button exists to do.
        return HTMLResponse(
            f"<p>Could not save that priority override to the spreadsheet:</p>"
            f"<pre style='white-space:pre-wrap;'>{html.escape(str(e))}</pre>"
            f"<p><a href='/reps/{rep}'>Back to {html.escape(rep)}</a></p>",
            status_code=500,
        )
    return RedirectResponse(url=f"/reps/{rep}", status_code=303)


REENGAGEMENT_OVERRIDE_ACTIONS = {"cancel": "cancelled", "deprioritize": "deprioritized", "reactivate": "active"}


@app.get("/reps/{rep}/leads", response_class=HTMLResponse)
def rep_leads_page(request: Request, rep: str):
    """Kris's ask (07/09/2026): "would be nice for each rep to be able to see
    a list of all their old leads, in order of priority and the rep can then
    lower the priority or cancel the follow up." Ranked list of every stalled
    (non-Sold, non-fresh) lead this rep owns, re-derived from the Sales Call
    Log the same way Phase17_SeanFollowUpAutomation.gs's Cadence 2 detection
    does (reengagement_leads_for_rep). Only Bens/Joana/Sean/Tomás have
    Cadence-2-eligible leads at all (REENGAGEMENT_REPS)."""
    leads = reengagement_leads_for_rep(rep, rep_call_rows_for_reengagement(), reengagement_override_actions())
    return render(
        request,
        "rep_leads.html",
        {
            "active_page": "",
            "freshness": freshness_status(),
            "rep": rep,
            "leads": leads,
        },
    )


@app.post("/reps/{rep}/leads/override")
def set_reengagement_override(
    request: Request,
    rep: str,
    lead_key: str = Form(...),
    lead_email: str = Form(""),
    lead_name: str = Form(""),
    action: str = Form(...),
):
    """Writes one Cancel/Lower Priority/Reactivate decision straight to the
    "Re-engagement Overrides" sheet tab (sheets_write.py) — Phase17_
    SeanFollowUpAutomation.gs's Cadence 2 digest (findDueReengagements_) reads
    it back and skips a 'cancelled' lead entirely; 'deprioritized' only
    affects this page's own sort order. lead_key isn't written anywhere (the
    sheet stores email/name, same as everything else) — it's only here so the
    form can echo back which row was acted on if the write fails."""
    if action not in REENGAGEMENT_OVERRIDE_ACTIONS:
        return HTMLResponse(f"Unknown action {html.escape(action)!r}.", status_code=400)
    try:
        sheets_write.write_reengagement_override(
            rep, lead_email, lead_name, REENGAGEMENT_OVERRIDE_ACTIONS[action],
            request.session.get("user_email") or "",
        )
    except Exception as e:
        # Same "surface it, don't pretend it worked" rule as /review/decide
        # and /reps/{rep}/priority-override above.
        return HTMLResponse(
            f"<p>Could not save that to the spreadsheet:</p>"
            f"<pre style='white-space:pre-wrap;'>{html.escape(str(e))}</pre>"
            f"<p><a href='/reps/{rep}/leads'>Back to {html.escape(rep)}'s leads</a></p>",
            status_code=500,
        )
    return RedirectResponse(url=f"/reps/{rep}/leads", status_code=303)


def _rep_score_series(rep):
    full = score_over_time("week")
    for s in full["series"]:
        if s["rep"] == rep:
            return {"labels": full["labels"], "data": s["data"]}
    return {"labels": [], "data": []}


def all_reps_list():
    conn = get_conn()
    rows = conn.execute(
        "SELECT DISTINCT rep FROM sales_call_log WHERE rep IS NOT NULL AND rep != '' ORDER BY rep"
    ).fetchall()
    conn.close()
    return [r["rep"] for r in rows]


def sanitize_fts5_query(q):
    """Turns free-text search-box input into a safe FTS5 MATCH expression.

    Real bug (M-03): the raw query string used to be passed straight to
    MATCH, but FTS5 MATCH syntax is a small query LANGUAGE, not literal
    text — a bareword "or"/"not"/"near" is a boolean operator, a leading
    "-" on a term excludes it, and "column:term" filters by column. A user
    innocently searching for the word "or", or a phrase like "not sure" or
    "day-to-day", got silently reinterpreted as an operator expression
    instead of literal text — wrong (sometimes empty, sometimes just
    confusing) results with no error at all. Wrapping every individual
    token in its own escaped double-quoted phrase (FTS5's literal-string
    syntax — a doubled `""` escapes a literal quote inside one) forces
    every token to match as plain text; space-separated quoted phrases are
    ANDed by default, preserving the original "all these words" behavior.
    """
    tokens = q.split()
    if not tokens:
        return ""
    return " ".join('"' + t.replace('"', '""') + '"' for t in tokens)


# call_type in the Sales Call Log's own dropdown is only QC/Sales Call/
# Discovery (Phase1_ComplianceCheck.gs setupSalesCallLog_) — there is no
# distinct "2nd sales call / closing call" option to log against, but the
# scoring pipeline already needs that distinction to pick a rubric (see
# resolveRubricVariantForRow_ in Phase2_CallScoring.gs: a Sales Call scored
# under Tomás is always his closing-call rubric, since Tomás only ever runs
# follow-up/closing calls per buildTomasJudgeSystemPrompt_'s own header
# comment). Mirrors that exact rule here for display only — no new column,
# nothing written back to the sheet — so "Type" in the browser reads the
# same way the AI judge already treats the call.
def _display_call_type(call_type, rep):
    if call_type == "Sales Call" and rep in ("Tomás", "Tomas"):
        return "2nd Sales Call (Closing)"
    if call_type == "Sales Call":
        return "Sales Call (1st)"
    return call_type


def filtered_calls(
    rep="", verdict="", failure_mode="", min_score=None, max_score=None,
    asked_for_close="", objections_handled="", match_method="", outcome_disposition="",
    framework_explained="", q="", call_type_display="", limit=200,
):
    """Backs the /calls browser. With `q` set, searches call_search (FTS5
    over every call's AI Feedback Summary — sync.py rebuilds this index
    every sync cycle, unlike playbooks.py's FTS5 table which only covers
    the 3 curated markdown playbooks and only rebuilds at app startup).
    Other filters combine with the search rather than being mutually
    exclusive with it."""
    conn = get_conn()
    conn.row_factory = sqlite3.Row
    q = q.strip() if q else ""
    try:
        if q:
            sql = (
                "SELECT s.id, s.prospect_name, s.rep, s.call_date, s.call_type, s.lead_quality_verdict, "
                "s.call_quality_score, s.primary_failure_mode, s.transcript_url, "
                "s.outcome_disposition, s.flag_framework_explained, s.framework_gaps, "
                # \x01/\x02 (not real HTML) mark the highlight boundaries so they
                # survive html.escape() below untouched — see the escaping step
                # after the query runs for why (M-05).
                "snippet(call_search, 4, '\x01', '\x02', '…', 20) AS snippet, "
                # Full, un-truncated text for the click-to-expand feedback modal —
                # the FTS snippet() above is deliberately clipped to ~20 tokens
                # around the match, which isn't enough to read the whole
                # feedback_summary the AI judge wrote.
                "s.ai_feedback_summary AS full_feedback "
                "FROM call_search cs JOIN sales_call_log s ON s.id = cs.call_id "
                "WHERE call_search MATCH ?"
            )
            params = [sanitize_fts5_query(q)]
        else:
            sql = (
                "SELECT id, prospect_name, rep, call_date, call_type, lead_quality_verdict, "
                "call_quality_score, primary_failure_mode, transcript_url, outcome_disposition, "
                "flag_framework_explained, framework_gaps, "
                "ai_feedback_summary AS snippet, ai_feedback_summary AS full_feedback "
                "FROM sales_call_log s WHERE 1=1"
            )
            params = []

        prefix = "s." if q else ""
        if rep:
            sql += f" AND {prefix}rep = ?"
            params.append(rep)
        if verdict:
            sql += f" AND {prefix}lead_quality_verdict = ?"
            params.append(verdict)
        if failure_mode:
            sql += f" AND {prefix}primary_failure_mode = ?"
            params.append(failure_mode)
        if min_score is not None:
            sql += f" AND {prefix}call_quality_score >= ?"
            params.append(min_score)
        if max_score is not None:
            sql += f" AND {prefix}call_quality_score <= ?"
            params.append(max_score)
        if asked_for_close in ("yes", "no"):
            sql += f" AND {prefix}flag_asked_for_close = ?"
            params.append(1 if asked_for_close == "yes" else 0)
        if objections_handled in ("yes", "no"):
            sql += f" AND {prefix}flag_objections_handled = ?"
            params.append(1 if objections_handled == "yes" else 0)
        if framework_explained in ("yes", "no"):
            sql += f" AND {prefix}flag_framework_explained = ?"
            params.append(1 if framework_explained == "yes" else 0)
        if match_method:
            sql += f" AND {prefix}match_method = ?"
            params.append(match_method)
        if outcome_disposition == OUTCOME_MISSING:
            # The nudge target: scored calls nobody ever logged an outcome for.
            sql += (
                f" AND ({prefix}outcome_disposition IS NULL"
                f" OR TRIM({prefix}outcome_disposition) = '')"
            )
        elif outcome_disposition:
            # Case-insensitive: reps hand-type this column.
            sql += f" AND LOWER(TRIM({prefix}outcome_disposition)) = ?"
            params.append(outcome_disposition.strip().lower())

        if call_type_display == "2nd Sales Call (Closing)":
            sql += f" AND {prefix}call_type = 'Sales Call' AND {prefix}rep IN ('Tomás', 'Tomas')"
        elif call_type_display == "Sales Call (1st)":
            sql += f" AND {prefix}call_type = 'Sales Call' AND {prefix}rep NOT IN ('Tomás', 'Tomas')"
        elif call_type_display:
            sql += f" AND {prefix}call_type = ?"
            params.append(call_type_display)

        if q:
            sql += " ORDER BY rank LIMIT ?"
        else:
            sql += " LIMIT ?"
        params.append(limit)

        rows = conn.execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        # malformed FTS5 query syntax (e.g. an unbalanced quote in the search box)
        rows = []
    finally:
        conn.close()

    calls = [dict(r) for r in rows]
    if q:
        # Real bug (M-05): the template renders this snippet with `| safe` so
        # the <mark> highlight tags work — but snippet() returns raw text
        # straight from ai_feedback_summary (an AI-written summary that can
        # echo transcript content verbatim), so any literal "<"/">" in that
        # text would render as real markup: stored XSS. \x01/\x02 (not real
        # HTML — see the query above) stand in for the mark tags through
        # html.escape(), then get swapped for the real tags afterward, so the
        # untrusted text is escaped and only the trusted wrapper is HTML.
        for c in calls:
            if c.get("snippet"):
                c["snippet"] = (
                    html.escape(c["snippet"]).replace("\x01", "<mark>").replace("\x02", "</mark>")
                )
    else:
        calls.sort(key=lambda c: parse_call_date(c["call_date"]) or datetime.min.date(), reverse=True)
    for c in calls:
        c["call_type_display"] = _display_call_type(c.get("call_type"), c.get("rep"))
    return calls


def _int_or_none(v):
    """Real bug (P1): FastAPI/pydantic rejects an empty-string query param
    against an `int` type with a 422, rather than treating it as "not
    provided" — but a filter form's number input submits `min_score=` (an
    empty string), not an omitted param, when left blank. Declaring these
    params as plain `str` and converting through this instead means a blank
    filter field degrades to "no filter" like every other blank field on
    this same form, rather than the whole page erroring out."""
    if v is None or v == "":
        return None
    try:
        return int(v)
    except ValueError:
        return None


@app.get("/calls", response_class=HTMLResponse)
def calls_page(
    request: Request,
    rep: str = "",
    verdict: str = "",
    failure_mode: str = "",
    min_score: str = "",
    max_score: str = "",
    asked_for_close: str = "",
    objections_handled: str = "",
    match_method: str = "",
    outcome_disposition: str = "",
    framework_explained: str = "",
    call_type_display: str = "",
    q: str = "",
):
    min_score = _int_or_none(min_score)
    max_score = _int_or_none(max_score)
    return render(
        request,
        "calls.html",
        {
            "active_page": "calls",
            "freshness": freshness_status(),
            "all_reps": all_reps_list(),
            "calls": filtered_calls(
                rep, verdict, failure_mode, min_score, max_score,
                asked_for_close, objections_handled, match_method,
                outcome_disposition, framework_explained, call_type_display, q,
            ),
            "filters": {
                "rep": rep, "verdict": verdict, "failure_mode": failure_mode,
                "min_score": min_score, "max_score": max_score, "q": q,
                "asked_for_close": asked_for_close, "objections_handled": objections_handled,
                "match_method": match_method,
                "outcome_disposition": outcome_disposition,
                "framework_explained": framework_explained,
                "call_type_display": call_type_display,
            },
            "outcome_missing_key": OUTCOME_MISSING,
            "all_outcomes": [d["disposition"] for d in outcome_breakdown()["distribution"]],
            "all_call_types": ["QC", "Discovery", "Sales Call (1st)", "2nd Sales Call (Closing)"],
        },
    )


@app.get("/queue", response_class=HTMLResponse)
def queue_page(request: Request, rep: str = ""):
    return render(
        request,
        "queue.html",
        {
            "active_page": "queue",
            "freshness": freshness_status(),
            "queue": review_queue(rep),
            "calibration": calibration_agreement(),
            "filter_rep": rep,
        },
    )


# Reverse of REP_TO_PLAYBOOK_SLUG, for turning a search result's doc_slug
# back into a link to that rep's own page instead of dumping every playbook's
# full text onto this shared page (25/08/2026 — was one long combined
# scroll of all three; moved the full text to each rep's own /reps/{rep}
# page, this page keeps only cross-rep search).
PLAYBOOK_SLUG_TO_REP = {v: k for k, v in REP_TO_PLAYBOOK_SLUG.items()}


@app.get("/training", response_class=HTMLResponse)
def training_page(request: Request, q: str = ""):
    return render(
        request,
        "training.html",
        {
            "active_page": "training",
            "freshness": freshness_status(),
            "assignments": training_assignments(),
            "practice_status": daily_practice_status(),
            "leaderboard": leaderboard(),
            "leaderboard_recent_calls": LEADERBOARD_RECENT_CALLS,
            "query": q,
            "search_results": search_playbooks(DB_PATH, q) if q else [],
            "playbook_slug_to_rep": PLAYBOOK_SLUG_TO_REP,
        },
    )


@app.get("/charts", response_class=HTMLResponse)
def charts_page(request: Request):
    return render(
        request,
        "charts.html",
        {"active_page": "charts", "freshness": freshness_status()},
    )


@app.get("/api/charts")
def charts_data(granularity: str = "week"):
    if granularity not in ("day", "week", "month", "year", "all"):
        granularity = "week"
    return {
        "score_over_time": score_over_time(granularity),
        "lead_quality": lead_quality_distribution(),
        "failure_modes": failure_mode_breakdown(),
        "rep_summary": rep_summary(),
    }


@app.get("/api/leads")
def leads_api(verdict: str = "", failure_mode: str = "", rep: str = ""):
    return {"leads": get_leads(verdict=verdict or None, failure_mode=failure_mode or None, rep=rep or None)}


# Kris, 06/09/2026: "This project has an interface. Is it easy enough to put
# it in an interface with a GREEN / RED button for him to quickly review
# each?" — Tomás's approve/reject work on "CRM Organization Review" and
# "Lead Reconciliation - All" (Phase15_CrmOrganizationReview.gs /
# Phase13_LeadReconciliation.gs) otherwise means opening the spreadsheet and
# hunting through hundreds of rows for the ones still unticked. This is that
# interface: one finding/lead at a time, two big buttons, writes straight
# back to the sheet via sheets_write.py. "Undecided" = neither checkbox
# ticked yet in the mirrored table.
#
# Kris, 06/09/2026, after trying it: "Should we not split into two? CRM
# review and then lead review" — a single combined queue meant the 13 CRM
# findings always came first (see review_queue_rows below, unchanged
# ordering) and the "Show everything" noise toggle looked like it did
# nothing, since it only affects leads further down a queue you can't see
# yet. Split into two separate queues/pages instead: /review/crm (13 items,
# no noise concept) and /review/leads (477, with its own noise toggle) — a
# landing page at /review just shows both counts and links to each.
def crm_review_pending_rows():
    conn = get_conn()
    # Real bug found live (06/09/2026): needs_more_info was added via ALTER
    # TABLE to an already-populated table (_add_column_if_missing, sync.py)
    # — SQLite sets that column to NULL on every pre-existing row, not 0,
    # and "NULL = 0" is never true in SQL. Every already-written finding
    # silently vanished from the queue after the app restarted, before the
    # next sync cycle overwrote NULL with a real 0/1 read from the Sheet.
    # COALESCE(..., 0) treats "never set" the same as "explicitly false"
    # so this can't happen again on the next column ever added the same way.
    rows = conn.execute(
        "SELECT sheet_row, timestamp, category, finding, evidence, suggested_action "
        "FROM crm_organization_review "
        "WHERE approve = 0 AND reject = 0 AND COALESCE(needs_more_info, 0) = 0 ORDER BY sheet_row"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def lead_review_pending_rows():
    conn = get_conn()
    rows = conn.execute(
        "SELECT sheet_row, timestamp, name, email, status, sources, likely_noise, "
        "noise_reason, ambiguous_matches, dedupe_key FROM lead_reconciliation "
        "WHERE real_lead = 0 AND not_real_lead = 0 AND COALESCE(needs_more_info, 0) = 0 "
        "ORDER BY likely_noise ASC, sheet_row"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def needs_more_info_rows():
    """Kris, 06/09/2026: "Add another button. Don't know...so that if he
    doesn't understand he can just hit that. Then afterwards, you can do an
    analysis and give him more information to make the right decision." —
    everything currently set aside as "unsure," across both queues, so it
    can be found and researched instead of getting stuck as the same
    confusing card blocking the rest of the swipe queue."""
    conn = get_conn()
    crm_rows = conn.execute(
        "SELECT sheet_row, timestamp, category, finding, evidence, suggested_action "
        "FROM crm_organization_review WHERE needs_more_info = 1 ORDER BY sheet_row"
    ).fetchall()
    lead_rows = conn.execute(
        "SELECT sheet_row, timestamp, name, email, status, sources, ambiguous_matches "
        "FROM lead_reconciliation WHERE needs_more_info = 1 ORDER BY sheet_row"
    ).fetchall()
    conn.close()
    cards = []
    for r in crm_rows:
        d = dict(r)
        d["table"] = "crm_organization_review"
        d["card_type"] = "crm"
        cards.append(d)
    for r in lead_rows:
        d = dict(r)
        d["table"] = "lead_reconciliation"
        d["card_type"] = "lead"
        cards.append(d)
    return cards


def lead_related_calls(name):
    """Kris, 06/09/2026: "Need information on the leads too. He can't make a
    decision on this" — a bare name and a "Sales Call Log:3" source citation
    isn't enough for Tomás to recognize who someone is. Pulls the actual
    call(s) already mirrored in sales_call_log for this name (case/whitespace
    -insensitive, since that's exactly how Phase13's own dedupe key folds
    names) so the review card can show call date, rep, type, outcome, score,
    and the AI's own summary — the context a human actually needs to decide
    "real lead" or "not a lead." Best-effort: matched by name text, not a
    stable row id (Phase13's lead.sourceRow isn't mirrored here), so a lead
    whose name doesn't exactly match its own Sales Call Log row (a rename, a
    typo fixed later) simply shows no related calls rather than a wrong one."""
    if not name or not name.strip():
        return []
    conn = get_conn()
    rows = conn.execute(
        "SELECT call_date, rep, call_type, outcome_disposition, call_quality_score, "
        "ai_feedback_summary, transcript_url, prospect_email FROM sales_call_log "
        "WHERE LOWER(TRIM(prospect_name)) = LOWER(TRIM(?))",
        (name,),
    ).fetchall()
    conn.close()
    calls = [dict(r) for r in rows]
    calls.sort(key=lambda c: parse_call_date(c["call_date"]) or datetime.min.date(), reverse=True)
    return calls


@app.get("/review", response_class=HTMLResponse)
def review_index(request: Request):
    crm_pending = crm_review_pending_rows()
    lead_pending = lead_review_pending_rows()
    lead_candidates = [r for r in lead_pending if not r.get("likely_noise")]
    return render(
        request,
        "review_index.html",
        {
            "active_page": "review",
            "freshness": freshness_status(),
            "crm_count": len(crm_pending),
            "lead_count": len(lead_pending),
            "lead_candidate_count": len(lead_candidates),
            "needs_info_count": len(needs_more_info_rows()),
        },
    )


@app.get("/review/crm", response_class=HTMLResponse)
def review_crm_page(request: Request):
    cards = crm_review_pending_rows()
    return render(
        request,
        "review.html",
        {
            "active_page": "review",
            "freshness": freshness_status(),
            "review_type": "crm",
            "cards": cards,
            "total_pending": len(cards),
        },
    )


@app.get("/review/leads", response_class=HTMLResponse)
def review_leads_page(request: Request, only_candidates: str = "1"):
    cards = lead_review_pending_rows()
    total_all = len(cards)
    if only_candidates != "0":
        # "Candidates" mirrors the same noise filter Phase13's own
        # "Lead Reconciliation - Candidates" sheet applies (outreach-tool
        # sender addresses, newsletters, recording filenames) — advisory
        # only there, and the same here: still just a default view, never a
        # decision, so "Show everything" always stays one click away.
        cards = [c for c in cards if not c.get("likely_noise")]
    if cards:
        # Only the visible card needs its related calls looked up — no
        # point querying for the other 500 that aren't on screen yet.
        related = lead_related_calls(cards[0].get("name"))
        cards[0]["related_calls"] = related
        # Kris, 06/09/2026: "Can you add more information like email... or
        # what member of our team spoke with them when" — a lead's own
        # Email column is often blank (that's part of why it's not_found),
        # but the matching Sales Call Log row frequently has one anyway.
        # Fall back to it rather than showing nothing when the lead itself
        # doesn't carry an email.
        if not cards[0].get("email"):
            for c in related:
                if c.get("prospect_email"):
                    cards[0]["email"] = c["prospect_email"]
                    break
    return render(
        request,
        "review.html",
        {
            "active_page": "review",
            "freshness": freshness_status(),
            "review_type": "leads",
            "cards": cards,
            "total_pending": len(cards),
            "total_all_pending": total_all,
            "only_candidates": only_candidates,
        },
    )


@app.get("/review/needs-info", response_class=HTMLResponse)
def review_needs_info_page(request: Request):
    return render(
        request,
        "review_needs_info.html",
        {
            "active_page": "review",
            "freshness": freshness_status(),
            "cards": needs_more_info_rows(),
        },
    )


@app.post("/review/needs-info/reset")
def review_needs_info_reset(request: Request, table: str = Form(...), sheet_row: int = Form(...)):
    """Puts an "unsure" row back to pending — e.g. once someone has done the
    analysis Kris asked for and it's ready for Tomás to decide on again."""
    if table not in _REVIEW_TABLE_INFO:
        return HTMLResponse(f"<p>Unknown review table {table!r}.</p>", status_code=400)
    conn = get_conn()
    try:
        _clear_row(table, sheet_row, conn)
    except Exception as e:
        conn.close()
        return HTMLResponse(
            f"<p>Could not reset that row:</p>"
            f"<pre style='white-space:pre-wrap;'>{html.escape(str(e))}</pre>"
            f"<p><a href='/review/needs-info'>Back</a></p>",
            status_code=500,
        )
    conn.execute(
        "UPDATE review_decisions_log SET undone = 1 WHERE table_name = ? AND sheet_row = ? AND undone = 0",
        (table, sheet_row),
    )
    conn.commit()
    conn.close()
    return RedirectResponse(url="/review/needs-info", status_code=303)


# table -> the page to send the reviewer back to after a decision, and the
# local-mirror column each of the three decisions ("approve"/"reject"/
# "unsure") updates (see review_decide below). "unsure" is the "Needs More
# Info"/"Don't know" button (Kris, 06/09/2026).
_REVIEW_TABLE_INFO = {
    "crm_organization_review": {
        "back_url": "/review/crm",
        "columns": {"approve": "approve", "reject": "reject", "unsure": "needs_more_info"},
    },
    "lead_reconciliation": {
        "back_url": "/review/leads",
        "columns": {"approve": "real_lead", "reject": "not_real_lead", "unsure": "needs_more_info"},
    },
}


def _review_row_label(conn, table, sheet_row):
    """A human-readable one-liner for review_decisions_log, snapshotted at
    decide-time (see that table's own comment in sync.py for why)."""
    if table == "crm_organization_review":
        row = conn.execute(
            "SELECT category, finding FROM crm_organization_review WHERE sheet_row = ?", (sheet_row,)
        ).fetchone()
        return f"{row[0]}: {row[1]}" if row else f"(CRM row {sheet_row})"
    if table == "lead_reconciliation":
        row = conn.execute(
            "SELECT name, email FROM lead_reconciliation WHERE sheet_row = ?", (sheet_row,)
        ).fetchone()
        if not row:
            return f"(lead row {sheet_row})"
        name = row[0] or "(no name)"
        return f"{name} — {row[1]}" if row[1] else name
    return f"(row {sheet_row})"


@app.post("/review/decide")
def review_decide(
    request: Request,
    table: str = Form(...),
    sheet_row: int = Form(...),
    decision: str = Form(...),
    only_candidates: str = Form("1"),
):
    info = _REVIEW_TABLE_INFO.get(table)
    if info is None:
        return HTMLResponse(f"<p>Unknown review table {table!r}.</p>", status_code=400)
    if decision not in ("approve", "reject", "unsure"):
        return HTMLResponse(f"<p>Unknown decision {decision!r}.</p>", status_code=400)

    back_url = info["back_url"] + (f"?only_candidates={only_candidates}" if table == "lead_reconciliation" else "")

    conn = get_conn()
    label = _review_row_label(conn, table, sheet_row)

    try:
        sheets_write.write_decision(table, sheet_row, decision)
    except Exception as e:
        conn.close()
        # Surface the failure to whoever clicked the button rather than
        # silently pretending it worked — a swallowed exception here means
        # Tomás's decision never actually reached the spreadsheet, the one
        # thing this whole page exists to do.
        #
        # Real bug found live (06/09/2026): the error message wasn't
        # HTML-escaped, so an exception whose text contains something that
        # looks like a tag (Google API error bodies sometimes do) rendered
        # as invisible markup instead of visible text — the error page
        # showed nothing after the colon. html.escape() here, and
        # <pre>/white-space so a long JSON error body stays readable.
        return HTMLResponse(
            f"<p>Could not save that decision to the spreadsheet:</p>"
            f"<pre style='white-space:pre-wrap;'>{html.escape(str(e))}</pre>"
            f"<p><a href='{back_url}'>Back to Review</a></p>",
            status_code=500,
        )

    # Update the local mirror immediately too, so this row doesn't reappear
    # in the queue for the next click — sync.py's next scheduled cycle will
    # overwrite this with the same values read back from the sheet anyway.
    cols = info["columns"]
    set_clause = ", ".join(f"{col} = ?" for col in cols.values())
    values = [1 if key == decision else 0 for key in cols] + [sheet_row]
    conn.execute(f"UPDATE {table} SET {set_clause} WHERE sheet_row = ?", values)
    # Kris, 06/09/2026: "Add to be able to review all the changes in the
    # interface with an UNDO and UNDO ALL button" — every decision made
    # through this route is logged so /review/history can show it and undo
    # it later; see review_decisions_log's own comment in sync.py.
    conn.execute(
        "INSERT INTO review_decisions_log (table_name, sheet_row, decision, label, decided_by, decided_at, undone) "
        "VALUES (?, ?, ?, ?, ?, ?, 0)",
        (table, sheet_row, decision, label, request.session.get("user_email") or "", datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()

    return RedirectResponse(url=back_url, status_code=303)


def review_decisions_log_rows():
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, table_name, sheet_row, decision, label, decided_by, decided_at, undone "
        "FROM review_decisions_log ORDER BY decided_at DESC, id DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/review/history", response_class=HTMLResponse)
def review_history_page(request: Request, message: str = "", show_undone: str = "0"):
    all_decisions = review_decisions_log_rows()
    undone_count = sum(1 for d in all_decisions if d["undone"])
    # Kris, 06/09/2026: "Make the undone actually disappear" — an undone
    # decision has already been reverted on the spreadsheet, so leaving it
    # visible here just clutters the list with entries there's nothing left
    # to do with. Hidden by default; still reachable via the toggle below
    # for anyone who wants to confirm something really was undone.
    decisions = all_decisions if show_undone == "1" else [d for d in all_decisions if not d["undone"]]
    return render(
        request,
        "review_history.html",
        {
            "active_page": "review",
            "freshness": freshness_status(),
            "decisions": decisions,
            "undone_count": undone_count,
            "show_undone": show_undone,
            "message": message,
        },
    )


def _undo_one(conn, log_row):
    """Undoes one logged decision: clears both sheet checkboxes, updates the
    local mirror, and marks the log entry undone — in that order, so a
    sheet-write failure (raised to the caller) leaves the log entry active
    and the mirror untouched rather than claiming an undo that didn't
    actually reach the spreadsheet."""
    _clear_row(log_row["table_name"], log_row["sheet_row"], conn)
    conn.execute("UPDATE review_decisions_log SET undone = 1 WHERE id = ?", (log_row["id"],))


def _clear_row(table, sheet_row, conn):
    """Unticks all three decision checkboxes on one row, on both the sheet
    and the local mirror. Shared by _undo_one (undoing one logged decision)
    and /review/needs-info/reset (putting an "unsure" row back to pending
    without necessarily going through a specific log entry)."""
    info = _REVIEW_TABLE_INFO[table]
    sheets_write.clear_decision(table, sheet_row)
    set_clause = ", ".join(f"{col} = 0" for col in info["columns"].values())
    conn.execute(f"UPDATE {table} SET {set_clause} WHERE sheet_row = ?", (sheet_row,))


@app.post("/review/undo")
def review_undo(request: Request, log_id: int = Form(...)):
    conn = get_conn()
    row = conn.execute(
        "SELECT id, table_name, sheet_row, undone FROM review_decisions_log WHERE id = ?", (log_id,)
    ).fetchone()
    if row is None:
        conn.close()
        return HTMLResponse(
            "<p>No such decision.</p><p><a href='/review/history'>Back to history</a></p>", status_code=404
        )
    if row["undone"]:
        conn.close()
        return RedirectResponse(url="/review/history", status_code=303)

    try:
        _undo_one(conn, dict(row))
    except Exception as e:
        conn.rollback()
        conn.close()
        return HTMLResponse(
            f"<p>Could not undo that decision:</p>"
            f"<pre style='white-space:pre-wrap;'>{html.escape(str(e))}</pre>"
            f"<p><a href='/review/history'>Back to history</a></p>",
            status_code=500,
        )
    conn.commit()
    conn.close()
    return RedirectResponse(url="/review/history", status_code=303)


@app.post("/review/undo_all")
def review_undo_all(request: Request):
    conn = get_conn()
    pending = conn.execute(
        "SELECT id, table_name, sheet_row FROM review_decisions_log WHERE undone = 0"
    ).fetchall()
    undone_count = 0
    failures = []
    for row in pending:
        row = dict(row)
        try:
            _undo_one(conn, row)
            conn.commit()
            undone_count += 1
        except Exception as e:
            conn.rollback()
            failures.append(f"row {row['sheet_row']} ({row['table_name']}): {e}")
    conn.close()

    if failures:
        message = f"Undid {undone_count} decision(s). {len(failures)} failed: " + "; ".join(failures[:5])
        if len(failures) > 5:
            message += f" ... and {len(failures) - 5} more"
    else:
        message = f"Undid {undone_count} decision(s)." if undone_count else "Nothing to undo."
    return RedirectResponse(url=f"/review/history?message={quote(message)}", status_code=303)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}
