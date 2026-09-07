/**
 * Phase18_PitchGuideReview.gs
 *
 * Kris's ask (07/09/2026), confirming the cycle explicitly: "YES we are
 * about to do the first pitch guide training today. I will send you the
 * recording so you can suggest updates to the SOP. Then moving forward once
 * per month, you send suggestions to the SOP based on all the sales calls.
 * Tomas will approve or not. And then do another training with the team and
 * send you the recordings."
 *
 * Modeled directly on PLAYBOOK_REVIEW_CONFIG (Phase1_ComplianceCheck.gs) —
 * same "AI drafts suggestions from real material, a human approves or
 * rejects, only approved changes ever land" shape, but for the Pitch Guide
 * (the sales script/deck doc) instead of Joana's objection-handling
 * playbook, and driven by Tomás's own recorded training walkthroughs instead
 * of flagged calls.
 *
 * WORKFLOW (monthly cycle):
 *   1. Tomás records a training walkthrough of the Pitch Guide (with a rep,
 *      or the team) and drops the raw video/audio into:
 *        Pitch Guide Training Recordings: https://drive.google.com/drive/folders/1Wu4-iuNExsNtIHcRiBTHIMLgKd8YbOlW
 *      Nothing else to do — same "just drop the file, no sheet, no filename
 *      convention" pattern as Phase16_CalibrationFeedback.gs.
 *   2. tools/transcribe_pitch_guide_training.py (run unattended on the OVH
 *      VPS via tools/transcribe_all.py, same free local-Whisper setup as
 *      every other transcription batch) drops a "<video name> — Transcript"
 *      Doc next to the video.
 *   3. This phase's monthly trigger finds a video+transcript pair it hasn't
 *      reviewed yet, reads the CURRENT live Pitch Guide doc
 *      (PITCH_GUIDE_REVIEW_CONFIG.PITCH_GUIDE_DOC_ID), asks the judge model
 *      to compare what Tomás actually said against what the doc currently
 *      says, and produces concrete, quote-grounded suggested edits — never
 *      generic sales advice untethered from the actual transcript (see
 *      buildPitchGuideReviewJudgeSystemPrompt_'s own instructions on this).
 *   4. Every suggestion gets a row in the "Pitch Guide SOP Suggestions" tab
 *      (blank "Tomás Verdict" column — Yes/No, same convention as "Kris
 *      Manual Review Verdict" on the Sales Call Log) plus one summary email
 *      to Tomás (cc Kris) linking the sheet and the training recording.
 *      Tomás fills in Yes/No per row; applying approved edits to the actual
 *      Pitch Guide doc is a manual step for Tomás/Kris for now — rewriting a
 *      formatted slide-script doc programmatically is a real risk of
 *      corrupting it, and Tomás wanted final say over the SOP anyway ("Tomas
 *      will approve or not").
 *   5. A "<video name> — Reviewed" marker Doc gets dropped in the same
 *      folder once suggestions are generated, so a re-run never double-
 *      processes the same training (same pattern as Phase16's "Feedback
 *      Sent" marker).
 *
 * ONE-TIME SETUP:
 *   1. Share the live Pitch Guide doc
 *      (https://docs.google.com/document/d/1esEHIkR_GrCxYyGYoSmkjXv0cblR99KCWD1PlVtBr8U/edit,
 *      owned by tomas@iconsofrealestate.com) with whichever account runs
 *      this Apps Script project, at least as a Viewer — without this,
 *      DocumentApp.openById on PITCH_GUIDE_DOC_ID throws and the whole run
 *      fails loud (see fetchPitchGuideDocText_'s own comment).
 *   2. Make sure tools/transcribe_pitch_guide_training.py has run at least
 *      once against a real training video.
 *   3. Run previewPitchGuideReview() from the editor — logs what it would
 *      write/send, writes/sends nothing.
 *   4. Flip PITCH_GUIDE_REVIEW_CONFIG.ENABLED to true, run
 *      installAllReadyTriggers() (Phase1_ComplianceCheck.gs) — this phase
 *      shares Phase 17/19's consolidated every-2-hour trigger
 *      (runPhase17To19StandingChecks_, Phase17_SeanFollowUpAutomation.gs),
 *      not a standalone trigger of its own (trigger-cap consolidation,
 *      07/09/2026 — see that function's own header).
 */

var PITCH_GUIDE_REVIEW_CONFIG = {
  ENABLED: false, // flip true after previewPitchGuideReview() looks right
  FOLDER_ID: '1Wu4-iuNExsNtIHcRiBTHIMLgKd8YbOlW',
  PITCH_GUIDE_DOC_ID: '1esEHIkR_GrCxYyGYoSmkjXv0cblR99KCWD1PlVtBr8U',
  TRIGGER_DAY_OF_MONTH: 1, // "once per month" per Kris's ask — first of the month
  TRIGGER_HOUR: 9
};

var PITCH_GUIDE_SUGGESTIONS_SHEET_NAME = 'Pitch Guide SOP Suggestions';
var PITCH_GUIDE_SUGGESTIONS_HEADERS = [
  'Training Video', 'Date Reviewed', 'Suggestion #', 'Gap / Change',
  'Transcript Quote', 'Suggested Edit', 'Confidence',
  'Tomás Verdict', // dropdown: Yes/No, blank = not yet judged — same convention as "Kris Manual Review Verdict"
  'Applied' // checkbox — ticked by hand once an approved edit is actually made in the Pitch Guide doc
];

/** Marker name convention — same pair as Phase16_CalibrationFeedback.gs's own. */
function pitchGuideTranscriptName_(videoName) {
  return videoName.trim() + ' — Transcript';
}
function pitchGuideReviewedMarkerName_(videoName) {
  return videoName.trim() + ' — Reviewed';
}

/** Every video file directly in the training folder — flat, no subfolder recursion (Tomás drops files straight in). */
function collectPitchGuideTrainingVideos_(folder) {
  var out = [];
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if (file.getMimeType && String(file.getMimeType()).indexOf('video/') === 0) out.push(file);
  }
  return out;
}

function findPitchGuideTranscript_(folder, videoFile) {
  var it = folder.getFilesByName(pitchGuideTranscriptName_(videoFile.getName()));
  return it.hasNext() ? it.next() : null;
}

function pitchGuideTrainingAlreadyReviewed_(folder, videoFile) {
  return folder.getFilesByName(pitchGuideReviewedMarkerName_(videoFile.getName())).hasNext();
}

/**
 * Live text of the current Pitch Guide doc. Throws loudly (with a clear
 * "share the doc" message) rather than silently treating a permission error
 * as "no current doc" — this whole phase's entire value is comparing against
 * the REAL current doc, so running against nothing would produce suggestions
 * that duplicate content already there.
 */
function fetchPitchGuideDocText_() {
  try {
    return DocumentApp.openById(PITCH_GUIDE_REVIEW_CONFIG.PITCH_GUIDE_DOC_ID).getBody().getText();
  } catch (e) {
    throw new Error('Could not open the Pitch Guide doc (' + PITCH_GUIDE_REVIEW_CONFIG.PITCH_GUIDE_DOC_ID + '): ' + e +
      '. Make sure it is shared with whichever account runs this Apps Script project — see this file\'s ' +
      'ONE-TIME SETUP step 1.');
  }
}

/**
 * Every suggestion must trace to something actually said on the call —
 * exactly the discipline that made the first (manual) run of this pipeline
 * useful rather than generic. Mirrors that same instruction set back into
 * the judge prompt so future automated runs hold the same bar.
 */
function buildPitchGuideReviewJudgeSystemPrompt_() {
  return [
    'You are comparing a real sales-training call transcript (Tomás, the sales manager, walking a rep through the ' +
      'company\'s sales process) against the company\'s CURRENT live "Pitch Guide" document, to produce concrete ' +
      'suggested updates to that document.',
    '',
    'Identify:',
    '  1. Real, concrete gaps: things described as important/standard practice on the call that are NOT written ' +
      'anywhere in the current Pitch Guide (new sequencing steps, framing techniques, specific phrases/scripts, ' +
      'objection-handling techniques, discovery structure, etc.).',
    '  2. Real contradictions: places where what is said on the call conflicts with or supersedes the current doc.',
    '  3. Outdated content: anything the speaker explicitly says needs updating (quote it directly).',
    '',
    'Do NOT invent generic sales advice that is not grounded in something actually said on this specific call. ' +
      'EVERY suggestion must include a real quote from the transcript as its source — no quote, no suggestion.',
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text, in this exact shape:',
    '',
    '{',
    '  "suggestions": [',
    '    {',
    '      "gap": "string — what the doc currently says or lacks, one or two sentences",',
    '      "quote": "string — the actual transcript quote this is grounded in",',
    '      "suggestedEdit": "string — the concrete edit to make to the doc",',
    '      "confidence": "High | Medium | Low"',
    '    }',
    '  ],',
    '  "outdatedFlags": [',
    '    { "quote": "string — verbatim quote where the speaker says something in the doc needs updating" }',
    '  ]',
    '}'
  ].join('\n');
}

function buildPitchGuideReviewJudgeUserPrompt_(videoTitle, transcriptText, pitchGuideText) {
  return [
    'Training recording: ' + videoTitle,
    '',
    '=== CURRENT PITCH GUIDE DOC ===',
    pitchGuideText,
    '',
    '=== TRAINING CALL TRANSCRIPT ===',
    transcriptText
  ].join('\n');
}

function isValidPitchGuideReviewSchema_(obj) {
  return !!(obj &&
    Array.isArray(obj.suggestions) &&
    obj.suggestions.every(function (s) {
      return s && typeof s.gap === 'string' && typeof s.quote === 'string' &&
        typeof s.suggestedEdit === 'string' &&
        ['High', 'Medium', 'Low'].indexOf(s.confidence) !== -1;
    }) &&
    Array.isArray(obj.outdatedFlags) &&
    obj.outdatedFlags.every(function (f) { return f && typeof f.quote === 'string'; }));
}

/**
 * Same "never block on a parse failure, fall back to something safe" shape
 * as gradeCalibrationFeedbackTranscript_ (Phase16_CalibrationFeedback.gs) —
 * one retry with an explicit "raw JSON only" reminder, then an empty result
 * rather than a thrown error, so one bad model response doesn't stop the
 * whole monthly run from marking the video reviewed and moving on.
 */
function gradePitchGuideTraining_(videoTitle, transcriptText, pitchGuideText) {
  var systemPrompt = buildPitchGuideReviewJudgeSystemPrompt_();

  for (var attempt = 0; attempt <= (PHASE2_CONFIG.MAX_PARSE_RETRIES || 1); attempt++) {
    var userPrompt = buildPitchGuideReviewJudgeUserPrompt_(videoTitle, transcriptText, pitchGuideText);
    if (attempt > 0) {
      userPrompt += '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    }
    try {
      var raw = callKimiJudge_(systemPrompt, userPrompt, 'phase18:pitch_guide_review');
      var parsed = stripFencesAndParseJson_(raw);
      if (!isValidPitchGuideReviewSchema_(parsed)) throw new Error('Parsed JSON missing required fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ gradePitchGuideTraining_ attempt ' + (attempt + 1) + ' failed for ' + videoTitle + ': ' + e);
    }
  }
  return { suggestions: [], outdatedFlags: [] };
}

/**
 * Same getOrCreate-plus-frozen-header pattern as every other phase's own tab
 * (e.g. getOrCreateSeanFollowUpTrackerSheet_, Phase17_SeanFollowUpAutomation.gs).
 */
function getOrCreatePitchGuideSuggestionsSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PITCH_GUIDE_SUGGESTIONS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PITCH_GUIDE_SUGGESTIONS_SHEET_NAME);
    sheet.getRange(1, 1, 1, PITCH_GUIDE_SUGGESTIONS_HEADERS.length).setValues([PITCH_GUIDE_SUGGESTIONS_HEADERS])
      .setFontWeight('bold').setBackground('#e8eef7');
    sheet.setFrozenRows(1);
    log_('Created "' + PITCH_GUIDE_SUGGESTIONS_SHEET_NAME + '" tab.');
  }
  return sheet;
}

/** One row per suggestion. Pure w.r.t. sheet contents — takes the sheet as a param so it's testable with a fake. */
function appendPitchGuideSuggestionRows_(sheet, videoTitle, dateLabel, graded) {
  graded.suggestions.forEach(function (s, i) {
    sheet.appendRow([videoTitle, dateLabel, i + 1, s.gap, s.quote, s.suggestedEdit, s.confidence, '', false]);
  });
}

/**
 * Summary email to Tomás (cc Kris) — the sheet is where he actually records
 * Yes/No per suggestion (bulk-editable, keeps history), so this email is
 * just "here's what's waiting for you," not the review surface itself.
 */
function buildPitchGuideReviewEmail_(videoTitle, videoUrl, sheetUrl, graded) {
  var subject = '[Pitch Guide review] ' + graded.suggestions.length + ' suggestion(s) from "' + videoTitle + '"';

  var outdatedLines = graded.outdatedFlags.map(function (f) { return '• "' + f.quote + '"'; });

  var body =
    'New Pitch Guide training reviewed: ' + videoTitle + '\n\n' +
    'Recording: ' + videoUrl + '\n\n' +
    graded.suggestions.length + ' suggested update(s) — review and mark Yes/No in the tracking sheet:\n' +
    sheetUrl + '\n\n' +
    (outdatedLines.length
      ? 'Also explicitly flagged as needing an update on the call:\n' + outdatedLines.join('\n') + '\n\n'
      : '');

  var htmlBody = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    '<p>New Pitch Guide training reviewed: <strong>' + escapeHtml_(videoTitle) + '</strong></p>' +
    '<p><a href="' + escapeHtml_(videoUrl) + '">Watch the recording</a></p>' +
    '<p>' + graded.suggestions.length + ' suggested update(s) — review and mark Yes/No in the ' +
    '<a href="' + escapeHtml_(sheetUrl) + '">tracking sheet</a>.</p>' +
    (outdatedLines.length
      ? '<p><strong>Also explicitly flagged as needing an update on the call:</strong></p>' +
        '<ul style="margin:0 0 12px 0;padding-left:20px;">' +
        graded.outdatedFlags.map(function (f) { return '<li><i>&quot;' + escapeHtml_(f.quote) + '&quot;</i></li>'; }).join('') +
        '</ul>'
      : '') +
    '</div>';

  return { subject: subject, body: body, htmlBody: htmlBody };
}

/**
 * One video+transcript pair end to end: grade against the current Pitch
 * Guide doc, write suggestion rows, email Tomás/Kris, drop the "Reviewed"
 * marker. dryRun logs instead of writing/sending. Returns true if it did
 * real work.
 */
function processPitchGuideTrainingVideo_(folder, videoFile, transcriptFile, pitchGuideText, dryRun) {
  var transcriptText = getTranscriptText_(transcriptFile);
  var graded = gradePitchGuideTraining_(videoFile.getName(), transcriptText, pitchGuideText);
  var videoUrl = videoFile.getUrl();

  if (dryRun) {
    log_('(preview) ' + videoFile.getName() + ': ' + graded.suggestions.length + ' suggestion(s), ' +
      graded.outdatedFlags.length + ' outdated-flag(s). Nothing written or sent.');
    graded.suggestions.forEach(function (s, i) {
      log_('  [' + (i + 1) + '] (' + s.confidence + ') ' + s.gap);
    });
    return false;
  }

  var sheet = getOrCreatePitchGuideSuggestionsSheet_();
  var dateLabel = Utilities.formatDate(new Date(), CONFIG.BUSINESS_TIMEZONE, 'dd/MM/yyyy');
  appendPitchGuideSuggestionRows_(sheet, videoFile.getName(), dateLabel, graded);
  var sheetUrl = 'https://docs.google.com/spreadsheets/d/' + SALES_CALL_LOG_SPREADSHEET_ID +
    '/edit#gid=' + sheet.getSheetId();

  var email = buildPitchGuideReviewEmail_(videoFile.getName(), videoUrl, sheetUrl, graded);
  var sent = guardedSend_(CONFIG.TOMAS_EMAIL, email.subject, email.body, {
    cc: CONFIG.KRIS_EMAIL,
    htmlBody: email.htmlBody,
    name: 'Pitch Guide Review Bot'
  }, 2); // Tomás + Kris
  if (!sent) {
    log_('  ' + videoFile.getName() + ': SEND FAILED/SKIPPED (quota-short or invalid config) — suggestions were ' +
      'still written to the sheet, but no "Reviewed" marker was dropped, so this will retry next run.');
    return false;
  }

  var marker = DocumentApp.create(pitchGuideReviewedMarkerName_(videoFile.getName()));
  marker.getBody().setText('Reviewed on ' + new Date() + ' — ' + graded.suggestions.length +
    ' suggestion(s) written to "' + PITCH_GUIDE_SUGGESTIONS_SHEET_NAME + '".\nRecording: ' + videoUrl);
  marker.saveAndClose();
  DriveApp.getFileById(marker.getId()).moveTo(folder);

  log_('  ' + videoFile.getName() + ': ' + graded.suggestions.length + ' suggestion(s) written, emailed, marked reviewed.');
  return true;
}

/** Shared by preview and live paths. dryRun=true never sends, writes, or marks anything processed. */
function buildAndMaybeSendPitchGuideReview_(dryRun) {
  RUN_TAG = 'buildAndMaybeSendPitchGuideReview_';
  var folder = DriveApp.getFolderById(PITCH_GUIDE_REVIEW_CONFIG.FOLDER_ID);
  var pitchGuideText = fetchPitchGuideDocText_();
  var processed = 0;

  collectPitchGuideTrainingVideos_(folder).forEach(function (videoFile) {
    if (pitchGuideTrainingAlreadyReviewed_(folder, videoFile)) return;
    var transcriptFile = findPitchGuideTranscript_(folder, videoFile);
    if (!transcriptFile) {
      log_('  ' + videoFile.getName() + ': no transcript yet — run tools/transcribe_pitch_guide_training.py first.');
      return;
    }
    if (processPitchGuideTrainingVideo_(folder, videoFile, transcriptFile, pitchGuideText, dryRun)) processed++;
  });

  if (!processed) log_('buildAndMaybeSendPitchGuideReview_: nothing new to process.');
  return processed;
}

/** Run this FIRST from the editor. Logs what it would write/send — nothing is sent, written, or marked. */
function previewPitchGuideReview() {
  return previewPitchGuideReview_();
}

function previewPitchGuideReview_() {
  RUN_TAG = 'previewPitchGuideReview_';
  log_('PREVIEW MODE — reviewing pending Pitch Guide training video(s), nothing will be sent or written.');
  return buildAndMaybeSendPitchGuideReview_(/*dryRun=*/true);
}

/** Trigger target. */
function runPitchGuideReview() {
  RUN_TAG = 'runPitchGuideReview';
  if (!PITCH_GUIDE_REVIEW_CONFIG.ENABLED) {
    log_('runPitchGuideReview: PITCH_GUIDE_REVIEW_CONFIG.ENABLED is false, skipping.');
    return 0;
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runPitchGuideReview: another scoring/queue run holds the lock, skipping this run.');
    return 0;
  }
  try {
    return buildAndMaybeSendPitchGuideReview_(/*dryRun=*/false);
  } finally {
    lock.releaseLock();
  }
}

// installPitchGuideReviewTrigger (its own standalone monthly trigger) was
// removed 07/09/2026 — this phase now shares Phase 17/19's consolidated
// every-2-hour trigger (runPhase17To19StandingChecks_,
// Phase17_SeanFollowUpAutomation.gs), which calls runPitchGuideReview() only
// when the current day-of-month/hour matches TRIGGER_DAY_OF_MONTH/
// TRIGGER_HOUR above (see that function's own header for why: the project
// hit Apps Script's 20-trigger cap with only 1 slot free and 4 pending
// automations of different cadences). Install via installAllReadyTriggers()
// (Phase1_ComplianceCheck.gs), not a phase-specific installer.
