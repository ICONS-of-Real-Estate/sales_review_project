# Handoff — 23/08/2026 (session 6 — CRITICAL: legacy backfill duplicate-row bug + Joana fix)

## 0. What happened this session (read this first)

**Real, severe bug found live and fixed — verify the fix actually stopped it
before trusting Bens' numbers for anything.** Pulled the actual Sales Call
Log directly (not just the Executions log summary) and confirmed:

- **Bens: 316 rows for what should be 14 distinct transcripts.** One
  prospect/date pair was duplicated up to 35 times. Root cause:
  `installLegacyBackfillTrigger()` not deduping its own trigger (found
  earlier this session, already fixed) meant multiple copies of the
  10-minute trigger could exist; `runAllLegacyBackfills_`'s own mutex was a
  plain `getProperty`/`setProperty` check, not atomic, so several
  overlapping firings could each see the gate as free before any of them
  set it, then each proceeded with its own stale "what's already scored"
  snapshot. Bens' legacy scorer has no lock of its own (Sean/Joana's own
  functions do, via their own internal `LockService` calls — that's why
  only Bens took the hit).
- **Joana: zero rows, still.** `scoreJoanaTranscripts()` is only ever
  reachable through `runAllLegacyBackfills_`, which ran Bens FIRST — and
  Bens' real backlog alone (14 files × ~2-4 min via Kimi) already exceeds
  the 30-minute execution cap on a clean pass, so the function almost
  certainly timed out inside Bens' loop every single firing and never
  reached Joana at all.

**Fixed this session** (commit after this note):
1. `runAllLegacyBackfills_`'s mutex is now atomic — a brief real
   `LockService` hold around just the check-and-set, released before any
   actual scoring runs (so it never nests with Joana/Sean's own internal
   locks).
2. Reordered to Joana → Sean → Bens so Bens can't starve the others.
3. **Joana now has her own dedicated 4-hour trigger**
   (`installJoanaScoringAutomation()`, wired into `installAllReadyTriggers_`)
   — same pattern as Sean/Tomás, no longer solely dependent on the fragile
   temporary backfill chain. **Needs to actually be run once** (or just
   re-run `installAllReadyTriggers_()`).
4. Fixed a real missing-line bug: `scoreLegacyTranscriptFolder` (Bens' path)
   never updated its in-memory dedup set after appending a row — Joana's
   separate copy of this loop already did. Closed for consistency/defense
   in depth, though the dominant cause of the duplication was #1 above, not
   this.
5. **New cleanup functions, not yet run**: `previewLegacyBackfillDuplicates()`
   then `dedupeLegacyBackfillDuplicates()` — finds every duplicate
   (rep, prospect, date) group among `fallback_heuristic` rows and deletes
   all but one (preferring a row with a real Kris verdict if any duplicate
   in the group has one, else the lowest row number). **Run the preview
   first and sanity-check the count (~302 expected) before running the live
   version** — this permanently deletes rows.

**Not done / needs Kris**:
- Deploy: `git pull` + `clasp push`, then re-run `installAllReadyTriggers_()`
  to pick up Joana's new dedicated trigger.
- Run `previewLegacyBackfillDuplicates()` → `dedupeLegacyBackfillDuplicates()`
  to clean up the ~302 duplicate Bens rows already written — until this
  runs, every downstream number for Bens (dashboard averages, weekly
  scorecard, review queue) is skewed by the duplication.
- Check whether `installLegacyBackfillTrigger()` still has duplicate copies
  stacked live (Triggers page, clock icon) — the dedupe fix from earlier
  this session only prevents new stacking, doesn't clean up what's already
  there.
- **Separately, Sean's Daily Practice folder**
  (`1SJJ5Jek_4vEzmS907NQofDYq6bl-Mnr1`) has two practice uploads (260820,
  260821) sitting ungraded — `tools/transcribe_daily_practice.py` has never
  been run for them (it's not part of the automated OVH `transcribe-all.timer`
  job, still fully manual), so no `"— Transcript"` Doc exists yet for Phase
  7's grading scan to find. Needs someone to run that script by hand (needs
  `GEMINI_API_KEY` + Drive credentials) — worth also considering wiring it
  into the OVH automation so this doesn't keep silently stalling.

---

# Handoff — 23/08/2026 (session 5 — acting on the QA/coaching research report)

## 0. What happened this session (read this first)

Worked through `QA_COACHING_RESEARCH_REPORT.md`'s "five things" list end to
end. All code-only, no deploy access from this session (see deploy notes at
the top of this file) — **everything below still needs `git pull` + `clasp
push`** for the `.gs` changes, no dashboard deploy needed (no
`tools/dashboard/` files touched this session). Commits, in order:

- **`a86d524`** — new Phase 2 feature: a weekly random calibration holdout
  (3-5 calls, blind of the AI's own flag/score, feeding the existing "Kris
  Manual Review Verdict" column) so `runWeeklyCalibration()` can finally see
  false negatives, not just calls the model already flagged as hard. Ships
  **disabled** (`RANDOM_CALIBRATION_CONFIG.ENABLED = false`) — run
  `previewRandomCalibrationSample()` first, confirm it looks right, then
  flip `ENABLED` and run `installRandomCalibrationSampleTrigger()` (or
  re-run `installAllReadyTriggers_()`). Also added Phase 5's rolling
  4-week average (with its own n) alongside the single-week number.
- **`dbb1056`** — dashboard leaderboard (`/training`) converted from a
  cross-rep ranking to self-comparison: each rep's own recent-10-calls
  average vs. their own prior average, sorted alphabetically, not by score.
  At 3-4 reps a ranked leaderboard structurally punishes whoever's last,
  every week, forever.
- **`58c202f`** — rewrote every rep-facing feedback surface (Phase 5 weekly
  scorecard, Phase 7 daily practice drill feedback) to lead with a quoted
  transcript moment and one behavior to change, with score/averages moved
  into a "For the record" section below the fold. **Also changed every
  judge prompt's `feedback_summary` field spec** (shared rubric, Sean's,
  Tomás's, daily-practice) to require quoting the rep's own words and
  naming exactly one behavior — this is a live prompt-wording change
  affecting every phase that scores real calls. **Worth spot-checking a
  few real `feedback_summary` outputs against real transcripts** before
  fully trusting it, same as any other rubric change here.
- **`6f81eed`** — weekly scorecard now also nudges each rep, once a week,
  about scored calls still missing an Outcome Disposition
  (Sold/Not Sold/Follow-up/No-show) — that column has existed since Phase 0
  but nothing has ever prompted anyone to actually fill it in, so in
  practice it's sat empty. Confirmed the "rep's tracker" comments on that
  column refer to this SAME Sales Call Log sheet, not a separate one.

**One thing flagged earlier, now resolved with real evidence**: the report's
§4 claim that "the old 30-minute Workspace execution tier was retired,
6-minute cap now applies to everyone" directly contradicted the 30-minute
mutex window `runAllLegacyBackfills_`'s overlap fix relies on. Couldn't
verify from web sources (egress-blocked from Google's own docs). **Settled
later the same session by real evidence**: Kris pasted the actual Executions
log — a real `runAllLegacyBackfills_` firing on 23/08 shows `Duration
1800.478s`, `STATUS: Timed out`. That's exactly 30 minutes, not 6 —
confirms this Workspace account really does get 30-minute executions. The
report's claim was wrong for this account; the existing 30-minute mutex
window is correct, left as-is.

**Real bug found from that same Executions log**: the firing cadence around
it was wildly irregular (~2-4 min gaps instead of a clean 10-minute
spacing) — `installLegacyBackfillTrigger()` was the only `install*Trigger`
function in this codebase that didn't delete its own existing trigger
before creating a new one, so a second accidental run of it stacks a
second independent 10-minute trigger at a different offset instead of
replacing the first. Fixed to dedupe like every other install function
here. **If this has been run more than once, check the Triggers page
(clock icon, left sidebar) for multiple `runAllLegacyBackfills_` entries
and delete the extras by hand** — the code fix only prevents this going
forward, it doesn't clean up triggers already stacked live. The mutex
itself prevented any actual double-scoring, so this was wasteful, not
damaging.

**Also from that Executions log**: no visible `scored X, already-present Y`
tally for any of Bens/Joana/Sean in the summary table — that requires
opening one of the fast "Completed" executions and reading its actual
Logger output, not just the table. Still need that to know whether the
backfill has actually finished. Joana's transcript folder ID is confirmed
correctly wired end-to-end — `PHASE2_CONFIG.JOANA_FOLDERS` (Phase 2) and
`transcribe_joana_calls.py`'s `JOANA_FOLDERS` both point at the same real
Drive folder (`17YaE4fBjEBFissvR-l7_GOkoTnZjdQq5`), no config drift — so if
Joana's calls still aren't showing up scored, the more likely culprits are
(a) her raw videos genuinely not transcribed yet by the OVH pipeline (a
separate step from anything in this Executions log), or (b) something
inside `scoreJoanaTranscripts()`'s own run — worth opening a
`runAllLegacyBackfills_` execution's log directly to see which.

**Not done / follow-ups**:
- Dashboard has synced `outcome_disposition` into SQLite since `sync.py`
  was written, but nothing in `app.py`/templates surfaces it yet — worth
  wiring up once real disposition data starts landing (closes the
  score-vs-outcome loop the report flags as the real missing piece).
- Report's other recommendations (analytic sub-scores instead of one 1-5,
  a frozen regression set for drift detection, `rubric_version` column,
  build-vs-buy analysis) not started this session — see the report itself
  for the full ranked list.
- All new logic covered by `tests/run_tests.js` (28 tests, up from 18 at
  the start of this session) and `tools/dashboard/tests/` (78 tests,
  unchanged — no dashboard code touched). Run `node tests/run_tests.js`
  before trusting any further `.gs` change in this area.

---

# Handoff — 22/08/2026 (session 4 — dashboard deployment)

## 0. What happened this session (read this first)

Deployed the sales review dashboard (Phase A) to the live OVH VPS, with a
security pass along the way:

- **Server hardening.** Created a non-root sudo user `kris`; SSH still
  works with both key and password for `kris`. The whole repo was moved
  from `/root/sales_review_project` to `/home/kris/sales_review_project`
  (it can't stay under `/root` — `/root` itself is `700`, so `kris` can
  never traverse into it, no matter what a subdirectory is chowned to).
  `transcribe-all.service`/`.timer` were rebuilt against the new path via
  `tools/deploy/setup_ovh.sh`, now running as `kris` instead of root.
- **Dashboard deployed and running.** GCP project `sales-review-dashboard-506303`
  created under the `iconsofrealestate.com` Workspace org (needed later for
  Phase B's OAuth "Internal" consent screen). A service account
  (`sales-dashboard-reader@sales-review-dashboard-506303.iam.gserviceaccount.com`)
  was created and shared as Viewer on the Sales Call Log — **but `sync.py`
  on the live box was changed to use the transcription pipeline's OAuth
  `token.json`/`credentials.json` pattern instead**, and hasn't been
  switched to the service account yet. Do that switch next session — it's
  the more robust option per `DASHBOARD_RESEARCH_REPORT.md` §3.1 (a user
  token can get revoked/expire and needs a browser on an authorized
  machine to fix; the service account key already exists and is sitting
  unused).
- **`sales-dashboard.service` is live** (`active (running)`), synced 1,159
  real rows from the Sales Call Log. Currently bound to `127.0.0.1:8000`
  (the env-file placeholder), so **it's only reachable from the box itself
  right now** — Tailscale hasn't been set up yet. Next session: install
  Tailscale, get the team on the same tailnet, set `DASHBOARD_BIND_HOST`
  in `/etc/sales-dashboard/env` to the box's tailnet IP, restart.
- **Real bug found and fixed: `ProtectHome=yes` breaks this service under
  systemd.** Confirmed by hand-testing directive-by-directive on the live
  box: `ProtectHome=yes`, even paired with a matching `ReadWritePaths=`
  override for the app's own directory, reliably causes
  `code=exited, status=203/EXEC` — systemd can't execute anything in the
  app's venv at all. `ProtectSystem=strict` + `ReadWritePaths` alone work
  fine. Fixed in `tools/deploy/setup_dashboard.sh` (comment there explains
  why) and manually removed from the live unit file already — don't
  re-add `ProtectHome=yes` if touching this service again.
- Also hit and fixed along the way: the dashboard's own venv
  (`tools/dashboard/.venv`) had been created by copying/cloning the
  transcription pipeline's venv rather than fresh, so its scripts'
  shebang lines pointed at the wrong venv's Python — rebuilt clean with
  `python3 -m venv`.

Not done yet: switch `sync.py` back to the service account, Tailscale
setup, Phase B (charts, Google OAuth, public access) — see
`DASHBOARD_RESEARCH_REPORT.md` §6/§7.

## 0b. Later the same session — dashboard fully fleshed out

Everything above got resolved, and a lot more got built. Current state:

- **`sync.py` switched to the service account** — someone (commits `6f46ad7`/
  `8d7e3d0`, authored "Admin" directly from the VPS) patched it to prefer
  `service_account.json` when present, falling back to `token.json`
  otherwise. The real key was placed at
  `tools/dashboard/service_account.json` and confirmed working (a manual
  `sync.py` run synced 1,165 rows with no auth error).
- **Tailscale is live.** VPS tailnet IP is `100.95.253.100`. `kris`'s
  Windows machine is on the same tailnet. Dashboard is reachable at
  `http://100.95.253.100:8000/` — still HTTP, not HTTPS (matters for OAuth,
  below).
- **Charts** (`/charts`): score-over-time (day/week/month/year/all-time
  granularity selector, continuous buckets so gaps in the data show as
  real gaps instead of jamming distant weeks together), lead-quality
  doughnut, failure-mode bar chart — both click-through to a modal listing
  the actual calls behind that number. Chart.js vendored locally at
  `tools/dashboard/static/chart.umd.min.js` (fetched via `npm`, not a CDN —
  this session's proxy blocks `cdn.jsdelivr.net` directly, and a local copy
  is the right call anyway per the research report's CSP guidance).
- **Training** (`/training`): renders `Objection_Handling_Playbook.md`,
  `_Sean.md`, `Tomas_Playbook.md` as real formatted pages (not raw
  markdown) with FTS5 search (`playbooks.py`, indexed once at app
  startup since the source is repo files); shows each rep's current
  practice-drill assignment (the "Training Assignments" sheet tab added
  earlier this session); a leaderboard; and Phase 7's daily-practice
  compliance status (new `daily_practice_followups` table, synced from
  the "Daily Practice Follow-ups" tab — previously invisible outside
  Apps Script logs).
- **Review queue** (`/queue`): every flagged-but-unreviewed call sorted by
  severity/age, plus the calibration agreement % (SOP §7's 80% go-live
  gate) — a simplified read-only view of the same rows
  `buildReviewQueue()` clusters into an actual 3-a-day sitting.
- **Rep detail pages** (`/reps/{rep}`): full call history + individual
  score trend, linked from every rep name across the dashboard.
- **Calls browser** (`/calls`): filter by rep/verdict/failure-mode/score
  range, plus full-text search across every call's AI Feedback Summary
  via a second FTS5 index (`call_search` in `sync.py`, rebuilt every sync
  cycle — separate from `playbooks.py`'s FTS5 table, which only covers the
  3 curated markdown files and only rebuilds at app startup).
- **Trend alerts**: Overview shows a banner when a rep's most recent
  scored week drops sharply vs. the week before, or falls below a floor —
  deterministic, computed from the same `score_over_time()` data the chart
  uses.
- **Google OAuth is coded but NOT live** (`auth.py` + `RequireLoginMiddleware`
  in `app.py`). Blocked on two things Kris still needs to do:
  1. An HTTPS URL — Google requires HTTPS redirect URIs for anything but
     literal `localhost`. Plan is Tailscale's own HTTPS certs
     (`tailscale serve`), not the full FASTPANEL/domain route Phase B
     originally sketched, since Tailscale's is already half-set-up.
  2. A real OAuth Client ID/Secret from GCP Console (Internal consent
     screen, same `sales-review-dashboard-506303` project).
  Until both exist, **`/etc/sales-dashboard/env` must keep
  `DASHBOARD_REQUIRE_LOGIN=false`** or the dashboard locks everyone out
  with no way back in.
- **Real bug found and fixed live: overlapping trigger runs.** Workspace
  accounts get 30-minute Apps Script executions, not the 6-minute cap this
  was designed around — confirmed two firings of the temporary
  `runAllLegacyBackfills_` trigger running simultaneously, which could
  have double-scored a call (`scoreBensLegacyTranscripts()` has no lock of
  its own). Fixed with an explicit Script Properties mutex in
  `runAllLegacyBackfills_` itself (commit `e1ed6fb`) rather than nesting
  `LockService` calls. **Still need to check the Sales Call Log for actual
  duplicate rows** (same Prospect Name + Call Date, `Rep = Bens`) from the
  overlap window around 17:19–17:29 on 22/08 — nobody's confirmed this yet.
  Command to check (from `tools/dashboard/` on the VPS, after a fresh
  `sync.py` run): `sqlite3 dashboard.db "SELECT prospect_name, call_date,
  COUNT(*) AS n FROM sales_call_log WHERE rep='Bens' GROUP BY
  prospect_name, call_date HAVING COUNT(*) > 1;"`
- Also added this session: real scoring entry points for Joana
  (`scoreJoanaTranscripts()` — the old `scoreJoanaLegacyTranscripts()`
  assumed the wrong filename convention and silently scored nothing) and
  the temporary `runAllLegacyBackfills_` trigger to catch up Bens/Joana/
  Sean's backlogs (61/all/133 unscored respectively at the time) — check
  whether that trigger is still running or has been removed via
  `removeLegacyBackfillTrigger()` once all three report 0 newly scored.

Not done yet: finish OAuth (needs the two Kris-side steps above), the
duplicate-row check, and whatever's next after that — no fixed plan beyond
here, built reactively this session based on what Kris asked for live.

## 0c. Later still — OAuth went live, UI click-through everywhere, Bens got his own rubric

- **Google OAuth is now actually live**, not just coded. Tailscale HTTPS is
  up (`sudo tailscale serve --bg http://127.0.0.1:8000`, not the `tailscale
  serve https / http://...` syntax the docs imply — that's deprecated on
  current Tailscale). Public-ish URL is
  `https://vps-b3e68291.tail9f0adb.ts.net/`. A real GCP OAuth client exists
  under project `sales-review-dashboard-506303` (Internal consent screen),
  redirect URI `.../auth/callback`. `/etc/sales-dashboard/env` has
  `DASHBOARD_REQUIRE_LOGIN=true` and the 5-email allowlist. Hit and fixed
  two real bugs getting here:
  - `requirements.txt` was missing `httpx` — `authlib`'s Starlette
    integration imports it transitively, so the service crashed on start
    with `ModuleNotFoundError` the moment OAuth code actually got deployed
    (fixed, `204d3db`).
  - The very first env-var command used a quoted heredoc (`<<'EOF'`), which
    disables all shell substitution, so `DASHBOARD_SESSION_SECRET=$(openssl
    rand -hex 32)` got written as that literal string instead of a real
    secret — re-run with an unquoted heredoc to actually generate one if
    that hasn't been double-checked since.
- **Every stat tile and table cell is now clickable**, drilling into a
  filtered `/calls` or `/queue` view — Overview's 3 top tiles, the "By rep"
  table's every column, the failure-mode tables on both Overview and
  `/queue`, and the rep-detail page's stat tiles. `filtered_calls()` grew
  `asked_for_close`/`objections_handled`/`match_method` filters and
  `/queue` grew a `rep` filter to back all of this (commit `945e17e`).
- **Fixed a real readability bug**: table cells default to
  `vertical-align: middle`, so any row with a long AI Feedback Summary
  paragraph became enormous with the short cells floating in empty space —
  reported directly off the live `/reps` page. Fixed with a global
  `vertical-align: top` plus a 3-line-clamp class on every long-text cell
  (`04f20df`).
- **Bens got his own grading rubric** (`Phase2_CallGradingSOP.md` §3C,
  `Phase2_CallScoring.gs` commit `833c3b4`) — caught live because his
  "Asked for close" number looked implausibly high on the dashboard. He is
  not a closer: ICONS 100 lead-gen podcast interviews + QCs, booking a
  QC/Sales Call for someone else to run, never taking a sales call himself.
  New `scoreBensTranscript_`/`buildBensFeedbackSummary_`, wired in via
  optional `judgeFn`/`feedbackSummaryFn` params on
  `scoreLegacyTranscriptFolder()` rather than forking it. Reuses the shared
  schema's field *names* so the sheet/dashboard/Phase 5 scorecard keep
  working — only what `asked_for_close` *means* for him changed (booking a
  concrete next step, not asking for money).
  - **Open decision, not yet actioned**: the ~42 Bens rows already in the
    sheet were scored under the OLD wrong rubric and will NOT
    auto-correct (the existing-row skip is keyed on prospect name + date).
    Kris was asked whether to identify and delete those rows for a
    re-score, or leave the old numbers as historical — no answer yet as of
    this note.

## 0d. Same night, later — Bens re-score kicked off, daily-practice tracking bug, playbook TOC readability

- **Bens' old-rubric decision resolved: delete and re-score.** Added
  `deleteBensLegacyRows()` to `Phase2_CallScoring.gs` — deletes every
  Sales Call Log row where Rep=Bens and Match Method=fallback_heuristic
  (i.e. exactly his legacy-backfill rows, nothing else). Kris ran it, then
  `previewBensLegacyTranscripts()` confirmed all 57 correctly-named files
  now show `[new]`. **In progress as of this note**: `scoreBensLegacyTranscripts()`
  is re-scoring them under the corrected rubric, but each call is taking
  ~2-4 minutes (slower than expected, partly `429 engine_overloaded` from
  Moonshot/Kimi — the retry logic already handles a failed attempt) — far
  too slow to finish in one 30-minute execution. Kris installed
  `installLegacyBackfillTrigger()` (fires `runAllLegacyBackfills_` every 10
  minutes, self-deduping via `loadExistingLegacyKeys_`, protected by the
  existing 30-minute time-window mutex) to let it grind through unattended
  overnight. **Next session: check the Apps Script Executions log — once a
  firing reports Bens `scored 0, already-present 53` (57 minus the 4
  unparsed odd-filename ones), run `removeLegacyBackfillTrigger()`** so it
  doesn't fire forever. Also fixed a stale comment on
  `installLegacyBackfillTrigger()` that still cited the old (already
  corrected elsewhere) "6-minute execution cap" as the overlap-safety
  reason — the real protection is the mutex, not the trigger interval.
- **Fixed a real bug**: `sendDailyPracticeReminders_` searched Gmail for
  the just-sent thread immediately after sending it; if Gmail's search
  index hadn't caught up yet, the whole assignment silently dropped out of
  tracking — no row in "Daily Practice Follow-ups", nothing for `sync.py`
  to sync, which is exactly what Kris saw ("Sean has daily practice
  assigned" but the dashboard said "No daily practice assignments synced
  yet"). Now the row is always registered (with a blank threadId on a
  search miss, after a 3s delay to reduce misses), and
  `checkDailyPracticeCompliance_`/nagging fall back to a standalone email
  instead of crashing on `GmailApp.getThreadById('')`. Today's already-lost
  assignment isn't retroactively recoverable; tomorrow's should sync fine.
- **Fixed a readability bug**: the playbook page's "Contents:" line was one
  long `·`-joined run-on paragraph of anchor links. Now a wrapped pill list
  (`.toc` CSS in `base.html`).
- **Branch/workflow note**: this session's designated branch
  (`claude/repo-handoff-next-task-fzt3rq`) had apparently already been
  merged and deleted upstream before this session started, so `git
  checkout -B` + push recreated it fresh from `main`, then everything was
  fast-forward merged straight back into `main` (commit `6f2fe57`) — Kris's
  `clasp`/deploy machine tracks `main`, not feature branches, and hadn't
  seen the new commits with a plain `git pull` otherwise.
- **Still open / unconfirmed from earlier**: the Bens duplicate-row check
  from the overlapping-trigger bug (§0b) — still nobody has actually run
  that `sqlite3` query and reported back.
- Both `runAllLegacyBackfills_` (temporary trigger, §0b) and the OAuth
  setup above landed on the live systems via a mix of `clasp push` (Apps
  Script) and `git pull` + `pip install` + `systemctl restart` (dashboard)
  — check current systemd/trigger state before assuming either is still
  running the way this note describes it, state may have moved on.

---

**Session 2's `clasp push` blocker is resolved — Kris confirmed push, pull,
and trigger install all done.** Everything through commit `1f28a1e` is now
live on the Apps Script project. No outstanding deploy blocker.

**Fixed a real gap found while confirming the deploy steps:
`installDailySelfPracticeTriggers_()` had no dropdown-visible wrapper.**
Every other phase's entry points follow the `functionName()` calls
`functionName_()` convention so Apps Script's "Select function to run"
dropdown can find them — this one was missed, so there was no way to
re-install Phase 7's triggers (e.g. after the session-2 fix that added the
new 8pm compliance trigger) without editing code in the browser editor,
which CLAUDE.md explicitly forbids. Added `installDailySelfPracticeTriggers()`
wrapper — commit `1f28a1e`. Also confirmed `installAllReadyTriggers()`
(`Phase1_ComplianceCheck.gs`) already calls the `_` version directly, so
running that one function reinstalls every enabled phase's triggers,
Phase 7 included — no need to run phase-specific installers individually.

**Explained the Joana/Tomás "few-shot anchors" email to Kris** — it's Joana
asking Tomás to confirm 3 real calls (Carolyn Triebold, Tennitia Wilson, Ben
Sweet) are fair representative examples before they become permanent
grading references for the AI scorer. Not a code/deploy issue, just needed
context. Kris is asking Tomás directly — no action needed from a future
session unless Tomás's reply changes something.

**Built two Google Docs for the sales team** (not code, pure documentation —
Kris will send this to the reps directly):
- First pass covered technical pipeline internals (transcription mechanics,
  deploy steps, "where things live") — Kris pushed back hard: reps don't
  care about any of that, rewrite it as short and rep-facing as possible.
- Final version, titled **"How Call Reviews Work — What You Need To Do"**:
  https://docs.google.com/document/d/1vCyXc_Qe7jCvcoJuyUFPFC9HVBpBoVcaRRpWpu32DfE/edit
  Two sections only: (1) a table of each rep's own Drive upload folder
  link(s) — Sean (Sales Calls, Qualification Calls, Daily Practice), Joana
  (QC & Sales Calls, Daily Practice), Tomás (Sales Calls, Second Calls),
  Bens (Riverside transcript folder, Daily Practice); (2) a table of every
  automated email a rep will receive — name, timing, subject-line shape,
  and what action (if any) to take. Since the team is spread across time
  zones, every "when" is shown as both PT (the system's actual clock,
  `CONFIG.BUSINESS_TIMEZONE = 'America/Los_Angeles'`) and ET — e.g. "6:00pm
  PT / 9:00pm ET" — converted assuming both US zones are currently in
  daylight time (3h gap), which holds for most of the year but drifts by an
  hour for a week or two around the DST changeover if PT/ET switch on
  different dates; not footnoted in the doc itself since it's not worth
  confusing reps with.
- Two earlier draft versions of this doc were created and then trashed
  (`mcp__Google_Drive__trash_file`) as each got superseded — only the final
  link above is live. There is still no tool available that can edit an
  existing Google Doc's body content, so any future revision means
  repeating this create-new/trash-old pattern (same limitation noted for
  Joana's setup doc in session 2, §0 below).

---

# Handoff — 21/08/2026 (session 2)

## 0. What happened this session (read this first)

**IMPORTANT — code is pushed to GitHub but likely NOT deployed to the live
Apps Script project yet.** `clasp push` failed mid-session with
`invalid_grant`/`invalid_rapt` (an expired Google re-auth token, unrelated to
the code). Fix on the machine with `.clasp.json`:
```
clasp logout
clasp login
clasp push
```
Everything below in this section is in `main` on GitHub as of commits
`f1c4e36` → `98ec43d`, but confirm it actually reached the live Apps Script
project before assuming any of it is running for real.

**Fixed a real bug: every rep-facing email subject was missing the rep's
name.** Kris couldn't tell whose email was whose in an inbox list (multiple
reps' automated emails all had the same generic subject). Added `<rep> — `
to the front of the subject in every phase that emails individual reps:
Phase 1 (compliance check), Phase 3 (handoff brief), Phase 4 (inbox SLA),
Phase 5 (weekly scorecard), Phase 7 (daily practice reminder) — commits
`60b6530`, `4694e85`. Phase 2/6/8 either already had the rep's name or only
ever go to one fixed recipient (Kris/Tomás), so left alone.

**Phase 7 (daily practice) had two more real bugs**, both fixed in
`60b6530`:
- The YYMMDD file-naming instruction was only wired into the close-ask
  assignment branch — the "objections" branch and the generic fallback
  branch (what Bens/Joana actually see when no objections are on file yet)
  never told the rep how to name their file at all.
- The non-compliance nag was a once-a-day check tied to calendar date, not a
  true 12h interval, despite Kris asking for 12h. Now: two daily triggers
  (`COMPLIANCE_CHECK_HOUR` / `COMPLIANCE_CHECK_HOUR_PM`, 8am/8pm) plus a
  real elapsed-time gate (`NAG_INTERVAL_HOURS = 12`) using a stored
  timestamp instead of a date string.

**Formatting fixes, content unchanged, on three more bot emails** (Kris
flagged each as "badly formatted" with real screenshots):
- Phase 4 inbox SLA email — added an `htmlBody` bullet list so unanswered
  emails don't run together as one wrapped paragraph (`60b6530`).
- Phase 8 daily reply tracker — added blank lines between the
  Today/7-day/30-day blocks, which were running together (`f1c4e36`).
- Phase 6 training call review email — already had an `htmlBody`, but it
  was just `<p>` tags with bold labels, so Notes/team-notes still rendered
  as one dense paragraph. Restyled with colored yes/no badges for the
  attended/practiced stats and a left-accented callout box per section
  (blue Notes, orange close-ask, purple team-note) — `98ec43d`. Reusable
  helpers `trainingReviewStatBadge_`/`trainingReviewCallout_` if other
  phases' emails need the same treatment later.

**Found and fixed a real transcription-pipeline bug: subfolders were never
scanned.** `list_videos()` (shared by every `transcribe_*.py` script) only
listed a folder's direct children. Live folders actually have videos
organized into subfolders — confirmed real, not hypothetical: Sean has
`Sabiha Razzak` and `Roxy Miles` subfolders under Sales Calls, Joana has a
`Qualification Calls` subfolder under QC & Sales Calls — and none of those
videos were ever being picked up by any engine (Gemini/Qwen/Whisper) on any
machine. Fixed in `bbb2b64`: `list_videos()` now recurses into subfolders at
any depth, and each video carries its own `parent_folder_id` so its
transcript doc and multi-machine lock file get created in the folder it
actually lives in (not the top-level folder) — threaded through every
script that calls `save_transcript_doc` (Sean/Joana/Tomás ×
Gemini/Qwen/Whisper, plus `transcribe_daily_practice.py`).

**Transcription backlog snapshot (21/08, before the OVH box's next few
cycles run with the recursion fix):**

| Folder | Videos | Transcribed | Pending |
|---|---|---|---|
| Sean — Sales Calls (+2 subfolders) | 146 | 145 | 1 |
| Sean — Qualification Calls | 80 | 71 | 9 (4 from Feb, unexplained — see §3) |
| Joana — QC & Sales Calls (+ Qualification Calls subfolder) | 25 | 0 | 25 (never scanned before the recursion fix — should clear on the next OVH cycle) |
| Tomás — Sales Calls + Second Calls | 80 | 80 | 0 |
| Bens — Daily Practice | 0 | n/a | n/a (no raw-video folder — Riverside handles his) |

**Bens' Riverside-transcript folder** (`PHASE2_CONFIG.LEGACY_FOLDERS.Bens`,
`1vA5F39fGZ3kUrXwMNV9TTQf3Iho_ipdg`) now has ~60 `.txt` transcripts, up from
the 43 scored in the first batch (17/08). **Do not re-run
`scoreBensLegacyTranscripts()` yet** — Kris wants to wait until Bens
confirms he's fully caught up uploading before scoring the rest.

**FEW_SHOT_ANCHORS sign-off — RESOLVED, was never actually a code/deploy
problem.** The email asking Tomás to confirm the 3 few-shot anchor examples
(Carolyn Triebold close-ask miss, Tennitia Wilson objection-handling miss,
Ben Sweet model resolution) was a fully-written, correctly-addressed Gmail
draft (`to: tomas@iconsofrealestate.com`, `cc: kris@ardorseo.com`) that had
just never been sent — sitting in Joana's Gmail account since 20/08. Sent it
this session via `mcp__Gmail__send_message` with `draftId`. Nothing to
follow up here unless Tomás's reply raises something.

Also emailed Tomás directly (separate from the above) with a link to the
Sales Call Log and what to check, so he can self-verify his own
`call_role`/`teachable_strength`/`coach_this` output now that his backlog
(Sales Calls + Second Calls) is fully transcribed — his own leads, his call
on whether the classification/coaching reads right.

**Known friction: the Gmail MCP connector for this session kept needing
manual reconnection between `kris@iconsofrealestate.com` and
`joana@iconsofrealestate.com`** to find things (an email sent from one
account isn't visible when the connector points at the other). This is the
same underlying issue flagged in the 20/08 handoff below. Worth someone
checking with whoever set up the connector which account should be the
actual default, so this doesn't keep costing time.

**Still not done: delete the stale "NOT YET READY" banner in Joana's setup
doc.** No tool in this session can edit a Google Doc's body content (only
read/download/metadata) — someone needs to open the doc and delete this
paragraph (and the `---` divider right after it) by hand:
> ⚠ NOT YET READY TO RUN: JOANA_FOLDERS in transcribe_joana_calls.py is
> still an empty placeholder — nobody has filled in her actual Drive folder
> ID(s) yet. Someone needs to edit that one line in the repo (same file
> Sean's and Tomás's real folder IDs live in) before Step 5 below will do
> anything but exit with an error. Everything else in this doc is ready to
> go now.

https://docs.google.com/document/d/1MUhwFzSeDX9w0D2PN6ct4JCfSoGg1u2d_SrCnmijmfc/edit

---

# Handoff — 20/08/2026 (end of day)

## 1. Current state — everything is live

`installAllReadyTriggers()` (`Phase1_ComplianceCheck.gs`) was run this
session and confirmed clean — **all 8 phases installed, nothing skipped**:

- Phase 1: daily compliance check + weekly self-heal
- Phase 2: ongoing call scoring (4h) + Sean auto-scoring (4h) + **Tomás
  auto-scoring (4h, new this session)**
- Phase 3: warm-handoff briefs
- Phase 4: inbox SLA check (Sean + Bens only — Joana deliberately excluded,
  see below)
- Phase 5: weekly scorecard
- Phase 6: training call review + Tomás's Tuesday transcript reminder
- Phase 7: daily self-practice grading + reminders (persistent follow-up
  system, new this session — see §2)
- Phase 8: reply tracker (new this session — see §2)

**Phase 0 (Riverside sync) is gone, not just parked.** Deleted
`Phase0_RiversideSync.gs` this session — settled decision from earlier today
(Riverside's API is Business-plan-only, Bens manually downloads his own
transcripts instead), and nothing else in the codebase depended on it.
Don't recreate it unless the Riverside plan is genuinely upgraded.

## 2. What got built/fixed this session

**Fixed a real scoring bug, not just a rubric question.** Sean's Phase 5
"1.0/5 across 103 calls" flagged at the top of today's earlier handoff was
real, but not because Sean is bad — `LITELLM_PROXY_URL` was never set
(the LiteLLM proxy server described in `litellm-config.yaml` was never
actually deployed anywhere), so ~110 of those "scored" calls were parse-failure
placeholders hardcoded to `score: 1`. Fixed by pointing `Phase2_CallScoring.gs`
straight at Moonshot's own API instead of a nonexistent proxy
(`LITELLM_PROXY_URL` → `https://api.moonshot.ai/v1/chat/completions`, model
name `kimi-k3` confirmed via platform.kimi.ai/playground, no `moonshot/`
prefix). Ran `deleteFailedParseRows()` + `scoreSeanTranscripts()` to rescore
for real — **re-check Sean's actual average once that finishes** (see §3).
Real scoring costs ~$0.02–0.03/call (Kimi K3: $3/M input, $15/M output).

**Tomás's own calls now get graded too** (`Phase2_CallScoring.gs`) —
`scoreTomasTranscripts()`, shared rubric (not Sean's stricter variant, per
`tools/transcribe_tomas_calls.py`'s own header note). Two folders:
`PHASE2_CONFIG.TOMAS_FOLDERS = { 'Sales Calls': ..., 'Second Calls': ... }`
(his own first-touch calls vs. his closing calls as the 2nd-call closer —
added mid-session once Kris found the folder). The judge classifies
`call_role` (`own_new_lead` / `second_call_closer`) from the transcript
itself since the folders don't cleanly separate this, and every call gets
two coaching fields beyond the score — `teachable_strength` (what to pass to
other reps) and `coach_this` (what to train him on) — per Kris's explicit
ask: the point is coaching material both directions, not just a number.
Backlog (46 transcripts as of this session, "Second Calls" still
transcribing) is scoring via the same 4h trigger as Sean's.

**Phase 7 (daily self-practice) got a persistent follow-up system,
replacing the old one-shot "alert Kris/Tomás about yesterday" check** —
Kris's ask: a rep saying "done" isn't enough. `checkDailyPracticeCompliance_`
(same trigger slot, no new install) now tracks every outstanding assignment
in a new **"Daily Practice Follow-ups" sheet tab** and reply-alls a nag on
the *same thread* once a day until either (a) a correctly-named file (must
start with that day's YYMMDD — Zoom's own auto-recording name does not
count) lands in the rep's folder, or (b) Kris or Tomás replies-all on that
thread with "cancel" or "stop". Once the file *and* its transcript are both
ready, the grading itself lands as a reply-all on that same tracked thread
(`deliverDailyPracticeGrading_`) instead of a separate email — shared logic
between this daily scan and the nightly grading pass, whichever gets there
first. A file with no tracked thread (predates this system) still falls
back to a standalone email.

**New Phase 8: daily reply tracker** (`Phase8_ReplyTracker.gs`) — tracks
the hundreds of cold-outreach replies forwarded daily into Joana's inbox.
Confirmed by reading real threads: despite hundreds of different Maildoso
sending domains, every forward funnels through one consistent address,
`network@ardorseo.com` — that's what it filters on. Classifies each reply
positive/negative via the same Kimi judge Phase 2 uses (no existing system
recorded this before), logs to a new "Reply Tracker" sheet tab, reports
daily/7-day/30-day rollups (count, positive, negative, % of negative-replying
leads who later turned positive) to Kris (cc Tomás) at 9pm daily.
`ENABLED = true`, live. Costs pennies — replies are short, ~$0.003–0.005 each.
**Not yet wired up:** the two booking-percentage metrics ("booked themselves"
vs. "booked to QC by a rep") are stubbed — `REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS`
is empty, logs `n/a` rather than guessing. Needs the real tab name(s) holding
the existing "Booked" column (values seen: a rep name, or "By the Lead").

**Fixed a silent deploy-drift bug on Kris's machine**, not code: a stale
nested `sales_review_project/sales_review_project/` folder (leftover from an
earlier accidental clone-inside-a-clone, dated 17/08) was sitting inside the
real repo folder. Because `.clasp.json` has `rootDir: "."`, `clasp push`
walked into it too and — since Apps Script has a flat file namespace — the
stale duplicate `Phase1_ComplianceCheck.gs` inside it was silently
overwriting the real one's fixes on every push. Kris deleted the nested
folder; confirm a future `clasp push` + a look at the compliance email
formatting (see §3) to be sure this is fully resolved.

**OVH VPS is now running the transcription backlog live, in parallel, at
idle priority.** Deployed `tools/transcribe_all.py` (Sean + Joana + Tomás,
Whisper engine — free, local) to the OVH box (`vps-b3e68291`, IP
`148.113.204.247`, SSH port `2288`, 16 vCores/16GB, also hosts websites via
FASTPANEL/nginx/php-fpm/mariadb) via `tools/deploy/setup_ovh.sh` — installs
Python/ffmpeg, builds a venv, and registers a systemd timer
(`transcribe-all.timer`) that fires every 6h automatically. `credentials.json`/
`token.json` were copied over from Kris's laptop (they're gitignored,
per-machine secrets — not something `git pull` brings over).

Added parallel-worker support (`TRANSCRIBE_WORKERS`/`WHISPER_THREADS` env
vars) once Kris confirmed the box was idle and wanted it maxed out — this
just runs N copies of the same batch loop as separate processes, safe
because it reuses the SAME Drive-lock (`.lock-<video_id>`) that already lets
multiple laptops share one backlog without double-transcribing. Systemd unit
defaults to `TRANSCRIBE_WORKERS=4` x `WHISPER_THREADS=4` = 16 threads,
matched to the box's core count. Confirmed live via `top`: all 4 workers
running at ~380-400% CPU each, `Nice=19`/idle scheduling correctly yielding
to the box's real websites (`php-fpm`/`mariadb` stayed low-CPU and
unaffected throughout). Bens is deliberately NOT in this script — his calls
come pre-transcribed from Riverside, no raw-video folder to point this at.

Useful commands on the VPS (`ssh -p 2288 root@148.113.204.247`):
```
systemctl list-timers transcribe-all.timer   # next scheduled fire
sudo systemctl start transcribe-all.service   # run it right now
sudo systemctl restart transcribe-all.service # pick up a config change mid-run
journalctl -u transcribe-all.service -f       # watch a run live
```
**Check next session**: how far Sean's 75-video "Qualification Calls"
backlog got, and whether Joana's/Tomás's batches on this box found anything
new beyond what the laptops already did.

## 3. Open items for a future session

- **Re-check Sean's real Phase 5 average** now that the Moonshot direct-call
  fix + `scoreSeanTranscripts()` rescore have run — the 1.0/5 was fake data,
  confirm what his actual average looks like via `previewWeeklyScorecards_()`.
- **Confirm the compliance-email formatting fix actually deployed** — this
  was blocked by the nested-folder `clasp push` bug (see §2); the fix itself
  (commit `a278379`, an older commit than today's session) should already be
  correct in git, just confirm it's showing up in a real sent email now that
  the nested folder is gone.
- **Wire up Phase 8's booking-percentage metrics** — need the real tab
  name(s) for the existing "Booked" column (see §2).
- ~~Get Tomás's sign-off on the 3 `FEW_SHOT_ANCHORS` excerpts~~ — RESOLVED
  21/08, see the session-2 handoff above (was a real unsent draft, now sent).
  Still waiting on Tomás's actual reply confirming the 3 examples.
- **Sean's Qualification Calls has 9 stuck pending videos**, 4 of them from
  a single Feb 2026 upload batch (`Hyrum Worthen`, `Mark Gordon`,
  `Scott Felske`, `Andrew Farley & Lisa Briganti`) that never got picked up
  despite the rest of the queue being current. Checked sizes/names/dates
  (21/08 session) — nothing structurally wrong, no lock file on any of
  them. Likely just never reached yet (listing order isn't chronological),
  not a code bug — but if still untouched after several more OVH cycles,
  worth a real investigation.
- Decide/confirm Tomás's `call_role` split is producing sensible results
  once his backlog (Sales Calls + Second Calls) finishes scoring — spot-check
  a few `teachable_strength`/`coach_this` entries before circulating any of
  it to other reps (every row is forced `Manual Review Recommended = TRUE`,
  same policy as the other legacy backfills).
- Run Joana's Whisper transcription pipeline once OVH access is available
  (unchanged from before this session).
- Delete the stale "NOT YET READY" banner in Joana's setup doc (cosmetic,
  unchanged from before this session):
  https://docs.google.com/document/d/1MUhwFzSeDX9w0D2PN6ct4JCfSoGg1u2d_SrCnmijmfc/edit

## 4. Key architectural decisions

- **Apps Script hides trailing-underscore functions from the "Select
  function to run" dropdown.** Every `preview*_()`/`install*_()` function in
  this codebase uses a thin no-underscore wrapper for this reason.
- **GitHub and the live Apps Script project can silently drift** — both via
  the browser editor (an `ENABLED` flip not in git gets reverted by the next
  `clasp push`) and, as discovered this session, via a stale nested clone
  inside the working directory that `clasp push` also walks (flat Apps
  Script namespace means a duplicate file silently wins). Deploy workflow is
  always: change config in the repo → commit → push → `git pull` +
  `clasp push`. Periodically sanity-check there's no nested
  `sales_review_project/` folder inside the real one.
- **The Moonshot/Kimi call is direct, not through a proxy** — despite the
  Script Property names (`LITELLM_PROXY_URL`/`LITELLM_API_KEY`) and
  `litellm-config.yaml` existing in the repo, no LiteLLM proxy server was
  ever deployed. Those properties point straight at Moonshot's API. Don't
  assume `litellm-config.yaml` describes live infrastructure.
- **"Asking for the money" is graded as its own skill, separate from
  objection handling.** Objection Handling = Agree, Isolate, Repeat; Asking
  For The Money = a direct line, ideally asked more than once. Runs through
  Phase 6 (`TRAINING_CLOSE_DRILL_<rep>`) and Phase 7 (`drill_type`).
- **Training-call folder structure**: `<Rep> Training Calls/<YYMMDD>/`
  containing Zoom's own auto-generated `.vtt` transcript + video/audio.
- **Daily-practice file naming**: must start with that day's YYMMDD (new
  this session) — enforced by `checkDailyPracticeCompliance_`'s persistent
  follow-up, not just a suggestion.
- **The daily-practice cycle is anchored to Tuesday's training call, NOT the
  calendar work-week:** Wed=Day1 … Tue=Day5. `computeTrainingCycleLabel_` is
  stateless — computed from the date against a fixed epoch.
- **This week's objections/close-ask drill persist across a skipped/late
  training week** — Phase 6 only overwrites `TRAINING_OBJECTIONS_<rep>` on a
  real non-empty result.
- **`htmlBody` passed to `guardedSend_`/`MailApp.sendEmail` must contain raw
  HTML tags, not HTML-escaped text.**
- **Cross-machine Drive lock** (the three `*_whisper.py` scripts): a
  `.lock-<video_id>` marker file, stale-lock steal after 6 hours. Gemini/Qwen
  variants deliberately don't have this.
- **Reply-tracker forward address**: `network@ardorseo.com` is the one
  consistent thread despite hundreds of different Maildoso sending domains —
  confirmed by reading real inbox threads, not assumed.

## 0e. Session handoff point — everything below is committed and pushed to `main`

Picking this up in a fresh session/account: nothing is stuck in an
uncommitted or unpushed state as of this note (`git status` clean, HEAD =
`fda1818` on `main`). In order, most recent first:

- **`fda1818`** — `deep_research_prompt.md` at the repo root: a
  ready-to-paste prompt for Claude's Research feature (or another deep
  research tool) covering LLM-as-judge reliability, sales coaching program
  design, build-vs-buy vs. commercial call-intelligence platforms,
  Sheet-as-database architecture risk, and the missing
  score-vs-close-rate/revenue feedback loop. Not yet run — Kris was
  planning to run it via claude.ai's Research feature (Opus, high/xhigh
  effort), not Claude Code, since it's pure web research/synthesis with no
  repo interaction.
- **`90342f1`** — `tools/dashboard/tests/` — a full pytest suite (76 tests,
  previously zero) covering every `app.py` business-logic function and
  every route, against a per-test throwaway SQLite fixture. Run with
  `cd tools/dashboard && pip install -r requirements-dev.txt && pytest tests/ -v`.
  Doesn't touch the live dashboard/VPS at all.
- **`9262218`/`6f2fe57`** — the still-open action item from earlier
  tonight: **`installLegacyBackfillTrigger()` was run to re-score Bens'
  ~57 legacy transcripts under his corrected (booking, not closing)
  rubric** after `deleteBensLegacyRows()` cleared the ~42 old-rubric rows.
  As of this note it's unconfirmed whether that finished — **next session
  should check the Apps Script Executions log for a `scoreBensLegacyTranscripts`
  firing reporting `scored 0, already-present 53`** (57 minus the 4
  oddly-named files it correctly skips), then run
  `removeLegacyBackfillTrigger()` so the 10-minute trigger doesn't fire
  forever. Also in this range: the daily-practice thread-tracking race fix
  (root cause of a rep's assignment not showing as synced) and the
  playbook Contents-line readability fix.
- **Deploy status**: all `.gs` changes through `1fda8f9` were confirmed
  live via `clasp push` by Kris. The two commits after that
  (`6f2fe57` Phase7 fix, `9262218`/`90342f1`/`fda1818` non-Apps-Script
  files) — the Phase7 fix specifically still needs a `git pull` +
  `clasp push` on Kris's machine to actually take effect; the dashboard
  test suite and the research prompt don't need any deploy at all.
- **Open decisions nobody has answered yet**: the Bens duplicate-row
  sqlite check (query given to Kris, never confirmed either way), and
  whether `DASHBOARD_SESSION_SECRET` on the VPS actually got regenerated
  as a real secret (see §0c) rather than the literal
  `$(openssl rand -hex 32)` string from the quoted-heredoc bug.
