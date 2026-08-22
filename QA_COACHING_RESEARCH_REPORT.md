# Improving an AI-Graded Sales Call QA + Coaching System
### A research report — findings, recommendations, and honest uncertainties

**Prepared:** August 2026
**Scope:** LLM-as-judge reliability, coaching program design, build-vs-buy, data/architecture risk, measurement gaps
**Not included:** code, legal advice
**Produced by:** Claude Research, from `deep_research_prompt.md` in this repo

---

## How to read this

Recommendations are ranked within each section by **expected impact ÷ effort**. Each carries a confidence marker:

- **[High]** — well-supported by multiple independent sources or established research
- **[Medium]** — practitioner consensus, or research that doesn't map perfectly onto your context
- **[It depends]** — the honest answer is conditional; the conditions are stated

A note on evidence quality up front, because it matters for Section 2: **most published sales-coaching statistics are vendor-produced, self-reported, and correlational.** The widely-cited CSO Insights numbers (28% higher win rates, ~17% revenue growth from "dynamic coaching") come from surveys where well-run organisations both coach more *and* perform better for a dozen shared reasons. Treat them as directional evidence that structured coaching is worth doing — not as effect sizes you can forecast against. Where I cite peer-reviewed work (Kluger & DeNisi, the generalizability-theory literature, the LLM-judge papers), the evidence is substantially stronger and I say so.

---

## Section 1 — LLM-as-judge reliability for subjective sales coaching

### The headline finding: your calibration check is probably measuring the wrong thing on the wrong sample

You already have the two ingredients most teams lack — a human reviewer producing agree/disagree verdicts, and a weekly calibration check. Two structural problems are likely making that check over-optimistic.

**Problem 1: raw agreement massively overstates real agreement.** A large-scale 2026 evaluation of 21 LLM judges found that every single judge's raw exact-match score exceeded its chance-corrected agreement (Cohen's κ) — by 33 to 41 percentage points, regardless of provider, model scale, or generation. The authors named this "kappa deflation." The mechanism is simple: when your label distribution is skewed (most calls are "fine"), a judge that mostly says "fine" racks up high raw agreement while having near-zero ability to discriminate. If your weekly check reports something like "the model and I agreed on 84% of calls," that number is close to meaningless on its own.
*Source: "Reliability without Validity: A Systematic, Large-Scale Evaluation of LLM-as-a-Judge Models," arXiv 2606.19544*

**Problem 2 — and this one is specific to your design: you are calibrating on a biased sample.** Your human review queue is populated by a severity/confidence heuristic. That means the human only ever sees calls the model already flagged as bad or was unsure about. Agreement measured on that subset tells you how well the model performs *on the calls it already knows are hard* — it tells you nothing about false negatives, which are the expensive errors. A rep who is quietly mediocre on every call, none of which trip the severity threshold, is invisible to your calibration loop by construction.

### Recommendations, ranked

**1.1 Add a small random holdout to the review queue. [High impact / Low effort]**

Every week, in addition to the heuristically-flagged calls, sample 3–5 calls **at random** (or stratified across the score range) and review them blind — ideally without seeing the model's score first. This is the single highest-value change in this report. It costs you maybe 20 minutes a week and it's the only way to detect the failure mode your current design is structurally blind to.

**1.2 Switch the calibration metric to Cohen's κ or Krippendorff's α. [High / Low]**

Practitioner consensus on thresholds is fairly consistent:

| κ | Interpretation | Action |
|---|---|---|
| < 0.40 | Poor | Rubric needs major revision before trusting the judge |
| 0.40–0.60 | Moderate | Usable, but human spot-check all failures |
| 0.61–0.79 | Substantial | Good — deploy with monitoring |
| ≥ 0.80 | Almost perfect | Deploy autonomously |

For reference, human-to-human κ on subjective judging tasks typically lands around 0.80, so ~0.75+ is genuinely "as good as another person."

**Sample size matters more than people expect.** With fewer than ~10 annotations the 95% confidence interval on κ is wider than ±0.30 — the number is statistically meaningless. Practitioner guidance converges on 15–20 annotations *per criterion* as a floor and 20–30 before you trust it for a deployment decision. At 3–5 random reviews per week you'll have a usable first read in about a month, which is fine.
*Sources: AWS `sample-GEDD` Cohen's-kappa guide (github.com/aws-samples/sample-GEDD); Galileo, "How to Calibrate Your LLM Judge With Human Annotations"*

**1.3 Build a frozen regression set for drift detection. [High / Low-Medium]**

Pull 30–50 calls spanning the full score range, with your human verdict attached, and freeze them. Re-run the entire judging pipeline against that set:
- on every model version change
- on every rubric edit
- monthly regardless

Compare the *score distribution*, not just the mean. Drift usually shows up as compression or inflation of the distribution before it shows up in averages. This is the only mechanism that lets you distinguish "my reps are improving" from "the new model is more generous." Recalibrate on a fresh annotation batch every 60–90 days.

Related discipline, from conversation-intelligence practitioners: **freeze a scorecard version for a full quarter.** Mid-cycle rubric revisions silently break every week-over-week comparison you've made.

**1.4 Move from a single holistic 1–5 to analytic sub-scores. [High / Medium]**

The research consensus has moved decisively toward analytic (per-criterion) rubrics over holistic (single-score) ones for LLM judges. The reasons are directly relevant to you:

- Holistic scores **mask strengths and weaknesses that cancel out** — a rep with brilliant discovery and no close-ask lands at "3," identical to a rep who is mediocre at everything. That's a coaching signal destroyed at source.
- Holistic scoring **increases rater disagreement**, because raters disagree more on integrated overall judgments than on individual criteria.
- A single scalar **cannot explain its own rationale**, which kills auditability — you can't root-cause a regression.

*Sources: "Autorubric: A Unified Framework for Rubric-Based LLM Evaluation," arXiv 2603.00077; "From Holistic Evaluation to Structured Criteria," arXiv 2606.08625*

Two important caveats:

- **Analytic agreement does not automatically inherit holistic agreement.** A 2026 essay-scoring study found strong open models reaching QWK ≈ 0.6 on holistic scoring, but that this did *not* transfer uniformly to analytic scoring, where large and stable directional bias appeared on some traits (arXiv 2604.00259). **You must validate each sub-score separately** — one aggregate κ is not enough.
- **Lower-precision scales are more reliable.** Fine-grained scales invite the judge to invent distinctions it cannot defend. Binary and 3-point judgments align with humans more reliably than 5-point ones on the same task.

**Concrete suggested shape:** decompose each rubric into 6–12 near-binary checks ("Did the rep isolate the objection before responding? yes / partial / no"), each with a one-line evidence quote from the transcript, then compute the 1–5 as a weighted rollup. You keep continuity with your historical data, you gain a coaching signal, and you gain auditability — every score traces to specific transcript moments.

**1.5 Fix rubric bleed structurally, not with prompt wording. [High / Low]**

The bug you hit — a booking rep graded against a closer's rubric — is a known and predictable class. Practitioner guidance is blunt about the mechanism: *"One rubric per dimension. A single prompt that scores faithfulness, relevance, fluency, and format compliance in one pass produces correlated, unreliable scores. The model anchors on the first dimension and lets that anchor bleed into the others"* (Galtea, "LLM as a Judge prompts"). The same anchoring applies across rubrics in one context window.

Three defences, in order of value:

1. **Never put two rubrics in the same context window.** Select the rubric by data lookup (rep ID → role → rubric ID) in Apps Script *before* assembling the prompt. The model should never see a rubric it isn't meant to apply, and should never be asked to choose.
2. **Make the judge echo its rubric ID and version into a dedicated column.** Then assert in code that it matches what you routed. This is ~10 lines and permanently closes the entire bug class, including future silent recurrences.
3. **Add per-role anchor examples.** 2–4 annotated examples (one strong, one weak, one borderline) drawn from *real disagreements* between you and the model, refreshed periodically. Chain-of-thought before scoring — reasoning first, score second — improves consistency and gives you an audit trail.

**1.6 Watch two confounds that are specific to transcript-based judging. [Medium / Low]**

- **Transcript quality as a hidden score determinant.** Whisper word-error-rate varies with mic quality, accent, cross-talk and connection. A rep on a bad headset systematically produces worse transcripts and therefore worse scores. Check it: correlate score against call duration, audio source, and (if you can get it) transcription confidence. If any correlation is meaningful, you're partly grading equipment.
- **Consistency ≠ validity.** The 2026 study above identified a "consistency–bias paradox": judges with very high test-retest reliability (α > 0.95) simultaneously showed severe position bias. **Re-running the same call and getting the same answer proves nothing about correctness.** Only human comparison does.

One piece of good news: the same study found verbosity bias in modern models to be *much* smaller than the 20–40% variance reported in 2023-era literature — so "long transcript = higher score" is less of a worry than older guidance suggests. Worth verifying on your own data anyway, since it's a one-line correlation.

### How much human spot-checking is actually enough?

**[It depends]** — on your κ and on the cost of a wrong score.

- κ ≥ 0.80: sampled verification of 5% of output, biased toward low-confidence cases, plus the frozen regression set.
- κ 0.61–0.79: 5–10%, plus review all cases at the score extremes.
- κ < 0.60: review everything the model marks as a failure, and fix the rubric before scaling.

Given that your scores drive coaching assignments rather than compensation or termination, the cost of an individual wrong score is low — a rep does one unnecessary drill. **The cost of a systematically wrong rubric is high**, because it silently coaches the whole team toward the wrong behaviour for months. That asymmetry says: spend your review budget on rubric validation and the random holdout, not on maximising the number of individual calls reviewed.

---

## Section 2 — Sales coaching program design for small teams

### The one piece of research that should shape this whole section

Kluger & DeNisi's 1996 meta-analysis (607 effect sizes, 23,663 observations, *Psychological Bulletin*) remains the most rigorous work on feedback interventions. Two findings:

1. Feedback improved performance on average (d = 0.41), **but over one-third of feedback interventions made performance worse.**
2. The moderator that explains it: **feedback effectiveness decreases as attention moves up the hierarchy — away from the task and toward the self.** Task-level feedback ("your second question closed off the discovery") helps. Self-level feedback ("you scored 2/5 on discovery this week") often hurts, because it triggers ego-defence rather than learning.

This is not a soft finding. It is the best-evidenced thing in this report, and it has an uncomfortable implication for automated coaching systems: **a numeric score delivered by a machine is close to a worst case** — it's self-directed, it's evaluative, it carries no task-level detail, and it arrives without a relationship to soften it. An automated feedback loop is not neutral. It can easily land in the third of interventions that make people worse.

That doesn't mean stop. It means the *design* of the feedback matters more than the accuracy of the score.

### Recommendations, ranked

**2.1 Restructure every automated message to be task-level, not person-level. [High / Low]**

Concretely, for both the weekly scorecard and the daily assignment:

- Lead with a **transcript quote and a timestamp**, not a number. "At 14:32 you got the price objection and answered it in 4 seconds — here's what isolating it first would have sounded like."
- Give **one behaviour to change**, not a list. Practitioner consensus on this is unanimous.
- Put the score **below the fold**, or remove it from the rep-facing view entirely and keep it for your own trend analysis. The score is a management instrument; it is not coaching.
- Never let the automated message contain a comparison to another rep.

This costs a prompt rewrite. It is the highest-leverage change in this section.

**2.2 Kill the leaderboard, or convert it to self-comparison. [High / Low]**

**With 3–4 people, a ranked leaderboard is a bad instrument**, and the reason is structural rather than a matter of taste.

The relevant research findings:
- Absolute leaderboards showing overall rankings **particularly harm lower performers**, by accumulating perceptions of repeated failure; only mid-to-upper ranked users experience a sense of success (JMIR Serious Games, 2021).
- Competition's positive effects are **more likely when competitors are at approximately the same performance level** (Sailer et al., *Computers in Human Behavior*, 2017). Leaderboards motivate when a position is a few points away and demotivate when a player sits at the bottom (Werbach & Hunter).
- Bottom-ranked participants are **less likely to remain engaged in closing the gap** with top-ranked peers under an absolute leaderboard; upward comparison erodes the motivation to close it.

At n=30, rank 22 is anonymous and mobile. At n=4, rank 4 is a public, permanent, personally-identifying label, and the person holding it has a 25% chance of ever escaping it in a given week. The standard mitigation for large leaderboards — relative/cohort scoping, "show top 10 plus your position" — is mathematically unavailable to you.

**What to replace it with** (the pattern is well-established in workplace gamification): show each rep's performance **against their own prior weeks and their own goal**, side by side, as *% to own target* rather than as a rank. Reset weekly so bad weeks don't perpetuate. Add a **team-aggregate** goal so the social dynamic is cooperative rather than zero-sum. You keep visibility and social accountability; you lose the permanent-loser problem.

**2.3 Redesign the daily drill assignment so it isn't purely deficit-driven. [High / Medium]**

Your current rule — "assign remedial practice on the weakest area from the last real training call" — has three predictable failure modes: it repeats when the weakness is persistent (demoralising), it over-fits to a single call (noisy — see 5.2), and it never reinforces what's working.

Suggested changes, roughly in order of value:

- **Cap consecutive identical assignments at two.** If the same weakness surfaces a third time, that is a signal the *automated loop has failed* — escalate to a live human conversation instead of assigning the drill again. This is the single most important guardrail: the third identical automated nag on the same weakness is the moment a rep concludes the system doesn't see them.
- **Interleave spaced review of previously-fixed skills.** The reinforcement literature converges on expanding intervals — commonly cited as a 2-7-14-30 day pattern. Maintain a per-rep skill inventory with a last-drilled date; each day, pick from {current weakness, skill due for spaced review} rather than always the former. This also solves repetitiveness for free.
- **Weight the assignment on severity × recency across the last 3 calls**, not the single last call. One call is not a measurement (Section 5.2).
- **Open every assignment with something that worked**, quoted from the same call. A 2:1 or 3:1 reinforcement-to-correction ratio is the common practitioner heuristic. The specificity matters more than the ratio — generic praise ("great energy!") reads as machine-generated and devalues the correction that follows.
- **Grade drills against the rep's own baseline**, not an absolute bar. Improvement-relative scoring keeps the loop task-focused, which is exactly what Kluger & DeNisi's moderator analysis says preserves effectiveness.

**2.4 Rethink the compliance nagging. [Medium / Low]**

An automated email that says "your file didn't show up" is a meta-task, self-directed intervention with zero task content — squarely in the category the meta-analysis identifies as most likely to backfire. It also habituates fast: by the fourth one it's spam.

Better shape: **nag once, then escalate to a human.** Two consecutive misses should generate a note to *you*, not a third email to the rep. A missed drill is usually information (they're slammed, they're demoralised, the drill was badly matched, they've quietly checked out) and the information is lost if a robot absorbs it.

**2.5 Keep the cadence — you're already past the frequency question. [High confidence, no action]**

The coaching-frequency literature (weekly coaching associated with substantially higher quota attainment than monthly or quarterly) is worth knowing but not actionable for you: **you already coach daily and weekly.** Your constraint isn't cadence, it's whether the daily/weekly artefacts change behaviour. Don't add more frequency. Add specificity.

One structural point from that literature that *is* actionable: high-performing teams **separate skills coaching from deal/pipeline inspection**, because conflating them turns coaching into interrogation. If your weekly scorecard conversation and your pipeline review are the same meeting, split them.

**2.6 What separates coaching programs that change behaviour from ones that produce reports nobody acts on. [Medium]**

Synthesising across the practitioner literature, the consistent differentiators:

1. **Practice, not information.** The rep performs the actual behaviour, gets feedback, and repeats. Your drill loop already does this — it's the strongest part of your design.
2. **Short and frequent beats long and occasional.** 5–15 minute drills on one skill. Again, you already do this.
3. **Reinforcement after the event is the single biggest predictor of lasting behaviour change** — bigger than the quality of the original training.
4. **One behaviour at a time.**
5. **Manager language aligned to the framework.** If your Agree/Isolate/Repeat framework is what the rubric grades, it must also be the language you use in live conversation. Reps revert instantly when the coaching vocabulary and the review vocabulary diverge.
6. **Follow-through checked in the field.** Did the drilled skill show up in the next real call? Almost nobody measures this. You can (see 5.4) — you have both halves of the data.

**[It depends]** — how much of this matters is a function of rep tenure. New reps benefit most from high-frequency deficit-focused drilling; experienced reps at a plateau usually need deal-specific coaching and autonomy, and respond badly to daily remediation. If your handful of reps span both, consider running the daily loop for ramping reps only and shifting tenured reps to weekly.

---

## Section 3 — Build vs. buy

### The honest answer: keep what you have, but buy the boring layer

I'll lead with the conclusion because you asked for it plainly: **at 3–4 reps, no mature conversation-intelligence platform is worth switching to wholesale, and the one requirement you called unusual is the requirement they handle worst.** But there is a hybrid that is probably better than either pure option.

### What the platforms cost

**Gong** (category leader, ~4.7/5 on G2 across 6,500+ reviews) does not publish pricing. Reported 2026 figures from multiple independent procurement-focused sources converge on:

| Component | Reported range |
|---|---|
| Per-seat licence (Foundations) | $1,300–$1,600/user/year |
| Platform fee (mandatory, fixed) | $5,000–$50,000/year |
| Implementation/onboarding | $7,500–$65,000 one-time |
| Seat minimum | ~15 seats commonly reported |
| Contract | Annual/multi-year, paid upfront; 5–15% auto-renewal uplifts |

A commonly-reported first-year total for a small team is **~$28,500**. The structural problem for you is that **the platform fee doesn't shrink with headcount** — at 10 seats it adds $42–$417/user/month before any licence cost. With a ~15-seat minimum against your 3–4 reps, you'd be paying for 11+ phantom seats.

*Caveat on sources: nearly all published Gong pricing analysis is written by competitors. I've reported the range where independent sources agree rather than any single figure, and the convergence across sources with different axes to grind is itself reasonable evidence.*

**Mid-market tier** — this is where you'd actually shop:

| Tool | Reported 2026 pricing | Notes |
|---|---|---|
| Avoma | ~$19–$29/seat/mo entry; higher tiers reported $79–$129 | Custom AI scorecards; free viewer seats; monthly billing available |
| Jiminny | ~$42/user/mo insights seat; ~$83/user/mo recording seat | Coaching-first; 12-month minimum + one-time setup fee |
| Clari Copilot (ex-Wingman) | ~$1,200+/seat/year | Custom scorecards vs MEDDIC/SPICED; real-time cue cards |
| Fireflies / Fathom / Grain | Free–$19/seat/mo | Recording + transcription only; no real coaching layer |

At 4 seats, Avoma or Jiminny lands somewhere between **$1,000 and $4,000/year**. That is a genuinely different conversation from Gong.

*Note the pricing inconsistency across sources for Avoma — different tiers are being quoted as "starting price." Get a quote; don't plan on a number from a blog post.*

### The per-role rubric requirement — where buying breaks down

You flagged this as your most unusual requirement. It is, and it's the strongest argument for keeping your build.

**Every platform advertises custom scorecards.** Gong's AI Call Reviewer lets you build scorecards (including an AI Builder that generates one from your closed-won calls), auto-answer scorecard questions from the transcript, and auto-apply scorecards. Clari Copilot, Avoma and Revenue.io all advertise methodology-aligned and role-based scorecards.

**But the assignment mechanics are where it gets awkward for your exact setup.** From Gong's own help documentation and community forums:

- Automatic review **scores the call host** (or selected participants based on team hierarchy). Multiple customers report difficulty getting the AI to score a *non-host participant* — one CSM team found Gong auto-scoring the host on every meeting their CSM merely attended. A Gong PM confirmed in late 2025 that "expanding our capabilities to score more people than the host" was still forthcoming.
- Scorecards are auto-applied via **streams — dynamic filter-based collections**. Gong's own community documentation notes that *"a given call can have multiple scorecards, so if filters overlap, more than one scorecard can be applied to the same recording."*
- AI answers aren't available for transcripts under 100 words or voicemail-answered calls.

Read that second bullet again: **overlapping filters applying the wrong scorecard is exactly the bug you already hit and fixed.** Buying doesn't eliminate the failure mode; it moves it into someone else's config UI where you can't add an assertion.

Your specific shape — a podcast host who runs the recording (so *is* the host) and is graded on booking rather than closing, while closers on other calls may or may not be the host — is precisely the configuration these tools handle least gracefully.

### The volume question you should answer first

One practitioner heuristic worth taking seriously: **below roughly 20 calls per rep per month, you don't have enough data for coaching analytics to mean much** — from anyone's system, including yours.

**Go compute this before anything else in this section.** If your reps are running 40+ calls/month, all of this is worth investing in. If they're running 8, the honest answer is that your weekly scorecard is measuring noise (see 5.2), the leaderboard is ranking noise, and the highest-value thing you could do is listen to two calls a week yourself and skip the machinery. That's not a knock on what you've built — it's the volume threshold below which *any* statistical approach to call quality stops working.

### Recommendation: buy the capture layer, keep the judging layer

**[High / Medium effort]** The split that probably serves you best:

**Buy (or at least de-risk):** recording capture, transcription, storage, permissions, playback UI. This is the least differentiated, most operationally fragile part of your stack — a Whisper pipeline plus Drive folder management plus file-arrival compliance checking is a lot of surface area maintaining something you can rent for $20–80/seat/month with better reliability. Most of these tools have APIs or webhooks that let you pull the transcript out.

**Keep:** the role-specific rubrics, the judging prompts, the drill assignment loop, the review queue heuristic, the dashboard. This is your actual IP, it encodes your ICONS SOP framework, and no vendor will let you express it as precisely.

**The break-even maths:** if you're spending more than ~4–6 hours/month maintaining the pipeline (debugging skipped rows, chasing failed transcriptions, patching quota errors), a $1–4k/year tool pays for itself at almost any valuation of your time — and you're the bottleneck resource in this whole system. Gong-tier doesn't pay for itself at your scale and probably won't until 15+ reps.

**Two vendor-risk flags:** the Clari/Salesloft merger is reported to complete in H2 2026 (product roadmaps get disrupted in mergers), and Gong shifted to metered AI credits in June 2026 with a per-seat annual allowance — meaning heavy use of generative features can now incur overage. Contract terms in this category are moving.

### One adjacent category worth a look

There are now tools that do specifically what your drill loop does — score real calls against a custom scorecard, detect the skill gap, and auto-assign a targeted roleplay (Hyperbound's Perform + Practice pairing is the clearest example; Pitchmonster, Second Nature and Retorio occupy adjacent space). You independently built this pattern, which is a good sign you built the right thing. Worth a demo purely as a benchmark for your own drill design — not necessarily as a purchase.

---

## Section 4 — Data / architecture risks

### The Sheet: size is not your problem, concurrency is

**Hard limits:** 10 million cells **per spreadsheet, shared across all tabs** (not per tab — this trips people up), 18,278 columns, 50,000 characters per cell.

**Your actual exposure:** at ~20 columns and even 50 calls/week, you're generating ~52,000 cells/year. You will not hit the cell limit this decade. Practical performance degradation typically begins around 100,000 rows, which at your volume is decades away.

**The two size risks that do apply:**
- Your free-text AI feedback summary column against the 50,000-character-per-cell cap. Unlikely, but if you ever store full transcripts in the Sheet, that's where it bites.
- Empty cells count. Twenty tabs of default 1,000×26 blank grids is 520,000 cells of nothing.

### The real risk: eight processes writing one sheet with no transactions

This is where these setups actually break, and it's independent of row count. Apps Script gives you no transactions, no row-level locking by default, and a hard execution ceiling.

**Relevant limits (2026):**
- **6-minute maximum execution time per run.** The old 30-minute Workspace tier was retired — upgrading no longer buys headroom.
- Per-service daily quotas (Gmail, Drive, Sheets, UrlFetch) that stack independently of execution quotas. A workflow can be well within execution time and still fail on service call rate. Your per-call LLM requests consume UrlFetch quota.
- Concurrent execution caps at project level.

**The specific failure modes to expect, in rough order of likelihood:**

1. **Trigger collision / lost update.** Two time-driven triggers fire close together; both read the same "last processed row"; one overwrites the other's state. Symptoms: duplicate grading, silently skipped rows, calls that never get graded and never error.
2. **Mid-batch timeout.** A run of 100+ rows hits the 6-minute ceiling. Rows 1–40 process correctly; 41–100 are skipped **silently**, with no rollback and no error.
3. **Service rate throttling.** "Service invoked too many times" mid-run. Classically time-of-day dependent, which is the clearest diagnostic signature of a quota problem.
4. **Runaway triggers.** A pattern of "create a trigger to run again in a few minutes" without cleanup produces overlapping triggers and burns quota.

The insidious property of all four: **they look identical to "the rep had a quiet week."** A silently skipped row is indistinguishable from a call that didn't happen, which means these failures corrupt your coaching data without ever announcing themselves.

### Mitigations, cheapest first

**4.1 LockService around every write critical section. [High / Low]** Always release in a `finally` block, or a thrown error leaves the lock held and blocks all future runs.

**4.2 Idempotency key per call. [High / Low]** Use the recording file ID as the key, plus a `processed` / `phase_completed` column checked before any write. Retrying a row without knowing whether it already succeeded is how you get duplicates. Combine with exponential backoff on 429s.

**4.3 Checkpoint after every batch. [High / Low]** Anything not flushed when the 6-minute timeout hits is gone.

**4.4 Single-writer pattern. [Medium / Medium]** Have phases 2–8 append to their own dedicated tabs; one reconciler process composes the master row. This eliminates the multi-writer race surface entirely rather than mitigating it.

**4.5 A coverage assertion. [High / Low]** A daily check: recordings in Drive vs. rows in the Sheet vs. rows with a completed grade. Any mismatch emails you. This is the alarm that makes silent failures loud, and it's maybe 30 lines of code.

### The migration: invert what you already have

**[High impact / Low-Medium effort]** You already run a SQLite mirror for the dashboard. **The single cleanest architectural move is to invert the relationship: make SQLite (or a hosted Postgres — Supabase, Neon, Turso) the system of record, and make the Sheet a read-only export** that Apps Script writes to on a schedule.

You get transactions, real schema, proper indexes, an append-only score history, and joins against outcome data. You keep the Sheet as the human-facing surface everyone's used to. You are already 80% of the way there.

**The trigger conditions that say "do it now"** — you're likely at or past all three:
1. You need score/rubric-version history per call (you do, the moment you version rubrics — see 4.6)
2. You need to join against outcome data (Section 5.1)
3. More than one process writes concurrently (already true, eight times over)

**[It depends]** — if the Apps Script pipeline is currently stable and you've never seen a skipped row, the mitigations in 4.1–4.5 may buy you another year and cost a day. If you're already debugging duplicate or missing rows, stop patching and migrate.

### 4.6 Rubric versioning — the quiet data-integrity problem

Sheets has no schema migration. **The moment you edit a rubric, every historical score becomes incomparable to every future score**, and nothing in your system records that this happened. Your trend charts will show a step change you'll later misread as a coaching win or a rep regression.

Minimum fix: a `rubric_version` column on every row, written by the judge and asserted against the expected value (this is the same column recommended in 1.5 — one change, two problems solved). Then freeze rubrics for a quarter at a time and annotate version boundaries on your trend charts.

---

### Legal / privacy — what to go verify with an actual lawyer

**None of this is legal advice.** It's a list of the specific things I'd walk into a lawyer's office with, and it's arranged so you're not paying billable hours for the lawyer to explain the landscape to you.

**A. Recording consent — the baseline map.**
Twelve US states require all-party ("two-party") consent to record: **CA, CT, DE, FL, IL, MD, MA, MT, NH, OR, PA, WA.** Federal law and most other states permit one-party consent. The complication is interstate: under *Kearney v. Salomon Smith Barney* (Cal. 2006), California's rule can follow a California resident onto a call originating elsewhere, and courts often apply the stricter rule when any participant is covered by an all-party statute. With remote participants you frequently cannot know where everyone is sitting.

**The pragmatic posture** most counsel recommend: **treat every external call as all-party**, disclose recording verbally at the top, and capture that disclosure *inside the recording itself* so consent is evidenced by the artefact.

**B. The AI-specific overlay — this is the part that's new and moving.**
There is an active litigation wave treating AI transcription vendors as *third-party eavesdroppers* rather than passive tools of the consenting user. Live matters include *In re Otter.AI Privacy Litigation* (N.D. Cal., CIPA + ECPA), a suit against Granola, and a BIPA claim against Fireflies.

The fact pattern that should concern you most: in a related N.D. Cal. case, plaintiffs **survived a motion to dismiss** where companies used third-party AI for transcription and analytics in customer service calls. The court emphasised that the vendor's **mere capability to use the data for its own purposes** (e.g. model training) was enough to implicate CIPA liability, coupled with lack of consent.

**Questions for counsel:**
1. Every vendor touching call audio or transcripts — Zoom, Riverside, your Whisper provider, your LLM API — what are their retention and model-training terms? Get zero-retention / no-training commitments **in writing**, and check whether defaults were ever changed on your account.
2. Does your recording disclosure cover *analysis and AI scoring*, or only *recording*? These are being pleaded as separate acts.
3. Is your Whisper deployment hosted or on-device? On-device processing materially changes the interception analysis because nothing is transmitted.
4. Damages exposure scales fast — **$5,000 per CIPA violation** as a statutory figure, applied per call. Ask what your realistic aggregate exposure looks like given your call volume.
5. If you do speaker diarization, ask specifically about Illinois BIPA and whether anything you do constitutes voiceprint extraction.

**C. Employee-side consent.** Your reps are being recorded, transcribed, and algorithmically scored — with those scores driving assignments and visible in a leaderboard. Ask about employee monitoring notice requirements in the states where your reps live, and about written consent. **If any team member sits outside the US, this changes materially** — GDPR Article 22 governs automated decision-making producing significant effects, and several European jurisdictions add works-council or employee-monitoring requirements on top. Worth flagging your team's actual geographic distribution to counsel rather than assuming the US analysis covers it.

**D. TCPA on the outbound side — and a correction you'll need.**
Your outbound motion sits in a vertical (real estate lead-gen) that plaintiffs' firms actively target, with statutory damages of $500–$1,500 per call and per-call aggregation in class actions.

**Important:** a great deal of content published in 2026 states that the FCC's "one-to-one consent" rule took effect in January 2026. **It did not.** The Eleventh Circuit **vacated** it in *Insurance Marketing Coalition Ltd. v. FCC* on 24 January 2025, three days before its effective date, holding the FCC exceeded its statutory authority. The FCC subsequently deleted the vacated language and reinstated the prior rules. As of now, the **pre-2023 prior-express-written-consent standard governs.** Verify current status with counsel — the concept could return via narrower rulemaking or legislation — but don't let a blog post convince you a rule applies that doesn't.

What *does* apply and is more commonly litigated anyway: DNC obligations (federal, state, and internal lists), the 8am–9pm local-time calling window, and the amended FTC Telemarketing Sales Rule's **five-year** record retention requirement including the script used and disposition for each call. That last one is worth noting because **your Sales Call Log may already be substantially satisfying it** — which is an argument for the database migration and a documented retention policy rather than an ad-hoc Sheet.

**E. Retention.** You currently have no stated deletion schedule, which means recordings accumulate indefinitely as both a discovery surface and a breach surface. Ask counsel for a retention schedule that satisfies the TSR minimum without keeping everything forever.

---

## Section 5 — What you're not measuring

### 5.1 Predictive validity: does the score predict the outcome? [Highest impact / Medium effort]

You named this yourself, and you're right that it's the gap. It's worth being precise about *why* it's the most important one: **without an outcome link, the entire system is unfalsifiable.** You cannot distinguish a good rubric from a bad one, you cannot justify the weights, and you cannot tell whether a rep whose score is rising is actually getting better. Every other recommendation in this report is a refinement to a measurement instrument that has never been validated against anything.

**Concrete design:**
- Log `call_id → outcome` with a 60–90 day lag: booked / showed / closed / contract value.
- Compute correlation of the overall score **and each sub-score independently** against outcome.
- **Control for lead quality** — you already capture a lead-quality verdict, which is genuinely fortunate, because lead quality will otherwise swamp everything. A great call to a terrible lead loses; a mediocre call to a hot lead wins. Without controlling for it you'll mostly measure lead-source quality and call it rep skill.
- Reweight or delete sub-scores that don't discriminate. A rubric line that doesn't correlate with anything is coaching your reps toward a behaviour you invented.
- A rough sanity threshold from practitioner writing: **calls scoring above 75 (of 100) should convert meaningfully better than those below 50.** If they don't, the criteria need recalibration, not the reps.

**[It depends] — the honest caveat:** at 3–4 reps, n is small and the confidence intervals will be embarrassing. Expect 6–12 months before this is more than directional, and be disciplined about not acting on early noise. It's still worth starting the logging **today**, because the clock only starts when you begin capturing outcomes, and every month you don't is a month you can never analyse.

### 5.2 Measurement reliability per rep: how many calls before an average means anything? [High / Low]

**This is the finding I'd most want you to take away from Section 5**, because it's invisible and it's probably corrupting your weekly scorecard right now.

The rating-reliability literature (generalizability theory, used in medical OSCEs and teacher-observation systems) is unambiguous: **a single observation is not a measurement of a person.** The Gates Foundation's MET project found that one observation by a school administrator plus one by an external peer produced reliability of just **0.59** — well below the 0.80 conventionally required to make decisions about an individual. Classroom-observation G-studies typically require **4+ observations** (and multiple raters) to reach 0.90.

The mechanism transfers directly: variance in a rep's score comes from the rep, the rubric items, the rater, **and the particular call**. A hard prospect, a bad connection, a call that ended early — all produce score variance that has nothing to do with skill.

**What this means for your weekly scorecard:** if a rep does 3 calls in a week, their weekly average is mostly noise, and week-over-week deltas are almost entirely noise. Acting on them — assigning a drill, moving a leaderboard position — means you are systematically coaching randomness.

**Fixes, all cheap:**
- Report **rolling 4-week averages** as the primary figure, with the weekly number secondary.
- Display **n (calls graded)** next to every score, always.
- Suppress or grey out any rep-week below a minimum n.
- Set a **minimum meaningful delta** and don't trigger interventions below it. You can estimate this empirically from your own data: the standard deviation of a rep's scores within a stable period is your noise floor.
- Assign drills on the last 3 calls, not the last 1 (per 2.3).

### 5.3 Did the coaching actually work? [High / Low effort — you already have the data]

Almost nobody measures this, and you can, because you hold both halves: **when a rep is assigned a drill for weakness X, does sub-score X improve on their next 2–3 real calls?**

This is the direct test of whether your drill loop does anything. It's a single join between the assignment table and the call log. Run it monthly. If assigned drills don't move the corresponding sub-score, the loop is theatre and you should know that — it's a cheap experiment on an expensive-to-maintain system.

A related second-order question worth tracking: **the practice-to-live gap.** A rep who scores well on drills and poorly on live calls has a performance-under-pressure problem, not a knowledge problem, and needs a completely different intervention (live-call support, shadowing) than more drilling. Your current loop would respond by assigning more drills, which is exactly the wrong move.

### 5.4 Score distribution drift, separated from real improvement [Medium / Low]

Track the *distribution* of scores monthly, not just the mean. If scores rise across the board, there are four candidate explanations and they demand opposite responses:
1. Reps genuinely improved
2. The judge drifted (model version, provider-side change)
3. The rubric changed
4. Reps learned the rubric and are gaming it

**Only the frozen regression set from 1.3 distinguishes (1) from (2).** The rubric_version column distinguishes (3). For (4), the diagnostic signature is **rising sub-scores with flat outcome metrics** — which requires 5.1 to detect. These three recommendations interlock; each is much weaker alone.

On gaming specifically: once reps know the rubric — and they will, you should tell them, coaching secretly is worse — they will say the magic words. Goodhart's law is not avoidable here, only detectable. Mitigation is to grade *substance* over *presence*: "did the rep quantify the pain with a specific number" rather than "did the rep mention pain."

### 5.5 Pipeline coverage [Medium / Low]

**% of calls that were actually captured, transcribed, and graded**, tracked as a first-class metric. Per Section 4, a silently skipped row is indistinguishable from a quiet week — and this metric is the only thing that separates them. It is also the health check for your whole automation stack.

### 5.6 Review-queue precision — protecting the scarcest resource [Medium / Low]

Of the calls your severity/confidence heuristic flags for manual review, **what percentage do you actually disagree with the model on?** If it's low, the heuristic is generating false positives and consuming the single scarcest input in the entire system: your attention. Tune the threshold against your own disagreement rate. Combined with 1.1's random holdout, you get both precision (are flagged calls worth reviewing?) and recall (what are we missing?).

### 5.7 The thing systems like this most commonly miss, in one line

Ranked by how often it's absent and how much it costs:

1. **Outcome correlation** (5.1) — without it, nothing else can be validated
2. **Reliability-aware reporting** (5.2) — most weekly scorecards report noise as signal
3. **Coaching-effect measurement** (5.3) — the loop is never tested against its own purpose
4. **Coverage monitoring** (5.5) — silent failures corrupt everything upstream

---

## Summary: if you only do five things

| # | Action | Section | Effort |
|---|---|---|---|
| 1 | Add 3–5 **random** calls/week to the human review queue, and switch the calibration metric to Cohen's κ | 1.1, 1.2 | Low |
| 2 | Start logging **call → outcome** with a 60–90 day lag today, controlling for lead quality | 5.1 | Medium |
| 3 | Report **rolling 4-week averages with n**, and stop acting on week-over-week deltas | 5.2 | Low |
| 4 | Convert the leaderboard to **self-comparison / % to own goal**, weekly reset | 2.2 | Low |
| 5 | Rewrite automated feedback to be **task-level with transcript quotes**, score below the fold | 2.1 | Low |

Four of the five are low-effort. The one structural change worth planning for is inverting the SQLite mirror to become the system of record (4.5) — and the one thing you should *not* do is buy Gong.

---

## Sources

**LLM-as-judge reliability**
- "Reliability without Validity: A Systematic, Large-Scale Evaluation of LLM-as-a-Judge Models Across Agreement, Consistency, and Bias" — arXiv 2606.19544
- "Bias and Uncertainty in LLM-as-a-Judge Estimation" (Fiedler, Indeed) — arXiv 2605.06939
- "Autorubric: A Unified Framework for Rubric-Based LLM Evaluation" — arXiv 2603.00077
- "From Holistic Evaluation to Structured Criteria: Rubrics Across the Evolving LLM Landscape" — arXiv 2606.08625
- "LLM Essay Scoring Under Holistic and Analytic Rubrics: Prompt Effects and Bias" — arXiv 2604.00259
- AWS `sample-GEDD`, "Cohen's Kappa for LLM Judges" — github.com/aws-samples/sample-GEDD
- Galileo, "How to Calibrate Your LLM Judge With Human Annotations" — galileo.ai/blog/calibrate-llm-judge-human-annotations
- Galtea, "LLM as a Judge prompts: templates, rubrics, and best practices" — galtea.ai/blog
- Openlayer, "LLM-as-judge: A complete guide to evaluation best practices" (March 2026)

**Coaching and feedback**
- Kluger, A. N., & DeNisi, A. (1996). "The effects of feedback interventions on performance." *Psychological Bulletin*, 119(2), 254–284
- Sailer et al. (2017), "How gamification motivates," *Computers in Human Behavior* — ScienceDirect S074756321630855X
- "How leaderboard positions shape our motivation," *Internet Research* 33(7), Emerald
- JMIR Serious Games (2021) on macro-leaderboard harm to lower performers, via Yu-kai Chou / Octalysis
- MySalesCoach 2026 sales coaching statistics (3,700+ respondents) — mysalescoach.com/sales-coaching-statistics
- CSO Insights / Korn Ferry Sales Enablement studies (vendor-published, correlational)

**Vendor landscape**
- Gong Help Center, "How to create and manage scorecards" — help.gong.io/docs/create-and-manage-scorecards
- Gong community (visioneers.gong.io) — AI Call Reviewer host-scoring limitations, overlapping-stream scorecard behaviour
- Pricing ranges triangulated across Claap, MarketBetter, RevenueGrid, Nimitai, Sybill, Airspeed, LeadHaste (2026) — all competitor-published; reported where independent sources converge

**Architecture**
- Google Sheets limits: 10M cells/spreadsheet, 18,278 columns, 50,000 chars/cell
- Apps Script quotas 2026: 6-minute execution cap (30-minute tier retired), per-service daily quotas, concurrent execution limits — dev.to and ModelMonkey 2026 quota guides
- MageSheet, "Building Production Apps with Google Apps Script" — LockService, checkpointing, concurrency failure modes

**Legal**
- Paul Hastings, "AI Transcription Tools: When a Robot Is Listening, Courts May Find It Is Wiretapping" (April 2026)
- Mayer Brown, "AI Notetakers: Productivity Tool or Emerging Legal Risk?" (June 2026)
- *Insurance Marketing Coalition Ltd. v. FCC* (11th Cir., 24 Jan 2025) — via Morrison Foerster, Wiley, Venable client alerts
- All-party consent state list and *Kearney v. Salomon Smith Barney* interstate rule
- FTC Telemarketing Sales Rule, 16 CFR Part 310 (amended record-retention: five years)

**Measurement**
- MET Project, "The Reliability of Classroom Observations by School Personnel" (Gates Foundation)
- "Reliability analysis of the objective structured clinical examination using generalizability theory" — PMC4991996
- "Using Generalizability Theory to Investigate the Reliability of Learning Environment Quality Ratings" — Society for the Scientific Study of Reading
