"""
Unit tests for transcripts.py — pulling real-dialogue excerpts around
whatever the AI feedback quoted, onto the call detail page. Kris's ask
(09/09/2026): "The feedback is good but need to see more of what Bens said
so we can train him." No real Drive API/network needed:
build_transcript_excerpts() calls the module-level fetch_transcript_text(),
which every test here monkeypatches directly.
"""
from googleapiclient.errors import HttpError

import transcripts

SAMPLE_TRANSCRIPT = """\
Bens Olano (00:00.19)
There's some technical issues. But how is it? How's the business so far?

Mark Ryan (00:05.55)
I don't know that I have the bandwidth for more guesting right now.

Bens Olano (00:13.53)
The average commitment every week is like an hour... and we take care of everything.

Mark Ryan (00:24.19)
Sure, happy to talk.

Bens Olano (00:27.23)
Great, I'll book you for Friday the 4th at 11:30 AM ET.
"""


class TestExtractDriveFileId:
    def test_pulls_the_id_out_of_a_view_link(self):
        url = "https://drive.google.com/file/d/1Rm3EyY3sy4UuxNOWsfw1qs1luaq6CFSb/view?usp=drivesdk"
        assert transcripts.extract_drive_file_id(url) == "1Rm3EyY3sy4UuxNOWsfw1qs1luaq6CFSb"

    def test_returns_none_for_blank_or_missing_url(self):
        assert transcripts.extract_drive_file_id("") is None
        assert transcripts.extract_drive_file_id(None) is None

    def test_returns_none_for_a_url_with_no_recognizable_file_id(self):
        assert transcripts.extract_drive_file_id("https://example.com/not-a-drive-link") is None


class TestParseTranscriptTurns:
    def test_splits_into_one_turn_per_speaker_block(self):
        turns = transcripts.parse_transcript_turns(SAMPLE_TRANSCRIPT)
        assert len(turns) == 5
        assert turns[1]["speaker"] == "Mark Ryan"
        assert turns[1]["timestamp"] == "00:05.55"
        assert "bandwidth" in turns[1]["text"]

    def test_folds_a_headerless_block_into_the_previous_turn(self):
        text = "Bens Olano (00:00.19)\nFirst line.\n\nSecond paragraph, same turn."
        turns = transcripts.parse_transcript_turns(text)
        assert len(turns) == 1
        assert "First line." in turns[0]["text"] and "Second paragraph" in turns[0]["text"]


class TestFindQuotes:
    def test_extracts_every_distinct_quote_in_order(self):
        feedback = (
            '"I would propose a strategy call." Mark said "Sure, happy to talk" and you locked it in.\n'
            'Next time, answer "I don\'t know that I have the bandwidth" before making the ask.'
        )
        quotes = transcripts.find_quotes(feedback)
        assert quotes == [
            "I would propose a strategy call.",
            "Sure, happy to talk",
            "I don't know that I have the bandwidth",
        ]

    def test_ignores_a_tiny_quote_too_short_to_be_a_real_moment(self):
        assert transcripts.find_quotes('He said "ok".') == []

    def test_deduplicates_a_quote_reused_later_in_the_feedback(self):
        feedback = '"Sure, happy to talk" was the turning point. Later: "Sure, happy to talk" again.'
        assert transcripts.find_quotes(feedback) == ["Sure, happy to talk"]

    def test_blank_feedback_yields_no_quotes(self):
        assert transcripts.find_quotes("") == []
        assert transcripts.find_quotes(None) == []


class TestBuildTranscriptExcerpts:
    def test_no_transcript_url_returns_no_excerpts_and_no_error(self):
        result = transcripts.build_transcript_excerpts("", '"Sure, happy to talk" was great.')
        assert result == {"excerpts": [], "error": None}

    def test_no_quotes_in_feedback_skips_fetching_the_transcript_entirely(self, monkeypatch):
        called = []
        monkeypatch.setattr(transcripts, "fetch_transcript_text", lambda fid: called.append(fid) or SAMPLE_TRANSCRIPT)
        result = transcripts.build_transcript_excerpts(
            "https://drive.google.com/file/d/abc123/view", "No quotes in this feedback at all."
        )
        assert result == {"excerpts": [], "error": None}
        assert called == []  # never even tried to fetch — nothing to look for

    def test_a_matched_quote_returns_an_excerpt_with_context_and_the_matching_turn_highlighted(self, monkeypatch):
        monkeypatch.setattr(transcripts, "fetch_transcript_text", lambda fid: SAMPLE_TRANSCRIPT)
        feedback = '"Sure, happy to talk" was the moment it worked.'
        result = transcripts.build_transcript_excerpts(
            "https://drive.google.com/file/d/abc123/view", feedback, context_turns=1
        )
        assert result["error"] is None
        assert len(result["excerpts"]) == 1
        turns = result["excerpts"][0]["turns"]
        # "Sure, happy to talk" is turn index 3 (Mark Ryan); context_turns=1 -> turns 2..4
        speakers_and_highlight = [(t["speaker"], t["highlight"]) for t in turns]
        assert ("Mark Ryan", True) in speakers_and_highlight
        highlighted = [t for t in turns if t["highlight"]]
        assert len(highlighted) == 1
        assert "Sure, happy to talk" in highlighted[0]["text"]

    def test_two_nearby_quotes_merge_into_one_excerpt_not_two(self, monkeypatch):
        monkeypatch.setattr(transcripts, "fetch_transcript_text", lambda fid: SAMPLE_TRANSCRIPT)
        feedback = (
            'You answered "the average commitment every week is like an hour" '
            'right after "Sure, happy to talk" — nice sequence.'
        )
        result = transcripts.build_transcript_excerpts(
            "https://drive.google.com/file/d/abc123/view", feedback, context_turns=1
        )
        assert result["error"] is None
        assert len(result["excerpts"]) == 1
        highlighted = [t for t in result["excerpts"][0]["turns"] if t["highlight"]]
        assert len(highlighted) == 2

    def test_a_quote_not_found_anywhere_in_the_transcript_is_silently_dropped(self, monkeypatch):
        monkeypatch.setattr(transcripts, "fetch_transcript_text", lambda fid: SAMPLE_TRANSCRIPT)
        feedback = '"Something that was never actually said on this call at all" is the quote.'
        result = transcripts.build_transcript_excerpts(
            "https://drive.google.com/file/d/abc123/view", feedback
        )
        assert result == {"excerpts": [], "error": None}

    def test_a_drive_http_error_returns_a_friendly_message_instead_of_raising(self, monkeypatch):
        def boom(fid):
            raise HttpError(resp=type("R", (), {"status": 403, "reason": "Forbidden"})(), content=b"denied")
        monkeypatch.setattr(transcripts, "fetch_transcript_text", boom)
        result = transcripts.build_transcript_excerpts(
            "https://drive.google.com/file/d/abc123/view", '"Sure, happy to talk" was great.'
        )
        assert result["excerpts"] == []
        assert "Couldn't load" in result["error"]

    def test_a_missing_service_account_file_also_fails_gracefully(self, monkeypatch):
        """build_transcript_excerpts must never crash the page just because
        this sandbox/test box has no real service_account.json — the
        surrounding call detail page should still render."""
        def boom(fid):
            raise FileNotFoundError("no service_account.json here")
        monkeypatch.setattr(transcripts, "fetch_transcript_text", boom)
        result = transcripts.build_transcript_excerpts(
            "https://drive.google.com/file/d/abc123/view", '"Sure, happy to talk" was great.'
        )
        assert result["excerpts"] == []
        assert "Couldn't load" in result["error"]
