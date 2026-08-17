#!/usr/bin/env python3
"""
Cheaper alternative to transcribe_joana_calls.py, using Alibaba's
Qwen3-ASR-Flash instead of Gemini — same trade-off as
transcribe_sean_calls_qwen.py (no speaker diarization; see that file's
docstring for the full reasoning). Reuses the Drive plumbing from
transcribe_sean_calls.py, the Qwen CLI wrapper from
transcribe_sean_calls_qwen.py, and the JOANA_FOLDERS placeholder from
transcribe_joana_calls.py, so there is exactly one place to fill in her
Drive folder ID(s) once known.

Setup: same as transcribe_sean_calls_qwen.py (qwen3-asr-toolkit + ffmpeg on
PATH + DASHSCOPE_API_KEY).
"""

import os
import sys
import tempfile

from transcribe_sean_calls import download_video, get_drive_service, list_videos, save_transcript_doc
from transcribe_sean_calls_qwen import transcribe_with_qwen
from transcribe_joana_calls import JOANA_FOLDERS


def main():
    if not JOANA_FOLDERS:
        sys.exit(
            "JOANA_FOLDERS is still empty — fill in her Drive folder ID(s) in "
            "transcribe_joana_calls.py before running."
        )
    if not os.environ.get("DASHSCOPE_API_KEY"):
        sys.exit("Set DASHSCOPE_API_KEY before running.")

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
                    print("    (reusing file downloaded on a previous run)")
                else:
                    download_video(drive, video["id"], local_path)
                transcript = transcribe_with_qwen(local_path)
                link = save_transcript_doc(drive, folder_id, video["id"], title, transcript)
                print(f"    done -> {link}")
                os.remove(local_path)
            except Exception as e:
                print(f"    FAILED: {e}")
                if os.path.exists(local_path):
                    os.remove(local_path)


if __name__ == "__main__":
    main()
