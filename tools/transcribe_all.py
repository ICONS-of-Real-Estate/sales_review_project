#!/usr/bin/env python3
"""
Runs Sean's, Joana's, and Tomás's Whisper transcription backlogs in one
process, one after another, using the free local Whisper engine (no API
key, no per-call cost). Meant for unattended runs on a server — see
deploy/setup_ovh.sh in this same tools/ folder for wiring this up as a
low-priority scheduled job on the OVH VPS.

Not included: Bens. His calls go through Riverside, which already
transcribes them for him — he downloads his own finished transcript
manually. There's no raw-video Drive folder to point this at for him.

This file only sequences the three existing per-person batches — it
reuses each one's own folder config, title-naming rule, and completion log
(Tomás's has both; Sean's and Joana's have neither) rather than
duplicating any of that logic. Each batch is independently
multi-machine-safe (see run_whisper_batch's lock docstring in
transcribe_sean_calls.py), so running this on the OVH VPS at the same time
as, say, a laptop still working through Tomás's backlog is fine — they
won't double-transcribe the same video.

Setup: identical to the individual *_whisper.py scripts — pip install -r
requirements.txt, ffmpeg on PATH, and credentials.json + token.json
already present in this folder. No API key needed for any of it.
"""

from transcribe_sean_calls import SOURCE_FOLDERS, run_whisper_batch
from transcribe_sean_calls_whisper import transcribe_with_whisper
from transcribe_joana_calls import JOANA_FOLDERS
from transcribe_tomas_calls import TOMAS_FOLDERS, clean_title_, log_completed_

BATCHES = [
    ("Sean", SOURCE_FOLDERS, None, None),
    ("Joana", JOANA_FOLDERS, None, None),
    ("Tomas", TOMAS_FOLDERS, lambda v: clean_title_(v["name"]), log_completed_),
]


def main():
    for label, folders, title_fn, log_fn in BATCHES:
        print(f"\n{'=' * 60}\n{label}\n{'=' * 60}")
        if not folders:
            print(f"  (no folders configured for {label} yet -- skipping)")
            continue
        run_whisper_batch(folders, transcribe_with_whisper, title_fn=title_fn, log_completed_fn=log_fn)
    print("\nAll batches done.")


if __name__ == "__main__":
    main()
