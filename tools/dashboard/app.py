#!/usr/bin/env python3
"""
Sales Review Dashboard — Phase A (per DASHBOARD_RESEARCH_REPORT.md §6).

Read-only team overview: total scored calls, per-rep averages/flags, and
the primary-failure-mode breakdown, read from the local SQLite mirror
sync.py maintains. No charts yet, no auth yet — this phase deliberately
ships behind Tailscale-only access so the data path can be proven before
either of those is built (Phase B).

Run with: uvicorn app:app --host <bind-host> --port 8000
(tools/deploy/setup_dashboard.sh installs this as sales-dashboard.service.)
"""
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = os.environ.get("DASHBOARD_DB_PATH", str(BASE_DIR / "dashboard.db"))
FRESHNESS_WARN_MINUTES = int(os.environ.get("DASHBOARD_FRESHNESS_WARN_MINUTES", "15"))
FRESHNESS_STALE_MINUTES = int(os.environ.get("DASHBOARD_FRESHNESS_STALE_MINUTES", "60"))

app = FastAPI(title="Sales Review Dashboard")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

static_dir = BASE_DIR / "static"
static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


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
    return templates.TemplateResponse(
        request,
        "overview.html",
        {
            "freshness": freshness_status(),
            "total_calls": total_calls,
            "reps": rep_summary(),
            "failure_modes": failure_mode_breakdown(),
            "pipeline": pipeline_health(),
        },
    )


@app.get("/healthz")
def healthz():
    return {"status": "ok"}
