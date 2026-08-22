#!/usr/bin/env python3
"""
Backfills Drive transcripts for Joana's recorded sales/QC calls — same
situation as Sean (raw Zoom recordings, no existing transcripts), so this
reuses all of transcribe_sean_calls.py's Drive/Gemini plumbing rather than
duplicating it. Only the source folders differ.

JOANA_FOLDERS points at her "Joana Peixe" Drive folder of QC & Sales Call
recordings. Works exactly like transcribe_sean_calls.py: skip
already-transcribed videos, retry on quota/connection errors, stop cleanly
on a real billing wall instead of grinding through the whole folder.

Once transcripts exist, run previewJoanaTranscripts() then
scoreJoanaTranscripts() (Phase2_CallScoring.gs, PHASE2_CONFIG.JOANA_FOLDERS
already points at this same folder) in the Apps Script editor to backfill
them into the Sales Call Log, against the shared Bens/Joana rubric — Joana
is not on Sean's stricter variant. (Not scoreJoanaLegacyTranscripts() —
that one assumes a Bens-style flat-folder filename convention these
transcripts don't use, so it would silently match nothing.)

Setup: identical to transcribe_sean_calls.py (see that file's docstring).
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

JOANA_FOLDERS = {
    "QC & Sales Calls": "17YaE4fBjEBFissvR-l7_GOkoTnZjdQq5",
}


def main():
    if not JOANA_FOLDERS:
        sys.exit(
            "JOANA_FOLDERS is still empty — fill in her Drive folder ID(s) at the "
            "top of this script before running (see the docstring above)."
        )

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
            video_folder_id = video.get("parent_folder_id", folder_id)
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
                link = save_transcript_doc(drive, video_folder_id, video["id"], title, transcript)
                print(f"    upload: {format_duration_(time.time() - t0)}")
                print(f"    done -> {link}")
                if os.path.exists(local_path):
                    os.remove(local_path)
            except QuotaExhaustedError:
                # Stop the whole batch, but keep the local file — next run picks up
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
            "This is not a bug in the script — see transcribe_sean_calls.py's docstring "
            "history for what this usually means (free-tier cap, or the prepay-credits "
            "billing sync issue). Re-run this script once it's resolved; it skips "
            "everything already transcribed and picks up right where it stopped."
        )
