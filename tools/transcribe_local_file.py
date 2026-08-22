#!/usr/bin/env python3
"""
One-off transcription of a single local video/audio file -- no Google
Drive, no API key, everything runs on this machine via whisper.cpp. For
transcribing more than a couple of files, use one of the
transcribe_<rep>_calls_whisper.py scripts instead (they handle the Drive
folder scan + upload); this script is just for "I have one file sitting on
my computer and want its transcript."

Setup (Windows):
    1. Install ffmpeg and make sure it's on PATH:
       winget install ffmpeg
       (or download from https://www.gyan.dev/ffmpeg/builds/ and add its
       bin/ folder to PATH manually, then open a NEW terminal so PATH reloads)
    2. pip install pywhispercpp

Setup (macOS/Linux):
    1. brew install ffmpeg   (or apt/dnf install ffmpeg)
    2. pip install pywhispercpp

Run:
    python transcribe_local_file.py "C:\\path\\to\\your\\video.mp4"

First run downloads the whisper.cpp "small.en" model (~500MB) once, then
it's cached. Writes the transcript to a .txt file next to the input, with
the same base name.
"""
import sys
import time
from pathlib import Path


def main():
    if len(sys.argv) != 2:
        print("Usage: python transcribe_local_file.py <path to video or audio file>")
        sys.exit(1)

    input_path = Path(sys.argv[1])
    if not input_path.exists():
        print(f"File not found: {input_path}")
        sys.exit(1)

    output_path = input_path.with_suffix(".txt")

    print("Loading the whisper.cpp model (downloads once, ~500MB for small.en, then cached)...")
    from pywhispercpp.model import Model
    model = Model("small.en", print_realtime=False, print_progress=False)

    print(f"Transcribing {input_path.name} locally on this CPU...")
    start = time.time()
    segments = model.transcribe(str(input_path))
    transcript = " ".join(seg.text.strip() for seg in segments).strip()
    elapsed = time.time() - start
    print(f"    took {elapsed / 60:.1f} minutes")

    output_path.write_text(transcript, encoding="utf-8")
    print(f"SUCCESS: transcript written to {output_path}")
    print(
        "\nNote: whisper.cpp doesn't label speaker turns -- check whether it's still "
        "clear who's the rep and who's the prospect from context alone."
    )


if __name__ == "__main__":
    main()
