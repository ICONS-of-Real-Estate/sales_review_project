# Call Grading SOP — Phase 2 (AI Call Scoring)

> Companion to `brief.txt` (Technical Design Brief). That document is the architecture/rubric *design*; this document is the operational SOP — what actually happens to a call, in what order, and by what rule. If the two ever disagree, `brief.txt` is source of truth and this file should be updated to match.

## 1. Scope

Covers every **QC, Discovery, and Sales Call** logged in the Sales Call Log by Bens, Joana, or Sean. Does not cover the ICONS 100 podcast recordings (separate initiative, Section 4B) or the Guest Pipeline (Tech-Partner/Celebrity lane — explicitly out of scope per `brief.txt`).

A call is only eligible for grading once it has:
1. A logged **Outcome Disposition** in the tracker (Sold / Not Sold / Follow-up / No-show) — this is what Phase 1 compliance-checks for.
2. A matched Riverside transcript, keyed by **Calendar Event ID** (exact match) or flagged `fallback_heuristic` / `no_match` for manual confirmation. Calls with `no_match` do not get auto-scored — they route straight to manual review.

## 2. The two-pass evaluation

Grading is **not** one blended score. It's two sequential, distinct judgment calls, mirroring the brief's split-evaluator requirement:

**Pass 1 — Lead Quality Verdict.** Should this call have been booked at all?
- `good_to_book` or `should_screen_out`
- If `should_screen_out`, Pass 2 does not run — a bad lead doesn't get penalized for a rep's close technique on a call that shouldn't have happened.

**Pass 2 — Call Quality Score (1–5) + two failure-mode flags.** Only runs if Pass 1 passed.

## 3. The rubric — exactly two failure modes, nothing more

Kris's own framing of what goes wrong on a call reduces to two failure modes. Everything else (SPIN, Challenger, MEDDIC) is reasoning scaffolding for *why* a failure happened — not additional scored fields. Resist the urge to add more scored dimensions; the brief is explicit that this keeps the model stable under forced temperature=1.

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

Kris/Thao's explicit ask (17/08/2026): the shared two-failure-mode rubric above doesn't fit Sean's funnel cleanly enough to catch what actually matters on his calls. Sean's calls end one of two acceptable ways — he closes the money directly, or he books a second call with Tomás to close — and a call that does neither, with no clear evidenced reason, is the specific miss worth catching. This is a **separate rubric variant for Sean only** (`buildSeanJudgeSystemPrompt_()` / `scoreSeanTranscripts()` in `Phase2_CallScoring.gs`), not a change to the shared rubric above — Bens/Joana keep the original two-failure-mode design per this doc's own "resist adding scored dimensions" guidance in Section 3.

Six questions the model must answer, in order, before scoring:
1. Were objections uncovered *and* overcome with something concrete?
2. Did the rep explicitly ask for the money (not just a trial-close question)?
3. If no sale closed, was a second call with Tomás actually booked? If not, why not?
4. Did the rep do real discovery — do they demonstrably understand this lead's specific business?
5. Did the rep capture the lead's actual goals and tie the podcast framework back to them specifically (not a generic pitch)?
6. Bottom line: if nothing closed, what's the single root cause — stated causally, not vaguely?

Extra scored fields beyond the shared schema: `discovery_adequate`, `understood_leads_business`, `captured_leads_goals`, `tied_framework_to_goals`, `booked_second_call_with_tomas`, and a free-text `root_cause_if_no_sale`. The "Sales Call Log" sheet has no dedicated columns for these yet, so `scoreSeanTranscripts()` packs them into the existing `AI Feedback Summary` column alongside the standard coaching summary rather than requiring a sheet migration — revisit this if the extra fields turn out to need their own columns for filtering/reporting.

Transcript source for Sean's backfill: `tools/transcribe_sean_calls.py` (Gemini-based, since Sean records on Zoom, not Riverside) writes each transcript as a `"<video title> — Transcript"` Doc directly next to its source video in `PHASE2_CONFIG.SEAN_FOLDERS` — there's no separate transcripts-only folder like Bens' setup, and no Calendar-Event-ID-in-title convention, so every row is forced `Match Method = fallback_heuristic` and `Manual Review Recommended = TRUE`, same policy as the Bens legacy backfill.

A second, cheaper transcription option exists: `tools/transcribe_sean_calls_qwen.py`, using Alibaba's Qwen3-ASR-Flash (~$0.002/min vs. Gemini's much higher effective per-file cost) instead of Gemini. It reuses all of `transcribe_sean_calls.py`'s Drive plumbing and writes to the same `"<video title> — Transcript"` naming, so the two are interchangeable from the scoring side — but the underlying `qwen3-asr-toolkit` doesn't do speaker diarization (no `Rep:`/`Prospect:` labels), unlike Gemini's video-understanding approach. Manually reviewing 12 real Gemini transcripts (17/08/2026) showed speaker roles are reliably inferable from context alone even without labels, which is the working assumption behind using Qwen — but confirm that holds on a real Qwen transcript (`tools/test_single_transcription_qwen.py`) before running it at scale. The Gemini version is kept as-is and works standalone; treat it as the fallback if Qwen's output quality or the missing labels turn out to be a problem.

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
  "primary_failure_mode": "none | no_close_ask | objections_missed | both",
  "manual_review_recommended": true,
  "severity": 1,
  "feedback_summary": "string — 2-3 sentences, coaching-ready"
}
```

No fields beyond these. Booleans + 1–5 severity resist drift under kimi-k2.6's forced temperature=1 in a way 0–100 scores would not.

**Parsing rule:** strip leading/trailing ` ```json ` fences via regex before `JSON.parse()`. On parse failure, retry once with an explicit "return ONLY raw JSON" reminder. On a second failure, log the raw response and route to manual review — never silently drop a row.

## 6. Prioritization (who Kris actually reviews)

Kris reviews 3 calls/day, clustered by rep (concentrated feedback beats scattered feedback):
1. Group unreviewed flagged calls by rep.
2. Cluster score = (flagged-call count, capped at 3) blended with that rep's max/sum `severity`.
3. Pick the rep whose cluster best fills a 3-call sitting with highest aggregate severity.
4. Tie-breaks in order: higher single-call severity → older queue age (anti-starvation) → both failure-mode flags true beats one → alphabetical by rep.
5. Rollover: unreviewed calls stay queued, `age_in_queue` increments; an age threshold (e.g. 3 days) escalates priority so no rep's backlog starves behind a chronically higher-severity rep.

## 7. Rollout gates (do not skip)

| Phase | Gate to advance |
|---|---|
| Shadow mode (~2 weeks) | Score calls, do **not** email Kris. Hand-check model verdicts against Kris's own judgment. |
| Go live | ≥80% agreement with Kris on `manual_review_recommended` (this is a benchmark to hit on *this* data — the 80% figure from Zheng et al. 2023 is a general finding, not a guarantee here). |
| Weekly calibration | Diff model verdicts vs. Kris's actual review outcomes every week; track agreement (percent agreement / Cohen's kappa); feed disagreements back into rubric-prompt tweaks, mirroring the existing `learning_loop.gs` pattern. |

## 8. Known failure modes to design around (carried over from `brief.txt`)

- kimi-k2.6 **must** run at temperature=1 — any other value fails every call silently while the run reports "complete."
- Expect markdown-fenced JSON even at temperature=1 — defensive parsing is not optional.
- A call with `Match Method = no_match` never gets auto-scored, full stop — it's a matching failure, not a call-quality signal.

## 9. What this SOP deliberately does not cover

- Few-shot anchor examples (2–3 labeled transcript excerpts: a clear close-ask, a clear miss, a borderline case) — these need to come from real graded calls, not be invented. The first batch of 43 real transcripts has now been scored (17/08/2026) and its objection patterns are cataloged in `Objection_Handling_Playbook.md`; that's the source to pull `FEW_SHOT_ANCHORS` from in `Phase2_CallScoring.gs` once Kris/Tomás confirm which examples are representative.
- The actual Apps Script implementation (`brief.txt`'s explicit scope note: architecture/rubric only, no implementation code here either).
- Podcast-recording grading (Section 4B, separate initiative).

---
*First pass — for Kris/Tomás review and edit before this becomes the literal prompt text.*
