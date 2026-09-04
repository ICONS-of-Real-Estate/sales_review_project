/**
 * Phase 11 — Bens Podcast Tracker -> Sales Call Log sync.
 *
 * Background: CONFIG.REPS's Bens entry (Phase1_ComplianceCheck.gs) has always
 * pointed sheetName at "Sales Call Log", but his real system of record is a
 * separate tab in the same spreadsheet — "Icons Podcast Recordings" (see
 * CLAUDE.md "Who does what — never guess this again", which named it "Icons
 * 100 Series Podcast Tracker"; that name is stale/wrong — confirmed live
 * 04/09/2026 by downloading the actual spreadsheet and listing its real tab
 * names: no tab named "Icons 100 Series Podcast Tracker" exists, but "Icons
 * Podcast Recordings" has the exact column layout CLAUDE.md described, so
 * it's the same tab under its real name. CLAUDE.md corrected in the same
 * commit.). Nothing ever copied his tracker rows into "Sales Call Log", so
 * the daily compliance check found nothing there for him and nagged him
 * about calls that were never going to appear in the tab it was actually
 * reading.
 *
 * Confirmed with Tomas (doc comments + email reply on the proposal doc,
 * 04/09/2026) before building this:
 *   - Create a row once "Recording Done" is checked in his tracker (Q4).
 *   - Call Type for a synced row must be literally "Icons 100 Recording",
 *     not a generic "Podcast" value (Q3).
 *   - Bens's tracker should only track what HE is in control of — Recording
 *     Booked, Recording Done, Strategy Call Booked, Strategy Call Taken.
 *     Outcome (Sold/Not Sold/Follow-up/No-show) is "up to the closer," not
 *     him — so a synced row marks Outcome Logged true (his own step is done)
 *     but leaves Outcome Disposition blank rather than guessing a mapping he
 *     was never asked to produce (his email reply, same thread).
 *   - Q6 ("should the compliance nag still apply to podcast recordings?")
 *     was a terse "Yes" — read together with the email above, that means
 *     "yes, still chase him for his own steps," not "yes, still ask him for
 *     an outcome disposition." Outcome Logged=true (see above) satisfies the
 *     compliance check's "logged" test (Phase1_ComplianceCheck.gs's
 *     `logged` check accepts EITHER Outcome Logged truthy OR Outcome
 *     Disposition non-blank) without inventing a disposition.
 *   - Historical backfill scope (Q5) was left non-committal ("not sure...")
 *     — this sync only looks at CURRENT tracker rows going forward; no
 *     separate one-time backfill mode is built here. If Kris wants the
 *     pre-existing tracker rows synced too, this same function already
 *     covers them (it scans the whole tracker every run) — nothing extra to
 *     build, just run it.
 *
 * Deliberately NOT built here:
 *   - Scoring/rubric wiring for these rows. scoreNewlyLoggedCalls_
 *     (Phase2_CallScoring.gs) only scores rows with Match Method exact_key,
 *     which requires a real Calendar Event ID — this sync never sets one, so
 *     synced rows are inert until Phase 1's own event-matching pipeline
 *     (matchEventsForRep_/findMatch_) independently backfills that, exactly
 *     like every other rep's rows. Nothing to change here.
 *   - CONFIG.REPS's Bens `columns` fallback list, which is a SEPARATE bug
 *     (still references his tracker's headers even though sheetName points
 *     at "Sales Call Log") — fixed alongside this file, see the diff to
 *     Phase1_ComplianceCheck.gs in the same commit.
 */

var BENS_PODCAST_SYNC_CONFIG = {
  ENABLED: false,
  TRACKER_SHEET_NAME: 'Icons Podcast Recordings',
  CALL_TYPE: 'Icons 100 Recording',
  REP_NAME: 'Bens'
};

var BENS_PODCAST_TRACKER_HEADERS = [
  'Name', 'Email', 'Source', 'Booked', 'Booking Date', 'Recording Date',
  'Recording Done', 'QC Booked', 'QC Date', 'QC Show Up', 'SC Booked',
  'SC Date', 'SC Show Up', 'Sale', 'Comments'
];

/**
 * Trims both sides before comparing — unlike getValidatedColumnMap_'s exact
 * match on "Sales Call Log" (a sheet this codebase itself writes the header
 * row for), this tab's real header row has a stray trailing space on "SC
 * Booked " (confirmed live 04/09/2026), and there's no reason to make Bens
 * fix a whitespace typo in a column this sync doesn't even read for its own
 * logic. Trim, don't ignore: still throws loudly on an actual column being
 * renamed/removed/reordered, same safety net as getValidatedColumnMap_.
 */
function getValidatedBensTrackerColumnMap_(sheet) {
  var header = sheet.getRange(1, 1, 1, BENS_PODCAST_TRACKER_HEADERS.length).getValues()[0];
  var mismatches = [];
  BENS_PODCAST_TRACKER_HEADERS.forEach(function (expected, i) {
    if (String(header[i] || '').trim() !== expected) {
      mismatches.push('column ' + (i + 1) + ': expected "' + expected + '", found "' + header[i] + '"');
    }
  });
  if (mismatches.length) {
    throw new Error('"' + BENS_PODCAST_SYNC_CONFIG.TRACKER_SHEET_NAME + '" header drift detected:\n  ' +
      mismatches.join('\n  '));
  }
  var col = {};
  BENS_PODCAST_TRACKER_HEADERS.forEach(function (h, i) { col[h] = i + 1; });
  return col;
}

/**
 * True if a "Sales Call Log" row already represents this tracker row, so the
 * sync doesn't append a duplicate every time it runs. Matches on Rep +
 * Call Type + normalized prospect name only (no stable join key exists
 * between the two tabs) — same normalize_ helper the compliance check and
 * GHL hygiene check both already rely on for name matching.
 */
function bensPodcastRowAlreadySynced_(prospectName, existingLogRows, logCol) {
  var target = normalize_(prospectName);
  for (var i = 0; i < existingLogRows.length; i++) {
    var row = existingLogRows[i];
    if (String(row[logCol['Rep'] - 1] || '').trim() !== BENS_PODCAST_SYNC_CONFIG.REP_NAME) continue;
    if (String(row[logCol['Call Type'] - 1] || '').trim() !== BENS_PODCAST_SYNC_CONFIG.CALL_TYPE) continue;
    if (normalize_(row[logCol['Prospect Name'] - 1]) === target) return true;
  }
  return false;
}

/**
 * Reads the podcast tracker and the current "Sales Call Log" and computes
 * which tracker rows need a new Sales Call Log row created. Pure/no writes —
 * shared by the preview and the live sync so they can never disagree.
 */
function computeBensPodcastSyncPlan_(trackerRows, trackerCol, existingLogRows, logCol) {
  var toCreate = [];
  var stats = { scanned: trackerRows.length, notRecordingDone: 0, alreadySynced: 0, missingName: 0 };

  trackerRows.forEach(function (row, i) {
    var name = String(row[trackerCol['Name'] - 1] || '').trim();
    if (!isTruthyOutcome_(row[trackerCol['Recording Done'] - 1])) {
      stats.notRecordingDone++;
      return;
    }
    if (!name) {
      stats.missingName++;
      return;
    }
    if (bensPodcastRowAlreadySynced_(name, existingLogRows, logCol)) {
      stats.alreadySynced++;
      return;
    }

    var recordingDate = row[trackerCol['Recording Date'] - 1];
    var callDate = recordingDate || row[trackerCol['Booking Date'] - 1] || '';

    toCreate.push({
      trackerRow: i + 2,
      prospectName: name,
      prospectEmail: String(row[trackerCol['Email'] - 1] || '').trim(),
      source: String(row[trackerCol['Source'] - 1] || '').trim(),
      callDate: callDate
    });
  });

  return { toCreate: toCreate, stats: stats };
}

/**
 * Log-display only — never touches what actually gets written to the
 * sheet. A raw Date's default toString() (what plain string concatenation
 * produces) renders in the Apps Script PROJECT's own default timezone, not
 * CONFIG.BUSINESS_TIMEZONE (confirmed live 04/09/2026: preview output read
 * "GMT+0700 (Indochina Time)" for a US business) — same class of
 * timezone-mismatch bug this codebase has hit before (see formatDateCell_'s
 * own header comment, Phase1_ComplianceCheck.gs). Reformats to the
 * business timezone in the same dd/MM/yyyy convention every other preview
 * log line in this codebase uses, purely so a human reviewing the preview
 * output isn't misled about what date is actually being synced.
 */
function formatBensSyncDateForLog_(v) {
  if (v instanceof Date && !isNaN(v)) {
    return Utilities.formatDate(v, CONFIG.BUSINESS_TIMEZONE, 'dd/MM/yyyy');
  }
  return String(v || '(blank)');
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewBensPodcastSync() {
  return previewBensPodcastSync_();
}

/** Read-only. Reports every "Sales Call Log" row this sync would create. Writes nothing. */
function previewBensPodcastSync_() {
  RUN_TAG = 'previewBensPodcastSync_';
  log_('PREVIEW MODE — read-only Bens podcast tracker sync probe. Nothing will be written.');

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var trackerSheet = ss.getSheetByName(BENS_PODCAST_SYNC_CONFIG.TRACKER_SHEET_NAME);
  if (!trackerSheet) { log_('No "' + BENS_PODCAST_SYNC_CONFIG.TRACKER_SHEET_NAME + '" tab found.'); return; }
  var logSheet = resolveSheet_(ss, 'Sales Call Log');
  if (!logSheet) { log_('No "Sales Call Log" tab found.'); return; }

  var trackerCol = getValidatedBensTrackerColumnMap_(trackerSheet);
  var trackerLastRow = trackerSheet.getLastRow();
  var trackerRows = trackerLastRow < 2 ? [] :
    trackerSheet.getRange(2, 1, trackerLastRow - 1, BENS_PODCAST_TRACKER_HEADERS.length).getValues();

  var logCol = getValidatedColumnMap_(logSheet);
  var logLastRow = logSheet.getLastRow();
  var existingLogRows = logLastRow < 2 ? [] :
    logSheet.getRange(2, 1, logLastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  var plan = computeBensPodcastSyncPlan_(trackerRows, trackerCol, existingLogRows, logCol);

  plan.toCreate.forEach(function (fix) {
    log_('Tracker row ' + fix.trackerRow + ' "' + fix.prospectName + '" -> new Sales Call Log row ' +
      '(Call Type "' + BENS_PODCAST_SYNC_CONFIG.CALL_TYPE + '", Call Date ' + formatBensSyncDateForLog_(fix.callDate) + ').');
  });

  log_('');
  log_('Scanned ' + plan.stats.scanned + ' tracker row(s): ' + plan.stats.notRecordingDone +
    ' not yet Recording Done, ' + plan.stats.alreadySynced + ' already synced, ' +
    plan.stats.missingName + ' missing a name.');
  log_(plan.toCreate.length + ' row(s) would be created in "Sales Call Log".');
  log_('Paste this whole log back to Claude before running the real sync.');
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function runBensPodcastSync() {
  return runBensPodcastSync_();
}

/**
 * LIVE WRITE. Gated by BENS_PODCAST_SYNC_CONFIG.ENABLED — run
 * previewBensPodcastSync() first and confirm the output looks right before
 * flipping that to true. Appends one new "Sales Call Log" row per tracker
 * row computeBensPodcastSyncPlan_ found; never edits an existing row.
 */
function runBensPodcastSync_() {
  RUN_TAG = 'runBensPodcastSync_';
  if (!BENS_PODCAST_SYNC_CONFIG.ENABLED) {
    log_('BENS_PODCAST_SYNC_CONFIG.ENABLED is false — run previewBensPodcastSync() first, confirm the output looks right, then flip BENS_PODCAST_SYNC_CONFIG.ENABLED to true in Phase11_BensPodcastSync.gs.');
    return;
  }

  // Shares the script lock other Sales Call Log writers use so this can
  // never race scoreNewlyLoggedCalls_/scoreSeanTranscripts/syncGhlEmailAndDisposition_
  // appending or editing rows at the same moment.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runBensPodcastSync_: another run holds the lock, skipping this firing.');
    return;
  }

  try {
    var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
    var trackerSheet = ss.getSheetByName(BENS_PODCAST_SYNC_CONFIG.TRACKER_SHEET_NAME);
    if (!trackerSheet) { log_('No "' + BENS_PODCAST_SYNC_CONFIG.TRACKER_SHEET_NAME + '" tab found.'); return; }
    var logSheet = resolveSheet_(ss, 'Sales Call Log');
    if (!logSheet) { log_('No "Sales Call Log" tab found.'); return; }

    var trackerCol = getValidatedBensTrackerColumnMap_(trackerSheet);
    var trackerLastRow = trackerSheet.getLastRow();
    var trackerRows = trackerLastRow < 2 ? [] :
      trackerSheet.getRange(2, 1, trackerLastRow - 1, BENS_PODCAST_TRACKER_HEADERS.length).getValues();

    var logCol = getValidatedColumnMap_(logSheet);
    var logLastRow = logSheet.getLastRow();
    var existingLogRows = logLastRow < 2 ? [] :
      logSheet.getRange(2, 1, logLastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

    var plan = computeBensPodcastSyncPlan_(trackerRows, trackerCol, existingLogRows, logCol);
    if (!plan.toCreate.length) {
      log_('No tracker rows need syncing.');
      return;
    }

    plan.toCreate.forEach(function (fix) {
      logSheet.appendRow([
        fix.prospectName,                        // Prospect Name
        fix.prospectEmail,                        // Prospect Email
        fix.source,                               // Source
        fix.callDate,                             // Call Date
        BENS_PODCAST_SYNC_CONFIG.REP_NAME,        // Rep
        BENS_PODCAST_SYNC_CONFIG.CALL_TYPE,       // Call Type
        true,                                      // Outcome Logged — his own step (recording done) is complete
        '',                                        // Outcome Disposition — not his to set, see file header comment
        '',                                        // Calendar Event ID — left for Phase 1's own event matching
        '', '', '',                                // Riverside Recording ID / Transcript URL / Match Method
        '', '', '', '', '', '', '', '', ''          // Lead Quality Verdict .. Primary Failure Mode (Phase 2/5 columns)
      ]);
      log_('Tracker row ' + fix.trackerRow + ' "' + fix.prospectName + '" -> created in "Sales Call Log".');
    });

    log_('runBensPodcastSync_() done — created ' + plan.toCreate.length + ' row(s) in "Sales Call Log".');
  } finally {
    lock.releaseLock();
  }
}

/**
 * ONE-TIME setup, run manually — ONLY after previewBensPodcastSync() has
 * been reviewed and BENS_PODCAST_SYNC_CONFIG.ENABLED has been flipped to
 * true. Idempotent: safe to re-run, replaces any existing trigger for this
 * handler rather than stacking duplicates. Same daily cadence as the GHL
 * sync (installGhlSyncTrigger, Phase9_GhlSync.gs) — Bens's tracker doesn't
 * need sub-day latency either.
 */
function installBensPodcastSyncTrigger() {
  RUN_TAG = 'installBensPodcastSyncTrigger';
  if (!BENS_PODCAST_SYNC_CONFIG.ENABLED) {
    log_('BENS_PODCAST_SYNC_CONFIG.ENABLED is still false — the trigger will install, but runBensPodcastSync_ will refuse to write until that flag is flipped.');
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runBensPodcastSync_') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('runBensPodcastSync_')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .inTimezone(CONFIG.BUSINESS_TIMEZONE)
    .create();
  log_('Installed: runBensPodcastSync_() now runs daily at 7am ' + CONFIG.BUSINESS_TIMEZONE +
    ' (ahead of the 18:00 daily compliance check, so a same-day recording has a chance to show up in "Sales Call Log" before it\'s flagged).');
}
