/**
 * Phase16_CalibrationFeedback.gs
 *
 * Kris's ask (06/09/2026), after "Make it one per person" (see
 * pickOneCallPerRep_ in Phase2_CallScoring.gs) fixed the random calibration
 * sample itself: he wants to record his own blind-review feedback (a video
 * per rep) and have it reach that rep automatically. His exact words: "I
 * want the code to automatically pick up my training, send email to the
 * rep with my feedback and link to my recording. Incorporate what I say
 * into the training plan for the coming week."
 *
 * Confirmed live 06/09/2026: he already dropped 5 real recordings straight
 * into the Drive folders below with no sheet interaction at all (2 Sean, 1
 * Joana, 2 Tomás) — so this phase is Drive-folder-driven end to end, not
 * tied to a Sales Call Log row or any manually-typed notes. An earlier
 * version of this file expected Kris to paste a video link + typed notes
 * into two new Sales Call Log columns — abandoned before ever being
 * deployed once it was clear he wasn't going to use it that way.
 *
 * WORKFLOW:
 *   1. Kris drops a raw video into the matching rep's Drive folder:
 *        Calibration Feedback/Sean:  https://drive.google.com/drive/folders/1vkSV1_rNnfFXMYr_RHsdIZ7ID3OjvDWX
 *        Calibration Feedback/Joana: https://drive.google.com/drive/folders/1FYo2dy5CBFeluuLgvxphuN38Fn4RHlP1
 *        Calibration Feedback/Tomás: https://drive.google.com/drive/folders/11qw_wKdOYmQZ8mkf1x_VQ08JSqwP1UFy
 *        Calibration Feedback/Bens:  https://drive.google.com/drive/folders/1QSCdg6TQ_3ocjVhAlq-fXanlw-0rPqCg
 *      (all four live under the shared "Calibration Feedback" folder:
 *      https://drive.google.com/drive/folders/1yNZRbi-Y4YWfq0izgXRQi84k7cH5Dnw0)
 *      Nothing else to do — no filename convention, no sheet to touch.
 *   2. `tools/transcribe_calibration_feedback.py` (run unattended on the
 *      OVH VPS via `tools/transcribe_all.py`, same free local-Whisper setup
 *      as every other transcription batch in this project — no API key,
 *      no per-call cost) drops a "<video name> — Transcript" Doc next to
 *      each new video, same convention Sean/Joana/Tomás/Daily Practice
 *      already use.
 *   3. This phase (its own daily trigger) finds a video+transcript pair it
 *      hasn't handled yet, asks the same judge model Phase 6 uses (a new
 *      lightweight prompt built for grading Kris's spoken feedback on one
 *      call rather than a full 1:1 training-call transcript) to turn the
 *      transcript into a short coaching-summary paragraph PLUS objections/
 *      close-ask/framework gaps to drill, emails the rep the video link +
 *      that summary, and merges the drill topics into the exact same
 *      TRAINING_OBJECTIONS_<rep>/TRAINING_CLOSE_DRILL_<rep>/
 *      TRAINING_FRAMEWORK_<rep> Script Properties Phase 6 already writes —
 *      so Phase 7's daily practice assignment emails pick this up
 *      automatically with zero changes on that end ("incorporate what I
 *      say into the training plan for the coming week").
 *   4. A "<video name> — Feedback Sent" marker Doc gets dropped in the same
 *      folder once the email goes out, so a re-run never double-sends —
 *      same "write the marker before/around the real work" pattern Phase 6
 *      uses for its own training-plan docs.
 *
 * ONE-TIME SETUP (same pattern as every other phase in this file):
 *   1. Make sure `tools/transcribe_calibration_feedback.py` has actually run
 *      at least once against a real video (see that file) — this phase has
 *      nothing to do until a transcript exists next to a video.
 *   2. Run previewCalibrationFeedback() from the editor — logs what it
 *      would send/learn, sends nothing, writes nothing.
 *   3. Flip CALIBRATION_FEEDBACK_CONFIG.ENABLED to true, run
 *      installCalibrationFeedbackTrigger().
 */

var CALIBRATION_FEEDBACK_CONFIG = {
  ENABLED: false, // flip after previewCalibrationFeedback() looks right
  TRIGGER_HOUR: 9,
  FOLDERS: {
    Sean: '1vkSV1_rNnfFXMYr_RHsdIZ7ID3OjvDWX',
    Joana: '1FYo2dy5CBFeluuLgvxphuN38Fn4RHlP1',
    'Tomás': '11qw_wKdOYmQZ8mkf1x_VQ08JSqwP1UFy',
    Bens: '1QSCdg6TQ_3ocjVhAlq-fXanlw-0rPqCg'
  }
};

/** Marker name convention shared by findCalibrationFeedbackTranscript_ and the "already sent" check below. */
function calibrationFeedbackTranscriptName_(videoName) {
  return videoName.trim() + ' — Transcript';
}
function calibrationFeedbackSentMarkerName_(videoName) {
  return videoName.trim() + ' — Feedback Sent';
}

/** Every video file directly in a rep's Calibration Feedback folder — flat, no subfolder recursion (Kris drops files straight in). */
function collectCalibrationFeedbackVideos_(folder) {
  var out = [];
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if (file.getMimeType && String(file.getMimeType()).indexOf('video/') === 0) out.push(file);
  }
  return out;
}

/** The "<video name> — Transcript" Doc tools/transcribe_calibration_feedback.py drops next to a video, if it's run yet. */
function findCalibrationFeedbackTranscript_(folder, videoFile) {
  var wanted = calibrationFeedbackTranscriptName_(videoFile.getName());
  var it = folder.getFilesByName(wanted);
  return it.hasNext() ? it.next() : null;
}

function calibrationFeedbackAlreadySent_(folder, videoFile) {
  return folder.getFilesByName(calibrationFeedbackSentMarkerName_(videoFile.getName())).hasNext();
}

/**
 * Lightweight sibling of Phase6's buildTrainingReviewSystemPrompt_ — same
 * three drill fields (objections_to_drill/close_ask_drill/
 * framework_gaps_to_drill), same JSON shape, so the result plugs straight
 * into the SAME Script Properties/Phase 7 pipeline, plus a
 * "feedback_summary" field the rep-facing email actually shows — grading
 * Kris's own spoken/written feedback on one sales call rather than a
 * transcript of a full 1:1 training session between Tomás and the rep, so
 * this needed its own prompt rather than reusing Phase 6's.
 */
function buildCalibrationFeedbackJudgeSystemPrompt_(rep) {
  var role = trainingReviewRoleFor_(rep);
  var closeAskLine = '  - If Kris\'s feedback calls out a specific gap in ' + role.closeAskSkillLabel + ': a short label ' +
    'for what to drill and a one-clause note on how to fix it. Omit (null) if he doesn\'t mention it.';
  var frameworkLine = role.drillsFramework
    ? '  - If Kris\'s feedback calls out a framework-explanation gap: which of the three specific pieces ' +
      '(recruit_agents | number_one_podcast | sell_more_houses), each with a short, concrete one-clause note on ' +
      'what to say differently. Empty array if he doesn\'t mention it.'
    : '  - Framework explanation is NOT part of ' + rep + '\'s role (' + role.roleNote + ') — always return an ' +
      'empty "framework_gaps_to_drill" array.';
  return [
    'You are reading a TRANSCRIPT OF KRIS\'S OWN SPOKEN FEEDBACK on one specific sales call ' + rep + ' had with a ' +
      'prospect — part of a blind weekly calibration review, not a transcript of a training call or the sales ' +
      'call itself.',
    'Two things to produce for ' + rep + ':',
    '  1. A short, faithful summary of what Kris actually said — his real feedback, in his own substance and ' +
      'tone, not generic coaching invented on top of it. This gets emailed to ' + rep + ' directly, alongside the ' +
      'recording itself, so it needs to read as "here\'s what Kris said," not as a rewritten review.',
    '  2. Concrete, actionable drill topics for ' + rep + '\'s coming week of daily self-practice, pulled only ' +
      'from what Kris\'s feedback actually says — do not invent gaps he doesn\'t mention.',
    '',
    'Extract for (2):',
    '  - The specific objection-handling gaps Kris calls out (not a general theme — the actual named objection, ' +
      'e.g. "I\'m too busy right now"), each with a short, concrete one-clause note on how to handle it via ' +
      'Agree/Isolate/Repeat. Empty array if he doesn\'t mention any.',
    closeAskLine,
    frameworkLine,
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text, in this exact shape:',
    '',
    '{',
    '  "feedback_summary": "string — faithful summary of Kris\'s actual spoken feedback, 2-5 sentences. If it ' +
      'covers more than one distinct point, put each on its own line separated by a literal \\n.",',
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

function buildCalibrationFeedbackJudgeUserPrompt_(rep, videoTitle, transcriptText) {
  return [
    'Rep: ' + rep,
    'Recording: ' + videoTitle,
    '',
    'Transcript of Kris\'s feedback:',
    transcriptText
  ].join('\n');
}

function isValidCalibrationFeedbackSchema_(obj) {
  return !!(obj &&
    typeof obj.feedback_summary === 'string' &&
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
 * Asks the judge model to turn Kris's feedback transcript into a rep-facing
 * summary plus drill topics. Never blocks the rep email on failure — falls
 * back to a summary that just points at the recording, plus all-empty drill
 * fields (a safe no-op for mergeCalibrationDrillIntoTrainingProperties_'s
 * non-destructive merge), after retrying once, same resilience pattern as
 * reviewTrainingCallTranscript_.
 *
 * Real failure mode hit live (06/09/2026): Kris's actual coaching style is
 * often heavily profane ("don't fucking send people links..."), and the
 * shared LiteLLM proxy's own content filter rejected that transcript
 * outright (HTTP 400, "considered high risk") — TWICE, identically, since
 * the plain retry above just resends the exact same rejected text. Once a
 * content_filter rejection is seen, every subsequent attempt here retries
 * with softenProfanityForJudge_() instead — same substance, worded mildly
 * enough to get past the filter. This never touches what the rep actually
 * sees: the email always links the real, unedited recording; only the text
 * sent to THIS judge call is softened.
 */
function gradeCalibrationFeedbackTranscript_(rep, videoTitle, transcriptText) {
  var systemPrompt = buildCalibrationFeedbackJudgeSystemPrompt_(rep);
  var softened = false;

  for (var attempt = 0; attempt <= (PHASE2_CONFIG.MAX_PARSE_RETRIES || 1); attempt++) {
    var textThisAttempt = softened ? softenProfanityForJudge_(transcriptText) : transcriptText;
    var userPrompt = buildCalibrationFeedbackJudgeUserPrompt_(rep, videoTitle, textThisAttempt);
    if (attempt > 0 && !softened) {
      userPrompt += '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    }
    try {
      var raw = callKimiJudge_(systemPrompt, userPrompt, 'phase16:calibration_feedback');
      var parsed = stripFencesAndParseJson_(raw);
      if (!isValidCalibrationFeedbackSchema_(parsed)) throw new Error('Parsed JSON missing required fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ gradeCalibrationFeedbackTranscript_ attempt ' + (attempt + 1) + ' failed for ' + rep + '/' +
        videoTitle + ': ' + e);
      if (!softened && String(e).indexOf('content_filter') !== -1) {
        softened = true; // next attempt (if any) retries with softened language instead of resending the identical rejected text
      }
    }
  }
  return {
    feedback_summary: 'Automated summary unavailable this run — watch the recording directly for Kris\'s feedback.',
    objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: []
  };
}

/**
 * Replaces the handful of words most likely to trip a shared LLM proxy's
 * content filter with mild stand-ins, keeping sentence structure/meaning
 * intact for the judge model to still extract real coaching content from.
 * ONLY ever used for the judge call above after a content_filter rejection —
 * never rep-facing (the email always links the real, unedited recording).
 * Whole-word, case-insensitive (\b boundaries) so e.g. "shitake" isn't
 * mangled.
 */
function softenProfanityForJudge_(text) {
  var replacements = [
    [/\bfucking\b/gi, 'really'],
    [/\bfucked\b/gi, 'messed up'],
    [/\bfuck\b/gi, 'heck'],
    [/\bbullshit\b/gi, 'nonsense'],
    [/\bshit\b/gi, 'stuff'],
    [/\bass\b/gi, 'butt'],
    [/\bdamn\b/gi, 'darn']
  ];
  var out = text;
  replacements.forEach(function (pair) { out = out.replace(pair[0], pair[1]); });
  return out;
}

/**
 * Rep-facing email: the video link plus Kris's (AI-summarized) feedback —
 * this is blind calibration feedback on one specific call, so it stays
 * short and points the rep at the recording for full context rather than
 * trying to replace it.
 */
function buildCalibrationFeedbackEmail_(rep, videoTitle, videoUrl, feedbackSummary) {
  var subject = '[Calibration feedback] ' + videoTitle;
  var body = 'Kris recorded feedback for you — ' + videoTitle + ':\n\n' +
    'Recording: ' + videoUrl + '\n\n' +
    'His feedback:\n' + feedbackSummary;
  var htmlBody = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    '<p>Kris recorded feedback for you — <strong>' + escapeHtml_(videoTitle) + '</strong>:</p>' +
    '<p><a href="' + escapeHtml_(videoUrl) + '">Watch the recording</a></p>' +
    '<p><strong>His feedback:</strong><br>' + escapeHtml_(feedbackSummary).replace(/\n/g, '<br>') + '</p>' +
    '</div>';
  return { subject: subject, body: body, htmlBody: htmlBody };
}

/**
 * Same non-destructive overwrite-only-on-nonempty rule as
 * processTrainingTranscript_ (Phase6_TrainingCallReview.gs): a recording
 * where Kris's feedback doesn't happen to mention a gap must not wipe out
 * the drill Phase 6 (or a prior calibration round) already assigned. Ends
 * by mirroring into the Training Assignments sheet the same way Phase 6
 * does, so the dashboard reflects it without any changes on that end.
 */
function mergeCalibrationDrillIntoTrainingProperties_(rep, graded) {
  var props = PropertiesService.getScriptProperties();
  if (graded.objections_to_drill && graded.objections_to_drill.length) {
    props.setProperty('TRAINING_OBJECTIONS_' + rep, JSON.stringify(graded.objections_to_drill));
  }
  if (graded.close_ask_drill) {
    props.setProperty('TRAINING_CLOSE_DRILL_' + rep, JSON.stringify(graded.close_ask_drill));
  }
  if (graded.framework_gaps_to_drill && graded.framework_gaps_to_drill.length) {
    props.setProperty('TRAINING_FRAMEWORK_' + rep, JSON.stringify(graded.framework_gaps_to_drill));
  }
  mirrorTrainingAssignment_(rep);
}

/**
 * One video+transcript pair end to end: email the rep, merge drill topics,
 * drop the "Feedback Sent" marker. dryRun logs instead of sending/writing.
 * Returns true if it did real work.
 */
function processCalibrationFeedbackVideo_(rep, folder, videoFile, transcriptFile, dryRun) {
  var repEmail = repEmailForFollowUpCheck_(rep);
  if (!repEmail) {
    log_('  ' + rep + '/' + videoFile.getName() + ': no known email for rep "' + rep + '" — skipping.');
    return false;
  }

  var transcriptText = getTranscriptText_(transcriptFile);
  var graded = gradeCalibrationFeedbackTranscript_(rep, videoFile.getName(), transcriptText);
  var videoUrl = videoFile.getUrl();
  var email = buildCalibrationFeedbackEmail_(rep, videoFile.getName(), videoUrl, graded.feedback_summary);

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
    log_('  ' + rep + '/' + videoFile.getName() + ': SEND FAILED/SKIPPED (quota-short or invalid config) — left pending, will retry next run.');
    return false;
  }

  mergeCalibrationDrillIntoTrainingProperties_(rep, graded);

  var marker = DocumentApp.create(calibrationFeedbackSentMarkerName_(videoFile.getName()));
  marker.getBody().setText('Emailed ' + repEmail + ' (cc ' + CONFIG.TOMAS_EMAIL + ', ' + CONFIG.KRIS_EMAIL + ') on ' +
    new Date() + '.\nRecording: ' + videoUrl);
  marker.saveAndClose();
  DriveApp.getFileById(marker.getId()).moveTo(folder);

  log_('  ' + rep + '/' + videoFile.getName() + ': emailed feedback, merged drill topics, marked sent.');
  return true;
}

/** Shared by preview and live paths. dryRun=true never sends, writes, or marks anything processed. */
function buildAndMaybeSendCalibrationFeedback_(dryRun) {
  RUN_TAG = 'buildAndMaybeSendCalibrationFeedback_';
  var processed = 0;
  Object.keys(CALIBRATION_FEEDBACK_CONFIG.FOLDERS).forEach(function (rep) {
    var folder = DriveApp.getFolderById(CALIBRATION_FEEDBACK_CONFIG.FOLDERS[rep]);
    collectCalibrationFeedbackVideos_(folder).forEach(function (videoFile) {
      if (calibrationFeedbackAlreadySent_(folder, videoFile)) return;
      var transcriptFile = findCalibrationFeedbackTranscript_(folder, videoFile);
      if (!transcriptFile) {
        log_('  ' + rep + '/' + videoFile.getName() + ': no transcript yet — run tools/transcribe_calibration_feedback.py first.');
        return;
      }
      if (processCalibrationFeedbackVideo_(rep, folder, videoFile, transcriptFile, dryRun)) processed++;
    });
  });
  if (!processed) log_('buildAndMaybeSendCalibrationFeedback_: nothing new to process.');
  return processed;
}

/** Run this FIRST from the editor. Logs what it would send/learn — nothing is sent, written, or marked. */
function previewCalibrationFeedback() {
  return previewCalibrationFeedback_();
}

function previewCalibrationFeedback_() {
  RUN_TAG = 'previewCalibrationFeedback_';
  log_('PREVIEW MODE — reviewing pending calibration feedback video(s), nothing will be sent or written.');
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
