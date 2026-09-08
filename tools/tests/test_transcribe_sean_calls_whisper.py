"""
Tests for transcribe_sean_calls_whisper.py's transcribe_with_whisper() —
THE actual production transcription function. transcribe_all.py (what
tools/deploy/setup_ovh.sh runs unattended every 6 hours on the OVH VPS for
every rep's real backlog) imports and calls exactly this function, not the
Gemini or Qwen variants — confirmed by tracing transcribe_all.py's own
imports and tools/deploy/README.md's own description ("Whisper engine —
free, local, no API key"). Frank Pirrone's real corrupted transcript (found
live 09/09/2026, 3,933 repeats of "I'm going to do it this way.") came
through this path.

No real whisper.cpp model or audio file needed — get_whisper_model is
monkeypatched to return a fake Model whose .transcribe() returns
pre-scripted fake Segment objects, same style as transcribe_with_gemini's
own tests (test_transcribe_sean_calls.py).
"""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import transcribe_sean_calls_whisper as tsw


def _fake_segments(texts):
    return [SimpleNamespace(text=t) for t in texts]


CORRUPTED_SEGMENTS = _fake_segments(["I'm going to do it this way."] * 200 + ["filler word"] * 100)
CLEAN_SEGMENTS = _fake_segments([
    "Sean: Hey Frank, thanks for jumping on today.",
    "Frank: Happy to be here, I have been looking at this for a while.",
    "Sean: Tell me what made you book the call in the first place.",
    "Frank: Honestly I want more visibility, nobody in my market knows who I am.",
    "Sean: Got it. And how many transactions did you close last year?",
    "Frank: About eighteen, but almost all of them came from my brokerage.",
] * 15)


def _fake_model(segment_lists):
    """segment_lists: one list of fake Segments consumed per transcribe() call."""
    model = MagicMock()
    model.transcribe.side_effect = list(segment_lists)
    return model


class TestTranscribeWithWhisper:
    def test_returns_paragraphs_joined_with_real_breaks_not_a_single_space(self, monkeypatch):
        """Real bug: joining with a single space is exactly what made the
        real corrupted transcript invisible to a line-based repetition
        check, and unreadable as coaching material generally."""
        model = _fake_model([CLEAN_SEGMENTS])
        monkeypatch.setattr(tsw, "get_whisper_model", lambda: model)
        result = tsw.transcribe_with_whisper("fake.mp4")
        assert "\n\n" in result
        assert result.count("\n\n") >= len(CLEAN_SEGMENTS) - 1

    def test_retries_on_a_looped_result_with_an_escalated_temperature_and_succeeds(self, monkeypatch):
        """The core fix: retrying at the SAME (default) temperature would
        just reproduce the identical failure on fully-deterministic greedy
        decoding — the temperature bump is what gives the retry a real
        chance."""
        model = _fake_model([CORRUPTED_SEGMENTS, CLEAN_SEGMENTS])
        monkeypatch.setattr(tsw, "get_whisper_model", lambda: model)
        result = tsw.transcribe_with_whisper("fake.mp4")
        assert "I'm going to do it this way." not in result or result.count("I'm going to do it this way.") < 50
        assert model.transcribe.call_count == 2
        first_call_kwargs = model.transcribe.call_args_list[0].kwargs
        second_call_kwargs = model.transcribe.call_args_list[1].kwargs
        # temperature must be passed EXPLICITLY on every call, attempt 0
        # included — real bug (code review, 09/09/2026): pywhispercpp's
        # Model.transcribe(**params) applies each given key via setattr onto
        # a _params object that lives on the (cached, reused-per-worker)
        # Model instance and is never reset on its own. Omitting the key on
        # attempt 0 (instead of passing temperature=0.0) meant a PRIOR
        # video's retry could leave a raised temperature silently in effect
        # for every later video's "first attempt" in the same worker
        # process, for the rest of that run.
        assert "temperature" in first_call_kwargs, \
            "temperature must be passed explicitly, even at 0.0, to actually reset any value a prior retry left set"
        assert first_call_kwargs["temperature"] == 0
        assert second_call_kwargs["temperature"] > 0

    def test_temperature_is_always_explicit_even_on_a_single_clean_call(self, monkeypatch):
        """Isolated regression for the same state-leak bug: even with no
        retry involved at all, attempt 0 must still pass temperature=0.0
        explicitly rather than omitting the key — otherwise a stray
        `if attempt else {}`-style omission looks correct in this simple
        case while still leaking state across videos in the real (stateful)
        pywhispercpp Model object this test's plain MagicMock can't
        reproduce on its own."""
        model = _fake_model([CLEAN_SEGMENTS])
        monkeypatch.setattr(tsw, "get_whisper_model", lambda: model)
        tsw.transcribe_with_whisper("fake.mp4")
        kwargs = model.transcribe.call_args.kwargs
        assert "temperature" in kwargs
        assert kwargs["temperature"] == 0

    def test_gives_up_loudly_after_max_retries_rather_than_saving_corruption(self, monkeypatch):
        model = _fake_model([CORRUPTED_SEGMENTS] * (tsw.MAX_REPETITION_RETRIES + 1))
        monkeypatch.setattr(tsw, "get_whisper_model", lambda: model)
        with pytest.raises(RuntimeError, match="still looping"):
            tsw.transcribe_with_whisper("fake.mp4")
        assert model.transcribe.call_count == tsw.MAX_REPETITION_RETRIES + 1

    def test_a_clean_transcript_never_retries(self, monkeypatch):
        model = _fake_model([CLEAN_SEGMENTS])
        monkeypatch.setattr(tsw, "get_whisper_model", lambda: model)
        tsw.transcribe_with_whisper("fake.mp4")
        assert model.transcribe.call_count == 1

    def test_empty_segments_are_dropped_not_left_as_blank_paragraphs(self, monkeypatch):
        segments = _fake_segments(["Sean: hello", "", "   ", "Frank: hi"])
        model = _fake_model([segments])
        monkeypatch.setattr(tsw, "get_whisper_model", lambda: model)
        result = tsw.transcribe_with_whisper("fake.mp4")
        assert result == "Sean: hello\n\nFrank: hi"
