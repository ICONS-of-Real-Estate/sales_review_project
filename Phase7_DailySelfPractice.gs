/**
 * Phase7_DailySelfPractice.gs
 *
 * Thao's ask (19/08/2026): every day, each rep (Bens/Sean/Joana) uploads a
 * video of themselves practicing objection handling alone. This phase grades
 * that day's practice reps and emails feedback, plus sends each rep that
 * day's assignment (the specific objections from their last training call,
 * per Phase 6's TRAINING_OBJECTIONS_<rep> property) each training-cycle
 * weekday.
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
 * The daily assignment email (sendDailyPracticeReminders_) is cc'd to Tomás
 * (CONFIG.TOMAS_EMAIL) so he sees every assignment as it goes out, not just
 * the escalations. A separate compliance check (checkDailyPracticeCompliance_)
 * runs each morning BEFORE that day's new assignment goes out, checking
 * whether the rep replied to yesterday's assignment email and whether a new
 * file actually landed in their Drive folder — alerting Kris+Tomás per rep
 * missing either.
 *
 * Reuses CONFIG, log_, guardedSend_, callKimiJudge_, stripFencesAndParseJson_,
 * getTranscriptText_, computeTrainingCycleLabel_ from Phase1/Phase2 (same-project
 * global scope).
 *
 * ONE-TIME SETUP:
 *   1. Run previewDailyPracticeGrading() from the Apps Script editor (not
 *      the trailing-underscore version — Apps Script's "Select function"
 *      dropdown hides those) —
 *      grades whatever transcripts already exist and only logs the feedback,
 *      nothing sent, nothing written.
 *   2. Run previewDailyPracticeCompliance() the same way to sanity-check the
 *      reply/upload check against yesterday's real assignment before it can
 *      send any alerts.
 *   3. Flip DAILY_PRACTICE_CONFIG.ENABLED to true and run
 *      installDailySelfPracticeTriggers_(). First run will prompt Gmail
 *      authorization (checkDailyPracticeCompliance_ reads reply threads via
 *      GmailApp) — approve it under the same account that owns this project.
 */

var DAILY_PRACTICE_CONFIG = {
  ENABLED: true, // Flipped true 19/08/2026 after previewDailyPracticeGrading_() ran clean (0 found, folders newly shared with Kris).
  FOLDERS: {
    Bens: '1NG3YUXlCWOjcJT8d8ECU0uw6hEVL-fHC',
    Sean: '1SJJ5Jek_4vEzmS907NQofDYq6bl-Mnr1',
    Joana: '1fevtADQtgtb6Q1UAffp-cZjcNB6t6VRm'
  },
  GRADING_HOUR: 20, // 8pm — after the work day, so today's upload has time to land + get transcribed
  REMINDER_HOUR: 9, // 9am — this is now the day's assignment (objections to drill), not an end-of-day nag, so it goes out in the morning. Was 16:00; flag to Kris if a different time is wanted.
  COMPLIANCE_CHECK_HOUR: 8, // 8am — an hour before REMINDER_HOUR, so it always checks yesterday's assignment before today's goes out.
  // Escalate (cc Kris + Tomás) when a graded rep falls at or below this — same
  // "manual review" spirit as Phase 2's severity flag, applied to a rep's own
  // practice quality rather than a real lead's call.
  ESCALATE_AT_OR_BELOW: 2
};

function buildDailyPracticeSystemPrompt_() {
  return [
    'You are grading a rep\'s SOLO PRACTICE DRILL — not a real sales call. There is no lead on this',
    'recording; the rep is practicing alone or role-playing both sides to rehearse one of our two named',
    'skills. First decide which one this drill is:',
    '  OBJECTION HANDLING = Agree, Isolate, Repeat. Agree with the objection\'s premise, isolate it as the',
    '    one thing standing in the way, then repeat/confirm that back before answering it.',
    '  ASKING FOR THE MONEY = a direct line, e.g. "Ready to get started?" — not a soft/open question. Ideally',
    '    asked MORE THAN ONCE: ask it, then whatever comes back is either another objection (loop back into',
    '    Agree/Isolate/Repeat, then ask again) or a yes (go straight to payment).',
    '',
    'If drill_type is "close_ask", answer, in order:',
    '1. Did they use the direct line (or a clear equivalent) rather than a soft/open question? Quote it.',
    '2. Did they ask more than once — i.e. handle whatever came back (objection or hesitation) and ask',
    '   again, rather than asking once and moving on?',
    '3. Delivery: confident and natural, or hesitant/reading off a script woodenly?',
    '4. What is the single most specific thing to sharpen before their next live call?',
    'Score anchors for overall_score (1-5) on a close_ask drill:',
    '5 = direct line used, asked more than once with a real branch (objection-loop or payment), confident.',
    '4 = direct line used and repeated, but delivery or the branch handling was a little off.',
    '3 = direct line used once, but no repeat attempt after the first response.',
    '2 = only a soft/open question substituted for the direct ask — no real close-ask practiced.',
    '1 = did not attempt the ask at all, or the drill doesn\'t show real practice.',
    '',
    'If drill_type is "objection", answer, in order:',
    '1. Which objection type were they practicing (budget, third-party approval, timing, ROI/proof,',
    '   compliance, competitor comparison, trust/prior bad experience, or other — name it specifically)?',
    '2. Did they actually run Agree, Isolate, Repeat — or use a concrete technique (a number, a case study,',
    '   a specific script line) — rather than vague reassurance?',
    '3. Delivery: confident and natural, or hesitant/reading off a script woodenly?',
    '4. What is the single most specific thing to sharpen before their next live call?',
    'Score anchors for overall_score (1-5) on an objection drill:',
    '5 = clear objection named, Agree/Isolate/Repeat (or an equally concrete technique) used, confident.',
    '4 = concrete technique used, but delivery or objection-framing was a little off.',
    '3 = attempted a technique but it stayed generic/vague rather than concrete.',
    '2 = no real technique — just repeated reassurance or changed the subject.',
    '1 = did not engage with the objection at all, or the drill doesn\'t show real practice.',
    '',
    'Be skeptical by default — a rep going through the motions without a real attempt should score low',
    'even if their delivery is smooth.',
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text, in this exact shape:',
    '',
    '{',
    '  "reasoning": "string",',
    '  "drill_type": "objection | close_ask",',
    '  "objection_type": "string — the objection practiced, or \\"n/a\\" if drill_type is close_ask",',
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
    (obj.drill_type === 'objection' || obj.drill_type === 'close_ask') &&
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
    drill_type: 'objection',
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
  var focusLine = result.drill_type === 'close_ask'
    ? 'Drill: Asking for the money'
    : 'Objection practiced: ' + result.objection_type;
  var body =
    'Hi ' + rep + ',\n\n' +
    'Feedback on today\'s practice drill ("' + fileName + '"):\n\n' +
    focusLine + '\n' +
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
/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewDailyPracticeGrading() {
  return previewDailyPracticeGrading_();
}

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
 * Daily assignment pass — for each rep, on a training-cycle weekday (Wed-Tue,
 * skips weekends), sends that day's objection-drill assignment: the specific
 * objections stored from their last training call (Phase 6's
 * TRAINING_OBJECTIONS_<rep> property) plus the delivery folder link. Falls
 * back to a generic "record something" nudge if no training has landed yet
 * for that rep (e.g. before their first Tuesday session).
 */
function sendDailyPracticeReminders_() {
  RUN_TAG = 'sendDailyPracticeReminders_';
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var label = computeTrainingCycleLabel_(new Date(), tz);
  if (!label) { log_('Weekend — no daily practice assignment today.'); return; }

  Object.keys(DAILY_PRACTICE_CONFIG.FOLDERS).forEach(function (rep) {
    var repCfg = CONFIG.REPS.filter(function (r) { return r.name === rep; })[0];
    if (!repCfg) { log_('No CONFIG.REPS entry for "' + rep + '" — skipping assignment.'); return; }

    var folderId = DAILY_PRACTICE_CONFIG.FOLDERS[rep];
    var folderLink = 'https://drive.google.com/drive/folders/' + folderId;
    var stored = PropertiesService.getScriptProperties().getProperty('TRAINING_OBJECTIONS_' + rep);
    var objections = stored ? JSON.parse(stored) : null;
    var storedCloseAsk = PropertiesService.getScriptProperties().getProperty('TRAINING_CLOSE_DRILL_' + rep);
    var closeAsk = storedCloseAsk ? JSON.parse(storedCloseAsk) : null;

    // Alternate which skill gets today's assignment when both are on file, so reps
    // get dedicated close-ask reps rather than it always riding along after
    // objections (or being crowded out of a single day's recording). Objection days
    // fall on the "day" index computeTrainingCycleLabel_ assigns; close-ask takes
    // the other days once a close-ask drill actually exists on file.
    var assignCloseAskToday = closeAsk && (!objections || !objections.length || (label.day % 2 === 1));

    var subject, body, htmlBody;
    if (assignCloseAskToday) {
      subject = label.label + ' — Training Plan';
      body =
        'Record a video practicing ASKING FOR THE MONEY:\n\n' +
        '"' + closeAsk.label + '" — ' + closeAsk.note + '\n\n' +
        'Ask it, handle whatever comes back (objection or hesitation), then ask again — don\'t stop at one ask.\n\n' +
        'Delivery folder: ' + folderLink + '\n\n' +
        '— Automated daily assignment. Reply to Kris or Tomás with any issues.';
      htmlBody =
        '<p>Record a video practicing <b>ASKING FOR THE MONEY</b>:</p>' +
        '<p>"' + closeAsk.label + '" — ' + closeAsk.note + '</p>' +
        '<p>Ask it, handle whatever comes back (objection or hesitation), then ask again — don\'t stop at one ask.</p>' +
        '<p><b>Delivery folder:</b> <a href="' + folderLink + '">' + folderLink + '</a></p>' +
        '<p><i>— Automated daily assignment. Reply to Kris or Tomás with any issues.</i></p>';
    } else if (objections && objections.length) {
      subject = label.label + ' — Training Plan';
      var plainList = objections.map(function (o, i) { return (i + 1) + '. ' + o.label + ' — ' + o.note; }).join('\n');
      var htmlList = '<ol>' + objections.map(function (o) {
        return '<li><b>' + o.label + '</b> — ' + o.note + '</li>';
      }).join('') + '</ol>';

      body =
        'Record a video practicing objection handling (Agree, Isolate, Repeat):\n\n' +
        plainList + '\n\n' +
        'Delivery folder: ' + folderLink + '\n\n' +
        '— Automated daily assignment. Reply to Kris or Tomás with any issues.';

      htmlBody =
        '<p>Record a video practicing objection handling (Agree, Isolate, Repeat):</p>' +
        htmlList +
        '<p><b>Delivery folder:</b> <a href="' + folderLink + '">' + folderLink + '</a></p>' +
        '<p><i>— Automated daily assignment. Reply to Kris or Tomás with any issues.</i></p>';
    } else {
      subject = label.label + ' — Training Plan';
      body =
        'Record a video practicing objection handling (no specific objections on file yet — pick one you ' +
        'want to sharpen).\n\n' +
        'Delivery folder: ' + folderLink + '\n\n' +
        '— Automated daily assignment. Reply to Kris or Tomás with any issues.';
      htmlBody =
        '<p>Record a video practicing objection handling (no specific objections on file yet — pick one ' +
        'you want to sharpen).</p>' +
        '<p><b>Delivery folder:</b> <a href="' + folderLink + '">' + folderLink + '</a></p>' +
        '<p><i>— Automated daily assignment. Reply to Kris or Tomás with any issues.</i></p>';
    }

    if (!DAILY_PRACTICE_CONFIG.ENABLED) {
      log_('(preview, config disabled) ' + repCfg.email + ' <- ' + subject + ' (cc ' + CONFIG.TOMAS_EMAIL + ')\n' + body + '\n');
      return;
    }
    guardedSend_(repCfg.email, subject, body, { htmlBody: htmlBody, name: 'Daily Practice Reminder Bot', cc: CONFIG.TOMAS_EMAIL }, 2);
    log_('[' + rep + '] Sent ' + label.label + ' assignment' + (objections && objections.length ? '.' : ' (generic fallback — no objections on file).') + ' (cc\'d Tomás)');
  });
}

/**
 * Compliance check for the PREVIOUS training-cycle weekday's assignment —
 * did the rep (a) reply to that day's "<label> — Training Plan" email, and
 * (b) actually upload a new practice file to their Drive folder? Escalates
 * to Kris + Tomás per rep missing either. Runs once daily, an hour BEFORE
 * sendDailyPracticeReminders_ sends that day's new assignment, so it's
 * always checking on yesterday's — see COMPLIANCE_CHECK_HOUR below.
 */
function checkDailyPracticeCompliance_(dryRun) {
  RUN_TAG = 'checkDailyPracticeCompliance_';
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var label = computeTrainingCycleLabel_(yesterday, tz);
  if (!label) { log_('Yesterday was a weekend — no daily practice assignment to check.'); return; }

  var subject = label.label + ' — Training Plan';
  var sinceMidnightYesterday = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());

  Object.keys(DAILY_PRACTICE_CONFIG.FOLDERS).forEach(function (rep) {
    var repCfg = CONFIG.REPS.filter(function (r) { return r.name === rep; })[0];
    if (!repCfg) { log_('No CONFIG.REPS entry for "' + rep + '" — skipping compliance check.'); return; }

    var replied = false;
    GmailApp.search('subject:"' + subject + '" to:' + repCfg.email + ' newer_than:2d', 0, 5).forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        if (msg.getFrom().indexOf(repCfg.email) !== -1) replied = true;
      });
    });

    var folder = DriveApp.getFolderById(DAILY_PRACTICE_CONFIG.FOLDERS[rep]);
    var files = folder.getFiles();
    var newFile = false;
    while (files.hasNext()) {
      if (files.next().getDateCreated() >= sinceMidnightYesterday) { newFile = true; break; }
    }

    if (replied && newFile) {
      log_('[' + rep + '] Compliant — replied to "' + subject + '" and uploaded a new file.');
      return;
    }

    var missing = [];
    if (!replied) missing.push('no reply to the "' + subject + '" email');
    if (!newFile) missing.push('no new file uploaded to their practice folder');
    var alertSubject = '[Daily Practice] ' + rep + ' missed yesterday\'s assignment';
    var alertBody = rep + ' — ' + missing.join(' and ') + ' (checking against "' + subject + '").\n\n' +
      'Folder: https://drive.google.com/drive/folders/' + DAILY_PRACTICE_CONFIG.FOLDERS[rep];

    if (dryRun) {
      log_('(preview) ' + CONFIG.KRIS_EMAIL + ' <- ' + alertSubject + ' (cc ' + CONFIG.TOMAS_EMAIL + ')\n' + alertBody);
      return;
    }
    guardedSend_(CONFIG.KRIS_EMAIL, alertSubject, alertBody, { cc: CONFIG.TOMAS_EMAIL, name: 'Daily Practice Compliance Bot' }, 2);
    log_('[' + rep + '] NON-COMPLIANT — ' + missing.join(' and ') + '. Alerted Kris/Tomás.');
  });
}

/** Run this FIRST from the editor — logs compliance findings, sends nothing. */
/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewDailyPracticeCompliance() {
  return previewDailyPracticeCompliance_();
}

function previewDailyPracticeCompliance_() {
  RUN_TAG = 'previewDailyPracticeCompliance_';
  log_('PREVIEW MODE — checking yesterday\'s daily practice compliance, nothing will be sent.');
  checkDailyPracticeCompliance_(/*dryRun=*/true);
}

/** Trigger target. */
function runDailyPracticeCompliance() {
  RUN_TAG = 'runDailyPracticeCompliance';
  if (!DAILY_PRACTICE_CONFIG.ENABLED) { log_('DAILY_PRACTICE_CONFIG.ENABLED is false — skipping.'); return; }
  checkDailyPracticeCompliance_(/*dryRun=*/false);
}

function installDailySelfPracticeTriggers_() {
  RUN_TAG = 'installDailySelfPracticeTriggers_';
  ['runDailyPracticeGrading', 'sendDailyPracticeReminders_', 'runDailyPracticeCompliance'].forEach(function (handler) {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
    });
  });

  ScriptApp.newTrigger('runDailyPracticeCompliance')
    .timeBased().everyDays(1).atHour(DAILY_PRACTICE_CONFIG.COMPLIANCE_CHECK_HOUR).inTimezone(CONFIG.BUSINESS_TIMEZONE).create();
  ScriptApp.newTrigger('sendDailyPracticeReminders_')
    .timeBased().everyDays(1).atHour(DAILY_PRACTICE_CONFIG.REMINDER_HOUR).inTimezone(CONFIG.BUSINESS_TIMEZONE).create();
  ScriptApp.newTrigger('runDailyPracticeGrading')
    .timeBased().everyDays(1).atHour(DAILY_PRACTICE_CONFIG.GRADING_HOUR).inTimezone(CONFIG.BUSINESS_TIMEZONE).create();

  log_('Daily self-practice triggers installed: compliance check at ' + DAILY_PRACTICE_CONFIG.COMPLIANCE_CHECK_HOUR +
    ':00, reminders at ' + DAILY_PRACTICE_CONFIG.REMINDER_HOUR + ':00, grading at ' +
    DAILY_PRACTICE_CONFIG.GRADING_HOUR + ':00 (' + CONFIG.BUSINESS_TIMEZONE + ').');
}
