# Discovery Playbook — What To Train, And Why It's Been Blank

> Companion to `Phase2_CallGradingSOP.md` and the discovery rubric in `Phase2_CallScoring.gs` (`discoveryRubricPrompt_`/`DISCOVERY_GAP_LABELS_`). Tomás approves changes here before they're used in training, same as the objection-handling playbooks.

## Read this part first — why there's no "real examples" list yet

Every other playbook in this repo (`Objection_Handling_Playbook*.md`) was built by pulling real flagged calls out of the scoring pipeline. Discovery can't be built that way yet, and Kris should know why before reading the rest of this doc as if it were the finished article:

**The discovery rubric only shipped 03/09/2026.** Rows scored before that date carry a *blank* discovery flag — not a pass, not a failure, just never graded (this is the same "no signal ≠ false" rule `trainingElementFlagsForRow_` in `Phase1_ComplianceCheck.gs` enforces everywhere else in this system). Run live 08/09/2026 via `previewTrainingElementCoverage()`:

| Rep | Calls last week | Discovery graded |
|---|---|---|
| Joana | 4 | **0 of 4** — every call scored under the old `pitch-delivery` rubric, before discovery existed |
| Sean | 5 | 4 of 5 — 1 call under the old rubric, 4 under `discovery-sop-rubric`/`2026-09-03-discovery` |
| Bens | 1 | 0 of 1 — not scored at all yet (`rubric=(none)`) |

That's the actual root cause of "Joana's training keeps coming back empty on discovery" — not a bug in who picks the topic, but a straightforward backlog: her calls simply predate the rubric that grades this dimension. **`rescoreLastWeekCalls()`/`rescoreAllCalls_()` (`Phase2_CallScoring.gs`) is the fix** — it only re-scores rows whose `Rubric Version` is behind the current one, so running it (scoped to last week, or a full backfill for history) is what turns Joana's `0 of 4` into real, gradeable data. Until that's run at least once against her calls, any "Joana's real discovery patterns" section below would have to be invented, not extracted — so it isn't here.

The one real discovery failure on the books so far:

**Frank Pirrone (Sean, Sales Call, 05/09/2026, score 1)** — `discovery_adequate: false`. I could not pull the full transcript or `AI Feedback Summary` text for this row from here to quote it directly (same caution the Joana v1 playbook itself flags about not trusting an unverified paraphrase), so this is a pointer, not a coaching case yet: pull the transcript/sheet row before using it in a session. Once `rescoreLastWeekCalls()` has run and a few weeks of real discovery-graded calls exist for Joana and Sean both, this doc should get its own "Real examples" section built the exact same way the objection playbooks were — by prospect name and date, citing the actual AI Feedback Summary.

---

## What the rubric actually grades

Three separate things, each scored independently (`discoveryRubricPrompt_`, `Phase2_CallScoring.gs`) — a call can pass one and fail another, and Tomás should train whichever one is actually failing, not "discovery" as one undifferentiated blob:

1. **`discovery_adequate` — did the rep ask real questions before pitching?** Open questions that got the lead talking about their own business count. Rhetorical set-ups for the pitch ("You're looking to grow your business, right?") do not. This is the most common failure shape and the one to drill first.
2. **`understood_leads_business` — by the end of the call, had the rep actually grasped what this lead does?** Judged on evidence in the transcript — referring back to specifics the lead gave — not on whether the rep asked the right question. A rep can ask great questions and still never demonstrate they absorbed the answers.
3. **`confirmed_prior_discovery` — on a Sales Call that follows an earlier QC, did the rep CONFIRM what that call already surfaced and go DEEPER where it was thin?** Two distinct failures collapse into this one flag: re-asking everything cold as if the QC never happened (wastes the lead's patience and signals disorganization), and the opposite — assuming the QC covered it and never checking (misses whatever the lead's situation changed since). Only scored when there's a real prior call to confirm against; first-contact QCs are graded TRUE automatically since there's nothing to confirm.

`Discovery Gaps` (the free-text column next to the flag) names which of the three actually failed on a given call — that's the same per-call detail the "Missing: ..." line in the weekly playbook email now surfaces (fixed 08/09/2026, `playbookFocusGapsForCall_` in `Phase1_ComplianceCheck.gs`), once a call has actually been graded on it.

## Generic technique library (starter set — replace with real examples as they accumulate)

These are not extracted from real ICONS calls the way the objection-handling entries are; they're standard discovery-coaching technique, included so Tomás has something concrete to run a session on before real per-rep data exists. Treat this section as a draft to correct, not a finished playbook — the same status Joana's v1 objection playbook had before Tomás reviewed it.

### 1. Trades pitching for pitching too early
**Symptom:** the rep opens with the offer/package before asking anything about the lead's actual situation — `discovery_adequate: false`.
**Technique:** the first three questions of every call should be about the lead, not the product — current volume, biggest current bottleneck, what's already been tried. Nothing about the offer gets said until at least one of those has a real answer on the table.
**Drill:** role-play the first 90 seconds of a call twice — once starting with the pitch (the failure mode), once starting with "walk me through what a typical week looks like for you right now" (the fix). Compare how much real information the lead volunteers in each version.

### 2. Asks the question but doesn't absorb the answer
**Symptom:** discovery questions get asked, but nothing the lead said comes back up later in the call — `understood_leads_business: false` even though `discovery_adequate` may pass.
**Technique:** after any discovery answer, the rep should reflect one specific detail back before moving on ("30 transactions a year, mostly referral — got it") rather than acknowledging generically and moving to the next question. That reflection is also the thing that later ties the offer to something the lead actually said, instead of a generic pitch.
**Drill:** listen back to (or role-play) a discovery block, then have the rep summarize the lead's business from memory with zero notes. Anything they can't summarize is a sign the question was asked but not really listened to.

### 3. Re-does the QC's discovery from scratch on the Sales Call
**Symptom:** on a second call, the rep asks the same opening questions as if the QC never happened — `confirmed_prior_discovery: false`.
**Technique:** open a second call by referencing the specific thing the QC surfaced ("last time you mentioned X — still the case?"), then go one layer deeper on whatever was thin, rather than re-running the full discovery script cold.
**Drill:** hand the rep a one-paragraph fake QC summary and have them open a mock second call confirming + deepening it in under 30 seconds, instead of re-asking it as new information.

---

## Suggested practice format (for the Kris/Tomás session)

1. Run `previewTrainingElementCoverage()` (or check the dashboard) first, every time — confirm there's actually graded discovery data for this rep this week before building a session around it. A `0 of N` for discovery means "not graded," not "passed."
2. Once real data exists: read one real prospect line from a failed call (not the fix) and have the rep respond live, cold — same drill format the objection playbooks use.
3. Until then: use the generic drills above, but say so explicitly in the session — this is technique practice, not yet a "here's exactly what went wrong on your calls" review.

---

v1 — draft, built 08/09/2026 from the rubric definition and the one real discovery-failure row on file (Frank Pirrone, pointer only, no verified quote). For Tomás's review before use. Once `rescoreLastWeekCalls()` has backfilled Joana's and Sean's discovery grades across a few real weeks, replace the generic technique library above with real per-rep patterns, the same way the objection-handling playbooks were built.
