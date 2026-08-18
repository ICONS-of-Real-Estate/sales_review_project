#!/usr/bin/env python3
"""
Free, fully local alternative to transcribe_joana_calls.py, using
whisper.cpp instead of Gemini/Qwen -- same reasoning as
transcribe_sean_calls_whisper.py (no API key, no per-call cost, runs
entirely on your own CPU; see that file's docstring for the full
explanation of why this works fine without a dedicated GPU). Reuses the
Drive plumbing from transcribe_sean_calls.py, the whisper.cpp wrapper from
transcribe_sean_calls_whisper.py, and the JOANA_FOLDERS placeholder from
transcribe_joana_calls.py, so there is exactly one place to fill in her
Drive folder ID(s) once known.

Setup: same as transcribe_sean_calls_whisper.py (pip install -r
requirements.txt + ffmpeg on PATH). No API key needed.
"""

import os
import sys
import tempfile
import time

from transcribe_sean_calls import download_video, format_duration_, get_drive_service, list_videos, save_transcript_doc, transcript_temp_path
from transcribe_sean_calls_whisper import transcribe_with_whisper
from transcribe_joana_calls import JOANA_FOLDERS


def main():
    if not JOANA_FOLDERS:
        sys.exit(
            "JOANA_FOLDERS is still empty — fill in her Drive folder ID(s) in "
            "transcribe_joana_calls.py before running."
        )

    drive = get_drive_service()

    # Pre-scan every folder up front (list_videos() gets called once per
    # folder either way) so the per-video progress/ETA lines below can report
    # against the WHOLE backlog, not just whatever folder happens to be
    # running.
    work_by_folder = {}
    total_videos = 0
    for folder_label, folder_id in JOANA_FOLDERS.items():
        videos, existing_names = list_videos(drive, folder_id)
        pending = [v for v in videos if f"{v['name'].strip()} — Transcript" not in existing_names]
        work_by_folder[folder_label] = (folder_id, pending)
        total_videos += len(pending)
        print(f"  [{folder_label}] {len(pending)} to do, {len(videos) - len(pending)} already transcribed")
    print(f"\n{total_videos} video(s) to transcribe across {len(JOANA_FOLDERS)} folder(s).")

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
