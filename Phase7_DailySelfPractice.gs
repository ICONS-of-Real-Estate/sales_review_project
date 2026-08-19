/**
 * Phase7_DailySelfPractice.gs
 *
 * Thao's ask (19/08/2026): every day, each rep (Bens/Sean/Joana) uploads a
 * video of themselves practicing objection handling alone. This phase grades
 * that day's practice reps and emails feedback, plus reminds anyone who
 * hasn't uploaded yet.
 *
 * Source folders — one per rep, under "Daily Objection Practice":
 *   Bens:  https://drive.google.com/drive/folders/1NG3YUXlCWOjcJT8d8ECU0uw6hEVL-fHC
 *   Sean:  https://drive.google.com/drive/folders/1SJJ5Jek_4vEzmS907NQofDYq6bl-Mnr1
 *   Joana: https://drive.google.com/drive/folders/1fevtADQtgtb6Q1UAffp-cZjcNB6t6VRm
 *
 * This phase grades TRANSCRIPTS, same as every other phase — it does not
 * transcribe video itself. Run tools/transcribe_daily_practice.py (same repo,
 * reuses transcribe_sean_calls.py's Drive/Gemini plumbing) against these three
 * folders on whatever cadence you like (a nightly scheduled task on someone's
 * machine, or by hand) so a "<video name> — Transcript" Doc lands next to
 * each upload before this phase's grading trigger runs.
 *
 * Reuses CONFIG, log_, guardedSend_, callKimiJudge_, stripFencesAndParseJson_,
 * getTranscriptText_, businessDayStart_ from Phase1/Phase2 (same-project
 * global scope).
 *
 * ONE-TIME SETUP:
 *   1. Run previewDailyPracticeGrading_() from the Apps Script editor —
 *      grades whatever transcripts already exist and only logs the feedback,
 *      nothing sent, nothing written.
 *   2. Flip DAILY_PRACTICE_CONFIG.ENABLED to true and run
 *      installDailySelfPracticeTriggers_().
 */

var DAILY_PRACTICE_CONFIG = {
  ENABLED: false,
  FOLDERS: {
    Bens: '1NG3YUXlCWOjcJT8d8ECU0uw6hEVL-fHC',
    Sean: '1SJJ5Jek_4vEzmS907NQofDYq6bl-Mnr1',
    Joana: '1fevtADQtgtb6Q1UAffp-cZjcNB6t6VRm'
  },
  GRADING_HOUR: 20, // 8pm — after the work day, so today's upload has time to land + get transcribed
  REMINDER_HOUR: 16, // 4pm — nudge anyone who hasn't uploaded yet with hours still left in the day
  // Escalate (cc Kris + Tomás) when a graded rep falls at or below this — same
  // "manual review" spirit as Phase 2's severity flag, applied to a rep's own
  // practice quality rather than a real lead's call.
  ESCALATE_AT_OR_BELOW: 2
};

function buildDailyPracticeSystemPrompt_() {
  return [
    'You are grading a rep\'s SOLO OBJECTION-HANDLING PRACTICE DRILL — not a real sales call. There is no',
    'lead on this recording; the rep is practicing alone or role-playing both sides to rehearse handling',
    'a specific objection.',
    '',
    'Answer, in order:',
    '1. Which objection type were they practicing (budget, third-party approval, timing, ROI/proof,',
    '   compliance, competitor comparison, trust/prior bad experience, or other — name it specifically)?',
    '2. Did they use a concrete technique (a number, a case study, a specific script line) rather than',
    '   vague reassurance?',
    '3. Delivery: confident and natural, or hesitant/reading off a script woodenly?',
    '4. What is the single most specific thing to sharpen before their next live call?',
    '',
    'Be skeptical by default — a rep going through the motions without a real technique attempt should',
    'score low even if their delivery is smooth.',
    '',
    'Score anchors for overall_score (1-5):',
    '5 = clear objection named, a genuinely concrete technique used, confident delivery.',
    '4 = concrete technique used, but delivery or objection-framing was a little off.',
    '3 = attempted a technique but it stayed generic/vague rather than concrete.',
    '2 = no real technique — just repeated reassurance or changed the subject.',
    '1 = did not engage with the objection at all, or the drill doesn\'t show real practice.',
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text, in this exact shape:',
    '',
    '{',
    '  "reasoning": "string",',
    '  "objection_type": "string",',
    '  "technique_used": true,',
    '  "technique_description": "string",',
    '  "delivery_quality": "confident | hesitant | mixed",',
    '  "overall_score": 1,',
    '  "sharpen_next": "string — one concrete, specific thing to work on next",',
    '  "feedback_summary": "string — 3-4 sentences, coaching-ready, addressed to the rep directly"',
    '}'
  ].join('\n');
}

function buildDailyPracticeUserPrompt_(rep, transcriptText, fileName) {
  return [
    'Rep: ' + rep,
    'Practice recording: ' + fileName,
    '',
    'Transcript:',
    transcriptText
  ].join('\n');
}

function isValidDailyPracticeSchema_(obj) {
  return !!(obj &&
    typeof obj.objection_type === 'string' &&
    typeof obj.technique_used === 'boolean' &&
    typeof obj.delivery_quality === 'string' &&
    typeof obj.overall_score === 'number' &&
    typeof obj.sharpen_next === 'string' &&
    typeof obj.feedback_summary === 'string');
}

/** Same retry/manual-review shape as scoreTranscript_ (Phase2), against the daily-practice drill rubric above. */
function gradeDailyPracticeTranscript_(rep, transcriptText, fileName) {
  var systemPrompt = buildDailyPracticeSystemPrompt_();
  var userPrompt = buildDailyPracticeUserPrompt_(rep, transcriptText, fileName);

  for (var attempt = 0; attempt <= (PHASE2_CONFIG.MAX_PARSE_RETRIES || 1); attempt++) {
    var promptForThisAttempt = attempt === 0
      ? userPrompt
      : userPrompt + '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    try {
      var raw = callKimiJudge_(systemPrompt, promptForThisAttempt);
      var parsed = stripFencesAndParseJson_(raw);
      if (!isValidDailyPracticeSchema_(parsed)) throw new Error('Parsed JSON missing required fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ gradeDailyPracticeTranscript_ attempt ' + (attempt + 1) + ' failed for ' + rep + '/' + fileName + ': ' + e);
    }
  }
  return {
    reasoning: 'Unscored — parse failure after retries.',
    objection_type: 'unknown',
    technique_used: false,
    technique_description: '',
    delivery_quality: 'mixed',
    overall_score: 3, // neutral, not escalation-triggering, since this is a pipeline failure not a rep failure
    sharpen_next: 'Automated grading failed to parse twice — review manually: ' + fileName,
    feedback_summary: 'Automated grading hit a parsing error twice in a row. Kris/Tomás: please review "' + fileName + '" by hand.'
  };
}

function buildDailyPracticeFeedbackEmail_(rep, fileName, result) {
  var subject = 'Practice Drill Feedback — ' + fileName + ' (' + result.overall_score + '/5)';
  var body =
    'Hi ' + rep + ',\n\n' +
    'Feedback on today\'s practice drill ("' + fileName + '"):\n\n' +
    'Objection practiced: ' + result.objection_type + '\n' +
    'Technique used: ' + (result.technique_used ? 'Yes — ' + result.technique_description : 'No — see below') + '\n' +
    'Delivery: ' + result.delivery_quality + '\n' +
    'Score: ' + result.overall_score + '/5\n\n' +
    result.feedback_summary + '\n\n' +
    'Sharpen next: ' + result.sharpen_next + '\n\n' +
    '— This is an automated review of your practice drill. Drafted by AI; reply to Kris or Tomás with any issues.';
  return { subject: subject, body: body };
}

/** True if a "<title> — Feedback" Doc already sits next to this practice file. */
function dailyPracticeAlreadyGraded_(folder, fileName) {
  var feedbackName = fileName.replace(/\.[^.]+$/, '').replace(/[—-]?\s*Transcript\s*$/i, '').trim() + ' — Feedback';
  return folder.getFilesByName(feedbackName).hasNext();
}

/** Shared by preview and live paths. dryRun=true never sends and never writes a Feedback doc. */
function buildAndMaybeGradeDailyPractice_(dryRun) {
  Object.keys(DAILY_PRACTICE_CONFIG.FOLDERS).forEach(function (rep) {
    var repCfg = CONFIG.REPS.filter(function (r) { return r.name === rep; })[0];
    if (!repCfg) { log_('No CONFIG.REPS entry for "' + rep + '" — skipping.'); return; }

    var folder = DriveApp.getFolderById(DAILY_PRACTICE_CONFIG.FOLDERS[rep]);
    var files = folder.getFiles();
    var found = 0, processed = 0;

    while (files.hasNext()) {
      var file = files.next();
      var name = file.getName();
      if (name.indexOf('Transcript') === -1) continue; // skip source videos, only grade transcript docs
      found++;

      if (!dryRun && dailyPracticeAlreadyGraded_(folder, name)) continue;

      var text = getTranscriptText_(file);
      var result = gradeDailyPracticeTranscript_(rep, text, name);
      var email = buildDailyPracticeFeedbackEmail_(rep, name, result);
      var escalate = result.overall_score <= DAILY_PRACTICE_CONFIG.ESCALATE_AT_OR_BELOW;

      if (dryRun) {
        log_('(preview) ' + repCfg.email + ' <- ' + email.subject +
          (escalate ? ' [would CC Kris+Tomás — score <= ' + DAILY_PRACTICE_CONFIG.ESCALATE_AT_OR_BELOW + ']' : '') +
          '\n' + email.body + '\n');
        continue;
      }

      var sendOptions = { name: 'Daily Practice Feedback Bot' };
      var recipientsNeeded = 1;
      if (escalate) {
        sendOptions.cc = CONFIG.KRIS_EMAIL + ',' + CONFIG.TOMAS_EMAIL;
        recipientsNeeded = 3;
      }
      guardedSend_(repCfg.email, email.subject, email.body, sendOptions, recipientsNeeded);

      var feedbackName = name.replace(/[—-]?\s*Transcript\s*$/i, '').trim() + ' — Feedback';
      var doc = DocumentApp.create(feedbackName);
      doc.getBody().setText(email.body);
      doc.saveAndClose();
      DriveApp.getFileById(doc.getId()).moveTo(folder);

      processed++;
      log_('  [' + rep + '] Graded "' + name + '" (' + result.overall_score + '/5)' +
        (escalate ? ' — escalated to Kris/Tomás.' : '.'));
    }

    log_('[' + rep + '] ' + found + ' transcript(s) found, ' + processed + ' graded this run.');
  });
}

/** Run this FIRST from the editor. Grades whatever's in the folders and only logs — sends and writes nothing. */
function previewDailyPracticeGrading_() {
  RUN_TAG = 'previewDailyPracticeGrading_';
  log_('PREVIEW MODE — grading daily practice transcript(s), nothing will be sent or written.');
  buildAndMaybeGradeDailyPractice_(/*dryRun=*/true);
}

/** Trigger target. */
function runDailyPracticeGrading() {
  RUN_TAG = 'runDailyPracticeGrading';
  if (!DAILY_PRACTICE_CONFIG.ENABLED) { log_('DAILY_PRACTICE_CONFIG.ENABLED is false — skipping.'); return; }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runDailyPracticeGrading: another run holds the lock, skipping this firing.');
    return;
  }
  try {
    buildAndMaybeGradeDailyPractice_(/*dryRun=*/false);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reminder pass — for each rep, checks whether ANY file (video or transcript)
 * was added to their folder so far today (business day); if not, emails them
 * the direct folder link. Independent of grading — runs earlier in the day
 * so there's still time left to upload.
 */
function sendDailyPracticeReminders_() {
  RUN_TAG = 'sendDailyPracticeReminders_';
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var dayStart = businessDayStart_(new Date(), tz);

  Object.keys(DAILY_PRACTICE_CONFIG.FOLDERS).forEach(function (rep) {
    var repCfg = CONFIG.REPS.filter(function (r) { return r.name === rep; })[0];
    if (!repCfg) { log_('No CONFIG.REPS entry for "' + rep + '" — skipping reminder.'); return; }

    var folderId = DAILY_PRACTICE_CONFIG.FOLDERS[rep];
    var folder = DriveApp.getFolderById(folderId);
    var files = folder.getFiles();
    var uploadedToday = false;
    while (files.hasNext()) {
      if (files.next().getDateCreated() >= dayStart) { uploadedToday = true; break; }
    }

    if (uploadedToday) { log_('[' + rep + '] already uploaded today — no reminder needed.'); return; }

    var subject = 'Reminder: today\'s objection-practice drill';
    var body =
      'Hi ' + rep + ',\n\n' +
      'Looks like today\'s objection-handling practice video hasn\'t been uploaded yet. Drop it here ' +
      'when you record it:\n\n' +
      'https://drive.google.com/drive/folders/' + folderId + '\n\n' +
      'You\'ll get feedback automatically once it\'s uploaded and transcribed.\n\n' +
      '— This is an automated reminder. Reply to Kris or Tomás with any issues.';

    if (!DAILY_PRACTICE_CONFIG.ENABLED) {
      log_('(preview, config disabled) ' + repCfg.email + ' <- ' + subject);
      return;
    }
    guardedSend_(repCfg.email, subject, body, { name: 'Daily Practice Reminder Bot' }, 1);
    log_('[' + rep + '] Sent upload reminder.');
  });
}

function installDailySelfPracticeTriggers_() {
  RUN_TAG = 'installDailySelfPracticeTriggers_';
  ['runDailyPracticeGrading', 'sendDailyPracticeReminders_'].forEach(function (handler) {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
    });
  });

  ScriptApp.newTrigger('sendDailyPracticeReminders_')
    .timeBased().everyDays(1).atHour(DAILY_PRACTICE_CONFIG.REMINDER_HOUR).inTimezone(CONFIG.BUSINESS_TIMEZONE).create();
  ScriptApp.newTrigger('runDailyPracticeGrading')
    .timeBased().everyDays(1).atHour(DAILY_PRACTICE_CONFIG.GRADING_HOUR).inTimezone(CONFIG.BUSINESS_TIMEZONE).create();

  log_('Daily self-practice triggers installed: reminders at ' + DAILY_PRACTICE_CONFIG.REMINDER_HOUR +
    ':00, grading at ' + DAILY_PRACTICE_CONFIG.GRADING_HOUR + ':00 (' + CONFIG.BUSINESS_TIMEZONE + ').');
}
