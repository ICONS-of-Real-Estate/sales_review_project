#!/usr/bin/env python3
"""
Backfills Drive transcripts for the daily objection-practice drill videos
(Phase7_DailySelfPractice.gs) — same situation as Sean/Joana's call
recordings, so this reuses all of transcribe_sean_calls.py's Drive/Gemini
plumbing rather than duplicating it. Only the source folders differ: one
per rep, under "Daily Objection Practice".

Once a rep uploads today's practice video into their folder below, run
this (by hand, or on a nightly scheduled task on someone's machine) to drop
a "<video name> — Transcript" Doc next to it. Phase7's grading trigger
picks up any transcript it hasn't graded yet the next time it runs.

Setup: identical to transcribe_sean_calls.py (see that file's docstring) —
same credentials.json/token.json, same GEMINI_API_KEY.
"""

import os
import sys
import tempfile
import time

from transcribe_sean_calls import (
    QuotaExhaustedError,
    download_video,
    format_duration_,
    get_drive_service,
    list_videos,
    save_transcript_doc,
    transcribe_with_gemini,
    transcript_temp_path,
)
from google import genai

# Same three folders as DAILY_PRACTICE_CONFIG.FOLDERS in Phase7_DailySelfPractice.gs.
DAILY_PRACTICE_FOLDERS = {
    "Bens": "1NG3YUXlCWOjcJT8d8ECU0uw6hEVL-fHC",
    "Sean": "1SJJ5Jek_4vEzmS907NQofDYq6bl-Mnr1",
    "Joana": "1fevtADQtgtb6Q1UAffp-cZjcNB6t6VRm",
}


def main():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        sys.exit("Set GEMINI_API_KEY before running.")
    client = genai.Client(api_key=api_key)

    drive = get_drive_service()

    # Pre-scan every folder up front (list_videos() gets called once per
    # folder either way) so the per-video progress/ETA lines below can report
    # against the WHOLE backlog, not just whatever folder happens to be
    # running.
    work_by_folder = {}
    total_videos = 0
    for rep, folder_id in DAILY_PRACTICE_FOLDERS.items():
        videos, existing_names = list_videos(drive, folder_id)
        pending = [v for v in videos if f"{v['name'].strip()} — Transcript" not in existing_names]
        work_by_folder[rep] = (folder_id, pending)
        total_videos += len(pending)
        print(f"  [{rep}] {len(pending)} to do, {len(videos) - len(pending)} already transcribed")
    print(f"\n{total_videos} video(s) to transcribe across {len(DAILY_PRACTICE_FOLDERS)} rep folder(s).")

    batch_start = time.time()
    completed = 0
    # Only videos transcribed FRESH this run go in here -- a reused
    # download/transcript from a prior interrupted run finishes far faster
    # than a real transcription, so it isn't a fair basis for estimating what
    # the REMAINING (not-yet-started) videos will take.
    per_video_times = []

    for rep, (folder_id, videos) in work_by_folder.items():
        print(f"\n=== {rep} ===")
        for video in videos:
            title = video["name"].strip()
            print(f"[transcribing] {title} ({int(video.get('size', 0)) / 1e6:.0f} MB)")

            local_path = os.path.join(tempfile.gettempdir(), f"{video['id']}.mp4")
            txt_path = transcript_temp_path(video["id"])
            video_start = time.time()
            fresh = False
            try:
                if os.path.exists(txt_path):
                    # Already transcribed on a prior run that got interrupted
                    # before a successful upload -- reuse it instead of
                    # paying for another Gemini transcription.
                    print("    (reusing transcript from a previous, interrupted run)")
                    with open(txt_path, "r", encoding="utf-8") as f:
                        transcript = f.read()
                else:
                    if os.path.exists(local_path):
                        print("    (reusing file downloaded on a previous, quota-stopped run)")
                    else:
                        t0 = time.time()
                        download_video(drive, video["id"], local_path)
                        print(f"    download: {format_duration_(time.time() - t0)}")

                    t0 = time.time()
                    transcript = transcribe_with_gemini(client, local_path)
                    print(f"    transcribe: {format_duration_(time.time() - t0)}")
                    fresh = True

                t0 = time.time()
                link = save_transcript_doc(drive, folder_id, video["id"], title, transcript)
                print(f"    upload: {format_duration_(time.time() - t0)}")
                print(f"    done -> {link}")
                if os.path.exists(local_path):
                    os.remove(local_path)
            except QuotaExhaustedError:
                # Stop the whole batch, but keep the local file -- next run picks up
                # transcription directly instead of re-downloading it from scratch.
                raise
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
    try:
        main()
    except QuotaExhaustedError as e:
        sys.exit(
            "\nSTOPPING — Gemini API quota/billing wall: "
            f"{e}\n\n"
            "This is not a bug in the script -- see transcribe_sean_calls.py's docstring "
            "history for what this usually means (free-tier cap, or the prepay-credits "
            "billing sync issue). Re-run this script once it's resolved; it skips "
            "everything already transcribed and picks up right where it stopped."
        )
