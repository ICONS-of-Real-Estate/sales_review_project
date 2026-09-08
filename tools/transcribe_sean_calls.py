#!/usr/bin/env python3
"""
Backfills Drive transcripts for Sean's recorded sales/QC calls.

Run this on a machine with a browser available (your laptop, a VA's machine,
or a small cloud VM you can port-forward from) — the first run needs a
one-time interactive Google OAuth login. After that it's unattended and
re-runnable: it skips any video that already has a "<name> — Transcript" doc
next to it, so running it again later only picks up new calls.

Setup:
    pip install -r requirements.txt

    1. Google Cloud Console (same project as your Gemini key is fine) >
       APIs & Services > Credentials > Create Credentials > OAuth client ID >
       Desktop app. Download the JSON, save it next to this script as
       credentials.json.
    2. Enable the Google Drive API on that same project.
    3. export GEMINI_API_KEY="<your key from aistudio.google.com/apikey>"
    4. python transcribe_sean_calls.py

First run opens a browser tab for Google login/consent, then caches a
token.json so future runs don't prompt again.
"""

import calendar
import datetime
import io
import os
import socket
import subprocess
import sys
import tempfile
import time

from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload

DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"]
CREDENTIALS_FILE = "credentials.json"
TOKEN_FILE = "token.json"

SOURCE_FOLDERS = {
    "Sales Calls": "1gFb7YnXbnGAowAJgnLE2KNp5iKOCfnYH",
    "Qualification Calls": "15YMEMseEvUQakgDF00BtQg3QK6fiTsjX",
}

GEMINI_MODEL = "gemini-flash-latest"

# How stale a lock file has to be before another machine will steal it --
# i.e. how long we're willing to assume a machine that grabbed a video is
# still legitimately working on it before treating it as crashed/killed.
# Comfortably above the slowest realistic single-video time (download + local
# Whisper transcription of a 900MB call on a modest CPU).
LOCK_STALE_SECONDS = 6 * 3600


class QuotaExhaustedError(RuntimeError):
    """Raised when Gemini reports a daily/project quota cap, not a transient error.
    Retrying or continuing to the next file won't help until billing is enabled
    or the quota window resets, so this aborts the whole batch instead of
    burning bandwidth downloading files that are guaranteed to fail."""

def build_transcript_prompt_(rep_name=None, prospect_name_hint=None):
    """Real bug found live (09/09/2026, Kris, pointing at Frank Pirrone's
    actual transcript doc): Gemini's plain "Rep:"/"Prospect:" instruction
    below was routinely ignored on real calls — the doc Kris pasted used
    ">>" as its turn marker instead, not the requested labels, and later in
    the same doc degenerated into one line ("I'm going to do it this way.")
    repeated 3,933 times with no speaker labels or paragraph breaks at all.
    Two separate, additive fixes here, both driven by real evidence rather
    than guessing at what would help:

    1. An explicit anti-repetition instruction — nothing in the old prompt
       ever told the model what to do if it got stuck, and long-form
       generation looping on itself is a well-known failure mode with no
       built-in stopping behavior. transcribe_with_gemini (below) is the
       real backstop (it actually detects and retries a looped result) —
       this is the cheap first line of defense that costs nothing extra to
       try.
    2. Real names instead of generic "Rep:"/"Prospect:" labels, when known
       — Kris's ask directly: "we know who the speaker is, right? ... you
       know it's Joanna and what the lead is, then fill in the freaking
       names of who's speaking." rep_name is always known (this project
       calls this function once per rep's own script); prospect_name_hint
       is the video's own filename, which in practice usually already
       contains the prospect's name (e.g. "1/21 Anthony Camperi") — passed
       through as a HINT the model can confirm or correct against what it
       actually hears, never as an assertion, since the filename is
       sometimes just a date or a cruft-laden video title with no name in
       it at all.
    """
    lines = [
        "Transcribe this recorded sales call verbatim, word for word.",
        "Do not summarize, paraphrase, or clean up filler words — this is for coaching review,",
        "so accuracy matters more than readability.",
        "",
        "Format:",
    ]
    if rep_name:
        lines.append(f'- The rep on this call is named {rep_name}. Label their turns "{rep_name}:".')
        if prospect_name_hint:
            lines.append(
                f'- The other speaker is the prospect. The recording is titled "{prospect_name_hint}", '
                f"which may (or may not) contain their real name — confirm it against what you actually "
                f'hear on the call. If you can identify their real name, label their turns with it '
                f'(e.g. "Frank:"); otherwise use "Prospect:".'
            )
        else:
            lines.append(
                '- The other speaker is the prospect. If you can tell their name from context '
                '(the rep addressing them by name, an introduction), label their turns with it; '
                'otherwise use "Prospect:".'
            )
    else:
        lines.append(
            '- Label speaker turns as best you can tell (e.g. "Rep:", "Prospect:"). If you can\'t '
            'tell who\'s speaking, use "Speaker 1:" / "Speaker 2:" consistently.'
        )
    lines += [
        "- One speaker turn per paragraph, on its own line.",
        "- If a stretch of audio is inaudible, write [inaudible] rather than guessing.",
        "",
        "IMPORTANT — if you notice yourself about to repeat the same sentence or phrase over and",
        "over: STOP immediately. Do not continue looping under any circumstances. Either move on to",
        "the next distinguishable thing actually said, or if the audio genuinely has nothing more to",
        "transcribe, end the transcript there rather than repeating anything.",
        "",
        "Return only the transcript text, nothing else.",
    ]
    return "\n".join(lines)


# Kept as a plain string too (not just the function above) — a handful of
# older internal tools/tests may still reference the bare prompt text
# directly; build_transcript_prompt_() with no arguments returns the
# equivalent generic (no-rep-name) version.
TRANSCRIPT_PROMPT = build_transcript_prompt_()


# ---------------------------------------------------------------------------
# Repetition-loop detection — same algorithm, same thresholds, as Apps
# Script's transcriptRepetitionLoopShare_/transcriptIsDegenerateRepetition_
# (Phase2_CallScoring.gs), added the same day for the same reason: a
# line-based check misses this failure entirely, since a looped transcript
# often has few or no line breaks at all. Verified directly against Frank
# Pirrone's real transcript there (dominant 6-word window "going to do it
# this way" repeats exactly 3,933 times, covering 82.6% of the transcript)
# — kept in sync with that implementation rather than reinvented, so a
# transcript that would be caught downstream in Apps Script is instead
# caught HERE, before it's ever saved to Drive at all.
# ---------------------------------------------------------------------------

DEGENERATE_TRANSCRIPT_MIN_WORDS = 150
DEGENERATE_TRANSCRIPT_NGRAM_SIZE = 6
DEGENERATE_TRANSCRIPT_DOMINANT_GRAM_SHARE = 0.5


def transcript_repetition_loop_share_(text):
    words = (text or "").split()
    n = DEGENERATE_TRANSCRIPT_NGRAM_SIZE
    if len(words) < DEGENERATE_TRANSCRIPT_MIN_WORDS or len(words) < n:
        return 0.0
    counts = {}
    most_count = 0
    for i in range(len(words) - n + 1):
        gram = " ".join(words[i:i + n]).lower()
        c = counts.get(gram, 0) + 1
        counts[gram] = c
        if c > most_count:
            most_count = c
    return (most_count * n) / len(words)


def transcript_is_degenerate_repetition_(text):
    return transcript_repetition_loop_share_(text) >= DEGENERATE_TRANSCRIPT_DOMINANT_GRAM_SHARE


def get_drive_service():
    creds = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, DRIVE_SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, DRIVE_SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_FILE, "w") as f:
            f.write(creds.to_json())
    return build("drive", "v3", credentials=creds)


def list_videos(drive, folder_id):
    """Recurses into subfolders so a rep's videos aren't missed just because
    someone organized a few of them into a dated/named subfolder (seen for
    real in Sean's and Joana's folders) -- every subfolder at any depth gets
    scanned the same as the top folder. Each returned video dict carries its
    own "parent_folder_id" (where it actually lives) since that's where its
    transcript doc and lock file need to be created, which can differ from
    the top-level folder_id callers pass in. Also carries "videoMediaMetadata"
    (Drive's own duration_millis, when Drive has already computed it) as a
    fallback source for call_length_line_ below, for whenever
    probe_duration_seconds_ can't measure the downloaded file itself."""
    videos, existing_names = [], set()
    folders_to_scan = [folder_id]
    while folders_to_scan:
        current_folder_id = folders_to_scan.pop()
        page_token = None
        while True:
            resp = (
                drive.files()
                .list(
                    q=f"'{current_folder_id}' in parents and trashed = false",
                    fields="nextPageToken, files(id, name, mimeType, size, videoMediaMetadata)",
                    pageSize=200,
                    pageToken=page_token,
                )
                .execute()
            )
            for f in resp.get("files", []):
                if f["mimeType"] == "application/vnd.google-apps.folder":
                    folders_to_scan.append(f["id"])
                elif f["mimeType"].startswith("video/"):
                    f["parent_folder_id"] = current_folder_id
                    videos.append(f)
                else:
                    existing_names.add(f["name"])
            page_token = resp.get("nextPageToken")
            if not page_token:
                break
    return videos, existing_names


def download_video(drive, file_id, dest_path):
    request = drive.files().get_media(fileId=file_id)
    with io.FileIO(dest_path, "wb") as fh:
        downloader = MediaIoBaseDownload(fh, request, chunksize=50 * 1024 * 1024)
        done = False
        while not done:
            status, done = downloader.next_chunk()
            if status:
                print(f"    downloaded {int(status.progress() * 100)}%")


def generate_with_retry(client, model, contents, max_retries=6):
    delay = 15
    max_delay = 120
    config = genai_types.GenerateContentConfig(
        thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
        # Real bug found live (09/09/2026): no temperature was ever set here,
        # so this ran at Gemini's default (creative-sampling) temperature for
        # a task that should be as close to deterministic as possible —
        # verbatim transcription, not generation. Low but nonzero: 0 can
        # itself increase certain repetition failure modes in some models by
        # always picking the single most-likely next token; 0.1 keeps output
        # close to deterministic while still allowing the model to move past
        # a locally-likely-but-wrong token instead of latching onto it.
        temperature=0.1,
    )
    for attempt in range(max_retries):
        try:
            response = client.models.generate_content(model=model, contents=contents, config=config)
        except genai_errors.ClientError as e:
            _reraise_as_quota_error_if_applicable(e)
        except (genai_errors.ServerError, ConnectionError, TimeoutError, OSError) as e:
            # OSError also catches transient SSL/connection drops (e.g. "EOF occurred
            # in violation of protocol"), which aren't ServerError but are just as retryable.
            if attempt == max_retries - 1:
                raise
            print(f"    Gemini server error ({e}), retrying in {delay}s...")
            time.sleep(delay)
            delay = min(delay * 2, max_delay)
            continue

        if response.text:
            return response
        candidate = response.candidates[0] if response.candidates else None
        reason = candidate.finish_reason if candidate else response.prompt_feedback
        raise RuntimeError(f"Gemini returned no transcript text (reason: {reason})")


def _reraise_as_quota_error_if_applicable(e):
    if "RESOURCE_EXHAUSTED" in str(e) or getattr(e, "code", None) == 429:
        raise QuotaExhaustedError(str(e)) from e
    raise e


def upload_with_retry(client, local_path, max_retries=4):
    delay = 15
    max_delay = 60
    for attempt in range(max_retries):
        try:
            gemini_file = client.files.upload(file=local_path)
            while gemini_file.state.name == "PROCESSING":
                time.sleep(5)
                gemini_file = client.files.get(name=gemini_file.name)
            return gemini_file
        except genai_errors.ClientError as e:
            _reraise_as_quota_error_if_applicable(e)
        except (ConnectionError, TimeoutError, OSError) as e:
            # Large files (300MB+) occasionally drop mid-upload with an SSL EOF;
            # this is transient, unlike quota errors, so it's worth retrying.
            if attempt == max_retries - 1:
                raise
            print(f"    Upload connection error ({e}), retrying in {delay}s...")
            time.sleep(delay)
            delay = min(delay * 2, max_delay)


MAX_REPETITION_RETRIES = 2


def transcribe_with_gemini(client, local_path, rep_name=None, prospect_name_hint=None):
    """rep_name/prospect_name_hint feed build_transcript_prompt_ so the
    transcript comes back with real speaker names instead of generic
    "Rep:"/"Prospect:" labels when we already know who's on the call — see
    that function's own comment. Both optional and backward-compatible:
    omitted, this behaves exactly as before.

    Real bug found live (09/09/2026, Kris pasting Frank Pirrone's actual
    transcript doc): this used to return whatever Gemini produced, even a
    transcript that degenerated into one line repeated 3,933 times — that
    corrupted doc got saved to Drive, scored by the Apps Script pipeline as
    a genuine 1/5 call, and became the single worst call in Sean's training
    email. The Apps Script side now catches this AFTER the fact
    (transcriptIsDegenerateRepetition_, Phase2_CallScoring.gs) and blanks
    the score rather than trusting it — but that still means a real API
    call was wasted producing garbage, a real API call was wasted scoring
    it, and Sean's Drive folder has a permanently corrupted "transcript"
    sitting in it forever.

    Catching it HERE instead: detect the same failure with the same
    algorithm (transcript_is_degenerate_repetition_, ported directly from
    the Apps Script fix) before ever saving anything, and retry the
    generation — a fresh Gemini call is not deterministic even at low
    temperature, so a retry has a real chance of succeeding outright. Only
    after MAX_REPETITION_RETRIES straight failures does this give up and
    raise, so the batch loop's existing "FAILED: ..." handling logs it and
    moves to the next video rather than silently uploading garbage.
    """
    gemini_file = upload_with_retry(client, local_path)
    if gemini_file.state.name != "ACTIVE":
        raise RuntimeError(f"Gemini file upload failed: {gemini_file.state.name}")

    prompt = build_transcript_prompt_(rep_name, prospect_name_hint)
    try:
        last_text = None
        for attempt in range(MAX_REPETITION_RETRIES + 1):
            response = generate_with_retry(client, GEMINI_MODEL, [gemini_file, prompt])
            last_text = response.text
            if not transcript_is_degenerate_repetition_(last_text):
                return last_text
            share = transcript_repetition_loop_share_(last_text)
            if attempt < MAX_REPETITION_RETRIES:
                print(f"    Gemini transcript looped (dominant phrase covers "
                      f"{share:.0%} of the text) — retrying ({attempt + 1}/{MAX_REPETITION_RETRIES})...")
            else:
                raise RuntimeError(
                    f"Gemini transcript still looping after {MAX_REPETITION_RETRIES} retries "
                    f"(dominant phrase covers {share:.0%} of the text) — refusing to save a corrupted "
                    f"transcript. Try again later, or fall back to the Zoom transcript if one exists."
                )
    finally:
        client.files.delete(name=gemini_file.name)


def format_duration_(seconds):
    """Human-readable elapsed/ETA time for the progress lines main() prints
    below (e.g. "1h 12m 4s") -- shared by every transcribe_*.py variant
    (Sean/Joana x Gemini/Qwen/Whisper) so they all report progress the same way."""
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def probe_duration_seconds_(local_path, video_meta=None):
    """Real elapsed seconds of a call recording, for Kris's ask (07/09/2026):
    "seems to be the length of the calls. Tomas calls are longer than the
    others. We need to measure the call length and the average -- that is a
    key indicator." ffprobe (already a hard dependency of every Whisper
    variant here, since Whisper itself needs ffmpeg to decode audio) reads
    the actual downloaded file -- more reliable than Drive's own
    videoMediaMetadata.durationMillis, which can be missing or stale right
    after upload. Falls back to that Drive metadata (list_videos' own field,
    passed in as video_meta) when ffprobe isn't available or the local file
    is already gone (e.g. the "reuse transcript from an interrupted run"
    resume path, which can skip the download entirely). Returns None, never
    raises, on any failure -- a missing duration must never block a
    transcription or look like a measured zero-length call."""
    if local_path and os.path.exists(local_path):
        try:
            out = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", local_path],
                capture_output=True, text=True, timeout=30, check=True,
            )
            return float(out.stdout.strip())
        except Exception:
            pass
    if video_meta:
        millis = (video_meta.get("videoMediaMetadata") or {}).get("durationMillis")
        if millis:
            try:
                return float(millis) / 1000.0
            except (TypeError, ValueError):
                pass
    return None


def with_call_length_line_(transcript, local_path, video_meta=None):
    """Prepends call_length_line_'s output to transcript, unless it's already
    there. Needed because the "reuse transcript from a previous, interrupted
    run" resume path (run_whisper_batch/main, above) reads back a .txt file
    that save_transcript_doc may have already stamped with this line before a
    prior run's upload step failed -- without this guard, resuming that file
    would stack a second "[Call length: ...]" line on top of the first."""
    if transcript.startswith("[Call length:"):
        return transcript
    return call_length_line_(probe_duration_seconds_(local_path, video_meta)) + transcript


def call_length_line_(seconds):
    """A leading "[Call length: MM:SS]" line stashed at the very top of every
    saved transcript doc -- the cheapest, already-available signal for actual
    call length. Phase2_CallScoring.gs's getTranscriptText_/
    getCallLengthMinutesFromTranscriptFile_ parse this back out (and strip it
    before any judge prompt sees it), so it never reads as something someone
    said on the call. Returns '' (no line at all) when duration is unknown --
    a missing measurement must never look like a real "0:00" call."""
    if not seconds or seconds <= 0:
        return ""
    minutes, secs = divmod(int(round(seconds)), 60)
    return f"[Call length: {minutes}:{secs:02d}]\n\n"


def transcript_temp_path(video_id):
    """Where save_transcript_doc stashes a transcript locally before/while
    uploading it. Exposed so callers can check for one left behind by a
    prior run that got interrupted after transcribing but before a
    successful upload (process killed, laptop slept through a long network
    drop, etc.) and skip straight to re-uploading instead of re-transcribing
    -- regenerating can mean 20-40+ minutes of local CPU time (Whisper) or
    real API cost (Gemini/Qwen)."""
    return os.path.join(tempfile.gettempdir(), f"{video_id}.txt")


def save_transcript_doc(drive, folder_id, video_id, title, transcript_text):
    tmp_txt = transcript_temp_path(video_id)
    with open(tmp_txt, "w", encoding="utf-8") as f:
        f.write(transcript_text)

    # Retries transient network drops -- confirmed to hit this Drive upload
    # too, not just the large-file Gemini upload upload_with_retry already
    # guards above ("SSL EOF occurred in violation of protocol" is a real
    # error seen here on a plain .txt upload, not just 300MB+ files).
    # Deliberately does NOT delete tmp_txt if every retry is exhausted:
    # transcript_text can represent 30-40+ minutes of local CPU time (Whisper)
    # or real API cost (Gemini/Qwen) to regenerate, so losing it to a
    # transient blip is far worse than a stray temp file. Only cleaned up
    # after a confirmed successful upload, below.
    link = _upload_transcript_with_retry(drive, folder_id, tmp_txt, title)
    try:
        os.remove(tmp_txt)
    except OSError:
        pass  # Windows can still hold the handle briefly; harmless to leave a tiny .txt in Temp.
    return link


def _upload_transcript_with_retry(drive, folder_id, tmp_txt, title, max_retries=4):
    delay = 15
    max_delay = 60
    for attempt in range(max_retries):
        try:
            media = MediaFileUpload(tmp_txt, mimetype="text/plain")
            doc = (
                drive.files()
                .create(
                    body={
                        "name": f"{title} — Transcript",
                        "parents": [folder_id],
                        "mimeType": "application/vnd.google-apps.document",
                    },
                    media_body=media,
                    fields="id, webViewLink",
                )
                .execute()
            )
            return doc["webViewLink"]
        except (ConnectionError, TimeoutError, OSError) as e:
            # OSError also catches transient SSL/connection drops, same
            # reasoning as upload_with_retry above.
            if attempt == max_retries - 1:
                raise
            print(f"    Drive upload connection error ({e}), retrying in {delay}s...")
            time.sleep(delay)
            delay = min(delay * 2, max_delay)


def _lock_name(video_id):
    return f".lock-{video_id}"


def _parse_drive_time(ts):
    """Drive's createdTime looks like '2026-08-20T12:34:56.789Z' -- parse as UTC epoch seconds."""
    dt = datetime.datetime.strptime(ts.split(".")[0], "%Y-%m-%dT%H:%M:%S")
    return calendar.timegm(dt.timetuple())


def try_acquire_lock(drive, folder_id, video_id):
    """Best-effort distributed lock so multiple machines (e.g. two laptops plus
    an OVH cloud VM) can run the SAME batch script against the SAME Drive
    folder at once without two of them transcribing the same video.

    Drive has no real compare-and-swap, so this creates a marker file named
    after the video, waits a beat for Drive to settle, then re-lists by that
    exact name: only the earliest-created contender (createdTime, file id as
    a stable tiebreak) wins the race, and every loser deletes its own copy.
    A lock left behind by a crashed/killed process is stolen once it's older
    than LOCK_STALE_SECONDS, so a dead machine can't strand a video forever.

    Returns the winning lock file's id (pass to release_lock when done), or
    None if this machine should skip this video (already claimed and fresh,
    or the lock check itself failed -- either way, safer to move on to the
    next pending video than to risk double-transcribing).
    """
    lock_name = _lock_name(video_id)
    try:
        existing = drive.files().list(
            q=f"'{folder_id}' in parents and name = '{lock_name}' and trashed = false",
            fields="files(id, createdTime)",
        ).execute().get("files", [])
        if existing:
            oldest_age = time.time() - min(_parse_drive_time(f["createdTime"]) for f in existing)
            if oldest_age < LOCK_STALE_SECONDS:
                return None
            print(f"    (stealing a lock left behind {format_duration_(oldest_age)} ago -- looks abandoned)")
            for f in existing:
                try:
                    drive.files().delete(fileId=f["id"]).execute()
                except Exception:
                    pass

        mine = drive.files().create(
            body={
                "name": lock_name,
                "parents": [folder_id],
                "description": f"claimed by {socket.gethostname()} pid={os.getpid()}",
            },
            fields="id, createdTime",
        ).execute()

        time.sleep(2)  # let Drive settle before checking for a same-instant race with another machine
        contenders = drive.files().list(
            q=f"'{folder_id}' in parents and name = '{lock_name}' and trashed = false",
            fields="files(id, createdTime)",
        ).execute().get("files", [])
        winner = min(contenders, key=lambda f: (f["createdTime"], f["id"]))
        for f in contenders:
            if f["id"] != winner["id"] and f["id"] != mine["id"]:
                try:
                    drive.files().delete(fileId=f["id"]).execute()
                except Exception:
                    pass
        if winner["id"] != mine["id"]:
            try:
                drive.files().delete(fileId=mine["id"]).execute()
            except Exception:
                pass
            return None
        return mine["id"]
    except Exception as e:
        print(f"    (lock check failed, skipping this video for now: {e})")
        return None


def release_lock(drive, lock_file_id):
    if not lock_file_id:
        return
    try:
        drive.files().delete(fileId=lock_file_id).execute()
    except Exception:
        pass  # best-effort -- a leftover lock is just treated as stale (and stolen) after LOCK_STALE_SECONDS


def transcript_already_exists(drive, folder_id, title):
    """Live re-check, called right after winning the lock -- closes a real
    gap found live (23/08/2026): run_whisper_batch's `existing_names` is a
    snapshot taken once at the START of a run, then held for however long
    that run takes (hours, for a big folder). Two runs/workers started close
    together both see the same stale "not yet transcribed" snapshot, both
    win the lock for DIFFERENT videos in their own pass, and neither's
    pre-scan ever gets refreshed to notice the other's completed work along
    the way -- confirmed live: Sean's Qualification Calls folder had 2-4
    duplicate "<title> — Transcript" Docs for ~25+ real calls, all from
    concurrent worker runs. The per-video lock alone doesn't catch this
    because by the time a video's own lock is being contested, the OTHER
    worker may have already finished, uploaded, and released it. This is a
    direct, live Drive query for the one thing that actually matters right
    now: does a transcript with this exact name exist in this folder AT
    THIS MOMENT, not "did it exist when this run started."
    """
    try:
        existing = drive.files().list(
            q=f"'{folder_id}' in parents and name = '{title} — Transcript' and trashed = false",
            fields="files(id)",
        ).execute().get("files", [])
        return bool(existing)
    except Exception:
        return False  # best-effort, same spirit as try_acquire_lock above -- never block real work on this check failing


def run_whisper_batch(folders, transcribe_fn, title_fn=None, log_completed_fn=None):
    """Shared multi-machine-safe batch loop for the *_whisper.py variants
    (Sean/Tomás/Joana) -- same Drive plumbing as main() above, plus the
    per-video lock from try_acquire_lock/release_lock so this can safely run
    on several machines at once against the same folder(s): each machine
    claims a video before starting it, and skips straight to the next
    pending one if another machine already has it.

    title_fn(video_dict) -> display name; defaults to the raw Drive filename.
    log_completed_fn(title, video_id, link), if given, is called after each
    successful upload (Tomás's variant uses this for its completion log).
    """
    if title_fn is None:
        title_fn = lambda v: v["name"].strip()

    drive = get_drive_service()

    # Pre-scan every folder up front (list_videos() gets called once per
    # folder either way) so the per-video progress/ETA lines below can report
    # against the WHOLE backlog, not just whatever folder happens to be
    # running.
    work_by_folder = {}
    total_videos = 0
    for folder_label, folder_id in folders.items():
        videos, existing_names = list_videos(drive, folder_id)
        pending = [v for v in videos if f"{title_fn(v)} — Transcript" not in existing_names]
        work_by_folder[folder_label] = (folder_id, pending)
        total_videos += len(pending)
        print(f"  [{folder_label}] {len(pending)} to do, {len(videos) - len(pending)} already transcribed")
    print(f"\n{total_videos} video(s) to transcribe across {len(folders)} folder(s) "
          f"(some may already be claimed by another machine).")

    batch_start = time.time()
    completed = 0
    skipped_locked = 0
    # Only videos transcribed FRESH this run go in here -- a reused
    # download/transcript from a prior interrupted run finishes far faster
    # than a real transcription, so it isn't a fair basis for estimating what
    # the REMAINING (not-yet-started) videos will take.
    per_video_times = []

    for folder_label, (folder_id, videos) in work_by_folder.items():
        print(f"\n=== {folder_label} ===")
        for video in videos:
            title = title_fn(video)
            video_folder_id = video.get("parent_folder_id", folder_id)

            lock_id = try_acquire_lock(drive, video_folder_id, video["id"])
            if lock_id is None:
                print(f"[skipping] {title} — already claimed by another machine")
                skipped_locked += 1
                continue

            # Live re-check, not just the pre-scan snapshot from when this run
            # started -- see transcript_already_exists's docstring for the real
            # duplicate-transcript bug this closes.
            if transcript_already_exists(drive, video_folder_id, title):
                print(f"[skipping] {title} — a transcript already exists (finished by another run/worker since this batch started)")
                release_lock(drive, lock_id)
                skipped_locked += 1
                continue

            print(f"[transcribing] {title} ({int(video.get('size', 0)) / 1e6:.0f} MB)")

            local_path = os.path.join(tempfile.gettempdir(), f"{video['id']}.mp4")
            txt_path = transcript_temp_path(video["id"])
            video_start = time.time()
            fresh = False
            try:
                if os.path.exists(txt_path):
                    # A previous run already finished transcribing this one but
                    # got interrupted before a successful upload (process
                    # killed, laptop slept through a long network drop, etc.)
                    # -- reuse it instead of burning another 20-40+ minutes
                    # re-transcribing.
                    print("    (reusing transcript from a previous, interrupted run)")
                    with open(txt_path, "r", encoding="utf-8") as f:
                        transcript = f.read()
                else:
                    if os.path.exists(local_path):
                        print("    (reusing file downloaded on a previous run)")
                    else:
                        t0 = time.time()
                        download_video(drive, video["id"], local_path)
                        print(f"    download: {format_duration_(time.time() - t0)}")

                    t0 = time.time()
                    transcript = transcribe_fn(local_path)
                    print(f"    transcribe: {format_duration_(time.time() - t0)}")
                    fresh = True

                transcript = with_call_length_line_(transcript, local_path, video)

                t0 = time.time()
                link = save_transcript_doc(drive, video_folder_id, video["id"], title, transcript)
                print(f"    upload: {format_duration_(time.time() - t0)}")
                print(f"    done -> {link}")
                if log_completed_fn:
                    log_completed_fn(title, video["id"], link)
                if os.path.exists(local_path):
                    os.remove(local_path)
            except Exception as e:
                print(f"    FAILED: {e}")
                if os.path.exists(local_path):
                    os.remove(local_path)
                continue
            finally:
                video_total = time.time() - video_start
                print(f"    total: {format_duration_(video_total)}")
                release_lock(drive, lock_id)

            completed += 1
            if fresh:
                per_video_times.append(video_total)
            remaining = total_videos - completed - skipped_locked
            line = (f"    progress: {completed}/{total_videos} done this machine "
                    f"({skipped_locked} claimed by others), elapsed {format_duration_(time.time() - batch_start)}")
            if remaining and per_video_times:
                avg = sum(per_video_times) / len(per_video_times)
                line += f", ~{format_duration_(avg * remaining)} left ({format_duration_(avg)}/video avg)"
            print(line)

    print(f"\nAll done: {completed}/{total_videos} video(s) transcribed on this machine "
          f"({skipped_locked} were already claimed by other machines). "
          f"Total elapsed: {format_duration_(time.time() - batch_start)}")


def main():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        sys.exit("Set GEMINI_API_KEY before running.")
    client = genai.Client(api_key=api_key)

    drive = get_drive_service()

    # Pre-scan every folder up front (list_videos() gets called once per
    # folder either way) so the per-video progress/ETA lines below can report
    # against the WHOLE backlog, not just whatever folder happens to be
    # running.
    work_by_folder = {}
    total_videos = 0
    for folder_label, folder_id in SOURCE_FOLDERS.items():
        videos, existing_names = list_videos(drive, folder_id)
        pending = [v for v in videos if f"{v['name'].strip()} — Transcript" not in existing_names]
        work_by_folder[folder_label] = (folder_id, pending)
        total_videos += len(pending)
        print(f"  [{folder_label}] {len(pending)} to do, {len(videos) - len(pending)} already transcribed")
    print(f"\n{total_videos} video(s) to transcribe across {len(SOURCE_FOLDERS)} folder(s).")

    batch_start = time.time()
    completed = 0
    # Only videos transcribed FRESH this run go in here -- a reused
    # download/transcript from a prior interrupted run finishes far faster
    # than a real transcription, so it isn't a fair basis for estimating what
    # the REMAINING (not-yet-started) videos will take.
    per_video_times = []

    for folder_label, (folder_id, videos) in work_by_folder.items():
        print(f"\n=== {folder_label} ===")
        for video in videos:
            title = video["name"].strip()
            video_folder_id = video.get("parent_folder_id", folder_id)
            print(f"[transcribing] {title} ({int(video.get('size', 0)) / 1e6:.0f} MB)")

            local_path = os.path.join(tempfile.gettempdir(), f"{video['id']}.mp4")
            txt_path = transcript_temp_path(video["id"])
            video_start = time.time()
            fresh = False
            try:
                if os.path.exists(txt_path):
                    # Already transcribed on a prior run that got interrupted
                    # before a successful upload -- reuse it instead of paying
                    # for another Gemini transcription.
                    print("    (reusing transcript from a previous, interrupted run)")
                    with open(txt_path, "r", encoding="utf-8") as f:
                        transcript = f.read()
                else:
                    if os.path.exists(local_path):
                        print("    (reusing file downloaded on a previous, quota-stopped run)")
                    else:
                        t0 = time.time()
                        download_video(drive, video["id"], local_path)
                        print(f"    download: {format_duration_(time.time() - t0)}")

                    t0 = time.time()
                    transcript = transcribe_with_gemini(client, local_path, rep_name="Sean", prospect_name_hint=title)
                    print(f"    transcribe: {format_duration_(time.time() - t0)}")
                    fresh = True

                transcript = with_call_length_line_(transcript, local_path, video)

                t0 = time.time()
                link = save_transcript_doc(drive, video_folder_id, video["id"], title, transcript)
                print(f"    upload: {format_duration_(time.time() - t0)}")
                print(f"    done -> {link}")
                if os.path.exists(local_path):
                    os.remove(local_path)
            except QuotaExhaustedError:
                # Stop the whole batch, but keep the local file — next run picks up
                # transcription directly instead of re-downloading it from scratch.
                raise
            except Exception as e:
                print(f"    FAILED: {e}")
                if os.path.exists(local_path):
                    os.remove(local_path)
                continue
            finally:
                video_total = time.time() - video_start
                print(f"    total: {format_duration_(video_total)}")

            completed += 1
            if fresh:
                per_video_times.append(video_total)
            remaining = total_videos - completed
            line = f"    progress: {completed}/{total_videos} done, elapsed {format_duration_(time.time() - batch_start)}"
            if remaining and per_video_times:
                avg = sum(per_video_times) / len(per_video_times)
                line += f", ~{format_duration_(avg * remaining)} left ({format_duration_(avg)}/video avg)"
            print(line)

    print(f"\nAll done: {completed}/{total_videos} video(s) transcribed. "
          f"Total elapsed: {format_duration_(time.time() - batch_start)}")


if __name__ == "__main__":
    try:
        main()
    except QuotaExhaustedError as e:
        sys.exit(
            "\nSTOPPING — Gemini API quota exhausted for today: "
            f"{e}\n\n"
            "This is a free-tier daily cap on this Google Cloud project, not a bug in "
            "the script. Enable billing on the project tied to your Gemini API key "
            "(aistudio.google.com/apikey -> this key -> its linked project -> enable "
            "Pay-as-you-go billing in Google Cloud Console), then re-run this script. "
            "It will skip everything already transcribed and pick up right where it "
            "stopped."
        )
