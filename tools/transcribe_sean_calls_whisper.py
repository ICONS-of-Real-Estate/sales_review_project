#!/usr/bin/env python3
"""
Free, fully local alternative to transcribe_sean_calls.py / _qwen.py:
transcribes Sean's recorded calls with whisper.cpp (via the pywhispercpp
Python bindings) running entirely on your own machine -- no API key, no
per-call cost, no data ever leaves this laptop.

Why this is realistic on a laptop with no dedicated GPU (confirmed via
public whisper.cpp CPU benchmarks, not assumed): base.en/small.en run
FASTER than real-time on any 2020-or-later CPU, and even the much larger
large-v3 model manages roughly 3-5x real-time on a plain x86 CPU. This
script defaults to small.en -- a good accuracy/speed balance for CPU-only
hardware. If it's too slow on your specific machine, drop to 'base.en' in
get_whisper_model() below (faster, slightly less accurate); if you later
get real GPU headroom, pywhispercpp also supports CUDA/CoreML/Vulkan
acceleration (see its README) -- this script doesn't need to change,
whisper.cpp just uses whatever it can find.

Trade-off to know before pointing this at the whole backlog: Whisper's
plain transcribe(), like Qwen's, does NOT do speaker diarization -- no
"Rep:"/"Prospect:" labels like Gemini produces. Same caveat as
transcribe_sean_calls_qwen.py: fine if speaker roles are inferable from
context, worth confirming on one real transcript first. See
test_single_transcription_whisper.py for that smoke test.

transcribe_sean_calls.py (Gemini) and transcribe_sean_calls_qwen.py (Qwen)
are both untouched and still work -- keep either as a fallback if local
Whisper's quality, missing diarization, or CPU speed on your machine turns
out to be a problem.

Reuses all the Drive plumbing (auth, folder listing, download, upload-back)
from transcribe_sean_calls.py -- only the transcription step changes, so run
this from the same tools/ directory with the same credentials.json/token.json.

Setup (in addition to transcribe_sean_calls.py's one-time Drive OAuth setup):
    pip install -r requirements.txt          (adds pywhispercpp)
    Install ffmpeg and make sure it's on your PATH -- needed to read the
    source .mp4 files directly (pywhispercpp only handles .wav natively).
    On Windows: winget install Gyan.FFmpeg (or download from ffmpeg.org and
    add the bin folder to PATH). Already installed if you set up the Qwen
    path first.
    python transcribe_sean_calls_whisper.py

No API key, no environment variable to set. The model itself (~500MB for
small.en) downloads automatically to a local cache the first time this runs,
then never needs the network again.
"""

import os
import tempfile
import time

from transcribe_sean_calls import (
    SOURCE_FOLDERS,
    download_video,
    format_duration_,
    get_drive_service,
    list_videos,
    save_transcript_doc,
    transcript_temp_path,
)

_whisper_model = None


def get_whisper_model():
    """Loads the whisper.cpp model once per process (loading it is the slow
    part; reuse across every file in the batch instead of reloading each time)."""
    global _whisper_model
    if _whisper_model is None:
        from pywhispercpp.model import Model
        _whisper_model = Model("small.en", print_realtime=False, print_progress=False)
    return _whisper_model


def transcribe_with_whisper(local_path):
    model = get_whisper_model()
    segments = model.transcribe(local_path)
    return " ".join(seg.text.strip() for seg in segments).strip()


def main():
    drive = get_drive_service()

    # Pre-scan every folder up front (list_videos() gets called once per
    # folder either way) so the per-video progress/ETA lines below can report
    # against the WHOLE backlog, not just whatever folder happens to be
    # running.
    work_by_folder = {}
    total_videos = 0
    for folder_label, folder_id in SOURCE_FOLDERS.items():
        videos, existing_names = list_videos(drive, folder_id)
        pending = [v for v in videos if f"{v['name'].strip()} — Transcript" not in existing_names]
        work_by_folder[folder_label] = (folder_id, pending)
        total_videos += len(pending)
        print(f"  [{folder_label}] {len(pending)} to do, {len(videos) - len(pending)} already transcribed")
    print(f"\n{total_videos} video(s) to transcribe across {len(SOURCE_FOLDERS)} folder(s).")

    batch_start = time.time()
    completed = 0
    # Only videos transcribed FRESH this run go in here -- a reused
    # download/transcript from a prior interrupted run finishes far faster
    # than a real transcription, so it isn't a fair basis for estimating what
    # the REMAINING (not-yet-started) videos will take.
    per_video_times = []

    for folder_label, (folder_id, videos) in work_by_folder.items():
        print(f"\n=== {folder_label} ===")
        for video in videos:
            title = video["name"].strip()
            print(f"[transcribing] {title} ({int(video.get('size', 0)) / 1e6:.0f} MB)")

            local_path = os.path.join(tempfile.gettempdir(), f"{video['id']}.mp4")
            txt_path = transcript_temp_path(video["id"])
            video_start = time.time()
            fresh = False
            try:
                if os.path.exists(txt_path):
                    # A previous run already finished transcribing this one but
                    # got interrupted before a successful upload (process
                    # killed, laptop slept through a long network drop, etc.)
                    # -- reuse it instead of burning another 20-40+ minutes
                    # re-transcribing.
                    print("    (reusing transcript from a previous, interrupted run)")
                    with open(txt_path, "r", encoding="utf-8") as f:
                        transcript = f.read()
                else:
                    if os.path.exists(local_path):
                        print("    (reusing file downloaded on a previous run)")
                    else:
                        t0 = time.time()
                        download_video(drive, video["id"], local_path)
                        print(f"    download: {format_duration_(time.time() - t0)}")

                    t0 = time.time()
                    transcript = transcribe_with_whisper(local_path)
                    print(f"    transcribe: {format_duration_(time.time() - t0)}")
                    fresh = True

                t0 = time.time()
                link = save_transcript_doc(drive, folder_id, video["id"], title, transcript)
                print(f"    upload: {format_duration_(time.time() - t0)}")
                print(f"    done -> {link}")
                if os.path.exists(local_path):
                    os.remove(local_path)
            except Exception as e:
                print(f"    FAILED: {e}")
                if os.path.exists(local_path):
                    os.remove(local_path)
                continue
            finally:
                video_total = time.time() - video_start
                print(f"    total: {format_duration_(video_total)}")

            completed += 1
            if fresh:
                per_video_times.append(video_total)
            remaining = total_videos - completed
            line = f"    progress: {completed}/{total_videos} done, elapsed {format_duration_(time.time() - batch_start)}"
            if remaining and per_video_times:
                avg = sum(per_video_times) / len(per_video_times)
                line += f", ~{format_duration_(avg * remaining)} left ({format_duration_(avg)}/video avg)"
            print(line)

    print(f"\nAll done: {completed}/{total_videos} video(s) transcribed. "
          f"Total elapsed: {format_duration_(time.time() - batch_start)}")


if __name__ == "__main__":
    main()
