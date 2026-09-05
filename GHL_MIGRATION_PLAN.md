# GHL_MIGRATION_PLAN.md — moving off the spreadsheet, onto GoHighLevel

> **Status: design only. No phase code has been changed.** This document
> exists to be reviewed by Kris, Tomás, Joana and Hazel *before* anything is
> built, because it contains one finding that changes what "GHL is the
> system of record" can actually mean.
>
> Companion to `GHL_PIPELINE_MAP.md` (what's in the CRM) and
> `SYSTEM_OVERVIEW.md` (what the Apps Script system does). Read both first.
> Written 05/09/2026.

## 0. What was asked for

Kris, 05/09/2026: *"how do we move away from spreadsheets and to full GHL
integration?"* — with one hard constraint carried over from the Phase 12
note-sync work shipped the same day: **everything logged, everything
undoable.**

The short version of the answer:

1. **Most of what the spreadsheet holds, GHL already holds better** — lead
   state, outcome, no-shows, who owns the lead. GHL knows all of it natively;
   the sheet only knows it because a human typed it in. This part should
   move, and it's the part that gets everyone off spreadsheet maintenance.
2. **Per-call review history cannot live in GHL's structured fields** — not
   because of our integration or any volume limit, but because of GHL's data
   model: it stores one card per person, and we need one row per call (§2).
   That history needs somewhere with rows. One such place already exists and
   is already deployed (§4).
3. **Even after the "Sales Call Log" tab is retired, the spreadsheet file
   itself has to survive** — seven other script-owned tabs live in it (§7).

So the achievable target is not "GHL replaces the spreadsheet." It's
**"GHL owns the lead; a database owns the call reviews; nobody maintains a
spreadsheet by hand."** That does deliver what Kris actually asked for.

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

## 2. The one real blocker: GHL has no per-call record

**In plain terms: the spreadsheet stores one line per call. GHL stores one
card per person.**

Take Ward Frederick. He has had 4 calls with us. In the spreadsheet that's 4
lines, each with its own score. On his GHL contact card there is one box
called "Call Quality Score" — write call 2's score into it and call 1's is
gone; write call 3 and call 2's is gone. At the end you have one number, and
no way to see that he went 2/5 → 3/5 → 4/5.

That progression is the entire coaching product. It's what the Monday
scorecard compares ("this week vs. your 4-week average"), what the weekly
calibration checks, and what every trend on the dashboard draws.

Note this is **not** a problem with the review notes — a contact can hold as
many notes as you like, which is exactly why the Phase 12 sync works. It only
affects **structured, sortable fields**.

In the system's own terms: the Sales Call Log's grain is one row per call;
GHL's grain is one record per contact plus one per opportunity. Neither is
one-per-call.

This is not theoretical. From the real Phase 12 sync run on 05/09/2026 that
posted 306 review notes:

- **Ward Frederick** — rows 111, 195, 207, 221 (4 calls)
- **Deme Mekras** — rows 37, 136, 209, 212 (4 calls)
- **Dertrez Pressley** — rows 177, 203, 205 (3 calls)
- **Sammy Lyon** — rows 13, 28, 275 (3 calls)

306 notes went to materially fewer than 306 people. So if `Call Quality
Score` becomes a **contact custom field**, Ward Frederick's four calls
collapse to one number — and the other three aren't overwritten-and-
recoverable, they are *never written at all*. That silently breaks:

- Phase 5's weekly scorecard (this week vs. rolling 4-week average)
- Phase 2's weekly calibration against Kris's manual verdicts
- Phase 2's regression-drift baseline
- the dashboard's score-over-time trend
- any future "is the coaching actually working" measurement

And it breaks in the one way the "everything can be undone" rule cannot
protect against: **you cannot revert data that was never recorded.**

| Approach | Keeps per-call history? | Verdict |
|---|---|---|
| Contact custom fields | ❌ latest-only | Good as a *display* of the most recent review. Never as the store. |
| Opportunity custom fields | ❌ per-deal | Same problem, one level up. |
| Notes (live since 05/09) | ✅ many per contact | Human-readable only — a scorecard can't average HTML. |
| **GHL Custom Objects** | ✅ *if available* | The only way GHL itself could be the store. Availability unverified — Gate 1, §5. |
| A real database | ✅ | Works today. §4. |

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

## 4. What this means — the recommended shape

- **GHL is the system of record for the lead**: contact, email, phone, owner,
  pipeline stage, outcome disposition, appointments, no-shows,
  conversations. It already is. We stop duplicating it into a sheet by hand.
  *This is the part that ends spreadsheet maintenance.*
- **GHL is the human-facing surface for call reviews**: one note per call
  (already live), plus contact-level "latest review" fields so a rep sees
  current state without opening a note.
- **A real database is the system of record for per-call review history** —
  all 23 scored dimensions, one row per call, forever.

For that database, the strong recommendation is to **promote the existing
`dashboard.db`** rather than invent something. It already exists, runs on the
team's own OVH server, has a schema matching all 39 columns, has 76 tests,
syncs every 10 minutes, and is already what every human actually looks at.
Today it's a read-only mirror (`sync.py` pulls from the sheet with a
read-only service account); promoting it means giving it a write path and
reversing the direction of that sync.

That is a smaller, safer change than modelling per-call records inside a CRM
that may not support them — and it satisfies the actual ask, because nobody
is maintaining a spreadsheet either way.

**If Gate 1 says Custom Objects *are* available**, that's still worth doing
for a subset — it would put the scored review on the contact timeline where
reps live. But it doesn't remove the need for a bulk-readable local store
(§3), so it's an addition, not an alternative.

## 5. Decision gates — answer before any phase code is touched

Each of these changes the plan materially. Three are cheap read-only probes.

**Gate 1 — Does this GHL plan have Custom Objects?**
Determines whether GHL could hold per-call history at all (§2). Probe: a
read-only `previewGhlCustomObjects_()` following the same self-diagnosing
contract as every other `ghl*_` function here — log full status + body on
non-2xx, so the first real run *is* the verification (GHL's docs are
egress-blocked from the dev sandbox, exactly as they were for the Notes and
custom-fields work). *~1 hour.*

**Gate 2 — Is the custom-fields scope actually granted?**
`GET /locations/{id}/customFields` returned 401 on 05/09/2026; Kris was
adding the scope as of this writing. Re-run
`previewGhlNotesAndCustomFields()` to confirm. Blocks every field write.

**Gate 3 — Whose calls are in scope?**
`GHL_PIPELINE_MAP.md` §C: GHL shows sources naming **Bruno, Simon, Ty** and
six assignee initials (SC, JP, BO, PC, KD, AA), none in `CONFIG.REPS`
(Bens, Joana, Sean, Tomás). While the sheet is the source they're invisible.
**The moment GHL is the source, their calls enter the pipeline.** Someone
must say: scored, ignored, or scored-but-not-emailed.
*Owner: Kris/Tomás. Blocks Phases 1 and 2.*

**Gate 4 — What about leads GHL doesn't have?**
Confirmed (`GHL_PIPELINE_MAP.md` §E, Tomás 28/08/2026): Lucy Quiñones,
Chelsea Fernandez, Monique Lewis and Salisia Murray are real leads whose
history lives outside GHL — the podcast-guest route, or nowhere formal.
**GHL is not a complete record of calls and never will be.** Any design must
keep a first-class path for no-GHL-match calls, or they stop existing.
*Owner: Kris/Tomás. Blocks Phase 2.*

**Gate 5 — Does blank-vs-FALSE survive?**
All 12 `Flag:` columns rely on a **three-state** convention: blank means "not
applicable / no signal", FALSE means "judged and failed". This is load-bearing
in `trainingElementFlagsForRow_` (`Phase1:2960`) and `isExplicitlyFalse_`
(`Phase5:74`), and it's why blank rows aren't counted as failures in any
scorecard. Most CRM boolean fields have two states. Whatever store is chosen
must preserve three, or every "not applicable" silently becomes a failure.
*Engineering decision, but Kris/Tomás should know it exists.*

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

### F3. Stand up the per-call store

Depends on Gates 1 and 5. Either define the GHL Custom Object, or give
`dashboard.db` a write path and reverse the sync direction. **No phase moves
until this exists**, because "read from GHL instead of the sheet" is
meaningless for the 23 scored columns until there is somewhere for them to
live.

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

Every record needs a stable ID of its own before any of that can move, and
the emailed links need a replacement destination (a GHL contact URL, or a
dashboard URL) or reviewing a flagged call gets worse, not better.

## 7. The spreadsheet file survives even if the tab doesn't

Retiring the *Sales Call Log tab* is not the same as retiring the
*spreadsheet*. Seven other tabs live in the same file and are load-bearing:

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
| **1 — New source authoritative, sheet fallback** | act on the new source; fall back when there's no match | low — Gate 4's orphans stay covered |
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
| 2 | **12** GHL Note Sync | yes | AM marker | small | Already live. Extend to write contact-level "latest review" fields once Gate 2 clears. Create-only/fill-blank. |
| 3 | **4** Inbox SLA | one read | no | small | Only `computeNoShowFollowUpResults_` touches SCL; joins on Prospect Email + Rep — both have obvious CRM homes. `NO_SHOW_FOLLOWUP_CONFIG.ENABLED` is still false, so there's no live behaviour to preserve. Must preserve the literal string `'No-show'`. |
| 4 | **10** Conversion Funnel | yes (6 cols) | no | small | Pure read-only consumer, `ENABLED` still false — **never sent live**, so nothing to break. Two catches: its `good_to_book` funnel step is script-native with **no GHL equivalent**, and its blank-disposition-means-attended rule (§6 F2) makes pre/post numbers incomparable. Also: rows Phase 11 creates (`Call Type: Icons 100 Recording`) match neither of its call-type filters, so they're invisible to it today — a live inconsistency worth fixing while we're here. |
| 5 | **1** Compliance | yes (heavy) | I, L | medium | Gains no-show visibility — the single biggest blind spot in the system. But: 6 full-sheet scans per run (§3), row-index write-back (F4), and checkbox/`isTruthyOutcome_` tolerance that only makes sense for a spreadsheet cell. Blocked on Gate 3. |
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

1. **Silent history loss** if contact custom fields get used as the store
   (§2). Mitigation: answer Gate 1 honestly *before* designing fields.
2. **Backfills taking multiple runs** (§3) — expected, not a failure. Build
   them time-budgeted and resumable, as `rescoreAllCalls_` and Phase 12
   already are. Separately: GHL's rate limits are still unmeasured.
3. **Scope creep from GHL's own data.** GHL is not curated: ~2,309
   opportunities, 373 no-shows in one pipeline alone, and unclassified
   callers (Gate 3). Every phase needs an explicit filter or Phase 2 starts
   trying to score no-shows that have no transcript.
4. **Name-match errors becoming permanent.** Today a bad match misplaces a
   note (annoying, deletable). Once matches drive scoring and emails, a bad
   match sends a rep someone else's review. F1 plus a human eyeball is the
   mitigation.
5. **Blank-vs-FALSE collapsing** (Gate 5) — turns every "not applicable" into
   a recorded failure, quietly, across 12 columns.
6. **Numbers changing under people's feet** (F2). Not a bug, but it must be
   announced with a date.
7. **Two systems disagreeing during cutover.** Unavoidable in stages 0–2; the
   shadow-read logs make it visible rather than mysterious.
8. **Pipeline hygiene still in flight.** The ~83-contact cleanup runs in
   parallel (approved). Stage membership drives disposition, so
   disposition-derived numbers stay provisional until it lands.

## 13. Recommended sequence

**This week — no phase code changes at all:**
1. Gate 2 — confirm the custom-fields scope (Kris, in progress).
2. Gate 1 — probe for Custom Objects. **This is the fork in the road.**
3. F1 — add column AN, backfill contact IDs mostly free from the note-sync log.
4. Put Gates 3 and 4 to Kris/Tomás as real questions with a deadline.
5. Fix the `resolveSheet_` silent-fallback footgun (§7) — cheap, and it makes
   every later step fail loudly instead of quietly.

**Once Gates 1 and 5 are answered:**
6. F3 — stand up the per-call store.
7. F4 — stable record IDs, and a replacement for the emailed row links.
8. F2 — `GHL Sync Log`, then flip `GHL_CONFIG.ENABLED`. First column that
   stops needing a human.

**Then per phase, up the ladder in §9, in the order in §10** — the three
zero-burden phases need nothing, the two never-enabled phases (4, 10) are
free practice, and Phase 2 goes last.

## 14. What this does not commit to

- **No timeline.** Gate 1 changes the shape of the work enough that
  estimating before answering it would be guessing.
- **No claim that GHL becomes the complete record of calls.** Gate 4 says it
  can't be.
- **No code.** Nothing in the twelve phases has been modified to produce this
  document.
