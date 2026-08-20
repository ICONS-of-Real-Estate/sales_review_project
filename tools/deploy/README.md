# Deploying the transcription backlog on the OVH VPS

Runs `transcribe_all.py` (Sean + Joana + Tomás, Whisper engine — free,
local, no API key) automatically and forever, at the lowest possible
priority so it never slows down the websites this box also hosts.

## 1. Get the code and auth files onto the VPS

```bash
git clone <repo-url> sales_review_project
cd sales_review_project
```

Copy `credentials.json` and `token.json` into `tools/` from an
already-authorized machine (e.g. `scp credentials.json token.json
you@vps-ip:~/sales_review_project/tools/`) — these are gitignored secrets,
`git pull` won't bring them over, and there's no browser on this box to do
a fresh OAuth login.

## 2. Run the setup script once

```bash
cd sales_review_project
bash tools/deploy/setup_ovh.sh
```

This installs Python/ffmpeg, creates a virtualenv, installs the pip
dependencies, and registers a **systemd timer** that runs
`transcribe_all.py` every 6 hours, at `Nice=19` / idle IO / idle CPU
scheduling — the server only ever spends spare cycles and spare disk
bandwidth on this, so a busy moment for the actual websites always wins.
Given this box is "normally under very little load," most runs should
proceed at essentially full CPU speed anyway (Whisper's small.en model
runs faster than real-time on any modern CPU core) — the idle priority
only kicks in on the rare occasion something else needs the machine.

## 3. Check on it

```bash
systemctl list-timers transcribe-all.timer   # when it'll next fire
sudo systemctl start transcribe-all.service   # trigger a run right now
journalctl -u transcribe-all.service -f       # watch a run live
```

Safe to trigger manually any time — it always resumes from wherever it
left off (skips anything with a matching `"<title> — Transcript"` doc
already in Drive), and systemd won't let two runs overlap.

## 4. After transcripts exist

Transcription alone doesn't score anything. Once a person's backlog has
real transcripts, someone still needs to run the matching scoring step in
`Phase2_CallScoring.gs` (`scoreSeanTranscripts()`, `scoreTomasTranscripts()`,
or wire up `scoreJoanaLegacyTranscripts()` per `transcribe_joana_calls.py`'s
docstring).
