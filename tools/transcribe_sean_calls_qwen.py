#!/usr/bin/env python3
"""
Cheaper alternative to transcribe_sean_calls.py: transcribes Sean's recorded
calls with Alibaba's Qwen3-ASR-Flash (via the official qwen3-asr-toolkit CLI)
instead of Gemini. Roughly $0.002/minute of audio, vs. Gemini's much higher
effective per-file cost -- for a ~45 minute call that's about $0.06-0.10 here
vs. roughly $0.45 with Gemini.

Trade-off to know before pointing this at the whole backlog: the qwen3-asr-toolkit
does NOT do speaker diarization -- no "Rep:"/"Prospect:" labels like Gemini
produces. Alibaba's underlying ASR model reportedly supports diarization, but
this toolkit doesn't yet expose that parameter (open issue:
github.com/QwenLM/Qwen3-ASR-Toolkit/issues/13, unresolved as of writing).
Transcripts from this script are plain, unlabeled text -- fine if whoever
reviews/scores the call can infer speaker roles from context (which held up
across 12 real Gemini transcripts we reviewed by hand), but worth confirming
on one real Qwen transcript before trusting it at scale. See
test_single_transcription_qwen.py for that smoke test.

transcribe_sean_calls.py (the Gemini version) is untouched and still works --
keep it as a fallback if Qwen's quality or missing diarization turns out to
be a problem.

Reuses all the Drive plumbing (auth, folder listing, download, upload-back)
from transcribe_sean_calls.py -- only the transcription step changes, so run
this from the same tools/ directory with the same credentials.json/token.json.

Setup (in addition to transcribe_sean_calls.py's one-time Drive OAuth setup):
    pip install -r requirements.txt          (adds qwen3-asr-toolkit)
    Install ffmpeg and make sure it's on your PATH -- the toolkit needs it to
    extract/resample audio from video files. On Windows: winget install
    Gyan.FFmpeg (or download from ffmpeg.org and add the bin folder to PATH).
    export DASHSCOPE_API_KEY="<your key from dashscope.console.aliyun.com>"
    python transcribe_sean_calls_qwen.py
"""

import os
import subprocess
import sys
import tempfile

from transcribe_sean_calls import (
    SOURCE_FOLDERS,
    download_video,
    get_drive_service,
    list_videos,
    save_transcript_doc,
    transcript_temp_path,
)


def transcribe_with_qwen(local_path):
    """Shells out to the qwen3-asr CLI, which writes a .txt transcript next
    to local_path (same base name, same directory)."""
    subprocess.run(["qwen3-asr", "-i", local_path], check=True)
    txt_path = os.path.splitext(local_path)[0] + ".txt"
    if not os.path.exists(txt_path):
        raise RuntimeError(f"qwen3-asr didn't produce the expected output file: {txt_path}")
    with open(txt_path, "r", encoding="utf-8") as f:
        transcript = f.read()
    os.remove(txt_path)
    return transcript


def main():
    if not os.environ.get("DASHSCOPE_API_KEY"):
        sys.exit("Set DASHSCOPE_API_KEY before running.")

    drive = get_drive_service()

    for folder_label, folder_id in SOURCE_FOLDERS.items():
        print(f"\n=== {folder_label} ===")
        videos, existing_names = list_videos(drive, folder_id)
        for video in videos:
            title = video["name"].strip()
            if f"{title} — Transcript" in existing_names:
                print(f"[skip] {title} (already transcribed)")
                continue

            local_path = os.path.join(tempfile.gettempdir(), f"{video['id']}.mp4")
            txt_path = transcript_temp_path(video["id"])
            try:
                if os.path.exists(txt_path):
                    # Already transcribed on a prior run that got interrupted
                    # before a successful upload -- reuse it instead of
                    # re-running qwen3-asr.
                    print(f"[resuming upload] {title} (already transcribed on a previous run)")
                    with open(txt_path, "r", encoding="utf-8") as f:
                        transcript = f.read()
                else:
                    print(f"[transcribing] {title} ({int(video.get('size', 0)) / 1e6:.0f} MB)")
                    if os.path.exists(local_path):
                        print("    (reusing file downloaded on a previous run)")
                    else:
                        download_video(drive, video["id"], local_path)
                    transcript = transcribe_with_qwen(local_path)

                link = save_transcript_doc(drive, folder_id, video["id"], title, transcript)
                print(f"    done -> {link}")
                if os.path.exists(local_path):
                    os.remove(local_path)
            except Exception as e:
                print(f"    FAILED: {e}")
                if os.path.exists(local_path):
                    os.remove(local_path)


if __name__ == "__main__":
    main()
