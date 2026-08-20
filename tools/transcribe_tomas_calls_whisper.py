#!/usr/bin/env python3
"""
Free, fully local alternative to transcribe_tomas_calls.py, using
whisper.cpp instead of Gemini -- same reasoning as
transcribe_sean_calls_whisper.py (no API key, no per-call cost, runs
entirely on your own CPU; see that file's docstring for the full
explanation of why this works fine without a dedicated GPU). Reuses the
Drive plumbing from transcribe_sean_calls.py, the whisper.cpp wrapper from
transcribe_sean_calls_whisper.py, and TOMAS_FOLDERS/clean_title_ from
transcribe_tomas_calls.py.

Setup: same as transcribe_sean_calls_whisper.py (pip install -r
requirements.txt + ffmpeg on PATH). No API key needed. If this machine is
already set up for Sean's Whisper backlog, there is nothing new to
install -- just run this script instead of that one.
"""

from transcribe_sean_calls import run_whisper_batch
from transcribe_sean_calls_whisper import transcribe_with_whisper
from transcribe_tomas_calls import TOMAS_FOLDERS, clean_title_, log_completed_


def main():
    run_whisper_batch(
        TOMAS_FOLDERS,
        transcribe_with_whisper,
        title_fn=lambda v: clean_title_(v["name"]),
        log_completed_fn=log_completed_,
    )


if __name__ == "__main__":
    main()
