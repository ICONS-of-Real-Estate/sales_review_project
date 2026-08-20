# Handoff — 20/08/2026

## 1. Current state — what's live vs. blocked

**Phases live (triggers installed or ready for the user to install):**
- Phase 1 (compliance check)
- Phase 2 (call scoring + Sean auto-scoring)
- Phase 3 (handoff briefs) — `HANDOFF_CONFIG.ENABLED = true`
- Phase 4 (inbox SLA) — `INBOX_SLA_CONFIG.ENABLED = true` (20/08/2026), scoped
  to **Sean and Bens only** — Joana deliberately excluded, she has hundreds
  of leads to work through and this nudge would just be noise on top of that
  backlog. User needs to run `installInboxSlaTrigger()` (`Phase4_InboxSLA.gs`)
  after `clasp push` if not already done.
- Phase 5 (weekly scorecard) — `WEEKLY_SCORECARD_CONFIG.ENABLED = true`
  (20/08/2026) after `previewWeeklyScorecards_()` ran clean. User needs to run
  `installWeeklyScorecardTrigger()` (`Phase5_WeeklyScorecard.gs`) if not
  already done. **Flag for a future session:** the preview showed Sean's
  all-time average as 1.0/5 across 103 scored calls — the lowest possible
  score on every call he's had scored. Worth sanity-checking a sample of his
  scored rows/reasoning before this has been running a few weeks, in case the
  Sean-specific stricter rubric is miscalibrated rather than that being real.
- Phase 6 (training call review) — `TRAINING_REVIEW_CONFIG.ENABLED = true`,
  including Tomás's Tuesday transcript-upload reminder
  (`TOMAS_TRANSCRIPT_REMINDER_CONFIG.ENABLED = true`, 20/08/2026) — user needs
  to run `installTomasTranscriptReminderTrigger()` if not already done.
- Phase 7 (daily self-practice) — `DAILY_PRACTICE_CONFIG.ENABLED = true`,
  covers both objection-handling and asking-for-the-money ("close ask")
  drills as of the split-schema rewrite (see §2).

**Deliberately not automated:**
- **Phase 0 (Riverside sync) — parked, not just blocked.** Riverside's API
  is Business-plan-only; the account is on Pro. Kris's call (20/08/2026):
  not upgrading for this — **Bens will manually download his own
  transcripts** instead, same as the existing "someone pastes a Drive link
  in by hand" fallback path. Don't re-raise this as an open blocker in a
  future session; it's a settled decision, not a TODO. Revisit only if the
  Riverside plan is ever upgraded for other reasons.

**Transcription pipelines (tools/, not Apps Script):**
- Sean and Tomás: Gemini/Qwen/Whisper variants all built; the three
  `*_whisper.py` scripts support running on multiple machines at once via a
  Drive-marker-file lock (6h stale-lock steal). Sean's backlog was still
  transcribing as of 19/08 (~70h estimate).
- Joana: `JOANA_FOLDERS` now points at her real Drive folder
  (`17YaE4fBjEBFissvR-l7_GOkoTnZjdQq5`, "Joana Peixe" — 9 QC/SC videos as of
  20/08). Code-ready; not yet run. Plan is to run it on Kris's OVH cloud VM
  once access is available (setup doc:
  https://docs.google.com/document/d/1MUhwFzSeDX9w0D2PN6ct4JCfSoGg1u2d_SrCnmijmfc/edit
  — still has a stale "NOT YET READY" banner at the top that should be
  deleted manually, the rest of the doc is accurate).

**Pending sign-off:**
- `FEW_SHOT_ANCHORS` in `Phase2_CallScoring.gs` — populated (20/08/2026) with
  3 real excerpts from `Objection_Handling_Playbook.md` (Carolyn Triebold:
  close-ask miss; Tennitia Wilson: objection surfaced-not-overcome; Ben
  Sweet: model resolution). Marked `TODO(Tomás)` in the code — these shape
  live grading prompts, so get his confirmation before treating as final.

## 2. Key architectural decisions

- **Apps Script hides trailing-underscore functions from the "Select
  function to run" dropdown.** Every `preview*_()`/`install*_()` function in
  this codebase uses a thin no-underscore wrapper for this reason (e.g.
  `previewWeeklyScorecards()` calling `previewWeeklyScorecards_()`). Apply
  the same pattern to any new human-run entry point.
- **GitHub and the live Apps Script project can silently drift.** Any
  `ENABLED` flag flipped directly in the browser editor (not in the local
  `.gs` file + git) gets reverted by the next `clasp push`. Deploy workflow
  is always: change config in the repo → commit → push → `git pull` +
  `clasp push` on whichever machine has `.clasp.json` (see `CLAUDE.md`).
  Never edit live in the browser.
- **"Asking for the money" is graded as its own skill, separate from
  objection handling.** Per Kris's exact methodology: Objection Handling =
  Agree, Isolate, Repeat; Asking For The Money = a direct line ("Ready to
  get started?"), ideally asked more than once, branching to another
  objection or straight to payment. A soft/open question never counts as a
  close. This runs through Phase 6 (`practiced_objections` /
  `practiced_close_ask` / `close_ask_drill`, persisted as
  `TRAINING_CLOSE_DRILL_<rep>`) and Phase 7 (`drill_type: "objection" |
  "close_ask"`, alternating assignment days once both types are on file).
- **Training-call folder structure**: `<Rep> Training Calls/<YYMMDD>/`
  containing Zoom's own auto-generated `.vtt` transcript + video/audio — no
  separate transcription step, unlike Sean/Joana's sales-call backlog.
  `stripVttMarkup_()` strips cue numbers/timestamps before judging.
- **Training-plan email routing:** goes to the rep being trained (primary
  recipient), always cc Tomás + Kris.
- **The daily-practice cycle is anchored to Tuesday's training call, NOT the
  calendar work-week:** Wed=Day1 … Tue=Day5, loops the following Wednesday.
  Weekends get no assignment. `computeTrainingCycleLabel_(date, tz)` in
  `Phase1_ComplianceCheck.gs` is deliberately **stateless** — computed from
  the date against a fixed epoch, no counter persisted anywhere.
- **This week's objections/close-ask drill persist across a skipped/late
  training week.** Phase 6 only *overwrites*
  `TRAINING_OBJECTIONS_<rep>`/`TRAINING_CLOSE_DRILL_<rep>` on a real
  non-empty result — a parse failure or a week with no training call must
  NOT wipe out last week's data.
- **Tomás's Tuesday reminder is a nudge, not a dependency.** Phase 6's daily
  scan already handles "training happened late/skipped" on its own; the
  reminder just reduces how often that happens.
- **`htmlBody` passed to `guardedSend_`/`MailApp.sendEmail` must contain raw
  HTML tags, not HTML-escaped text** (`<p>`, not `&lt;p&gt;`) — escaped tags
  render as literal text in Gmail. Has bitten a prior session already.
- **Cross-machine Drive lock** (the three `*_whisper.py` scripts): a
  `.lock-<video_id>` marker file dropped next to the target file in the same
  Drive folder, race resolution by earliest `(createdTime, id)`, stale-lock
  steal after 6 hours. Lets 2 laptops + a cloud VM share a work queue without
  a central server. Gemini/Qwen engine variants deliberately don't have this
  — don't run the same engine/person combo on two machines at once.

## 3. Open items for a future session

- Confirm `previewInboxSlaCheck_()`/`previewWeeklyScorecards_()` triggers
  actually got installed (steps above) — this session enabled the configs
  but couldn't run Apps Script itself to install the triggers.
- Sanity-check Sean's 1.0/5 all-time average (see §1) once a few more real
  weeks of Phase 5 data exist.
- Get Tomás's sign-off on the 3 `FEW_SHOT_ANCHORS` excerpts.
- Run Joana's Whisper transcription pipeline once OVH access is available.
- Delete the stale "NOT YET READY" banner at the top of Joana's setup doc
  (link above) — cosmetic only, doesn't block anything.
- Two now-fully-merged GitHub branches (`claude/repo-handoff-next-task-fzt3rq`,
  `claude/sales-review-dev-infra-wp3cto`) still exist on GitHub — delete
  manually via the repo's Branches page if desired (no API permission to do
  it from a session).
