#!/usr/bin/env python3
"""
Backfills Drive transcripts for Tomás's own sales calls -- his direct
closing calls with prospects (a different folder from the "Training Calls"
folders set up earlier for reviewing his coaching calls with reps). Same
situation as Sean/Joana (raw Zoom recordings, no existing transcripts), so
this reuses all of transcribe_sean_calls.py's Drive/Gemini plumbing rather
than duplicating it. Only the source folder differs.

Unlike Sean's/Joana's videos, these files were uploaded with their ".mp4"
extension baked into the Drive filename itself (e.g. "Steve Houck Sales
Call.mp4"), so this module also strips that before building the
"<title> — Transcript" doc name -- see clean_title_() below, used by every
variant of this script (this one and transcribe_tomas_calls_whisper.py).

Once transcripts exist, these should get scored against the SAME shared
rubric Bens/Joana use (not Sean's stricter two-outcome variant -- that
rubric is built around Tomás being the second-call closer, which doesn't
apply to his own calls). Wire up a scoreTomasTranscripts()-style function
in Phase2_CallScoring.gs pointed at this same folder ID once that's needed.

Setup: identical to transcribe_sean_calls.py (see that file's docstring) --
same credentials.json/token.json, same GEMINI_API_KEY. If you're switching
a machine off Sean's backlog onto this one, nothing new to set up.
"""

import os
import re
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

TOMAS_FOLDERS = {
    "Sales Calls": "1QjmKqmTQpg6yePI55L_tqtoEvIf0Lbf_",
    "Second Calls": "1ohbJInhrWg_toyrGNr39ba7VzzAojmqE",  # his closing calls as the second-call closer -- added 20/08/2026
}

# Append-only record of every video this machine has finished transcribing,
# so progress is visible at a glance (which files, when) without opening
# Drive -- useful when the backlog is being split across machines/runs over
# several days. The actual skip-already-done logic still comes from checking
# Drive for the matching "<title> — Transcript" doc (see main() below); this
# log is a human-readable side effect of that, not a second source of truth.
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tomas_transcribed_log.txt")


def log_completed_(title, video_id, link):
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"{title} | {video_id} | {link}\n")


def clean_title_(raw_name):
    """Tomás's files carry their video extension in the Drive filename
    itself (e.g. "Steve Houck Sales Call.mp4"), unlike Sean's/Joana's --
    strip it so the resulting "<title> — Transcript" doc name matches the
    rest of the project's naming convention."""
    return re.sub(r"\.(mp4|mov|m4v|mkv)$", "", raw_name.strip(), flags=re.IGNORECASE)


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
    for folder_label, folder_id in TOMAS_FOLDERS.items():
        videos, existing_names = list_videos(drive, folder_id)
        pending = [v for v in videos if f"{clean_title_(v['name'])} — Transcript" not in existing_names]
        work_by_folder[folder_label] = (folder_id, pending)
        total_videos += len(pending)
        print(f"  [{folder_label}] {len(pending)} to do, {len(videos) - len(pending)} already transcribed")
    print(f"\n{total_videos} video(s) to transcribe across {len(TOMAS_FOLDERS)} folder(s).")

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
            title = clean_title_(video["name"])
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
                log_completed_(title, video["id"], link)
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
            "This is not a bug in the script -- see transcribe_sean_calls.py's docstring "
            "for what this usually means (free-tier cap, or the prepay-credits billing "
            "sync issue). Re-run this script once it's resolved; it skips everything "
            "already transcribed and picks up right where it stopped."
        )
