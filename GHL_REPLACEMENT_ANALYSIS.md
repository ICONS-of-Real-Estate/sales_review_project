# GHL_REPLACEMENT_ANALYSIS.md — what GHL does for us, and what it would take to drop it

> **Kris, 09/09/2026:** *"I want to model everything that GHL does. Record
> call logs, sms, emails. Build the system so we can lose GHL. For now until
> the system is built and working perfectly, we'll continue using GHL."*

**This reverses the direction of `GHL_MIGRATION_PLAN.md`.** That document's
target (Kris, 05/09/2026) was *"EVERYTHING in GHL"* — the spreadsheet dies,
GHL becomes the system of record. The target is now the opposite: **our
system absorbs what GHL does, and GHL is eventually cancelled.**

`GHL_MIGRATION_PLAN.md` is therefore **superseded on direction**. It is still
worth reading and is *not* wasted: its §1 (where data lives), §7 (the other
tabs), §8 (the revert model), §9 (the staged-cutover ladder) and §10
(phase-by-phase burden) are all direction-neutral and still correct. Only its
goal — writing our data *into* GHL — is dead. Don't build F3 (the Call Review
custom object).

Companion docs: `GHL_PIPELINE_MAP.md` (what's in the CRM), `SYSTEM_OVERVIEW.md`
(what our system does). Written 09/09/2026.

---

## 1. How solid is the evidence in this document

This project has been burned repeatedly by acting on assumption instead of
evidence (see `HANDOFF.md` §5, "Evidence over assumption"). So every claim
below is tagged:

| Tag | Meaning |
|---|---|
| **MEASURED** | Verified this session against live data (the real spreadsheet, or the code as it actually runs) |
| **DOCUMENTED** | Recorded in this repo from a real observation, but not re-verified now |
| **ASSERTED** | Someone said it; never verified |
| **UNKNOWN** | No evidence either way — do not plan around it |

The single most important thing to notice: **the thing Kris most wants to
replicate — call logs, SMS, emails — is the thing we have the least evidence
about.** It is `ASSERTED` only, from one line in `GHL_MIGRATION_PLAN.md`:
*"If you call a lead 10 times, it is logged in GHL. Same with SMS. Same with
Email!"* Nobody has ever looked. There is no volume, no channel mix, no date
range, no field shape recorded anywhere in this repo.

**That gap is now closable.** `previewGhlCommunicationsAudit()`
(`Phase9_GhlSync.gs`, added with this document, read-only, writes and sends
nothing) samples real contacts and reports exactly that: which channels are
in use, inbound vs outbound counts, the real date range, how many messages
carry a recording, and the raw field shape of a message object. **Run it
before anyone estimates the comms rebuild** — §8 Step 0.

---

## 2. What GHL actually does for this business

Ten capability areas. "Replaceable by us?" is about *our* ability to rebuild
it, not about whether it's easy.

### 2.1 Contact database — **the load-bearing one**

**DOCUMENTED / MEASURED.** ~2,309 opportunities across 6 pipelines
(`GHL_PIPELINE_MAP.md`, 27/08 screenshot — stale). GHL holds the contact
record: name, email, **phone**, owner, tags, source, custom fields.

**Our system has no contact record at all.** MEASURED: the unit of storage in
the "Sales Call Log" is *one row per call that happened and was transcribed*.
Person identity is derived on the fly (`reengagementLeadKey_` in
`Phase17_SeanFollowUpAutomation.gs`, mirrored by `reengagement_lead_key()` in
`tools/dashboard/app.py`), never stored. There is no contact ID, no dedupe, no
merge, no per-person history object.

Two consequences that matter more than they look:
- **A lead who never took a call does not exist in our system.** No-shows,
  leads still being chased, leads that ghosted — structurally absent.
- MEASURED: `tools/dashboard/templates/review.html:80` states it outright —
  *"No phone number is tracked anywhere in this system — only name, email,
  and call history."* We could not dial a lead from our own data today.

**Replaceable by us?** Yes — this is ordinary schema work, and it is the
foundation everything else needs.

### 2.2 Opportunities / pipelines as a daily working surface

**MEASURED (05/09 live scan, "CRM Organization Review" tab).** ~279 **open**
opportunities assigned across **ten** people:

| Assignee | Open opportunities |
|---|---|
| Sean Church | 118 |
| Tomás Fonseca | 64 |
| Joana Peixe | 48 |
| Piero Bengoa | 31 |
| Amanda Arambulo | 7 |
| Bens Olano | 4 |
| Denise Le | 4 |
| Podcast Coordinator | 1 |
| Ashley Lester | 1 |
| Thao Tran | 1 |

This is **not** four reps using a reporting tool. It is ten people — including
setters, a Podcast Coordinator, and names that appear nowhere in
`CONFIG.REPS` (`Phase1_ComplianceCheck.gs`) — working the boards. Tomás:
*"here, when we want to follow up with someone, we go to the CRM, so you need
to be here"* (`TASKS_FROM_JOANA_TRAINING_CALL_08092026.md:156`). He also asked
for a freeze on GHL changes while he reorganised it himself
(`Phase13_LeadReconciliation.gs:29`) — this is a surface people actively own.

**Our system has nothing equivalent.** MEASURED: no opportunity object, no
stage, no stage-change history, no deal value, no owner field beyond `Rep`.
Stage vocabulary exists only as two flat columns (`Call Type`,
`Outcome Disposition`), and `Phase3_HandoffBrief.gs` says explicitly that
funnel-stage *order* "isn't encoded anywhere in the schema."

**Replaceable by us?** Yes technically — but this is the item that turns the
project from "a data pipeline" into "a product ten non-technical people use
every day." That is the real scope change, and it is easy to under-price.

### 2.3 Communications: calls, SMS, email — **the stated goal, and the least understood**

**ASSERTED only.** See §1. Nothing measured.

What we *do* know:
- **DOCUMENTED:** sales calls and QCs happen on **Zoom**; ICONS 100
  interviews on **Riverside** (`CLAUDE.md`, `HANDOFF.md:285`). GHL is not
  where those calls happen.
- **DOCUMENTED:** cold outreach email runs on **Maildoso**, not GHL —
  hundreds of replies forwarded daily via `network@ardorseo.com`
  (`HANDOFF.md:1513-1516`). Reps reply from their own Gmail.
- **MEASURED:** our code has never called a GHL `/calls` endpoint. The only
  per-event objects ever touched are `conversations`, `appointments`, `notes`.
- **DOCUMENTED:** the one GHL-side email stage that exists (`Tomas Email`, in
  the Remarketing pipeline) has **count 0 — never used**.
- **UNKNOWN:** whether GHL owns a phone number, whether anyone dials through
  it, whether any SMS has ever been sent, whether GHL sends any lead-facing
  email at all.

> **UPDATE 09/09/2026 — Kris answered, and this section's working assumption
> was wrong.** GHL's comms are **not** a dead log. He confirmed live outbound
> automation: *"when people book on icons one hundred, book a sales call,
> there are automated emails that get sent and automated SMSes."*
>
> So the job is not "mirror a message log" — it is **replicate a running
> automation that sends real email and SMS to real leads on a trigger.** That
> is a substantially bigger piece of work, and it moves the comms rebuild from
> "maybe out of scope" to "definitely in scope."
>
> The mitigating half: he believes the SMS goes through **Twilio**, which if
> true means we already own the numbers and the carrier registration — see
> §10, "The Twilio question." That single fact swings the timeline by months
> in the *other* direction.

Two probes now target this directly, both read-only:
`previewGhlCommunicationsAudit()` (what was actually sent, at what volume) and
`previewGhlAccountDiscovery()` (what automations exist, and which phone
provider the account is wired to).

**Replaceable by us?** Yes, but this is the piece that decides the project's
size. See §5 and §10.

### 2.4 Booking and calendars

**DOCUMENTED.** Real and load-bearing, but the calendars in evidence are
**rep Google Calendars** with GHL booking links layered on:
- Joana has her own booking link; leads self-book onto it
  (`Phase3_HandoffBrief.gs:831`).
- Booking attribution is tracked as *who booked it* — "Bens" or "By the Lead"
  (`Phase8_ReplyTracker.gs:82-83`).
- Tomás: *"I already adjusted, for example, ICONS 100 to be set as a tag every
  time it's booked on Bens's calendar"*
  (`TASKS_FROM_SEAN_TRAINING_CALL_08092026.md:157`) — a
  calendar-booking → tag automation.

**Our system reads calendars and cannot write them.** MEASURED: no
`createEvent`, no `addGuest`, no `deleteEvent` anywhere in any `.gs` file.
`getRepCallEvents_` (`Phase1_ComplianceCheck.gs`) reads one calendar per rep.
There is no booking page, no availability logic, no reschedule/cancel flow.

**Replaceable by us?** Moderate. Google Calendar's API can create events, but
a *booking product* (public availability page, timezone handling, round-robin,
reminders, reschedule links) is a real build.

### 2.5 Forms — the rep-facing data entry surface, **currently broken**

**DOCUMENTED, and this one is a live business problem.** GHL hosts a form reps
fill in after a QC. It does not reliably work:

> **Sean:** *"I do [fill out the form], but when I submit it, it doesn't upload
> to the CRM. And I don't know why... it's been happening so many times, I
> just thought there's a glitch."* — `TASKS_FROM_SEAN_TRAINING_CALL_08092026.md:147`

> **Tomás:** *"When you do the QC, you do put the details on the form, right?"*
> **Joana:** *"Usually no."* **Tomás:** *"it's just that then it's not
> registered with the CRM."* — `TASKS_FROM_JOANA_TRAINING_CALL_08092026.md:177-179`

So the primary intended data-entry path is both unreliable *and* inconsistently
used. Worth knowing: **this is a capability we would be replacing at a low bar.**

**Our system has no forms at all** and — MEASURED — the dashboard deliberately
does not touch ports 80/443 (FASTPANEL runs client sites on that box, per
`CLAUDE.md`); access is Tailscale-only. A rep-facing or lead-facing form needs
public HTTPS ingress that does not exist today. See §5.4.

### 2.6 Lead capture and ad ingestion

**DOCUMENTED, thin.** Stages `Contact Registered` / `Framework Downloaded`
imply a lead magnet. Remarketing pipeline leads are Meta/Facebook ads, source
almost entirely "Facebook". **UNKNOWN:** the connector mechanism, the landing
pages, the form URLs — none named anywhere.

**Replaceable by us?** The Meta Lead Ads API is well documented and this is a
tractable build — but it needs public webhook ingress (§5.4).

### 2.7 Tags

**DOCUMENTED + live ask.** Tomás wants historical contacts tagged
`icons 100 guest` (`HANDOFF.md`, logged this session). Purpose is
cross-pipeline lead history: *"when one lead closes from ICONS 100, I want to
know if she's been a guest on a podcast before, if she was cold called
before"* (`TASKS_FROM_SEAN_TRAINING_CALL_08092026.md:161`).

Design fact worth carrying into any rebuild — **tags live on the contact, not
the opportunity**, and every opportunity sees its contact's tags (Tomás,
`GHL_MIGRATION_PLAN.md:625-627`).

**MEASURED:** nothing in our codebase writes a GHL tag, and we have no tag
concept of our own. Replaceable trivially once a contact record exists.

### 2.8 No-show tracking — **our single biggest blind spot**

**DOCUMENTED.** `GHL_PIPELINE_MAP.md:321-324`: the Sales Call Log only ever
contains calls that *happened and were transcribed*, so **every no-show is
structurally absent from every metric our system produces** — while "No Show"
(373) is the largest single stage in the entire CRM.

This is the one place where mirroring GHL pays off immediately, regardless of
whether the replacement ever finishes.

### 2.9 Automations

**DOCUMENTED, thin.** Only one named live automation: the ICONS 100 auto-tag
on Bens's calendar booking. The designed multi-touch chase ladder (Dial 2 /
Dial 3 / Social DM / Tomas Email) holds **zero opportunities — never used
once**.

**Our system's scheduling engine is genuinely strong** and is arguably already
better than what GHL is being used for here: MEASURED —
`STANDING_AUTOMATION_HANDLERS_` (24 handlers), `installAllReadyTriggers_` with
an orphan sweep, `selfHealTriggers_` weekly reinstatement, per-phase ENABLED
gating, `LockService` concurrency control, time budgets and resumable passes.

**Replaceable by us?** Yes — this is the area where we are *ahead*, not behind.

### 2.10 Multi-user access

**MEASURED (§2.2).** Ten assignees, including roles our system has never
modelled (setters, Podcast Coordinator). **UNKNOWN:** mobile app usage — which
matters, because reps working leads on phones is a different product than a
desktop dashboard.

Our dashboard's auth (MEASURED) is Google OAuth + workspace-domain check +
explicit `DASHBOARD_ALLOWED_EMAILS` allowlist, failing closed
(`tools/dashboard/auth.py`). That model extends to ten users fine — but it is
staff-only by design, Tailscale-gated, with no lead-facing concept at all.

---

## 3. What we already have that counts

Not starting from zero. MEASURED inventory:

| Capability | State |
|---|---|
| AI call scoring / coaching | Mature — the thing GHL can't do at all |
| Scheduling & automation engine | Mature (24 handlers, self-healing, budgeted, resumable) |
| Internal email | Mature — all routed through `guardedSend_` (`Phase1_ComplianceCheck.gs`) with quota reserve and a config audit that blocks sends to non-internal addresses |
| Inbound email reading | Real — domain-wide-delegated service account, `gmail.readonly`, Sean/Bens/Joana mailboxes (`Phase4_InboxSLA.gs`, `Phase8_ReplyTracker.gs`) |
| Calendar reading | Real, read-only |
| Web app | Real: ~24 routes, OAuth + allowlist, SQLite mirror, write-back to Sheets, **329 tests** |
| Reporting | Rich: scorecards, funnel, calibration, failure modes, trends |
| Follow-up cadence state machine | Built but **disabled** — "Sean Follow-Up Tracker" and the re-engagement cadence (`Phase17_SeanFollowUpAutomation.gs`) |

The last row matters: a lead-nurture cadence engine already exists in this
codebase, fully designed with stages, anchors and stop-states. It is switched
off pending a Gmail scope. That is a large head start on §2.9.

---

## 4. The gap — what would actually have to be built

Grouped by how hard, not by order.

**Tier 1 — ordinary work, we can do this well**
1. **Contact object** — identity, dedupe/merge, emails, phones, tags, source, owner, custom fields. The keystone; nothing else works without it.
2. **Opportunity object** — pipeline, stage, owner, value, status, **stage-change history** (GHL loses this too; we'd be better).
3. **Tags** — contact-level, cross-pipeline.
4. **Activity timeline** — one unified per-contact event stream (call, SMS, email, note, stage change, appointment, form submission). Confirmed real need, not hypothetical: Bens asked Tomás in Slack (11/09/2026) for visibility into whether his ICONS 100 leads' Sales Calls got booked/showed up — exactly a per-contact "what happened, by whom" view, currently answerable only by emailing/asking the closer or checking their personal tracker sheet. Phase20_BensLeadStatusReport.gs papers over this today with a weekly cross-reference email (podcast tracker email ↔ "Sales Call Log" Call Type='Sales Call' rows, any rep) — a stopgap, not a substitute for this item once Step 1+ lands.
5. **Mirror-from-GHL importer** — the migration path *and* the analysis instrument.

**Tier 2 — real product work**
6. **Rep-facing CRM UI** — pipeline board with drag-to-stage, contact page, search, filters, notes, task list. For ten people, daily, probably on phones.
7. **Booking** — public availability page, event creation, reminders, reschedule/cancel.
8. **Forms** — rep-facing QC form (low bar to beat — §2.5) and lead-facing capture.
9. **Automation/workflow surface** — we have the engine; we lack a way for Tomás to define a rule without a code change.

**Tier 3 — not really "code" at all (see §5)**
10. **Telephony** — dialing, call recording, recording storage.
11. **SMS** — sending, receiving, and the regulatory registration behind it.
12. **Lead-facing email at volume** — sending domain, deliverability, unsubscribe handling.
13. **Public ingress** — webhooks and public pages, on a box deliberately kept off ports 80/443.

---

## 5. The four things that are not code — these set the timeline

Engineering effort is *not* the binding constraint. These are.

### 5.1 Telephony and call recording
If any dialing happens through GHL today, replacing it means becoming a
Twilio (or similar) customer: buying/porting numbers, building call handling,
storing recordings, and handling **all-party recording consent** — which this
project has already analysed for Zoom/Riverside
(`QA_COACHING_RESEARCH_REPORT.md:333-336`: *"treat every external call as
all-party, disclose recording verbally at the top"*) but never for GHL.
**Blocked on the §2.3 unknown.** If nobody dials through GHL, this tier
evaporates — which is why the audit probe is Step 0.

### 5.2 SMS — the long pole, if it's in use at all
US A2P 10DLC requires brand + campaign registration before a business can send
application-to-person SMS. That is a **weeks-long, externally-gated process**
with carrier vetting, and it cannot be compressed by writing code faster. If
GHL is currently sending SMS on our behalf under *its* registration, we
inherit that problem entirely on the way out.
**UNKNOWN whether any SMS is sent at all.** Do not plan this tier until the
probe says whether it's real.

### 5.3 Email deliverability
Lead-facing email is not "call the Gmail API." It's a sending domain, SPF/DKIM/
DMARC, warm-up, bounce and unsubscribe handling, and reputation you can destroy
in a week. Note MEASURED constraint: `MailApp` gives a Workspace account
**1,500 recipients/day**, and `guardedSend_` already reserves headroom —
CRM-volume lead email would blow straight through it. This needs a real ESP,
not Apps Script.
Mitigating fact: cold outreach already runs on **Maildoso**, not GHL — so this
tier may be smaller than it looks.

### 5.4 Public ingress
Forms, booking pages, Meta lead-ad webhooks, and Twilio callbacks all require
public HTTPS. The dashboard VPS **deliberately** avoids ports 80/443, nginx and
iptables because FASTPANEL serves client sites there (`CLAUDE.md`). This is a
real infrastructure decision — separate host, subdomain, or a fronting service —
and it gates items 6, 7, 8, 10, 11 all at once.

---

## 6. Three defects found while doing this analysis

All in `Phase14_GhlStageTriage.gs`, all live now, all found by cross-checking
the real spreadsheet rather than reading code. Worth fixing whether or not GHL
is ever replaced, because Tomás is being shown this output.

**STATUS 12/09/2026 — all fixed.** 6.1/6.2 were already wired in by the time
this session re-checked the live code (`ghlMostRecentNoteDate_` already
filters `ghlNoteIsOurOwn_` and normalizes via `ghlTimestampToIso_`;
`ghlMostRecentConversationDate_` already walks real messages, filtering
`ghlMessageIsAutomated_`, both ISO-normalized before the `[...].sort().pop()`
comparison — this doc just hadn't been updated to say so). 6.3 itself, and
its carried-over trigger-registry gap, were still live and are fixed in this
session — see each subsection below.

### 6.1 Our own bot's notes are counted as human activity — **CONFIRMED, not inferred**
`ghlMostRecentNoteDate_` takes the most recent note on a contact. Since
05/09/2026, `runGhlNoteSync_` (`Phase12_GhlNoteSync.gs`) has been posting our
AI review as a contact note every 4 hours. So "last GHL activity" is often
*us*.

Proof: eight triage rows show a last-activity timestamp on 05/09. Every one
matches an entry in our own "GHL Note Sync Log" **to the second** (one hour
apart, a timezone rendering difference):

| Contact | Triage "last activity" | Our note sync |
|---|---|---|
| John Herkenrath | 05/09 05:52:57 | 05/09 06:52:57 |
| Cindi Jarvis | 05/09 05:52:49 | 05/09 06:52:49 |
| Reba Miller | 05/09 05:52:56 | 05/09 06:52:56 |
| Scott Felske | 05/09 05:54:10 | 05/09 06:54:11 |

**Impact is not cosmetic.** In `buildGhlStageTriageSuggestion_`, the branch
that produces the one *decisive* recommendation — `Move to a "Not Taken"/
No-Show stage` — only fires when there is **no** recent touch. Our notes
suppress it. MEASURED in the live tab: 38 of 50 rows fell through to the vague
*"Needs a human look — has activity, but stalled"*, and the 12 that got the
decisive suggestion are exactly the 12 with no activity found at all. **It gets
worse as note sync covers more contacts.**

Design lesson for the replacement: **system-generated events must be
distinguishable from human touches** in the activity timeline. Bake that into
the schema from day one.

### 6.2 Mixed timestamp formats corrupt the "most recent" comparison
`ghlMostRecentNoteDate_` returns **ISO strings**; `ghlMostRecentConversationDate_`
returns **epoch milliseconds**. `buildGhlStageTriageSuggestion_` then does
`[lastNoteDate, lastConversationDate].filter(Boolean).sort().pop()` — a
**lexicographic sort across two different formats**. `"1787216916228"` sorts
before `"2026-..."` every time, so an ISO note always beats a genuinely more
recent conversation. This compounds 6.1.

It also leaks raw epochs into the sheet Tomás reads: MEASURED, the live "GHL
Stage Triage" tab currently shows `1787216916228` where a date should be
(that's 20/08/2026).

`ghlTimestampToIso_` (`Phase9_GhlSync.gs`, added with this document, unit
tested) is the fix — it is not yet wired into Phase 14.

### 6.3 Triage sees a sliver of the CRM — **FIXED 12/09/2026**
`ghlListOpenOpportunitiesInPipeline_` was **single page, no cursor**, and the
live tab contained only "Cold Calling" rows (50 of ~2,309 opportunities). The
code was honest about it (`possiblyTruncated`), but nobody reading the tab
would know. Now paginates for real (`page` param, confirmed-live cursor
style for this endpoint), capped at `GHL_STAGE_TRIAGE_CONFIG.MAX_PAGES_PER_PIPELINE`
(30 pages = 3,000 opportunities per pipeline) as a safety valve, not the
everyday limit — the largest known pipeline (ICONS Podcast, ~946
opportunities) needs only 10.

*Also carried over from the earlier code survey, unrelated to Phase 14 —
**FIXED 12/09/2026**:* `installGhlHygieneCheckTrigger` (`Phase9_GhlSync.gs`)
installs a handler that was **not registered in `STANDING_AUTOMATION_HANDLERS_`**
(`Phase1_ComplianceCheck.gs`) — so `installAllReadyTriggers_`'s orphan sweep
deletes it on the next run. Install it and it silently disappears.

---

## 7. Proposed shape

```
                    ┌────────────────────────────────────┐
   GHL (while it    │  IMPORTER  (read-only, continuous) │
   still exists) ──▶│  contacts, opportunities, stages,  │
                    │  tags, conversations, appointments │
                    └───────────────┬────────────────────┘
                                    ▼
   Zoom/Riverside ──▶  ┌──────────────────────────────┐
   Gmail          ──▶  │   OUR STORE  (system of      │  ◀── Apps Script
   Google Calendar──▶  │   record: contact,           │       phases keep
   Meta lead ads  ──▶  │   opportunity, activity,     │       scoring calls
   (later) Twilio ──▶  │   tag, appointment)          │
                       └───────────┬──────────────────┘
                                   ▼
                       ┌──────────────────────────────┐
                       │  REP UI  (pipeline board,    │
                       │  contact page, timeline)     │
                       └──────────────────────────────┘
```

Key decisions this implies, each worth arguing before it's assumed:

1. **The store is a real relational database, not a spreadsheet.** The
   Sales Call Log's row-as-primary-key model already causes documented pain
   (`GHL_MIGRATION_PLAN.md` F4). The dashboard already runs SQLite on the VPS;
   a CRM with concurrent writers from ten users wants **Postgres**.
2. **Apps Script stops being the centre of gravity.** MEASURED limits: 6-minute
   execution ceiling, a **20-trigger project cap already hit for real**
   (03/09/2026), and MailApp's 1,500/day. It stays excellent at what it does
   — Drive/Calendar/Gmail-native scoring work — and stops being where CRM state
   lives.
3. **`dashboard.db` stops being disposable.** Today it is a cache that can be
   deleted and rebuilt. The moment it holds contact state, it needs backups,
   migrations and a real restore story — a genuinely different operational
   commitment.
4. **Activity events are typed and sourced** (`human` vs `system`), per §6.1.

---

## 8. Sequenced plan, with exit criteria

Each step delivers value standalone. If the project stops after Step 2, we are
still meaningfully better off — that is the test each step must pass.

**Step 0 — Measure what's actually there (days).**
Run both read-only probes in `Phase9_GhlSync.gs` and paste the logs back:
- `previewGhlCommunicationsAudit()` — what has actually been sent: channel
  mix, inbound/outbound volume, date range, message schema.
- `previewGhlAccountDiscovery()` — what's configured: **workflows/campaigns**
  (the automations Kris described), forms and submissions (the QC form
  mystery, and whether Sean's submissions land), calendars, tags, and
  **which phone provider the account uses** (§10, the Twilio question).

*Exit:* we can size Tier 3 honestly instead of guessing, and we know whether
A2P registration is on the critical path or already ours.

**Step 1 — Mirror GHL into our own store, continuously (weeks).**
Read-only importer: contacts, opportunities, stages, tags, appointments,
conversations. Nothing writes to GHL. Team keeps using GHL exactly as today.
*Why first:* it kills lock-in immediately (`Phase12_GhlNoteSync.gs:35` notes
GHL offers no real backup/restore), it is the replacement's schema, and it
closes the no-show blind spot (§2.8) on day one.
*Exit:* dashboard shows no-shows and full pipeline state; a GHL outage no
longer loses us data.

**Step 2 — Own the read surface (weeks).**
Contact page, pipeline board, activity timeline in the dashboard — read-only,
fed by the mirror. Reps still *work* in GHL; they start *looking* here.
*Exit:* Tomás can answer his own "has this lead been a guest before / was she
cold called" question (§2.7) without opening GHL.

**Step 3 — Own the writes (weeks–months).**
Dual-write: stage moves, notes, tags happen here and push to GHL. GHL becomes
a replica. This is where the §9 staged ladder from `GHL_MIGRATION_PLAN.md`
(shadow → authoritative-with-fallback → sole → retire) applies unchanged.
*Exit:* a rep can run a full day without opening GHL.

**Step 4 — Own the edges (gated by §5).**
Booking pages, forms, Meta lead ingestion, then comms. Sequence and scope set
entirely by Step 0's answer and the §5.4 ingress decision.
*Exit criterion for cancelling GHL:* every §2 capability has a working
replacement **and** ten people have used it for a full cycle.

**Do not cancel GHL before Step 4 completes.** Kris already said this
("we'll continue using GHL") and it is the right call — but it needs saying in
the plan, because the export in Step 1 makes cancelling *feel* safe long
before it is.

---

## 9. Risks

1. **Under-pricing the UI.** Ten daily users, not four. §2.2 is the item most
   likely to be estimated as "a page" and turn out to be the project.
2. **A2P 10DLC being on the critical path** and nobody noticing until Step 4
   (§5.2). Step 0 exists to find this early.
3. **Building against a two-week-old snapshot.** Every number in
   `GHL_PIPELINE_MAP.md` is a 27/08 screenshot taken with an uninspected
   "Advanced filters (1)" active on every board — so even those counts may be
   partial.
4. **The 206 unmatched leads.** MEASURED: the "Lead Reconciliation - All" tab
   has **206 `not_found` and 29 `ambiguous`** out of 235 named rows. Either GHL
   is far less complete than assumed, or our name matching is weak. Both are
   bad for a migration and this has never been resolved.
5. **Half-migrated limbo.** Steps 2–3 mean two systems disagreeing. The staged
   ladder handles it, but only if shadow-mode disagreement is actually measured
   rather than assumed away.
6. **Losing GHL's incidental features** nobody documented — the "Advanced
   filters (1)" saved view is a known example of exactly this class.

---

## 10. Kris's answers, 09/09/2026 — and what each one changes

Answered in his own words. Several materially change the analysis above;
where they do, it's called out.

| # | Question | Answer | What it changes |
|---|---|---|---|
| 1 | Does anyone dial through GHL? | *"We used to use Twilio, but now I think we use Go High Level, but we could go back to Twilio."* **Uncertain.** | §5.1 stays open, but the fallback is known and cheap. See "the Twilio question" below. |
| 2 | Any SMS from GHL? | *"I think they're done through Twilio."* **Uncertain.** | Potentially removes §5.2 — the single biggest timeline risk. See below. |
| 3 | Does GHL send lead-facing email? | First *"No"*, then corrected: **yes.** *"When people book on icons one hundred, book a sales call, there are automated emails that get sent and automated SMSes."* | **Overturns §2.3's "possibly dead log".** GHL runs live outbound automation on booking — email AND SMS. This is a real capability to replicate, not a log to mirror. |
| 4 | What is the QC form? | *"I don't know what it is."* | Unresolved — now a probe target, not a question. |
| 5 | How do Meta lead ads reach GHL? | *"I don't know."* | Unresolved — now a probe target. |
| 6 | Who are the ten assignees? | **Piero Bengoa — fired.** **Amanda Arambulo, Denise Le, Ashley Lester — account managers.** **Thao Tran — operations manager, runs podcast production.** **"Podcast Coordinator" — Joana**, a title used because *"no one wants to talk to a salesperson."* | Softens §5.1 but does not remove it. Real seat count is ~8-9, and account managers are still daily users with their own needs. Piero's 31 open opportunities need reassigning regardless. |
| 7 | GHL mobile app? | *"I don't think so. I don't know."* | Leave Step 2/3 desktop-first, but confirm before committing. |
| 8 | The saved board filter? | *"I don't know what that even is."* | Nobody set it deliberately → low risk of losing something load-bearing. Downgrade that risk in §9. |
| 9 | Cost? | **$299/month** (~$3,600/yr). *"I would like to save that money."* | The budget is now known. See below. |

### The Twilio question — now the highest-value unknown after the audit

Kris thinks SMS runs through Twilio. **GHL supports both models**: its own
bundled LC Phone, or "bring your own Twilio" where the account connects to a
Twilio subaccount the customer owns.

Which one is in use decides the hardest part of this whole project:

- **If it's our own Twilio:** we already own the phone numbers and the A2P
  10DLC brand/campaign registration. Replacing GHL's messaging becomes
  "point our own code at the Twilio account we already have" — a normal
  integration. **§5.2 and most of §5.1 evaporate.**
- **If it's GHL's LC Phone:** the numbers and the registration belong to GHL.
  We would need our own Twilio account, our own A2P registration (weeks,
  carrier-gated), and to port numbers out. **§5.2 stays the long pole.**

This is the difference between a few weeks and a few months, and it is
answerable with one API call plus a look at the Twilio console. Probed by
`previewGhlAccountDiscovery()` ("Location detail").

### What $299/month actually buys

At $3,600/year, the honest framing is: **this is not primarily a cost-saving
project.** Any serious build here costs multiples of $3,600 in time alone,
and adds permanent ownership (backups, restores, on-call when a rep can't
load their pipeline at 9am — §9).

The real arguments for doing it are the ones that aren't about the invoice:
owning the data, closing the no-show blind spot, and having the CRM and the
call-scoring system be one thing instead of two that disagree. **The $299
should be treated as a bonus, not the business case** — otherwise the first
month the build overruns, it stops making sense on its own terms.

The corollary is worth stating plainly: **stopping after Step 1 or 2 is a
perfectly good outcome.** Mirror the data, close the reporting gap, keep
paying the $299, and revisit. That is a real option, not a failure.

### The Twilio question — answered, 11/09/2026 (Kris/Hazel call)

Not from a probe — from Kris's own words on an unrelated SEO call: *"we just
moved from Twil[i]o to GHL for SMS and calling, I mean, we can move back to
Twil[i]o, it's got an API that we can connect."*

This resolves §10 Q1/Q2 for real: **it's GHL's own phone/SMS (LC Phone),
not bring-your-own-Twilio.** The account used to run Twilio directly, then
moved everything (SMS + calling) onto GHL. §5.2 stays the long pole per the
table above — a fresh Twilio account, A2P 10DLC registration, and porting
numbers back would all be needed. The one upside: Twilio is a known
quantity here, not a new vendor decision — they already ran on it before,
so "move back" is a re-integration, not a first-time build.

### Two separate replacement efforts running in parallel — don't conflate them

Same call surfaced a second GHL-replacement project that isn't this one:
**Hania is migrating GHL's *client-facing* usage** (the agency runs GHL
for its own clients, separately from ICONS' internal sales pipeline) into
"the hub," her own product, over "two sprints" (~1 month). Kris, on his
own internal sales-team replacement (this document, `ghl_mirror.py`
onward): *"I reckon I can definitely get it done in the next two weeks...
mirror, and use both, and then when you can see that one's working fine,
switch the other off."* That's the same Step 1 → parallel-run → cutover
shape already in §8, just a real timeline attached to it now (his target,
not a commitment).

### Real-world confirmation of §4 item 4 (Activity timeline) — not hypothetical

Hazel gave a concrete before/after that's worth keeping as the reference
case when that item's schema gets designed: on MailerLite (pre-GHL), a
lead was just an email address — no idea which page, campaign, or podcast
brought them in. After moving to GHL: full per-lead history — SMS with
Sean, which newsletter they read, source page, Facebook/Instagram
engagement (comments, DMs), and whether a "new" ad click was actually an
old lead re-engaging or a genuinely first-time contact. Kris's own list of
what must carry over, in his words: form source, "the actions they did,"
Twilio conversation history (once/if that migration happens), and Facebook
ad re-engagement history. None of this is new scope — it's exactly §4 item
4 — but it's now anchored to a real, specific pain (MailerLite-era
blindness) rather than an abstract "nice to have."

### Adjacent, NOT part of this replacement

Kris mentioned a separate personal project on the same call: scraping and
enriching RealTrends' agent directory (name, city, rank, email, website,
phone) for small-batch, personalized outreach ("100 people who'll actually
buy something" instead of a 10,000-person blast). Related in spirit (both
are "know your leads properly" projects) but a different system with a
different data source — not folded into `ghl_mirror.py` or this plan.

---

## 11. Status

- **Direction settled:** absorb GHL's functionality, then drop GHL.
  `GHL_MIGRATION_PLAN.md` is superseded on direction only.
- **Built this session** (all `Phase9_GhlSync.gs`, all read-only, 8 unit tests
  in `tests/run_tests.js`, 714 passing):
  `previewGhlCommunicationsAudit()` + `summarizeGhlMessages_` +
  `ghlTimestampToIso_`, and `previewGhlAccountDiscovery()` +
  `describeGhlProbeResult_`.
- **Not built:** everything in §4. No phase code changed, nothing written to
  GHL, no flags flipped.
- **Immediate next action:** deploy (`git pull && clasp push`), run **both**
  probes, paste the logs back. Steps 1+ cannot be sized honestly before that.
- **Budget is now known:** $299/month. Read §10's note on why that should not
  be the business case.
- **Not estimated on purpose.** Step 0's answer moves the total by months.
  Estimating now would be the same guess this document exists to avoid.
- **11/09/2026 — real input for §4 item 4 (Activity timeline), and a stopgap
  built ahead of it:** Bens asked Tomás in Slack for visibility into his
  ICONS 100 leads' Sales Call status; Tomás's answer was "check these two
  manual tracker spreadsheets" — exactly the fragmented-view problem §4
  item 4 exists to fix. Rather than wait for Step 1+, built
  `Phase20_BensLeadStatusReport.gs`: a weekly email to Bens (cc Tomás,
  Kris) cross-referencing his podcast tracker's leads against "Sales Call
  Log" by email, any rep, Call Type 'Sales Call'. Uses only data we already
  have; writes nothing back to either sheet. Not a reason to deprioritize
  item 4 — it's a manual-feeling proxy for the real thing, worth keeping in
  mind as a concrete example when that item's schema gets designed.
