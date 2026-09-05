# Sales Review Dashboard

Read-only web dashboard over the "Sales Call Log" Google Sheet. Built per
`DASHBOARD_RESEARCH_REPORT.md` (repo root) — read that first for the
reasoning behind every choice below. This README covers the "Phase A"
build only: a local SQLite mirror of the Sheet, and a FastAPI app showing
per-rep score trends and pipeline health, with **no public exposure and no
login** — access is via Tailscale only, on purpose, so the data path gets
proven before any auth code is written (Phase B).

## What's here

- `sync.py` — pulls the `Sales Call Log`, `Training Assignments`,
  `CRM Organization Review`, and `Lead Reconciliation - All` tabs from the
  Sheet into `dashboard.db` (SQLite). Run on a timer; the mirror is fully
  disposable — delete `dashboard.db` and re-run to rebuild it.
- `sheets_write.py` — the one place this app writes anything back to the
  Sheet: Tomás's Approve/Reject (or "Real Lead"/"Not a real lead") clicks on
  `/review` (see below). Everything else stays read-only.
- `app.py` — the FastAPI app. Reads only from `dashboard.db` (never talks
  to Google directly) except `/review/decide`, which calls `sheets_write.py`.
- `/review` — one finding/lead at a time from `CRM Organization Review` /
  `Lead Reconciliation - All` (Phase15_CrmOrganizationReview.gs /
  Phase13_LeadReconciliation.gs), with big Approve/Reject buttons that write
  straight back to the Sheet — added 06/09/2026 so Tomás doesn't have to
  open the spreadsheet and hunt through hundreds of rows by hand.
- `templates/`, `static/` — Jinja2 templates and static assets for the app.
- `requirements.txt` — pinned Python deps.

## One-time setup

### 1. Create a read-only service account

In the Google Cloud project tied to this Workspace (the same one
`tools/credentials.json` for the transcription pipeline came from, or a
new one — see §7.2 of the research report for why "does the GCP project
belong to the Workspace org" matters before Phase B's OAuth step, though
it doesn't block this read-only step):

1. GCP Console → IAM & Admin → Service Accounts → Create.
2. Enable the **Google Sheets API** for the project if not already on.
3. Create a JSON key for the new service account, download it, and save
   it as `tools/dashboard/service_account.json` on the VPS (not in git —
   see `.gitignore`).
4. Open the Sales Call Log spreadsheet
   (`1bK0VbgP3xdK5LhfYqO0fps9ivJzPDn3fsDcsl1dEBM4`) → Share → paste the
   service account's `...@....iam.gserviceaccount.com` email → **Editor**
   (not just Viewer — `/review`'s Approve/Reject buttons write two
   checkbox columns back to the Sheet via `sheets_write.py`, using this
   same service account/key with a wider `spreadsheets` scope; Viewer-only
   access makes every one of those writes fail with a 403, visible in the
   dashboard as "Could not save that decision to the spreadsheet"). If this
   account was already shared as Viewer-only before 06/09/2026, re-share it
   and pick Editor to upgrade the existing permission — no need to remove
   and re-add it.

This is deliberately a service account, not the transcription pipeline's
`token.json` user-OAuth pattern — see the research report §3.1/§0.4 for
why a user refresh token doesn't belong in this new piece.

### 2. Add the "Training Assignments" mirror to the live sheet

`Phase6_TrainingCallReview.gs` now writes each rep's current practice-drill
assignment into a `Training Assignments` tab (added 22/08/2026, so the
dashboard isn't structurally blind to Script-Properties-only state — see
`SYSTEM_OVERVIEW.md` / the research report §0.3). This tab gets created
automatically the next time Phase 6 processes a training call. If you want
it to exist immediately rather than waiting for the next training call,
run `buildAndMaybeSendTrainingReviews_(true)` (preview mode) from the Apps
Script editor once, per the project's usual rollout discipline.

### 3. Get on the same Tailscale network as the VPS

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4   # note this box's tailnet IP
```

Every team member who should see the dashboard also installs Tailscale on
whatever device they'll check it from, and gets added to the same tailnet
(Tailscale admin console → invite). Confirm the free-tier user cap covers
your team size before relying on it (the research report flags this
specific number as worth re-checking against Tailscale's current pricing
page).

### 4. Run the setup script

```bash
cd /path/to/sales_review_project
bash tools/deploy/setup_dashboard.sh
```

Then edit `/etc/sales-dashboard/env` and set `DASHBOARD_BIND_HOST` to the
Tailscale IP from step 3, and restart:

```bash
sudo systemctl restart sales-dashboard
```

### 5. Check it

```bash
sudo systemctl status sales-dashboard sales-dashboard-sync.timer
journalctl -u sales-dashboard-sync.service -f
```

Then, from any device on the tailnet: `http://<tailscale-ip>:8000/`.

**Live URL (this VPS)**: https://vps-b3e68291.tail9f0adb.ts.net/ — the
Tailscale MagicDNS HTTPS name, not the raw IP:8000 above. Still tailnet-only
(no public exposure) — you need to be on the same tailnet to reach it.

## Redeploying after a code change

```bash
cd /path/to/sales_review_project && git pull
tools/dashboard/.venv/bin/pip install -r tools/dashboard/requirements.txt   # only if deps changed
sudo systemctl restart sales-dashboard
```

## Running tests

Every route and every business-logic function (`rep_summary`,
`score_over_time`, `filtered_calls`, the FTS search, the review queue and
calibration math, etc.) has a test against a throwaway per-test SQLite
file — no real `dashboard.db`, no network, no Google credentials needed.

```bash
cd tools/dashboard
pip install -r requirements-dev.txt   # adds pytest on top of requirements.txt
pytest tests/ -v
```

Nothing here talks to the live Sales Call Log sheet — `sync.py`'s own
`init_schema()`/`rebuild_call_search_index()` build a fresh schema per test,
seeded with fixture rows (`tests/conftest.py`), so this is safe to run
anywhere, anytime, including on the VPS against a copy of `dashboard.db`
without touching the real file.

## Phase B (public access + Google login) — required env vars

`auth.py`/`app.py` implement the plan from the research report §6/§3.3: an
OAuth consent screen set to **Internal**, `hd`-claim verification plus an
email allowlist, session cookies signed with a server-side secret. Three
env vars gate this — **all three must be set explicitly once Phase B is
live** (i.e. once `DASHBOARD_REQUIRE_LOGIN` is not `"false"`, which is the
default):

- `DASHBOARD_SESSION_SECRET` — signs the session cookie. Generate one with
  `python3 -c "import secrets; print(secrets.token_hex(32))"` and put it in
  `/etc/sales-dashboard/env` (0600, root-owned — see
  `tools/deploy/setup_dashboard.sh`). **There is no working default** —
  `app.py` refuses to start without this set unless `DASHBOARD_REQUIRE_LOGIN`
  is explicitly `"false"` (local dev only), specifically so a fresh
  deployment can't accidentally go live signed with the fallback dev
  secret checked into this repo.
- `DASHBOARD_ALLOWED_EMAILS` — comma-separated list of the exact Google
  account emails allowed to log in (e.g.
  `kris@iconsofrealestate.com,tomas@iconsofrealestate.com`). **An empty or
  unset allowlist denies everyone**, not everyone-in-the-domain — the
  Workspace `hd` check alone is not the access control.
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` — from the GCP
  OAuth consent screen (set to **Internal**) and its Web application OAuth
  client. `GOOGLE_OAUTH_REDIRECT_URI` should also be set explicitly (the
  app sits behind Tailscale/a reverse proxy, so scheme auto-detection from
  the raw request isn't reliable).

Still needs FASTPANEL's own nginx + Let's Encrypt fronting on a subdomain,
with the app rebound to `127.0.0.1` — see the research report's §7
questions (domain in FASTPANEL, which GCP project) for that piece.
