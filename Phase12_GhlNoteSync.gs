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
  ENABLED: false
};

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
 */
function computeGhlReviewNoteSyncPlan_(locationId) {
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

  for (var i = 0; i < rows.length; i++) {
    if (Date.now() - runStart > GHL_NOTE_SYNC_TIME_BUDGET_MS_) { truncated = true; break; }

    var row = rows[i];
    stats.scanned++;

    var leadQualityVerdict = row[col['Lead Quality Verdict'] - 1];
    if (!leadQualityVerdict) { stats.notScored++; continue; }
    if (isTruthyOutcome_(row[col['GHL Review Synced'] - 1])) { stats.alreadySynced++; continue; }

    var prospectName = row[col['Prospect Name'] - 1];
    var search = ghlSearchContactByName_(locationId, prospectName);
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

  var plan = computeGhlReviewNoteSyncPlan_(locationId);
  plan.toPost.forEach(function (p) {
    log_('Row ' + p.row + ' "' + p.prospectName + '" -> would post a review note to GHL contact ' + p.contactId + '.');
  });

  log_('');
  log_('Scanned ' + plan.stats.scanned + ' row(s): ' + plan.stats.notScored + ' not yet scored, ' +
    plan.stats.alreadySynced + ' already synced, ' + plan.stats.noMatch + ' no GHL match, ' +
    plan.stats.ambiguous + ' ambiguous, ' + plan.stats.searchFailed + ' search failed.');
  log_(plan.toPost.length + ' review note(s) would be posted.');
  if (plan.truncated) log_('PARTIAL SCAN — time budget hit. Re-run previewGhlNoteSync() to see the rest.');
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

  var plan = computeGhlReviewNoteSyncPlan_(locationId);
  if (!plan.toPost.length) {
    log_('No review notes need posting.' + (plan.truncated ? ' PARTIAL scan — re-run to continue.' : ''));
    return;
  }

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  var col = getValidatedColumnMap_(sheet);

  var posted = 0;
  plan.toPost.forEach(function (p) {
    var res = ghlPostContactNote_(p.contactId, p.noteBody);
    if (!res.ok) {
      log_('Row ' + p.row + ' "' + p.prospectName + '": POST note FAILED, HTTP ' + res.status +
        '. Body (first 500 chars): ' + String(res.body).slice(0, 500));
      return;
    }
    sheet.getRange(p.row, col['GHL Review Synced']).setValue(true);
    posted++;
    log_('Row ' + p.row + ' "' + p.prospectName + '": review note posted to GHL.');
  });

  log_('runGhlNoteSync_() done — posted ' + posted + ' of ' + plan.toPost.length + ' planned review note(s).' +
    (plan.truncated ? ' PARTIAL scan — re-run to continue with the remaining rows.' : ' Full sheet scanned.'));
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
