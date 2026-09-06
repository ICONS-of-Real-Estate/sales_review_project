#!/usr/bin/env python3
"""
Drives Whisper transcription of Kris's blind-calibration feedback
recordings (Phase16_CalibrationFeedback.gs) — same situation as every other
batch in this folder (raw video, no existing transcript), so this reuses
transcribe_sean_calls.py's Drive/lock plumbing and transcribe_all.py's free
local-Whisper engine rather than duplicating either.

CALIBRATION_FEEDBACK_FOLDERS points at the four per-rep "Calibration
Feedback/<rep>" Drive folders Kris drops his recordings into directly — no
filename convention, no sheet to touch. Once a "<video name> — Transcript"
Doc lands next to a video, Phase16's daily trigger picks it up, emails the
rep the recording link + a summary of Kris's feedback, and folds any drill
topics into that rep's daily-practice assignment.

Run standalone (python transcribe_calibration_feedback.py) or via
transcribe_all.py, which already includes this batch — see that file's
BATCHES list.
"""

from transcribe_sean_calls import run_whisper_batch
from transcribe_sean_calls_whisper import transcribe_with_whisper

CALIBRATION_FEEDBACK_FOLDERS = {
    "Sean": "1vkSV1_rNnfFXMYr_RHsdIZ7ID3OjvDWX",
    "Joana": "1FYo2dy5CBFeluuLgvxphuN38Fn4RHlP1",
    "Tomás": "11qw_wKdOYmQZ8mkf1x_VQ08JSqwP1UFy",
    "Bens": "1QSCdg6TQ_3ocjVhAlq-fXanlw-0rPqCg",
}


def main():
    run_whisper_batch(CALIBRATION_FEEDBACK_FOLDERS, transcribe_with_whisper)


if __name__ == "__main__":
    main()
