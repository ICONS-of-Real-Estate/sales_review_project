#!/usr/bin/env python3
"""
Drives Whisper transcription of Tomás's Pitch Guide training recordings
(Phase18_PitchGuideReview.gs) — same situation as Calibration Feedback (raw
video, no existing transcript), so this reuses transcribe_sean_calls.py's
Drive/lock plumbing and transcribe_all.py's free local-Whisper engine rather
than duplicating either.

PITCH_GUIDE_TRAINING_FOLDERS points at the single "Pitch Guide Training
Recordings" Drive folder Tomás/Kris drop a training walkthrough video into
directly — no filename convention, no sheet to touch. Once a
"<video name> — Transcript" Doc lands next to a video, Phase18's monthly
trigger picks it up, compares it against the live Pitch Guide doc, and
writes concrete suggested edits to the "Pitch Guide SOP Suggestions" tab for
Tomás to approve or reject.

Run standalone (python transcribe_pitch_guide_training.py) or via
transcribe_all.py, which already includes this batch — see that file's
BATCHES list.
"""

from transcribe_sean_calls import run_whisper_batch
from transcribe_sean_calls_whisper import transcribe_with_whisper

PITCH_GUIDE_TRAINING_FOLDERS = {
    "Pitch Guide Training": "1Wu4-iuNExsNtIHcRiBTHIMLgKd8YbOlW",
}


def main():
    run_whisper_batch(PITCH_GUIDE_TRAINING_FOLDERS, transcribe_with_whisper)


if __name__ == "__main__":
    main()
