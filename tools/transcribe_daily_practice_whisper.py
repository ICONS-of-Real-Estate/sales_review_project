#!/usr/bin/env python3
"""
Free, fully local alternative to transcribe_daily_practice.py, using
whisper.cpp instead of Gemini -- same reasoning as
transcribe_sean_calls_whisper.py (no API key, no per-call cost, runs
entirely on your own CPU). Reuses the Drive plumbing from
transcribe_sean_calls.py, the whisper.cpp wrapper from
transcribe_sean_calls_whisper.py, and DAILY_PRACTICE_FOLDERS from
transcribe_daily_practice.py, so there is exactly one place the three
reps' Daily Practice folder IDs live.

This is the one to run on OVH (or any shared/server box) -- policy per
Kris (23/08/2026): Whisper (free) is the standing default for anything
running unattended there, never a per-call API charge. See
tools/transcribe_all.py, which now includes this batch alongside
Sean/Joana/Tomás's regular call transcription.

Setup: same as transcribe_sean_calls_whisper.py (pip install -r
requirements.txt + ffmpeg on PATH). No API key needed.
"""

from transcribe_sean_calls import run_whisper_batch
from transcribe_sean_calls_whisper import transcribe_with_whisper
from transcribe_daily_practice import DAILY_PRACTICE_FOLDERS


def main():
    run_whisper_batch(DAILY_PRACTICE_FOLDERS, transcribe_with_whisper)


if __name__ == "__main__":
    main()
