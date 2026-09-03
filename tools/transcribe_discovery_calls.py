#!/usr/bin/env python3
"""
Backfills Drive transcripts for the Discovery-call recordings gathered into
the shared "Discovery Call Recordings" folder (Kris, 03/09/2026 — dug through
every active client folder for old Discovery calls and copied them all here
so the AMs have one place to drop new ones going forward). Same situation as
Sean/Joana/Tomás (raw video, mostly no VERBATIM transcript), so this reuses
all of transcribe_sean_calls.py's Drive/Gemini plumbing rather than
duplicating it. Only the source folder differs, plus one real wrinkle this
folder has that the others don't:

Some of the copied items are Google Drive SHORTCUTS (mimeType
'application/vnd.google-apps.shortcut'), not real video files — the
find-and-copy pass that populated this folder copied a few Meet recordings
as shortcuts rather than literal file copies (the underlying recording lives
in whichever Meet-recordings folder Katia's/Tisha's own Drive auto-filed it
in). transcribe_sean_calls.py's list_videos() only recognizes a real
video/* mimeType and silently drops anything else into "not a video" —
list_discovery_videos() below extends that to resolve a shortcut's real
target file and use ITS id/mimeType/size, while keeping the shortcut's own
name and parent folder for where the resulting transcript doc gets created.

Also, unlike Sean's/Joana's raw Zoom recordings, a lot of this folder's
files ALREADY have a "Notes by Gemini" doc sitting next to them (Google
Meet's own auto-generated meeting notes) — that is NOT the same thing as a
verbatim transcript (it's an AI summary: Summary/Decisions/Next steps, not
dialogue), and the Discovery-call rubric (buildDiscoveryJudgeSystemPrompt_,
Phase2_CallScoring.gs) needs real dialogue to judge things like elevation
and delivery. So the skip-check here is deliberately the same as every
other variant — only skips a video that already has a real
"<title> — Transcript" doc, a Notes-by-Gemini doc next to it does NOT count
as already done.

Setup: identical to transcribe_sean_calls.py (see that file's docstring) --
same credentials.json/token.json, same GEMINI_API_KEY. If you're switching a
machine off another backlog onto this one, nothing new to set up.
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
    save_transcript_doc,
    transcribe_with_gemini,
    transcript_temp_path,
)
from google import genai

DISCOVERY_CALL_RECORDINGS_FOLDER = "1arDFT1Mt0yT99J_QqDeyQAyMGc8rqGtm"

# Same append-only completion log pattern as transcribe_tomas_calls.py --
# human-readable side effect only, not a second source of truth (the real
# skip-already-done check is always a live Drive query for the matching
# "<title> — Transcript" doc, see main() below).
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "discovery_transcribed_log.txt")


def log_completed_(title, video_id, link):
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"{title} | {video_id} | {link}\n")


def clean_title_(raw_name):
    """Some of this folder's files carry their video extension in the Drive
    filename itself (Zoom/Meet auto-exports, e.g. "GMT20260828-...recording.mp4"),
    others don't (Meet's own "<Event title> - Recording" convention) -- strip
    a trailing extension when present so the resulting "<title> — Transcript"
    doc name is consistent either way."""
    return re.sub(r"\.(mp4|mov|m4v|mkv|webm)$", "", raw_name.strip(), flags=re.IGNORECASE)


def list_discovery_videos(drive, folder_id):
    """Same recursive folder-walk as transcribe_sean_calls.list_videos(), but
    also resolves Drive shortcuts to real video files instead of silently
    dropping them -- see this module's own docstring for why that matters
    here specifically. Returns (videos, existing_names) with the same shape
    list_videos() does: each video dict's "id" is the REAL underlying file id
    (safe to pass straight to download_video), "name" is the shortcut's own
    display name (what a human sees in this folder), and "parent_folder_id"
    is where the transcript doc should be created (this folder, not wherever
    the shortcut's target actually lives)."""
    videos, existing_names = [], set()
    folders_to_scan = [folder_id]
    while folders_to_scan:
        current_folder_id = folders_to_scan.pop()
        page_token = None
        while True:
            resp = (
                drive.files()
                .list(
                    q=f"'{current_folder_id}' in parents and trashed = false",
                    fields="nextPageToken, files(id, name, mimeType, size, shortcutDetails)",
                    pageSize=200,
                    pageToken=page_token,
                )
                .execute()
            )
            for f in resp.get("files", []):
                if f["mimeType"] == "application/vnd.google-apps.folder":
                    folders_to_scan.append(f["id"])
                elif f["mimeType"].startswith("video/"):
                    f["parent_folder_id"] = current_folder_id
                    videos.append(f)
                elif f["mimeType"] == "application/vnd.google-apps.shortcut":
                    target = f.get("shortcutDetails", {})
                    target_mime = target.get("targetMimeType", "")
                    if target_mime.startswith("video/"):
                        try:
                            meta = drive.files().get(fileId=target["targetId"], fields="id, size").execute()
                        except Exception as e:
                            print(f"    (couldn't resolve shortcut '{f['name']}': {e} -- skipping)")
                            continue
                        videos.append({
                            "id": meta["id"],
                            "name": f["name"],
                            "mimeType": target_mime,
                            "size": meta.get("size", 0),
                            "parent_folder_id": current_folder_id,
                        })
                    else:
                        existing_names.add(f["name"])
                else:
                    existing_names.add(f["name"])
            page_token = resp.get("nextPageToken")
            if not page_token:
                break
    return videos, existing_names


def main():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        sys.exit("Set GEMINI_API_KEY before running.")
    client = genai.Client(api_key=api_key)

    drive = get_drive_service()

    videos, existing_names = list_discovery_videos(drive, DISCOVERY_CALL_RECORDINGS_FOLDER)
    pending = [v for v in videos if f"{clean_title_(v['name'])} — Transcript" not in existing_names]
    total_videos = len(pending)
    print(f"{len(videos)} Discovery call video(s) found, {total_videos} to do, "
          f"{len(videos) - total_videos} already transcribed.")

    batch_start = time.time()
    completed = 0
    # Only videos transcribed FRESH this run go in here -- a reused
    # download/transcript from a prior interrupted run finishes far faster
    # than a real transcription, so it isn't a fair basis for estimating what
    # the REMAINING (not-yet-started) videos will take.
    per_video_times = []

    for video in pending:
        title = clean_title_(video["name"])
        video_folder_id = video.get("parent_folder_id", DISCOVERY_CALL_RECORDINGS_FOLDER)
        print(f"[transcribing] {title} ({int(video.get('size', 0) or 0) / 1e6:.0f} MB)")

        local_path = os.path.join(tempfile.gettempdir(), f"{video['id']}.mp4")
        txt_path = transcript_temp_path(video["id"])
        video_start = time.time()
        fresh = False
        try:
            if os.path.exists(txt_path):
                # Already transcribed on a prior run that got interrupted
                # before a successful upload -- reuse it instead of paying
                # for another Gemini transcription.
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
