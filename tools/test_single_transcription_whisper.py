#!/usr/bin/env python3
"""
One-file smoke test for the local whisper.cpp transcription pipeline: grabs
a single video from the "Sales Calls" Drive folder, transcribes it entirely
on this machine (no API, no key), and drops the result back into the same
folder -- so you can sanity-check quality (unlabeled speaker turns, same
caveat as the Qwen path) AND how fast it actually runs on your specific CPU
before pointing transcribe_sean_calls_whisper.py at the whole backlog.

Setup (same as tools/transcribe_sean_calls_whisper.py):
    pip install -r requirements.txt
    Install ffmpeg and make sure it's on your PATH.
    - Drive API enabled + an OAuth "Desktop app" client ID downloaded as
      credentials.json, next to this script (same one transcribe_sean_calls.py
      uses).
    No API key needed -- this is the whole point of running it locally.

Run:
    python test_single_transcription_whisper.py
"""

import io
import os
import time

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload

SCOPES = ["https://www.googleapis.com/auth/drive"]
CREDENTIALS_FILE = "credentials.json"
TOKEN_FILE = "token.json"

FOLDER_ID = "1gFb7YnXbnGAowAJgnLE2KNp5iKOCfnYH"  # "Sales Calls"


def authenticate_drive():
    creds = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_FILE, "w") as f:
            f.write(creds.to_json())
    return build("drive", "v3", credentials=creds)


def run_single_test():
    drive_service = authenticate_drive()

    query = f"'{FOLDER_ID}' in parents and mimeType='video/mp4' and trashed=false"
    results = (
        drive_service.files()
        .list(q=query, pageSize=1, fields="files(id, name)")
        .execute()
    )
    files = results.get("files", [])
    if not files:
        print("No .mp4 files found in the specified folder.")
        return

    file_id, file_name = files[0]["id"], files[0]["name"].strip()
    local_video_path = f"./temp_{file_id}.mp4"
    # Hoisted above the try block, and NOT cleaned up unless the upload
    # actually succeeds: if transcription already ran once (e.g. a prior
    # attempt died on the upload step), this file survives on disk and the
    # next run skips straight to a retried upload instead of re-running
    # Whisper -- regenerating a transcript can cost 30-40+ minutes of CPU
    # time, so a transient network blip on upload should never throw that
    # work away.
    local_txt_path = f"./temp_{file_id}.txt"
    print(f"Targeting: {file_name} (ID: {file_id})")

    try:
        if os.path.exists(local_txt_path):
            print("Found a transcript from a previous run that didn't finish uploading -- reusing it, skipping transcription.")
            with open(local_txt_path, "r", encoding="utf-8") as f:
                transcript = f.read()
        else:
            print("Downloading video from Google Drive...")
            request = drive_service.files().get_media(fileId=file_id)
            with io.FileIO(local_video_path, "wb") as fh:
                downloader = MediaIoBaseDownload(fh, request, chunksize=50 * 1024 * 1024)
                done = False
                while not done:
                    status, done = downloader.next_chunk()
                    if status:
                        print(f"    {int(status.progress() * 100)}%")

            print("Loading the whisper.cpp model (downloads once, ~500MB for small.en, then cached)...")
            from pywhispercpp.model import Model
            model = Model("small.en", print_realtime=False, print_progress=False)

            print("Transcribing locally on this CPU -- timing it so you know what to expect on the full backlog...")
            start = time.time()
            segments = model.transcribe(local_video_path)
            transcript = " ".join(seg.text.strip() for seg in segments).strip()
            elapsed = time.time() - start
            print(f"    took {elapsed / 60:.1f} minutes on this machine")

            with open(local_txt_path, "w", encoding="utf-8") as f:
                f.write(transcript)

        transcript_name = f"{file_name} — Transcript"
        print(f"Uploading '{transcript_name}' back to the same Drive folder...")
        uploaded = _upload_with_retry(drive_service, local_txt_path, transcript_name)
        os.remove(local_txt_path)
        print(f"SUCCESS: {uploaded['webViewLink']}")
        print(
            "\nRead this transcript before trusting the full batch: whisper.cpp doesn't label "
            "speaker turns, so check whether it's still clear who's the rep and who's the "
            "prospect from context alone. Also compare the elapsed time above against this "
            "video's actual length -- if it's much slower than real-time on your machine, drop "
            "to 'base.en' in both this file and transcribe_sean_calls_whisper.py's "
            "get_whisper_model() (faster, slightly less accurate)."
        )

    finally:
        if os.path.exists(local_video_path):
            os.remove(local_video_path)


def _upload_with_retry(drive_service, local_txt_path, transcript_name, max_retries=4):
    """Retries transient network drops (e.g. "SSL EOF occurred in violation of
    protocol") -- confirmed to happen on this exact upload, not just large
    files. Raises on the last attempt, leaving local_txt_path in place for a
    future run to pick back up."""
    delay = 15
    max_delay = 60
    for attempt in range(max_retries):
        try:
            return (
                drive_service.files()
                .create(
                    body={"name": transcript_name, "parents": [FOLDER_ID]},
                    media_body=MediaFileUpload(local_txt_path, mimetype="text/plain"),
                    fields="id, webViewLink",
                )
                .execute()
            )
        except (ConnectionError, TimeoutError, OSError) as e:
            if attempt == max_retries - 1:
                raise
            print(f"    Drive upload connection error ({e}), retrying in {delay}s...")
            time.sleep(delay)
            delay = min(delay * 2, max_delay)


if __name__ == "__main__":
    run_single_test()
