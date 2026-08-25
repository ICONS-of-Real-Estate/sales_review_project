# Call Grading SOP — Phase 2 (AI Call Scoring)

> Companion to `brief.txt` (Technical Design Brief). That document is the architecture/rubric *design*; this document is the operational SOP — what actually happens to a call, in what order, and by what rule. If the two ever disagree, `brief.txt` is source of truth and this file should be updated to match.

## 1. Scope

Covers every **QC, Discovery, and Sales Call** logged in the Sales Call Log by Bens, Joana, or Sean. Does not cover the ICONS 100 podcast recordings (separate initiative, Section 4B) or the Guest Pipeline (Tech-Partner/Celebrity lane — explicitly out of scope per `brief.txt`).

A call is only eligible for grading once it has:
1. A logged **Outcome Disposition** in the tracker (Sold / Not Sold / Follow-up / No-show) — this is what Phase 1 compliance-checks for.
2. A matched Riverside transcript, keyed by **Calendar Event ID** (exact match) or flagged `fallback_heuristic` / `no_match` for manual confirmation. Calls with `no_match` do not get auto-scored — they route straight to manual review.

**Implemented as `Phase0_RiversideSync.gs`** (17/08/2026) — `brief.txt` §E fully specifies this (list recordings, extract the Calendar Event ID from the title, exact-key match against the sheet, download + save the transcript) but it had never been built; `scoreNewlyLoggedCalls_()` in `Phase2_CallScoring.gs` has always expected `Transcript URL` to already be populated, which until now only ever happened by someone pasting a Drive link in by hand. **Not yet live-tested against a real Riverside API key** — run `previewRiversideSync()` (read-only, no downloads or writes) first to validate the API contract and confirm recording titles actually carry the Calendar Event ID as expected, before trusting `syncRiversideTranscripts_()` to write anything. Not wired to a trigger yet, same confirm-before-automating gate as `buildReviewQueue()`.

## 2. The two-pass evaluation

Grading is **not** one blended score. It's two sequential, distinct judgment calls, mirroring the brief's split-evaluator requirement:

**Pass 1 — Lead Quality Verdict.** Should this call have been booked at all?
- `good_to_book` or `should_screen_out`
- If `should_screen_out`, Pass 2 does not run — a bad lead doesn't get penalized for a rep's close technique on a call that shouldn't have happened.

**Pass 2 — Call Quality Score (1–5) + two failure-mode flags.** Only runs if Pass 1 passed.

## 3. The rubric — two failure modes plus one universal explanation-quality flag

Kris's own framing of what goes wrong on a call reduces to two failure modes. Everything else (SPIN, Challenger, MEDDIC) is reasoning scaffolding for *why* a failure happened — not additional scored fields. Resist the urge to add more scored dimensions; the brief is explicit that this keeps the model stable under forced temperature=1. **§3D below (25/08/2026) is the one deliberate exception** — a third, independently-tracked dimension Kris explicitly asked for, not an accretion. It does not touch `call_quality_score`'s anchors.

### Failure mode 1 — Never asked for the close
- **Decision rule (not an adjective):** did the rep make an explicit request for commitment — an Order or Advance in SPIN's taxonomy ("Shall we move forward with this?"), not merely a trial close (asking for an opinion, "How does that sound?")?
- A trial-close-only call scores as a fail on this flag, even if the conversation otherwise went well.
- Grounding: SPIN Selling's Order/Advance/Continuation/No-sale taxonomy; Challenger's "Take Control" (comfort discussing money, pressing for commitment).

### Failure mode 2 — Objections not uncovered or not overcome
- **Decision rule:** did the rep proactively surface objections (value: "too expensive" / capability: "not sure it does X") rather than let them go unspoken, and when raised, were they addressed with something concrete (case study, reference, quantified value) rather than brushed past?
- Grounding: SPIN's "objection prevention beats objection handling"; MEDDIC's Identify Pain / Metrics / Champion as the underlying gaps that produce a missed objection.
- See `Objection_Handling_Playbook.md` for the actual objection types this has surfaced so far, real examples, and suggested handling technique per type — maintained as a living list and updated whenever a new call batch surfaces an objection not already in it.

**Two scored booleans result:** `asked_for_close`, `objections_uncovered` + `objections_overcome`. `primary_failure_mode` derives from these (`none / no_close_ask / objections_missed / both`) — it's not separately judged.

### 3B. Sean-specific variant — a deliberately stricter rubric

Kris/Thao's explicit ask (17/08/2026): the shared two-failure-mode rubric above doesn't fit Sean's funnel cleanly enough to catch what actually matters on his calls. Sean's calls end one of two acceptable ways — he closes the money directly, or he books a second call with Tomás to close — and a call that does neither, with no clear evidenced reason, is the specific miss worth catching. This is a **separate rubric variant for Sean only** (`buildSeanJudgeSystemPrompt_()` / `scoreSeanTranscripts()` in `Phase2_CallScoring.gs`), not a change to the shared rubric above — Joana keeps the original two-failure-mode design per this doc's own "resist adding scored dimensions" guidance in Section 3. Bens has his own separate variant too — see Section 3C.

Six questions the model must answer, in order, before scoring:
1. Were objections uncovered *and* overcome with something concrete?
2. Did the rep explicitly ask for the money (not just a trial-close question)?
3. If no sale closed, was a second call with Tomás actually booked? If not, why not?
4. Did the rep do real discovery — do they demonstrably understand this lead's specific business?
5. Did the rep capture the lead's actual goals and tie the podcast framework back to them specifically (not a generic pitch)?
6. Bottom line: if nothing closed, what's the single root cause — stated causally, not vaguely?

Extra scored fields beyond the shared schema: `discovery_adequate`, `understood_leads_business`, `captured_leads_goals`, `tied_framework_to_goals`, `booked_second_call_with_tomas`, and a free-text `root_cause_if_no_sale`. The "Sales Call Log" sheet has no dedicated columns for these yet, so `scoreSeanTranscripts()` packs them into the existing `AI Feedback Summary` column alongside the standard coaching summary rather than requiring a sheet migration — revisit this if the extra fields turn out to need their own columns for filtering/reporting.

See `Objection_Handling_Playbook_Sean.md` for the actual objection types Sean's calls have surfaced so far, real examples, and suggested handling technique per type — a separate living list from `Objection_Handling_Playbook.md` (Bens), same reasoning as the separate rubric above. v1 built from the first batch of 12 real Sean transcripts (17/08/2026); update it whenever a new call batch surfaces an objection not already in it.

Transcript source for Sean's backfill: `tools/transcribe_sean_calls.py` (Gemini-based, since Sean records on Zoom, not Riverside) writes each transcript as a `"<video title> — Transcript"` Doc directly next to its source video in `PHASE2_CONFIG.SEAN_FOLDERS` — there's no separate transcripts-only folder like Bens' setup, and no Calendar-Event-ID-in-title convention, so every row is forced `Match Method = fallback_heuristic` and `Manual Review Recommended = TRUE`, same policy as the Bens legacy backfill.

A second, cheaper transcription option exists: `tools/transcribe_sean_calls_qwen.py`, using Alibaba's Qwen3-ASR-Flash (~$0.002/min vs. Gemini's much higher effective per-file cost) instead of Gemini. It reuses all of `transcribe_sean_calls.py`'s Drive plumbing and writes to the same `"<video title> — Transcript"` naming, so the two are interchangeable from the scoring side — but the underlying `qwen3-asr-toolkit` doesn't do speaker diarization (no `Rep:`/`Prospect:` labels), unlike Gemini's video-understanding approach. Manually reviewing 12 real Gemini transcripts (17/08/2026) showed speaker roles are reliably inferable from context alone even without labels, which is the working assumption behind using Qwen — but confirm that holds on a real Qwen transcript (`tools/test_single_transcription_qwen.py`) before running it at scale. The Gemini version is kept as-is and works standalone; treat it as the fallback if Qwen's output quality or the missing labels turn out to be a problem.

### 3C. Bens-specific variant — he is not a closer

Kris's explicit correction (22/08/2026, caught live from the dashboard's "Asked for close" numbers looking implausibly high for him): Bens does not sell. He runs the ICONS 100 lead-generation podcast — interviewing a guest, then booking a QC or Sales Call for someone else on the team to run — and he also runs QCs himself, booking a Sales Call for someone else from those. He never takes a sales call or asks for money. Scoring him against the shared rubric's "asked for close" flag was measuring a money-ask he was never supposed to make in the first place.

This is a **separate rubric variant for Bens only** (`buildBensJudgeSystemPrompt_()` / `scoreBensTranscript_()` in `Phase2_CallScoring.gs`, wired in via `scoreBensLegacyTranscripts()` passing it as an override to `scoreLegacyTranscriptFolder()`), not a change to the shared rubric — Joana and Sean are unaffected.

Deliberately reuses the shared schema's field *names* (`asked_for_close`, `objections_uncovered`, `objections_overcome`) so the "Sales Call Log" sheet's existing columns, the dashboard, and Phase 5's weekly-scorecard failure-mode tally all keep working unchanged — only what `asked_for_close` *means* is redefined for him: did he explicitly ask to book the next concrete step (a QC or Sales Call, with a specific date/time), not whether he asked for money.

Six questions the model must answer, in order, before scoring:
1. Were objections/hesitations about booking the next step uncovered *and* addressed with something concrete?
2. Did Bens explicitly ask to book a QC or Sales Call, with a specific date/time — not left open-ended?
3. Did that next step actually get booked? If not, why not?
4. Did Bens do real discovery — do they demonstrably understand this person's business/situation?
5. For an ICONS 100 interview specifically: was the interview itself genuinely good content (not applicable, scored true, for a QC)?
6. Bottom line: if no next step was booked, what's the single root cause — stated causally, not vaguely?

Extra scored fields beyond the shared schema: `call_role` (`icons_100_interview | qc | unclear`), `booked_next_step`, `next_step_type` (`QC | Sales Call | none`), `discovery_adequate`, `understood_leads_business`, `interview_content_quality_good`, and a free-text `root_cause_if_no_booking`. Same as Sean's variant, these get packed into the existing `AI Feedback Summary` column (`buildBensFeedbackSummary_()`) rather than requiring a sheet migration.

**Rows already scored under the old shared rubric before this change are not automatically re-scored** — `scoreLegacyTranscriptFolder()`'s existing-row skip (keyed on prospect name + date) means a call already in the sheet stays exactly as it was scored, under whichever rubric was live at the time. If those older rows need re-scoring under the correct rubric, delete them from the sheet first, then re-run `scoreBensLegacyTranscripts()`.

### 3D. Framework explanation — a third, universal dimension (25/08/2026)

Kris's pushback (25/08/2026) on the two-failure-mode design above: on every real sales call, the rep is also explaining our actual value proposition — the "framework" — and until now nothing scored that, and nothing fed a gap in it into a rep's weekly scorecard priority or the following week's training/practice assignment. Tomás's own ask, verbatim: reps should be able to explain (1) how the podcast helps recruit agents, (2) how it can make them the #1 real estate podcast in their city, and (3) how it helps sell more houses.

**The grounding, and why this isn't scope creep on top of §3's "resist adding dimensions" rule**: Kris's own framing is that explaining the framework properly *handles objections before they arise* — which is the exact same "objection prevention beats objection handling" principle already cited for Failure mode 2 above (SPIN Selling), just applied one step earlier in the call. A lead who never understood the offer is the lead who raises "so what does this actually do for me"-shaped objections. This is not a new, unrelated dimension bolted onto the rubric — it's upstream of Failure mode 2, made explicit and trackable because a missed explanation was invisible until now.

**Decision rule:** did the rep proactively and accurately explain all three components — recruit agents, #1-podcast-in-your-city authority, sell more houses — across the whole call? Graded generously for substance (did they convey the idea, in their own words) over reciting exact marketing language. Each of the three is scored independently; a strong explanation of one does not paper over silence on another.

**Universal, not variant-specific**: applies to the shared rubric, and to Sean's, Bens', and Tomás's variants alike — every rep, real sales calls only (this is not part of Phase 6's training-call rubric or Phase 7's daily-practice rubric, though both of those were extended separately to drill it — see their own headers). Deliberately does **not** change `call_quality_score`'s existing anchors (still close-ask/objection-handling only) — this stays an independent tracked flag, same relationship the two original failure modes already have to each other, extended to three.

**Scored fields**, added to every variant's schema: a `framework` object with three booleans (`recruit_agents_explained`, `number_one_podcast_explained`, `sell_more_houses_explained`). Derived in Apps Script (`deriveFrameworkFields_()` in `Phase2_CallScoring.gs`, shared across all variants) into two real sheet columns — `Flag: Framework Explained` (true only if all three) and `Framework Gaps` (comma-joined labels of whichever were missing, blank if none) — not packed into free text like the Sean/Bens/Tomás extra fields, since this is meant to be a first-class, permanently tracked skill like the original two, not a one-off enrichment. `primary_failure_mode` gained a new possible value, `framework_not_explained`, used when this is the sole failure among the tracked flags (`multiple` covers it combining with a close-ask or objection-handling miss, same as it already does for two).

**Closing the loop Kris asked about** ("will we pick it up for the next training plan and their week of practicing?"): yes, end to end —
- Phase 5's weekly scorecard picks up `framework_not_explained` in its existing `Primary Failure Mode` priority-to-improve logic, no separate wiring needed (`FAILURE_MODE_COACHING_TEXT_` in `Phase5_WeeklyScorecard.gs` just gained a new key).
- Phase 6 (Tomás's weekly 1:1 training-call review) now also extracts whether framework explanation was practiced live and which of the three components need drilling (`practiced_framework`, `framework_gaps_to_drill`), persisted the same way `TRAINING_OBJECTIONS_<rep>`/`TRAINING_CLOSE_DRILL_<rep>` already are.
- Phase 7's daily self-practice `drill_type` gained a third value, `framework`, in rotation alongside `objection`/`close_ask`, graded against the same three-part rubric.

**Migration**: two new trailing columns on the live "Sales Call Log" sheet — re-run `migrateAddPrimaryFailureModeColumn()` (despite the name, it's the general "catch the sheet up to `SALES_CALL_LOG_HEADERS`" migration, safe to re-run) after deploying this. Rows scored before this change read both new columns as blank ("no signal"), same backward-compatible pattern as every prior column addition in this file.

### 3E. Rubric Version — recording which rubric produced a given score (25/08/2026)

The rubric has changed twice in two days (Section 3B's Sean variant, then Section 3D's framework dimension) — and until now nothing recorded which rubric version actually produced a given row's score. That makes historical rows silently non-comparable to new ones: a `call_quality_score` of 3 from before the framework dimension existed and a 3 from after it are not necessarily measuring the same thing, and nothing in the sheet said so.

**What it is**: `RUBRIC_VERSION` (`Phase2_CallScoring.gs`) is a single string constant, written into a new trailing `Rubric Version` column (`SALES_CALL_LOG_HEADERS`, `Phase1_ComplianceCheck.gs`) by every code path that writes a score — `writeScoreToRow_()` (the ongoing pipeline) and all four `appendRow`-based backfill functions (Bens/legacy, Sean, Joana, Tomás).

**Versioning convention — a standing project rule, not a one-off**: `RUBRIC_VERSION`'s value is `'YYYY-MM-DD-shortlabel'` — the date a rubric change landed, plus a few words naming it (current value: `'2026-08-25-framework'`, for the Section 3D addition). **Bump this string every time any rubric variant's scoring logic changes** — a new or changed failure mode, a new scored dimension, a changed score anchor, or a new/altered per-rep variant — regardless of which variant (shared or Sean/Bens/Tomás) actually changed, since they all currently move together version-wise. Do this in the same commit as the rubric change itself, the same discipline as updating both this SOP and the prompt-building code together per Section 1's file-header note.

**Migration and backward compatibility**: one more trailing column — re-run `migrateAddPrimaryFailureModeColumn()` (Phase2_CallScoring.gs; despite its name, the general "catch the sheet up to `SALES_CALL_LOG_HEADERS`" migration) after deploying this. Existing rows read `Rubric Version` as blank ("no signal") and are **not** retroactively backfilled — there's no reliable way to know after the fact which rubric version actually scored an old row, so blank honestly means "unknown," not "the current version."

## 4. Scoring scale — anchored, not impressionistic

`call_quality_score` is 1–5. Each level must be anchored to observable transcript evidence, not adjectives like "good/adequate":

| Score | Anchor |
|---|---|
| 5 | Explicit close asked (Order/Advance) AND objections surfaced+resolved with concrete proof |
| 4 | Close asked, minor objection-handling gap (surfaced but weakly resolved) |
| 3 | One of the two failure modes present; the other executed well |
| 2 | Both failure modes present, but lead was otherwise good-to-book |
| 1 | Both failure modes present AND lead quality was borderline |

(Severity, a separate 1–5 field used only for queue prioritization, is not the same as this quality score — see Section 6.)

## 5. Output contract (JSON schema)

This is the exact schema the Kimi k2.6 call must return — reasoning first, structured fields last (chain-of-thought ordering reduces judge variance per Zheng et al. 2023):

```json
{
  "reasoning": "string — evidence quoted from transcript, per criterion",
  "lead_quality": {
    "verdict": "good_to_book | should_screen_out",
    "justification": "string"
  },
  "call_quality_score": 1,
  "flags": {
    "asked_for_close": true,
    "objections_uncovered": true,
    "objections_overcome": true
  },
  "framework": {
    "recruit_agents_explained": true,
    "number_one_podcast_explained": true,
    "sell_more_houses_explained": true
  },
  "primary_failure_mode": "none | no_close_ask | objections_missed | framework_not_explained | multiple",
  "manual_review_recommended": true,
  "severity": 1,
  "feedback_summary": "string — 2-3 sentences, coaching-ready"
}
```

No fields beyond these (`framework`, added §3D 25/08/2026, is the one deliberate exception — see that section for why it doesn't count as scope creep). Booleans + 1–5 severity resist drift under kimi-k2.6's forced temperature=1 in a way 0–100 scores would not.

**Parsing rule:** strip leading/trailing ` ```json ` fences via regex before `JSON.parse()`. On parse failure, retry once with an explicit "return ONLY raw JSON" reminder. On a second failure, log the raw response and route to manual review — never silently drop a row.

## 6. Prioritization (who Kris actually reviews)

Kris reviews 3 calls/day, clustered by rep (concentrated feedback beats scattered feedback):
1. Group unreviewed flagged calls by rep.
2. Cluster score = (flagged-call count, capped at 3) blended with that rep's max/sum `severity`.
3. Pick the rep whose cluster best fills a 3-call sitting with highest aggregate severity.
4. Tie-breaks in order: higher single-call severity → older queue age (anti-starvation) → both failure-mode flags true beats one → alphabetical by rep.
5. Rollover: unreviewed calls stay queued, `age_in_queue` increments; an age threshold (e.g. 3 days) escalates priority so no rep's backlog starves behind a chronically higher-severity rep.

**Implemented as `buildReviewQueue()` in `Phase2_CallScoring.gs`** (17/08/2026) — this section fully specified the algorithm but, like the ongoing-scoring triggers, it had never actually been built. Two things in the spec above were genuinely ambiguous and needed a concrete choice to write runnable code — confirm both before trusting this to drive real review assignments:
- **Cluster score weighting:** "capped-at-3 count blended with max/sum severity" doesn't give exact weights. Implemented as `cappedCount × 1000 + sum of the top-3 severities`, so whether a rep's sitting can be filled to 3 dominates, and aggregate severity only breaks ties within the same count band.
- **Per-call ordering within a rep's own cluster:** not specified at all. Implemented using the same signal order as the rep-level tie-breaks (severity → queue age → both-failure-modes) for internal consistency, rather than inventing a separate rule.

Currently manual (run from the Apps Script editor); not yet wired to a daily trigger pending that confirmation.

**Digest email — implemented as `sendReviewQueueDigest_()`** (17/08/2026), closing a gap `buildReviewQueue()` itself left open: it computed and logged the daily pick but never actually told Kris anything outside the Apps Script execution log. This is `brief.txt` §D's "3-per-day clustered review email" plus the "hard cap ... triggers a digest to Kris" it also names (implemented as a 7-day `QUEUE_AGE_HARD_CAP_DAYS`, stricter than the 3-day escalation-watch log line above). Gated by `PHASE2_CONFIG.SHADOW_MODE` — during shadow mode it logs instead of sending, same rule as every other Kris-facing send in this file; flipping `SHADOW_MODE` to `false` after the 80%-agreement gate (Section 7) clears is what turns this email on, matching `brief.txt`'s own Phase 3 rollout recommendation ("turn on the 3-per-day clustered review email").

## 7. Rollout gates (do not skip)

| Phase | Gate to advance |
|---|---|
| Shadow mode (~2 weeks) | Score calls, do **not** email Kris. Hand-check model verdicts against Kris's own judgment. |
| Go live | ≥80% agreement with Kris on `manual_review_recommended` (this is a benchmark to hit on *this* data — the 80% figure from Zheng et al. 2023 is a general finding, not a guarantee here). |
| Weekly calibration | Diff model verdicts vs. Kris's actual review outcomes every week; track agreement (percent agreement / Cohen's kappa); feed disagreements back into rubric-prompt tweaks, mirroring the existing `learning_loop.gs` pattern. |

**Implemented as `runWeeklyCalibration()` in `Phase2_CallScoring.gs`** (17/08/2026) — `learning_loop.gs`, referenced above and in `brief.txt`, could not be located anywhere in this repo, so this is a fresh implementation of the same requirement rather than a port of an existing pattern. Real agreement/kappa needs Kris's own independent verdict in the same category as the AI's `manual_review_recommended`, not just an agree/disagree checkbox (which would only support percent-agreement, not the confusion matrix kappa requires) — added one new column, **`Kris Manual Review Verdict`** (Yes/No dropdown, blank = not yet judged), which she fills in per call she's reviewed. Additive to `SALES_CALL_LOG_HEADERS`, appended at the end so it doesn't shift any existing column and existing `appendRow` calls that don't set it just leave it correctly blank. Not yet wired to a trigger — needs a real week of judged rows first, and Kris/Tomás sign-off that a manual dropdown is the right capture mechanism before this runs unattended.

## 7B. Frozen regression set — drift detection (25/08/2026)

Section 7's calibration loop checks whether the model agrees with Kris — it has nothing to say about whether the model agrees with *itself* over time. The judge (Kimi k3, forced `TEMPERATURE: 1`) could silently drift in behavior — a Moonshot-side model update, a subtle prompt-sensitivity issue — with nothing catching it: every existing safeguard in `Phase2_CallScoring.gs` (schema validation, parse retries, manual-review routing) catches a badly-*formed* response, none of them catch a well-formed response that quietly started judging differently than it used to.

**The mechanism**: freeze a small fixed set of already-scored real calls as a "known-good" baseline, then periodically re-run the exact same transcripts through the exact same rubric and diff the fresh result against the frozen one.

- **`freezeRegressionSet_()`** (wrapper: `freezeRegressionSet()`) picks up to `REGRESSION_DRIFT_CONFIG.SAMPLE_SIZE` (12; the recommended range is 10-15) already-scored calls, spread across reps/rubric variants (`pickStratifiedRegressionSample_`, so the baseline can't land entirely on one rep's calls), and stores `call_quality_score`, the boolean flags, and `primary_failure_mode` — plus which rubric variant and `Rubric Version` (Section 3E) actually produced that score — in a new **`Regression Baseline`** sheet tab. Re-running it *replaces* the stored baseline outright; it's a snapshot, not an append-only log.
- **Storage choice — a sheet tab, not a Script Property**: the codebase has two established durable-storage patterns (Script Properties, e.g. `TRAINING_OBJECTIONS_<rep>` in `Phase6_TrainingCallReview.gs`; or a dedicated sheet tab with a self-healing header row, e.g. `getOrCreateTrainingAssignmentsSheet_()`, also in `Phase6_TrainingCallReview.gs`, added 25/08/2026). This uses the sheet-tab pattern: the baseline is ~10-15 rows of genuinely tabular per-call data that Kris/Tomás need to eyeball directly, and a sheet tab is inspectable by anyone who can open the spreadsheet, where a Script Property is only readable from inside the Apps Script editor or by code.
- **`checkRegressionDrift_()`** (preview wrapper: `previewRegressionDrift()`; trigger target: `checkRegressionDrift()`) re-fetches each frozen call's transcript and re-scores it via `scoreTranscriptByVariant_()`, dispatching to whichever rubric variant (`shared`/`sean`/`bens`/`tomas`) actually produced the frozen score — not just whatever the rep's name might suggest, since the ongoing pipeline always scores `exact_key` rows under the shared rubric regardless of rep (see `resolveRubricVariantForRow_()`'s own comment). `diffRegressionResult_()` then flags a row where `call_quality_score` differs by more than 1, any boolean flag flipped, or `primary_failure_mode` changed. This is **strictly read-only against real data**: it never rewrites the frozen baseline (only `freezeRegressionSet_()` does that) and never touches the live "Sales Call Log" — a drift check must never corrupt real scoring history.

**Rollout gate, same pattern as every other phase in this file**: ships **disabled** (`REGRESSION_DRIFT_CONFIG.ENABLED = false`). `previewRegressionDrift()` always works regardless (read-only by construction) and only logs; `checkRegressionDrift()` refuses to run at all while `ENABLED` is false. **Not wired to a trigger yet** — that's a separate go-live decision for a human to make later, same as `RANDOM_CALIBRATION_CONFIG` before it shipped this session (Section "Random calibration holdout" in `Phase2_CallScoring.gs`). Setup: run `freezeRegressionSet()` once, then `previewRegressionDrift()` and eyeball the output against real transcripts, then flip `ENABLED` (a live, non-preview run additionally sends an ops alert via `sendOpsAlert_()` if drift is found, same escalation Section 7's 80%-agreement gate uses) before ever wiring a trigger to `checkRegressionDrift()`.

## 8. Known failure modes to design around (carried over from `brief.txt`)

- kimi-k2.6 **must** run at temperature=1 — any other value fails every call silently while the run reports "complete."
- Expect markdown-fenced JSON even at temperature=1 — defensive parsing is not optional.
- A call with `Match Method = no_match` never gets auto-scored, full stop — it's a matching failure, not a call-quality signal.

## 8b. Warm-handoff briefing between funnel stages

Kris's ask (17/08/2026): when a lead moves from one funnel stage to the next rep (e.g. Bens takes an ICONS 100 recording call, books a QC, and joins that QC to hand the lead to Joana), the incoming rep should get real context before the call, not just an introduction — who the lead is, their stated issues/goals, how podcasting was pitched (or should be) to address them, which objections from the prior call are still unresolved, and anything else worth knowing.

**Implemented as `Phase3_HandoffBrief.gs`** (17/08/2026). Matches an upcoming QC/Sales Call/Discovery calendar event (reusing Phase 1's event classification and prospect-name guessing) to the most recent *scored* `Sales Call Log` row for the same prospect — no assumption about funnel stage order is encoded, just "the last thing we know about this lead." The brief itself is synthesized fresh from that prior call's transcript via a dedicated prompt (a distinct judgment task from the scoring rubrics — not a call-quality verdict, just an extraction of what the next rep needs to know), not from the terse `AI Feedback Summary` column. Sent ~24 hours ahead of the next call, deduped via a new `Handoff Briefs Sent` tracking tab (the upcoming call has no `Sales Call Log` row of its own yet to mark against).

**Not yet live-verified end-to-end** (no real upcoming event existed to test against at the time this was written) — `previewUpcomingHandoffBriefs_()` does the full match and logs what it would send without calling the model or sending anything; run that first. Gated by `HANDOFF_CONFIG.ENABLED`, a separate flag from `PHASE2_CONFIG.SHADOW_MODE` since this is a different kind of LLM output (an extraction/summary, not a scored verdict) that Kris/Tomás haven't reviewed yet — flip it once a handful of generated briefs check out against the real prior transcript.

## 9. What this SOP deliberately does not cover

- Few-shot anchor examples (2–3 labeled transcript excerpts: a clear close-ask, a clear miss, a borderline case) — these need to come from real graded calls, not be invented. The first batch of 43 real transcripts has now been scored (17/08/2026) and its objection patterns are cataloged in `Objection_Handling_Playbook.md`; that's the source to pull `FEW_SHOT_ANCHORS` from in `Phase2_CallScoring.gs` once Kris/Tomás confirm which examples are representative.
- The actual Apps Script implementation (`brief.txt`'s explicit scope note: architecture/rubric only, no implementation code here either).
- Podcast-recording grading (Section 4B, separate initiative).

---
*First pass — for Kris/Tomás review and edit before this becomes the literal prompt text.*
