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

## Parallel workers (multi-core servers like the OVH VPS)

Set TRANSCRIBE_WORKERS to run that many copies of the full Sean+Joana+Tomas
sweep at once, in separate processes. This is safe -- not a hack on top of
the single-machine case -- because it's exactly the same distributed lock
`run_whisper_batch` already uses to let multiple LAPTOPS share one backlog
(see its docstring in transcribe_sean_calls.py): each worker claims a video
via a Drive lock file before starting it, so N workers on one box behave
just like N separate machines and never double-transcribe the same video.

Each worker loads its own copy of the Whisper model (~500MB RAM, ~1-2 CPU
threads by default -- set WHISPER_THREADS to change) and works through
the folders independently, so pick TRANSCRIBE_WORKERS x WHISPER_THREADS to
roughly match the core count you want to use. Output from different
workers interleaves in the log since they print concurrently -- each line
still names its own video/folder, so it stays readable, just not grouped
by worker.

Leave TRANSCRIBE_WORKERS unset (or 1) for the old single-process behavior
-- that's still the right default on a laptop doing other things at the
same time.
"""

import os
import time

from transcribe_sean_calls import SOURCE_FOLDERS, run_whisper_batch
from transcribe_sean_calls_whisper import transcribe_with_whisper
from transcribe_joana_calls import JOANA_FOLDERS
from transcribe_tomas_calls import TOMAS_FOLDERS, clean_title_, log_completed_

BATCHES = [
    ("Sean", SOURCE_FOLDERS, None, None),
    ("Joana", JOANA_FOLDERS, None, None),
    ("Tomas", TOMAS_FOLDERS, lambda v: clean_title_(v["name"]), log_completed_),
]


def _run_batches(worker_id=None, startup_delay=0):
    if startup_delay:
        # Stagger workers' startup so they don't all hit Google's OAuth
        # token refresh and Whisper's model-load CPU spike in the exact
        # same instant -- a real (if narrow) risk of a corrupt token.json
        # if two processes refresh-and-write it at literally the same time.
        time.sleep(startup_delay)
    prefix = f"[worker {worker_id}] " if worker_id is not None else ""
    for label, folders, title_fn, log_fn in BATCHES:
        print(f"\n{prefix}{'=' * 60}\n{prefix}{label}\n{prefix}{'=' * 60}")
        if not folders:
            print(f"{prefix}  (no folders configured for {label} yet -- skipping)")
            continue
        run_whisper_batch(folders, transcribe_with_whisper, title_fn=title_fn, log_completed_fn=log_fn)
    print(f"\n{prefix}This worker's batches done.")


def main():
    n_workers = int(os.environ.get("TRANSCRIBE_WORKERS", "1"))
    if n_workers <= 1:
        _run_batches()
        print("\nAll batches done.")
        return

    import multiprocessing as mp

    print(f"Running with {n_workers} parallel workers (TRANSCRIBE_WORKERS={n_workers}) "
          f"-- each claims its own video via the same Drive lock that keeps "
          f"multiple machines from double-transcribing.")
    procs = [
        mp.Process(target=_run_batches, args=(i, i * 5), name=f"worker-{i}")
        for i in range(n_workers)
    ]
    for p in procs:
        p.start()
    for p in procs:
        p.join()
    print("\nAll workers finished.")


if __name__ == "__main__":
    main()
