"""
Unit tests for playbooks.py's markdown section-splitting and reindex
warning behavior — no database needed for the splitting tests.
"""
import sys

import playbooks


class TestSplitSections:
    def test_splits_on_top_level_headings(self):
        text = "# Title\n\nIntro text.\n\n## First\n\nBody one.\n\n## Second\n\nBody two.\n"
        sections = playbooks._split_sections(text)
        assert [h for h, _ in sections] == ["Title", "First", "Second"]

    def test_fenced_code_block_containing_a_fake_heading_is_not_split(self):
        """Real bug (B1): a fenced code block with an example line starting
        "## " (a shell comment, a markdown-inside-markdown sample) used to
        be misread as a real section break."""
        text = (
            "# Title\n\nIntro.\n\n"
            "## Real Section\n\n"
            "Some body text.\n\n"
            "```\n"
            "## this looks like a heading but is inside a fence\n"
            "```\n\n"
            "More body text after the fence.\n"
        )
        sections = playbooks._split_sections(text)
        assert [h for h, _ in sections] == ["Title", "Real Section"]
        assert "this looks like a heading" in sections[1][1]
        assert "More body text after the fence." in sections[1][1]

    def test_h1_inside_a_fence_is_not_mistaken_for_the_real_title(self):
        """Real bug (B2): the H1 search used to scan the whole intro body
        with re.search, ignoring fence state — a fenced example containing
        "# something" would be picked as the title and stripped from the
        body, corrupting the actual example."""
        text = (
            "```\n"
            "# this is example markdown, not the real title\n"
            "```\n\n"
            "# Real Title\n\n"
            "Intro text.\n\n"
            "## First\n\nBody.\n"
        )
        sections = playbooks._split_sections(text)
        assert sections[0][0] == "Real Title"
        assert "this is example markdown, not the real title" in sections[0][1]
        assert "# Real Title" not in sections[0][1]

    def test_no_h1_falls_back_to_overview(self):
        text = "Just some intro text, no H1 at all.\n\n## First\n\nBody.\n"
        sections = playbooks._split_sections(text)
        assert sections[0][0] == "Overview"


class TestReindexPlaybooks:
    def test_missing_playbook_file_logs_a_warning(self, tmp_path, monkeypatch, capsys):
        """Real bug (B3): a renamed/moved/deleted playbook file used to
        vanish from search with zero signal — indistinguishable from Joana's
        by-design lack of a playbook."""
        monkeypatch.setattr(playbooks, "PLAYBOOKS", [
            {"slug": "ghost", "title": "Ghost Playbook", "filename": "Does_Not_Exist.md"},
        ])
        db_path = tmp_path / "test.db"
        playbooks.reindex_playbooks(str(db_path), str(tmp_path))
        err = capsys.readouterr().err
        assert "Does_Not_Exist.md" in err
        assert "ghost" in err
