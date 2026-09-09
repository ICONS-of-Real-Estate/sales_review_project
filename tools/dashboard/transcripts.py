"""
Fetches the actual transcript text behind a scored call and pulls short
excerpts around whatever the AI feedback quoted, so the call detail page can
show real dialogue instead of just the AI's write-up of it. Kris's ask
(09/09/2026), looking at Mark Ryan's feedback card: "The feedback is good
but need to see more of what Bens said so we can train him."

Uses its own narrower scope, same split-by-blast-radius pattern as
sheets_write.py/sync.py: read-only, and only ever fetches the one file a
call's own Transcript URL already points at — never lists or browses Drive.
"""
import os
import re
from functools import lru_cache
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

BASE_DIR = Path(__file__).resolve().parent
SERVICE_ACCOUNT_FILE = os.environ.get(
    "DASHBOARD_SERVICE_ACCOUNT_FILE", str(BASE_DIR / "service_account.json")
)
READ_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

# e.g. https://drive.google.com/file/d/1Rm3EyY3sy4UuxNOWsfw1qs1luaq6CFSb/view?usp=drivesdk
_DRIVE_FILE_ID_RE = re.compile(r"/d/([A-Za-z0-9_-]+)")

# Every transcript checked live (09/09/2026, Esme Sanchez's file) is
# Riverside-style speaker-tagged blocks: a "Speaker Name (mm:ss.fff)" header
# line, blank line, then that turn's text, blank line, repeat.
_TURN_HEADER_RE = re.compile(r"^(?P<speaker>.+?) \((?P<timestamp>\d{1,3}:\d{2}(?:\.\d+)?)\)$")

# Every buildXFeedbackSummary_ in Phase2_CallScoring.gs quotes real speech in
# plain ASCII double quotes — require some real length so a stray one-word
# quote doesn't send this hunting for a match that isn't really there.
_QUOTE_RE = re.compile(r'"([^"\n]{8,300})"')

# Below this word-overlap ratio, treat a quote as unmatched rather than
# attach it to a turn that merely shares a few common words.
_FUZZY_MATCH_FLOOR = 0.6


def extract_drive_file_id(url):
    if not url:
        return None
    m = _DRIVE_FILE_ID_RE.search(url)
    return m.group(1) if m else None


def drive_client():
    creds = service_account.Credentials.from_service_account_file(
        SERVICE_ACCOUNT_FILE, scopes=READ_SCOPES
    )
    return build("drive", "v3", credentials=creds)


@lru_cache(maxsize=128)
def fetch_transcript_text(file_id):
    """Raw transcript text for one Drive file id, cached for the life of
    this process — a scored call's transcript never changes, so there's no
    reason to refetch it on every page view."""
    request = drive_client().files().get_media(fileId=file_id)
    return request.execute().decode("utf-8", errors="replace")


def parse_transcript_turns(text):
    """Splits a transcript into (speaker, timestamp, text) turns. Blocks are
    separated by blank lines; a block that isn't itself a "Speaker (ts)"
    header line is folded into the immediately preceding turn (Riverside
    sometimes splits one person's turn across several blank-line-separated
    paragraphs)."""
    turns = []
    for block in text.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        lines = block.split("\n")
        header = _TURN_HEADER_RE.match(lines[0].strip())
        if header:
            body = "\n".join(lines[1:]).strip()
            turns.append({"speaker": header.group("speaker"), "timestamp": header.group("timestamp"), "text": body})
        elif turns:
            turns[-1]["text"] = (turns[-1]["text"] + "\n" + block).strip()
        else:
            turns.append({"speaker": "", "timestamp": "", "text": block})
    return turns


def find_quotes(feedback_text):
    """Every distinct double-quoted span in the feedback text, in the order
    they appear — de-duplicated, since the same quote sometimes gets reused
    both as the opening moment and again in a later sentence."""
    seen, quotes = set(), []
    for m in _QUOTE_RE.finditer(feedback_text or ""):
        q = m.group(1).strip()
        if q and q not in seen:
            seen.add(q)
            quotes.append(q)
    return quotes


def _normalize(s):
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()


def _best_matching_turn_index(quote, turns):
    """The turn most likely to contain this quote. An exact (normalized)
    substring match wins outright; otherwise falls back to whichever turn
    shares the most words with the quote, since the AI occasionally cleans
    up filler words when quoting. Returns None below _FUZZY_MATCH_FLOOR —
    a quote that isn't real speech (or a transcript that's changed format)
    shouldn't get a random excerpt attached to it."""
    norm_quote = _normalize(quote)
    if not norm_quote:
        return None
    for i, turn in enumerate(turns):
        if norm_quote in _normalize(turn["text"]):
            return i
    quote_words = set(norm_quote.split())
    if not quote_words:
        return None
    best_i, best_score = None, 0.0
    for i, turn in enumerate(turns):
        turn_words = set(_normalize(turn["text"]).split())
        if not turn_words:
            continue
        overlap = len(quote_words & turn_words) / len(quote_words)
        if overlap > best_score:
            best_score, best_i = overlap, i
    return best_i if best_score >= _FUZZY_MATCH_FLOOR else None


def build_transcript_excerpts(transcript_url, feedback_text, context_turns=2):
    """Returns {"excerpts": [...], "error": None} normally, or
    {"excerpts": [], "error": <str>} if the transcript couldn't be fetched.
    Each excerpt is {"turns": [{"speaker", "timestamp", "text", "highlight"}, ...]} —
    one per quoted moment in the feedback, with overlapping/adjacent windows
    merged so the same stretch of conversation never gets shown twice."""
    file_id = extract_drive_file_id(transcript_url)
    if not file_id:
        return {"excerpts": [], "error": None}
    quotes = find_quotes(feedback_text)
    if not quotes:
        return {"excerpts": [], "error": None}

    try:
        text = fetch_transcript_text(file_id)
    except HttpError:
        return {"excerpts": [], "error": (
            "Couldn't load the transcript excerpt — the dashboard's Google service "
            "account may not have read access to this file yet. Use the full "
            "transcript link below instead."
        )}
    except Exception:
        return {"excerpts": [], "error": (
            "Couldn't load the transcript excerpt. Use the full transcript link below instead."
        )}

    turns = parse_transcript_turns(text)
    if not turns:
        return {"excerpts": [], "error": None}

    windows = []  # [start, end, {highlighted turn indices}]
    for quote in quotes:
        idx = _best_matching_turn_index(quote, turns)
        if idx is None:
            continue
        start = max(0, idx - context_turns)
        end = min(len(turns) - 1, idx + context_turns)
        windows.append([start, end, {idx}])

    if not windows:
        return {"excerpts": [], "error": None}

    windows.sort(key=lambda w: w[0])
    merged = [windows[0]]
    for start, end, highlight in windows[1:]:
        last = merged[-1]
        if start <= last[1] + 1:  # overlapping or touching — one excerpt
            last[1] = max(last[1], end)
            last[2] |= highlight
        else:
            merged.append([start, end, highlight])

    excerpts = [
        {"turns": [{**turns[i], "highlight": i in highlight} for i in range(start, end + 1)]}
        for start, end, highlight in merged
    ]
    return {"excerpts": excerpts, "error": None}
