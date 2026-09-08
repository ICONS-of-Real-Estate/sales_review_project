#!/usr/bin/env python3
"""
Free, fully local alternative to transcribe_sean_calls.py / _qwen.py:
transcribes Sean's recorded calls with whisper.cpp (via the pywhispercpp
Python bindings) running entirely on your own machine -- no API key, no
per-call cost, no data ever leaves this laptop.

Why this is realistic on a laptop with no dedicated GPU (confirmed via
public whisper.cpp CPU benchmarks, not assumed): base.en/small.en run
FASTER than real-time on any 2020-or-later CPU, and even the much larger
large-v3 model manages roughly 3-5x real-time on a plain x86 CPU. This
script defaults to small.en -- a good accuracy/speed balance for CPU-only
hardware. If it's too slow on your specific machine, drop to 'base.en' in
get_whisper_model() below (faster, slightly less accurate); if you later
get real GPU headroom, pywhispercpp also supports CUDA/CoreML/Vulkan
acceleration (see its README) -- this script doesn't need to change,
whisper.cpp just uses whatever it can find.

Trade-off to know before pointing this at the whole backlog: Whisper's
plain transcribe(), like Qwen's, does NOT do speaker diarization -- no
"Rep:"/"Prospect:" labels like Gemini produces. Same caveat as
transcribe_sean_calls_qwen.py: fine if speaker roles are inferable from
context, worth confirming on one real transcript first. See
test_single_transcription_whisper.py for that smoke test.

transcribe_sean_calls.py (Gemini) and transcribe_sean_calls_qwen.py (Qwen)
are both untouched and still work -- keep either as a fallback if local
Whisper's quality, missing diarization, or CPU speed on your machine turns
out to be a problem.

IMPORTANT: transcribe_with_whisper() below is THE actual production path.
transcribe_all.py -- what tools/deploy/setup_ovh.sh runs unattended every 6
hours on the OVH VPS for every rep's real backlog -- imports and calls this
exact function, not the Gemini or Qwen ones. Any bug found in a real call's
transcript (confirmed live 09/09/2026) traces back to here first.

Reuses all the Drive plumbing (auth, folder listing, download, upload-back)
from transcribe_sean_calls.py -- only the transcription step changes, so run
this from the same tools/ directory with the same credentials.json/token.json.

Setup (in addition to transcribe_sean_calls.py's one-time Drive OAuth setup):
    pip install -r requirements.txt          (adds pywhispercpp)
    Install ffmpeg and make sure it's on your PATH -- needed to read the
    source .mp4 files directly (pywhispercpp only handles .wav natively).
    On Windows: winget install Gyan.FFmpeg (or download from ffmpeg.org and
    add the bin folder to PATH). Already installed if you set up the Qwen
    path first.
    python transcribe_sean_calls_whisper.py

No API key, no environment variable to set. The model itself (~500MB for
small.en) downloads automatically to a local cache the first time this runs,
then never needs the network again.
"""

import os

from transcribe_sean_calls import (
    MAX_REPETITION_RETRIES,
    SOURCE_FOLDERS,
    run_whisper_batch,
    transcript_is_degenerate_repetition_,
    transcript_repetition_loop_share_,
)

_whisper_model = None


def get_whisper_model():
    """Loads the whisper.cpp model once per process (loading it is the slow
    part; reuse across every file in the batch instead of reloading each time).

    WHISPER_THREADS controls how many CPU threads EACH model instance uses --
    matters when transcribe_all.py runs several parallel workers (each with
    its own model) on the same box, so the total (workers x threads) can be
    tuned to the machine's core count instead of oversubscribing it. Left
    unset, whisper.cpp's own default applies -- fine for a single-worker run."""
    global _whisper_model
    if _whisper_model is None:
        from pywhispercpp.model import Model
        n_threads = os.environ.get("WHISPER_THREADS")
        kwargs = {"n_threads": int(n_threads)} if n_threads else {}
        try:
            _whisper_model = Model("small.en", print_realtime=False, print_progress=False, **kwargs)
        except TypeError:
            # Older pywhispercpp versions may not accept n_threads as a kwarg --
            # fall back to its default thread count rather than hard-failing.
            _whisper_model = Model("small.en", print_realtime=False, print_progress=False)
    return _whisper_model


def transcribe_with_whisper(local_path):
    """THE actual production transcription path — every batch in
    transcribe_all.py (Sean, Joana, Tomás, Daily Practice, Calibration
    Feedback, Pitch Guide Training) imports and calls this one function, and
    transcribe_all.py is what runs unattended on the OVH VPS every 6 hours
    (tools/deploy/setup_ovh.sh). transcribe_sean_calls.py's Gemini path
    (main()) is a documented fallback, not what's actually deployed.

    Real bug found live (09/09/2026, Kris pasting Frank Pirrone's actual
    corrupted transcript doc): this is the function that produced it.
    whisper.cpp has a well-documented failure mode where a difficult stretch
    of audio (silence, noise, low audio quality) makes it lock onto one
    hallucinated phrase and repeat it — its own built-in temperature-fallback
    safety net (entropy_thold/logprob_thold, see get_whisper_model's comment)
    is tuned to catch LOW-confidence garbage, not a confidently-repeated
    phrase, which is exactly the failure mode that slipped through here. This
    used to return whatever came back with no validation at all.

    Now: detect the same repetition-loop shape as everywhere else in this
    project (transcript_is_degenerate_repetition_, shared with
    transcribe_sean_calls.py's Gemini path and kept in lockstep with the Apps
    Script version, Phase2_CallScoring.gs's transcriptRepetitionLoopShare_ —
    same algorithm, same thresholds, three independent layers now catching
    the identical failure) and retry with an escalating temperature. Retrying
    at the SAME temperature=0.0 (whisper.cpp's default, fully greedy/
    deterministic decoding) would just reproduce the identical failure every
    time — the temperature bump is what actually gives a retry a real chance
    of landing somewhere different. Only after MAX_REPETITION_RETRIES straight
    failures does this give up and raise, so run_whisper_batch's existing
    "FAILED: ..." handling logs it and moves to the next video rather than
    silently uploading garbage — a corrupted transcript no longer reaches
    Drive at all.

    Also: segments are now joined with a real paragraph break rather than a
    single space (Kris: "it'd be nicer if it formatted the document
    better") — whisper.cpp's plain transcribe() has no speaker diarization
    at all (see this file's own docstring above), so real "Sean:"/"Frank:"
    labels aren't available from this path without a separate diarization
    step (whisper.cpp does have optional tinydiarize turn-boundary
    detection via tdrz_enable, but it needs a different, `-tdrz` compiled
    model and hasn't been validated against a real call here yet — worth
    doing as a follow-up, not guessed at blind). This at least gives every
    distinct utterance its own paragraph instead of one unbroken wall of
    text, which is also exactly the shape that made the original corruption
    invisible to a line-based detector in the first place.
    """
    model = get_whisper_model()
    for attempt in range(MAX_REPETITION_RETRIES + 1):
        # Real bug found live (09/09/2026, code review): pywhispercpp's
        # Model.transcribe(**params) applies each key it's GIVEN via
        # setattr onto a `_params` object that lives on the Model instance
        # and is never reset — get_whisper_model() caches one Model per
        # worker process and reuses it for every video in the whole batch
        # (run_whisper_batch's loop). Omitting `temperature` on attempt 0
        # (the old `if attempt else {}`) meant it never got reset back to
        # 0.0 after an earlier video's retry had bumped it — every
        # subsequent "first attempt" in that worker, for the rest of the
        # run, silently inherited whatever temperature the last retry left
        # behind instead of running at the documented deterministic
        # default. Passing it explicitly every time, including 0.0 on
        # attempt 0, is what actually resets it.
        segments = model.transcribe(local_path, temperature=attempt * 0.4)
        text = "\n\n".join(seg.text.strip() for seg in segments if seg.text.strip()).strip()
        if not transcript_is_degenerate_repetition_(text):
            return text
        share = transcript_repetition_loop_share_(text)
        if attempt < MAX_REPETITION_RETRIES:
            print(f"    Whisper transcript looped (dominant phrase covers "
                  f"{share:.0%} of the text) — retrying ({attempt + 1}/{MAX_REPETITION_RETRIES})...")
        else:
            raise RuntimeError(
                f"Whisper transcript still looping after {MAX_REPETITION_RETRIES} retries "
                f"(dominant phrase covers {share:.0%} of the text) — refusing to save a corrupted "
                f"transcript. Try again later, or fall back to Zoom's own transcript if one exists."
            )


def main():
    run_whisper_batch(SOURCE_FOLDERS, transcribe_with_whisper)


if __name__ == "__main__":
    main()
