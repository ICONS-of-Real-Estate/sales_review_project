# GHL_PIPELINE_MAP.md — GoHighLevel pipeline survey

Reference map of the GoHighLevel (GHL) CRM sub-account "Icons of Real
Estate", surveyed 27/08/2026. Same role as `SYSTEM_OVERVIEW.md` for the
Apps Script side: read this before designing or changing anything that
touches GHL, so the structure doesn't have to be re-derived from
screenshots every session.

## How this was captured (and what that means for the numbers)

Captured by reading the GHL Opportunities board directly (screenshots),
**not** via the API — no API credential existed at survey time. Two
caveats follow from that:

1. **Counts are a point-in-time snapshot** (27/08/2026) and will drift.
   Treat them as proportions and orders of magnitude, not live figures.
2. **Every board had an "Advanced filters (1)" chip active.** The filter's
   contents were not inspected, so each pipeline's true total may be
   higher than what's recorded here. Per-stage counts summed exactly to
   each board's stated total in all five non-empty pipelines, so the
   numbers are at least internally consistent — but they are consistent
   *within* whatever that filter admits.

Re-verify against the API before any number here is used for reporting.

## Pipeline & stage IDs (API-confirmed, 28/08/2026)

Captured via `previewGhlConnection_()` (`Phase9_GhlSync.gs`), a real
authenticated call against `GET /opportunities/pipelines`. These IDs are
what any stage -> Outcome Disposition sync must be built against — names
can be renamed in the GHL UI at any time, IDs can't.

**The API returned only 5 of the 6 pipelines below — "Icons Remarketing
72026" did not come back.** Not a concern: that pipeline was already
confirmed empty (0 opportunities, template-default stages) in the
screenshot survey above. Either GHL's API excludes empty pipelines, or
this token's permissions don't extend to it (a per-pipeline "Manage
permissions" option exists in the GHL settings menu). If it's ever
populated, re-run the probe to pick up its ID.

| Pipeline | Pipeline ID |
|---|---|
| Cold Calling | `vbYzOZ1s0ipPKAZ7PPUT` |
| Cold Calling 2 | `3JsTXN1uJWUL0o5393VO` |
| ICONS Podcast | `IVdbfrBHzxXj1lIhs2kF` |
| Remarketing Pipeline (2026) | `QLsTzwdOdWSg5cgGJfij` |
| SALES CALL pipeline | `M7O9ZsPmczMyS7oP9m85` |
| Icons Remarketing 72026 | not returned by the API — see above |

### Cold Calling (`vbYzOZ1s0ipPKAZ7PPUT`)

| Stage | Stage ID | Outcome Disposition |
|---|---|---|
| Callback | `a592af20-39f4-4b10-a4af-203904f60650` | Follow-up |
| Qualification Call Booked | `c2244a73-2f06-492a-8951-538e4bcaa885` | (none inferred) |
| Qualification Call Not Taken | `42dd4243-af6b-4073-a2ee-8b1eca2a5eea` | No-show |
| Qualification Call Taken (No SC) | `1709fe35-07ff-4580-b196-cf60fdf691e1` | (none inferred) |
| Qualification Call Reschedule | `c43249a6-d935-4ca2-a3c8-86d6300ed492` | Follow-up |
| Sales Call Booked | `d31b5cb3-e61a-4af8-be23-916a28c032b5` | (none inferred) |
| Sales Call Not Taken | `83beda8d-11c7-4f15-967a-dc9a98ae0501` | No-show |
| Need to Reschedule | `e45f8abb-534f-4f37-8a67-1eec33898866` | Follow-up |
| Sales Call Taken | `8438974d-b7b3-43b9-98d3-0653810d1e40` | (none inferred) |
| Failed Deal Form Filled | `6b598727-ecfd-41d2-8640-059a05320207` | (none inferred) |
| 2nd Zoom Call | `8f88ead9-2624-4b1e-bec8-dfe0b96a8cb9` | (none inferred) |
| 2nd Call Taken | `314a2b14-e5a6-4883-8edf-78b5f0a44efa` | (none inferred) |
| 2nd Call Not Taken | `f1f82b9e-4d50-447f-852d-3a0a8d3a8ed9` | No-show |
| Closed Won | `b2e74e82-9793-492d-8521-2a2f2453d3e0` | Sold |

### Cold Calling 2 (`3JsTXN1uJWUL0o5393VO`)

| Stage | Stage ID | Outcome Disposition |
|---|---|---|
| Qualification Call Booked | `d1dc6fa8-da01-4383-b19b-0cdf4465355f` | (none inferred) |
| Qualification Call Not Taken | `0d5da1d2-7711-4c8d-8923-a0b382b19e6d` | No-show |
| Qualification Call Taken (No SC) | `e79678dd-1079-45f8-adf3-f7fc4998651d` | (none inferred) |
| Qualification Call Reschedule | `a7f7a839-647d-45f7-a9f9-36ea7aff0085` | Follow-up |
| Sales Call Booked | `2dff7aea-9bd4-411a-8f14-1bd9cbae7d45` | (none inferred) |
| Sales Call Not Taken | `775c6844-49a9-4705-9357-ad5d09858e95` | No-show |
| Need to Reschedule | `fa29893f-b8a1-4a10-8020-05640a9e4427` | Follow-up |
| Sales Call Taken | `606dde8e-d719-4f59-a1b4-13fed99532e5` | (none inferred) |
| Failed Deal Form Filled | `4d469ac9-20cf-4975-b6ef-6337fbe5c9c7` | (none inferred) |
| 2nd Call Booked | `de4292ec-e876-48bf-ba15-4104abcea787` | (none inferred) |
| 2nd Call Not Taken | `d57bbc85-4632-41d9-8cc2-489fcff17126` | No-show |
| 2nd Call Taken | `22d49a64-1de6-4ebd-a15f-5573bd1675bd` | (none inferred) |
| Closed Won | `1ef5a5e6-df39-42da-aea9-308adf89aec1` | Sold |

### ICONS Podcast (`IVdbfrBHzxXj1lIhs2kF`)

| Stage | Stage ID | Outcome Disposition |
|---|---|---|
| Pre-Interview Booked | `fdd38cf6-4065-40e2-8048-202186e281a2` | (none inferred) |
| Pre-Interview Reject | `fe481b26-7b71-4ec2-912d-89a42cc3e132` | (none inferred) |
| Podcast Booked On Calendar | `1bdb0788-3fbf-45d0-ab01-20cf95b41bd2` | (none inferred) |
| No Show | `c749ed4f-ae9f-4713-bfd6-5f58d81af1c9` | No-show |
| Podcast Recorded | `088d2b19-d0fd-4f45-816c-10685e7078b6` | (none inferred) |
| Sales Call Booked | `7e26252a-5ac2-4f5f-9757-eca1ff9efdf2` | (none inferred) |
| Sales Call No-Show | `e97e0b4d-da2a-4983-adbd-87d5c04cf815` | No-show |
| Sales Call Taken | `386e3e94-cfdd-4493-ab42-f5c0b9bf6f3d` | (none inferred) |
| Second Sales Call Booked | `5dbc8733-4b29-4cdf-998e-3bdc8530649b` | (none inferred) |
| Second Sales Call No-Show | `bb2c3d48-64b3-4767-b1af-9708f6defb42` | No-show |
| Second Sales Call Taken | `f069a8c7-d311-4e21-a7e0-3c63295a4be0` | (none inferred) |
| Moving Forward Later | `4be6b62c-b015-4e44-9b75-8cac16948b64` | Follow-up |
| Discovery Call Booked | `7406e9d3-8933-47d7-a273-a934e75068ff` | (none inferred) |
| Discovery Call Not Taken | `4ccb1247-cdd2-4d2d-b193-6f52bb764578` | No-show |
| Discovery Call Taken | `219a98a7-93e0-4b7b-a990-26ac508ffd08` | (none inferred) |
| Closed won | `8186be96-1f67-40bd-9cd6-4cb097e010ef` | Sold |
| Closed lost | `78186d1f-2820-4de9-a442-ceedb2ec6910` | Not Sold |

### Remarketing Pipeline (2026) (`QLsTzwdOdWSg5cgGJfij`)

| Stage | Stage ID | Outcome Disposition |
|---|---|---|
| Contact Registered | `b4650bc4-7db0-4ccb-aa1f-26a7894d7001` | (none inferred) |
| Framework Downloaded | `905bd11b-8e93-48fa-a384-f7744ca5559c` | (none inferred) |
| Not Qualified/Valid | `3ba0153b-6aaf-4bb7-af31-3d7913e5057b` | (none inferred) |
| Assigned to Setter | `6a401973-7398-4fcf-a780-51ef84773175` | (none inferred) |
| Dial 1 | `24c05708-0bf3-455f-ad36-b1e0d2a89c31` | (none inferred) |
| Dial 2 | `6cea8555-1e80-4b87-80ac-9a05ef345057` | (none inferred) |
| Dial 3 | `d1f6626d-3ec1-436d-a07f-537a8edddc59` | (none inferred) |
| Social Media DM | `7242e55b-7184-49c7-bfa2-71c459ac5d22` | (none inferred) |
| Tomas Email | `1c3ae194-d035-4523-9f47-1efa66496f59` | (none inferred) |
| Qualification Call - Booked | `63ee6b6e-0892-4d56-9c3d-0b70eda3cf6b` | (none inferred) |
| Qualification Call - No Show | `8710628c-4ec3-47a9-b3cd-cea06ce3ee0c` | No-show |
| Qualification Call - Taken | `8b8751c2-6c53-4447-8746-3fdf466d820f` | (none inferred) |
| Sales Call - Booked | `c5aa687c-4721-468f-8153-bb766e5291ff` | (none inferred) |
| Sales Call - No Show | `d406e9ef-0f99-494c-a70c-092526bcb258` | No-show |
| Sales Call - Taken | `6828a071-1785-45be-ac39-8fe4a29caace` | (none inferred) |
| Closed Won | `c7214db1-72c3-49b7-b4b0-ec182feb45de` | Sold |

### SALES CALL pipeline (`M7O9ZsPmczMyS7oP9m85`)

| Stage | Stage ID | Outcome Disposition |
|---|---|---|
| Framework Downloaded | `717cd6f2-03fc-49e6-b81a-d86ee5bddfe4` | (none inferred) |
| Sales Call - Booked | `56c8783b-c960-43a4-90fe-db5581725326` | (none inferred) |
| Sales Call - No Show | `0e6fe4e8-c741-4132-ab45-f847088c579b` | No-show |
| Sales call - Reschedule | `3f62653d-38f1-409f-b892-3a54981bd1a5` | Follow-up |
| Sales Call - Taken | `12400c3f-d8c1-451e-95e7-3f30451e7959` | (none inferred) |
| Closed Won | `b3a5403b-833b-41ce-8b0f-952e2a522adb` | Sold |

## Pipeline summary

| # | Pipeline | Opportunities | Stages | State |
|---|---|---|---|---|
| 1 | ICONS Podcast | 946 | 17 | Active — the core funnel |
| 2 | Cold Calling 2 | 638 | 13 | **Frozen** — 97% stuck in stage 1 |
| 3 | Cold Calling | 305 | 14 | Active |
| 4 | SALES CALL pipeline | 295 | 6 | Active |
| 5 | Remarketing Pipeline (2026) | 125 | 16 | **Stalled** — 87% never reach a call, 0 closed |
| 6 | Icons Remarketing 72026 | 0 | 4 | Empty — template defaults, never used |

Total: ~2,309 opportunities.

**The "Updated on" column in GHL's pipeline list is the stage-config edit
date, not a usage signal.** "SALES CALL pipeline" showed Dec 2024 yet holds
295 live opportunities; "ICONS Podcast" showed Jun 2025 and holds 946.
Never infer a pipeline is dead from that column.

---

## 1. ICONS Podcast — 946 opportunities, 17 stages

The main funnel: guest interview → recording → sales call → close.

| Stage | Count |
|---|---|
| Pre-Interview Booked | 35 |
| Pre-Interview Reject | 1 |
| Podcast Booked On Calendar | 70 |
| **No Show** | **373** |
| Podcast Recorded | 115 |
| Sales Call Booked | 0 |
| Sales Call No-Show | 133 |
| Sales Call Taken | 113 |
| Second Sales Call Booked | 1 |
| Second Sales Call No-Show | 26 |
| Second Sales Call Taken | 7 |
| Moving Forward Later | 15 |
| Discovery Call Booked | 0 |
| Discovery Call Not Taken | 10 |
| Discovery Call Taken | 5 |
| Closed won | 33 |
| Closed lost | 9 |

Notes:
- **"No Show" (373) is the single largest stage in the entire CRM** — 39%
  of this pipeline.
- "Podcast Recorded" (115) ≈ Bens' 114 scored calls in the Sales Call Log.
  Good sign the transcription/scoring pipeline keeps pace with this stage.
- Both "…Booked" holding stages read 0 while their downstream
  Taken/No-Show stages hold hundreds. Either bookings are moved out of the
  booked stage immediately, or that stage isn't used as a waiting state.
  **Open question** — it matters, because "currently booked" is the state
  a chase/reminder feature would key off.

## 2. Cold Calling 2 — 638 opportunities, 13 stages

| Stage | Count |
|---|---|
| **Qualification Call Booked** | **619** |
| Qualification Call Not Taken | 12 |
| Qualification Call Reschedule | 2 |
| Sales Call Booked | 3 |
| Sales Call Taken | 1 |
| Closed Won | 1 |
| Qualification Call Taken (No SC) | 0 |
| Sales Call Not Taken | 0 |
| Need to Reschedule | 0 |
| Failed Deal Form Filled | 0 |
| 2nd Call Booked / Not Taken / Taken | 0 each |

**97% of this pipeline is frozen in the first stage.** Its stage structure
is a near-duplicate of "Cold Calling" (below), which is actively
distributed across all stages — so this reads as the abandoned
predecessor, consistent with its Nov 2025 config-edit date.

**Open question for Kris:** are those 619 "Qualification Call Booked"
leads real bookings that silently died, or an import artifact? 619 is too
many to leave unexplained, and the answer changes whether this is a
cleanup job or a recoverable backlog.

## 3. Cold Calling — 305 opportunities, 14 stages

| Stage | Count |
|---|---|
| Callback | 1 |
| Qualification Call Booked | 54 |
| Qualification Call Not Taken | 75 |
| Qualification Call Taken (No SC) | 8 |
| Qualification Call Reschedule | 28 |
| Sales Call Booked | 3 |
| Sales Call Not Taken | 60 |
| Need to Reschedule | 5 |
| Sales Call Taken | 42 |
| Failed Deal Form Filled | 1 |
| 2nd Zoom Call | 10 |
| 2nd Call Taken | 5 |
| 2nd Call Not Taken | 2 |
| Closed Won | 11 |

Healthy distribution across the whole funnel — this is the live cold-call
pipeline. **135 of 305 (44%) are "Not Taken"** at some stage (75
qualification + 60 sales).

## 4. SALES CALL pipeline — 295 opportunities, 6 stages

| Stage | Count |
|---|---|
| Framework Downloaded | 13 |
| **Sales Call - Booked** | **232** |
| Sales Call - No Show | 4 |
| Sales call - Reschedule | 4 |
| Sales Call - Taken | 29 |
| Closed Won | 13 |

The simplest pipeline, and the one whose stages map most directly onto
what the Sales Call Log tries to track. 232 currently booked is the
largest live "pending" block anywhere in the CRM.

Cross-checked against our own data: **Nicole Freed** appears here in
"Sales Call - Booked", and is the same prospect as the Bens→Joana handoff
brief (QC 17/08 → Sales Call 25/08). Confirms GHL opportunities correspond
1:1 with real scored calls in our system.

## 5. Remarketing Pipeline (2026) — 125 opportunities, 16 stages

Meta/Facebook ads leads (per Kris). Source field is almost entirely
"Facebook", with some "5 Podcast Frameworks Leads".

| Stage | Count |
|---|---|
| Contact Registered | 25 |
| Framework Downloaded | 3 |
| Not Qualified/Valid | 6 |
| Assigned to Setter | 21 |
| **Dial 1** | **60** |
| Dial 2 | 0 |
| Dial 3 | 0 |
| Social Media DM | 0 |
| Tomas Email | 0 |
| Qualification Call - Booked | 0 |
| Qualification Call - No Show | 2 |
| Qualification Call - Taken | 1 |
| Sales Call - Booked | 3 |
| Sales Call - No Show | 2 |
| Sales Call - Taken | 2 |
| **Closed Won** | **0** |

This is the pipeline Kris specifically asked to monitor ("make sure they
are chased"). Three findings:

1. **The escalation ladder has never been used once.** Dial 2, Dial 3,
   Social Media DM, and Tomas Email all hold zero opportunities — ever. A
   proper multi-touch chase sequence exists as pipeline design and only
   the first rung is in use.
2. **109 of 125 (87%) never reach a call.** 25 registered but never
   assigned → 3 downloaded the framework and got nothing → 21 assigned to
   a setter but never dialed → 60 dialed once with no recorded second
   attempt. Only 6 are legitimately screened out (Not Qualified/Valid).
3. **Zero closed.** 10 leads reached a call stage; none closed.

## 6. Icons Remarketing 72026 — 0 opportunities, 4 stages

New Lead → Contacted → Proposal Sent → Closed. Generic template defaults,
never used. Safe to ignore or delete.

---

## Cross-cutting findings

### A. No-shows dominate, and are invisible to our system

| Pipeline | No-show / not-taken |
|---|---|
| ICONS Podcast | 373 + 133 + 26 + 10 |
| Cold Calling | 75 + 60 + 2 |
| Cold Calling 2 | 12 |
| Remarketing 2026 | 2 + 2 |
| SALES CALL pipeline | 4 |

The Sales Call Log only ever contains calls that **happened and were
transcribed**. Every no-show is structurally absent from our dashboard —
so the single biggest failure mode in the business does not appear in any
metric the system currently produces. This is the largest gap the GHL
connection could close, and it has nothing to do with call scoring.

### B. The same lead exists in multiple pipelines, under name variants

Confirmed from the boards:

| Lead | Appears in |
|---|---|
| Steve Rath | Cold Calling (Callback) + Remarketing 2026 (Assigned to Setter) |
| Pamela Flitton / **Pam** Flitton | Cold Calling (Closed Won) + ICONS Podcast (Closed won) |
| Dee Brummett / **Deana** Brummett | Cold Calling (Closed Won) + ICONS Podcast (Closed won) |

Two consequences:

- **Summing Closed Won across pipelines overstates real deals.** Naive
  total is 33 + 13 + 11 + 1 = 58; at least two of those are the same
  humans counted twice.
- **Name-only matching to the Sales Call Log will be fragile** — the exact
  class of problem `normalize_()` and the fuzzy filename matching in
  `Phase2_CallScoring.gs` already exist to fight.

### C. There are people running calls that our system doesn't model

`CONFIG.REPS` (`Phase1_ComplianceCheck.gs`) contains Bens, Joana, Sean,
Tomás. The GHL boards show:

- **Source values** naming **Bruno**, **Simon**, and **Ty** — e.g.
  "Podcast Chat with Bruno…", "Chat with Simon – Qualificat…", "Podcast
  Production with Ty". Bruno appears frequently across Cold Calling.
- **At least six distinct assignee avatars** — SC, JP, BO, PC, KD, AA.
  SC handles most of the Remarketing pipeline.

Either these are setters whose calls are deliberately out of scope for
scoring, or our rep list is incomplete. **Open question for Kris** — it
determines whether whole categories of calls are silently unscored.

### D. Our rows have no email, so joining on email needs a backfill first

The legacy backfill (`scoreLegacyTranscriptFolder` and the per-rep
equivalents in `Phase2_CallScoring.gs`) writes `''` into Prospect Email on
every row — all 439 scored rows have a blank email. GHL has a real email
per contact.

So a GHL join can't use email today, but **GHL can supply the email that
makes email a stable join key from then on**. That's likely the correct
first sync step, ahead of anything else.

---

## Mapping GHL stages onto Sales Call Log concepts

### Outcome Disposition (currently 100% manual, 0% filled in)

`Outcome Disposition` is the column the Manual Review Guide calls "the
single most important column for you to fill in" — nothing in the pipeline
writes it, and as of 25/08 essentially none of it is filled. **GHL already
knows this automatically**, as stage membership:

| GHL stage pattern | Outcome Disposition |
|---|---|
| `Closed won` / `Closed Won` | Sold |
| `Closed lost` | Not Sold |
| `* No Show`, `* No-Show`, `* Not Taken` | No-show |
| `* Reschedule`, `Need to Reschedule`, `Callback`, `Moving Forward Later` | Follow-up |
| `* Taken`, `Podcast Recorded` | call happened — disposition depends on a later stage |
| `* Booked` | pending — no disposition yet |

This is the highest-value, best-scoped sync available: **populate Outcome
Disposition from GHL stage instead of asking humans to type it.** It turns
a 0%-filled column into a near-complete one without changing anyone's
workflow, and it's what makes the dashboard's funnel numbers mean
anything.

### Call Type

| GHL stage / source | Call Type |
|---|---|
| Pre-Interview Call, ICONS Podcast Recording, Icons 100 – Podcast Rec… | the Bens interview (`icons_100_interview` in his rubric) |
| Qualification Call *, Podcast Qualification Zoom | QC |
| Sales Call * | Sales Call |
| Discovery Call * | Discovery |

These line up cleanly with the existing `Call Type` dropdown
(QC / Sales Call / Discovery) and with Bens' `call_role` classifier.

### Rep

GHL opportunity assignee ↔ `Rep`. Blocked on finding C — the assignee set
is larger than `CONFIG.REPS`, so this mapping can't be completed until we
know who Bruno / Simon / Ty / SC / JP / BO / PC / KD / AA are and which of
them should be scored.

---

## Open questions for Kris

1. **Cold Calling 2** — are the 619 leads in "Qualification Call Booked"
   real bookings that died, or an import artifact?
2. **Unknown callers** — who are Bruno, Simon, Ty? And the assignee
   initials SC / JP / BO / PC / KD / AA? Should any of their calls be
   scored?
3. **"…Booked" stages reading 0** in ICONS Podcast (Sales Call Booked,
   Discovery Call Booked) — is a booking moved out of that stage
   immediately, or is the stage unused? Affects any "chase what's pending"
   feature.
4. **What is the "Advanced filters (1)" filter** active on every board? It
   may be hiding opportunities from every count in this document.
5. **Remarketing chase** — is the Dial 2 / Dial 3 / Social DM / Tomas
   Email ladder meant to be used and isn't, or is it obsolete design? The
   fix differs: a monitoring alert vs. deleting dead stages.

## What this implies for the integration

Ranked by value-to-effort, based on the above:

1. **Backfill Prospect Email from GHL** — unblocks every later join, small
   and low-risk.
2. **Populate Outcome Disposition from GHL stage** — fills the most
   important empty column in the system, no workflow change for anyone.
3. **Surface no-shows** — the biggest blind spot; needs no scoring work,
   just counting stages we currently can't see.
4. **Remarketing chase monitoring** — directly addresses Kris's stated
   ask; likely resembles Phase 4's Inbox SLA (time-since-last-touch
   alerting) more than the scoring phases.

Nothing here should be built until the credential exists and the open
questions above are answered — particularly (2), which determines whose
calls are in scope at all.
