# Handoff — 28/08/2026 (session 12 — GHL integration built, Inbox SLA alias bug fixed, Reply Tracker bug found)

## 0. What happened this session (read this first)

Three separate threads: (1) built out the GoHighLevel CRM integration from
scratch through a real (but not-yet-enabled) data backfill, (2) found and
fixed a real production bug in the Inbox SLA check, (3) found but did NOT
yet fix a real bug in the Reply Tracker's per-lead metrics. Also several
smaller fixes carried over from immediately before this session's context
was summarized (playbook corrections, email formatting). All `.gs` changes
this session were pushed straight to `main` (branch workflow dropped
partway through — Kris's explicit call, see commit history for the exact
point).

### 1. GoHighLevel (GHL) CRM integration — built, mostly still preview-only

New file **Phase9_GhlSync.gs**, new doc **GHL_PIPELINE_MAP.md** (full survey
of all 6 GHL pipelines/stages, keep reading this before touching anything
GHL-related further).

- `previewGhlConnection()` — read-only, dumps every pipeline+stage ID. Run
  and confirmed working live.
- `previewGhlMatching()` — read-only, samples ~16 Sales Call Log rows,
  resolves each to a GHL contact by name. First real run: only 4/16
  confident matches, one real bug found and fixed (`/opportunities/search`
  needs snake_case `location_id`/`contact_id`, not camelCase — GHL's v2 API
  is genuinely inconsistent about this across endpoint groups).
- **Real data-quality bug found and fixed at the source**: Sean/Joana/
  Tomás's Prospect Name column had filename cruft ("1/21 Anthony Camperi",
  "Will Salinas SC.mp4") breaking every GHL name search. Fixed going
  forward (`cleanProspectNameForSheet_` in `Phase2_CallScoring.gs`, applied
  at write time + dedup-key computation) AND retroactively — Kris ran
  `repairProspectNames()` live, **315 rows corrected** in the production
  Sales Call Log, confirmed idempotent (immediate re-run found 0 more).
- **Second real bug found and fixed**: GHL's contact search can return
  completely unrelated contacts (5 for "Desiree Doggett", zero name
  overlap) instead of an empty list. Added `contactNameLooksLikeQuery_`
  name-similarity filter so garbage results read as "no match," not a
  false "ambiguous" or (worse) a false "confident" match.
- Re-ran `previewGhlMatching()` after both fixes: **11/16 confident, 1
  ambiguous, 4 no-match, 0 search failures** — up from 4/16. The 4
  no-matches (all Tomás, all 28/08 same afternoon) are **confirmed real,
  not a bug**: Tomás's answers + a podcast-tracker xlsx Kris provided
  confirmed Lucy Quiñones is a real lead tracked entirely in a separate
  "Icons of Real Estate Podcast Tracker" Google Sheet
  (docs.google.com/spreadsheets/d/1EkZ03TUMxWbTu6L7mu08tLHXofNqD79y3hqFdBzcWNE),
  never in GHL at all — exact email match confirmed
  (`lucyqpa@gmail.com`). Chelsea Fernandez/Monique Lewis/Salisia Murray are
  also real 2024 leads not found in GHL, source unconfirmed. Written up as
  **finding E** in `GHL_PIPELINE_MAP.md` — a "no GHL match" must be treated
  as its own category (lead lives elsewhere / predates tracking), never
  auto-treated as broken data.
- **Built the actual backfill** (items 1-2 of `GHL_PIPELINE_MAP.md`'s
  ranked plan): `previewGhlSync()` (read-only, full-sheet scan) and
  `syncGhlEmailAndDisposition_()` (the live write — gated by
  `GHL_CONFIG.ENABLED`, **still false**). Fills blank Prospect Email and
  Outcome Disposition from the matched GHL contact/opportunity; never
  overwrites anything already there; flags (writes nothing for) a contact
  whose opportunities imply conflicting dispositions across pipelines
  rather than guessing; time-boxed (`GHL_SYNC_TIME_BUDGET_MS_`, same
  pattern as `INBOX_SLA_TIME_BUDGET_MS_`) since a full ~439-row scan can
  cost up to 2 GHL calls/row.

**Not done yet**: Kris has NOT yet run `previewGhlSync()` on the real
sheet. That's the immediate next step before `GHL_CONFIG.ENABLED` can be
considered. Also still open, unanswered by Kris — see
`GHL_PIPELINE_MAP.md`'s "Open questions" section: Cold Calling 2's 619
"Qualification Call Booked" count (real or import artifact?), who Bruno/
Simon/Ty and assignee initials SC/JP/BO/PC/KD/AA are and whether their
calls should be scored, the unused-looking "…Booked" stages reading 0 in
ICONS Podcast, what the "Advanced filters (1)" chip on every GHL board
actually filters, and whether the Remarketing chase ladder (Dial 2/3/
Social DM/Tomas Email) is meant to be used.

### 2. Inbox SLA false positive — real bug found and fixed, deployed

Bens got flagged for an email he'd already replied to. Root cause
(confirmed by Kris): Sean and Bens' `@iconsofrealestate.com` and
`@ardorseo.com` addresses are the SAME GSuite mailbox — either can be the
`From` address on a message they send — but
`findUnansweredThreadsForRep_` (`Phase4_InboxSLA.gs`) only ever compared
against one hardcoded address. Fixed: added `aliases` to each rep in
`INBOX_SLA_CONFIG.REPS` (`sean@ardorseo.com`/`bens@ardorseo.com`) and a new
`repOwnEmails_()` helper; the "did the rep answer" check now matches any of
a rep's own addresses. **Deployed live** (`git pull` + `clasp push`
confirmed done by Kris) — takes effect on tomorrow's 18:00 run.

Separately raised, deliberately NOT actioned: Bens' complaint that the
bot also flags pure-FYI ICONS-internal broadcast emails ("your episode is
LIVE", promo-kit notices). **Kris's explicit call: skip this, tell Bens to
archive them manually instead** (that's the only lever that actually
works — the bot only checks `in:inbox`, never read/unread status, so
marking read/unread does nothing).

### 3. Reply Tracker — real bug found, NOT yet fixed, needs real sample data

Kris flagged the "Sales Review - Daily Tracker" email as inaccurate: 131
replies today but "0% booked themselves / 0% booked to QC" AND only "6
leads who replied this period" (should be closer to 131). Root cause
theory, strongly supported by this file's own header comment: **`Phase8_
ReplyTracker.gs`'s "Lead Email" is extracted from the forwarded message's
own `From` header** (`extractEmailAddress_(msg.fromRaw)` in
`classifyNewReplies`), which per that file's documented finding is very
likely `network@ardorseo.com` (the Maildoso forwarding relay) on most/all
threads — NOT the real lead's address. That would explain both symptoms:
per-lead grouping in `computeReplyStats_` collapses to almost nothing, and
`reconcileBookingOutcomes_`'s join to the booking tracker (keyed by lead
email) never matches, permanently reading 0%.

**Not yet fixed** — need real evidence before touching the extraction
logic (same discipline as every other fix this session): either a couple
of real rows from the "Reply Tracker" sheet tab's `From`/`Lead Email`
columns, or the raw "From:" line + quoted forwarded-header block from one
of Joana's actual forwarded reply emails, to see the real Maildoso forward
format and extract the actual lead address correctly (probably from the
quoted header block in the body text, not the envelope `From`).

### 4. Carried over from just before this session's context was summarized

- **Objection Handling Playbook factual fixes** (`Phase1_ComplianceCheck.gs`):
  removed "Dana Hindman-Allen" miscategorization from Bens' playbook
  (count 2→1, live sheet patched too) and the disputed "Mark Vincent
  Fansler" example from Joana's playbook (count 4→3) — both per Tomás's
  review feedback.
- **Handoff Brief and Reply Tracker emails** got HTML formatting (colored
  section labels, bold key facts) per Kris's ask that they "needs colour
  and bolding." Reply Tracker subject changed to "Sales Review - Daily
  Tracker".
- **Playbook review rewritten to be strictly week-scoped** — per Kris's
  explicit instruction ("training should focus on only the calls that
  happened in the previous week... don't want to revisit OLD issues").
  Removed the old cumulative/watermark-based logic entirely from
  `Phase1_ComplianceCheck.gs`. `PLAYBOOK_REVIEW_CONFIG.ENABLED` flipped to
  `true`, and `installPlaybookReviewTrigger()` confirmed run live —
  weekly, Tuesdays 8am America/New_York.

## 1. Deploy status

Everything through commit `0691a0a` (Inbox SLA alias fix) is confirmed
deployed — Kris ran `git pull && clasp push` and confirmed. Nothing
`.gs`-side is currently un-deployed as of the end of this session. No
dashboard (`tools/dashboard/`) changes were made this session — nothing to
deploy there.

## 2. What a human needs to do next, in rough priority order

1. **Get real sample data for the Reply Tracker "Lead Email" bug** (§3
   above) — this is actively producing a misleading daily email (0%
   booked, wrong lead counts) and is the highest-value fix outstanding.
2. **Run `previewGhlSync()`** (`Phase9_GhlSync.gs`) and review the output
   before considering flipping `GHL_CONFIG.ENABLED`.
3. Answer the open `GHL_PIPELINE_MAP.md` questions (§1 above) whenever
   convenient — nothing is blocked on them except completing the GHL→Rep
   mapping for calls outside `CONFIG.REPS`.
4. Confirm tomorrow that Bens' specific false-positive thread stops
   getting flagged post-deploy, and that he's archiving the FYI-only
   broadcast emails per the "ignore, tell him to archive" decision above.

## 3. Test suite

`tests/run_tests.js`: **137 → 153** this session (name-similarity filter,
the GHL email/disposition backfill's fixes/conflict/time-budget behavior,
the Inbox SLA alias fix). All passing.

---



## 0. What happened this session (read this first) — SHADOW MODE ONLY, NOTHING LIVE CHANGED

Ran in the background. Kris approved `QA_COACHING_RESEARCH_REPORT.md` §1.4 — moving off a single holistic `call_quality_score` (1-5), which the model currently picks directly in the same breath as the booleans/framework it also outputs, toward a deterministic weighted rollup computed from those same booleans. The report's own concern this addresses: nothing today enforces the model's holistic pick agrees with its own flags — it's an unvalidated, uncorrelated second judgment happening in the same pass. Kris's explicit instruction, applied to every rubric variant: a missed close-ask must be weighted higher than any other single miss.

**Built, all `.gs`-side, `Phase2_CallScoring.gs`**:
- `computeAnalyticScore_(variant, result)` dispatches to one pure per-variant function (`computeSharedAnalyticScore_`/`computeSeanAnalyticScore_`/`computeBensAnalyticScore_`/`computeTomasAnalyticScore_`) — base score 5, deductions applied, clamped to `[1,5]` via `clampAnalyticScore_`. Exact weight table (and the reasoning behind each variant's shape — the Bens asked-vs-booked non-double-penalty, the Bens icons_100_interview-only QC-vs-Sales-Call deduction, Sean's OR-close condition and combined discovery/goal-alignment bucket) is now documented in `Phase2_CallGradingSOP.md` §7C — read that section rather than this summary for the full per-variant detail.
- **Shadow mode only — nothing live changed.** Every one of the 5 real scoring write sites (`writeScoreToRow_`, plus the four `appendRow`-based backfill functions for Bens/legacy, Sean, Joana, Tomás) now also calls `logAnalyticScoreShadowCheck_(prospectName, variant, result)`, which computes the analytic score and logs `Analytic score shadow-check: "<prospect>" model=<N> analytic=<N> (diff <N>)` whenever the two differ by more than 1 point (same >1 tolerance `diffRegressionResult_`'s drift check already uses) — and does nothing else. The model's own `call_quality_score` is still exactly what gets written to the "Sales Call Log" sheet at all 5 sites, unchanged. New `ANALYTIC_SCORE_CONFIG = { ENABLED: false }` gates future real use; each write site carries a marked but deliberately **unbuilt** `FUTURE` comment showing where the branch to actually write the analytic score instead of the model's would go once a human decides to build it — flipping `ENABLED` does not, by itself, do anything live yet (see §2 below).
- No schema, `isValid*JudgeSchema_`, or prompt/score-anchor changes in any variant — the model still gets asked for and produces `call_quality_score` exactly as today. This computes a second, parallel number for comparison only.
- Tests: `tests/run_tests.js` **61 → 77** (16 new: a perfect call scores 5 in every variant; the core close-ask-vs-other-miss asymmetry, proven both as "-2 off perfect" vs "-1 off perfect" and as a direct score comparison; the floor at 1 under a worst-case shared-rubric input; `clampAnalyticScore_`'s floor/ceiling directly; Sean's OR-close condition (asked-only, booked-only, neither) and its combined discovery/goal-alignment bucket (one gap vs all four gaps costing the same single point); Bens' asked-but-not-booked vs never-asked non-double-penalty; Bens' icons_100_interview-only QC-vs-Sales-Call scoping (interview+QC, interview+SalesCall, qc-role+QC); Tomás's three single-deduction branches; the variant dispatcher including an unknown-variant fallback; `logAnalyticScoreShadowCheck_`'s >1-only logging and always-returns-the-analytic-score behavior; `ANALYTIC_SCORE_CONFIG.ENABLED` shipping `false`; and — the one that matters most for safety — `writeScoreToRow_` still writing the model's own score to the sheet even when the analytic score diverges sharply).
- `Phase2_CallScoring.gs` re-parses clean: `node -e "new Function(require('fs').readFileSync('Phase2_CallScoring.gs','utf8'))"`.

## 1. Deploy — NOT done, needs a human

This sandbox/session has no `.clasp.json` (see `CLAUDE.md`), so `clasp push` could not be run from here. On whichever machine has `.clasp.json`:

```
git pull
clasp push
```

No sheet migration is needed for this session's change — it adds no new columns, only a new logging call at existing write sites.

## 2. What a human needs to do next — this is a multi-step rollout, not a one-flag decision

1. **Deploy** (above).
2. **Let the pipeline run for a while across a real batch of calls, covering all four rubric variants** (the ongoing shared-rubric pipeline plus the Sean/Bens/Tomás backfill triggers all naturally do this over the following days without anyone doing anything extra).
3. **Read the Apps Script execution log for `Analytic score shadow-check` lines.** Look at how often the model's own score and the analytic rollup diverge by more than 1 point, and how far — this is the real, not-yet-collected evidence for whether the deterministic weights above actually track Kris's own judgment, or whether some variant's weighting needs adjusting before it could ever be trusted to replace the model's number.
4. **Discuss the pattern with Tomás** before touching anything further — same rigor every other rubric-affecting change in this project has gotten (see the Bens variant, Sean's stricter variant, the framework-explanation dimension, all §3B-3D).
5. **Only then consider flipping `ANALYTIC_SCORE_CONFIG.ENABLED` to `true`** (commit → push → `clasp push`, never edit it live in the browser editor — see `CLAUDE.md`). **Flipping this flag does not itself change anything live** — per point 2 above, no write site currently branches on it; the shadow-check keeps logging exactly as before either way. The actual final step, still unbuilt and intentionally left as a small separate follow-up, is wiring each write site's marked `FUTURE` comment into a real `if (ANALYTIC_SCORE_CONFIG.ENABLED) { write analytic score } else { write model score }` branch — that code change is what would make the analytic score the one that actually lands in the "Call Quality Score" column, and it should happen only after step 3's real-data review, not before.

---

# Handoff — 25/08/2026 (session 10 — rubric_version column + frozen regression set for drift detection)

## 0. What happened this session (read this first)

Ran in the background while the main conversation continued elsewhere. Kris approved two specific, narrowly-scoped recommendations from `QA_COACHING_RESEARCH_REPORT.md`'s unstarted list (a third recommendation, analytic sub-scores replacing the single 1-5 `call_quality_score`, was explicitly excluded — nothing about scoring dimensions or `call_quality_score`'s meaning was touched). All `.gs`-side, no dashboard work:

- **Rubric Version column**: the rubric has changed twice in two days (Sean's stricter variant, then the framework-explanation third dimension) with nothing recording which rubric version scored a given row — historical and new rows were silently non-comparable. Added `RUBRIC_VERSION` (`Phase2_CallScoring.gs`, currently `'2026-08-25-framework'`) and a new trailing `Rubric Version` column (`SALES_CALL_LOG_HEADERS`, `Phase1_ComplianceCheck.gs`), written by every code path that writes a score — `writeScoreToRow_()` plus all four `appendRow`-based backfill functions (Bens/legacy, Sean, Joana, Tomás). **Standing project convention, documented in both the code and the SOP**: bump `RUBRIC_VERSION` in the same commit as any future rubric change, any variant. Full detail: `Phase2_CallGradingSOP.md` §3E.
- **Frozen regression set for drift detection**: the judge model (Kimi k3, forced `temperature=1`) could silently drift in behavior over time with nothing catching it — every existing safeguard catches a badly-*formed* response, none catch a well-formed one that started judging differently. Built `freezeRegressionSet_()` (wrapper `freezeRegressionSet()`) — picks ~12 already-scored real calls spread across reps/rubric variants (`pickStratifiedRegressionSample_()`) and stores their scored values in a new **"Regression Baseline"** sheet tab (self-healing header row, same pattern as `getOrCreateTrainingAssignmentsSheet_()`; chose a sheet tab over a `TRAINING_OBJECTIONS_<rep>`-style Script Property specifically for human inspectability — reasoning is in the code comment on `getOrCreateRegressionBaselineSheet_()` and in the SOP). `checkRegressionDrift_()` (preview wrapper `previewRegressionDrift()`, trigger target `checkRegressionDrift()`) re-fetches each frozen call's transcript, re-scores it under the SAME rubric variant that produced the frozen score (`resolveRubricVariantForRow_()` — this is Match-Method-aware, not just rep-name-based, since the ongoing pipeline always scores `exact_key` rows under the shared rubric regardless of rep), and flags via `diffRegressionResult_()` any row where `call_quality_score` moved by more than 1, a boolean flag flipped, or `primary_failure_mode` changed. **Strictly read-only against real data** — never rewrites the frozen baseline, never touches the live "Sales Call Log." Full detail: `Phase2_CallGradingSOP.md` §7B.
- Tests: `tests/run_tests.js` **46 → 59** (13 new: `RUBRIC_VERSION`'s format, `writeScoreToRow_` writing it via a minimal fake-sheet mock, `resolveRubricVariantForRow_`'s exact_key-vs-fallback_heuristic/per-rep mapping, `diffRegressionResult_`'s five drift conditions — no-drift, >1-point score move vs. exactly-1 tolerance, a flipped flag, a changed failure mode, multiple simultaneous diffs — `pickStratifiedRegressionSample_`'s spread/top-up/no-mutation behavior, and `scoreTranscriptByVariant_`'s dispatch).
- Every touched `.gs` file re-parsed clean: `node -e "new Function(require('fs').readFileSync('<file>','utf8'))"` on both `Phase1_ComplianceCheck.gs` and `Phase2_CallScoring.gs`.

**Neither feature is live yet — both need a human to finish the rollout, same "built but not yet installed" pattern `RANDOM_CALIBRATION_CONFIG` followed before it shipped last session:**

1. **Deploy — confirmed done.** `git pull` + `clasp push` run.
2. **Rubric Version column — confirmed live.** `migrateAddPrimaryFailureModeColumn()` (`Phase2_CallScoring.gs`) re-run and confirmed: `Added missing header(s): Rubric Version (column 26)`. Every scoring code path now writes it going forward; rows scored before this read as blank ("no signal"), same backward-compatible pattern as every prior column addition, and are **not** backfilled. Nothing else needed for this piece.
3. **Frozen regression set — still needs a human.** From the Apps Script editor:
   - Run `freezeRegressionSet()` — creates the "Regression Baseline" tab and picks the initial ~12-call baseline. Confirm the tab looks right (real transcript URLs, sensible spread across reps).
   - Run `previewRegressionDrift()` — logs any drift found against real transcripts, writes/emails nothing. Eyeball this against a couple of the actual transcripts before trusting it.
   - Only then flip `REGRESSION_DRIFT_CONFIG.ENABLED` to `true` in the code (commit → push → `clasp push`, never edit the flag live in the browser editor — see `CLAUDE.md`). This makes a real (non-preview) `checkRegressionDrift()` run send an ops alert if drift is found, on top of logging.
   - **Deliberately not wired to a trigger yet** — installing a recurring trigger for `checkRegressionDrift()` (e.g. weekly, alongside the existing calibration/scorecard triggers) is a separate go-live decision left for a human, same as `RANDOM_CALIBRATION_CONFIG` was before this session flipped it on.

---

# Handoff — 25/08/2026 (session 9 — third scored dimension: framework explanation)

## -1. Real outage this session, found and fixed live — deploy-ordering hazard

After the dashboard fast-follow (§2 below) deployed, the live dashboard 500'd on
every page (`Internal Server Error`). Root cause: `sales-dashboard.service`
(the web app) and `sales-dashboard-sync.service`/`.timer` (the SQLite
migration, on its own 10-minute cadence) are separate processes. Deploy
instructions said "restart the app" without also forcing a sync first — the
app restarted running new code that unconditionally queries
`flag_framework_explained` (`rep_summary()`, called on every page via the
Overview route) before the next scheduled sync had migrated `dashboard.db`
to actually have that column. Fixed live by running
`sudo systemctl start sales-dashboard-sync.service` once by hand — no app
restart needed after, since `app.py` opens a fresh SQLite connection per
request.

**Standing rule for any future dashboard change that touches `sync.py`'s
schema** (adds/renames a column `app.py` then queries unconditionally):
deploy order must be sync first, app restart second —
`sudo systemctl start sales-dashboard-sync.service` before
`sudo systemctl restart sales-dashboard`, not the reverse. This mirrors
`setup_dashboard.sh`'s own first-time-setup ordering ("populate
dashboard.db before the app starts") — the same hazard exists on every
redeploy, not just initial setup, whenever a schema change ships.

## 0. What happened this session (read this first)

Kris pushed back on Tomás's feedback that reps should also be drilled on explaining the podcast "framework" (how it recruits agents, builds #1-podcast-in-your-city authority, sells more houses) — not just objection handling and asking for the close. Investigation confirmed the pipeline genuinely didn't track this at all: not scored on real calls, not fed into the weekly scorecard's priority-to-improve, not extractable from Tomás's 1:1 training calls, not drillable in daily practice. Kris's own framing — "explaining the framework properly handles objections before they arise" — became the rubric grounding: the exact same SPIN "prevention beats handling" logic already used for objection handling, applied one step earlier in the call. Built end to end, all `.gs`-side (deliberately did **not** touch the dashboard — see §2 below):

- **Phase 2 (all four rubric variants — shared/Sean/Bens/Tomás)**: new scored `framework` object (`recruit_agents_explained`/`number_one_podcast_explained`/`sell_more_houses_explained`, each independently judged), shared `deriveFrameworkFields_()` helper, `primary_failure_mode` gained `framework_not_explained`. Two new sheet columns, `Flag: Framework Explained` and `Framework Gaps` — real columns, not packed into free text, since this is meant to be a first-class permanent skill like the original two, not a one-off enrichment. **Deliberately does not change `call_quality_score`'s existing anchors** — stays an independent tracked flag. Full detail and the "why this isn't scope creep on §3's own anti-dimension-creep rule" reasoning: `Phase2_CallGradingSOP.md` §3D.
- **Phase 5**: `FAILURE_MODE_COACHING_TEXT_` gained `framework_not_explained` — no other wiring needed, `priorityToImprove_` already generically picks the week's most common `Primary Failure Mode`.
- **Phase 6** (Tomás's weekly 1:1 training-call review): third skill in the rubric alongside objection handling / asking for the money, `practiced_framework` + `framework_gaps_to_drill` extracted, persisted to `TRAINING_FRAMEWORK_<rep>` (same non-destructive "only overwrite on non-empty result" rule as the other two), mirrored into the "Training Assignments" sheet tab (new "Training Framework (JSON)" column).
- **Phase 7** (daily self-practice): `drill_type` gained `"framework"`, with its own rubric branch and score anchors. The daily assignment picker was generalized from a 2-way objections/close-ask alternation to a 3-way rotation across whichever lanes actually have content on file (`todaysLane = availableLanes[label.day % availableLanes.length]`) — objections stays the fallback when nothing is on file at all, unchanged from before.
- **Real bug caught and fixed before it could bite**: `getOrCreateTrainingAssignmentsSheet_()` only wrote the sheet's header row on first creation — since that sheet already exists live, the new "Training Framework (JSON)" header would never have appeared on the real sheet, and `mirrorTrainingAssignment_()` (which writes by fixed column position, not header lookup) would have silently pushed framework JSON into what the header row still labeled "Last Updated," with the real timestamp landing in an unlabeled column. Fixed by making the header check self-healing on every call, same pattern `setupSalesCallLog()` already uses.
- Tests: `tests/run_tests.js` **44 → 46** (all four rubric-variant schema checks, `deriveFrameworkFields_`, the Phase5 coaching-text key, and the Phase7 framework `drill_type` validator all covered). Dashboard suite untouched, still 97, all passing — confirms the deliberate scope boundary below held.

## 1. Deploy — confirmed done

`git pull` + `clasp push` run, then `migrateAddPrimaryFailureModeColumn()` re-run and confirmed live: `Added missing header(s): Flag: Framework Explained (column 24), Framework Gaps (column 25)`. Both new trailing columns are now on the live "Sales Call Log" sheet. **Nothing else outstanding for this session** — every real sales call scored from here on will populate them; rows scored before this deploy read both as blank ("no signal"), same backward-compatible pattern as every prior column addition. No dashboard deploy needed (see §2).

## 2. Update, same session — the dashboard fast-follow is now built

§2 originally documented this as deliberately deferred (see the reasoning below, still accurate as *why* it wasn't done in the first pass). Kris asked for it later the same session — now built, tested, and deployable:

- **The real migration this needed**: `sync.py` gained `_add_column_if_missing()` — `ALTER TABLE ... ADD COLUMN`, guarded by checking `PRAGMA table_info` first rather than swallowing sqlite3's "duplicate column" error, so a genuine failure (locked db, real syntax error) still surfaces. Runs for `sales_call_log.flag_framework_explained`/`framework_gaps` and `training_assignments.training_framework_json` right after `init_schema()`'s `CREATE TABLE IF NOT EXISTS` block. Tested directly against a simulated copy of the live (pre-migration) schema before trusting it — confirmed it adds the columns cleanly, and confirmed a second `init_schema()` call against an already-migrated db doesn't error either.
- **Dashboard surfaces**: `framework_gap_breakdown(rep="")` (which of the 3 pieces get missed most, team-wide or per rep — parsed in Python since SQLite has no generic comma-split, but a safe exact-string count since `framework_gaps` is system-generated, never hand-typed). Wired into: Overview (a new breakdown table + "Framework explained %" column per rep), `/calls` (yes/no filter + a column), rep pages (same breakdown scoped to the rep), and `/training` (the framework drill Tomás assigned, alongside the existing objections/close-ask drills, labeled via a `FRAMEWORK_TOPIC_LABELS` dict kept in sync with Phase6's Apps Script one).
- Verified two ways: dashboard test suite **97 → 111**, and the app was actually started and hit with curl against seeded data (all four new surfaces confirmed rendering real content, not just passing under test mocks).
- **Deploy**: `git pull` on the VPS, then `sudo systemctl restart sales-dashboard` (or wait for the next scheduled `sync.py` run) — the migration runs itself on the next sync, no manual DB surgery.

Original §2 reasoning, for context on why this wasn't done in the first pass:

Kris's actual ask that session was "will we pick it up for the next training plan and their week of practicing" — that's Phase 5/6/7. The dashboard was **not** asked for and was deliberately left alone at the time: doing the column-map change without also migrating the live `training_assignments` SQLite table on the VPS (`CREATE TABLE IF NOT EXISTS` is a no-op against an already-existing table) would have broken the *entire* sync run, not just that one tab, the next time `sync.py` executed on the VPS. Caught before committing, not after.

---

# Handoff — 25/08/2026 (session 8 — outcome_disposition on the dashboard, Bens' missing trigger)

## 0. What happened this session (read this first)

Two things: the dashboard finally surfaces `outcome_disposition`, and a real
scheduling gap around Bens was found while reading a live backfill log.

**1. `outcome_disposition` is now visible on the dashboard.** `sync.py` has
mirrored this column into SQLite since it was written, but nothing in
`app.py` or the templates ever rendered it — so the one column that links
"what the AI scored this call" to "what actually happened on it" was
invisible. Added:
- `outcome_breakdown(rep="")` — per-outcome counts and **average call-quality
  score per outcome** (the score-vs-outcome loop `QA_COACHING_RESEARCH_REPORT.md`
  calls the real missing piece), plus how many scored calls have no outcome
  logged at all.
- Overview: an "Outcome vs. score" section, a 4th stat tile counting calls
  with no outcome logged, and an "Outcome logged %" column in the by-rep
  table (each cell drills into that rep's unlogged calls — the Phase 5 nudge
  target).
- `/calls`: an Outcome filter (including a `__none__` sentinel for "not
  logged") and an Outcome column. The filter is case-insensitive because
  reps hand-type this column.
- Rep pages: the same breakdown scoped to one rep, plus an Outcome column.
- **Deliberate honesty guard**: while coverage is under 50% the Overview
  says so in words and labels the averages provisional. With almost nothing
  logged yet, an "avg score for Sold" computed from a handful of rows is
  noise, and it would be easy to mistake it for proof the rubric predicts
  revenue. When the column is entirely empty the page explains why instead
  of rendering an empty table.
- Tests: `tools/dashboard/tests/` is now **97 tests, up from 78**.

**2. Bens had no scoring trigger of his own — found from the live log.**
`runAllLegacyBackfills_` was still reporting freshly scored calls, including
ones dated 2026-08-16/17. Those are not backlog. Root cause:
`scoreBensLegacyTranscripts()` was reachable ONLY through
`runAllLegacyBackfills_`, while Sean, Joana and Tomás each have their own
dedicated 4-hour trigger. So the standing instruction to retire the backfill
trigger once it drains was in direct conflict with keeping Bens scored at
all — **removing that trigger would have silently stopped scoring him**, and
because his Riverside folder keeps receiving new transcripts, the "scored 0
everywhere" retirement signal was never going to arrive.

Fixed: `installBensScoringAutomation()` (4h, same pattern as the other
three), wired into `installAllReadyTriggers_()`. After this is deployed and
installed, `runAllLegacyBackfills_` is genuinely temporary again and
`removeLegacyBackfillTrigger()` is safe to run.

**3. Closed the actual root cause of the 306 duplicate Bens rows.**
`scoreLegacyTranscriptFolder()` — Bens' scoring path — was the only scoring
function in the file with no `LockService` guard of its own; Sean's and
Joana's have always had one. `runAllLegacyBackfills_`'s mutex only protects
runs started through *it*, so it could never have stopped a dedicated
trigger, a manual editor run, or a stacked leftover trigger from overlapping.
That is why only Bens duplicated. The function now takes its own lock.
**This matters before installing the new 4h Bens trigger** — without it,
adding a second independent caller would have risked reintroducing exactly
the duplication that was just being cleaned up.

## 1. Update, same day — deploy confirmed, all three items closed

- **Deployed and installed, confirmed live**: `installAllReadyTriggers()` ran
  clean at 06:20 — all 8 phases plus Bens' new `installBensScoringAutomation()`
  trigger installed. Dashboard also deployed (`git pull` +
  `systemctl restart`), outcome_disposition changes confirmed rendering.
- **`dedupeLegacyBackfillDuplicates()` re-run to completion**: 06:47 run
  reported "deleted 6798 duplicate row(s)" (well past the ~306 first
  estimated — expected, since the still-firing backfill trigger kept adding
  more between the first partial run and this one; not a new problem).
- **`removeLegacyBackfillTrigger()` run** at 06:52, confirmed "Removed 1
  runAllLegacyBackfills_ trigger(s)" — exactly one, so no stacked leftover
  copies were found. Bens is now scored solely by his own dedicated 4-hour
  trigger, same as Sean/Joana/Tomás.
- **`DASHBOARD_SESSION_SECRET` confirmed real**, resolving the long-open
  question from session 4c: Kris pasted the live `/etc/sales-dashboard/env`
  and it's 64 real hex characters (a genuine `openssl rand -hex 32` output),
  not the literal `$(openssl rand -hex 32)` placeholder string the
  quoted-heredoc bug risked. Also visible in that same file:
  `DASHBOARD_ALLOWED_EMAILS` currently covers kris/tomas/bens/sean
  @iconsofrealestate.com — Tomás can already log in, nothing more to add.

**Nothing outstanding from this session.**

## 2. Known-stale, not fixed this session

The rep-facing Google Doc "How Call Reviews Work"
(https://docs.google.com/document/d/1vCyXc_Qe7jCvcoJuyUFPFC9HVBpBoVcaRRpWpu32DfE/edit)
lists every automated email time as PT/ET based on
`CONFIG.BUSINESS_TIMEZONE = 'America/Los_Angeles'`. That changed to
`America/New_York` in session 7, so **every time in that doc is now 3 hours
off** and reps are working from wrong expectations. No tool here can edit a
Doc's body, so fixing it means the create-new/trash-old pattern.

---

# Handoff — 23/08/2026 (session 7 — Call Date bug fully closed out, deployed, and repaired live)

## Status: everything below this section is DONE. Read this first, it supersedes the "NOT yet run" note in the section right below it.

Picking up from the session 6 addendum directly below: the Call Date fix
(`f7830a0`) has now been fully deployed and the live repair has run
successfully. Nothing from that addendum is still pending.

**What happened this session, in order:**

1. **Business timezone changed to Eastern**, per explicit instruction from
   Kris: `CONFIG.BUSINESS_TIMEZONE` is now `'America/New_York'` (was
   `'America/Los_Angeles'`) — commit `e6bb891`. Most of the client base is
   Eastern; the old Pacific setting was a holdover from "6pm PST = day's
   done," not a real business-timezone requirement. **All existing hour
   constants (GRADING_HOUR, REMINDER_HOUR, COMPLIANCE_CHECK_HOUR, etc.) are
   unchanged in value but now mean Eastern instead of Pacific — everything
   fires 3 hours earlier in absolute time.** If any of those hours were
   meant to anchor a specific real-world moment rather than "X o'clock local
   business time," they need a separate look — not done this session.

2. **Found and fixed a second, more subtle bug in the Call Date fix itself**,
   caught via `previewCallDateRepair()` before any live write:
   `resolveYearForMonthDay_` was comparing a computed "midnight of the
   titled day in BUSINESS_TIMEZONE" against a sibling video's exact creation
   instant, and rolling the year back a full year if that instant came out
   "later." Drive's `createdTime` is UTC — a video created a few minutes
   after UTC midnight reads back as the EVENING BEFORE once converted to
   America/New_York, which falsely tripped the "must be next year" rollback
   for videos created close to a UTC/Eastern day boundary. Confirmed live:
   Sean's `"4/2  Margaret Bruno  prep call for DISCO"` resolved to
   `2025-04-02` instead of `2026-04-02`; every other April row in the same
   preview correctly stayed in 2026, which is what exposed it. Fixed by
   requiring the "future" gap to exceed 2 days before rolling back a year —
   a real year mismatch is always ~365 days off, so this slack can never
   mask a genuine one. Commit `6f7f175`, with a regression test
   reproducing the exact scenario (`tests/run_tests.js`, 43 tests total, all
   passing). This bug lived in a function shared by both the repair tool
   AND live scoring going forward (`resolveRealCallDate_`), so it would have
   kept silently mis-dating future Sean/Joana/Tomás calls near that boundary
   if it hadn't been caught here.

3. **Both fixes deployed live** (`clasp push` run by Kris after `git pull`).

4. **`previewCallDateRepair()` re-run fresh post-deploy** — 153 rows, all
   correct (including the Margaret Bruno row, now `2026-04-02`).

5. **`repairCallDates()` run live** — same 153 rows, same output, sheet
   corrected. **This is done. Do not re-run it** — it's a one-time repair
   for legacy Match Method = `fallback_heuristic` rows; running it again on
   an already-corrected sheet should be a no-op (nothing left with a wrong
   date to find) but there's no need to re-verify unless a new symptom shows
   up.

6. **Sean's daily-practice transcription pipeline confirmed working live**:
   `260820 — Transcript` and `260821 — Transcript` both exist in Sean's
   Daily Practice folder (Whisper-transcribed, per the `transcribe_all.py`
   fix from earlier this session). `previewDailyPracticeGrading_()` graded
   both correctly — quoted feedback lead, one behavior to sharpen, score
   below the fold. Left to fire naturally via the `GRADING_HOUR: 20`
   trigger tonight rather than force-sending; not manually run live.

**Still open / carried forward, nothing new:**

- **`runAllLegacyBackfills_` temporary trigger** — still installed, still
  firing every 10 minutes. Watch for a firing that logs `scored 0` across
  Bens/Joana/Sean together (i.e. the backlog is fully drained), then run
  `removeLegacyBackfillTrigger()` to retire it. Not yet observed as of this
  session.
- Longer-tail backlog, not touched this session: `DASHBOARD_SESSION_SECRET`
  verification, Joana's stale "NOT YET READY" banner in her setup Google
  Doc, dashboard surfacing `outcome_disposition` in the UI.

---

# Handoff — 23/08/2026 (session 6 addendum — CRITICAL: Call Date bug, all three reps)

## -1. Read this first, even before section 0 below

**A second, unrelated critical bug found later the same session, while spot-
checking Joana's first-ever scored calls**: `scoreSeanTranscripts()`,
`scoreJoanaTranscripts()`, and `scoreTomasTranscripts()` all wrote **Call
Date as the TRANSCRIPT DOC's own creation date** (whenever the
Whisper/Gemini pipeline happened to transcribe it) instead of the real call
date. Confirmed live: Sean's own Prospect Names literally start with the
real date ("1/21 Anthony Camperi"), but the row showed a Call Date from
days/weeks later — the day of a bulk backlog transcription run. **This
silently corrupts every date-based feature**: weekly scorecard
week-bucketing, the rolling 4-week average added this session, the
dashboard's score-over-time chart — a whole backlog transcribed in one
sitting reads as "all happened this week." Bens is unaffected (his date
comes from the legacy filename directly).

**Fixed** (`f7830a0`): new `resolveRealCallDate_()` parses a real date out
of Sean's/Tomás's title convention ("M/D Name"), or falls back to the
paired original video's own upload date for Joana (whose titles have no
date at all) — never the transcript doc's creation date. Wired into all
three scoring functions.

~~**NOT yet run — needs Kris, from the Apps Script editor**~~ **UPDATE
(session 7, see top of file): done.** `repairCallDates()` ran live and
corrected 153 rows. See the session 7 section above for the full story,
including a second bug found and fixed in this repair before it ran.

---

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

**Update, same session**: `installAllReadyTriggers_()` was run (confirmed
live — Joana's new dedicated trigger installed cleanly alongside
everything else) and `previewLegacyBackfillDuplicates()` was run, reporting
306 duplicate rows (close enough to the ~302 estimate above — live data
shifts a little between reads, not a concern). **`dedupeLegacyBackfillDuplicates()`
itself has NOT been run yet** — that's the step that actually deletes them.

**Correction, same session**: first pass at automating daily-practice
transcription (`tools/deploy/setup_daily_practice_transcription.sh`) wired
up the Gemini-based `transcribe_daily_practice.py` as a new paid, separate
OVH timer — **wrong call**. Kris's standing policy: Whisper (free) is
always what runs unattended on OVH, never a per-call API charge. That
deploy script has been removed. Real fix: added
`tools/transcribe_daily_practice_whisper.py` (same reuse pattern as
`transcribe_joana_calls_whisper.py` — Drive plumbing from
`transcribe_sean_calls.py`, the whisper.cpp wrapper from
`transcribe_sean_calls_whisper.py`, folder config from
`transcribe_daily_practice.py`) and added it as a fourth batch in
`tools/transcribe_all.py`'s `BATCHES` list. **No new deploy step at all** —
this now runs automatically as part of the existing, already-live
`transcribe-all.timer` (every 6h), free, no API key. Nothing further needed
on the VPS beyond the usual `git pull`.

**Not done / needs Kris**:
- Deploy: `git pull` + `clasp push` (Apps Script side — already done per the
  Executions log above) and `git pull` on the OVH box (picks up the Daily
  Practice batch automatically, no other setup step).
- Run `dedupeLegacyBackfillDuplicates()` to actually delete the 306 duplicate
  Bens rows the preview identified — until this runs, every downstream
  number for Bens (dashboard averages, weekly scorecard, review queue) is
  skewed by the duplication.
- Check whether `installLegacyBackfillTrigger()` still has duplicate copies
  stacked live (Triggers page, clock icon) — the dedupe fix from earlier
  this session only prevents new stacking, doesn't clean up what's already
  there.
- **Separately, Sean's Daily Practice folder**
  (`1SJJ5Jek_4vEzmS907NQofDYq6bl-Mnr1`) has two practice uploads (260820,
  260821) sitting ungraded — will clear on `transcribe-all.timer`'s next
  6-hourly firing now that Daily Practice is in its batch list, or run
  `cd tools && .venv/bin/python transcribe_daily_practice_whisper.py` on the
  VPS for an immediate one-off run instead of waiting.

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
