/**
 * Phase 12 — post each scored call's AI review as a GHL Note on the matched
 * contact (Kris, 05/09/2026: "automate the fuck out of everything... as
 * well as the reviews of calls and note on leads").
 *
 * Confirmed live (05/09/2026, previewGhlNotesAndCustomFields_,
 * Phase9_GhlSync.gs) before building this: GHL's Notes endpoint is real,
 * writable-shaped, and already in genuine use by the team — a real
 * rep-written note ("Eric said they're so busy...") came back with real
 * HTML content, not an empty stub. This posts alongside that, one note per
 * scored call. Never overwrites or reads any existing note — purely
 * additive, same "never touch what a human wrote" policy as every other
 * GHL write in this codebase (syncGhlEmailAndDisposition_ only fills blank
 * cells; this only ever creates a new note).
 *
 * Deliberately NOT built here: anything using GHL custom fields (call
 * date/type/disposition as structured, filterable fields). The same probe
 * found GET /locations/{id}/customFields returns 401 ("token is not
 * authorized for this scope") — a genuine permission gap on the GHL
 * Private Integration token, not something fixable in code. Nothing here
 * actually needs that though: Outcome Disposition already comes from GHL
 * pipeline stage (ghlStageToOutcomeDisposition_, Phase9_GhlSync.gs), and
 * the qualitative call review this phase posts doesn't need a structured
 * field at all. If/when Hazel grants that scope, custom-field sync is a
 * separate, later addition — not a blocker for this one.
 *
 * Same preview-first, ENABLED-gated pattern as every other phase.
 */

var GHL_NOTE_SYNC_CONFIG = {
  ENABLED: true,

  // Kris's ask (05/09/2026): "move forward with everything and revert back
  // Monday if Tomás doesn't like it." A full GHL account backup/restore
  // isn't a real API GHL offers, so instead: cap the first live run to a
  // small batch, prove the note-sync-log + revertGhlNoteSync_ round trip
  // actually works end to end against a handful of real notes, THEN raise
  // this (or set it back to null) for the full run. null/0 = no limit.
  //
  // Set to 3 for the first live run (05/09/2026) — raise to null once
  // that batch is confirmed posted correctly in GHL and revertGhlNoteSync_
  // is confirmed to actually undo it.
  MAX_ROWS_PER_RUN: 3
};

var GHL_NOTE_SYNC_LOG_SHEET_NAME = 'GHL Note Sync Log';
var GHL_NOTE_SYNC_LOG_HEADERS = ['Timestamp', 'Row', 'Prospect Name', 'Contact ID', 'Note ID', 'Reverted'];

function getOrCreateGhlNoteSyncLogSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(GHL_NOTE_SYNC_LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(GHL_NOTE_SYNC_LOG_SHEET_NAME);
    sheet.getRange(1, 1, 1, GHL_NOTE_SYNC_LOG_HEADERS.length).setValues([GHL_NOTE_SYNC_LOG_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Durable record of exactly what runGhlNoteSync_ created — the actual
 * safety net for "revert back Monday if Tomás doesn't like it," since GHL
 * itself has no account-level backup/restore API. Without this, a targeted
 * undo would be impossible: there'd be no way to tell "a note this sync
 * created" apart from any other note on that contact. Best-effort — a
 * logging failure must not block the real GHL write that already
 * succeeded, so this is wrapped in its own try/catch (same policy as
 * logLlmCallCost_, Phase2_CallScoring.gs).
 */
function logGhlNoteSyncEntry_(row, prospectName, contactId, noteId) {
  try {
    var sheet = getOrCreateGhlNoteSyncLogSheet_();
    sheet.appendRow([new Date(), row, prospectName, contactId, noteId || '', false]);
  } catch (e) {
    log_('logGhlNoteSyncEntry_: failed to write a GHL Note Sync Log row (' + e + ') — the note was still posted; ' +
      'this row just won\'t be automatically revertable by row number, only by finding it directly in GHL.');
  }
}

// Same margin under Apps Script's 6-minute ceiling as GHL_SYNC_TIME_BUDGET_MS_
// (Phase9_GhlSync.gs) — a full-sheet scan here costs up to 1 GHL search call
// per not-yet-synced row. Safe to just re-run if this is hit: already-synced
// rows (GHL Review Synced = true) are skipped before any API call.
var GHL_NOTE_SYNC_TIME_BUDGET_MS_ = 5 * 60 * 1000;

/**
 * Pure — builds one call's review note body from already-scored row data.
 * Testable without a real sheet, GHL, or SpreadsheetApp. HTML-escapes the
 * free-text feedback summary (escapeHtml_, Phase4_InboxSLA.gs) since GHL
 * notes render as rich text, same reasoning as every other htmlBody this
 * codebase builds.
 */
function buildGhlReviewNoteBody_(rowData) {
  var scoreLabel = (rowData.callQualityScore === '' || rowData.callQualityScore === null || rowData.callQualityScore === undefined)
    ? '(not scored)' : (rowData.callQualityScore + '/5');
  var lines = [];
  lines.push('<p><strong>AI Call Review</strong> — ' + escapeHtml_(rowData.callDate || '(no date)') +
    ' — ' + escapeHtml_(rowData.callType || '(no call type)') + ' (' + escapeHtml_(rowData.rep || '(no rep)') + ')</p>');
  lines.push('<p>Lead Quality: ' + escapeHtml_(rowData.leadQualityVerdict || '(not scored)') +
    ' | Call Quality Score: ' + scoreLabel + '</p>');
  if (rowData.aiFeedbackSummary) {
    lines.push('<p>' + escapeHtml_(rowData.aiFeedbackSummary) + '</p>');
  }
  if (rowData.transcriptUrl) {
    lines.push('<p><a href="' + rowData.transcriptUrl + '">Transcript</a></p>');
  }
  return lines.join('');
}

/**
 * Scans the live Sales Call Log for scored rows (Lead Quality Verdict
 * non-blank) not yet marked "GHL Review Synced", resolves each by GHL
 * contact name (same name-similarity filter as previewGhlMatching_ —
 * contactNameLooksLikeQuery_, Phase9_GhlSync.gs), and returns what WOULD be
 * posted. Never writes. Shared by previewGhlNoteSync_ (logs it) and
 * runGhlNoteSync_ (applies it), so they can never disagree.
 *
 * maxToPlan is optional — when set, this STOPS SCANNING (not just slices
 * the result) as soon as toPost.length reaches it. Real gap found live
 * (05/09/2026): GHL_NOTE_SYNC_CONFIG.MAX_ROWS_PER_RUN used to only trim
 * the finished plan in runGhlNoteSync_, so a "3-row test batch" still ran
 * the full ~470-call, several-minutes scan first — defeating the entire
 * point of capping a first live run small. Passing the cap in here instead
 * means a capped run is actually fast and cheap, not just fewer posts at
 * the end of the same expensive work.
 */
function computeGhlReviewNoteSyncPlan_(locationId, maxToPlan) {
  var stats = { scanned: 0, notScored: 0, alreadySynced: 0, noMatch: 0, ambiguous: 0, searchFailed: 0 };
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return { toPost: [], stats: stats, truncated: false }; }

  var col = getValidatedColumnMap_(sheet);
  if (col['GHL Review Synced'] === undefined) {
    log_('Sales Call Log is missing the "GHL Review Synced" column — run migrateAddPrimaryFailureModeColumn() first.');
    return { toPost: [], stats: stats, truncated: false };
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { toPost: [], stats: stats, truncated: false };
  var rows = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  var toPost = [];
  var runStart = Date.now();
  var truncated = false;

  // Real gap found live (05/09/2026): previewGhlNoteSync_ printed one line
  // ("PREVIEW MODE...") and then went completely silent for minutes — one
  // blocking GHL search per not-yet-synced scored row, up to hundreds of
  // rows in this sheet, so a normal multi-minute run looked identical to a
  // hang (same class of bug already fixed once in computeGhlSyncFixes_,
  // Phase9_GhlSync.gs — same fix here: log the real scope up front, then a
  // heartbeat every GHL_SYNC_HEARTBEAT_INTERVAL_MS_ so there's always a
  // recent line proving it's still making progress).
  var needingScan = 0;
  for (var n = 0; n < rows.length; n++) {
    if (rows[n][col['Lead Quality Verdict'] - 1] && !isTruthyOutcome_(rows[n][col['GHL Review Synced'] - 1])) needingScan++;
  }
  log_('computeGhlReviewNoteSyncPlan_: ' + needingScan + ' of ' + rows.length + ' row(s) are scored and not yet ' +
    'synced — scanning now (1 GHL search per row, so this can take a few minutes; a heartbeat line prints every ' +
    Math.round(GHL_SYNC_HEARTBEAT_INTERVAL_MS_ / 1000) + 's while it runs).');
  var lastHeartbeatAt = runStart;
  var searchedSoFar = 0;

  for (var i = 0; i < rows.length; i++) {
    if (Date.now() - runStart > GHL_NOTE_SYNC_TIME_BUDGET_MS_) {
      truncated = true;
      log_('computeGhlReviewNoteSyncPlan_: time budget hit after ' + i + '/' + rows.length +
        ' row(s) — re-run to continue (already-synced rows are skipped automatically, so this is always safe).');
      break;
    }

    var row = rows[i];
    stats.scanned++;

    var leadQualityVerdict = row[col['Lead Quality Verdict'] - 1];
    if (!leadQualityVerdict) { stats.notScored++; continue; }
    if (isTruthyOutcome_(row[col['GHL Review Synced'] - 1])) { stats.alreadySynced++; continue; }

    if (Date.now() - lastHeartbeatAt > GHL_SYNC_HEARTBEAT_INTERVAL_MS_) {
      log_('computeGhlReviewNoteSyncPlan_: still going — ' + searchedSoFar + '/' + needingScan +
        ' row(s) searched so far, ' + toPost.length + ' note(s) planned.');
      lastHeartbeatAt = Date.now();
    }

    var prospectName = row[col['Prospect Name'] - 1];
    var search = ghlSearchContactByName_(locationId, prospectName);
    searchedSoFar++;
    if (!search.ok) { stats.searchFailed++; continue; }

    var candidates = search.contacts.filter(function (c) { return contactNameLooksLikeQuery_(c, prospectName); });
    if (!candidates.length) { stats.noMatch++; continue; }
    if (candidates.length > 1) { stats.ambiguous++; continue; }

    var noteBody = buildGhlReviewNoteBody_({
      callDate: row[col['Call Date'] - 1],
      callType: row[col['Call Type'] - 1],
      rep: row[col['Rep'] - 1],
      leadQualityVerdict: leadQualityVerdict,
      callQualityScore: row[col['Call Quality Score'] - 1],
      aiFeedbackSummary: row[col['AI Feedback Summary'] - 1],
      transcriptUrl: row[col['Transcript URL'] - 1]
    });

    toPost.push({ row: i + 2, prospectName: prospectName, contactId: candidates[0].id, noteBody: noteBody });

    if (maxToPlan && toPost.length >= maxToPlan) {
      truncated = true;
      log_('computeGhlReviewNoteSyncPlan_: reached maxToPlan (' + maxToPlan + ') after ' + (i + 1) + '/' +
        rows.length + ' row(s) — stopping the scan here rather than continuing to search rows that would ' +
        'just be discarded. Re-run (or raise GHL_NOTE_SYNC_CONFIG.MAX_ROWS_PER_RUN) to plan/post the rest.');
      break;
    }
    Utilities.sleep(200); // polite pacing between rows, matching computeGhlSyncFixes_'s own convention
  }

  return { toPost: toPost, stats: stats, truncated: truncated };
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewGhlNoteSync() {
  return previewGhlNoteSync_();
}

/** Read-only. Reports every GHL review note this sync would post. Writes nothing. */
function previewGhlNoteSync_() {
  RUN_TAG = 'previewGhlNoteSync_';
  log_('PREVIEW MODE — read-only GHL review-note sync probe. Nothing will be written or sent.');

  var locationId;
  try {
    locationId = ghlCheckSetup_();
  } catch (e) {
    log_('SETUP INCOMPLETE: ' + e);
    return;
  }

  // Passes the same MAX_ROWS_PER_RUN cap runGhlNoteSync_ will use, so the
  // preview always shows exactly what the real run would do (same
  // "preview and run can never disagree" contract computeGhlReviewNoteSyncPlan_
  // already documents) — including stopping the scan itself early when capped.
  var plan = computeGhlReviewNoteSyncPlan_(locationId, GHL_NOTE_SYNC_CONFIG.MAX_ROWS_PER_RUN);
  plan.toPost.forEach(function (p) {
    log_('Row ' + p.row + ' "' + p.prospectName + '" -> would post a review note to GHL contact ' + p.contactId + '.');
  });

  log_('');
  log_('Scanned ' + plan.stats.scanned + ' row(s): ' + plan.stats.notScored + ' not yet scored, ' +
    plan.stats.alreadySynced + ' already synced, ' + plan.stats.noMatch + ' no GHL match, ' +
    plan.stats.ambiguous + ' ambiguous, ' + plan.stats.searchFailed + ' search failed.');
  log_(plan.toPost.length + ' review note(s) would be posted.');
  if (plan.truncated) log_('PARTIAL SCAN — time budget or MAX_ROWS_PER_RUN cap hit. Re-run previewGhlNoteSync() to see the rest.');
  log_('Paste this whole log back to Claude before running the real sync.');
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function runGhlNoteSync() {
  return runGhlNoteSync_();
}

/**
 * LIVE WRITE. Gated by GHL_NOTE_SYNC_CONFIG.ENABLED — run previewGhlNoteSync()
 * first and confirm the output looks right before flipping that to true.
 * Posts exactly what computeGhlReviewNoteSyncPlan_ computed, then marks each
 * row's "GHL Review Synced" true so it's never posted twice.
 */
function runGhlNoteSync_() {
  RUN_TAG = 'runGhlNoteSync_';
  if (!GHL_NOTE_SYNC_CONFIG.ENABLED) {
    log_('GHL_NOTE_SYNC_CONFIG.ENABLED is false — run previewGhlNoteSync() first, confirm the output looks right, then flip GHL_NOTE_SYNC_CONFIG.ENABLED to true in Phase12_GhlNoteSync.gs.');
    return;
  }

  var locationId;
  try {
    locationId = ghlCheckSetup_();
  } catch (e) {
    log_('SETUP INCOMPLETE: ' + e);
    return;
  }

  var plan = computeGhlReviewNoteSyncPlan_(locationId, GHL_NOTE_SYNC_CONFIG.MAX_ROWS_PER_RUN);
  if (!plan.toPost.length) {
    log_('No review notes need posting.' + (plan.truncated ? ' PARTIAL scan — re-run to continue.' : ''));
    return;
  }

  var toPost = plan.toPost;

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  var col = getValidatedColumnMap_(sheet);

  var posted = 0;
  var postedWithoutNoteId = 0;
  toPost.forEach(function (p) {
    var res = ghlPostContactNote_(p.contactId, p.noteBody);
    if (!res.ok) {
      log_('Row ' + p.row + ' "' + p.prospectName + '": POST note FAILED, HTTP ' + res.status +
        '. Body (first 500 chars): ' + String(res.body).slice(0, 500));
      return;
    }
    sheet.getRange(p.row, col['GHL Review Synced']).setValue(true);
    logGhlNoteSyncEntry_(p.row, p.prospectName, p.contactId, res.noteId);
    posted++;
    if (!res.noteId) postedWithoutNoteId++;
    log_('Row ' + p.row + ' "' + p.prospectName + '": review note posted to GHL' +
      (res.noteId ? ' (note id ' + res.noteId + ').' : ' — note id NOT returned by GHL, this one can\'t be precisely reverted.'));
  });

  log_('runGhlNoteSync_() done — posted ' + posted + ' of ' + toPost.length + ' planned review note(s).' +
    (postedWithoutNoteId ? ' ' + postedWithoutNoteId + ' posted note(s) had no id returned by GHL — see the log lines above for which.' : '') +
    (plan.truncated ? ' PARTIAL scan (time budget or MAX_ROWS_PER_RUN cap) — re-run to continue with the remaining rows.' : ' Full sheet scanned.'));
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewRevertGhlNoteSync() {
  return previewRevertGhlNoteSync_();
}

/**
 * Read-only. Reads the GHL Note Sync Log and reports exactly what
 * revertGhlNoteSync() would undo: which notes it would delete from GHL and
 * which Sales Call Log rows would get "GHL Review Synced" unchecked.
 * Writes nothing.
 */
function previewRevertGhlNoteSync_() {
  RUN_TAG = 'previewRevertGhlNoteSync_';
  log_('PREVIEW MODE — read-only revert probe. Nothing will be deleted or unchecked.');

  var entries = readGhlNoteSyncLogEntries_();
  var pending = entries.filter(function (e) { return !e.reverted; });
  if (!pending.length) {
    log_('No un-reverted GHL Note Sync Log entries found — nothing to revert.');
    return;
  }

  var withNoteId = 0, withoutNoteId = 0;
  pending.forEach(function (e) {
    if (e.noteId) {
      withNoteId++;
      log_('Row ' + e.row + ' "' + e.prospectName + '" -> would DELETE GHL note ' + e.noteId +
        ' on contact ' + e.contactId + ', and uncheck GHL Review Synced.');
    } else {
      withoutNoteId++;
      log_('Row ' + e.row + ' "' + e.prospectName + '" -> NO note id on file for this entry, cannot delete the ' +
        'note itself — would still uncheck GHL Review Synced so it doesn\'t look falsely synced.');
    }
  });

  log_('');
  log_(pending.length + ' entry(ies) would be reverted (' + withNoteId + ' with a real delete, ' +
    withoutNoteId + ' uncheck-only). Paste this whole log back to Claude before running the real revert.');
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function revertGhlNoteSync() {
  return revertGhlNoteSync_();
}

/**
 * LIVE WRITE (in the reverse direction). For every un-reverted GHL Note
 * Sync Log entry: deletes the note from GHL (when a note id was captured),
 * unchecks that row's "GHL Review Synced" (so it's eligible to be
 * re-synced normally later if the fix goes back in), and marks the log
 * entry Reverted so a second run never double-processes it. This is the
 * whole point of logGhlNoteSyncEntry_ existing — GHL has no account-level
 * backup/restore API, so a precise per-note undo of exactly what this
 * codebase created is the real safety net instead.
 */
function revertGhlNoteSync_() {
  RUN_TAG = 'revertGhlNoteSync_';

  var entries = readGhlNoteSyncLogEntries_();
  var pending = entries.filter(function (e) { return !e.reverted; });
  if (!pending.length) {
    log_('No un-reverted GHL Note Sync Log entries found — nothing to revert.');
    return;
  }

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  var col = getValidatedColumnMap_(sheet);
  var logSheet = getOrCreateGhlNoteSyncLogSheet_();

  var deleted = 0, uncheckOnly = 0, deleteFailed = 0;
  pending.forEach(function (e) {
    if (e.noteId) {
      var res = ghlDeleteContactNote_(e.contactId, e.noteId);
      if (!res.ok) {
        deleteFailed++;
        log_('Row ' + e.row + ' "' + e.prospectName + '": DELETE note FAILED, HTTP ' + res.status +
          '. Body (first 500 chars): ' + String(res.body).slice(0, 500) + ' — leaving this entry un-reverted, re-run to retry.');
        return;
      }
      deleted++;
    } else {
      uncheckOnly++;
    }
    sheet.getRange(e.row, col['GHL Review Synced']).setValue(false);
    logSheet.getRange(e.logRow, GHL_NOTE_SYNC_LOG_HEADERS.indexOf('Reverted') + 1).setValue(true);
    log_('Row ' + e.row + ' "' + e.prospectName + '": reverted' + (e.noteId ? ' (note deleted from GHL).' : ' (uncheck-only, no note id on file).'));
  });

  log_('revertGhlNoteSync_() done — ' + deleted + ' note(s) deleted, ' + uncheckOnly + ' uncheck-only, ' +
    deleteFailed + ' delete failure(s) left for a re-run.');
}

/** Reads every row of the GHL Note Sync Log into plain objects, including its own sheet row number (for writing "Reverted" back). */
function readGhlNoteSyncLogEntries_() {
  var sheet = getOrCreateGhlNoteSyncLogSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var rows = sheet.getRange(2, 1, lastRow - 1, GHL_NOTE_SYNC_LOG_HEADERS.length).getValues();
  return rows.map(function (row, i) {
    return {
      logRow: i + 2,
      row: row[GHL_NOTE_SYNC_LOG_HEADERS.indexOf('Row')],
      prospectName: row[GHL_NOTE_SYNC_LOG_HEADERS.indexOf('Prospect Name')],
      contactId: row[GHL_NOTE_SYNC_LOG_HEADERS.indexOf('Contact ID')],
      noteId: row[GHL_NOTE_SYNC_LOG_HEADERS.indexOf('Note ID')],
      reverted: isTruthyOutcome_(row[GHL_NOTE_SYNC_LOG_HEADERS.indexOf('Reverted')])
    };
  });
}

/**
 * ONE-TIME setup, run manually — ONLY after previewGhlNoteSync() has been
 * reviewed and GHL_NOTE_SYNC_CONFIG.ENABLED has been flipped to true. Same
 * daily cadence as the other GHL syncs (installGhlSyncTrigger,
 * Phase9_GhlSync.gs) — a call review isn't time-sensitive the way a live
 * compliance nag is.
 */
function installGhlNoteSyncTrigger() {
  RUN_TAG = 'installGhlNoteSyncTrigger';
  if (!GHL_NOTE_SYNC_CONFIG.ENABLED) {
    log_('GHL_NOTE_SYNC_CONFIG.ENABLED is still false — the trigger will install, but runGhlNoteSync_ will refuse to write until that flag is flipped.');
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runGhlNoteSync_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runGhlNoteSync_').timeBased().everyHours(4).create();
  log_('Installed: runGhlNoteSync_() now runs every 4 hours.');
}
