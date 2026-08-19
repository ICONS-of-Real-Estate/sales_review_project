# tools/ — Call Transcription Scripts

This folder backfills Google Drive with transcripts for Sean's, Joana's, and
Tomás's recorded sales/QC calls. Each script scans a set of Drive folders for videos
that don't already have a `"<name> — Transcript"` doc next to them,
transcribes the missing ones, and drops the transcript back into the same
Drive folder as a Google Doc.

All scripts are **safely re-runnable** — they skip anything already
transcribed, so running one again later only picks up new recordings.

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
add one the same way if needed).

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

### Joana — any engine
**Not ready yet.** `transcribe_joana_calls.py` (and its `_qwen`/`_whisper`
siblings) will exit immediately with an error — `JOANA_FOLDERS` is still a
placeholder at the top of the file. Fill in her real Drive folder ID(s)
there first, then it works identically to the Sean scripts above.

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

## Where the output goes

Everything lands back in the same Drive folder(s) each script reads from:
- **Sean — Sales Calls**: `1gFb7YnXbnGAowAJgnLE2KNp5iKOCfnYH`
- **Sean — Qualification Calls**: `15YMEMseEvUQakgDF00BtQg3QK6fiTsjX`
- **Tomás — Sales Calls**: `1QjmKqmTQpg6yePI55L_tqtoEvIf0Lbf_`

Each new video gets a matching `"<name> — Transcript"` Google Doc next to it.
Tomás's video filenames carry their `.mp4` extension in the Drive name itself
(e.g. `"Steve Houck Sales Call.mp4"`) — both Tomás scripts strip that before
building the transcript doc's name, so it still comes out as
`"Steve Houck Sales Call — Transcript"`, matching everyone else's convention.
