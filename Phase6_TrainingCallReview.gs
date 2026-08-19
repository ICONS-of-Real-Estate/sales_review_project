/**
 * Phase6_TrainingCallReview.gs
 *
 * Thao's ask (19/08/2026): Tomás runs a 1:1 training call with each rep,
 * built around that rep's own review from the week before, to drill
 * objection handling and asking for the money. This phase reads the
 * TRANSCRIPT OF THAT TRAINING CALL — not a sales call — and turns it into
 * a coaching plan for the coming week. Complements Phase 5 (grades the
 * reps' real sales calls); this phase grades the coaching session itself.
 *
 * Real folder structure (confirmed 19/08/2026 against Bens' actual first
 * session — Zoom's cloud recording drops its own auto-generated .vtt
 * transcript right next to the video, so no separate transcription
 * script is needed for these):
 *
 *   <Rep> Training Calls/
 *     <YYMMDD>/                          e.g. "260818"
 *       GMT..._Recording.transcript.vtt  <- Zoom's own transcript, read this
 *       GMT..._Recording_....mp4
 *       GMT..._Recording.m4a
 *
 *   Bens Training Calls:  https://drive.google.com/drive/folders/1aukWaQPrwGM_RmquAFo6gdPFveOgsNoD
 *   Sean Training Calls:  https://drive.google.com/drive/folders/1gbFSBxpEL-8YEnFzfZNidIrZF1hIsCTj
 *   Joana Training Calls: https://drive.google.com/drive/folders/1N88gC2kYBU51Dpb277mdFaIsVxWblSS3
 *
 * To hand over a new training call: just make sure the Zoom cloud
 * recording (with its auto-transcript) lands in a dated YYMMDD subfolder
 * under the right rep's folder above. Nothing to run by hand.
 *
 * Reuses CONFIG, log_, guardedSend_, callKimiJudge_, stripFencesAndParseJson_,
 * getTranscriptText_ from Phase1/Phase2 (same-project global scope).
 *
 * ONE-TIME SETUP:
 *   1. Run previewTrainingCallReview() from the Apps Script editor (the
 *      trailing-underscore version won't show up in the "Select function"
 *      dropdown — Apps Script hides those). It reads
 *      whatever dated subfolders exist and only logs the coaching plan for
 *      each — nothing is sent, nothing is marked processed.
 *   2. Check the output makes sense (right rep, notes actually match what
 *      happened in the call).
 *   3. Flip TRAINING_REVIEW_CONFIG.ENABLED to true and run
 *      installTrainingCallReviewTrigger().
 */

var TRAINING_REVIEW_CONFIG = {
  // Flipped true 19/08/2026 after Bens' 260818 training call was reviewed
  // and sent manually — future weeks are handled by this automation.
  ENABLED: true,
  FOLDERS: {
    Bens: '1aukWaQPrwGM_RmquAFo6gdPFveOgsNoD',
    Sean: '1gbFSBxpEL-8YEnFzfZNidIrZF1hIsCTj',
    Joana: '1N88gC2kYBU51Dpb277mdFaIsVxWblSS3'
  },
  TRIGGER_HOUR: 9 // checked daily since Zoom's auto-transcript turnaround varies; most days finds nothing new
};

function buildTrainingReviewSystemPrompt_(rep) {
  return [
    'You are reviewing the TRANSCRIPT OF A LIVE 1:1 TRAINING CALL between Tomás (sales trainer) and ' +
      rep + ' (rep) — not a sales call.',
    'Tomás runs this call weekly, built around ' + rep + '\'s own performance review from the week',
    'before, to drill objection handling and asking for the money. A third person (e.g. "Admin"/Kris)',
    'may sit in on the call — treat their turns as context, not as something to coach.',
    '',
    'Extract:',
    '  - Did Tomás reference a specific real call/objection pattern of ' + rep + '\'s, and what did he say about it?',
    '  - Did ' + rep + ' actively practice (role-play, answer a drill question) in this call? Quote the moment.',
    '  - What did Tomás explicitly tell ' + rep + ' to do differently before next week?',
    '  - The 2-3 SPECIFIC objections Tomás drilled ' + rep + ' on in this call (not a general theme —',
    '    the actual named objection, e.g. "I\'m too busy right now", "What does this cost?"), each with a',
    '    short, concrete one-clause note on how to handle it. These get sent to ' + rep + ' as this week\'s',
    '    daily practice assignment, so keep both the label and the note short and usable as a checklist item.',
    '',
    'Be skeptical: if ' + rep + ' was only listening, not practicing, mark practiced=false — don\'t invent',
    'practice that didn\'t happen.',
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text, in this exact shape:',
    '',
    '{',
    '  "reasoning": "string",',
    '  "attended": true,',
    '  "practiced": true,',
    '  "coaching_notes": "string — what Tomás said about their pattern/performance, with a quote",',
    '  "next_focus": "string — one concrete, specific self-practice focus for this coming week",',
    '  "objections_to_drill": [',
    '    { "label": "string — the specific objection, short, e.g. \\"I\'m too busy right now\\"",',
    '      "note": "string — one short clause on how to handle it, e.g. \\"qualify them, don\'t just push to book\\"" }',
    '  ],',
    '  "team_notes": "string — anything Tomás said that applies beyond ' + rep + ', else \\"none\\""',
    '}'
  ].join('\n');
}

function buildTrainingReviewUserPrompt_(rep, dateLabel, transcriptText) {
  return [
    'Rep: ' + rep,
    'Training call date folder: ' + dateLabel,
    '',
    'Transcript:',
    transcriptText
  ].join('\n');
}

function isValidTrainingReviewSchema_(obj) {
  return !!(obj &&
    typeof obj.attended === 'boolean' &&
    typeof obj.practiced === 'boolean' &&
    typeof obj.coaching_notes === 'string' &&
    typeof obj.next_focus === 'string' &&
    typeof obj.team_notes === 'string' &&
    Array.isArray(obj.objections_to_drill) &&
    obj.objections_to_drill.length > 0 &&
    obj.objections_to_drill.every(function (o) {
      return o && typeof o.label === 'string' && typeof o.note === 'string';
    }));
}

/** Strips WebVTT cue numbers + timestamp lines, leaving just "Speaker: text" lines for the judge. */
function stripVttMarkup_(raw) {
  return raw
    .split('\n')
    .filter(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed === 'WEBVTT') return false;
      if (/^\d+$/.test(trimmed)) return false; // cue sequence number
      if (trimmed.indexOf('-->') !== -1) return false; // timestamp line
      return true;
    })
    .join('\n');
}

/** Same retry/manual-review shape as scoreTranscript_ (Phase2), against the training-review rubric above. */
function reviewTrainingCallTranscript_(rep, transcriptText, dateLabel) {
  var systemPrompt = buildTrainingReviewSystemPrompt_(rep);
  var userPrompt = buildTrainingReviewUserPrompt_(rep, dateLabel, transcriptText);

  for (var attempt = 0; attempt <= (PHASE2_CONFIG.MAX_PARSE_RETRIES || 1); attempt++) {
    var promptForThisAttempt = attempt === 0
      ? userPrompt
      : userPrompt + '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    try {
      var raw = callKimiJudge_(systemPrompt, promptForThisAttempt);
      var parsed = stripFencesAndParseJson_(raw);
      if (!isValidTrainingReviewSchema_(parsed)) throw new Error('Parsed JSON missing required fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ reviewTrainingCallTranscript_ attempt ' + (attempt + 1) + ' failed for ' + rep + '/' + dateLabel + ': ' + e);
    }
  }
  return {
    reasoning: 'Unscored — parse failure after retries.',
    attended: true,
    practiced: false,
    coaching_notes: 'Automated review failed to parse twice — read the transcript manually.',
    next_focus: 'n/a — read transcript manually: ' + rep + '/' + dateLabel,
    objections_to_drill: [],
    team_notes: 'none'
  };
}

function buildTrainingReviewEmail_(rep, dateLabel, result) {
  var subject = 'Training Call Plan — ' + rep + ' — ' + dateLabel;
  var objections = result.objections_to_drill || [];

  var objectionsPlain = objections.map(function (o) {
    return '- ' + o.label + ' — ' + o.note;
  }).join('\n');
  var objectionsHtml = '<ul>' + objections.map(function (o) {
    return '<li><b>' + o.label + '</b> — ' + o.note + '</li>';
  }).join('') + '</ul>';

  var body = 'Training call with ' + rep + ' (' + dateLabel + '):\n\n' +
    'Attended: ' + (result.attended ? 'Yes' : 'No') + ' | Practiced live: ' + (result.practiced ? 'Yes' : 'No') + '\n\n' +
    'Notes: ' + result.coaching_notes + '\n\n' +
    'This week\'s objections to drill:\n' + objectionsPlain + '\n\n' +
    (result.team_notes && result.team_notes.toLowerCase() !== 'none' ? 'Team-wide note: ' + result.team_notes + '\n\n' : '') +
    '— Automated review of the training call itself, not a sales call. Reply to Kris or Tomás with corrections.';

  var htmlBody =
    '<p>Training call with <b>' + rep + '</b> (' + dateLabel + '):</p>' +
    '<p><b>Attended:</b> ' + (result.attended ? 'Yes' : 'No') +
    ' &nbsp;|&nbsp; <b>Practiced live:</b> ' + (result.practiced ? 'Yes' : 'No') + '</p>' +
    '<p><b>Notes:</b> ' + result.coaching_notes + '</p>' +
    '<p><b>This week\'s objections to drill:</b></p>' + objectionsHtml +
    (result.team_notes && result.team_notes.toLowerCase() !== 'none'
      ? '<p><b>Team-wide note:</b> ' + result.team_notes + '</p>' : '') +
    '<p><i>— Automated review of the training call itself, not a sales call. Reply to Kris or Tomás with corrections.</i></p>';

  return { subject: subject, body: body, htmlBody: htmlBody };
}

/** Finds the Zoom-generated transcript inside a dated subfolder (skips the video/audio siblings). */
function findTrainingTranscriptFile_(dateFolder) {
  var files = dateFolder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    if (/\.vtt$/i.test(name) || name.indexOf('Transcript') !== -1) return file;
  }
  return null;
}

/** True if a "Training Plan" Doc already sits in this dated subfolder. */
function trainingReviewAlreadyDone_(dateFolder) {
  return dateFolder.getFilesByName('Training Plan').hasNext();
}

/** Shared by preview and live paths. dryRun=true never sends and never marks anything processed. */
function buildAndMaybeSendTrainingReviews_(dryRun) {
  var found = 0, processed = 0;

  Object.keys(TRAINING_REVIEW_CONFIG.FOLDERS).forEach(function (rep) {
    var repFolder = DriveApp.getFolderById(TRAINING_REVIEW_CONFIG.FOLDERS[rep]);
    var dateFolders = repFolder.getFolders();

    while (dateFolders.hasNext()) {
      var dateFolder = dateFolders.next();
      var dateLabel = dateFolder.getName(); // e.g. "260818"

      var transcriptFile = findTrainingTranscriptFile_(dateFolder);
      if (!transcriptFile) continue; // recording dropped but Zoom hasn't produced a transcript yet
      found++;

      if (!dryRun && trainingReviewAlreadyDone_(dateFolder)) {
        log_('  ' + rep + '/' + dateLabel + ' already has a Training Plan doc — skipping.');
        continue;
      }

      var repCfg = CONFIG.REPS.filter(function (r) { return r.name === rep; })[0];
      if (!repCfg) { log_('No CONFIG.REPS entry for "' + rep + '" — skipping.'); return; }

      var cleanText = stripVttMarkup_(getTranscriptText_(transcriptFile));
      var result = reviewTrainingCallTranscript_(rep, cleanText, dateLabel);
      var email = buildTrainingReviewEmail_(rep, dateLabel, result);

      if (dryRun) {
        log_('(preview) ' + repCfg.email + ' (cc ' + CONFIG.TOMAS_EMAIL + ', ' + CONFIG.KRIS_EMAIL +
          ') <- ' + email.subject + '\n' + email.body + '\n');
        continue;
      }

      // Goes to the rep being trained; Tomás (who ran the call) and Kris are cc'd.
      guardedSend_(repCfg.email, email.subject, email.body, {
        cc: CONFIG.TOMAS_EMAIL + ',' + CONFIG.KRIS_EMAIL,
        htmlBody: email.htmlBody,
        name: 'Training Call Review Bot'
      }, 3); // rep + Tomás + Kris

      // Persisted for Phase 7's daily assignment emails to read. Only overwrite on a
      // real, non-empty result — a parse-failure fallback (empty array) must NOT wipe
      // out last week's objections; per Kris, a skipped/late training week just keeps
      // running the previous week's assignment until a new one actually lands.
      if (result.objections_to_drill && result.objections_to_drill.length) {
        PropertiesService.getScriptProperties().setProperty(
          'TRAINING_OBJECTIONS_' + rep, JSON.stringify(result.objections_to_drill));
      }

      var doc = DocumentApp.create('Training Plan');
      doc.getBody().setText(email.body);
      doc.saveAndClose();
      DriveApp.getFileById(doc.getId()).moveTo(dateFolder);

      processed++;
      log_('  Reviewed ' + rep + '/' + dateLabel + ' -> emailed training plan, wrote "Training Plan" doc.');
    }
  });

  log_('buildAndMaybeSendTrainingReviews_(dryRun=' + dryRun + ') — ' + found + ' transcript(s) found, ' +
    processed + ' processed this run.');
}

/** Run this FIRST from the editor. Reviews whatever's in the folders and only logs — sends and writes nothing. */
/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewTrainingCallReview() {
  return previewTrainingCallReview_();
}

function previewTrainingCallReview_() {
  RUN_TAG = 'previewTrainingCallReview_';
  log_('PREVIEW MODE — reviewing training call transcript(s), nothing will be sent or written.');
  buildAndMaybeSendTrainingReviews_(/*dryRun=*/true);
}

/** Trigger target. */
function runTrainingCallReview() {
  RUN_TAG = 'runTrainingCallReview';
  if (!TRAINING_REVIEW_CONFIG.ENABLED) { log_('TRAINING_REVIEW_CONFIG.ENABLED is false — skipping.'); return; }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runTrainingCallReview: another run holds the lock, skipping this firing.');
    return;
  }
  try {
    buildAndMaybeSendTrainingReviews_(/*dryRun=*/false);
  } finally {
    lock.releaseLock();
  }
}

function installTrainingCallReviewTrigger() {
  RUN_TAG = 'installTrainingCallReviewTrigger';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runTrainingCallReview') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runTrainingCallReview')
    .timeBased()
    .everyDays(1)
    .atHour(TRAINING_REVIEW_CONFIG.TRIGGER_HOUR)
    .inTimezone(CONFIG.BUSINESS_TIMEZONE)
    .create();
  log_('Training call review trigger installed: daily ' + TRAINING_REVIEW_CONFIG.TRIGGER_HOUR +
    ':00 (' + CONFIG.BUSINESS_TIMEZONE + ') — checks for new transcripts, most days finds none.');
}

// ---------------------------------------------------------------------------
// Tomás's Tuesday reminder to upload each rep's training call recording.
//
// Kris's ask (19/08/2026): remind Tomás every Tuesday, midday Portugal time,
// to drop each rep's training call recording into their folder. The daily
// scan above (runTrainingCallReview, hourly-checked-daily) already covers
// "training happened late" (Wed/Thu) or "training got skipped this week" —
// it just keeps finding nothing until a transcript actually shows up, and
// Phase 7's daily assignment keeps running last week's objections in the
// meantime. This reminder is purely a nudge on top of that, not a dependency.
// ---------------------------------------------------------------------------

var TOMAS_TRANSCRIPT_REMINDER_CONFIG = {
  ENABLED: false,
  TRIGGER_HOUR: 12, // midday
  TIMEZONE: 'Europe/Lisbon' // Portugal
};

function buildTomasTranscriptReminderEmail_() {
  var subject = "Reminder: upload this week's training call recordings";
  var links = Object.keys(TRAINING_REVIEW_CONFIG.FOLDERS).map(function (rep) {
    return rep + ': https://drive.google.com/drive/folders/' + TRAINING_REVIEW_CONFIG.FOLDERS[rep];
  }).join('\n');
  var body = 'Hi Tomás,\n\n' +
    "Please drop this week's training call recording for each rep into their folder (a dated " +
    'YYMMDD subfolder), so it can be reviewed:\n\n' + links + '\n\n' +
    "If Zoom's cloud recording auto-transcribes it, that's picked up automatically — nothing else " +
    'to do once it lands there.\n\n' +
    '— This is an automated reminder. Reply to Kris with any issues.';
  return { subject: subject, body: body };
}

/** Trigger target — also serves as its own preview (logs instead of sending while disabled). */
function sendTomasTranscriptReminder_() {
  RUN_TAG = 'sendTomasTranscriptReminder_';
  var email = buildTomasTranscriptReminderEmail_();
  if (!TOMAS_TRANSCRIPT_REMINDER_CONFIG.ENABLED) {
    log_('(preview, config disabled) ' + CONFIG.TOMAS_EMAIL + ' <- ' + email.subject + '\n' + email.body);
    return;
  }
  guardedSend_(CONFIG.TOMAS_EMAIL, email.subject, email.body, { name: 'Training Call Review Bot' }, 1);
  log_("Sent Tomás this week's transcript-upload reminder.");
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function sendTomasTranscriptReminder() {
  return sendTomasTranscriptReminder_();
}

function installTomasTranscriptReminderTrigger() {
  RUN_TAG = 'installTomasTranscriptReminderTrigger';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendTomasTranscriptReminder_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendTomasTranscriptReminder_')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.TUESDAY)
    .atHour(TOMAS_TRANSCRIPT_REMINDER_CONFIG.TRIGGER_HOUR)
    .inTimezone(TOMAS_TRANSCRIPT_REMINDER_CONFIG.TIMEZONE)
    .create();
  log_('Tomás transcript reminder installed: Tuesdays ' + TOMAS_TRANSCRIPT_REMINDER_CONFIG.TRIGGER_HOUR +
    ':00 (' + TOMAS_TRANSCRIPT_REMINDER_CONFIG.TIMEZONE + ').');
}
