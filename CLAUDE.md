# CLAUDE.md — persistent project notes

## Deploying changes to the live Apps Script project

This repo is bound to a real Apps Script project via `clasp`
(script ID `1qz0FO4M6Yzkyt5Em0qnIen8J03SP2m9Zc3JkcgPYJ-zxihwKwRFDqacX`,
bound to the Sales Call Log sheet). **After pushing `.gs`/`appsscript.json`
changes to `main` on GitHub, the deploy step is:**

```
git pull
clasp push
```

on whichever machine has `.clasp.json` (local-only, holds the real script
ID — recreate with
`{"scriptId":"1qz0FO4M6Yzkyt5Em0qnIen8J03SP2m9Zc3JkcgPYJ-zxihwKwRFDqacX","rootDir":"."}`
if missing). **Do not tell the user to manually paste code into the Apps
Script browser editor** — that was only ever a workaround from before clasp
was set up (19/08/2026), and giving that instruction now causes GitHub and
the live project to drift.

The reverse also matters: **never edit `ENABLED` flags or code directly in
the Apps Script browser editor** — the next `clasp push` silently reverts
any such change. All config changes go through the repo (commit → push →
`clasp push`).

This sandbox/session does not have `.clasp.json` (it's local-only, not
committed), so Claude cannot run `clasp push` itself from here — say so
explicitly and tell the user to run it, rather than claiming the deploy is
done once the GitHub push succeeds.

## Where to look for more context

- `HANDOFF.md` — session-to-session handoff notes (what's live, what's
  blocked, exact next steps). Read this at the start of any session
  touching the Apps Script phases.
- `brief.txt` — the original architecture/design brief.
- `Phase2_CallGradingSOP.md` — the call-grading rubric SOP.

## Apps Script conventions specific to this project

- Apps Script's "Select function to run" dropdown hides trailing-underscore
  functions. Every human-run entry point needs a thin no-underscore wrapper
  (e.g. `previewWeeklyScorecards()` calling `previewWeeklyScorecards_()`).
- Each phase is gated by its own `<PHASE>_CONFIG.ENABLED` flag, flipped only
  after running that phase's `preview*()` function and confirming the
  output looks right.
- `htmlBody` passed to `guardedSend_`/`MailApp.sendEmail` must contain raw
  HTML tags, not HTML-escaped text (`<p>`, not `&lt;p&gt;`) — escaped tags
  render as literal text in Gmail. This has bitten a prior session already.
