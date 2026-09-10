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


class TestLabelSegmentsBySpeakerTurn:
    """label_segments_by_speaker_turn — pure function, no model/API needed.
    Kris's ask, 09/09/2026: "even if it's not perfect, it'd be nice to try
    an estimate... fill in the freaking names of who's speaking." tinydiarize
    only marks WHEN the speaker changed, never WHO -- this is the alternating
    "Speaker 1:"/"Speaker 2:" estimate built on top of that, not verified
    identity."""

    def test_no_turns_at_all_labels_everything_as_the_first_speaker(self):
        segments = _fake_segments(["Hello there.", "How are you?"])
        result = tsw.label_segments_by_speaker_turn(segments, turns=[False, False])
        assert result == ["Speaker 1: Hello there.", "Speaker 1: How are you?"]

    def test_a_turn_flag_flips_the_label_for_the_next_segment_not_the_current_one(self):
        segments = _fake_segments(["Hi Bruce, thanks for joining.", "Good morning, how's it going?", "Pretty good."])
        # turns[0]=True means the speaker changed AFTER segment 0 finished --
        # so segment 0 keeps Speaker 1, segment 1 flips to Speaker 2.
        result = tsw.label_segments_by_speaker_turn(segments, turns=[True, False, False])
        assert result == [
            "Speaker 1: Hi Bruce, thanks for joining.",
            "Speaker 2: Good morning, how's it going?",
            "Speaker 2: Pretty good.",
        ]

    def test_alternates_correctly_across_multiple_real_turns(self):
        segments = _fake_segments(["A1", "A2", "B1", "B2", "A3"])
        result = tsw.label_segments_by_speaker_turn(segments, turns=[False, True, False, True, False])
        assert result == [
            "Speaker 1: A1", "Speaker 1: A2", "Speaker 2: B1", "Speaker 2: B2", "Speaker 1: A3",
        ]

    def test_empty_segments_are_dropped_but_still_consume_their_turn_flag(self):
        segments = _fake_segments(["Sean: hi", "", "Frank: hey"])
        result = tsw.label_segments_by_speaker_turn(segments, turns=[True, False, False])
        assert result == ["Speaker 1: Sean: hi", "Speaker 2: Frank: hey"]

    def test_custom_speaker_labels_are_honored(self):
        segments = _fake_segments(["Hi Bruce.", "Hey Sean."])
        result = tsw.label_segments_by_speaker_turn(segments, turns=[True], speaker_labels=("Sean", "Prospect"))
        assert result == ["Sean: Hi Bruce.", "Prospect: Hey Sean."]

    def test_a_turns_list_shorter_than_segments_does_not_crash(self):
        # _segment_speaker_turns can only ever return one flag per segment,
        # but this stays defensive rather than assuming the two always match.
        segments = _fake_segments(["one", "two", "three"])
        result = tsw.label_segments_by_speaker_turn(segments, turns=[])
        assert result == ["Speaker 1: one", "Speaker 1: two", "Speaker 1: three"]


class TestSegmentSpeakerTurns:
    """_segment_speaker_turns — the low-level tinydiarize extraction. Real
    whisper.cpp context objects can't be constructed in a unit test, so this
    only verifies the two documented failure paths: the extension module
    missing entirely, and the low-level call raising."""

    def test_returns_none_when_the_low_level_extension_is_unavailable(self, monkeypatch):
        import builtins
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "_pywhispercpp":
                raise ImportError("no such module in this test environment")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        result = tsw._segment_speaker_turns(MagicMock(), _fake_segments(["a", "b"]))
        assert result is None

    def test_returns_none_rather_than_raising_when_the_model_has_no_ctx_attribute(self):
        model_without_ctx = object()  # no ._ctx at all
        result = tsw._segment_speaker_turns(model_without_ctx, _fake_segments(["a"]))
        assert result is None


class TestSpeakerTurnLabelingOptIn:
    """The opt-in flag must not change ANY existing behavior when off (the
    default), and must wire tdrz_enable + labeling through when on."""

    def test_disabled_by_default_never_requests_tdrz_or_calls_segment_speaker_turns(self, monkeypatch):
        assert tsw.SPEAKER_TURN_LABELING_ENABLED is False, \
            "must ship disabled -- this has not been validated against real audio"
        model = _fake_model([CLEAN_SEGMENTS])
        monkeypatch.setattr(tsw, "get_whisper_model", lambda: model)
        called = []
        monkeypatch.setattr(tsw, "_segment_speaker_turns", lambda *a: called.append(1))
        tsw.transcribe_with_whisper("fake.mp4")
        assert called == [], "_segment_speaker_turns must never be called while the feature is off"
        assert "tdrz_enable" not in model.transcribe.call_args.kwargs

    def test_enabled_requests_tdrz_and_applies_speaker_labels(self, monkeypatch):
        segments = _fake_segments(["Hi Bruce, thanks for joining.", "Good morning."])
        model = _fake_model([segments])
        monkeypatch.setattr(tsw, "get_whisper_model", lambda: model)
        monkeypatch.setattr(tsw, "SPEAKER_TURN_LABELING_ENABLED", True)
        monkeypatch.setattr(tsw, "_segment_speaker_turns", lambda m, segs: [True, False])
        result = tsw.transcribe_with_whisper("fake.mp4")
        assert model.transcribe.call_args.kwargs["tdrz_enable"] is True
        assert result == "Speaker 1: Hi Bruce, thanks for joining.\n\nSpeaker 2: Good morning."

    def test_enabled_but_turn_extraction_unavailable_falls_back_to_unlabeled_paragraphs(self, monkeypatch):
        """_segment_speaker_turns returning None (extension unavailable, or
        any other failure) must fall back to exactly today's shipped
        behavior, not crash and not silently mislabel everything."""
        segments = _fake_segments(["Hi Bruce, thanks for joining.", "Good morning."])
        model = _fake_model([segments])
        monkeypatch.setattr(tsw, "get_whisper_model", lambda: model)
        monkeypatch.setattr(tsw, "SPEAKER_TURN_LABELING_ENABLED", True)
        monkeypatch.setattr(tsw, "_segment_speaker_turns", lambda m, segs: None)
        result = tsw.transcribe_with_whisper("fake.mp4")
        assert result == "Hi Bruce, thanks for joining.\n\nGood morning."
