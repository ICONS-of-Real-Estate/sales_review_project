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
                    # re-running qwen3-asr.
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
                    transcript = transcribe_with_qwen(local_path)
                    print(f"    transcribe: {format_duration_(time.time() - t0)}")
                    fresh = True

                t0 = time.time()
                link = save_transcript_doc(drive, video_folder_id, video["id"], title, transcript)
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
