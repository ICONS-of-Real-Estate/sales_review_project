# tools/ — Call Transcription Scripts

This folder backfills Google Drive with transcripts for Sean's, Joana's, and
Tomás's recorded sales/QC calls. Each script scans a set of Drive folders for videos
that don't already have a `"<name> — Transcript"` doc next to them,
transcribes the missing ones, and drops the transcript back into the same
Drive folder as a Google Doc.

All scripts are **safely re-runnable** — they skip anything already
transcribed, so running one again later only picks up new recordings.

**The three `*_whisper.py` scripts (Sean/Tomás/Joana) are also safe to run on
multiple machines at once against the same folder(s)** — e.g. two laptops
plus a cloud VM chewing through the same backlog together. Each one claims a
video (a small `.lock-<id>` marker file dropped in the same Drive folder)
before transcribing it; if another machine already claimed it, it's skipped
in favor of the next pending video. A lock left behind by a crashed/killed
process is treated as abandoned and stolen after 6 hours. The Gemini/Qwen
engines don't have this yet — don't run the same engine's script for the same
person on two machines simultaneously, they'll duplicate work.

## One-time setup

You already have `credentials.json` and `token.json` in this folder, so the
Google OAuth step is done. If you ever need to redo it on a fresh machine:

1. Google Cloud Console → APIs & Services → Credentials → Create Credentials
   → OAuth client ID → Desktop app. Download the JSON, save it here as
   `credentials.json`.
2. Enable the Google Drive API on that same project.
3. The first run of any script below opens a browser tab for Google
   login/consent, then caches `token.json` so future runs don't prompt again.

Install Python dependencies (do this once, or after pulling changes to
`requirements.txt`):

```powershell
pip install -r requirements.txt
```

Some scripts also need `ffmpeg` on your PATH (noted per-script below). On
Windows: `winget install Gyan.FFmpeg`, or download from ffmpeg.org and add
its `bin` folder to PATH.

## Which script to run

Three transcription "engines" are available. They all transcribe the same
Drive folders — pick one per person, based on cost/quality trade-offs:

| Script | Engine | Cost | Speaker labels (Rep:/Prospect:) | Extra setup |
|---|---|---|---|---|
| `transcribe_sean_calls.py` | Gemini | ~$0.45/45-min call | Yes | `GEMINI_API_KEY` |
| `transcribe_sean_calls_qwen.py` | Qwen3-ASR-Flash | ~$0.06–0.10/45-min call | No | `DASHSCOPE_API_KEY`, ffmpeg |
| `transcribe_sean_calls_whisper.py` | whisper.cpp (local) | Free | No | ffmpeg only |

The `transcribe_joana_calls*.py` scripts are the same three engines pointed
at Joana's recordings instead of Sean's. `transcribe_tomas_calls.py` /
`transcribe_tomas_calls_whisper.py` are the Gemini and Whisper engines
pointed at Tomás's own sales calls (there's no Qwen variant for him yet —
add one the same way if needed). `transcribe_discovery_calls.py` is the
Gemini engine pointed at the shared **Discovery Call Recordings** folder
(Kris copied every AM's old Discovery calls in there 03/09/2026) — see its
own section below, it has one extra wrinkle the others don't.

**Only run one engine per person per batch** — running two against the same
folder just wastes money/time re-transcribing calls that already have a doc
from the other engine (the "already transcribed" skip-check only looks for
*any* transcript doc, not which engine made it).

## How to launch each one

Run all of these from this `tools/` directory (`cd` here first if your
shell is somewhere else).

### Sean — Gemini (recommended default; produces speaker labels)
```powershell
$env:GEMINI_API_KEY = "<your key from aistudio.google.com/apikey>"
python transcribe_sean_calls.py
```

### Sean — Qwen (cheaper, no speaker labels)
```powershell
$env:DASHSCOPE_API_KEY = "<your key from dashscope.console.aliyun.com>"
python transcribe_sean_calls_qwen.py
```

### Sean — Whisper (free, fully local, no speaker labels)
```powershell
python transcribe_sean_calls_whisper.py
```
First run downloads the `small.en` model (~500MB) to a local cache, then
never touches the network again.

### Joana — Whisper (free, fully local, no speaker labels)
```powershell
python transcribe_joana_calls_whisper.py
```
`JOANA_FOLDERS` (in `transcribe_joana_calls.py`) now points at her "Joana
Peixe" Drive folder of QC & Sales Call recordings. Works identically to
the Sean/Tomás Whisper scripts above, including the multi-machine lock.

### Joana — Gemini (produces speaker labels)
```powershell
$env:GEMINI_API_KEY = "<your key from aistudio.google.com/apikey>"
python transcribe_joana_calls.py
```

### Tomás — Gemini (recommended default; produces speaker labels)
```powershell
$env:GEMINI_API_KEY = "<your key from aistudio.google.com/apikey>"
python transcribe_tomas_calls.py
```

### Tomás — Whisper (free, fully local, no speaker labels)
```powershell
python transcribe_tomas_calls_whisper.py
```
Same model download note as Sean's Whisper variant above. If this machine
already ran Sean's Whisper backlog, everything needed is already installed —
just point it at this script instead.

### Discovery calls — Gemini (all AMs, shared folder; produces speaker labels)
```powershell
$env:GEMINI_API_KEY = "<your key from aistudio.google.com/apikey>"
python transcribe_discovery_calls.py
```
Points at the shared **Discovery Call Recordings** Drive folder
(`1arDFT1Mt0yT99J_QqDeyQAyMGc8rqGtm`), not a per-person folder — every AM's
old Discovery calls got copied in there 03/09/2026, and new ones going
forward should land there too. Two things make this one different from the
others:
- Some items in that folder are Drive **shortcuts** to a recording that
  actually lives elsewhere (wherever Meet auto-filed it) rather than a real
  copy of the video — this script resolves those to the real file
  automatically, no manual fixing needed.
- Many of these already have a **"Notes by Gemini"** doc sitting next to
  them (Google Meet's own auto-generated meeting notes). That's an AI
  *summary*, not a verbatim transcript, and does **not** count as
  already-transcribed — this script only skips a video once a real
  `"<title> — Transcript"` doc exists for it, so it will still transcribe
  videos that already have Notes-by-Gemini next to them.

### Smoke-testing before a full run
Each engine has a one-file sanity check that grabs a single video, transcribes
it, and writes the result back — useful for confirming quality (especially
Qwen/Whisper's lack of speaker labels) before pointing a script at the whole
backlog:
```powershell
python test_single_transcription.py          # Gemini
python test_single_transcription_qwen.py     # Qwen
python test_single_transcription_whisper.py  # Whisper
```

## Running all three people at once (Sean + Joana + Tomás)

`transcribe_all.py` runs all three Whisper backlogs back-to-back in one
process — same lock-safe behavior as running each `*_whisper.py` script
individually, just sequenced for you. Bens isn't included: his calls go
through Riverside, which already transcribes them, so there's no raw-video
folder to point this at for him.

```powershell
python transcribe_all.py
```

For unattended deployment on the OVH VPS (auto-runs on a schedule, lowest
CPU/IO priority so it never slows down the hosted websites), see
`deploy/README.md` in this same folder.

## Running on a headless machine (e.g. an OVH cloud VM)

The OAuth step above (`flow.run_local_server(port=0)`) opens a real browser
tab — that only works on a machine with a desktop/browser. A headless cloud
VM has neither, so **copy `credentials.json` and `token.json` from a laptop
that's already authorized** into this folder on the VM instead of trying to
run the login flow there. Same two files, same folder, no re-login needed —
this is exactly how the lock feature above lets that VM safely join the same
batch as your existing laptops.

## Where the output goes

Everything lands back in the same Drive folder(s) each script reads from:
- **Sean — Sales Calls**: `1gFb7YnXbnGAowAJgnLE2KNp5iKOCfnYH`
- **Sean — Qualification Calls**: `15YMEMseEvUQakgDF00BtQg3QK6fiTsjX`
- **Tomás — Sales Calls**: `1QjmKqmTQpg6yePI55L_tqtoEvIf0Lbf_`
- **Discovery Call Recordings** (shared, all AMs): `1arDFT1Mt0yT99J_QqDeyQAyMGc8rqGtm`

Each new video gets a matching `"<name> — Transcript"` Google Doc next to it.
Tomás's video filenames carry their `.mp4` extension in the Drive name itself
(e.g. `"Steve Houck Sales Call.mp4"`) — both Tomás scripts strip that before
building the transcript doc's name, so it still comes out as
`"Steve Houck Sales Call — Transcript"`, matching everyone else's convention.

Both Tomás scripts also append a line to `tools/tomas_transcribed_log.txt`
(title | Drive video ID | transcript doc link) every time they finish one —
a local, human-readable record of what's been done, useful when the backlog
is being worked through gradually over several days/runs. It's just a
progress log, not what makes re-running safe: the actual "skip what's
already done" logic still checks Drive itself for the matching
`"<title> — Transcript"` doc, so re-running after uploading more of Tomás's
calls will still only transcribe the new ones even without this file (and
the log itself is gitignored — it's per-machine state, not shared).
