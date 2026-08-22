# Dashboard research report — secure team web dashboard on the OVH VPS

> Answers `Dashboard_Research_Prompt.md`. Research and recommendations only —
> no implementation. Read `SYSTEM_OVERVIEW.md` first for what the underlying
> system does.
>
> Written 22/08/2026. Everything in §0 was verified by reading this repo;
> §§1–6 combine that with external research (sources at the end). Where I
> could not reach a primary source, I say so.

---

## 0. What the box and the codebase actually look like

Four constraints came out of reading `HANDOFF.md`, `tools/deploy/setup_ovh.sh`
and the `.gs` files. They change the answers enough that they belong before
the recommendations, not after.

**0.1 — The VPS is not an empty box.** `vps-b3e68291`, 16 vCores / 16 GB,
SSH on port 2288. It already runs **FASTPANEL, with nginx + php-fpm +
mariadb serving real client websites**, plus the `transcribe-all.timer`
systemd unit at `Nice=19`/idle IO. Consequences:

- **Ports 80 and 443 are taken, and FASTPANEL owns the nginx config.**
  The usual "install Caddy, get automatic TLS" advice is wrong here — Caddy
  cannot bind 443, and hand-edited nginx config outside the panel's
  directories tends to get overwritten by it. The Caddy-vs-nginx+certbot
  question is effectively already decided: **use the panel's nginx and the
  panel's Let's Encrypt**, and add the dashboard as one more site.
- **The firewall is not yours either.** FASTPANEL manages iptables. Turning
  on `ufw` naively is a real way to lock yourself out of SSH on 2288 or take
  the client websites offline. Check what is in charge before touching it.
- **MariaDB already exists** — but it is the panel's, shared with client
  sites. Reusing it couples this dashboard's blast radius to those sites.
  Don't.
- Headroom is fine. 16 vCores/16 GB, and the transcription job is explicitly
  idle-priority. A Python web app for ten people is noise on this box.

**0.2 — The data is tiny.** From `HANDOFF.md`'s backlog table: ~146 + 80
(Sean) + 25 (Joana) + 80 (Tomás) + ~60 (Bens) ≈ **400 calls total**, growing
maybe 20–50/week. A year out that is low thousands of rows. This is not a
data-engineering problem. The entire dataset fits in memory, in one Sheets
API call, comfortably. Any architecture that treats this as a scale problem
is over-built.

**0.3 — Not all the data the dashboard wants is in the Sheet.** This is the
one genuine blocker, and it is worth fixing before anything else.

The prompt asks for "each rep's current practice-drill assignment/status".
That state does **not** live in the spreadsheet. `Phase6_TrainingCallReview.gs:335-343`
writes it to Apps Script **Script Properties**:

```
TRAINING_OBJECTIONS_<rep>     — the objections to drill this cycle
TRAINING_CLOSE_DRILL_<rep>    — the money-ask drill
```

and `Phase7_DailySelfPractice.gs:358-361` reads them back. **Script
Properties are only readable from inside Apps Script** — no Sheets API, no
Drive API, no service account can see them. So a pull-based dashboard is
structurally blind to the current drill assignment.

The fix is small and fits the existing architecture: add a mirror that
writes those two properties per rep into a `Training Assignments` tab on the
Sales Call Log whenever Phase 6 sets them (~15 lines, in Phase 6, right
after the `setProperty` calls). Then the assignment is visible to the same
sync path as everything else, *and* it becomes debuggable by a human, which
Script Properties are not. Phase 7 can keep reading the properties — no
behaviour change.

What **is** already Sheet-visible: the `Sales Call Log` tab (scores, verdicts,
failure-mode flags, `Kris Manual Review Verdict`, `Queue Age`), the
`Daily Practice Follow-ups` tab (`Phase7:446`), the reply tracker tab, and
the handoff tracking tab.

**0.4 — Google auth today is a user OAuth token, not a service account.**
`tools/deploy/setup_ovh.sh` requires `credentials.json` + `token.json`
copied by hand from Kris's already-authorized laptop, because "there's no
browser on this box." That works, but a user refresh token can be revoked
by a password change, a Workspace policy, or six months of inactivity —
and when it dies, the fix requires Kris's laptop again. Don't extend that
pattern to the dashboard (§3.1).

**0.5 — The project timezone is `Asia/Bangkok`** (`appsscript.json`), and
dates are DD/MM/YYYY by convention (`brief.txt` §2). That is the de-facto
business timezone, and it matters more than it sounds (§6).

---

## 1. Data access strategy

### 1.1 The options

| | How it works | Pros | Cons |
|---|---|---|---|
| **A. Read the Sheet live, per request** | Web app calls Sheets API on every page load | Always current; no state to keep | 300 reads/min/project, 60/min/user shared with everything else; page load waits on Google; charts over a year of history mean re-fetching everything constantly; dashboard dies when Sheets does |
| **B. Scheduled pull into a local DB** | systemd timer pulls the whole Sheet every N minutes into SQLite; app only ever reads SQLite | Page loads are local and instant; survives Google being slow or down; history/aggregation is SQL, not spreadsheet gymnastics; **no inbound network access needed** | Data is up to N minutes stale; one more moving part |
| **C. Apps Script pushes** | Phase code `UrlFetchApp`s rows to a webhook on the VPS | Near-real-time; no polling | Adds a 9th thing to a project with a strict "no LLM in the deterministic path" discipline; failures are now inside the phases; requires an inbound public endpoint + HMAC; consumes the daily UrlFetch quota; Apps Script's 6-minute execution cap is a bad place to put network retries |
| **D. Migrate system-of-record to Postgres** | Sheet becomes an input; DB is the truth | "Proper" architecture | **Requires rewriting all 8 Apps Script phases**, which are the working, calibrated part of the system. Enormous cost, zero user-visible benefit |

### 1.2 Recommendation: **B**, and the Sheet stays the system of record

The decisive argument against D: eight phases read and write that Sheet, and
Phase 2 is in the middle of a shadow-mode calibration run against Kris's own
verdicts. Changing the data spine now means re-validating the thing whose
whole point is being trustworthy. The Sheet is also genuinely good at
something a database is bad at — Kris opening it and editing a cell.

So: **Sheet = system of record. SQLite on the VPS = a read-mirror the
dashboard owns and can rebuild from scratch at any time.**

That last property is worth stating explicitly, because it removes a whole
category of operational worry: the mirror is *derived data*. If it corrupts,
you delete the file and re-run the sync. The only things that need real
backups are dashboard-native (§5.3).

Quota is a non-issue at this size: one `spreadsheets.values.batchGet` pulls
every tab. At one sync every 5 minutes that is 288 requests/day against a
300-per-minute ceiling. Even per-minute-per-user (60) is untouched. Note
Google has signalled that quota overages will start incurring charges later
in 2026 — irrelevant at this volume, but worth knowing the meter now exists.

Reject C on architecture grounds, not capability grounds: it works fine, it
just puts new failure modes inside the phases and requires opening an
inbound port. B needs **no inbound connectivity at all**, which is exactly
what makes the Tailscale-only security posture (§4.2) possible.

### 1.3 Two-way sync for `Kris Manual Review Verdict`

If the dashboard should eventually let Kris review from the web, this is the
safe shape:

1. **The dashboard writes exactly one column.** `Kris Manual Review Verdict`,
   and nothing else. Every other column is written by a phase; a second
   writer is a race condition waiting to happen.
2. **Address rows by `Calendar Event ID`, never by cached row index.** The
   mirror is up to N minutes old; rows shift when anyone inserts or sorts.
   Writing to "row 214" from a stale mirror is a live data-corruption bug.
   Look up the row by its join key at write time, then write that cell.
3. **Write-through, then re-pull immediately.** Write to Sheets, then
   trigger a sync so the UI reflects reality rather than optimistic state.
4. **Append-only audit table in SQLite** — who set what verdict, when, from
   which row key. The Sheet has no history; this is also what makes the
   weekly calibration job auditable later.
5. Conflict risk is close to zero in practice: Kris is the only writer of
   that column, and she is not going to be in the spreadsheet and the
   dashboard simultaneously. Last-write-wins with an audit trail is
   proportionate. Don't build locking.

Keep this out of v1 (see §7). Read-only first.

---

## 2. Stack

### 2.1 Recommendation

**Python 3 + FastAPI + Jinja2 templates + HTMX, server-rendered. SQLite for
storage. Apache ECharts for charts. No build step, no Node on the box.**

### 2.2 Why

- **One language, already on the box.** The transcription pipeline is Python
  with a venv and a `requirements.txt`. The dashboard reuses the same
  `google-api-python-client` / `google-auth` dependencies that are already
  installed and already working against these exact Google resources.
- **No build step is a security and ops property, not just convenience.**
  A React/Vite frontend means Node, `node_modules`, a build artifact, and a
  second supply chain to patch — on a box that also hosts client websites.
  For ~10 users and a dashboard whose interactivity is "filter by rep, pick a
  date range", that is cost with no return. Current writing on HTMX-vs-React
  for internal CRUD apps lands in the same place: no virtual DOM, no client
  routing, no state library, and any backend dev can edit a template.
- **HTMX covers the interactivity that actually exists here.** Swap a chart
  panel when the rep filter changes; submit a review verdict and re-render a
  row. That is a partial-HTML-over-the-wire problem, which is precisely what
  HTMX is for.
- **FastAPI over Flask** mostly for typed request models and the free
  `/docs` page — useful when the same endpoints later serve JSON to
  something else. Flask would also be fine; this is not a load-bearing
  choice.

### 2.3 Charts

Recommendation: **Apache ECharts**, with **Chart.js** as the lighter
fallback if the bundle bothers you.

- **ECharts** (~186 KB) — looks good with default settings, which matters
  when the brief is explicitly "should feel nice and visual". Canvas
  renderer with an SVG option, incremental rendering, and a much wider set
  of chart types than you will need. Apache-2.0.
- **Chart.js** (~14 KB) — the small, boring, excellent choice for line/bar/
  pie/radar. Canvas-native. If every chart on the dashboard is one of those
  four, Chart.js is genuinely sufficient and 13× smaller.
- **Plotly.js** — scientific/analytical focus and a heavy bundle. Overkill.
- **Observable Plot** — lovely for exploratory work; less suited to a fixed
  dashboard other people use.
- **D3** — a visualization *toolkit*, not a chart library. Don't.

On an internal dashboard over broadband, 186 KB is not a real cost, and the
"pretty by default" property is worth more than the bytes. Serve it locally
from `/static/`, not a CDN — one less external dependency, and it keeps the
Content-Security-Policy tight.

### 2.4 The playbooks

`Objection_Handling_Playbook.md`, `..._Sean.md`, `Tomas_Playbook.md` are
markdown in this repo. Render with `markdown-it-py`, auto-generate a
heading-based table of contents, and index them into **SQLite FTS5** for the
"browsable/searchable by objection type" requirement. FTS5 ships with
SQLite — no Elasticsearch, no extra service, no extra port. Re-index on
deploy, since the source is files in the repo.

---

## 3. Security

### 3.1 Google credentials for the sync job

Use a **service account** with a JSON key, and share the Sales Call Log with
its `...@....iam.gserviceaccount.com` address as **Viewer** (Editor only when
two-way writes land in §7 Phase E). No domain-wide delegation — that is for
impersonating mailboxes, which is Phase 4's problem, not this one.

Why not reuse the existing `token.json` pattern: a user refresh token is
tied to Kris's account and can be revoked out from under the server, and
re-minting it requires a browser on a machine that has none. A service
account is a non-human identity with a key you control, scoped to exactly
one spreadsheet by sharing. That is both more robust and less privileged
than what the transcription job does today.

Scope it read-only (`spreadsheets.readonly`) for v1.

### 3.2 TLS and reverse proxy

Decided by §0.1: **FASTPANEL's nginx, FASTPANEL's Let's Encrypt.** Create a
site for a dashboard subdomain in the panel, issue the cert through the
panel GUI, and point it at the app.

- **Bind the app to `127.0.0.1:8000`, never `0.0.0.0`.** Then a firewall
  mistake cannot expose it — the app is not reachable from outside the box
  at any port, only through nginx.
- Standard proxy headers (`Host`, `X-Real-IP`, `X-Forwarded-For`,
  `X-Forwarded-Proto`) so the app can build correct OAuth redirect URIs.
  Getting `X-Forwarded-Proto` wrong produces `http://` redirect URIs that
  Google rejects — a classic hour-long debugging session.
- If the panel offers a native "reverse proxy" site type, use it. If it
  fights you, put the custom `location` block in whichever include directory
  the panel documents as user-editable, so panel updates don't clobber it.

`Caddy vs nginx+certbot` is moot here. If this were a bare box, Caddy would
win on automatic TLS with near-zero config; on a FASTPANEL box, fighting the
panel for port 443 is a self-inflicted wound.

### 3.3 Authentication — two coherent postures

**Posture A — Tailscale, no public exposure.**

Put the VPS and each team member's devices on a tailnet; the dashboard
listens only on the Tailscale interface. No public DNS, no public TLS, no
login page, no auth code, nothing to brute-force. Tailscale's free Personal
plan now covers **6 users with unlimited user-owned devices** — the team is
Kris, Tomás, Sean, Joana, Bens = **5**. That fits, with exactly one seat of
headroom, and a 6th person means $8/user/mo. (Sourced from secondary
write-ups; tailscale.com was unreachable from this session, so **confirm the
current free-tier user count before depending on it**.)

Cost: everyone installs a client on every device they want to check the
dashboard from, including phones. For a distributed team who will want to
glance at this from a phone, that is real friction — and friction is fatal
to the stated goal of "something the whole team actually opens".

**Posture B — public HTTPS + Google OAuth restricted to the Workspace domain.**

Everything already lives in Google Workspace, everyone already has an
account and is already logged in. This is the natural fit and it is what I
recommend as primary. Three layers, all of which you should implement:

1. **Set the GCP OAuth consent screen to "Internal" user type.** Only
   members of the Workspace org can complete the flow at all, and internal
   apps skip Google's verification review entirely. Requires the GCP project
   to belong to the Workspace org, not a personal Gmail account.
2. **Verify the `hd` (hosted domain) claim server-side** on the ID token.
   The `hd` claim is inside the signed token, so it is trustworthy — but you
   must actually check it. Absence of `hd` means the account is not a
   Workspace account. Do not infer the domain by string-matching the email
   address.
3. **Check the email against an explicit allowlist** in config. Five names.
   This is the layer that survives someone being added to the Workspace for
   an unrelated reason.

Implement in-app with **Authlib** rather than putting **oauth2-proxy** in
front. Reasoning: it is a single application, so a separate auth proxy is an
extra service to run and patch; and the app needs the user's identity
anyway, to show "your" scorecard and to gate Kris-only review actions.
oauth2-proxy gives you a gate, not roles. (Note also that oauth2-proxy has
historically not validated `hd` itself — its `--email-domain` flag is an
email-suffix check, which is weaker than a signed-claim check.)

**Do not build password or magic-link auth.** It is more code, more support
burden, and worse security than an identity provider every user is already
authenticated against.

**Recommendation: B, with A as a fast path.** Posture A is the quickest
route to something working (§7 Phase A) precisely because it needs no auth
code. Ship on Tailscale while the data path is being proven, then add Google
OAuth and open the subdomain once there is something worth logging into.
They compose — you can keep Tailscale-only access for admin endpoints
permanently.

**Roles** (needed either way): rep sees their own detail plus team-wide
aggregates; Kris and Tomás see everything and can act on the review queue.
Map email → role in config, not in the database — five entries that change
about once a year.

### 3.4 Hardening checklist for this specific box

Dashboard-specific:

- Dedicated non-login service user (`salesdash`), owning only its own
  directories. Not root, not Kris's user.
- Secrets in `/etc/sales-dashboard/env`, mode `0600`, owned by that user,
  loaded via systemd `EnvironmentFile=`. **Not** in the repo directory
  alongside `credentials.json` — a gitignore is a convention, not a
  permission boundary.
- systemd hardening on the unit: `NoNewPrivileges=yes`, `PrivateTmp=yes`,
  `ProtectSystem=strict`, `ProtectHome=yes`, `ReadWritePaths=` limited to
  the data directory, `RestrictAddressFamilies=AF_INET AF_UNIX`, and a
  `MemoryMax=` so a runaway process cannot starve the client websites.
  This gets most of the isolation people reach for Docker to obtain.
- The Moonshot API key is not needed by the dashboard. Don't copy it there.

Box-level, and these are pre-existing issues the dashboard inherits rather
than causes:

- **`transcribe-all.service` runs as `${SUDO_USER:-$(whoami)}`**
  (`setup_ovh.sh`). Given the documented access pattern is
  `ssh -p 2288 root@...`, that unit is very likely **running as root** —
  a Whisper/ffmpeg pipeline processing untrusted media files, as root, on a
  box hosting client websites. Worth fixing independently of this project.
- SSH: key-only auth, `PermitRootLogin prohibit-password` at minimum, and a
  non-root sudo user for daily work. The non-standard port 2288 already cuts
  most background noise but is not a control.
- `fail2ban` — SSH jail plus an nginx jail. Typical settings: `maxretry=3`,
  `findtime=600`, `bantime=3600`.
- `unattended-upgrades` for security patches, configured in
  `/etc/apt/apt.conf.d/50unattended-upgrades`.
- Firewall: **find out what is managing iptables first** (FASTPANEL likely
  is). Default-deny inbound with only 2288, 80, 443 open is the target
  state, but reaching it via `ufw` on a panel-managed box needs care and a
  second SSH session held open while you do it.

---

## 4. Deployment and ops

### 4.1 Bare systemd, not Docker

Match the existing style. Docker would add a daemon, a network layer, image
builds, and another patch surface to a box whose other tenants are
panel-managed PHP sites — to run one Python process and a file-backed
database. The systemd hardening directives in §3.4 provide most of the
isolation benefit at none of the cost. (If the team later wants several
services, revisit; today it is one.)

Two units, mirroring `transcribe-all`:

- `sales-dashboard.service` — the web app. `Restart=always`,
  `RestartSec=5`. Runs uvicorn bound to `127.0.0.1:8000`.
- `sales-dashboard-sync.service` + `.timer` — the Sheets pull. `Type=oneshot`,
  every 5–15 minutes. **Do not** copy `Nice=19`/`IOSchedulingClass=idle`
  from the transcription unit: that job is a background backlog grinder,
  this one needs to be timely and takes milliseconds. `Nice=10` is plenty.

### 4.2 Deploy story

Same shape as the Apps Script side ("push to git, pull and restart"):

```
cd /opt/sales_review_project && git pull
.venv/bin/pip install -r tools/requirements.txt   # only when deps change
sudo systemctl restart sales-dashboard
```

Wrap it as `tools/deploy/update_dashboard.sh` next to the existing
`setup_ovh.sh`, and a `setup_dashboard.sh` for the one-time install, so the
deploy procedure is a file in the repo rather than tribal knowledge. Add it
to `CLAUDE.md` alongside the `clasp push` procedure — that file already
exists specifically because deploy steps drift when they are not written
down.

### 4.3 Monitoring — four layers, cheapest first

The stated worry is "a crashed dashboard sitting dead unnoticed like a
corrupted transcript currently could." Four things, in order of effort:

1. **A freshness banner in the dashboard itself.** "Last synced 4 minutes
   ago", turning amber then red past a threshold. Near-zero effort, and the
   people who care see it without anyone configuring alerts. This alone
   catches the most likely real failure — sync silently stopped while the
   web app keeps serving stale data, which no external uptime check would
   ever notice.
2. **`Restart=always` plus an `OnFailure=` unit** that emails on repeated
   failure. Handles crashes without a monitoring service.
3. **A dead-man's-switch ping** from the sync job (healthchecks.io free tier
   or equivalent): the job pings on success, and you get alerted when the
   ping *stops*. This is the right tool for "the job never ran", which is
   exactly the transcript-corruption failure mode — so **retro-fit the same
   ping to `transcribe-all.service`** and that long-standing gap closes too.
4. **Uptime Kuma** if a self-hosted status page is wanted — it is
   SQLite-backed and easy, but it is another service on the box. External
   HTTP probing answers "is the site up", which layers 1–3 already mostly
   cover. Optional.

**Bonus, and it belongs on the dashboard rather than in monitoring:** a
pipeline-health panel showing rows whose transcript is `[BLANK_AUDIO]` or
matches the repeating-text-loop pattern (`SYSTEM_OVERVIEW.md` §2's known
gap), plus rows stuck without a matched transcript. That known failure mode
is currently invisible to everyone; a table with counts makes it a
five-second glance.

---

## 5. Timezones

The team is distributed and the Apps Script project timezone is
`Asia/Bangkok`. Three distinct rules, because conflating them is where the
bugs are:

**5.1 — Calendar dates are not instants.** `Call Date` is a *day*, stored
DD/MM/YYYY. Do **not** convert it to UTC and render it in the viewer's
local time: a call on 01/09 shown to someone eight hours west becomes 31/08,
and now two people are looking at different months of the same data. Treat
`Call Date` as a plain date, all the way through — no timezone attached,
rendered identically for everyone, keeping the established DD/MM/YYYY
convention.

**5.2 — Real timestamps are instants.** Sync time, queue age, practice
submission time. Store UTC in SQLite; render in the viewer's local timezone
via `Intl.DateTimeFormat` in the browser, with a timezone label. This is
where "shows the right time for me" is genuinely what people want.

**5.3 — Week boundaries must be one fixed business timezone.** Phase 5
emails a weekly scorecard, and if the dashboard computes "this week" in the
viewer's local timezone, reps in different countries see different numbers
from the email they just received, and from each other. Pin every
week/day bucket to **`Asia/Bangkok`**, matching `appsscript.json`, so
dashboard aggregates and email aggregates always agree. State it in the UI
("week of 18–24 Aug, Asia/Bangkok") — one line of text that prevents a
recurring "why don't these match" conversation.

Corollary worth noting for whoever owns Phase 5: the same pinning is why the
scheduled-email timing issue exists. The dashboard should agree with the
emails, not quietly fix them.

---

## 6. Phased build plan

Each phase is independently useful and independently shippable. The
ordering front-loads the parts most likely to surface a surprise.

**Phase A — prove the data path (smallest useful thing).**
Service account + Sheets read; sync job into SQLite; FastAPI app with one
page: team overview, a handful of numbers, no charts. Access via Tailscale
only — no auth code, no public DNS, no certificate. Deployed with the two
systemd units. *Deliberately first, because §0.3 means the data path is
where the unknowns are, and Tailscale defers the entire auth question
without blocking anything.*

**Phase A′ — the Script Properties mirror (do alongside A).**
Add the ~15-line write of `TRAINING_OBJECTIONS_*` / `TRAINING_CLOSE_DRILL_*`
into a `Training Assignments` tab in Phase 6. Follows the existing rollout
discipline: build it, run the phase's `preview*()`, confirm the tab looks
right. Without this, Phase C's headline feature cannot be built at all.

**Phase B — charts and identity.**
Score-over-time per rep, failure-mode breakdown, lead-quality distribution,
team comparison. Google OAuth (Internal consent screen + `hd` verification +
allowlist), roles, and the public subdomain through FASTPANEL. Ship the
freshness banner here — it is most valuable the moment other people start
relying on the data.

**Phase C — training and playbooks.**
Rendered playbooks with a table of contents and FTS5 search; each rep's
current drill assignment (needs A′); training-cycle history from Phase 6;
practice status from the `Daily Practice Follow-ups` tab.

**Phase D — review queue and pipeline health.**
Kris's daily 3-call cluster, queue age and backlog, calibration agreement
over time, and the blank/corrupt-transcript panel from §4.3. Still
read-only.

**Phase E — write-back (only if wanted).**
Kris's manual verdict from the web, per the constraints in §1.3: one column,
keyed by `Calendar Event ID`, write-through plus re-sync, audit table. This
is the only phase that carries real data-integrity risk, which is why it is
last and optional.

---

## 7. What I need answered before implementation starts

Roughly in order of how much they block:

1. **Is there a domain, and is it already in FASTPANEL?** A spare subdomain
   (`dashboard.<something>`) on a domain the panel already manages makes
   Phase B's TLS a GUI click. If there is no domain at all, that changes the
   plan toward Tailscale-permanent.
2. **Google Workspace / GCP admin access.** Needed to set an OAuth consent
   screen to *Internal*, create the OAuth client, and create the service
   account. Also: **is there already a GCP project** (the transcription
   `credentials.json` came from one), and does it belong to the Workspace
   org or a personal Gmail account? Internal consent screens are not
   available on personal-account projects.
3. **Confirm the Sheet's actual tab list.** The code resolves the main tab
   through `CONFIG.SHARED_LOG_TAB_CANDIDATES`
   (`Phase1_ComplianceCheck.gs:105,638`), which currently holds exactly one
   entry — `'Sales Call Log'` — so the `brief.txt` §2 standardization looks
   done, with the list there as future-proofing. The sync job also needs the
   other tabs by name (`Daily Practice Follow-ups`, the reply tracker, the
   handoff tracker), and whether any per-rep legacy tabs still exist
   alongside them. A screenshot of the tab bar settles it.
4. **Exact OS and who owns the firewall.** `lsb_release -a`, plus whether
   `ufw` is active or FASTPANEL is managing iptables directly.
5. **Can a reverse-proxy site be added through FASTPANEL** without
   hand-editing nginx config the panel will overwrite?
6. **The user list and roles** — five email addresses, and confirmation that
   Tomás gets Kris-level visibility (he is CC'd on compliance emails, so
   probably yes).
7. **Read-only, or write-back?** Whether Phase E is in scope changes the
   service account's permissions and the audit design.
8. **Is Bens a first-class rep in the Sheet**, given his data arrives via the
   legacy-transcripts path rather than the normal pipeline? Affects whether
   he appears in team comparisons on equal footing.

---

## Sources

Repo-internal (highest confidence — read directly): `SYSTEM_OVERVIEW.md`,
`HANDOFF.md`, `CLAUDE.md`, `brief.txt`, `appsscript.json`,
`tools/deploy/setup_ovh.sh`, `tools/deploy/README.md`,
`Phase2_CallScoring.gs`, `Phase6_TrainingCallReview.gs`,
`Phase7_DailySelfPractice.gs`.

External:

- [Sheets API usage limits](https://developers.google.com/workspace/sheets/api/limits) — 300 reads/min/project, 60/min/user, 429 on overage
- [Apps Script quotas overview (2026)](https://dev.to/stack_c285afb2fa0bef/google-apps-script-quota-limits-2026-every-error-every-fix-2p87) — 6-min execution cap, UrlFetch daily limits
- [Configure the OAuth consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent) — Internal user type, no verification review
- [Verify the Google ID token server-side](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token) — `hd` claim semantics
- [oauth2-proxy Google provider](https://oauth2-proxy.github.io/oauth2-proxy/configuration/providers/google/) and [issue #2363 on `hd` verification](https://github.com/oauth2-proxy/oauth2-proxy/issues/2363)
- [Google login for FastAPI (Authlib)](https://blog.authlib.org/2020/fastapi-google-login)
- [Tailscale free plans](https://tailscale.com/docs/account/manage-plans/free-plans-discounts) and [2026 pricing change coverage](https://pbxscience.com/tailscale-overhauls-pricing-free-plan-now-supports-six-users-with-unlimited-devices/) — **verify current user cap directly**
- [FASTPANEL reverse proxy discussion](https://lowendtalk.com/discussion/202355/installing-docker-and-portainer-on-fastpanel-and-exposing-applications-with-reverse-proxy) and [nginx reverse proxy guide](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/)
- [Choosing a charting library: ECharts vs D3 vs Recharts vs Plotly vs Chart.js](https://www.ridhwaan.xyz/blog/choosing-a-charting-library-echarts-d3-recharts-plotly-chartjs-deckgl/)
- [FastAPI + HTMX: the no-build full-stack](https://blakecrosley.com/guides/fastapi-htmx)
- [SQLite vs Postgres for small web apps (2026)](https://goilerplate.com/blog/sqlite-vs-postgres-indie-saas)
- [Uptime Kuma vs Healthchecks.io trade-offs](https://futurion.blog/self-hosting-uptime-kuma-vs-healthchecks-io-honest-trade-offs-for-solo-builders/)
- [Ubuntu server hardening checklist](https://privatedevops.com/articles/server-hardening-checklist-ubuntu-2404)
- [Apps Script webhooks with HMAC verification](https://dev.to/hayrullahkar/bypass-zapier-build-production-grade-webhooks-in-google-apps-script-h1c)

Note on sourcing: this session's network proxy blocked direct fetches to
`developers.google.com`, `tailscale.com` and `oauth2-proxy.github.io`, so
those points come from search-result summaries rather than the primary docs.
The Sheets quota numbers, the Internal-consent-screen behaviour and the
Tailscale free-tier user count are the three worth re-checking against the
primary source before they become load-bearing decisions.
