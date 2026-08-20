/**
 * Phase0_RiversideSync.gs
 *
 * Companion to brief.txt Section E ("Riverside transcript integration —
 * deterministic keying") and Phase2_CallGradingSOP.md §1's second eligibility
 * rule. This is the piece that was never built: scoreNewlyLoggedCalls_() in
 * Phase2_CallScoring.gs reads a "Transcript URL" cell off each "Sales Call
 * Log" row, but nothing in this repo has ever written that cell for an
 * ongoing (non-legacy) call — it only exists today if someone pastes a Drive
 * link in by hand. Without this file, the "ongoing pipeline" scoreNewlyLoggedCalls_
 * describes itself as running is really "ongoing pipeline, once someone
 * manually attaches a transcript."
 *
 * Design, straight from brief.txt §E:
 *  - Riverside Business API v3. List recordings in a date window, regex-
 *    extract the Calendar Event ID that (per the brief's Phase 0 requirement)
 *    gets embedded in the recording title at booking time, then do a DIRECT
 *    row lookup by Calendar Event ID against "Sales Call Log" — no fuzzy
 *    matching, no date-window heuristics. Rows whose ID can't be found in any
 *    recording title, or whose title has no extractable ID, are left alone
 *    here (Match Method stays whatever Phase 1 already set, or blank) — they
 *    fall to the existing fallback_heuristic path (scoreLegacyTranscriptFolder)
 *    once a human points it at wherever the transcript actually landed.
 *
 * IMPORTANT — NOT YET LIVE-TESTED. This is written directly from brief.txt
 * §E's documented API contract (endpoints, field names, rate limits); this
 * repo has no working Riverside API key to verify a single field against a
 * real response. Before trusting this in production:
 *   1. Set RIVERSIDE_CONFIG.API_KEY_PROPERTY (Script Properties) to a real key.
 *   2. Run previewRiversideSync() FIRST — it only calls the read-only list
 *      endpoint, extracts/logs what it would match, and writes nothing. Use
 *      it to confirm the base URL, the response shape, and that recording
 *      titles actually carry the Calendar Event ID as expected, before
 *      syncRiversideTranscripts_() ever calls the download endpoint or
 *      writes to the sheet.
 *   3. Fill in RIVERSIDE_CONFIG.TRANSCRIPT_FOLDER_ID — a placeholder below,
 *      same pattern as tools/transcribe_joana_calls.py's JOANA_FOLDERS — so
 *      transcripts land somewhere specific instead of Drive's root.
 *
 * Prerequisite this file cannot substitute for (brief.txt §E, Phase 0):
 * whoever creates the Riverside studio/session at booking time must embed the
 * Calendar Event ID in its name, e.g. "QC-{CalendarEventID}-{RepInitials}".
 * That's a process change on the booking side, not something this script can
 * enforce — it can only detect and flag when a recording's title has no
 * extractable ID (logged loudly, never silently skipped).
 *
 * DEPRIORITIZED (20/08/2026, Kris's call): Riverside's API is Business-plan-
 * only and the account is on Pro, so this stays unused for now. Bens will
 * manually download his own transcripts instead of automating Riverside
 * sync — same "someone pastes a Drive link in by hand" fallback path this
 * file's own header describes above. Revisit this file if the plan is ever
 * upgraded.
 */

var RIVERSIDE_CONFIG = {
  API_KEY_PROPERTY: 'RIVERSIDE_API_KEY',

  // Per brief.txt §E: "Current version is v3; v1/v2 were slated for sunset
  // Feb 24, 2026." The download endpoint is documented as v1 specifically
  // (GET /api/v1/download/transcription/{file_id}) — confirm both paths are
  // still live before relying on this; the brief itself flags v1/v2 sunset
  // as a caveat to re-verify.
  LIST_URL: 'https://api.riverside.fm/v3/recordings',
  RECORDING_URL: 'https://api.riverside.fm/v3/recordings/', // + recordingId
  DOWNLOAD_URL: 'https://api.riverside.fm/v1/download/transcription/', // + fileId + ?type=txt

  // downloadRiversideTranscript_ below sends the live Bearer key to whatever
  // URL it fetches — every OTHER URL in this file is built from a hardcoded
  // host, but a recording's download_url comes straight from the API's own
  // response body. This prefix is the guard: download_url is only trusted if
  // it's actually on this host, so a bad/unexpected API response can't trick
  // this script into handing the credential to an arbitrary third party.
  ALLOWED_HOST_PREFIX: 'https://api.riverside.fm/',

  // List endpoint rate limit is ~1/sec per brief §E; this is a pause between
  // paginated list calls, not a global cap (each recording's own transcript
  // download is a distinct file_id / distinct "unique request", so the
  // brief's stricter "once per 10 min per unique request" cap on the download
  // endpoint isn't a batch-sync blocker — it only bites on a literal re-fetch
  // of the same file, which the Transcript-URL-already-set skip below never does).
  LIST_PAGE_PAUSE_MS: 1100,

  // How far back to look for recordings each run. Wider than 1 day on
  // purpose: Riverside processing can lag a day behind the actual call, and
  // re-running this only ever fills in blanks (never overwrites), so a wider
  // window costs nothing but a few extra list-API calls.
  LOOKBACK_DAYS: 3,

  // TODO: paste a real Drive folder ID before running syncRiversideTranscripts_
  // for real — same placeholder pattern as JOANA_FOLDERS in
  // tools/transcribe_joana_calls.py. previewRiversideSync() doesn't need this
  // (it writes nothing), so it's safe to run before this is filled in.
  TRANSCRIPT_FOLDER_ID: ''
};

/**
 * Extracts a Calendar Event ID from a Riverside recording title. Google
 * Calendar event IDs are themselves plain alphanumeric tokens with no
 * hyphens (see idsEqual_ in Phase1_ComplianceCheck.gs, which only strips an
 * "@google.com" suffix — never a hyphen — confirming this), so the character
 * class deliberately excludes "-" and "_": the brief's example format
 * "QC-{CalendarEventID}-{RepInitials}" hyphen-delimits the ID from its
 * prefix/suffix, and including hyphens in the match would swallow the whole
 * "QC-...-BT" string instead of isolating the ID inside it.
 */
function extractEventIdFromRecordingTitle_(title) {
  var m = String(title || '').match(/[A-Za-z0-9]{20,}(?:@google\.com)?/);
  return m ? normalizeEventId_(m[0]) : null;
}

/** Same suffix-stripping idsEqual_ in Phase1_ComplianceCheck.gs applies on the tracker side — applied here too so a row storing the bare ID still matches a title captured with the "@google.com" suffix, or vice versa. */
function normalizeEventId_(id) {
  // Trim BEFORE stripping (see idsEqual_ in Phase1_ComplianceCheck.gs for the
  // same fix and why): the end-anchored regex wouldn't match through
  // trailing whitespace left after "@google.com".
  return String(id || '').trim().replace(/@google\.com$/i, '');
}

function getRiversideKey_() {
  return getScriptSecret_(RIVERSIDE_CONFIG.API_KEY_PROPERTY);
}

/**
 * One page of GET /recordings for [startDate, endDate] (YYYY-MM-DD, per
 * brief §E). Follows pagination (default 20/page per the brief) until a page
 * comes back short of a full page. Read-only.
 */
function listRiversideRecordings_(startDate, endDate) {
  var key = getRiversideKey_();
  var all = [];
  var page = 1;

  for (;;) {
    var url = RIVERSIDE_CONFIG.LIST_URL + '?start_date=' + encodeURIComponent(startDate) +
      '&end_date=' + encodeURIComponent(endDate) + '&page=' + page;
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + key },
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      throw new Error('Riverside list HTTP ' + code + ': ' + resp.getContentText().slice(0, 500));
    }
    var body = JSON.parse(resp.getContentText());
    // Field name for the page's item array isn't pinned down by the brief
    // beyond "paginated (page, default 20/page)" — try the two shapes a
    // JSON:API-ish or plain-array response would plausibly use, and fail
    // loudly instead of silently treating an unrecognized shape as empty.
    var items = Array.isArray(body) ? body : (body.recordings || body.data || null);
    if (!items) {
      throw new Error('Unrecognized Riverside list response shape — got keys: ' + Object.keys(body || {}).join(', '));
    }
    all = all.concat(items);
    if (items.length < 20) break; // short page = last page
    page++;
    Utilities.sleep(RIVERSIDE_CONFIG.LIST_PAGE_PAUSE_MS);
  }
  return all;
}

/**
 * Fetches one recording's detail (GET /recordings/{id}) to get its
 * transcription.files[] — the list endpoint isn't documented to include
 * this, only the detail endpoint per brief §E.
 */
function getRiversideRecordingDetail_(recordingId) {
  var key = getRiversideKey_();
  var resp = UrlFetchApp.fetch(RIVERSIDE_CONFIG.RECORDING_URL + encodeURIComponent(recordingId), {
    method: 'get',
    headers: { Authorization: 'Bearer ' + key },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Riverside recording detail HTTP ' + code + ': ' + resp.getContentText().slice(0, 500));
  }
  return JSON.parse(resp.getContentText());
}

/** Picks the txt transcription file out of a recording detail's transcription.files[], if any. */
function findTxtTranscriptFile_(detail) {
  var files = detail && detail.transcription && detail.transcription.files;
  if (!files || !files.length) return null;
  for (var i = 0; i < files.length; i++) {
    if (files[i].type === 'txt') return files[i];
  }
  return null;
}

/**
 * Downloads one transcript file's text. Prefers the file object's own
 * download_url (brief §E lists this as a field on transcription.files[]
 * entries) over re-deriving /api/v1/download/transcription/{file_id}
 * ourselves — fewer assumptions about how file_id maps into that path — but
 * ONLY if it's actually on RIVERSIDE_CONFIG.ALLOWED_HOST_PREFIX. Unlike every
 * other URL this file builds (always from a hardcoded host),  download_url
 * comes straight from the third-party API's response body; fetching it
 * blindly would mean a bad or unexpected API response could redirect this
 * script's authenticated request — Bearer key included — to an arbitrary
 * host. Falls back to the safe constructed path whenever download_url is
 * missing OR fails that check, logging the mismatch rather than silently
 * either trusting or dropping it.
 */
function downloadRiversideTranscript_(file) {
  var key = getRiversideKey_();
  var fallbackUrl = RIVERSIDE_CONFIG.DOWNLOAD_URL + encodeURIComponent(file.id || file.file_id) + '?type=txt';
  var url = fallbackUrl;
  if (file.download_url) {
    if (file.download_url.indexOf(RIVERSIDE_CONFIG.ALLOWED_HOST_PREFIX) === 0) {
      url = file.download_url;
    } else {
      log_('  download_url "' + file.download_url + '" is not on the expected host (' +
        RIVERSIDE_CONFIG.ALLOWED_HOST_PREFIX + ') — ignoring it and using the constructed path instead.');
    }
  }
  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + key },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Riverside transcript download HTTP ' + code + ': ' + resp.getContentText().slice(0, 500));
  }
  return resp.getContentText();
}

/**
 * Read-only dry run: lists recent Riverside recordings, extracts a Calendar
 * Event ID from each title, and reports whether that ID matches a "Sales
 * Call Log" row that's missing a Transcript URL. Calls no download endpoint,
 * writes nothing. Run this before syncRiversideTranscripts_() to sanity-check
 * the API contract and the title convention against real data.
 */
function previewRiversideSync() {
  RUN_TAG = 'previewRiversideSync';
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var now = new Date();
  var endDate = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var startDate = Utilities.formatDate(new Date(now.getTime() - RIVERSIDE_CONFIG.LOOKBACK_DAYS * 86400000), tz, 'yyyy-MM-dd');

  var recordings;
  try {
    recordings = listRiversideRecordings_(startDate, endDate);
  } catch (e) {
    log_('FAILED to list Riverside recordings (' + startDate + ' to ' + endDate + '): ' + e);
    return;
  }
  log_('Riverside recordings ' + startDate + ' to ' + endDate + ': ' + recordings.length + ' found.');

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }
  var col = getValidatedColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  var rowsById = {};
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();
    values.forEach(function (row, i) {
      var id = normalizeEventId_(row[col['Calendar Event ID'] - 1]);
      if (id) rowsById[id] = { rowIndex: i + 2, transcriptUrl: row[col['Transcript URL'] - 1] };
    });
  }

  var matched = 0, noId = 0, idNotFound = 0, alreadyHasTranscript = 0;
  recordings.forEach(function (rec) {
    var name = rec.name || rec.title || '(untitled)';
    var eventId = extractEventIdFromRecordingTitle_(name);
    if (!eventId) {
      log_('  NO EVENT ID in recording title: "' + name + '" — booking-time convention not followed for this one.');
      noId++;
      return;
    }
    var hit = rowsById[eventId];
    if (!hit) {
      log_('  "' + name + '" → event ID ' + eventId + ' — NOT FOUND in Sales Call Log.');
      idNotFound++;
      return;
    }
    if (hit.transcriptUrl) {
      alreadyHasTranscript++;
      return;
    }
    log_('  "' + name + '" → event ID ' + eventId + ' → row ' + hit.rowIndex + ' (would sync)');
    matched++;
  });
  log_('previewRiversideSync summary: ' + matched + ' would sync, ' + alreadyHasTranscript +
    ' already have a Transcript URL, ' + idNotFound + ' event ID not found in the sheet, ' +
    noId + ' recording(s) with no extractable event ID.');
}

/**
 * Live sync: same matching as previewRiversideSync(), but downloads each new
 * match's transcript, saves it as a Doc in RIVERSIDE_CONFIG.TRANSCRIPT_FOLDER_ID,
 * and writes Riverside Recording ID / Transcript URL / Match Method = exact_key
 * onto the matched row. Never overwrites a row that already has a Transcript
 * URL (idempotent — safe to run repeatedly / on a schedule once confidence is
 * established). One recording's failure is logged and skipped, never fatal
 * to the run, same isolation pattern as scoreSeanTranscripts().
 */
function syncRiversideTranscripts_() {
  RUN_TAG = 'syncRiversideTranscripts_';
  if (!RIVERSIDE_CONFIG.TRANSCRIPT_FOLDER_ID) {
    log_('RIVERSIDE_CONFIG.TRANSCRIPT_FOLDER_ID is blank — fill in a Drive folder ID before running this for real.');
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('syncRiversideTranscripts_: another scoring/sync run holds the lock, skipping this firing.');
    return;
  }

  try {
    var tz = CONFIG.BUSINESS_TIMEZONE;
    var now = new Date();
    var endDate = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    var startDate = Utilities.formatDate(new Date(now.getTime() - RIVERSIDE_CONFIG.LOOKBACK_DAYS * 86400000), tz, 'yyyy-MM-dd');

    var recordings;
    try {
      recordings = listRiversideRecordings_(startDate, endDate);
    } catch (e) {
      log_('FAILED to list Riverside recordings (' + startDate + ' to ' + endDate + '): ' + e);
      return;
    }

    var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
    var sheet = resolveSheet_(ss, 'Sales Call Log');
    if (!sheet) { log_('No Sales Call Log tab found.'); return; }
    var col = getValidatedColumnMap_(sheet);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) { log_('No data rows.'); return; }
    var values = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();
    var rowsById = {};
    values.forEach(function (row, i) {
      var id = normalizeEventId_(row[col['Calendar Event ID'] - 1]);
      if (id && !row[col['Transcript URL'] - 1]) rowsById[id] = i + 2; // rowIndex, only if not already filled
    });

    var folder = DriveApp.getFolderById(RIVERSIDE_CONFIG.TRANSCRIPT_FOLDER_ID);
    var synced = 0, noId = 0, idNotFound = 0, noTxtFile = 0, failed = 0;

    recordings.forEach(function (rec) {
      var name = rec.name || rec.title || '(untitled)';
      var eventId = extractEventIdFromRecordingTitle_(name);
      if (!eventId) { noId++; return; }
      var rowIndex = rowsById[eventId];
      if (!rowIndex) { idNotFound++; return; }
      // Claim it immediately: two recordings resolving to the same event ID
      // in this same batch (e.g. a dropped call re-recorded) must not both
      // write the row — the second would silently overwrite the first sync's
      // Transcript URL and orphan its Doc, breaking the never-overwrite guarantee.
      delete rowsById[eventId];

      try {
        var recordingId = rec.recording_id || rec.id;
        var detail = getRiversideRecordingDetail_(recordingId);
        var txtFile = findTxtTranscriptFile_(detail);
        if (!txtFile) {
          log_('  "' + name + '" (row ' + rowIndex + '): no txt transcription file yet — will retry next run.');
          noTxtFile++;
          return;
        }
        var text = downloadRiversideTranscript_(txtFile);
        var doc = DocumentApp.create(name + ' — Transcript');
        doc.getBody().setText(text);
        doc.saveAndClose();
        var file = DriveApp.getFileById(doc.getId());
        folder.addFile(file);
        DriveApp.getRootFolder().removeFile(file); // DocumentApp.create() always lands in root first

        sheet.getRange(rowIndex, col['Riverside Recording ID']).setValue(String(recordingId));
        sheet.getRange(rowIndex, col['Transcript URL']).setValue(file.getUrl());
        sheet.getRange(rowIndex, col['Match Method']).setValue('exact_key');
        log_('  Synced "' + name + '" → row ' + rowIndex + ': ' + file.getUrl());
        synced++;
        Utilities.sleep(300);
      } catch (e) {
        log_('  FAILED "' + name + '" (row ' + rowIndex + '): ' + e);
        failed++;
      }
    });

    log_('syncRiversideTranscripts_ done — synced ' + synced + ', no txt file yet ' + noTxtFile +
      ', failed ' + failed + ', event ID not found ' + idNotFound + ', no event ID in title ' + noId + '.');
  } finally {
    lock.releaseLock();
  }
}

/**
 * ONE-TIME setup, run manually — ONLY after previewRiversideSync() has been
 * run against a real API key and confirmed the contract holds (list response
 * shape, recording titles actually carrying the Calendar Event ID, a real
 * txt transcription file appearing on a real recording detail response).
 * Uses the same idempotent reinstallHourlyTrigger_ helper as the Phase 2
 * scoring triggers (Phase2_CallScoring.gs) — safe to re-run.
 *
 * Deliberately NOT added to SELF_HEAL_TRIGGER_REGISTRY_ (Phase1_ComplianceCheck.gs):
 * that registry's weekly audit recreates any trigger it doesn't find, which
 * is correct for triggers that are SUPPOSED to always exist — but this one
 * hasn't been confirmed to work at all yet. Adding it there before a human
 * has run this installer once would make the weekly self-heal auto-turn-on
 * an unverified live sync against a real Riverside API key, silently. Add it
 * to the registry only after this has been run manually and confirmed once.
 */
function installRiversideSyncTrigger() {
  RUN_TAG = 'installRiversideSyncTrigger';
  reinstallHourlyTrigger_('syncRiversideTranscripts_', 4);
  log_('Riverside sync installed: syncRiversideTranscripts_() now runs every 4 hours. ' +
    'Confirm previewRiversideSync() looked correct against real data before relying on this.');
}
