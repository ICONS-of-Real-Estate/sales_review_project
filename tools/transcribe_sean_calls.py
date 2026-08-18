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

import io
import os
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


class QuotaExhaustedError(RuntimeError):
    """Raised when Gemini reports a daily/project quota cap, not a transient error.
    Retrying or continuing to the next file won't help until billing is enabled
    or the quota window resets, so this aborts the whole batch instead of
    burning bandwidth downloading files that are guaranteed to fail."""

TRANSCRIPT_PROMPT = """Transcribe this recorded sales call verbatim, word for word.
Do not summarize, paraphrase, or clean up filler words — this is for coaching review,
so accuracy matters more than readability.

Format:
- Label speaker turns as best you can tell (e.g. "Rep:", "Prospect:"). If you can't
  tell who's speaking, use "Speaker 1:" / "Speaker 2:" consistently.
- One speaker turn per paragraph.
- If a stretch of audio is inaudible, write [inaudible] rather than guessing.

Return only the transcript text, nothing else."""


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
    videos, existing_names, page_token = [], set(), None
    while True:
        resp = (
            drive.files()
            .list(
                q=f"'{folder_id}' in parents and trashed = false",
                fields="nextPageToken, files(id, name, mimeType, size)",
                pageSize=200,
                pageToken=page_token,
            )
            .execute()
        )
        for f in resp.get("files", []):
            if f["mimeType"].startswith("video/"):
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


def transcribe_with_gemini(client, local_path):
    gemini_file = upload_with_retry(client, local_path)
    if gemini_file.state.name != "ACTIVE":
        raise RuntimeError(f"Gemini file upload failed: {gemini_file.state.name}")

    response = generate_with_retry(client, GEMINI_MODEL, [gemini_file, TRANSCRIPT_PROMPT])
    client.files.delete(name=gemini_file.name)
    return response.text


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
                    transcript = transcribe_with_gemini(client, local_path)
                    print(f"    transcribe: {format_duration_(time.time() - t0)}")
                    fresh = True

                t0 = time.time()
                link = save_transcript_doc(drive, folder_id, video["id"], title, transcript)
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
