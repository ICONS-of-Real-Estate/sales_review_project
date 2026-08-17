#!/usr/bin/env python3
"""
One-file smoke test for the Qwen3-ASR-Flash transcription pipeline: grabs a
single video from the "Sales Calls" Drive folder, transcribes it with
qwen3-asr-toolkit, and drops the result back into the same folder -- so you
can sanity-check quality (and, critically, whether unlabeled speaker turns
are still usable) before running transcribe_sean_calls_qwen.py against the
full backlog.

Setup (same as tools/transcribe_sean_calls_qwen.py):
    pip install -r requirements.txt
    Install ffmpeg and make sure it's on your PATH.
    - Drive API enabled + an OAuth "Desktop app" client ID downloaded as
      credentials.json, next to this script (same one transcribe_sean_calls.py
      uses).
    - export DASHSCOPE_API_KEY="<your key from dashscope.console.aliyun.com>"

Run:
    python test_single_transcription_qwen.py
"""

import io
import os
import subprocess
import sys

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
    if not os.environ.get("DASHSCOPE_API_KEY"):
        sys.exit("Set DASHSCOPE_API_KEY before running.")

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
    local_txt_path = f"./temp_{file_id}.txt"
    print(f"Targeting: {file_name} (ID: {file_id})")

    try:
        print("Downloading video from Google Drive...")
        request = drive_service.files().get_media(fileId=file_id)
        with io.FileIO(local_video_path, "wb") as fh:
            downloader = MediaIoBaseDownload(fh, request, chunksize=50 * 1024 * 1024)
            done = False
            while not done:
                status, done = downloader.next_chunk()
                if status:
                    print(f"    {int(status.progress() * 100)}%")

        print("Transcribing with qwen3-asr (this shells out, watch for its own progress output)...")
        subprocess.run(["qwen3-asr", "-i", local_video_path], check=True)
        if not os.path.exists(local_txt_path):
            sys.exit(f"qwen3-asr didn't produce the expected output file: {local_txt_path}")

        transcript_name = f"{file_name} — Transcript"
        print(f"Uploading '{transcript_name}' back to the same Drive folder...")
        uploaded = (
            drive_service.files()
            .create(
                body={"name": transcript_name, "parents": [FOLDER_ID]},
                media_body=MediaFileUpload(local_txt_path, mimetype="text/plain"),
                fields="id, webViewLink",
            )
            .execute()
        )
        print(f"SUCCESS: {uploaded['webViewLink']}")
        print(
            "\nRead this transcript before trusting the full batch: qwen3-asr-toolkit doesn't "
            "label speaker turns, so check whether it's still clear who's the rep and who's "
            "the prospect from context alone."
        )

    finally:
        if os.path.exists(local_video_path):
            os.remove(local_video_path)
        if os.path.exists(local_txt_path):
            os.remove(local_txt_path)


if __name__ == "__main__":
    run_single_test()
