# Research prompt — paste this to a fresh Claude session

I need deep research (not code yet) on how to design and deploy a secure
web dashboard for an existing sales-call-review automation system, hosted
on my own OVH Cloud server.

## Context — read this first

The full system is documented in `SYSTEM_OVERVIEW.md` in this repo
(`icons-of-real-estate/sales_review_project`) — read it in full before
anything else. Short version: a Google Apps Script project (8 phases)
grades real estate agents' sales calls against a two-failure-mode rubric
(never asked for the close / objections not handled) using an LLM judge
(Moonshot Kimi), writes results into a shared Google Sheet ("Sales Call
Log"), and sends coaching emails (weekly scorecards, daily practice
drills, handoff briefs). There's also a set of markdown "playbook"
documents in the repo (`Objection_Handling_Playbook.md`,
`Objection_Handling_Playbook_Sean.md`, `Tomas_Playbook.md`) — living
training references built from real transcripts, meant to be read by the
sales team.

Right now the only way to see any of this is opening the raw spreadsheet
or reading markdown files in GitHub. There is no dashboard.

## What I want researched

I want a **secure web application**, deployable on my existing **OVH
Cloud VPS** (already running the Python transcription pipeline as a
systemd service — Ubuntu/Debian-family, moderate specs, not a
Kubernetes-scale box), that gives every team member (a handful of sales
reps + Kris + Tomás, spread across time zones) one visual place to see:

- **Pretty graphs/trends**: each rep's call-quality score over time,
  failure-mode breakdown (never-asked-for-close vs. objections-missed),
  lead-quality verdict distribution, weekly scorecard history, team-wide
  comparison — the kind of thing a manager actually wants to glance at,
  not a spreadsheet pivot table.
- **Training plans**: each rep's current practice-drill assignment/status
  (from Phase 7), their training-cycle history (Phase 6), and the
  playbook documents rendered nicely (not raw markdown/GitHub) — ideally
  browsable/searchable by objection type.
- **Review queue visibility**: what Kris's daily 3-call review cluster is,
  queue age/backlog, calibration agreement over time.
- Should feel "nice and visual" — this is meant to be something the whole
  team actually opens, not an internal ops tool.

## Specific things to research and report back on (in a structured report, with tradeoffs, not just a single opinionated answer)

1. **Data access strategy.** The live data is a Google Sheet + Google Docs
   (playbooks) + Apps Script execution logs, not a real database. Research
   the realistic options for a web app to read this reliably:
   - Reading Google Sheets directly via the Sheets API on a schedule vs.
     having Apps Script itself push data out (e.g., a small `doGet`/webhook
     endpoint, or writing to a separate lightweight DB) vs. mirroring into
     a proper database (Postgres/SQLite) that the web app owns.
   - Pros/cons of continuing to treat the Google Sheet as the system of
     record vs. this being the moment to migrate to a real DB with the
     Sheet as just a human-editable input.
   - How to keep Kris's manual review actions (the `Kris Manual Review
     Verdict` column) as a two-way sync point if the dashboard should ever
     let her review calls from the web instead of the spreadsheet.

2. **Stack choice for a small team internal tool on a single VPS.**
   Research realistic, low-maintenance options (this does not need to
   scale past ~10-20 users) — e.g. a Python backend (FastAPI/Flask, since
   the transcription pipeline is already Python) with a server-rendered
   or lightweight frontend charting library, vs. a full separate
   frontend/backend split (e.g. a small React/Vite frontend + API). Favor
   boring, maintainable, easy-to-secure choices over resume-driven
   architecture. Recommend specific charting libraries suited to "pretty"
   but simple dashboards.

3. **Security, for a real internet-facing box.** This is a live company
   server, not a toy — research and recommend concretely:
   - Reverse proxy + TLS (Caddy vs. nginx+certbot) in front of the app.
   - Authentication approach appropriate for ~5-10 known team members
     (Google OAuth login restricted to the company's own Workspace domain
     is a strong candidate given everything already lives in Google
     Workspace — evaluate it explicitly) vs. simple per-user
     password/magic-link auth.
   - Basic hardening checklist for an OVH VPS running both this new web
     app and the existing transcription systemd service side by side
     (firewall rules, non-root service user, secrets management for the
     Moonshot/Google API keys already in use, fail2ban or equivalent,
     automatic security updates).
   - Whether/how to keep this off the public internet entirely (VPN /
     Tailscale / IP allowlist) as an alternative to public HTTPS + auth,
     and which is the better fit for a small distributed team.

4. **Deployment/ops.** Docker Compose vs. bare systemd services (matching
   the existing transcription service's style) for running the web app +
   any DB alongside the existing Python jobs on the same VPS; how to keep
   deploys simple (this team already has a GitHub → server pull workflow
   for the Apps Script side, so favor something with a similarly simple
   "push to git, pull and restart" deploy story); basic monitoring/alerting
   so a crashed dashboard doesn't sit dead unnoticed like a corrupted
   transcript currently could.

5. **Team-timezone considerations.** The sales team is distributed
   globally (already an issue for scheduled-email timing in the existing
   system) — note anywhere this affects the dashboard design (displaying
   all times in the viewer's local time vs. a fixed business timezone,
   etc.).

## Deliverable

A written research report (not code) covering the above with concrete
recommendations (pick a stack, pick an auth approach, pick a deploy
model) and the reasoning/tradeoffs behind each pick, plus a rough phased
build plan (what to stand up first vs. later). Flag anything you need
clarified before implementation could start (e.g., exact OVH plan
specs/OS, whether a domain name exists, whether Google Workspace admin
access is available to set up OAuth).
