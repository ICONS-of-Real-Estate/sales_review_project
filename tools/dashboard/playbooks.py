"""
Renders the repo's markdown coaching playbooks (Objection_Handling_Playbook.md,
Objection_Handling_Playbook_Sean.md, Tomas_Playbook.md) for the dashboard, and
indexes them into SQLite FTS5 for search — per DASHBOARD_RESEARCH_REPORT.md
§2.4. FTS5 ships with SQLite itself, no extra service needed.

Re-indexed on demand (reindex_playbooks()), called once at app startup —
the source is files in the repo that only change on a `git pull` + restart,
not on sync.py's timer.
"""
import re
import sqlite3
import sys
from pathlib import Path

from markdown_it import MarkdownIt

_md = MarkdownIt("commonmark", {"html": False}).enable("table")

PLAYBOOKS = [
    {"slug": "bens", "title": "Objection Handling Playbook — Bens", "filename": "Objection_Handling_Playbook.md"},
    {"slug": "sean", "title": "Objection Handling Playbook — Sean", "filename": "Objection_Handling_Playbook_Sean.md"},
    {"slug": "joana", "title": "Objection Handling Playbook — Joana", "filename": "Objection_Handling_Playbook_Joana.md"},
    {"slug": "tomas", "title": "Tomás Playbook — What Other Reps Should Copy", "filename": "Tomas_Playbook.md"},
]


def _slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "section"


_FENCE_RE = re.compile(r"^(```|~~~)")


def _split_sections(markdown_text):
    """Splits a playbook on its top-level (##) headings. Content before the
    first ## — the doc's own H1 + intro blockquote — becomes its own
    section, titled after the H1 if present.

    Real bug (B1): heading detection used to run on every line regardless
    of fenced code blocks — a ```/~~~ fence containing an example line that
    starts with "## " (a shell comment, a markdown-inside-markdown sample)
    would be misread as a real section break, silently splitting one
    section into two (or worse, orphaning the rest of that section's
    content under the wrong heading). Now tracks fence state and skips
    heading detection entirely while inside one.
    """
    lines = markdown_text.splitlines()
    sections = []
    current_heading = None
    current_lines = []
    in_fence = False

    def flush():
        if current_heading is not None or current_lines:
            sections.append((current_heading, "\n".join(current_lines)))

    for line in lines:
        if _FENCE_RE.match(line.strip()):
            in_fence = not in_fence
            current_lines.append(line)
            continue
        m = None if in_fence else re.match(r"^##\s+(.*)$", line)
        if m:
            flush()
            current_heading = m.group(1).strip()
            current_lines = []
        else:
            current_lines.append(line)
    flush()

    if sections and sections[0][0] is None:
        body = sections[0][1]
        title, body = _extract_and_strip_h1(body)
        sections[0] = (title, body)

    return sections


def _extract_and_strip_h1(body):
    """Finds the intro section's own H1 (a real top-level `# heading` line,
    not one inside a fenced code block — B2) and strips just that line out
    of the body so it isn't rendered a second time as a literal <h1>."""
    lines = body.splitlines(keepends=True)
    in_fence = False
    for i, line in enumerate(lines):
        if _FENCE_RE.match(line.strip()):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = re.match(r"^#\s+(.*)$", line)
        if m:
            title = m.group(1).strip()
            return title, "".join(lines[:i] + lines[i + 1:])
    return "Overview", body


def render_playbook(repo_root, filename):
    """Returns a list of {heading, anchor, html, plain_text} dicts, one per
    top-level section. Raises FileNotFoundError if the playbook doesn't
    exist on this deploy — callers decide how to handle that."""
    path = Path(repo_root) / filename
    text = path.read_text(encoding="utf-8")
    sections = _split_sections(text)

    seen_slugs = set()
    out = []
    for heading, body in sections:
        slug = _slugify(heading or "section")
        base_slug, n = slug, 2
        while slug in seen_slugs:
            slug = f"{base_slug}-{n}"
            n += 1
        seen_slugs.add(slug)
        out.append(
            {
                "heading": heading,
                "anchor": slug,
                "html": _md.render(body),
                # Stripped of markdown punctuation for the search index —
                # FTS5 tokenizes on word boundaries, so this just avoids
                # noisy matches on stray "#"/"*"/"-" characters.
                "plain_text": re.sub(r"[#>*`_\[\]\(\)-]", " ", body),
            }
        )
    return out


def reindex_playbooks(db_path, repo_root):
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        DROP TABLE IF EXISTS playbook_sections;
        CREATE VIRTUAL TABLE playbook_sections USING fts5(
            doc_slug, doc_title, heading, anchor, body
        );
        """
    )
    for pb in PLAYBOOKS:
        try:
            sections = render_playbook(repo_root, pb["filename"])
        except FileNotFoundError:
            # Real bug (B3): silently skipping meant a renamed/moved/deleted
            # playbook file just vanished from search with no signal at all
            # — indistinguishable from "this rep genuinely has no playbook"
            # (Joana, by design) unless someone happened to notice the gap.
            print(f"WARNING: playbook file not found, skipping: {pb['filename']} (slug={pb['slug']!r})", file=sys.stderr)
            continue
        for s in sections:
            conn.execute(
                "INSERT INTO playbook_sections (doc_slug, doc_title, heading, anchor, body) "
                "VALUES (?, ?, ?, ?, ?)",
                (pb["slug"], pb["title"], s["heading"] or "", s["anchor"], s["plain_text"]),
            )
    conn.commit()
    conn.close()


def search_playbooks(db_path, query):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT doc_slug, doc_title, heading, anchor, "
            "snippet(playbook_sections, 4, '<mark>', '</mark>', '…', 20) AS snippet "
            "FROM playbook_sections WHERE playbook_sections MATCH ? "
            "ORDER BY rank LIMIT 20",
            (query,),
        ).fetchall()
    except sqlite3.OperationalError:
        # Malformed FTS5 query syntax (e.g. an unbalanced quote) — fail soft
        # with no results rather than a 500 over a typo in a search box.
        rows = []
    conn.close()
    return [dict(r) for r in rows]
