#!/usr/bin/env python3
"""
Free, fully local alternative to transcribe_joana_calls.py, using
whisper.cpp instead of Gemini/Qwen -- same reasoning as
transcribe_sean_calls_whisper.py (no API key, no per-call cost, runs
entirely on your own CPU; see that file's docstring for the full
explanation of why this works fine without a dedicated GPU). Reuses the
Drive plumbing from transcribe_sean_calls.py, the whisper.cpp wrapper from
transcribe_sean_calls_whisper.py, and the JOANA_FOLDERS placeholder from
transcribe_joana_calls.py, so there is exactly one place to fill in her
Drive folder ID(s) once known.

Setup: same as transcribe_sean_calls_whisper.py (pip install -r
requirements.txt + ffmpeg on PATH). No API key needed.
"""

import sys

from transcribe_sean_calls import run_whisper_batch
from transcribe_sean_calls_whisper import transcribe_with_whisper
from transcribe_joana_calls import JOANA_FOLDERS


def main():
    if not JOANA_FOLDERS:
        sys.exit(
            "JOANA_FOLDERS is still empty — fill in her Drive folder ID(s) in "
            "transcribe_joana_calls.py before running."
        )
    run_whisper_batch(JOANA_FOLDERS, transcribe_with_whisper)


if __name__ == "__main__":
    main()
