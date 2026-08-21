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
- Get Tomás's sign-off on the 3 `FEW_SHOT_ANCHORS` excerpts in
  `Phase2_CallScoring.gs` (draft email sent to him this session, cc Kris —
  check it was actually sent, it landed in a draft under Joana's connected
  mailbox rather than Kris's own, per this session's Gmail-connector mixup).
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
