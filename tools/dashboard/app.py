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
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware

import auth
from playbooks import PLAYBOOKS, reindex_playbooks, render_playbook, search_playbooks

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


app.add_middleware(RequireLoginMiddleware)
app.add_middleware(
    SessionMiddleware,
    secret_key=os.environ.get("DASHBOARD_SESSION_SECRET", "dev-only-insecure-secret-change-me"),
    same_site="lax",
)
app.include_router(auth.router)


def render(request: Request, name: str, context: dict):
    """templates.TemplateResponse, plus the logged-in user's email on every
    page (for the nav bar's "logged in as ..." + logout link) so every
    route doesn't have to remember to pass it themselves."""
    context = {**context, "user_email": request.session.get("user_email")}
    return templates.TemplateResponse(request, name, context)

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
    last_synced_at = datetime.fromisoformat(row["value"])
    age_minutes = (datetime.now(timezone.utc) - last_synced_at).total_seconds() / 60
    if age_minutes < FRESHNESS_WARN_MINUTES:
        level = "ok"
    elif age_minutes < FRESHNESS_STALE_MINUTES:
        level = "warn"
    else:
        level = "stale"
    return {"last_synced_at": last_synced_at, "age_minutes": age_minutes, "level": level}


def rep_summary():
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT
            rep,
            COUNT(*) AS total_calls,
            AVG(call_quality_score) AS avg_score,
            SUM(flag_asked_for_close) AS asked_for_close_count,
            SUM(flag_objections_handled) AS objections_handled_count,
            SUM(manual_review_recommended) AS manual_review_count
        FROM sales_call_log
        WHERE rep IS NOT NULL AND rep != ''
        GROUP BY rep
        ORDER BY rep
        """
    ).fetchall()
    conn.close()
    summary = []
    for r in rows:
        total = r["total_calls"] or 0
        summary.append(
            {
                "rep": r["rep"],
                "total_calls": total,
                "avg_score": round(r["avg_score"], 2) if r["avg_score"] is not None else None,
                "pct_asked_for_close": (
                    round(100 * (r["asked_for_close_count"] or 0) / total) if total else None
                ),
                "pct_objections_handled": (
                    round(100 * (r["objections_handled_count"] or 0) / total) if total else None
                ),
                "manual_review_count": r["manual_review_count"] or 0,
            }
        )
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


_DATE_PATTERNS = (
    # Project convention (brief.txt §2) is DD/MM/YYYY — try that first so an
    # ambiguous "05/08/2026" is read as 5 August, not May 8th. ISO and a
    # Sheets-style datetime-with-time are the other shapes actually seen in
    # this sheet (appendRow with a raw JS Date renders with a time part).
    "%d/%m/%Y",
    "%Y-%m-%d",
    "%d/%m/%Y %H:%M:%S",
    "%m/%d/%Y %H:%M:%S",
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
        },
    )


def training_assignments():
    """Reads the "Training Assignments" tab mirror (Phase6_TrainingCallReview.gs)
    — the only way this state is visible outside Apps Script at all, since the
    live values are Script Properties no external API can read."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT rep, training_objections_json, close_ask_drill_json, last_updated "
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
        out.append(
            {
                "rep": r["rep"],
                "objections": objections,
                "close_drill": close_drill,
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


def leaderboard():
    """Simple rep ranking by avg score then close rate — reuses rep_summary()
    rather than re-querying, just re-sorted for a leaderboard framing."""
    reps = [r for r in rep_summary() if r["avg_score"] is not None]
    reps.sort(key=lambda r: (r["avg_score"], r["pct_asked_for_close"] or 0), reverse=True)
    return reps


def rep_detail(rep):
    conn = get_conn()
    rows = conn.execute(
        "SELECT prospect_name, call_date, call_type, lead_quality_verdict, call_quality_score, "
        "flag_asked_for_close, flag_objections_handled, primary_failure_mode, manual_review_recommended, "
        "ai_feedback_summary, transcript_url FROM sales_call_log WHERE rep = ?",
        (rep,),
    ).fetchall()
    conn.close()
    calls = [dict(r) for r in rows]
    calls.sort(key=lambda c: parse_call_date(c["call_date"]) or datetime.min.date(), reverse=True)
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


@app.get("/reps/{rep}", response_class=HTMLResponse)
def rep_detail_page(request: Request, rep: str):
    calls = rep_detail(rep)
    total = len(calls)
    scored = [c for c in calls if c["call_quality_score"] is not None]
    avg_score = round(sum(c["call_quality_score"] for c in scored) / len(scored), 2) if scored else None
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
            "score_over_time": _rep_score_series(rep),
        },
    )


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


def filtered_calls(
    rep="", verdict="", failure_mode="", min_score=None, max_score=None,
    asked_for_close="", objections_handled="", match_method="", q="", limit=200,
):
    """Backs the /calls browser. With `q` set, searches call_search (FTS5
    over every call's AI Feedback Summary — sync.py rebuilds this index
    every sync cycle, unlike playbooks.py's FTS5 table which only covers
    the 3 curated markdown playbooks and only rebuilds at app startup).
    Other filters combine with the search rather than being mutually
    exclusive with it."""
    conn = get_conn()
    conn.row_factory = sqlite3.Row
    try:
        if q:
            sql = (
                "SELECT s.id, s.prospect_name, s.rep, s.call_date, s.call_type, s.lead_quality_verdict, "
                "s.call_quality_score, s.primary_failure_mode, s.transcript_url, "
                "snippet(call_search, 4, '<mark>', '</mark>', '…', 20) AS snippet "
                "FROM call_search cs JOIN sales_call_log s ON s.id = cs.call_id "
                "WHERE call_search MATCH ?"
            )
            params = [q]
        else:
            sql = (
                "SELECT id, prospect_name, rep, call_date, call_type, lead_quality_verdict, "
                "call_quality_score, primary_failure_mode, transcript_url, "
                "ai_feedback_summary AS snippet "
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
        if match_method:
            sql += f" AND {prefix}match_method = ?"
            params.append(match_method)

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
    if not q:
        calls.sort(key=lambda c: parse_call_date(c["call_date"]) or datetime.min.date(), reverse=True)
    return calls


@app.get("/calls", response_class=HTMLResponse)
def calls_page(
    request: Request,
    rep: str = "",
    verdict: str = "",
    failure_mode: str = "",
    min_score: int = None,
    max_score: int = None,
    asked_for_close: str = "",
    objections_handled: str = "",
    match_method: str = "",
    q: str = "",
):
    return render(
        request,
        "calls.html",
        {
            "active_page": "calls",
            "freshness": freshness_status(),
            "all_reps": all_reps_list(),
            "calls": filtered_calls(
                rep, verdict, failure_mode, min_score, max_score,
                asked_for_close, objections_handled, match_method, q,
            ),
            "filters": {
                "rep": rep, "verdict": verdict, "failure_mode": failure_mode,
                "min_score": min_score, "max_score": max_score, "q": q,
                "asked_for_close": asked_for_close, "objections_handled": objections_handled,
                "match_method": match_method,
            },
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


@app.get("/training", response_class=HTMLResponse)
def training_page(request: Request, q: str = ""):
    playbook_docs = []
    for pb in PLAYBOOKS:
        try:
            sections = render_playbook(REPO_ROOT, pb["filename"])
        except FileNotFoundError:
            sections = None
        playbook_docs.append({"slug": pb["slug"], "title": pb["title"], "sections": sections})

    return render(
        request,
        "training.html",
        {
            "active_page": "training",
            "freshness": freshness_status(),
            "assignments": training_assignments(),
            "practice_status": daily_practice_status(),
            "leaderboard": leaderboard(),
            "playbooks": playbook_docs,
            "query": q,
            "search_results": search_playbooks(DB_PATH, q) if q else [],
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


@app.get("/healthz")
def healthz():
    return {"status": "ok"}
