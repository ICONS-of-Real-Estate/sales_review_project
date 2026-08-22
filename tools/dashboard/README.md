# Sales Review Dashboard

Read-only web dashboard over the "Sales Call Log" Google Sheet. Built per
`DASHBOARD_RESEARCH_REPORT.md` (repo root) — read that first for the
reasoning behind every choice below. This README covers the "Phase A"
build only: a local SQLite mirror of the Sheet, and a FastAPI app showing
per-rep score trends and pipeline health, with **no public exposure and no
login** — access is via Tailscale only, on purpose, so the data path gets
proven before any auth code is written (Phase B).

## What's here

- `sync.py` — pulls the `Sales Call Log` and `Training Assignments` tabs
  from the Sheet into `dashboard.db` (SQLite). Run on a timer; the mirror
  is fully disposable — delete `dashboard.db` and re-run to rebuild it.
- `app.py` — the FastAPI app. Reads only from `dashboard.db`, never talks
  to Google directly.
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
   service account's `...@....iam.gserviceaccount.com` email → **Viewer**.

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

## Redeploying after a code change

```bash
cd /path/to/sales_review_project && git pull
tools/dashboard/.venv/bin/pip install -r tools/dashboard/requirements.txt   # only if deps changed
sudo systemctl restart sales-dashboard
```

## Moving to Phase B (public access + Google login)

Not built yet — see the research report §6 (Phase B) and §3.3 for the
plan: an OAuth consent screen set to **Internal**, `hd`-claim verification
plus an email allowlist, fronted by FASTPANEL's own nginx + Let's Encrypt
on a subdomain, with the app rebound to `127.0.0.1`. Needs answers to the
research report's §7 questions (domain in FASTPANEL, which GCP project)
before it can start.
