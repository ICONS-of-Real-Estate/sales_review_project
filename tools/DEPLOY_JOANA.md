# Deploying Joana's transcription on a new machine

One-page setup for getting `transcribe_joana_calls_whisper.py` running on a
machine that hasn't run any of this project's scripts before. Free, fully
local (no API key, no per-call cost) — safe to run alongside other machines
already working Sean's/Tomás's backlogs at the same time.

## 1. Get the code

```powershell
git clone <repo-url> sales_review_project
cd sales_review_project\tools
```

(If it's already cloned, just `git pull origin main` — make sure you're on
`main`, not an old feature branch: `git branch` should show `* main`.)

## 2. Copy over the two auth files

These are gitignored (per-machine secrets, not shared code) — `git
pull`/`clone` will **not** bring them over. Copy them from a machine that's
already logged in (e.g. Kris's laptop) into this same `tools\` folder:

- `credentials.json`
- `token.json`

Same two files, same folder, no browser login needed on this machine — this
is what lets a headless/new machine safely join the batch.

## 3. Install dependencies

```powershell
pip install -r requirements.txt
```

Also install `ffmpeg` and put it on PATH — Whisper needs it:
```powershell
winget install Gyan.FFmpeg
```
(or download from ffmpeg.org and add its `bin` folder to PATH manually)

## 4. Run it

```powershell
python transcribe_joana_calls_whisper.py
```

- No API key needed.
- First run downloads the `small.en` Whisper model (~500MB) once, then runs
  fully offline from then on.
- It'll print a folder-by-folder count up front (`[QC & Sales Calls] N to
  do, M already transcribed`) before starting — that tells you right away
  whether it found her backlog.
- Safe to Ctrl+C and re-run any time — it skips anything already
  transcribed (checks Drive for the matching `"<title> — Transcript"` doc),
  and picks up an in-progress download/transcript from where it left off.
- Safe to run on this machine at the same time as another machine also
  running Joana's Whisper script — each video gets a small `.lock-<id>`
  marker file in the Drive folder so two machines won't duplicate the same
  video (a lock is treated as abandoned and stolen after 6 hours if a
  process crashes).

## 5. Where it lands

Transcripts get written back into her `JOANA_FOLDERS` Drive folder(s)
(currently just `"QC & Sales Calls"`, ID `17YaE4fBjEBFissvR-l7_GOkoTnZjdQq5`
— see `transcribe_joana_calls.py`), as a `"<name> — Transcript"` Google Doc
next to each video.

## 6. After transcripts exist

This script only creates transcripts — it doesn't score them. Once a batch
is done, someone still needs to point `Phase2_CallScoring.gs` at Joana's
folder and run the scoring pass (see `transcribe_joana_calls.py`'s
docstring: set `PHASE2_CONFIG.LEGACY_FOLDERS.Joana` to the same folder ID
and run `scoreJoanaLegacyTranscripts()`), against the shared Bens/Joana
rubric — she's not on Sean's stricter variant.
