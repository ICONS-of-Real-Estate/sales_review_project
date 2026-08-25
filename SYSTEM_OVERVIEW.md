# System Overview — Sales Call Review & Coaching Automation

> What this whole thing is, why it exists, and how the pieces fit together.
> Written as a single reference doc so a new engineer (human or AI) can get
> oriented without reading `brief.txt`, `Phase2_CallGradingSOP.md`, and 8
> `.gs` files end to end. Those documents remain the source of truth on
> details — this is the map, not the territory.

## 1. What we're trying to achieve

Icons of Real Estate sells podcast production services to real estate
agents. A small sales team (Bens, Joana, Sean, and Tomás as closer/trainer)
runs a high volume of sales calls, and Kris (CEO) wants two things that
don't scale by hand once call volume is high:

1. **Know which calls are going wrong, and why, without listening to every
   call.** Two specific failure modes matter, grounded in real sales
   methodology (SPIN Selling / Challenger Sale / MEDDIC — see `brief.txt`):
   - The rep never actually asked for the close (a real "will you move
     forward," not a soft trial-close question).
   - Objections weren't surfaced, or were surfaced but not answered with
     anything concrete.
2. **Turn that signal into actual coaching**, not just a score — daily
   practice drills, weekly scorecards, handoff briefs between funnel
   stages, and (the newest piece) a real training playbook extracted from
   Tomás's own best calls, since he's the team's strongest closer and his
   technique is otherwise only in his head.

Everything below is deterministic Apps Script glue wrapping a small number
of LLM "judgment" calls — the design brief's explicit principle is: **Apps
Script does all deterministic work (reading Calendar/Sheets, date math,
email, matching); the LLM only ever judges quality/content**, never touches
scheduling, matching, or sending logic. This keeps the system debuggable —
if a wrong email goes out, it's a deterministic bug, not model
unpredictability.

## 2. The two raw-material pipelines

Before anything can be scored, a call has to become text.

**Transcription (Python, runs on an OVH VPS, not Apps Script):**
- Reps record calls on Zoom (Sean, Joana) or Riverside (Tomás, Bens — plus
  Bens' legacy Zoom backlog).
- `tools/transcribe_<rep>_calls.py` scripts scan each rep's Drive folder
  (recursing into subfolders), download new videos, transcribe them
  (primarily Gemini's video-understanding, with Whisper/Qwen as cheaper
  fallbacks — Qwen is cheap but has no speaker diarization), and save a
  `"<call name> — Transcript"` Google Doc next to the source video.
- Downloaded videos are deleted locally right after transcribing; a
  Drive-based lock prevents two runs from double-transcribing the same
  file if multiple machines/cron jobs run concurrently.
- `transcribe_all.py` / `transcribe-all.service` (systemd) runs this for
  Sean, Joana, and Tomás together on a schedule; Bens' daily-practice and
  training-call folders have their own equivalent tooling (Phase 7/6 below
  read Zoom's own auto-generated `.vtt` transcripts directly for training
  calls, so no separate transcription step is needed there).
- **Known gap (found 21/08/2026):** a small number of source recordings
  produce empty (`[BLANK_AUDIO]`) or corrupted (repeating-text-loop)
  transcripts — a transcription-pipeline failure mode, not a scoring
  problem. Worth monitoring for on any future dashboard.

**Riverside transcripts (manual, no sync job):**
- Bens' calls are recorded on Riverside and arrive already transcribed, so
  there is no raw-video folder and no transcription step for him. He
  downloads the `.txt` transcripts himself into a Drive folder
  (`PHASE2_CONFIG.LEGACY_FOLDERS.Bens`), which Phase 2 scores in batches via
  `scoreBensLegacyTranscripts()`.
- An automated Riverside pull (`Phase0_RiversideSync.gs`) was built and then
  **deleted on 21/08/2026** — Riverside's API is Business-plan-only. Nothing
  depends on it; don't recreate it unless that plan is upgraded. See
  `HANDOFF.md` §1.

## 3. The data spine — "Sales Call Log"

One shared Google Sheet
(`1bK0VbgP3xdK5LhfYqO0fps9ivJzPDn3fsDcsl1dEBM4`) is the single source of
truth every phase reads and writes. Key columns (see `brief.txt` §2 for the
full schema): Prospect Name/Email, Rep, Call Type, Call Date, Outcome
Disposition, Calendar Event ID, Transcript URL, Match Method, Lead Quality
Verdict, Call Quality Score, the two failure-mode flags, Manual Review
Recommended, Severity, AI Feedback Summary, Reviewed By, Queue Age,
Kris Manual Review Verdict, Primary Failure Mode.

A call only becomes eligible for AI scoring once it has a logged Outcome
Disposition **and** a matched transcript — this gate is itself
deterministic (Phase 1's job).

## 4. The eight Apps Script phases

All eight live in one Apps Script project (bound via `clasp` — see
`CLAUDE.md` for the deploy procedure), share global scope (no imports
needed between `.gs` files), and are each gated by their own
`<PHASE>_CONFIG.ENABLED` flag so a phase can be built and previewed without
going live.

| Phase | File | What it does |
|---|---|---|
| 1 | `Phase1_ComplianceCheck.gs` | Deterministic: did each rep log an outcome for every calendar sales/QC call from the prior business day? If not, nudge email (CC Kris, Tomás). No LLM. Also home to `installAllReadyTriggers()`, the single "reinstall every enabled phase's triggers" entry point. |
| 2 | `Phase2_CallScoring.gs` | The core AI grader. Two-pass judgment call (lead-quality verdict, then call-quality score + failure-mode flags) against a shared rubric — with a **stricter Sean-specific variant** (did he close the money or book a second call with Tomás?) and a **Tomás-specific variant** that also extracts `teachable_strength`/`coach_this` per call, since his calls double as training material. Also owns the review-queue builder (3 calls/day, clustered by rep) and the weekly calibration job against Kris's own manual verdicts. |
| 3 | `Phase3_HandoffBrief.gs` | ~24h before a rep's next call with a known prospect, emails them a synthesized brief of what happened last time — goals stated, how the offer was pitched, unresolved objections — pulled fresh from the prior transcript, not the terse feedback column. |
| 4 | `Phase4_InboxSLA.gs` | Checks Sean's and Bens' inboxes (via a domain-delegated service account, since GmailApp can't impersonate other mailboxes) for anything unanswered >24h; nudges. |
| 5 | `Phase5_WeeklyScorecard.gs` | Every Monday, emails each rep their week's scores, all-time average, and their single most common failure mode as "priority to improve" — timed to land before Tuesday's 1:1 training call. |
| 6 | `Phase6_TrainingCallReview.gs` | Grades Tomás's 1:1 coaching calls with each rep (reads Zoom's own `.vtt` transcript) and turns that into next week's practice-drill assignment. |
| 7 | `Phase7_DailySelfPractice.gs` | Assigns each rep a daily solo objection-drill (drawn from Phase 6's output), grades their uploaded practice video's transcript, nags every 12h until done. |
| 8 | `Phase8_ReplyTracker.gs` | Reports on cold-outreach reply/booking rates funneled through Joana's inbox. Partially complete — booking-percentage reconciliation needs one more answer from Kris on tracker tab names. |

**The training/playbook layer (new, 21/08/2026, not yet a Phase file):**
Separate from live scoring, `Objection_Handling_Playbook.md` (Bens),
`Objection_Handling_Playbook_Sean.md` (Sean), and `Tomas_Playbook.md`
(what to copy from Tomás) are living reference documents built by deep
transcript review rather than the per-call scoring pipeline — the answer
key behind the objection-handling flags, and (for Tomás) a direct
extraction of his best technique for training the rest of the team. These
are meant to be read by humans in a coaching session, not consumed by
another script — but they're an obvious candidate for surfacing on a
dashboard (see below).

## 5. Where the LLM sits

All judgment calls go through Moonshot's Kimi API directly (no proxy
despite legacy "LiteLLM" naming in config) — confirmed live model id is
`kimi-k3` (docs/brief historically said `kimi-k2.6`; that name is stale).
Hard constraint: this model **must** run at `temperature=1` — any other
value fails every call silently while the run reports success. Expect
markdown-fenced JSON even at temp=1; every call site does defensive parsing
(strip fences, retry once with an explicit "raw JSON only" reminder, then
route to manual review rather than dropping the row).

## 6. Rollout discipline

Every phase follows the same pattern before going live: build behind
`ENABLED = false`, run a `preview*()` function (read-only, no sends) and
confirm the output looks right, then flip the flag. `PHASE2_CONFIG.
SHADOW_MODE` additionally gates the AI scoring pipeline specifically:
score everything, but don't email Kris, until the model's
`manual_review_recommended` verdict hits ≥80% agreement with Kris's own
judgment on a real batch (tracked via `Kris Manual Review Verdict` and the
weekly calibration job).

## 7. Deploy mechanics (for reference — see `CLAUDE.md` for the live procedure)

Code lives in this GitHub repo and is bound to the real Apps Script project
via `clasp`. The loop is: commit/push to `main` → `git pull` + `clasp push`
on whichever machine holds the real `.clasp.json` → if any phase's trigger
schedule changed, re-run `installAllReadyTriggers()` from the Apps Script
editor (triggers don't self-update when code changes). Never edit
`ENABLED` flags or code in the Apps Script browser editor directly — the
next `clasp push` silently reverts it.

## 8. What does NOT exist yet (the gap this next project is meant to fill)

Right now, "seeing how the system is doing" means opening the Sales Call
Log spreadsheet directly, reading Apps Script execution logs, or reading
the markdown playbooks in the repo. There is no dashboard, no visual trend
of scores over time, no single place a rep can go to see their own
scorecard history, upcoming practice assignments, and the training
playbooks together. That's the next piece: a web application, hosted on
the team's own OVH Cloud server, that turns this same data (Sales Call Log
rows, playbook markdown, training-cycle state) into something visual and
easy for every team member to check.

The brief for researching that piece — data-access strategy, stack, auth,
hardening, deploy model — is checked in as `Dashboard_Research_Prompt.md`.
