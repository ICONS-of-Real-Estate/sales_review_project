#!/usr/bin/env python3
"""
Backfills Drive transcripts for Joana's recorded sales/QC calls — same
situation as Sean (raw Zoom recordings, no existing transcripts), so this
reuses all of transcribe_sean_calls.py's Drive/Gemini plumbing rather than
duplicating it. Only the source folders differ.

NOT YET READY TO RUN: JOANA_FOLDERS below is a placeholder. Fill in her
actual Drive folder ID(s) once known (same "create a folder" ask that was
sent to Sean applies to her — see Phase2_CallGradingSOP.md), then this
works exactly like transcribe_sean_calls.py: skip already-transcribed
videos, retry on quota/connection errors, stop cleanly on a real billing
wall instead of grinding through the whole folder.

Once transcripts exist, also set PHASE2_CONFIG.LEGACY_FOLDERS.Joana in
Phase2_CallScoring.gs to the SAME folder ID (or wherever the transcript
Docs land) and run scoreJoanaLegacyTranscripts() in the Apps Script editor
to backfill them into the Sales Call Log, against the shared Bens/Joana
rubric — Joana is not on Sean's stricter variant.

Setup: identical to transcribe_sean_calls.py (see that file's docstring).
"""

import os
import sys
import tempfile

from transcribe_sean_calls import (
    QuotaExhaustedError,
    download_video,
    get_drive_service,
    list_videos,
    save_transcript_doc,
    transcribe_with_gemini,
)
from google import genai

# TODO: replace with Joana's actual Drive folder ID(s) once known. Add more
# entries here the same way SEAN_FOLDERS has "Sales Calls" / "Qualification
# Calls" if her recordings are similarly split.
JOANA_FOLDERS = {
    # "Sales Calls": "PASTE_JOANA_FOLDER_ID_HERE",
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

    for folder_label, folder_id in JOANA_FOLDERS.items():
        print(f"\n=== {folder_label} ===")
        videos, existing_names = list_videos(drive, folder_id)
        for video in videos:
            title = video["name"].strip()
            if f"{title} — Transcript" in existing_names:
                print(f"[skip] {title} (already transcribed)")
                continue

            print(f"[transcribing] {title} ({int(video.get('size', 0)) / 1e6:.0f} MB)")
            local_path = os.path.join(tempfile.gettempdir(), f"{video['id']}.mp4")
            try:
                if os.path.exists(local_path):
                    print("    (reusing file downloaded on a previous, quota-stopped run)")
                else:
                    download_video(drive, video["id"], local_path)
                transcript = transcribe_with_gemini(client, local_path)
                link = save_transcript_doc(drive, folder_id, video["id"], title, transcript)
                print(f"    done -> {link}")
                os.remove(local_path)
            except QuotaExhaustedError:
                # Stop the whole batch, but keep the local file — next run picks up
                # transcription directly instead of re-downloading it from scratch.
                raise
            except Exception as e:
                print(f"    FAILED: {e}")
                if os.path.exists(local_path):
                    os.remove(local_path)


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
