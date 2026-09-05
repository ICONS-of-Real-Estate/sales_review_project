# GHL_MIGRATION_PLAN.md — moving off the spreadsheet, onto GoHighLevel

> **Target, set by Kris 05/09/2026: EVERYTHING in GHL.** *"I want EVERYTHING
> in GHL! It is a full CRM and can store everything!"* This document is the
> build plan for that. It is not an evaluation of whether to do it — that's
> decided. No phase code has been changed yet.
>
> For Kris, Tomás, Joana and Hazel to review before the build starts.
>
> Companion to `GHL_PIPELINE_MAP.md` (what's in the CRM) and
> `SYSTEM_OVERVIEW.md` (what the Apps Script system does). Read both first.
> Written 05/09/2026.

## 0. The target

**Everything lives in GHL. The Sales Call Log spreadsheet stops existing as
anything anyone maintains.** Lead state, call outcomes, no-shows, and the AI
review of every call — all of it in the CRM the team already works in.

That is achievable. The one thing still to determine is *which GHL object*
carries a call review, and there are two viable answers — §2. A single
read-only probe picks between them; it does not gate whether the migration
happens.

Two constraints carried in from the Phase 12 work shipped the same day:

- **Everything logged, everything undoable** (§8).
- **Nothing moves in one big cutover** — per phase, up a four-stage ladder,
  each stage its own flag (§9).

Two things genuinely need a human answer before Phase 2 can move, and both
are business questions rather than technical ones — whose calls are in scope
now that GHL shows callers our system has never modelled, and what happens to
leads that legitimately never entered GHL. §5.

## 1. Where the data lives today

| Store | Grain | Written by | Read by |
|---|---|---|---|
| **"Sales Call Log" tab** (39 cols A–AM, ~473 data rows) | one row per **call that happened and was transcribed** | Phase 2 (23 scored cols), Phase 1 (match stamp), Phase 11 (appends Bens rows), reps (outcome) | Phases 1, 2, 3, 4, 5, 10, 12; `sync.py` |
| **GoHighLevel** (~2,309 opportunities) | one record per **contact**; one per **opportunity** | reps, GHL automations, Phase 12 (notes) | Phase 9, Phase 12 |
| **`dashboard.db`** (SQLite, OVH VPS) | disposable mirror of 4 sheet tabs | `sync.py`, every 10 min | the dashboard web app |
| **7 auxiliary tabs** (§7) | per-phase bookkeeping | their own phase | their own phase, `sync.py` |
| **Script Properties** | compliance backlog, training assignments | Phases 1, 6 | Phases 1, 7 |

Only **7 of the 12** phase files touch the Sales Call Log at all. Phases 6,
7 and 8 are self-contained on Drive/Gmail plus their own tabs — they need no
data migration whatsoever.

## 2. Which GHL object holds a call review

> **Correction, 05/09/2026.** An earlier draft claimed GHL "has no per-call
> record" and called it a blocker. That was wrong and Kris rejected it
> correctly: *"If you call a lead 10 times, it is logged in GHL. Same with
> SMS. Same with Email!"* GHL stores many events per contact. The claim
> generalised from one narrow fact — that a *contact custom field* holds one
> value per contact — to all of GHL, without checking. Retracted.

The real question is mechanical: our review carries 23 scored fields per
call, so those fields need to hang off something that exists **once per
call**. Two options, and both put everything in GHL:

**Option A — a Custom Object ("Call Review").** One record per call, related
to the contact, with our 23 fields as real, sortable, filterable CRM fields.
This is the clean answer: reviews appear natively in GHL, reps can filter on
them, and GHL is unambiguously the system of record. Available on some GHL
plans; whether it's on this one is what the probe checks.

**Option B — the note we already write, with a machine-readable payload.**
Phase 12 already posts one note per call and a contact holds unlimited notes
— that's per-call storage in GHL, working in production today. Add a
structured block to the note body (the human-readable review stays exactly as
it is now; the payload rides alongside it), and the phases read their data
back by fetching the contact's notes and parsing it. Less pretty than Option
A, fully functional, and needs nothing from GHL that isn't already proven to
work.

**Either way GHL holds everything and the spreadsheet dies.** The difference
is whether the scores are first-class CRM fields or a payload we parse.

**The probe:** `previewGhlPerCallObjects()` (`Phase9_GhlSync.gs`, read-only,
added 05/09/2026). GHL returns a `model` on every custom field definition
naming the object it attaches to; that list plus `GET /objects/` says whether
Option A is available. It also dumps what GHL already logs natively per event
on a real contact. Full status and body logged on any non-2xx, so a wrong
endpoint guess reports itself — the same self-diagnosing contract that
settled both the Notes endpoint and the `contacts.write` scope.

### What each option costs to read back

The one thing to design around either way: a weekly scorecard needs *this
week's* calls, not all of them. Under Option A that's a filtered query.
Under Option B it's fetching notes for the contacts involved in this week's
calls. Both are fine at this volume; both are a reason to keep the contact ID
on hand rather than re-matching by name every run (F1, §6).

### For scale — how many calls per contact

From the real Phase 12 run on 05/09/2026 that posted 306 notes:

- **Ward Frederick** — 4 calls
- **Deme Mekras** — 4 calls
- **Dertrez Pressley** — 3 calls
- **Sammy Lyon** — 3 calls

306 notes went to materially fewer than 306 people, which is precisely why
the scores can't sit on the contact record itself: one box per person would
keep only the latest, and a rep going 2/5 → 3/5 → 4/5 is the thing the whole
coaching loop measures.

## 3. Volume — a batching problem, not a blocker

An earlier draft of this document called API volume a second blocker. **That
was wrong, and Kris was right to push back on it** (05/09/2026: *"just run it
for a few days"*). Recording the corrected version, because the numbers still
matter for how the work is built — just not for whether it's possible.

The scary-sounding figure is a **one-off backfill**, not the steady state:

- `writeScoreToRow_` (`Phase2_CallScoring.gs:1480-1554`) does up to 23
  single-cell writes per scored call. A **full rescore** covers ~470 rows —
  naively ~10,800 API calls, batched to one update per row ~470.
- Apps Script's execution ceiling is 6 minutes, so that does not fit in
  **one** run.

But nothing requires it to fit in one run, and this codebase already solves
exactly this. `rescoreAllCalls_` is resumable by design — it writes
`Rubric Version` per row and re-reads it as a skip marker, under a 5-minute
budget (`RESCORE_ALL_TIME_BUDGET_MS_`). Phase 12 shipped the same pattern
today (`MAX_ROWS_PER_RUN`, `GHL_NOTE_SYNC_TIME_BUDGET_MS_`) and pushed **306
real notes through in batches**. A backfill that takes a few days of trigger
firings is a normal outcome here, not a failure.

**Steady state is trivial**: a handful of newly scored calls per day, 23
field writes each. Nobody notices.

What survives from that earlier draft, as real but manageable engineering
constraints rather than blockers:

1. **Reads should come from a bulk-readable local store, not per-row API
   calls.** There are ~9 full-sheet scanners across the phases, and the daily
   compliance run alone does 6 full `getDataRange()` scans
   (`Phase1_ComplianceCheck.gs:637` via `:385`/`:405`). Those are cheap
   against a sheet or a database and expensive against a paged CRM API. This
   is an argument for the shape in §4 — it is not an argument against GHL.
2. **GHL's rate limits have never been measured against this account.** Worth
   establishing the real ceiling before eight phases fan out per-row calls on
   overlapping 4-hour triggers. Cheap to find out; currently unknown.
3. **Resolve contacts once, not every run** — see F1 (§6). The note sync
   needed ~2 minutes just to name-match 470 rows. Storing the contact ID
   turns that into a lookup.

## 4. The target shape, concretely

Everything below lives in GHL when this is done.

| What | Where it goes in GHL |
|---|---|
| Contact, email, phone, owner | contact record — **already there** |
| Pipeline stage, outcome, no-shows | opportunity stage — **already there**, stops being typed into a sheet (F2) |
| The human-readable call review | contact note, one per call — **already live** (Phase 12) |
| The 23 scored fields per call | Call Review custom object (Option A) or note payload (Option B) — §2 |
| "Latest review" at a glance | contact custom fields, refreshed each time a call is scored |
| Which calls are still unscored / unmatched | contact + opportunity state, plus our own sync logs |

Things that are **ours, not the lead's** — `Match Method`, `Queue Age`,
`Rubric Version`, `Reviewed By`, `Kris Manual Review Verdict`, the eight
free-text `Gaps` columns — ride along with the call review record (Option A)
or its payload (Option B). They're pipeline provenance, so they belong with
the review, not on the contact card where they'd clutter it for reps.

**The dashboard** then reads GHL instead of the sheet. `sync.py` currently
pulls four tabs into `dashboard.db` with a read-only Sheets service account;
it becomes a GHL pull instead. `dashboard.db` stays exactly what it is today
— a **disposable local cache** that makes the dashboard fast and keeps us off
per-page API calls. It is not a second source of truth; delete it and it
rebuilds from GHL.

## 5. Open questions

None of these stop the migration. Three are read-only probes we run
ourselves; two need a human answer before Phase 2 moves.

**Q1 — Option A or Option B?** (§2)
**Kris's answer 05/09/2026: Option A** — a Call Review custom object, one
record per call, scores as real CRM fields. Still needs the probe to confirm
custom objects are actually available on this plan; Option B stands as the
fallback if they aren't.
**Probe built and ready to run:**
`previewGhlPerCallObjects()` (`Phase9_GhlSync.gs`) — read-only. Reports every
custom field definition grouped by the object `model` it attaches to, probes
`GET /objects/` for custom object schemas, and dumps what GHL already logs
natively per event on a real contact. Self-diagnosing per this codebase's
usual contract: full status + body on any non-2xx, so a wrong endpoint guess
reports itself rather than failing silently (GHL's docs are egress-blocked
from the dev sandbox, exactly as they were for the Notes and contacts.write
work — both of which were settled this way). *One run.*

**Q2 — Is the custom-fields scope actually granted?**
`GET /locations/{id}/customFields` returned 401 on 05/09/2026; Kris was
adding the scope as of this writing. Re-run
`previewGhlNotesAndCustomFields()` to confirm. Blocks every field write.

**Q3 — Whose calls are in scope?** ✅ **ANSWERED** (Kris, 05/09/2026):
**Bruno, Simon and Ty are old sales reps.** So their calls are historical,
not incoming work — their leads and history belong in GHL like everyone
else's, but they don't need live scoring, weekly scorecards or coaching
emails. Practically: include them in data migration and reporting, exclude
them from `CONFIG.REPS`-driven sends. Original question kept below for
context.
`GHL_PIPELINE_MAP.md` §C: GHL shows sources naming **Bruno, Simon, Ty** and
six assignee initials (SC, JP, BO, PC, KD, AA), none in `CONFIG.REPS`
(Bens, Joana, Sean, Tomás). While the sheet is the source they're invisible.
**The moment GHL is the source, their calls enter the pipeline.** Someone
must say: scored, ignored, or scored-but-not-emailed.
*Owner: Kris/Tomás. Blocks Phases 1 and 2.*

**Q4 — Leads that aren't in GHL yet** ✅ **ANSWERED** (Kris, 05/09/2026):
**"Add them to CRM."** So every lead found in a spreadsheet but missing from
GHL gets created as a GHL contact. `previewLeadReconciliation()`
(`Phase13_LeadReconciliation.gs`) produces that list; creating the contacts
is a separate gated step so the list gets eyeballed first — a name-matching
false negative would create a duplicate contact, and CRM duplicates are much
harder to clean up than to avoid. Original question kept below.
Confirmed (`GHL_PIPELINE_MAP.md` §E, Tomás 28/08/2026): Lucy Quiñones,
Chelsea Fernandez, Monique Lewis and Salisia Murray are real leads whose
history lives outside GHL — the podcast-guest route, or nowhere formal.
Under "everything in GHL" the answer is straightforward: **create them as GHL
contacts.** That makes GHL complete, which is the goal. It's a write, so it
needs the same log-and-revert treatment as everything else (§8), and someone
should confirm we actually want 2024-era dead leads imported rather than left
behind. Whatever we decide, the sync must report "not found in GHL" as its
own distinct outcome and never silently drop the call.
*Owner: Kris/Tomás. Blocks Phase 2.*

**Q5 — Does blank-vs-FALSE survive?**
All 12 `Flag:` columns rely on a **three-state** convention: blank means "not
applicable / no signal", FALSE means "judged and failed". This is load-bearing
in `trainingElementFlagsForRow_` (`Phase1:2960`) and `isExplicitlyFalse_`
(`Phase5:74`), and it's why blank rows aren't counted as failures in any
scorecard. Most CRM boolean fields have two states. Under Option A the field
type must preserve three (or a companion "not applicable" value); under
Option B the payload preserves it for free. Otherwise every "not applicable"
silently becomes a recorded failure.
*Engineering decision — flagged so it isn't discovered later.*

## 6. Foundations — before any phase moves

### F1. Store the GHL Contact ID on every row *(the keystone)*

Add column **AN `GHL Contact ID`**; populate from the match we already
compute. Do this first because:

- **It makes everything later cheap.** Resolving 470 rows by name costs ~470
  searches ≈ 2 minutes *per phase, per run* (§3). A stored ID makes it a
  direct lookup.
- **It makes matching auditable.** GHL's `/contacts` query returns wholly
  unrelated people rather than an empty list (confirmed 28/08/2026,
  "Desiree Doggett") — which is why `contactNameLooksLikeQuery_` exists.
  Resolve once, eyeball it, then stop guessing on every run.
- **Most of it is already sitting there.** The `GHL Note Sync Log` tab
  already holds `(Row, Prospect Name, Contact ID, Note ID)` for all ~309
  rows Phase 12 has synced — backfill from it with **zero** API calls, then
  search only for the remainder.
- **Revert:** clear the column. Nothing reads it yet.

Needs `migrateAddPrimaryFailureModeColumn()` (`Phase2_CallScoring.gs`) run
once, same as every trailing-column addition before it.

### F2. Backfill Prospect Email and Outcome Disposition *(already built, still off)*

`syncGhlEmailAndDisposition_()` (`Phase9_GhlSync.gs`) exists, is preview-
tested, and is gated behind `GHL_CONFIG.ENABLED = false`. Every scored row
has a **blank** Prospect Email today (the legacy backfill writes `''`), so
there is no human-readable join key at all. This fills it, and only ever
fills blanks.

Add a **`GHL Sync Log`** tab in the Phase 12 mould first, so the writes are
revertible per §8.

⚠️ **This changes historical numbers.** `Outcome Disposition` is ~0% filled
today, and `Phase10_ConversionFunnel.gs:77-81` treats blank as **attended**.
Filling it from GHL stage will move every show-up and close rate the system
has ever produced. That's a correction, not a regression — but the numbers
are **not comparable across the cutover** and everyone reading them needs to
know the date it changed.

### F3. Build the call-review record in GHL

Depends on Q1 and Q5. Under **Option A**: define the Call Review custom
object and its 23 fields, and a `ghlCreateCallReview_()` alongside the
existing `ghlPostContactNote_()`. Under **Option B**: extend
`buildGhlReviewNoteBody_()` (`Phase12_GhlNoteSync.gs`) to append a
machine-readable payload after the human-readable review, plus a parser that
reads it back. Either way it lands in Phase 12, which already resolves the
contact and posts per call — this is an extension of working production code,
not a new integration.

**No phase moves off the sheet until this exists**, because "read from GHL
instead of the sheet" is meaningless for the 23 scored fields until they're
in GHL.

### F4. Replace row-index identity

**The sheet row number is the system's de facto primary key** and it is used
in more places than anyone would guess:

- `writeScoreToRow_` (`Phase2:1480`) and `stampMatch_` (`Phase1:757`) write
  by absolute row index
- the Queue Age bulk write indexes by `rowIndex - 2` (`Phase2:4522`)
- every `deleteRow` walk runs bottom-up *specifically* so indices don't shift
  (`Phase2:2292`, `:2396`, `:4269`)
- **`salesCallLogRowLink_` (`Phase2:4825`) builds `#gid=…&range=A{n}` deep
  links that are emailed to Kris and Tomás** — a user-visible dependency

Every record needs a stable ID of its own before any of that can move. The
GHL call-review record id (Option A) or the note id (Option B) becomes that
key — Phase 12 already captures note ids and logs them, so the mechanism
exists. The emailed row links become **GHL contact URLs**, which is an
upgrade: clicking a flagged call takes a reviewer to the lead in the CRM
instead of to a spreadsheet row.

## 7. The other tabs need somewhere to go too

"Everything in GHL" has to account for these, not just the Sales Call Log
tab. Ten other tabs live in the same spreadsheet and are load-bearing. Some
have an obvious GHL home; some are internal engineering telemetry that a CRM
is the wrong place for, and those should move to the dashboard's database
rather than clutter GHL:

| Tab | Owner | Notes |
|---|---|---|
| `Objection Playbook` | Phase 1 | **human-curated** — Tomás edits it |
| `Manual Review Guide` | Phase 1 | static reference |
| `LLM Cost Log` | Phase 2 | one row per model call |
| `Regression Baseline` | Phase 2 | frozen sample for drift detection |
| `Handoff Briefs Sent` | Phase 3 | dedup — **cannot** move onto call records: it keys on a *future* calendar event that has no call row yet |
| `Lead Confirmation Reminders Sent` | Phase 3 | same |
| `Scorecard History` | Phase 5 | derived reporting; belongs in the database, not the CRM |
| `Training Assignments` | Phase 6 | mirror of Script Properties, for the dashboard |
| `Daily Practice Follow-ups` | Phase 7 | Phase 7's whole state |
| `Reply Tracker` | Phase 8 | Phase 8's whole state |
| `Icons Podcast Recordings` | **Bens** | **human-maintained**, read by Phases 8 and 11 |

Plus the compliance backlog, which lives in **Script Properties**, not a tab
at all (`Phase1:809`).

**Suggested destinations** (worth a decision, not assumed):

| Tab | Goes to | Why |
|---|---|---|
| `Objection Playbook`, `Manual Review Guide` | stay as documents | human-authored reference, edited by Tomás — a CRM is the wrong tool |
| `Handoff Briefs Sent`, `Lead Confirmation Reminders Sent` | **GHL** — a marker on the contact/appointment | they're per-lead facts ("we already emailed about this booking") |
| `Scorecard History` | dashboard DB | per-rep-per-week reporting, not lead data |
| `LLM Cost Log`, `Regression Baseline` | dashboard DB | engineering telemetry, no business meaning in a CRM |
| `Training Assignments`, `Daily Practice Follow-ups`, `Reply Tracker` | dashboard DB | per-**rep** state; reps are GHL users, not contacts, so there's no natural contact record to hang them on |
| `Icons Podcast Recordings` | **GHL** eventually | it's Bens's lead tracker; it duplicates what GHL contacts do — but it's **his** working system, so migrating it is a conversation with him, not a code change |

**Footgun:** `resolveSheet_` (`Phase1:1333-1343`) silently falls back to
`CONFIG.SHARED_LOG_TAB_CANDIDATES` and then to **the first sheet in the
spreadsheet** when the named tab is missing. Phases 10 and 11 both go through
it. A tab rename during migration therefore produces *wrong data with no
error* rather than a clean failure. Fix this before touching tab names.

## 8. The revert model

Phase 12 set the precedent and it generalises, but it needs one addition.
Every GHL-writing phase gets a log tab shaped like `GHL Note Sync Log`
(`Timestamp, Row, <entity> ID, <object> ID, Reverted`) plus a
`preview<X>Revert()` / `revert<X>()` pair. What differs is *what revert
means*, and there are exactly three classes:

| Class | Example | Revert action | Safe? |
|---|---|---|---|
| **Create-only** | Phase 12 notes | delete the object by recorded ID | ✅ fully reversible |
| **Fill-blank-only** | Phase 9 email/disposition | set back to blank | ✅ prior state was "empty" |
| **Overwrite** | any future field sync replacing a real value | restore prior value **from the log** | ⚠️ only if the log captured it *first* |

**Rule for this migration: prefer create-only, then fill-blank-only. If a
step must overwrite, its log tab gets a `Previous Value` column and the write
is refused when the prior value wasn't recorded.** That clause is the whole
difference between "we can undo this" and "we believe we can undo this."

## 9. The cutover ladder — how each phase moves

Not one switch per phase. Four stages, each its own config flag, so revert is
always "flip the flag back" and never "restore from backup":

| Stage | Behaviour | Risk |
|---|---|---|
| **0 — Shadow read** | read from *both* sheet and new source; act on the **sheet**; log every disagreement | none — measures risk before taking any |
| **1 — New source authoritative, sheet fallback** | act on the new source; fall back when there's no match | low — Q4's orphans stay covered |
| **2 — New source only** | sheet no longer read | medium |
| **3 — Retire the column** | stop *writing* the sheet column too | the irreversible one — last, per phase, only after stage 2 runs clean for a full cycle |

Stage 0 is the important one and it's cheap: it turns "we think GHL's
disposition matches what the rep typed" into a measured number, per phase,
before anything depends on it. Any phase whose shadow run shows meaningful
disagreement does not advance until that's explained.

## 10. Phase-by-phase

Ordered by recommended sequence. "Burden" is migration effort, not value.

| # | Phase | Reads SCL? | Writes SCL? | Burden | Notes |
|---|---|---|---|---|---|
| — | **6** Training Review | no | no | **none** | Drive + Script Properties. Only needs its `Training Assignments` tab to keep existing. |
| — | **7** Daily Self-Practice | no | no | **none** | Drive + Gmail + its own tab. |
| — | **8** Reply Tracker | no | no | **none** for SCL | But joins to Bens's human tracker **positionally with no header validation** (`Phase8:414`) — a column insert there silently produces wrong booking percentages. Worth fixing regardless. |
| 1 | **9** GHL Sync | yes | fills B, H | small | Already GHL-native. Needs its log tab, then flip `ENABLED`. This is F2. |
| 2 | **12** GHL Note Sync | yes | AM marker | small | Already live. Extend to write contact-level "latest review" fields once Q2 clears. Create-only/fill-blank. |
| 3 | **4** Inbox SLA | one read | no | small | Only `computeNoShowFollowUpResults_` touches SCL; joins on Prospect Email + Rep — both have obvious CRM homes. `NO_SHOW_FOLLOWUP_CONFIG.ENABLED` is still false, so there's no live behaviour to preserve. Must preserve the literal string `'No-show'`. |
| 4 | **10** Conversion Funnel | yes (6 cols) | no | small | Pure read-only consumer, `ENABLED` still false — **never sent live**, so nothing to break. Two catches: its `good_to_book` funnel step is script-native with **no GHL equivalent**, and its blank-disposition-means-attended rule (§6 F2) makes pre/post numbers incomparable. Also: rows Phase 11 creates (`Call Type: Icons 100 Recording`) match neither of its call-type filters, so they're invisible to it today — a live inconsistency worth fixing while we're here. |
| 5 | **1** Compliance | yes (heavy) | I, L | medium | Gains no-show visibility — the single biggest blind spot in the system. But: 6 full-sheet scans per run (§3), row-index write-back (F4), and checkbox/`isTruthyOutcome_` tolerance that only makes sense for a spreadsheet cell. Blocked on Q3. |
| 6 | **5** Weekly Scorecard | yes | no | medium | Read-only; follows the store. Watch: it reads **cell type** (`typeof score !== 'number'`, `callDate instanceof Date`) and `callScoreIsUnusableForStats_` **pattern-matches free text inside AI Feedback Summary** to detect parse failures — that needs a real status field, not a string sniff. |
| 7 | **3** Handoff Brief | yes | no | medium | Joins on **normalized Prospect Name only** — the weakest join in the system; a contact ID would genuinely improve it. Its two dedup tabs stay put (§7). |
| 8 | **11** Bens Podcast Sync | yes (3 cols) | **appends A–U** | medium-high | ⚠️ **Live since 04/09/2026** (`ENABLED: true`) — `CLAUDE.md` still says false; that's stale and should be corrected. Writes by **positional `appendRow`**, and its only duplicate protection is a name+rep+calltype predicate. Any source swap must reproduce that predicate exactly or it duplicates rows daily. |
| 9 | **2** Call Scoring | yes (heavy) | **23 cols** | **highest** | Last, deliberately. Its write surface is mercifully contained — `writeScoreToRow_` plus four `appendRow` legacy paths — but it is where a mistake sends wrong coaching to a real rep, and it owns the columns with no CRM home (below). |

### Columns with no natural CRM home

`Match Method` (L), `Queue Age` (U), `Reviewed By` (T), `Kris Manual Review
Verdict` (V), `Rubric Version` (Z), and the eight free-text `Gaps`/`Gap`
columns (Y, AB, AD, AF, AH, AJ, AL). These are all *about our pipeline*, not
about the lead — they belong in the per-call store, never in the CRM.

`Rubric Version` is the load-bearing one: `rescoreAllCalls_`'s ability to
resume after hitting the 6-minute ceiling is built entirely on writing it and
reading it back as a skip marker.

## 11. What else breaks that isn't a phase

**The dashboard.** `sync.py` pulls four tabs into `dashboard.db` every 10
minutes with a read-only service account; `app.py` (1,138 lines, 76 tests) is
built on that mirror. If the sheet stops being written, the dashboard doesn't
error — **it goes quietly stale**, which is worse. `sync.py` needs its new
source before the sheet is retired, and `CLAUDE.md`'s deploy order (**always**
run the sync unit before restarting the web app) applies to every one of
these changes.

**Human workflow.** Reps type Outcome Disposition today. Once GHL supplies it
(F2), that stops being their job — but nobody will know unless they're told.

**`HANDOFF.md` is stale.** It describes the 28/08/2026 state and doesn't know
Phases 11 or 12 exist. Worth bringing current before this migration starts
generating handoffs of its own.

**`CLAUDE.md` is stale on Phase 11.** It says `BENS_PODCAST_SYNC_CONFIG.
ENABLED` is "false by default" and still needs a preview run reviewed; it was
flipped to `true` on 04/09/2026 and has been writing daily at 07:00 since.

## 12. Risks, in the order they're likely to bite

1. **Silent history loss** if the 23 scored fields end up on the *contact*
   record rather than a per-call record (§2) — a lead's earlier calls just
   stop existing, and unwritten data can't be reverted. Mitigation: settle
   Q1 before designing fields, and never put a score on the contact except
   as an explicitly-labelled "latest".
2. **Backfills taking multiple runs** (§3) — expected, not a failure. Build
   them time-budgeted and resumable, as `rescoreAllCalls_` and Phase 12
   already are. Separately: GHL's rate limits are still unmeasured.
3. **Scope creep from GHL's own data.** GHL is not curated: ~2,309
   opportunities, 373 no-shows in one pipeline alone, and unclassified
   callers (Q3). Every phase needs an explicit filter or Phase 2 starts
   trying to score no-shows that have no transcript.
4. **Name-match errors becoming permanent.** Today a bad match misplaces a
   note (annoying, deletable). Once matches drive scoring and emails, a bad
   match sends a rep someone else's review. F1 plus a human eyeball is the
   mitigation.
5. **Blank-vs-FALSE collapsing** (Q5) — turns every "not applicable" into
   a recorded failure, quietly, across 12 columns.
6. **Numbers changing under people's feet** (F2). Not a bug, but it must be
   announced with a date.
7. **Two systems disagreeing during cutover.** Unavoidable in stages 0–2; the
   shadow-read logs make it visible rather than mysterious.
8. **Pipeline hygiene still in flight.** The ~83-contact cleanup runs in
   parallel (approved). Stage membership drives disposition, so
   disposition-derived numbers stay provisional until it lands.

## 13. Recommended sequence

**Now — nothing destructive, no phase moves off the sheet yet:**
1. Q2 — confirm the custom-fields scope (Kris, in progress).
2. Q1 — run `previewGhlPerCallObjects()`. Picks Option A or B. **Written and
   ready.**
3. F1 — add column AN, backfill contact IDs mostly free from the note-sync
   log.
4. F3 — build the Call Review custom object (Q1: Option A). This is the real
   "everything in GHL" step: from here on, every newly scored call lands in
   the CRM in full.
5. Run `previewLeadReconciliation()` (`Phase13_LeadReconciliation.gs`) — the
   audit of every spreadsheet against GHL — then create the missing contacts
   (Q4) behind its own log-and-revert gate.
6. Fix the `resolveSheet_` silent-fallback footgun (§7) — cheap, and it makes
   every later step fail loudly instead of quietly.

**Then:**
7. F4 — stable record IDs, and GHL contact URLs replacing the emailed
   spreadsheet row links.
8. F2 — `GHL Sync Log`, then flip `GHL_CONFIG.ENABLED`. First column that
   stops needing a human to type it.
9. Backfill the ~470 historical calls into GHL, batched and resumable —
   expect it to run over several days of trigger firings, exactly like the
   306-note sync did.

**Then per phase, up the ladder in §9, in the order in §10** — the three
zero-burden phases need nothing, the two never-enabled phases (4, 10) are
free practice, and Phase 2 goes last.

## 14. Status

- **The target is settled**: everything in GHL, spreadsheet retired.
- **Open**: whether call reviews become custom-object records or note
  payloads (Q1 — one probe away), and the two questions for Tomás (Q3, Q4).
- **No timeline yet.** Q1 changes how much work F3 is; estimating before it
  is answered would be guessing.
- **No phase code changed.** The only code added so far is the read-only
  probe (`previewGhlPerCallObjects()`, `Phase9_GhlSync.gs`).
