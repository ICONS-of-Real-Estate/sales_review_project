# Deep research prompt: improving an AI-graded sales call QA + coaching system

## Context

I run a small real estate lead-generation business (a podcast-style lead-gen
show, "ICONS 100", plus outbound sales). I've built an internal system that:

1. **Transcribes every sales call** (Zoom/Riverside recordings → Whisper-based
   transcription pipeline).
2. **Grades each call with an LLM-as-judge** against a rubric tailored to
   each rep's actual role — most reps are closers judged on discovery,
   objection handling (Agree/Isolate/Repeat), and asking for the close; one
   rep runs the podcast and books next-step calls for others rather than
   closing himself, so he has a different rubric (book-a-next-step, not
   ask-for-money).
3. **Writes every graded call into a spreadsheet** ("Sales Call Log") that
   is the system of record — one row per call, ~20 columns including lead
   quality verdict, a 1-5 call quality score, boolean flags, a primary
   failure mode classification, a severity score, and a free-text AI
   feedback summary.
4. **Flags some calls for manual human review** (a severity/confidence
   heuristic), which the business owner works through and records
   agree/disagree verdicts on — those verdicts feed a weekly calibration
   check against the model's own judgment.
5. **Runs a daily self-practice loop**: each rep gets a daily assignment
   (record a video drilling a specific objection or a close-ask, based on
   what their last real training call surfaced as weak), an LLM grades
   the practice recording, and a compliance checker nags reps by email if
   the file doesn't show up.
6. **Produces weekly scorecards** per rep, emailed automatically.
7. Surfaces all of the above in a small internal **read-only dashboard**
   (FastAPI + SQLite mirror of the sheet, Google Workspace SSO-gated):
   per-rep trend charts, a review queue, full-text search over feedback
   summaries, a leaderboard, and playbook pages.

Technically: Google Apps Script is the orchestration layer (reads/writes the
sheet, sends email, manages Drive folders, triggers), calling an LLM
directly (no agent framework) for every judging step. The dashboard is a
separate read-only FastAPI app syncing from the same sheet every few
minutes. Total team size is small — a handful of reps, one person (me)
doing all review and coaching.

## What I want researched

I'm not asking you to write code — I want a **research report with concrete,
actionable, prioritized recommendations**, each with enough reasoning that I
can decide whether to act on it. Please cover:

### 1. LLM-as-judge reliability for subjective sales coaching
- What does the current literature/practitioner consensus say about
  making an LLM-as-judge scoring pipeline *trustworthy* for something this
  subjective (call quality, objection handling)? Known failure modes,
  calibration techniques, inter-rater-reliability analogues, how much
  human spot-checking is actually enough, and how to detect model drift
  over time (e.g. after a model version change).
- Is a single holistic 1-5 score the right unit, or would rubric-level
  sub-scores (discovery, objection handling, close) that roll up produce
  more actionable coaching signal *and* better auditability?
- Best practices for prompt-engineering a judge that must apply genuinely
  different rubrics to different roles without the rubrics silently
  bleeding into each other (a real bug I hit: a lead-gen/booking rep was
  initially graded against a closer's rubric).

### 2. Sales coaching program design for small teams
- What separates sales coaching programs that actually change rep
  behavior from ones that produce reports nobody acts on? Specifically
  for daily/weekly cadences like mine (daily drill + weekly scorecard).
- How should "assign remedial practice based on last real call's weakest
  area" be tuned so it doesn't become repetitive/demoralizing, and how do
  well-run sales orgs balance positive reinforcement vs. deficit-focused
  coaching in an automated feedback loop?
- Gamification / leaderboard design pitfalls for a team this small (a
  leaderboard among 3-4 people can backfire very differently than one
  among 30).

### 3. Build vs. buy
- Given this scope (a handful of reps, real estate lead-gen/sales,
  transcript-based QA), is there a mature commercial conversation
  intelligence / call-scoring platform (Gong, Chorus, Wingman/Clari,
  etc., or smaller/cheaper alternatives) that would cover most of this
  out of the box more reliably than a homegrown Apps Script + LLM
  pipeline, and at what price point does that become worth it vs.
  continuing to maintain this in-house? What do those platforms do for
  rubric customization per-role, which is my most unusual requirement?

### 4. Data/architecture risks worth knowing about now
- Known risks of using a Google Sheet as a system of record for something
  this write-heavy and multi-process (8 separate automation phases
  reading/writing the same sheet) — at what row/edit-frequency count do
  these setups typically start breaking down, and what's the standard
  next step (a real database) look like for a team this size?
- Anything specific to using an LLM judge on recorded sales calls that
  touches on data privacy / call-recording consent law I should be aware
  of (I'm US-based, real estate industry) — not asking for legal advice,
  just what to go verify with an actual lawyer.

### 5. What I'm not measuring yet
- Given everything above, what's the most common metric or feedback loop
  that systems like this *should* have but often miss — e.g. correlating
  call-quality score against actual close rate / revenue outcome (which
  I don't currently do), rep-level trend analysis beyond week-over-week,
  or something else entirely?

## Output format

A written report, organized by the five sections above, each with:
- The actual recommendation(s), ranked by expected impact vs. effort.
- Brief reasoning / evidence for each (cite real sources where you can —
  vendor docs, practitioner blog posts, research papers, whatever's
  credible).
- Explicit call-outs where the honest answer is "it depends" and what it
  depends on.

Do not assume I want to rebuild anything — flag build-vs-buy honestly even
if the answer is "keep what you have, it's fine for this scale."
