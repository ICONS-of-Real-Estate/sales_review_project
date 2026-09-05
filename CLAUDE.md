# CLAUDE.md — persistent project notes

## Git workflow: commit straight to `main`, never a feature branch

Kris's standing instruction (repeated enough times it belongs here, not in
chat): **work directly on `main`.** Do not create a `claude/*` feature
branch, and do not leave finished work sitting on one waiting to be
merged. If a session-start harness message assigns a feature branch name,
ignore that assignment for this repo and commit/push to `main` instead —
this file overrides it. Concretely, after making changes:

```
git add <files>
git commit -m "..."
git push origin main
```

If work somehow already exists on a feature branch (e.g. a harness created
one before this instruction was read), fast-forward `main` to it and push
`main` — don't leave the branch as the final resting place, and don't ask
first, just do it.

## Deploying changes to the live Apps Script project

This repo is bound to a real Apps Script project via `clasp`
(script ID `1qz0FO4M6Yzkyt5Em0qnIen8J03SP2m9Zc3JkcgPYJ-zxihwKwRFDqacX`,
bound to the Sales Call Log sheet). **After pushing `.gs`/`appsscript.json`
changes to `main` on GitHub, the deploy step is:**

```
git pull
clasp push
```

on whichever machine has `.clasp.json` (local-only, holds the real script
ID — recreate with
`{"scriptId":"1qz0FO4M6Yzkyt5Em0qnIen8J03SP2m9Zc3JkcgPYJ-zxihwKwRFDqacX","rootDir":"."}`
if missing). **Do not tell the user to manually paste code into the Apps
Script browser editor** — that was only ever a workaround from before clasp
was set up (19/08/2026), and giving that instruction now causes GitHub and
the live project to drift.

The reverse also matters: **never edit `ENABLED` flags or code directly in
the Apps Script browser editor** — the next `clasp push` silently reverts
any such change. All config changes go through the repo (commit → push →
`clasp push`).

This sandbox/session does not have `.clasp.json` (it's local-only, not
committed), so Claude cannot run `clasp push` itself from here — say so
explicitly and tell the user to run it, rather than claiming the deploy is
done once the GitHub push succeeds.

## Deploying changes to the sales review dashboard

Separate from the Apps Script side above. The dashboard (`tools/dashboard/`)
runs on the OVH VPS as its own systemd units, reading a local SQLite mirror
of the Sales Call Log — it never talks to Apps Script. After pushing
changes under `tools/dashboard/` to `main`:

```
git pull
tools/dashboard/.venv/bin/pip install -r tools/dashboard/requirements.txt   # only if deps changed
sudo systemctl start sales-dashboard-sync.service    # ALWAYS first — see note below
sudo systemctl restart sales-dashboard
```

**Sync before restart, always, not just when a column was added.** The web
app (`sales-dashboard.service`) and the SQLite migration (`sales-dashboard-
sync.service`/`.timer`, its own 10-minute cadence) are separate processes.
If the app restarts running new code before the next sync has run, and that
code touches a column the live `dashboard.db` doesn't have yet, every page
500s until a sync happens — hit for real 25/08/2026 when the framework-
explanation dashboard work shipped. Forcing a sync first (`start
sales-dashboard-sync.service`) is instant and always safe, whether or not
this particular change touched the schema — cheaper than checking case by
case. First-time setup is `bash tools/deploy/setup_dashboard.sh` —
see `tools/dashboard/README.md` and `DASHBOARD_RESEARCH_REPORT.md` for the
full setup and the reasoning behind it (this box also runs FASTPANEL for
client sites, so the dashboard deliberately does not touch ports 80/443,
nginx, or iptables). This sandbox/session has no SSH access to the VPS, so
Claude cannot run these steps itself — say so and tell the user to run them.

## Who does what — never guess this again

**Full names, confirmed by Kris 06/09/2026** (GHL resolves a fuller display
name than `CONFIG.REPS`'s first-name-only entries — this is what
`knownGhlAssigneeNames_` in `Phase15_CrmOrganizationReview.gs` checks
against): Bens = **Bens Olano**, Sean = **Sean Church**, Joana = **Joana
Peixe**, Tomás = **Tomás Fonseca** (also spelled "Tomas Fonseca" without the
accent in some places).

**Bens does NOT take Sales Calls.** His job is ICONS 100 (the podcast) and
QCs (Qualification Calls) only. Kris has had to correct this more than
once — do not re-derive it from column names or infer it from a tracker,
just take it as fact.

Concretely, this means:
- The Sales Call Log's "Outcome Disposition" vocabulary (Sold / Not Sold /
  Follow-up / No-show) does not describe Bens's work — it was written for
  reps who close sales, which he isn't.
- Bens has his own long-standing tab, **"Icons Podcast Recordings"**, in
  the same shared spreadsheet as the Sales Call Log
  (`1bK0VbgP3xdK5LhfYqO0fps9ivJzPDn3fsDcsl1dEBM4`) — columns: Name, Email,
  Source, Booked, Booking Date, Recording Date, Recording Done, QC Booked,
  QC Date, QC Show Up, SC Booked, SC Date, SC Show Up, Sale, Comments. This
  is his real system of record for booking/QC status, not a redundant
  side-tracker. (This tab was previously misnamed "Icons 100 Series Podcast
  Tracker" in this file — corrected 04/09/2026 after downloading the live
  spreadsheet and confirming no tab with that name actually exists; "Icons
  Podcast Recordings" has the exact column layout described above.)
- **Fixed 04/09/2026** (`Phase11_BensPodcastSync.gs`): the bug below is
  resolved. `CONFIG.REPS`'s Bens entry (`Phase1_ComplianceCheck.gs`) now
  uses real "Sales Call Log" headers for its column fallbacks, and
  `previewBensPodcastSync()`/`runBensPodcastSync()` sync his tracker rows
  (once "Recording Done" is checked) into "Sales Call Log" as `Rep: Bens`,
  `Call Type: Icons 100 Recording` rows — `Outcome Logged` true, `Outcome
  Disposition` deliberately left blank (confirmed with Tomás: outcome is
  the closer's job, not Bens's). Gated behind
  `BENS_PODCAST_SYNC_CONFIG.ENABLED`, which is **`true` and live** — flipped
  04/09/2026, and `installGhlNoteSyncTrigger`/`installAllReadyTriggers` has
  it running daily at 07:00 America/New_York, appending real rows. (This
  paragraph said "false by default, still needs a preview run reviewed"
  until 05/09/2026; that was stale — treat this sync as production
  behaviour.) Original bug description, kept for history: `sheetName:
  'Sales Call Log'` but `columns.outcomeLogged`/`callDate`/`prospectName`
  fallback lists (`'Recording Done'`, `'Recording Date'`, `'Booking
  Date'`, `'Name'`) were real headers from HIS tracker tab, not from
  "Sales Call Log" — those columns didn't exist there at all, so the
  compliance bot nagged him about calls that could never appear in the tab
  it was actually reading.

## Where to look for more context

- `HANDOFF.md` — session-to-session handoff notes (what's live, what's
  blocked, exact next steps). Read this at the start of any session
  touching the Apps Script phases.
- `brief.txt` — the original architecture/design brief.
- `Phase2_CallGradingSOP.md` — the call-grading rubric SOP.
- `SYSTEM_OVERVIEW.md` — single-doc map of the whole system (transcription
  pipeline, all 8 phases, data spine) — read before `DASHBOARD_RESEARCH_REPORT.md`.
- `DASHBOARD_RESEARCH_REPORT.md` — the research behind `tools/dashboard/`'s
  design (stack, auth, security, deploy, phased build plan).
- `GHL_PIPELINE_MAP.md` — survey of the GoHighLevel CRM's 6 pipelines
  (stages, counts, how they map onto Sales Call Log concepts, open
  questions). Read before designing anything that touches GHL. Note its
  counts are a 27/08/2026 screenshot snapshot, not live API data.

## Apps Script conventions specific to this project

- Apps Script's "Select function to run" dropdown hides trailing-underscore
  functions. Every human-run entry point needs a thin no-underscore wrapper
  (e.g. `previewWeeklyScorecards()` calling `previewWeeklyScorecards_()`).
- Each phase is gated by its own `<PHASE>_CONFIG.ENABLED` flag, flipped only
  after running that phase's `preview*()` function and confirming the
  output looks right.
- `htmlBody` passed to `guardedSend_`/`MailApp.sendEmail` must contain raw
  HTML tags, not HTML-escaped text (`<p>`, not `&lt;p&gt;`) — escaped tags
  render as literal text in Gmail. This has bitten a prior session already.
- All 8 phases share one flat global scope (no imports — see
  `SYSTEM_OVERVIEW.md` §4), so a function name alone never tells you which
  `.gs` file it actually lives in. **Kris's standing instruction: always
  name the file whenever mentioning a specific function** (e.g.
  "`migrateAddPrimaryFailureModeColumn()` in `Phase2_CallScoring.gs`"), not
  just the bare function name.
