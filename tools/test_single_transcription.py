#!/usr/bin/env python3
"""
One-file smoke test for the transcription pipeline: grabs a single video from
the "Sales Calls" Drive folder, transcribes it with Gemini, and drops the
result back into the same folder — so you can sanity-check the whole flow
before running it against the full backlog.

Setup (same as tools/transcribe_sean_calls.py):
    pip install -r requirements.txt
    - Drive API enabled + an OAuth "Desktop app" client ID downloaded as
      credentials.json, next to this script.
    - export GEMINI_API_KEY="<your key from aistudio.google.com/apikey>"

Run:
    python test_single_transcription.py
"""

import io
import os
import sys
import time

from google import genai
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload

SCOPES = ["https://www.googleapis.com/auth/drive"]
CREDENTIALS_FILE = "credentials.json"
TOKEN_FILE = "token.json"

FOLDER_ID = "1gFb7YnXbnGAowAJgnLE2KNp5iKOCfnYH"  # "Sales Calls"
GEMINI_MODEL = "gemini-2.5-flash"

TRANSCRIPT_PROMPT = """Provide a strict, verbatim, word-for-word transcript of the
audio in this video file. Do not summarize, do not edit, do not add section
headers, and do not add any feedback, analysis, or commentary. Label speaker
turns as best you can tell (e.g. "Rep:", "Prospect:"); if you can't tell who's
speaking, use "Speaker 1:" / "Speaker 2:" consistently. Output ONLY the transcript."""


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


def wait_until_active(client, gemini_file):
    while gemini_file.state.name == "PROCESSING":
        print("    still processing on Gemini's side, waiting...")
        time.sleep(5)
        gemini_file = client.files.get(name=gemini_file.name)
    if gemini_file.state.name != "ACTIVE":
        raise RuntimeError(f"Gemini file upload failed: {gemini_file.state.name}")
    return gemini_file


def run_single_test():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        sys.exit("Set GEMINI_API_KEY before running.")
    client = genai.Client(api_key=api_key)

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

        print("Uploading to Gemini and waiting for it to finish processing...")
        gemini_file = client.files.upload(file=local_video_path)
        gemini_file = wait_until_active(client, gemini_file)

        print("Transcribing...")
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[gemini_file, TRANSCRIPT_PROMPT],
        )
        client.files.delete(name=gemini_file.name)

        transcript_name = f"{file_name} — Transcript"
        local_transcript_path = f"./temp_{file_id}.txt"
        with open(local_transcript_path, "w", encoding="utf-8") as f:
            f.write(response.text)

        print(f"Uploading '{transcript_name}' back to the same Drive folder...")
        uploaded = (
            drive_service.files()
            .create(
                body={"name": transcript_name, "parents": [FOLDER_ID]},
                media_body=MediaFileUpload(local_transcript_path, mimetype="text/plain"),
                fields="id, webViewLink",
            )
            .execute()
        )
        print(f"SUCCESS: {uploaded['webViewLink']}")
        os.remove(local_transcript_path)

    finally:
        if os.path.exists(local_video_path):
            os.remove(local_video_path)


if __name__ == "__main__":
    run_single_test()
