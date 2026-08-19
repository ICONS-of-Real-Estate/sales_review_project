# Handoff — 19/08/2026

## 1. What was completed this session

**Deployed the whole project for real, for the first time.** Everything below
was previously just code sitting in GitHub — this session got it running in
the actual "Sales Review Project" Apps Script project
(`1qz0FO4M6Yzkyt5Em0qnIen8J03SP2m9Zc3JkcgPYJ-zxihwKwRFDqacX`, bound to the
Sales Call Log sheet), via `clasp`. `.clasp.json` (gitignored, local-only —
you'll need to recreate it locally: `{"scriptId":"1qz0FO4M6Yzkyt5Em0qnIen8J03SP2m9Zc3JkcgPYJ-zxihwKwRFDqacX","rootDir":"."}`)
and `appsscript.json` (committed) are the two files that make `clasp push`
work from this repo.

**Phases now actually live (triggers installed):**
- Phase 1 (compliance check), Phase 2 (call scoring + Sean auto-scoring)
- Phase 3 (handoff briefs) — `HANDOFF_CONFIG.ENABLED = true`
- Phase 6 (training call review) — `TRAINING_REVIEW_CONFIG.ENABLED = true`

**Still built but not yet enabled:**
- Phase 5 (weekly scorecard) — migration done, preview ran clean (no data
  yet, since Sean's real scoring pipeline only just went live)
- Phase 7 (daily self-practice) — not previewed yet, and its reminder
  function needs the rewrite described in "Next step" below
- Phase 4 (inbox SLA) — blocked on domain-wide delegation setup
- Phase 0 (Riverside sync) — blocked on a real API key

**Real production data started flowing:** `scoreSeanTranscripts()` and
`scoreNewlyLoggedCalls_()` triggers are live (every 4h), so the Sales Call
Log sheet will actually start getting real rows going forward. Everything
scored in-chat during this session (Kasondra McConnell, Charles Anthony
Clark, Alexis Ubeda, Chad Williams, David Crum, Jamie Reading, Brittany
McWilliams, and the whole earlier-session backlog) was a manual/simulated
stand-in for the automation while it wasn't live yet — none of it is in the
sheet. The real pipeline will re-score all of it fresh once it gets to
those transcripts; no action needed, just don't expect the sheet to match
the chat history 1:1.

**Bens' first real training-call cycle ran end-to-end:** Tomás's 8/18
session transcript (Zoom's own auto-`.vtt`) was reviewed, a coaching-plan
email was sent (Bens as primary recipient, Tomás + Kris cc'd — this was a
routing bug fix mid-session, was previously To:Tomás/cc:Kris), and a
"Training Plan" doc was written into the dated Drive folder.

**Daily practice assignment redesigned per Kris's feedback:** the original
long-prose training-plan email was replaced with a short, structured
"Week N, Day M" format — 2-3 specific named objections + a delivery-folder
link, no wall of text. The email-sending mechanics (`mcp__Gmail__send_message`)
were used directly once this session for Bens' resend; be careful with the
`htmlBody` field — HTML-*escaping* the tags (`&lt;p&gt;`) instead of leaving
them raw (`<p>`) causes Gmail to print literal tag text instead of
rendering — this bit us once already.

## 2. Key architectural decisions

- **Apps Script hides trailing-underscore functions from the "Select
  function to run" dropdown.** Every `preview*_()`/`install*_()` function in
  this codebase used that naming convention for "private" helpers, which
  meant NONE of them were selectable in the editor UI. Fixed by adding a
  thin no-underscore wrapper next to each one (e.g. `previewWeeklyScorecards()`
  calling `previewWeeklyScorecards_()`). Apply the same pattern to any new
  human-run entry point going forward.
- **GitHub and the live Apps Script project can silently drift.** Any
  `ENABLED` flag flipped directly in the browser editor (not in the local
  `.gs` file + git) gets reverted by the next `clasp push`. Habit going
  forward: change config in the repo, commit, push, `clasp push` — never
  edit live in the browser.
- **Training-call folder structure** (confirmed against Bens' real first
  session): `<Rep> Training Calls/<YYMMDD>/` containing Zoom's own
  auto-generated `.vtt` transcript + the video/audio — no separate
  transcription step needed for these, unlike Sean/Joana's sales-call
  backlog. `stripVttMarkup_()` strips cue numbers/timestamps before handing
  the transcript to the judge.
- **Training-plan email routing:** goes to the rep being trained (primary
  recipient), always cc Tomás + Kris. (Was backwards initially — fixed.)
- **The daily-practice cycle is anchored to Tuesday's training call, NOT the
  calendar work-week:** Wed=Day1, Thu=Day2, Fri=Day3, Mon=Day4, Tue=Day5,
  then loops to Week+1 Day1 the following Wednesday. Weekends get no
  assignment. Implemented as `computeTrainingCycleLabel_(date, tz)` in
  Phase1_ComplianceCheck.gs — deliberately **stateless**, computed purely
  from the date against a fixed epoch (`TRAINING_CYCLE_EPOCH_` = Wed
  19/08/2026 = Week 1 Day 1), so no counter needs to be persisted anywhere.
- **This week's objections persist across a skipped/late training week.**
  Phase 6 extracts 2-3 specific named objections per training call
  (`objections_to_drill: [{label, note}]`) and stores them in
  `PropertiesService` keyed `TRAINING_OBJECTIONS_<REP>`. Phase 7's daily
  assignment reads that key. Crucially, Phase 6 only *overwrites* it on a
  real non-empty result — a parse-failure fallback or a week with no
  training call must NOT wipe out last week's objections; per Kris, a
  skipped/late week just keeps running the previous assignment.
- **Tomás's Tuesday reminder is a nudge, not a dependency.** Phase 6's
  existing daily scan (checks every day, not just Tuesday) already handles
  "training happened late" or "got skipped" — the reminder just sits on top
  to reduce how often that happens, sent midday `Europe/Lisbon` time.

## 3. Exact next step to work on next

**Finish the Phase 7 daily-assignment rewrite** — this was interrupted
mid-edit by this handoff request. `Phase7_DailySelfPractice.gs`'s
`sendDailyPracticeReminders_()` (around line 247) currently only sends a
generic "you haven't uploaded yet" nudge. It needs to become the actual
daily assignment:

1. For each rep in `DAILY_PRACTICE_CONFIG.FOLDERS`, call
   `computeTrainingCycleLabel_(new Date(), CONFIG.BUSINESS_TIMEZONE)` — if
   it returns `null` (Saturday/Sunday), skip entirely, no email.
2. Read `PropertiesService.getScriptProperties().getProperty('TRAINING_OBJECTIONS_' + rep)`.
   If null (no training reviewed yet for this rep — e.g. Sean/Joana before
   their first Tuesday session lands), fall back to the existing generic
   reminder text.
3. If present, build subject `label.label + ' — Training Plan'` (e.g.
   "Week 1, Day 2 — Training Plan") and an HTML body matching the
   short format Kris asked for: "Record a video practicing objection
   handling:" + numbered list of the stored `{label, note}` objections (bold
   labels) + "Delivery folder:" + the rep's `DAILY_PRACTICE_CONFIG.FOLDERS[rep]`
   link. Match the corrected HTML from the Bens resend this session — raw
   tags in `htmlBody`, not escaped.
4. Send via `guardedSend_(repCfg.email, subject, plainBody, {htmlBody: ..., name: 'Daily Practice Reminder Bot'}, 1)`
   — decide whether this should still run at `REMINDER_HOUR` (currently
   16:00/4pm) or move earlier (e.g. 9am), since it's now a morning
   assignment rather than an end-of-day nag. Not yet confirmed with Kris —
   ask before changing `DAILY_PRACTICE_CONFIG.REMINDER_HOUR`.
5. Run `node tests/run_tests.js`, commit, push, tell the user to `git pull`
   + `clasp push`.

After that: Phase 7 still needs its own `previewDailyPracticeGrading()` run
and `ENABLED` flip (same pattern as every other phase), and Phase 5 needs
the same. Sean's transcript backlog is still transcribing (~70h estimate
given by Kris on 19/08); Joana's folder/pipeline hasn't been started yet
("then we will do Joana").
