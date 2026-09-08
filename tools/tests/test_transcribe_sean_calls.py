"""
Tests for tools/transcribe_sean_calls.py's Gemini transcription path — the
pipeline that produced Frank Pirrone's real corrupted transcript
(3,933 repeats of "I'm going to do it this way.", found live 09/09/2026 when
Kris pasted the actual Google Doc). Two things changed there and both are
covered here:

1. transcribe_with_gemini now detects a looped/repetitive result and retries
   instead of silently saving garbage — so the corruption never reaches
   Drive at all, rather than relying on Apps Script to catch it downstream
   after the fact (which it also now does, Phase2_CallScoring.gs).
2. build_transcript_prompt_ asks for real speaker names when the rep is
   known, per Kris: "we know who the speaker is, right? ... fill in the
   freaking names of who's speaking."

No real Gemini/Drive credentials needed — the client is a Mock shaped like
the real google-genai SDK's call surface (client.files.upload/get/delete,
client.models.generate_content).
"""
from unittest.mock import MagicMock

import pytest

import transcribe_sean_calls as tsc


# ---------------------------------------------------------------------------
# Repetition-loop detection — must stay in exact lockstep with the Apps
# Script version (Phase2_CallScoring.gs's transcriptRepetitionLoopShare_/
# transcriptIsDegenerateRepetition_), same thresholds, same algorithm.
# ---------------------------------------------------------------------------

class TestRepetitionDetection:
    def test_catches_the_actual_frank_pirrone_transcript_shape(self):
        """Real bug: the corrupted section of the real doc has almost NO
        line breaks at all — one giant run of the same sentence glued
        together with plain spaces. Reconstructed here at the real scale
        (3,933 repeats) with the same no-newline shape, matching exactly
        what Kris pasted."""
        opening = (
            "Hi Sean. Hi Frank. Good morning. Good morning. I am trying to dial into Zoom on my "
            "computer that has audio, so I was not blowing you off. Yeah, yeah, it is better so you "
            "can see the slides clearly. Gotcha, let me try that now, one second please, thank you. "
            "Take your time Frank, no worries, we have got all day for this."
        )
        corrupted_tail = " ".join(["I'm going to do it this way."] * 3933)
        full = opening + " " + corrupted_tail
        assert "\n" not in full
        assert tsc.transcript_is_degenerate_repetition_(full) is True
        # The real number Tomás read off his screen, not an approximation.
        share = tsc.transcript_repetition_loop_share_(full)
        assert share > 0.8

    def test_leaves_a_real_transcript_alone(self):
        real = (
            "Sean: Hey Frank, thanks for jumping on today.\n"
            "Frank: Happy to be here, I have been looking at this for a while.\n"
            "Sean: Tell me what made you book the call in the first place.\n"
            "Frank: Honestly I want more visibility, nobody in my market knows who I am.\n"
        ) * 15  # long enough to clear the 150-word floor with real variety
        assert tsc.transcript_is_degenerate_repetition_(real) is False

    def test_short_filler_repeated_often_does_not_trip_it(self):
        """Deliberately adversarial, same case validated on the Apps Script
        side: a rep saying only 'Yeah.'/'Right.' in strict alternation
        between 40 otherwise-unique lines lands at 37.5%, comfortably under
        the 50% threshold."""
        lines = []
        for i in range(40):
            lines.append("Rep: Yeah.")
            lines.append("Rep: Right.")
            lines.append(f"Lead: So my situation is a little different from that, number {i}.")
        text = "\n".join(lines)
        assert tsc.transcript_repetition_loop_share_(text) < 0.5
        assert tsc.transcript_is_degenerate_repetition_(text) is False

    def test_short_transcript_never_trips_on_word_count_alone(self):
        short = "Rep: thanks for taking the call today. " * 6
        assert tsc.transcript_repetition_loop_share_(short) == 0.0


# ---------------------------------------------------------------------------
# Prompt construction — real names when known, generic labels otherwise.
# ---------------------------------------------------------------------------

class TestBuildTranscriptPrompt:
    def test_uses_the_rep_name_when_given(self):
        prompt = tsc.build_transcript_prompt_(rep_name="Sean")
        assert 'Label their turns "Sean:"' in prompt
        assert "Rep:" not in prompt.split("Format:")[1].split("IMPORTANT")[0].replace(
            'Label their turns "Sean:"', ""
        ), "must not still ask for the generic \"Rep:\" label once we know the real name"

    def test_passes_the_video_title_through_as_a_hint_not_an_assertion(self):
        prompt = tsc.build_transcript_prompt_(rep_name="Sean", prospect_name_hint="1/21 Anthony Camperi")
        assert "1/21 Anthony Camperi" in prompt
        assert "confirm it against what you actually" in prompt

    def test_falls_back_to_generic_labels_with_no_rep_name(self):
        prompt = tsc.build_transcript_prompt_()
        assert '"Rep:", "Prospect:"' in prompt

    def test_always_includes_the_anti_repetition_instruction(self):
        # This is the cheap first line of defense — costs nothing to try,
        # separate from transcribe_with_gemini's real backstop below.
        assert "STOP immediately" in tsc.build_transcript_prompt_()
        assert "STOP immediately" in tsc.build_transcript_prompt_(rep_name="Joana")


# ---------------------------------------------------------------------------
# transcribe_with_gemini — the real backstop: detect, retry, and only ever
# give up loudly (never silently save a corrupted transcript).
# ---------------------------------------------------------------------------

def _fake_client(response_texts):
    """A Mock shaped like google.genai.Client's call surface. response_texts
    is consumed one per generate_content call, in order."""
    client = MagicMock()
    fake_file = MagicMock()
    fake_file.state.name = "ACTIVE"
    fake_file.name = "fake-gemini-file-id"
    client.files.upload.return_value = fake_file

    responses = [MagicMock(text=t, candidates=[MagicMock(finish_reason="STOP")]) for t in response_texts]
    client.models.generate_content.side_effect = responses
    return client, fake_file


CORRUPTED = " ".join(["I'm going to do it this way."] * 200) + " " + "filler word " * 100
CLEAN = (
    "Sean: Hey Frank, thanks for jumping on today.\n"
    "Frank: Happy to be here, I have been looking at this for a while.\n"
    "Sean: Tell me what made you book the call in the first place.\n"
    "Frank: Honestly I want more visibility, nobody in my market knows who I am.\n"
    "Sean: Got it. And how many transactions did you close last year?\n"
    "Frank: About eighteen, but almost all of them came from my brokerage.\n"
) * 15


class TestTranscribeWithGemini:
    def test_returns_a_clean_transcript_straight_through(self, tmp_path):
        client, _ = _fake_client([CLEAN])
        video = tmp_path / "fake.mp4"
        video.write_bytes(b"x")
        result = tsc.transcribe_with_gemini(client, str(video))
        assert result == CLEAN
        assert client.models.generate_content.call_count == 1

    def test_retries_once_on_a_looped_result_and_succeeds(self, tmp_path):
        """The actual fix: a corrupted first attempt no longer gets saved —
        it gets thrown away and retried."""
        client, _ = _fake_client([CORRUPTED, CLEAN])
        video = tmp_path / "fake.mp4"
        video.write_bytes(b"x")
        result = tsc.transcribe_with_gemini(client, str(video), rep_name="Sean", prospect_name_hint="Frank Pirrone")
        assert result == CLEAN
        assert client.models.generate_content.call_count == 2

    def test_gives_up_loudly_after_max_retries_rather_than_saving_corruption(self, tmp_path):
        client, fake_file = _fake_client([CORRUPTED] * (tsc.MAX_REPETITION_RETRIES + 1))
        video = tmp_path / "fake.mp4"
        video.write_bytes(b"x")
        with pytest.raises(RuntimeError, match="still looping"):
            tsc.transcribe_with_gemini(client, str(video))
        assert client.models.generate_content.call_count == tsc.MAX_REPETITION_RETRIES + 1
        # Cleanup must still happen even though this raised — real bug class
        # this guards against: a leaked Gemini file on every failed attempt.
        client.files.delete.assert_called_once_with(name=fake_file.name)

    def test_uses_a_low_temperature_for_transcription(self, tmp_path):
        client, _ = _fake_client([CLEAN])
        video = tmp_path / "fake.mp4"
        video.write_bytes(b"x")
        tsc.transcribe_with_gemini(client, str(video))
        _, kwargs = client.models.generate_content.call_args
        assert kwargs["config"].temperature == 0.1

    def test_passes_rep_and_prospect_context_into_the_actual_prompt_sent(self, tmp_path):
        client, _ = _fake_client([CLEAN])
        video = tmp_path / "fake.mp4"
        video.write_bytes(b"x")
        tsc.transcribe_with_gemini(client, str(video), rep_name="Joana", prospect_name_hint="Stacie Staub")
        _, kwargs = client.models.generate_content.call_args
        sent_prompt = kwargs["contents"][1]
        assert "Joana" in sent_prompt
        assert "Stacie Staub" in sent_prompt

    def test_uploaded_gemini_file_is_always_deleted_even_on_success(self, tmp_path):
        client, fake_file = _fake_client([CLEAN])
        video = tmp_path / "fake.mp4"
        video.write_bytes(b"x")
        tsc.transcribe_with_gemini(client, str(video))
        client.files.delete.assert_called_once_with(name=fake_file.name)
