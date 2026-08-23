#!/usr/bin/env python3
"""
One-time cleanup for the duplicate-transcript bug found live (23/08/2026,
see the commit that added transcript_already_exists() in
transcribe_sean_calls.py): before that fix, concurrent Whisper workers
could each independently transcribe the same video and upload their own
"<title> — Transcript" Doc, because the "what's already done" check was a
stale snapshot taken once at the start of a run. Confirmed live: Sean's
Qualification Calls folder had 2-4 duplicate Transcript Docs for ~25+ real
calls, all from before that fix landed.

This does NOT touch the Sales Call Log or any scored data — confirmed
separately that the scoring step was never fooled by these duplicates
(Sean's rows are already all distinct). This is purely Drive cleanup:
extra Google Docs sitting in the source folders, wasting nothing but disk
and making the folder noisier to browse by hand.

For each folder given, groups every "<title> — Transcript" Doc by its
exact title and, within each group of 2+, keeps the EARLIEST-created copy
(the one that would have "won" under the current code's logic if the race
had gone the way it should have) and trashes the rest. Uses Drive's Trash,
not permanent delete -- reversible for 30 days by default, same safety
margin as deleting a file by hand in the Drive UI.

Usage:
    python dedupe_duplicate_transcripts.py --preview   <folder_id> [folder_id ...]
    python dedupe_duplicate_transcripts.py --live      <folder_id> [folder_id ...]

Run --preview first always. Nothing is trashed until --live is passed
explicitly. Setup: identical to transcribe_sean_calls.py (credentials.json
+ token.json already present in this folder) -- no API key needed, this
only uses the Drive API.
"""

import sys
from collections import defaultdict

from transcribe_sean_calls import get_drive_service


def list_transcript_docs(drive, folder_id):
    """Every "<title> — Transcript" Doc directly in folder_id (not recursing
    into subfolders -- unlike list_videos, duplicate transcripts were only
    ever observed at the top level of the folders this bug hit)."""
    docs = []
    page_token = None
    while True:
        resp = (
            drive.files()
            .list(
                q=f"'{folder_id}' in parents and trashed = false "
                  f"and mimeType = 'application/vnd.google-apps.document' "
                  f"and name contains ' — Transcript'",
                fields="nextPageToken, files(id, name, createdTime, size)",
                pageSize=200,
                pageToken=page_token,
            )
            .execute()
        )
        docs.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return docs


def find_duplicate_groups(docs):
    """Groups by exact title; returns {title: [docs sorted oldest-first]} for
    every title with 2+ copies."""
    by_title = defaultdict(list)
    for d in docs:
        by_title[d["name"]].append(d)
    return {
        title: sorted(group, key=lambda d: d["createdTime"])
        for title, group in by_title.items()
        if len(group) > 1
    }


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("--preview", "--live"):
        sys.exit(__doc__)
    live = sys.argv[1] == "--live"
    folder_ids = sys.argv[2:]

    drive = get_drive_service()
    total_groups = 0
    total_to_trash = 0

    for folder_id in folder_ids:
        print(f"\n=== Folder {folder_id} ===")
        docs = list_transcript_docs(drive, folder_id)
        dupes = find_duplicate_groups(docs)
        if not dupes:
            print("  No duplicate transcripts found.")
            continue

        for title, group in sorted(dupes.items()):
            keeper = group[0]
            losers = group[1:]
            total_groups += 1
            total_to_trash += len(losers)
            print(f'  "{title}" — {len(group)} copies:')
            print(f"    KEEP  {keeper['id']}  ({keeper['createdTime']}, {keeper.get('size', '?')} bytes)")
            for loser in losers:
                action = "TRASHING" if live else "would trash"
                print(f"    {action}  {loser['id']}  ({loser['createdTime']}, {loser.get('size', '?')} bytes)"
                      f"  https://docs.google.com/document/d/{loser['id']}/edit")
                if live:
                    drive.files().update(fileId=loser["id"], body={"trashed": True}).execute()

    print(f"\n{total_groups} duplicate group(s), {total_to_trash} file(s) "
          f"{'trashed' if live else 'would be trashed'} across {len(folder_ids)} folder(s).")
    if not live:
        print("Re-run with --live in place of --preview to actually trash the extras "
              "(recoverable from Drive Trash for 30 days, same as deleting by hand).")


if __name__ == "__main__":
    main()
