/**
 * Phase16_CalibrationFeedback.gs
 *
 * Kris's ask (06/09/2026), after "Make it one per person" (see
 * pickOneCallPerRep_ in Phase2_CallScoring.gs) fixed the random calibration
 * sample itself: he wants to record his own blind-review feedback (a video,
 * per call sampled) and have it get to the rep, plus feed what he learns
 * back into their training. His exact words: "Where do I put the feedback
 * recordings? ... When you pick up my feedback, send the video link and the
 * notes to the rep. Plus learn from it."
 *
 * WORKFLOW (no new UI — reuses the row Kris already visits to type Yes/No
 * into "Kris Manual Review Verdict" per the calibration digest email):
 *   1. Kris drops the raw video into the matching rep's Drive folder:
 *        Calibration Feedback/Sean:  https://drive.google.com/drive/folders/1vkSV1_rNnfFXMYr_RHsdIZ7ID3OjvDWX
 *        Calibration Feedback/Joana: https://drive.google.com/drive/folders/1FYo2dy5CBFeluuLgvxphuN38Fn4RHlP1
 *        Calibration Feedback/Tomás: https://drive.google.com/drive/folders/11qw_wKdOYmQZ8mkf1x_VQ08JSqwP1UFy
 *        Calibration Feedback/Bens:  https://drive.google.com/drive/folders/1QSCdg6TQ_3ocjVhAlq-fXanlw-0rPqCg
 *      (all four live under the shared "Calibration Feedback" folder:
 *      https://drive.google.com/drive/folders/1yNZRbi-Y4YWfq0izgXRQi84k7cH5Dnw0)
 *   2. Gets that file's share link (Drive: right-click -> Share -> Copy link;
 *      must be viewable by the rep, e.g. "Anyone with the link").
 *   3. On the SAME Sales Call Log row the calibration digest pointed him at,
 *      pastes the link into "Kris Feedback Video" and his written notes into
 *      "Kris Feedback Notes" — the two columns appended right after "GHL
 *      Review Synced" (see SALES_CALL_LOG_HEADERS, Phase1_ComplianceCheck.gs).
 *   4. This phase (on its own daily trigger, same pattern as every other
 *      phase) finds rows with both columns filled and "Kris Feedback Sent"
 *      still false, emails the rep the video link + notes, and asks the
 *      SAME judge model Phase 6 uses to pull out objections/close-ask/
 *      framework gaps to drill from Kris's notes — merged into the exact
 *      same TRAINING_OBJECTIONS_<rep>/TRAINING_CLOSE_DRILL_<rep>/
 *      TRAINING_FRAMEWORK_<rep> Script Properties Phase 6 already writes, so
 *      Phase 7's daily practice assignment emails pick this up automatically
 *      with zero changes on that end ("learn from it").
 *
 * ONE-TIME SETUP (same pattern as every other phase in this file):
 *   1. Run migrateAddPrimaryFailureModeColumn() (Phase2_CallScoring.gs) once
 *      to backfill "Kris Feedback Video"/"Kris Feedback Notes"/"Kris
 *      Feedback Sent" onto the live sheet — it's the general "catch the
 *      sheet's headers up to SALES_CALL_LOG_HEADERS" migration, not specific
 *      to this phase, safe to re-run.
 *   2. Run previewCalibrationFeedback() from the editor — logs what it would
 *      send/learn, sends nothing, writes nothing.
 *   3. Flip CALIBRATION_FEEDBACK_CONFIG.ENABLED to true, run
 *      installCalibrationFeedbackTrigger().
 */

var CALIBRATION_FEEDBACK_CONFIG = {
  ENABLED: false, // flip after previewCalibrationFeedback() looks right
  TRIGGER_HOUR: 9,
  // Purely informational (logged in previews/instructions) — this phase
  // never reads Drive itself, it only ever reads the link Kris pastes into
  // the sheet. Kept here so the folder IDs live in one place if they're
  // ever needed again, same as TRAINING_REVIEW_CONFIG.FOLDERS.
  FOLDERS: {
    Sean: '1vkSV1_rNnfFXMYr_RHsdIZ7ID3OjvDWX',
    Joana: '1FYo2dy5CBFeluuLgvxphuN38Fn4RHlP1',
    'Tomás': '11qw_wKdOYmQZ8mkf1x_VQ08JSqwP1UFy',
    Bens: '1QSCdg6TQ_3ocjVhAlq-fXanlw-0rPqCg'
  }
};

/**
 * Pure scan of already-fetched Sales Call Log values: a row is pending when
 * both "Kris Feedback Video" and "Kris Feedback Notes" are non-blank and
 * "Kris Feedback Sent" is not truthy yet. Returns rows in sheet order.
 */
function calibrationFeedbackPendingRows_(values, col) {
  var pending = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var videoUrl = String(row[col['Kris Feedback Video'] - 1] || '').trim();
    var notes = String(row[col['Kris Feedback Notes'] - 1] || '').trim();
    if (!videoUrl || !notes) continue;
    if (isTruthyOutcome_(row[col['Kris Feedback Sent'] - 1])) continue;
    pending.push({
      rowIndex: r + 2,
      rep: row[col['Rep'] - 1],
      prospectName: row[col['Prospect Name'] - 1],
      callDateLabel: String(row[col['Call Date'] - 1] || '').trim(),
      videoUrl: videoUrl,
      notes: notes
    });
  }
  return pending;
}

/**
 * Rep-facing email: the video link plus Kris's notes, verbatim — this is
 * blind calibration feedback on one specific call, not a general coaching
 * plan, so it stays short and doesn't editorialize on top of what Kris wrote.
 */
function buildCalibrationFeedbackEmail_(rep, prospectName, callDateLabel, videoUrl, notes) {
  var subject = '[Calibration feedback] ' + prospectName + ' (' + callDateLabel + ')';
  var body = 'Kris recorded feedback on your call with ' + prospectName + ' (' + callDateLabel +
    '), sampled for blind calibration review:\n\n' +
    'Video: ' + videoUrl + '\n\n' +
    'Notes:\n' + notes;
  var htmlBody = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    '<p>Kris recorded feedback on your call with <strong>' + escapeHtml_(prospectName) + '</strong> (' +
    escapeHtml_(callDateLabel) + '), sampled for blind calibration review:</p>' +
    '<p><a href="' + escapeHtml_(videoUrl) + '">Watch the video</a></p>' +
    '<p><strong>Notes:</strong><br>' + escapeHtml_(notes).replace(/\n/g, '<br>') + '</p>' +
    '</div>';
  return { subject: subject, body: body, htmlBody: htmlBody };
}

/**
 * Lightweight sibling of Phase6's buildTrainingReviewSystemPrompt_ — same
 * three drill fields (objections_to_drill/close_ask_drill/
 * framework_gaps_to_drill), same JSON shape, so the result plugs straight
 * into the SAME Script Properties/Phase 7 pipeline, but grading Kris's own
 * written/spoken NOTES on one sales call rather than a transcript of a full
 * 1:1 training session between Tomás and the rep — a materially different
 * input, so this needed its own prompt rather than reusing Phase 6's.
 */
function buildCalibrationFeedbackJudgeSystemPrompt_(rep) {
  var role = trainingReviewRoleFor_(rep);
  var closeAskLine = '  - If these notes call out a specific gap in ' + role.closeAskSkillLabel + ': a short label ' +
    'for what to drill and a one-clause note on how to fix it. Omit (null) if the notes don\'t mention it.';
  var frameworkLine = role.drillsFramework
    ? '  - If these notes call out a framework-explanation gap: which of the three specific pieces ' +
      '(recruit_agents | number_one_podcast | sell_more_houses), each with a short, concrete one-clause note on ' +
      'what to say differently. Empty array if the notes don\'t mention it.'
    : '  - Framework explanation is NOT part of ' + rep + '\'s role (' + role.roleNote + ') — always return an ' +
      'empty "framework_gaps_to_drill" array.';
  return [
    'You are reading KRIS\'S OWN WRITTEN FEEDBACK on one specific sales call ' + rep + ' had with a prospect — ' +
      'part of a blind weekly calibration review, not a transcript of a training call.',
    'Pull out concrete, actionable drill topics for ' + rep + '\'s coming week of daily self-practice. Only ' +
      'extract what these notes actually say — do not invent gaps the notes don\'t mention, and do not repeat ' +
      'generic advice.',
    '',
    'Extract:',
    '  - The specific objection-handling gaps these notes call out (not a general theme — the actual named ' +
      'objection, e.g. "I\'m too busy right now"), each with a short, concrete one-clause note on how to handle ' +
      'it via Agree/Isolate/Repeat. Empty array if the notes don\'t mention any.',
    closeAskLine,
    frameworkLine,
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text, in this exact shape:',
    '',
    '{',
    '  "objections_to_drill": [',
    '    { "label": "string", "note": "string" }',
    '  ],',
    '  "close_ask_drill": { "label": "string", "note": "string" } | null,',
    '  "framework_gaps_to_drill": [',
    '    { "topic": "recruit_agents | number_one_podcast | sell_more_houses", "note": "string" }',
    '  ]',
    '}'
  ].join('\n');
}

function buildCalibrationFeedbackJudgeUserPrompt_(rep, prospectName, callDateLabel, notes) {
  return [
    'Rep: ' + rep,
    'Call: ' + prospectName + ' (' + callDateLabel + ')',
    '',
    'Kris\'s feedback notes:',
    notes
  ].join('\n');
}

/** Only the three drill fields matter here — no attended/coaching_notes/etc like Phase 6's full schema. */
function isValidCalibrationDrillSchema_(obj) {
  return !!(obj &&
    Array.isArray(obj.objections_to_drill) &&
    obj.objections_to_drill.every(function (o) {
      return o && typeof o.label === 'string' && typeof o.note === 'string';
    }) &&
    (obj.close_ask_drill === null ||
      (obj.close_ask_drill && typeof obj.close_ask_drill.label === 'string' && typeof obj.close_ask_drill.note === 'string')) &&
    Array.isArray(obj.framework_gaps_to_drill) &&
    obj.framework_gaps_to_drill.every(function (f) {
      return f && typeof f.topic === 'string' && typeof f.note === 'string';
    }));
}

/**
 * Asks the judge model to turn Kris's notes into drill topics. Never blocks
 * the rep email on failure — falls back to all-empty (a safe no-op for
 * mergeCalibrationDrillIntoTrainingProperties_'s non-destructive merge)
 * after retrying once, same resilience pattern as reviewTrainingCallTranscript_.
 */
function extractCalibrationDrillTopics_(rep, prospectName, callDateLabel, notes) {
  var systemPrompt = buildCalibrationFeedbackJudgeSystemPrompt_(rep);
  var userPrompt = buildCalibrationFeedbackJudgeUserPrompt_(rep, prospectName, callDateLabel, notes);

  for (var attempt = 0; attempt <= (PHASE2_CONFIG.MAX_PARSE_RETRIES || 1); attempt++) {
    var promptForThisAttempt = attempt === 0
      ? userPrompt
      : userPrompt + '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    try {
      var raw = callKimiJudge_(systemPrompt, promptForThisAttempt, 'phase16:calibration_feedback');
      var parsed = stripFencesAndParseJson_(raw);
      if (!isValidCalibrationDrillSchema_(parsed)) throw new Error('Parsed JSON missing required fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ extractCalibrationDrillTopics_ attempt ' + (attempt + 1) + ' failed for ' + rep + '/' +
        prospectName + ': ' + e);
    }
  }
  return { objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [] };
}

/**
 * Same non-destructive overwrite-only-on-nonempty rule as
 * processTrainingTranscript_ (Phase6_TrainingCallReview.gs): a week where
 * Kris's notes don't happen to mention a gap must not wipe out the drill
 * Phase 6 (or a prior calibration round) already assigned. Ends by mirroring
 * into the Training Assignments sheet the same way Phase 6 does, so the
 * dashboard reflects it without any changes on that end.
 */
function mergeCalibrationDrillIntoTrainingProperties_(rep, extracted) {
  var props = PropertiesService.getScriptProperties();
  if (extracted.objections_to_drill && extracted.objections_to_drill.length) {
    props.setProperty('TRAINING_OBJECTIONS_' + rep, JSON.stringify(extracted.objections_to_drill));
  }
  if (extracted.close_ask_drill) {
    props.setProperty('TRAINING_CLOSE_DRILL_' + rep, JSON.stringify(extracted.close_ask_drill));
  }
  if (extracted.framework_gaps_to_drill && extracted.framework_gaps_to_drill.length) {
    props.setProperty('TRAINING_FRAMEWORK_' + rep, JSON.stringify(extracted.framework_gaps_to_drill));
  }
  mirrorTrainingAssignment_(rep);
}

/**
 * One pending row end to end: email the rep, extract + merge drill topics,
 * mark "Kris Feedback Sent". dryRun logs instead of sending/writing/marking.
 * Returns true if it did real work.
 */
function processCalibrationFeedbackRow_(sheet, col, rowData, dryRun) {
  var repEmail = repEmailForFollowUpCheck_(rowData.rep);
  if (!repEmail) {
    log_('  Row ' + rowData.rowIndex + ': no known email for rep "' + rowData.rep + '" — skipping.');
    return false;
  }
  var email = buildCalibrationFeedbackEmail_(rowData.rep, rowData.prospectName, rowData.callDateLabel,
    rowData.videoUrl, rowData.notes);

  if (dryRun) {
    log_('(preview) ' + repEmail + ' (cc ' + CONFIG.TOMAS_EMAIL + ', ' + CONFIG.KRIS_EMAIL + ') <- ' +
      email.subject + '\n' + email.body + '\n');
    return false;
  }

  var sent = guardedSend_(repEmail, email.subject, email.body, {
    cc: CONFIG.TOMAS_EMAIL + ',' + CONFIG.KRIS_EMAIL,
    htmlBody: email.htmlBody,
    name: 'Calibration Feedback Bot'
  }, 3); // rep + Tomás + Kris
  if (!sent) {
    log_('  Row ' + rowData.rowIndex + ': SEND FAILED/SKIPPED (quota-short or invalid config) — left pending, will retry next run.');
    return false;
  }

  var extracted = extractCalibrationDrillTopics_(rowData.rep, rowData.prospectName, rowData.callDateLabel, rowData.notes);
  mergeCalibrationDrillIntoTrainingProperties_(rowData.rep, extracted);

  sheet.getRange(rowData.rowIndex, col['Kris Feedback Sent']).setValue(true);
  log_('  Row ' + rowData.rowIndex + ': emailed ' + rowData.rep + ' the calibration feedback, merged drill topics.');
  return true;
}

/** Shared by preview and live paths. dryRun=true never sends, writes, or marks anything processed. */
function buildAndMaybeSendCalibrationFeedback_(dryRun) {
  RUN_TAG = 'buildAndMaybeSendCalibrationFeedback_';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return 0; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { log_('No data rows.'); return 0; }

  var col = getValidatedColumnMap_(sheet);
  if (col['Kris Feedback Video'] === undefined || col['Kris Feedback Notes'] === undefined ||
    col['Kris Feedback Sent'] === undefined) {
    log_('Sales Call Log is missing the calibration feedback columns — run migrateAddPrimaryFailureModeColumn() first.');
    return 0;
  }

  var values = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();
  var pending = calibrationFeedbackPendingRows_(values, col);
  if (!pending.length) {
    log_('buildAndMaybeSendCalibrationFeedback_: nothing pending — no row has both a video link and notes waiting to send.');
    return 0;
  }

  var processed = 0;
  pending.forEach(function (rowData) {
    if (processCalibrationFeedbackRow_(sheet, col, rowData, dryRun)) processed++;
  });
  return processed;
}

/** Run this FIRST from the editor. Logs what it would send/learn — nothing is sent, written, or marked. */
function previewCalibrationFeedback() {
  return previewCalibrationFeedback_();
}

function previewCalibrationFeedback_() {
  RUN_TAG = 'previewCalibrationFeedback_';
  log_('PREVIEW MODE — reviewing pending calibration feedback row(s), nothing will be sent or written.');
  return buildAndMaybeSendCalibrationFeedback_(/*dryRun=*/true);
}

/** Trigger target. */
function runCalibrationFeedback() {
  RUN_TAG = 'runCalibrationFeedback';
  if (!CALIBRATION_FEEDBACK_CONFIG.ENABLED) {
    log_('runCalibrationFeedback: CALIBRATION_FEEDBACK_CONFIG.ENABLED is false, skipping.');
    return 0;
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runCalibrationFeedback: another scoring/queue run holds the lock, skipping this run.');
    return 0;
  }
  try {
    return buildAndMaybeSendCalibrationFeedback_(/*dryRun=*/false);
  } finally {
    lock.releaseLock();
  }
}

function installCalibrationFeedbackTrigger() {
  RUN_TAG = 'installCalibrationFeedbackTrigger';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runCalibrationFeedback') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runCalibrationFeedback')
    .timeBased()
    .everyDays(1)
    .atHour(CALIBRATION_FEEDBACK_CONFIG.TRIGGER_HOUR)
    .inTimezone(CONFIG.BUSINESS_TIMEZONE)
    .create();
  log_('Calibration feedback trigger installed: daily ' + CALIBRATION_FEEDBACK_CONFIG.TRIGGER_HOUR + ':00 ' +
    CONFIG.BUSINESS_TIMEZONE + '.');
}
