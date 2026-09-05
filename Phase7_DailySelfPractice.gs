/**
 * Phase7_DailySelfPractice.gs
 *
 * Thao's ask (19/08/2026): every day, each rep (Bens/Sean/Joana) uploads a
 * video of themselves practicing alone. This phase grades that day's
 * practice reps and emails feedback, plus sends each rep that day's
 * assignment each training-cycle weekday — rotating across whichever of the
 * three skills (objection handling, asking for the money, and — 25/08/2026 —
 * framework explanation) actually have content on file from their last
 * training call, per Phase 6's TRAINING_OBJECTIONS_<rep>/TRAINING_CLOSE_DRILL_<rep>/
 * TRAINING_FRAMEWORK_<rep> properties.
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
 * the escalations. Each assignment tells the rep to name their file starting
 * with that day's date in YYMMDD format (Zoom's own auto-recording names,
 * e.g. "GMT20260820-085518_Recording.mp4", do NOT satisfy this — the rep
 * must rename it).
 *
 * Kris's ask (20/08/2026): a rep saying "done" in the thread isn't enough —
 * checkDailyPracticeCompliance_ now persistently reply-alls the SAME
 * assignment thread every 12h (NAG_INTERVAL_HOURS, per Kris's follow-up ask
 * 21/08/2026 — was once a day) for as long as the correctly-named file is
 * still missing from the rep's Drive folder, tracked via the "Daily Practice
 * Follow-ups" sheet tab (one open row per outstanding assignment, not just
 * yesterday's). The only way to stop the nagging on one thread is Kris or
 * Tomás replying-all on it with "cancel" or "stop" — the check looks for
 * that in every message from either of them before deciding whether to nag
 * again. This replaces the old one-shot "alert Kris/Tomás about yesterday"
 * behavior; it runs twice daily, 12h apart, at COMPLIANCE_CHECK_HOUR (its
 * own dedicated runDailyPracticeCompliance trigger) and
 * COMPLIANCE_CHECK_HOUR_PM (folded into runDailyPracticeGrading's trigger,
 * which already fires at that same hour — see that function's own comment
 * for why, added 31/08/2026 to stay under Apps Script's 20-trigger cap).
 *
 * Once the correctly-named file lands AND its transcript is ready, the
 * grading itself also lands as a reply-all on that same tracked thread
 * (deliverDailyPracticeGrading_) instead of a separate standalone email —
 * so everyone already watching the thread sees how the rep did, in place.
 * Both checkDailyPracticeCompliance_'s daily scan and the nightly
 * buildAndMaybeGradeDailyPractice_ grading pass can be the one that actually
 * delivers it, whichever finds the transcript first; a file with no tracked
 * thread (predates this system) still falls back to a standalone email.
 *
 * Reuses CONFIG, log_, guardedSend_, callKimiJudge_, stripFencesAndParseJson_,
 * getTranscriptText_, computeTrainingCycleLabel_ from Phase1/Phase2, and (as of
 * the 25/08/2026 framework-explanation drill lane) FRAMEWORK_TOPIC_LABELS_
 * from Phase6 (same-project global scope).
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
  COMPLIANCE_CHECK_HOUR_PM: 20, // 8pm — second daily compliance pass, 12h after COMPLIANCE_CHECK_HOUR, per Kris's ask (21/08/2026) that outstanding assignments get nagged twice a day, not once.
  NAG_INTERVAL_HOURS: 12, // minimum gap between reply-all nags on the same thread — paired with the two triggers above.
  // Escalate (cc Kris + Tomás) when a graded rep falls at or below this — same
  // "manual review" spirit as Phase 2's severity flag, applied to a rep's own
  // practice quality rather than a real lead's call.
  ESCALATE_AT_OR_BELOW: 2,

  // Kris's ask (01/09/2026), after Joana said the daily cadence was hard to
  // sustain alongside calls/emails/trackers/follow-ups/briefings: cut back
  // per rep instead of dropping the program. A rep not listed here (or
  // whose array doesn't include today's weekday) simply gets no assignment
  // that day — checkDailyPracticeCompliance_ only ever nags a row
  // sendDailyPracticeReminders_ actually created, so skipping the creation
  // is enough; no separate change needed there. A rep with no entry at all
  // defaults to every weekday (unchanged behavior), so adding a new rep
  // here is opt-in, not required.
  PRACTICE_DAYS: {
    Joana: ['Tuesday', 'Thursday'],
    Bens: ['Monday', 'Wednesday', 'Thursday'],
    Sean: ['Monday', 'Wednesday', 'Thursday']
  }
};

/**
 * Role-aware, same distinction Phase 6's training-call review already draws
 * (trainingReviewRoleFor_, Phase6_TrainingCallReview.gs) — real bug found
 * live (05/09/2026, Bens's "260902_objection_practice" feedback): this
 * prompt used to hardcode "ASKING FOR THE MONEY" / "go straight to payment"
 * for EVERY rep, so Bens's close_ask drill got graded and coached as if he
 * were closing for cash. Kris: "Bens is lead generation... From either he
 * is either booking a QC or a Sales call. He never asks for the money.
 * Joana, Sean, Tomas ask for the money! NOT Bens." Framework explanation
 * stays generically described below (Bens never gets assigned that lane at
 * all — role.drillsFramework gates it upstream in
 * sendDailyPracticeReminders_/Phase 6 — so no role text is needed for it
 * here).
 */
function buildDailyPracticeSystemPrompt_(rep) {
  var role = trainingReviewRoleFor_(rep);
  var closeAskLabel = role.closeAskSkillLabel.toUpperCase();
  return [
    'You are grading a rep\'s SOLO PRACTICE DRILL — not a real sales call. There is no lead on this',
    'recording; the rep is practicing alone or role-playing both sides to rehearse one of our three named',
    'skills. First decide which one this drill is:',
    '  OBJECTION HANDLING = Agree, Isolate, Repeat. Agree with the objection\'s premise, isolate it as the',
    '    one thing standing in the way, then repeat/confirm that back before answering it.',
    '  ' + closeAskLabel + ' = ' + role.closeAskSkillDescription,
    '  FRAMEWORK EXPLANATION = proactively and specifically walking through all three pieces of our value',
    '    proposition: how the podcast helps RECRUIT AGENTS, how it builds #1-PODCAST-IN-YOUR-CITY authority,',
    '    and how it helps SELL MORE HOUSES — heads off objections before a lead who never understood the',
    '    offer raises them (25/08/2026, per Kris).',
    '',
    'If drill_type is "close_ask", answer, in order:',
    '1. Did they use the direct line (or a clear equivalent) for ' + role.closeAskSkillLabel +
      ' rather than a soft/open question? Quote it.',
    '2. Did they ask more than once — i.e. handle whatever came back (objection or hesitation) and ask',
    '   again, rather than asking once and moving on?',
    '3. Delivery: confident and natural, or hesitant/reading off a script woodenly?',
    '4. What is the single most specific thing to sharpen before their next live call?',
    'Score anchors for overall_score (1-5) on a close_ask drill (' + role.closeAskSkillLabel + '):',
    '5 = direct line used, asked more than once with a real branch, confident.',
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
    'If drill_type is "framework", answer, in order:',
    '1. Which of the three pieces were they practicing (framework_topic: recruit_agents |',
    '   number_one_podcast | sell_more_houses — or "multiple" if the recording covers more than one)?',
    '2. Was the explanation clear, specific, and proactive-sounding — something that would actually land with',
    '   a real lead — rather than vague or generic ("it helps your business" with no mechanism)?',
    '3. Delivery: confident and natural, or hesitant/reading off a script woodenly?',
    '4. What is the single most specific thing to sharpen before their next live call?',
    'Score anchors for overall_score (1-5) on a framework drill:',
    '5 = clear, specific, proactive-sounding explanation of the practiced piece(s), confident delivery.',
    '4 = the substance is there but delivery was a little off, or the explanation ran a bit generic.',
    '3 = attempted an explanation but it stayed vague or generic rather than concrete.',
    '2 = only a fragment of the explanation — named the topic but didn\'t actually explain the mechanism.',
    '1 = did not attempt the explanation at all, or the drill doesn\'t show real practice.',
    '',
    'Be skeptical by default — a rep going through the motions without a real attempt should score low',
    'even if their delivery is smooth.',
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text, in this exact shape:',
    '',
    '{',
    '  "reasoning": "string",',
    '  "drill_type": "objection | close_ask | framework",',
    '  "objection_type": "string — the objection practiced, or \\"n/a\\" if drill_type is not objection",',
    '  "framework_topic": "recruit_agents | number_one_podcast | sell_more_houses | multiple | n/a — n/a unless drill_type is framework",',
    '  "technique_used": true,',
    '  "technique_description": "string",',
    '  "delivery_quality": "confident | hesitant | mixed",',
    '  "overall_score": 1,',
    '  "sharpen_next": "string — one concrete, specific thing to work on next",',
    '  "feedback_summary": "string — 2-3 sentences, coaching-ready, addressed to the rep directly. MUST',
    '    open by quoting their own words from the transcript for the single most important moment (a real',
    '    line they actually said, in quotation marks) before saying anything else — task-level feedback',
    '    tied to a specific moment lands, a bare evaluation of the person does not. Never compare this rep',
    '    to any other rep by name. If this covers more than one distinct idea (the quoted moment, then a',
    '    separate observation, then what to change), put each on its own line separated by a literal \\n —',
    '    never chain them into one dense run-on paragraph."',
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
    (obj.drill_type === 'objection' || obj.drill_type === 'close_ask' || obj.drill_type === 'framework') &&
    typeof obj.objection_type === 'string' &&
    typeof obj.framework_topic === 'string' &&
    typeof obj.technique_used === 'boolean' &&
    typeof obj.delivery_quality === 'string' &&
    typeof obj.overall_score === 'number' &&
    typeof obj.sharpen_next === 'string' &&
    typeof obj.feedback_summary === 'string');
}

/** Same retry/manual-review shape as scoreTranscript_ (Phase2), against the daily-practice drill rubric above. */
function gradeDailyPracticeTranscript_(rep, transcriptText, fileName) {
  var systemPrompt = buildDailyPracticeSystemPrompt_(rep);
  var userPrompt = buildDailyPracticeUserPrompt_(rep, transcriptText, fileName);

  for (var attempt = 0; attempt <= (PHASE2_CONFIG.MAX_PARSE_RETRIES || 1); attempt++) {
    var promptForThisAttempt = attempt === 0
      ? userPrompt
      : userPrompt + '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    try {
      var raw = callKimiJudge_(systemPrompt, promptForThisAttempt, 'phase7:daily_practice');
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
    framework_topic: 'n/a',
    technique_used: false,
    technique_description: '',
    delivery_quality: 'mixed',
    overall_score: 3, // neutral, not escalation-triggering, since this is a pipeline failure not a rep failure
    sharpen_next: 'Automated grading failed to parse twice — review manually: ' + fileName,
    feedback_summary: 'Automated grading hit a parsing error twice in a row. Kris/Tomás: please review "' + fileName + '" by hand.'
  };
}

/**
 * QA_COACHING_RESEARCH_REPORT.md §2.1: task-level feedback ("your second
 * question closed off the discovery") helps; person-level feedback ("you
 * scored 2/5") often hurts, because it's self-directed and evaluative with
 * no task detail to act on. This leads with the judge's quoted-moment
 * feedback_summary and the single sharpen_next behavior, and pushes the
 * score/technique/delivery breakdown below the fold as a "for the record"
 * section rather than the headline — same information, reordered so the
 * first thing a rep reads is a concrete moment, not a number.
 */
/** Green at/above 4, amber at 3, red at/below ESCALATE_AT_OR_BELOW (2) — same score the escalation logic already treats as needing attention. */
function dailyPracticeScoreColor_(score) {
  if (score <= DAILY_PRACTICE_CONFIG.ESCALATE_AT_OR_BELOW) return '#c0392b';
  if (score < 4) return '#b8860b';
  return '#1a7a3c';
}

/**
 * `links` is {recordingUrl, transcriptUrl} — either may be missing (a
 * moved/deleted source file, or an old email built before this existed) and
 * is simply omitted rather than shown as a broken link. Kris, 05/09/2026,
 * looking at a 1/5 escalation with no way to verify it himself: "Include
 * the link to the recording and transcript so I can easily check myself.
 * This one needs checking. What is the link?" — there wasn't one.
 */
function buildDailyPracticeFeedbackEmail_(rep, fileName, result, links) {
  links = links || {};
  var subject = 'Practice Drill Feedback — ' + fileName;
  var closeAskLabel = trainingReviewRoleFor_(rep).closeAskSkillLabel;
  var focusLine = result.drill_type === 'close_ask'
    ? 'Drill: ' + closeAskLabel.charAt(0).toUpperCase() + closeAskLabel.slice(1)
    : result.drill_type === 'framework'
      ? 'Drill: Framework explanation (' + result.framework_topic + ')'
      : 'Objection practiced: ' + result.objection_type;
  var techniqueLine = result.technique_used ? 'Yes — ' + result.technique_description : 'No';
  var linkLines = [];
  if (links.recordingUrl) linkLines.push('Recording: ' + links.recordingUrl);
  if (links.transcriptUrl) linkLines.push('Transcript: ' + links.transcriptUrl);
  var body =
    'Hi ' + rep + ',\n\n' +
    'On today\'s practice drill ("' + fileName + '"):\n\n' +
    result.feedback_summary + '\n\n' +
    'One thing to sharpen next: ' + result.sharpen_next + '\n\n' +
    '— For the record —\n' +
    focusLine + '\n' +
    'Technique used: ' + techniqueLine + '\n' +
    'Delivery: ' + result.delivery_quality + '\n' +
    'Score: ' + result.overall_score + '/5\n\n' +
    (linkLines.length ? linkLines.join('\n') + '\n\n' : '') +
    '— This is an automated review of your practice drill. Drafted by AI; reply to Kris or Tomás with any issues.';

  // Kris's ask (29/08/2026): the plain-text version above reads as a wall of
  // text — bold/italic + color on the score, same "for the record, styled"
  // treatment already given to the Handoff Brief and Weekly Scorecard
  // emails. escapeHtml_ (Phase4_InboxSLA.gs) guards every AI-generated/
  // dynamic field since this is raw HTML, not Jinja.
  //
  // Kris's follow-up ask (31/08/2026): italicize quoted transcript excerpts
  // (a real line the rep actually said, in quotation marks — always present
  // per feedback_summary's own schema requirement above) so they read as
  // quotes rather than plain narration, and render "For the record" as a
  // real bulleted list instead of <br>-separated lines.
  var quoted = escapeHtml_(result.feedback_summary)
    .replace(/\n/g, '<br>')
    .replace(/"([^"]+)"/g, '<i>&quot;$1&quot;</i>');
  var htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    '<p>Hi ' + escapeHtml_(rep) + ',</p>' +
    '<p>On today\'s practice drill (<i>"' + escapeHtml_(fileName) + '"</i>):</p>' +
    '<p>' + quoted + '</p>' +
    '<p><strong>One thing to sharpen next:</strong> ' + escapeHtml_(result.sharpen_next) + '</p>' +
    '<p style="margin:16px 0 4px 0;"><strong style="color:#1a56db;">FOR THE RECORD</strong></p>' +
    '<ul style="margin:0;padding-left:20px;">' +
    '<li>' + escapeHtml_(focusLine) + '</li>' +
    '<li><strong>Technique used:</strong> ' + escapeHtml_(techniqueLine) + '</li>' +
    '<li><strong>Delivery:</strong> ' + escapeHtml_(result.delivery_quality) + '</li>' +
    '<li><strong>Score:</strong> <strong style="color:' + dailyPracticeScoreColor_(result.overall_score) + ';">' +
    escapeHtml_(String(result.overall_score)) + '/5</strong></li>' +
    '</ul>' +
    (linkLines.length
      ? '<p style="margin:12px 0 4px 0;">' +
        (links.recordingUrl ? '<a href="' + links.recordingUrl + '">Recording</a>' : '') +
        (links.recordingUrl && links.transcriptUrl ? ' &nbsp;|&nbsp; ' : '') +
        (links.transcriptUrl ? '<a href="' + links.transcriptUrl + '">Transcript</a>' : '') +
        '</p>'
      : '') +
    '<p style="color:#666;font-size:12px;margin-top:16px;"><i>— This is an automated review of your practice ' +
    'drill. Drafted by AI; reply to Kris or Tomás with any issues.</i></p>' +
    '</div>';

  return { subject: subject, body: body, htmlBody: htmlBody };
}

/**
 * The "<transcript doc name minus its trailing "— Transcript"> — Feedback"
 * name — shared by dailyPracticeAlreadyGraded_ and deliverDailyPracticeGrading_
 * so the two can never drift apart (real risk: transcribe_daily_practice.py
 * names the doc "<video name, extension included> — Transcript", so there is
 * no separate extension to strip here — a second .replace() trying to strip
 * one would either no-op or, for a differently-shaped name, strip the wrong
 * thing and leave the two functions building non-matching names, which would
 * make dailyPracticeAlreadyGraded_ never find its own output and re-grade/
 * re-send the same file forever).
 */
function dailyPracticeFeedbackDocName_(transcriptDocName) {
  return transcriptDocName.replace(/[—-]?\s*Transcript\s*$/i, '').trim() + ' — Feedback';
}

/**
 * Same strip as dailyPracticeFeedbackDocName_, without appending " —
 * Feedback" — this is the SOURCE video/recording's own name, per
 * transcribe_daily_practice.py's convention ("<video name, extension
 * included> — Transcript"). Used to look the source file back up so its
 * link can go in the feedback email (Kris, 05/09/2026: "Include the link to
 * the recording and transcript so I can easily check myself" — a real
 * escalation-worthy grade had no way to verify without manually hunting
 * through Drive).
 */
function dailyPracticeSourceFileName_(transcriptDocName) {
  return transcriptDocName.replace(/[—-]?\s*Transcript\s*$/i, '').trim();
}

/**
 * Files directly in `folder`, PLUS one level into any of its subfolders.
 * Real bug (confirmed live 28/08/2026): Bens' Zoom-exported recordings
 * landed inside a same-named subfolder (e.g. a "260827_objection_practice.mp4"
 * FOLDER containing the actual .mp4 inside it) instead of directly in his
 * practice folder — DriveApp.getFiles() never recurses, so every scan in
 * this file was completely blind to 5 real completed drills, going back to
 * 260819. transcribe_daily_practice.py apparently does recurse (real
 * Transcript docs already existed for these), so this brings the grading
 * side in line with it rather than requiring every rep to avoid ever
 * nesting an upload. Returns a flat array of File objects.
 */
function listDailyPracticeFilesRecursive_(folder) {
  var out = [];
  var files = folder.getFiles();
  while (files.hasNext()) out.push(files.next());
  var subfolders = folder.getFolders();
  while (subfolders.hasNext()) {
    var subFiles = subfolders.next().getFiles();
    while (subFiles.hasNext()) out.push(subFiles.next());
  }
  return out;
}

/** Finds a file by exact name in `folder` or one level into a subfolder — same recursion as listDailyPracticeFilesRecursive_. Returns the File or null. */
function findDailyPracticeFileByName_(folder, name) {
  var direct = folder.getFilesByName(name);
  if (direct.hasNext()) return direct.next();
  var subfolders = folder.getFolders();
  while (subfolders.hasNext()) {
    var match = subfolders.next().getFilesByName(name);
    if (match.hasNext()) return match.next();
  }
  return null;
}

/** True if a "<title> — Feedback" Doc already sits next to this practice file. */
function dailyPracticeAlreadyGraded_(folder, fileName) {
  return !!findDailyPracticeFileByName_(folder, dailyPracticeFeedbackDocName_(fileName));
}

/**
 * Delivers one graded file's feedback and writes the "<title> — Feedback" Doc
 * artifact. If replyThreadId is given (the original assignment thread, from
 * the "Daily Practice Follow-ups" sheet), replies-all on THAT thread instead
 * of sending a standalone email — per Kris (20/08/2026): once the thread's
 * assignment is picked up as complete, the grading should land as a reply on
 * the same thread everyone's already watching, not a separate email. Falls
 * back to a standalone email to the rep (the pre-existing behavior) when no
 * tracked thread is found — e.g. a backlog file that predates this tracking.
 */
function deliverDailyPracticeGrading_(rep, repCfg, folder, name, result, email, escalate, dryRun, replyThreadId) {
  if (dryRun) {
    log_('(preview) ' + (replyThreadId ? 'reply-all on tracked thread ' + replyThreadId : repCfg.email) +
      ' <- ' + email.subject + ' [CC Kris+Tomás]' +
      (escalate ? ' [score <= ' + DAILY_PRACTICE_CONFIG.ESCALATE_AT_OR_BELOW + ' — escalation]' : '') +
      '\n' + email.body + '\n');
    return true;
  }

  var sent;
  if (replyThreadId) {
    var thread = GmailApp.getThreadById(replyThreadId);
    if (thread) {
      sent = guardedReplyAll_(thread, email.body,
        { cc: CONFIG.KRIS_EMAIL + ',' + CONFIG.TOMAS_EMAIL, name: 'Daily Practice Feedback Bot', htmlBody: email.htmlBody }, 3);
      if (sent) {
        log_('  [' + rep + '] Graded "' + name + '" (' + result.overall_score + '/5) — replied on tracked assignment thread.');
      } else {
        log_('  [' + rep + '] Graded "' + name + '" (' + result.overall_score + '/5) but reply-all SEND FAILED/SKIPPED — feedback doc not written.');
        return false;
      }
    } else {
      log_('  [' + rep + '] Tracked thread ' + replyThreadId + ' no longer exists — falling back to a standalone email.');
      replyThreadId = null;
    }
  }
  if (!replyThreadId) {
    // Kris's ask (01/09/2026): CC Kris/Tomás on every practice feedback
    // email, not just escalations — same as the reply-all path above
    // already does unconditionally. escalate no longer changes who's CC'd,
    // only the log line below.
    var sendOptions = {
      name: 'Daily Practice Feedback Bot',
      htmlBody: email.htmlBody,
      cc: CONFIG.KRIS_EMAIL + ',' + CONFIG.TOMAS_EMAIL
    };
    var recipientsNeeded = 3;
    sent = guardedSend_(repCfg.email, email.subject, email.body, sendOptions, recipientsNeeded);
    if (!sent) {
      log_('  [' + rep + '] Graded "' + name + '" (' + result.overall_score + '/5) but SEND FAILED/SKIPPED — feedback doc not written.');
      return false;
    }
    log_('  [' + rep + '] Graded "' + name + '" (' + result.overall_score + '/5), CC\'d Kris/Tomás' +
      (escalate ? ' (score <= ' + DAILY_PRACTICE_CONFIG.ESCALATE_AT_OR_BELOW + ' — escalation).' : '.'));
  }

  var doc = DocumentApp.create(dailyPracticeFeedbackDocName_(name));
  doc.getBody().setText(email.body);
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(folder);
  return true;
}

/**
 * Real bug (confirmed live 28/08/2026, Sean's "260820" file): a plain
 * substring check ("Transcript" anywhere in the name) also matched a "<...>
 * — Feedback" doc whose OWN name still contained the word "Transcript" from
 * an earlier mis-stripped ancestor (dailyPracticeFeedbackDocName_ only
 * strips "Transcript" when it's at the very END of the name — a malformed
 * transcript doc with "Transcript" in the middle survives the strip
 * untouched). That Feedback doc then got graded AS IF it were a fresh
 * transcript, and a new "... — Feedback — Feedback" doc landed the next
 * day — every day, forever. Only the actual naming convention ("<video
 * name> — Transcript", see transcribe_daily_practice.py) should count.
 */
function isDailyPracticeTranscriptDocName_(name) {
  return /Transcript\s*$/i.test(name);
}

/**
 * Real bug (confirmed live 28/08/2026): Sean uploaded "260827 budget/
 * partner/hospital" for the assignment dated 260826 — he named it with the
 * day he ACTUALLY recorded it (correct per the naming instructions), one
 * day late, not the assignment's own date. An exact match on the
 * assignment's dateStr then never fires and the thread nags forever even
 * though a real, correctly-dated submission is sitting right there.
 * Picks the earliest name whose 6-digit date prefix is on/after
 * assignmentDateStr, excluding "— Transcript"/"— Feedback" docs (which
 * carry the same date prefix as their source video). Returns null if
 * nothing qualifies.
 */
function selectLateDailyPracticeFileName_(names, assignmentDateStr) {
  var bestDate = null, bestName = null;
  names.forEach(function (n) {
    if (/Transcript|Feedback/i.test(n)) return;
    var m = n.match(/^(\d{6})\b/);
    if (!m) return;
    var candidateDate = Number(m[1]);
    if (candidateDate < Number(assignmentDateStr)) return; // dated before the assignment — not this one
    if (bestDate === null || candidateDate < bestDate) {
      bestDate = candidateDate;
      bestName = n;
    }
  });
  return bestName;
}

/** Shared by preview and live paths. dryRun=true never sends and never writes a Feedback doc. */
function buildAndMaybeGradeDailyPractice_(dryRun) {
  Object.keys(DAILY_PRACTICE_CONFIG.FOLDERS).forEach(function (rep) {
    var repCfg = CONFIG.REPS.filter(function (r) { return r.name === rep; })[0];
    if (!repCfg) { log_('No CONFIG.REPS entry for "' + rep + '" — skipping.'); return; }

    var folder = DriveApp.getFolderById(DAILY_PRACTICE_CONFIG.FOLDERS[rep]);
    var found = 0, processed = 0;

    listDailyPracticeFilesRecursive_(folder).forEach(function (file) {
      var name = file.getName();
      if (!isDailyPracticeTranscriptDocName_(name)) return; // skip source videos and anything not actually ending in "— Transcript"
      found++;

      if (!dryRun && dailyPracticeAlreadyGraded_(folder, name)) return;

      var text = getTranscriptText_(file);
      var result = gradeDailyPracticeTranscript_(rep, text, name);
      var sourceFile = findDailyPracticeFileByName_(folder, dailyPracticeSourceFileName_(name));
      var links = { transcriptUrl: file.getUrl(), recordingUrl: sourceFile ? sourceFile.getUrl() : null };
      var email = buildDailyPracticeFeedbackEmail_(rep, name, result, links);
      var escalate = result.overall_score <= DAILY_PRACTICE_CONFIG.ESCALATE_AT_OR_BELOW;
      var replyThreadId = findDailyPracticeFollowupThreadForFile_(rep, name);

      var delivered = deliverDailyPracticeGrading_(rep, repCfg, folder, name, result, email, escalate, dryRun, replyThreadId);
      if (dryRun) return;
      if (!delivered) return; // send failed/skipped — leave the thread row (if any) untouched so it's retried, not marked graded
      if (replyThreadId) markDailyPracticeFollowupGraded_(rep, replyThreadId);
      processed++;
    });

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
/**
 * Also runs the PM compliance pass (checkDailyPracticeCompliance_) before
 * grading — real bug found live (31/08/2026): a dedicated PM
 * runDailyPracticeCompliance trigger at COMPLIANCE_CHECK_HOUR_PM used to
 * exist alongside this one, but that pushed the project over Apps Script's
 * hard 20-installable-trigger cap. GRADING_HOUR and
 * COMPLIANCE_CHECK_HOUR_PM were already both 20 (8pm) — same hour, same
 * timezone — so folding the PM compliance pass into this already-scheduled
 * firing is behaviorally identical to the old dedicated trigger (same exact
 * time, same day-of-week cadence) and frees a trigger slot permanently.
 * checkDailyPracticeCompliance_ isn't lock-guarded itself (see
 * runDailyPracticeCompliance's own wrapper, which has none either), so it's
 * safe to call before acquiring the grading lock below.
 */
function runDailyPracticeGrading() {
  RUN_TAG = 'runDailyPracticeGrading';
  if (!DAILY_PRACTICE_CONFIG.ENABLED) { log_('DAILY_PRACTICE_CONFIG.ENABLED is false — skipping.'); return; }
  checkDailyPracticeCompliance_(/*dryRun=*/false);
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
 * True unless the rep has a DAILY_PRACTICE_CONFIG.PRACTICE_DAYS entry that
 * excludes today's weekday. A rep with no entry at all gets every weekday
 * (the original behavior, before per-rep cadence existed).
 */
function repHasPracticeToday_(rep, weekday) {
  var practiceDays = DAILY_PRACTICE_CONFIG.PRACTICE_DAYS[rep];
  if (!practiceDays) return true;
  return practiceDays.indexOf(weekday) !== -1;
}

/**
 * Daily assignment pass — for each rep, on a training-cycle weekday (Wed-Tue,
 * skips weekends) that's also one of THEIR OWN practice days
 * (DAILY_PRACTICE_CONFIG.PRACTICE_DAYS, per-rep cadence added 01/09/2026),
 * sends that day's objection-drill assignment: the specific objections
 * stored from their last training call (Phase 6's TRAINING_OBJECTIONS_<rep>
 * property) plus the delivery folder link. Falls back to a generic "record
 * something" nudge if no training has landed yet for that rep (e.g. before
 * their first Tuesday session).
 */
function sendDailyPracticeReminders_() {
  RUN_TAG = 'sendDailyPracticeReminders_';
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var now = new Date();
  var label = computeTrainingCycleLabel_(now, tz);
  if (!label) { log_('Weekend — no daily practice assignment today.'); return; }
  var dateStr = Utilities.formatDate(now, tz, 'yyMMdd');
  var namingLine = 'Name the file starting with today\'s date, ' + dateStr +
    ' (e.g. "' + dateStr + '_objection_practice.mp4") — Zoom\'s own auto-recording name does not count, rename it.';
  var namingLineHtml = 'Name the file starting with today\'s date, <b>' + dateStr +
    '</b> (e.g. "' + dateStr + '_objection_practice.mp4") — Zoom\'s own auto-recording name does not count, rename it.';
  var todayWeekday = Utilities.formatDate(now, tz, 'EEEE');

  Object.keys(DAILY_PRACTICE_CONFIG.FOLDERS).forEach(function (rep) {
    var repCfg = CONFIG.REPS.filter(function (r) { return r.name === rep; })[0];
    if (!repCfg) { log_('No CONFIG.REPS entry for "' + rep + '" — skipping assignment.'); return; }

    if (!repHasPracticeToday_(rep, todayWeekday)) {
      log_('[' + rep + '] Not one of their practice days (' + todayWeekday + ') — skipping assignment.');
      return;
    }

    var folderId = DAILY_PRACTICE_CONFIG.FOLDERS[rep];
    var folderLink = 'https://drive.google.com/drive/folders/' + folderId;
    var stored = PropertiesService.getScriptProperties().getProperty('TRAINING_OBJECTIONS_' + rep);
    var objections = stored ? JSON.parse(stored) : null;
    var storedCloseAsk = PropertiesService.getScriptProperties().getProperty('TRAINING_CLOSE_DRILL_' + rep);
    var closeAsk = storedCloseAsk ? JSON.parse(storedCloseAsk) : null;
    var storedFramework = PropertiesService.getScriptProperties().getProperty('TRAINING_FRAMEWORK_' + rep);
    var frameworkGaps = storedFramework ? JSON.parse(storedFramework) : null;

    // Rotate today's assignment across whichever of the three skills actually
    // have content on file, so reps get dedicated reps on each rather than
    // objections always crowding out the others (25/08/2026: generalized from
    // the original 2-way objections/close-ask alternation to 3 lanes, same
    // "don't always ride along after objections" reasoning, extended).
    // Objections stays the fallback lane when nothing is on file at all
    // (unchanged behavior — see the final else branch below).
    var availableLanes = [];
    if (closeAsk) availableLanes.push('close_ask');
    if (frameworkGaps && frameworkGaps.length) availableLanes.push('framework');
    if (objections && objections.length) availableLanes.push('objection');
    // label.day is 1-based (Wed=1..Tue=5, see TRAINING_CYCLE_DAY_BY_WEEKDAY_)
    // against this 0-based lanes array — `label.day - 1` before the modulo so
    // day 1 actually lands on lane 0 and the rotation is a clean round-robin,
    // rather than every day landing one lane off from where an 0-based reader
    // would expect (real bug L-12).
    var todaysLane = availableLanes.length ? availableLanes[(label.day - 1) % availableLanes.length] : 'objection';
    var assignCloseAskToday = todaysLane === 'close_ask';
    var assignFrameworkToday = todaysLane === 'framework';

    var subjectPrefix = rep + ' — ' + label.label + ' — Training Plan';
    var subject, body, htmlBody;
    if (assignFrameworkToday) {
      subject = subjectPrefix;
      var frameworkLabelFor = function (f) { return (FRAMEWORK_TOPIC_LABELS_[f.topic] || f.topic); };
      var frameworkPlainList = frameworkGaps.map(function (f, i) {
        return (i + 1) + '. ' + frameworkLabelFor(f) + ' — ' + f.note;
      }).join('\n');
      var frameworkHtmlList = '<ol>' + frameworkGaps.map(function (f) {
        return '<li><b>' + frameworkLabelFor(f) + '</b> — ' + f.note + '</li>';
      }).join('') + '</ol>';

      body =
        'Record a VIDEO practicing FRAMEWORK EXPLANATION — walk through this like you\'re actually pitching a lead:\n\n' +
        frameworkPlainList + '\n\n' +
        namingLine + '\n\n' +
        'Transcript happens automatically once the video lands — nothing else to upload.\n\n' +
        'Delivery folder: ' + folderLink + '\n\n' +
        '— Automated daily assignment. Reply to Kris or Tomás with any issues.';
      htmlBody =
        '<p>Record a <b>video</b> practicing <b>FRAMEWORK EXPLANATION</b> — walk through this like you\'re actually pitching a lead:</p>' +
        frameworkHtmlList +
        '<p>' + namingLineHtml + '</p>' +
        '<p><i>Transcript happens automatically once the video lands — nothing else to upload.</i></p>' +
        '<p><b>Delivery folder:</b> <a href="' + folderLink + '">' + folderLink + '</a></p>' +
        '<p><i>— Automated daily assignment. Reply to Kris or Tomás with any issues.</i></p>';
    } else if (assignCloseAskToday) {
      subject = subjectPrefix;
      body =
        'Record a VIDEO practicing ASKING FOR THE MONEY:\n\n' +
        '"' + closeAsk.label + '" — ' + closeAsk.note + '\n\n' +
        'Ask it, handle whatever comes back (objection or hesitation), then ask again — don\'t stop at one ask.\n\n' +
        namingLine + '\n\n' +
        'Transcript happens automatically once the video lands — nothing else to upload.\n\n' +
        'Delivery folder: ' + folderLink + '\n\n' +
        '— Automated daily assignment. Reply to Kris or Tomás with any issues.';
      htmlBody =
        '<p>Record a <b>video</b> practicing <b>ASKING FOR THE MONEY</b>:</p>' +
        '<p>"' + closeAsk.label + '" — ' + closeAsk.note + '</p>' +
        '<p>Ask it, handle whatever comes back (objection or hesitation), then ask again — don\'t stop at one ask.</p>' +
        '<p>' + namingLineHtml + '</p>' +
        '<p><i>Transcript happens automatically once the video lands — nothing else to upload.</i></p>' +
        '<p><b>Delivery folder:</b> <a href="' + folderLink + '">' + folderLink + '</a></p>' +
        '<p><i>— Automated daily assignment. Reply to Kris or Tomás with any issues.</i></p>';
    } else if (objections && objections.length) {
      subject = subjectPrefix;
      var plainList = objections.map(function (o, i) { return (i + 1) + '. ' + o.label + ' — ' + o.note; }).join('\n');
      var htmlList = '<ol>' + objections.map(function (o) {
        return '<li><b>' + o.label + '</b> — ' + o.note + '</li>';
      }).join('') + '</ol>';

      body =
        'Record a VIDEO practicing objection handling (Agree, Isolate, Repeat):\n\n' +
        plainList + '\n\n' +
        namingLine + '\n\n' +
        'Transcript happens automatically once the video lands — nothing else to upload.\n\n' +
        'Delivery folder: ' + folderLink + '\n\n' +
        '— Automated daily assignment. Reply to Kris or Tomás with any issues.';

      htmlBody =
        '<p>Record a <b>video</b> practicing objection handling (Agree, Isolate, Repeat):</p>' +
        htmlList +
        '<p>' + namingLineHtml + '</p>' +
        '<p><i>Transcript happens automatically once the video lands — nothing else to upload.</i></p>' +
        '<p><b>Delivery folder:</b> <a href="' + folderLink + '">' + folderLink + '</a></p>' +
        '<p><i>— Automated daily assignment. Reply to Kris or Tomás with any issues.</i></p>';
    } else {
      subject = subjectPrefix;
      body =
        'Record a VIDEO practicing objection handling (no specific objections on file yet — pick one you ' +
        'want to sharpen).\n\n' +
        namingLine + '\n\n' +
        'Transcript happens automatically once the video lands — nothing else to upload.\n\n' +
        'Delivery folder: ' + folderLink + '\n\n' +
        '— Automated daily assignment. Reply to Kris or Tomás with any issues.';
      htmlBody =
        '<p>Record a <b>video</b> practicing objection handling (no specific objections on file yet — pick one ' +
        'you want to sharpen).</p>' +
        '<p>' + namingLineHtml + '</p>' +
        '<p><i>Transcript happens automatically once the video lands — nothing else to upload.</i></p>' +
        '<p><b>Delivery folder:</b> <a href="' + folderLink + '">' + folderLink + '</a></p>' +
        '<p><i>— Automated daily assignment. Reply to Kris or Tomás with any issues.</i></p>';
    }

    if (!DAILY_PRACTICE_CONFIG.ENABLED) {
      log_('(preview, config disabled) ' + repCfg.email + ' <- ' + subject + ' (cc ' + CONFIG.TOMAS_EMAIL + ')\n' + body + '\n');
      return;
    }
    // guardedSendAndGetThread_ returns the REAL sent thread directly (no
    // GmailApp.search race — see its own comment for the real bug this
    // replaced: a search-based lookup could and did track the wrong thread).
    var thread = guardedSendAndGetThread_(repCfg.email, subject, body, { htmlBody: htmlBody, name: 'Daily Practice Reminder Bot', cc: CONFIG.TOMAS_EMAIL }, 2);
    var isGenericFallback = todaysLane === 'objection' && !(objections && objections.length);
    log_('[' + rep + '] Sent ' + label.label + ' assignment (lane: ' + todaysLane + ')' +
      (isGenericFallback ? ' (generic fallback — nothing on file for any lane).' : '.') + ' (cc\'d Tomás)');
    if (!thread) return; // send failed/skipped — guardedSendAndGetThread_ already logged why

    registerDailyPracticeFollowup_(rep, dateStr, thread.getId());
  });
}

// ---------------------------------------------------------------------------
// Persistent follow-up tracking — "Daily Practice Follow-ups" sheet tab.
// One open row per outstanding assignment (rep + date), not just yesterday's.
// ---------------------------------------------------------------------------

var DAILY_PRACTICE_FOLLOWUP_SHEET_NAME = 'Daily Practice Follow-ups';
var DAILY_PRACTICE_FOLLOWUP_HEADERS = ['Rep', 'Assignment Date (YYMMDD)', 'Thread ID', 'Status', 'Last Nag At', 'Nag Count', 'Matched File'];

function getOrCreateDailyPracticeFollowupSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(DAILY_PRACTICE_FOLLOWUP_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(DAILY_PRACTICE_FOLLOWUP_SHEET_NAME);
    sheet.getRange(1, 1, 1, DAILY_PRACTICE_FOLLOWUP_HEADERS.length).setValues([DAILY_PRACTICE_FOLLOWUP_HEADERS])
      .setFontWeight('bold').setBackground('#e8eef7');
    sheet.setFrozenRows(1);
    log_('Created "' + DAILY_PRACTICE_FOLLOWUP_SHEET_NAME + '" tab.');
  } else if (sheet.getLastColumn() < DAILY_PRACTICE_FOLLOWUP_HEADERS.length) {
    // A column added to the headers constant (e.g. "Matched File",
    // 28/08/2026) after this sheet already existed live doesn't retroactively
    // appear on its own — write whatever's missing so an already-deployed
    // sheet catches up instead of every downstream getRange() silently
    // reading blank cells for a column that was never labeled.
    var missingHeaders = DAILY_PRACTICE_FOLLOWUP_HEADERS.slice(sheet.getLastColumn());
    sheet.getRange(1, sheet.getLastColumn() + 1, 1, missingHeaders.length).setValues([missingHeaders])
      .setFontWeight('bold').setBackground('#e8eef7');
  }
  return sheet;
}

/** Appends an 'open' row for rep+dateStr unless one already exists (safe to call every time an assignment sends). */
function registerDailyPracticeFollowup_(rep, dateStr, threadId) {
  var sheet = getOrCreateDailyPracticeFollowupSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var existing = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (var i = 0; i < existing.length; i++) {
      // String(): dateStr ("260819") looks numeric, so Sheets silently
      // stores it as a Number and getValues() reads it back as one — a bare
      // === against the string dateStr then always fails, letting a
      // duplicate 'open' row get appended for the same rep+day every time
      // this runs (real bug H-03).
      if (existing[i][0] === rep && String(existing[i][1]) === dateStr) return; // already tracked
    }
  }
  sheet.appendRow([rep, dateStr, threadId, 'open', '', 0, '']);
}

/** Row objects for every row currently in a given status (or any status if omitted). */
function loadDailyPracticeFollowupRows_(sheet, statusFilter) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, DAILY_PRACTICE_FOLLOWUP_HEADERS.length).getValues();
  var rows = [];
  values.forEach(function (row, i) {
    if (statusFilter && row[3] !== statusFilter) return;
    // dateStr/threadId coerced to String here (not left as whatever Sheets'
    // auto-typing produced) so every downstream === comparison against a
    // literal string works regardless of how the cell round-tripped.
    rows.push({
      rowIndex: i + 2, rep: row[0], dateStr: String(row[1]), threadId: row[2] ? String(row[2]) : '',
      status: row[3], lastNagDate: row[4], nagCount: row[5], matchedFile: row[6] ? String(row[6]) : ''
    });
  });
  return rows;
}

/** Finds the tracked assignment thread for a graded file by its leading YYMMDD prefix — null if none tracked (e.g. a pre-tracking backlog file). */
function findDailyPracticeFollowupThreadForFile_(rep, fileName) {
  var m = String(fileName).match(/^(\d{6})(?!\d)/); // (?!\d): don't misread a longer number as a 6-digit date
  if (!m) return null;
  var sheet = getOrCreateDailyPracticeFollowupSheet_();
  var rows = loadDailyPracticeFollowupRows_(sheet, null);
  var match = rows.filter(function (r) { return r.rep === rep && r.dateStr === m[1] && r.status !== 'cancelled'; })[0];
  return match ? match.threadId : null;
}

function markDailyPracticeFollowupGraded_(rep, threadId) {
  var sheet = getOrCreateDailyPracticeFollowupSheet_();
  var rows = loadDailyPracticeFollowupRows_(sheet, null);
  var match = rows.filter(function (r) { return r.rep === rep && r.threadId === threadId; })[0];
  if (match) sheet.getRange(match.rowIndex, 4).setValue('graded');
}

/**
 * True if any message in the thread from Kris or Tomás contains a standalone
 * "cancel" or "stop". Real bug (C-03): every automated message on this thread
 * is ALSO sent from the script owner's own account (kris@iconsofrealestate.com
 * — GAS sends as the project owner, `name:` only changes the display name),
 * and the nag body itself explains the words "cancel"/"stop" stop it — so
 * without excluding the bot's own messages, the very first nag would match
 * its own "From: Daily Practice Follow-up Bot <kris@...>" / own body text and
 * immediately self-cancel the thread. Every automated sender name in this
 * file ends in " Bot", so that's the exclusion signal.
 */
function dailyPracticeThreadHasStopRequest_(thread) {
  var stopRe = /\b(cancel|stop)\b/i;
  var botSenderRe = /\bBot\b/;
  return thread.getMessages().some(function (msg) {
    var from = msg.getFrom();
    if (botSenderRe.test(from)) return false; // our own automated send, not a real reply from a human
    var isKrisOrTomas = from.indexOf(CONFIG.KRIS_EMAIL) !== -1 || from.indexOf(CONFIG.TOMAS_EMAIL) !== -1;
    return isKrisOrTomas && stopRe.test(msg.getPlainBody());
  });
}

/**
 * Persistent per-assignment follow-up — replaces the old one-shot "check
 * yesterday, alert Kris/Tomás" behavior (20/08/2026, Kris's ask). Scans every
 * row in the "Daily Practice Follow-ups" sheet that isn't already resolved:
 *
 *   'open'          — no correctly-named file yet. Check for a STOP/cancel
 *                      reply from Kris or Tomás on the thread first (that
 *                      wins outright, marks 'cancelled', done). Otherwise
 *                      check the rep's folder for a file starting with that
 *                      assignment's YYMMDD; if found, mark 'file_received'
 *                      and fall through to the grading check below in the
 *                      same pass. If still missing, reply-all on the SAME
 *                      thread with a nag (once per day — a rep saying "done"
 *                      in the thread does NOT stop this, only Kris/Tomás
 *                      saying cancel/stop, or the file actually landing,
 *                      does).
 *   'file_received' — file is in, nagging already stopped. Once a matching
 *                      "<title> — Transcript" doc also exists, grades it and
 *                      replies-all on the tracked thread with the result
 *                      (buildAndMaybeGradeDailyPractice_'s nightly pass does
 *                      the same lookup, so whichever runs first delivers it).
 *
 * Runs twice daily, 12h apart (per Kris's ask 21/08/2026) — once via its own
 * trigger at COMPLIANCE_CHECK_HOUR, once folded into runDailyPracticeGrading
 * at COMPLIANCE_CHECK_HOUR_PM (31/08/2026, to stay under Apps Script's
 * 20-trigger cap — see that function's own comment). A thread's last-nag
 * timestamp (not just date) gates re-nagging so the two firings actually
 * land ~12h apart instead of collapsing to once a day.
 */
/**
 * Sorts same-file claimant rows (same rep, same matchedFile — can only exist
 * from before double-claim tracking existed) so the rightful owner comes
 * first: the claimant whose own assignment date is closest to (on or
 * before) the file's real date, i.e. the LARGEST dateStr. That's rightful
 * because selectLateDailyPracticeFileName_ always picks the EARLIEST
 * qualifying date on/after a row's own dateStr — on a clean run, the row
 * with the largest dateStr is the one that would actually have won this
 * file. Pure sort (no Sheet I/O) so repairDuplicateDailyPracticeFileClaims_
 * is testable without a fake Sheet.
 */
function sortDailyPracticeFileClaimantsByRightfulOwner_(rows) {
  return rows.slice().sort(function (a, b) { return Number(b.dateStr) - Number(a.dateStr); });
}

/**
 * One-time self-heal for rows written by the buggy pre-claim-tracking code
 * (confirmed live 28/08/2026: Sean's 260825 AND 260827 rows both pinned
 * "260827 budget/partner/hospital"). Every claim is legitimate going
 * forward (checkDailyPracticeCompliance_'s claimedFilesByRep prevents new
 * ones), but existing bad pins from before that fix need clearing — a row
 * with row.matchedFile set is trusted outright and never re-matched, so a
 * stale double-claim would otherwise be stuck forever. Reverts every
 * non-rightful claimant back to 'open' with its pin cleared so it
 * re-evaluates fresh (and gets nagged like it should have been all along).
 */
function repairDuplicateDailyPracticeFileClaims_(sheet, allRows, dryRun) {
  var byRepAndFile = {};
  allRows.forEach(function (r) {
    if (!r.matchedFile) return;
    var key = r.rep + '|' + r.matchedFile;
    byRepAndFile[key] = byRepAndFile[key] || [];
    byRepAndFile[key].push(r);
  });
  Object.keys(byRepAndFile).forEach(function (key) {
    if (byRepAndFile[key].length < 2) return;
    var claimants = sortDailyPracticeFileClaimantsByRightfulOwner_(byRepAndFile[key]);
    var rightfulOwner = claimants[0];
    claimants.slice(1).forEach(function (loser) {
      log_('[' + loser.rep + '/' + loser.dateStr + '] Repairing double-claimed file "' + loser.matchedFile +
        '" — ' + rightfulOwner.rep + '/' + rightfulOwner.dateStr + ' is the rightful match, reverting this row to open.' +
        (dryRun ? ' (preview — not written)' : ''));
      if (!dryRun) {
        sheet.getRange(loser.rowIndex, 4).setValue('open');
        sheet.getRange(loser.rowIndex, 7).setValue('');
      }
      loser.matchedFile = ''; // keep the in-memory row consistent with the sheet write for the rest of this pass
      loser.status = 'open';
    });
  });
}

/**
 * Resolves file matches for every still-unmatched row of ONE rep in a
 * single pass, so an exact match for one row's own date can never be
 * pre-empted by another row's late-submission fallback claiming it first.
 * Real bug (confirmed live 28/08/2026): rows were being resolved one at a
 * time in sheet order with a claim snapshot taken once at the start of the
 * run — 260825 (processed before 260827 in sheet order) grabbed 260827's
 * OWN exact-match file via late-fallback before 260827 ever got a turn,
 * because nothing updated the claim set mid-run. Exact matches (a file
 * whose name starts with the row's own dateStr) are claimed first, for
 * EVERY row, before any late-fallback runs at all — a row's own exact
 * match can never be stolen by another row's fallback. Only rows still
 * unmatched after that go through selectLateDailyPracticeFileName_,
 * processed in dateStr order so the earliest outstanding assignment gets
 * first claim on the earliest qualifying late file.
 *
 * rows: [{dateStr}] — every active row for this rep still needing a match.
 * candidateNames: file names in the folder, already filtered by the caller
 * to exclude generated Transcript/Feedback docs.
 * Returns {dateStr: matchedFileName} — a dateStr with no match is omitted.
 */
function resolveDailyPracticeFileMatches_(rows, candidateNames) {
  var remaining = candidateNames.slice();
  var matches = {};
  var stillUnmatched = [];

  rows.forEach(function (r) {
    var idx = -1;
    for (var i = 0; i < remaining.length; i++) {
      if (remaining[i].indexOf(r.dateStr) === 0) { idx = i; break; }
    }
    if (idx === -1) { stillUnmatched.push(r); return; }
    matches[r.dateStr] = remaining[idx];
    remaining.splice(idx, 1);
  });

  stillUnmatched
    .slice()
    .sort(function (a, b) { return Number(a.dateStr) - Number(b.dateStr); })
    .forEach(function (r) {
      var lateName = selectLateDailyPracticeFileName_(remaining, r.dateStr);
      if (!lateName) return;
      matches[r.dateStr] = lateName;
      remaining.splice(remaining.indexOf(lateName), 1);
    });

  return matches;
}

/**
 * 'cancelled' is only ever supposed to mean "a real human replied cancel/
 * stop on THIS assignment's own thread" — dailyPracticeThreadHasStopRequest_
 * is the only code path that sets it. Real bug (confirmed live 28/08/2026):
 * Bens' and Joana's 260824-260826 rows were all 'cancelled', but re-checking
 * their tracked threads directly found no real cancel/stop message from
 * Kris or Tomás anywhere. Root cause: sendDailyPracticeReminders_ used to
 * find the just-sent thread via a racy GmailApp.search() (see
 * guardedSendAndGetThread_'s own comment for the fix) that could track the
 * WRONG thread — so the original cancel check was evaluating content that
 * was never actually about this assignment. Re-verifies the same condition
 * that would have produced 'cancelled' in the first place; reverts to
 * 'open' if it no longer holds, so a row that should have been nagging the
 * whole time actually starts nagging. A thread that genuinely still has a
 * real stop request is left alone.
 */
function repairFalselyCancelledDailyPracticeRows_(sheet, allRows, dryRun) {
  allRows.forEach(function (row) {
    if (row.status !== 'cancelled') return;
    if (!row.threadId) return; // nothing to re-verify against either way — leave as-is
    var thread = null;
    try { thread = GmailApp.getThreadById(row.threadId); } catch (e) { thread = null; }
    if (thread && dailyPracticeThreadHasStopRequest_(thread)) return; // genuinely still cancelled
    log_('[' + row.rep + '/' + row.dateStr + '] Was cancelled, but its tracked thread has no real cancel/stop ' +
      'message (likely mistracked before the send-thread fix) — reverting to open.' +
      (dryRun ? ' (preview — not written)' : ''));
    if (!dryRun) sheet.getRange(row.rowIndex, 4).setValue('open');
    row.status = 'open';
  });
}

function checkDailyPracticeCompliance_(dryRun) {
  RUN_TAG = 'checkDailyPracticeCompliance_';
  var now = new Date();
  var sheet = getOrCreateDailyPracticeFollowupSheet_();
  var allRows = loadDailyPracticeFollowupRows_(sheet, null);
  repairFalselyCancelledDailyPracticeRows_(sheet, allRows, dryRun);
  repairDuplicateDailyPracticeFileClaims_(sheet, allRows, dryRun);

  var rows = allRows.filter(function (r) {
    return r.status === 'open' || r.status === 'file_received';
  });

  if (!rows.length) { log_('No open or pending daily-practice follow-ups.'); return; }

  // Every filename ANY row has ever claimed, from ALL rows regardless of
  // status — not just the active open/file_received set. Real bug
  // (confirmed live 28/08/2026): 260827 graded out (dailyPracticeAlreadyGraded_
  // found its Feedback doc and flipped it to 'graded' between runs), which
  // drops it out of the active `rows` filter entirely — and the previous
  // version of this exclusion set was built ONLY from that same filtered
  // list, so the instant 260827 left the active set, its claimed file
  // stopped being excluded and 260825 grabbed it right back. A file a row
  // once claimed must stay off-limits forever, not just while that row is
  // still active.
  var claimedByRep = {};
  allRows.forEach(function (r) {
    if (!r.matchedFile) return;
    claimedByRep[r.rep] = claimedByRep[r.rep] || {};
    claimedByRep[r.rep][r.matchedFile] = true;
  });

  // Resolve every rep's still-unmatched rows TOGETHER (see
  // resolveDailyPracticeFileMatches_) before any row-level nag/grading logic
  // runs, and persist the result immediately — this also catches up any row
  // that reached 'file_received' before Matched File tracking existed
  // (confirmed live 28/08/2026: the column was empty even for an
  // already-file_received row, which meant it kept re-deriving an untracked
  // match every single run forever).
  var byRep = {};
  rows.forEach(function (r) { (byRep[r.rep] = byRep[r.rep] || []).push(r); });
  Object.keys(byRep).forEach(function (rep) {
    var unmatched = byRep[rep].filter(function (r) { return !r.matchedFile; });
    if (!unmatched.length) return;
    var alreadyClaimed = claimedByRep[rep] || {};
    var folder = DriveApp.getFolderById(DAILY_PRACTICE_CONFIG.FOLDERS[rep]);
    var candidateNames = [];
    listDailyPracticeFilesRecursive_(folder).forEach(function (f) {
      var name = f.getName();
      if (!/Transcript|Feedback/i.test(name) && !alreadyClaimed[name]) candidateNames.push(name);
    });
    var matches = resolveDailyPracticeFileMatches_(unmatched, candidateNames);
    unmatched.forEach(function (r) {
      if (!matches[r.dateStr]) return;
      r.matchedFile = matches[r.dateStr];
      if (!dryRun) sheet.getRange(r.rowIndex, 7).setValue(r.matchedFile);
    });
  });

  rows.forEach(function (row) {
    try {
      checkDailyPracticeComplianceRow_(row, sheet, now, dryRun);
    } catch (e) {
      // One row's Drive/Gmail hiccup must not abort every other rep's row in
      // this same pass (real risk: forEach has no per-iteration try/catch of
      // its own, so an uncaught throw here — e.g. a transient Drive API
      // error — would silently skip every row still queued after it, not
      // just this one).
      log_('[' + row.rep + '/' + row.dateStr + '] checkDailyPracticeCompliance_ threw: ' + e + ' — skipping this row, others still processed.');
    }
  });
}

function checkDailyPracticeComplianceRow_(row, sheet, now, dryRun) {
    var repCfg = CONFIG.REPS.filter(function (r) { return r.name === row.rep; })[0];
    if (!repCfg) { log_('No CONFIG.REPS entry for "' + row.rep + '" — skipping row ' + row.rowIndex); return; }

    // row.threadId can be blank — sendDailyPracticeReminders_ registers the
    // row even when Gmail's search index hadn't caught up with the send yet.
    // getThreadById('') throws rather than returning null, so guard on the
    // string first; an uncaught throw here would abort every other rep's row
    // in this same forEach pass, not just this one.
    var thread = row.threadId ? GmailApp.getThreadById(row.threadId) : null;
    if (row.threadId && !thread) {
      log_('[' + row.rep + '/' + row.dateStr + '] Tracked thread ' + row.threadId + ' no longer exists — leaving row as-is.');
      return;
    }

    if (thread && dailyPracticeThreadHasStopRequest_(thread)) {
      if (!dryRun) sheet.getRange(row.rowIndex, 4).setValue('cancelled');
      log_('[' + row.rep + '/' + row.dateStr + '] Kris or Tomás said cancel/stop on the thread — stopping follow-up.' +
        (dryRun ? ' (preview — not written)' : ''));
      return;
    }

    // Matching itself already happened for every rep in checkDailyPracticeCompliance_
    // (resolveDailyPracticeFileMatches_) — row.matchedFile is either already
    // set from that, or genuinely has no match this pass. Just resolve the
    // File object here.
    var folder = DriveApp.getFolderById(DAILY_PRACTICE_CONFIG.FOLDERS[row.rep]);
    var namedFile = null;
    if (row.matchedFile) {
      namedFile = findDailyPracticeFileByName_(folder, row.matchedFile);
    }

    if (row.status === 'open') {
      if (namedFile) {
        if (!dryRun) sheet.getRange(row.rowIndex, 4).setValue('file_received');
        log_('[' + row.rep + '/' + row.dateStr + '] Correctly-named file landed ("' + namedFile.getName() +
          '") — stopping nag.' + (dryRun ? ' (preview — not written)' : ''));
        // Per Kris (28/08/2026): the file name only ever showed up in the
        // Apps Script execution log, which nobody actually reads day to day
        // — say it on the thread itself so it's visible without digging,
        // and so a late-submission fallback match (selectLateDailyPracticeFileName_)
        // picking an unexpected file is immediately obvious, not silent.
        var foundBody = 'Found "' + namedFile.getName() + '" — stopping the nag. ' +
          'Will grade it and reply here once its transcript is ready.';
        if (dryRun) {
          log_('(preview) would reply-all on tracked thread with file-found confirmation:\n' + foundBody);
        } else if (thread) {
          guardedReplyAll_(thread, foundBody, { name: 'Daily Practice Follow-up Bot' }, 1);
        }
        row.status = 'file_received'; // fall through to the grading check below in this same pass
      } else {
        // lastNagDate now holds a full timestamp (ISO string, or a real Date if
        // Sheets auto-converted it on read-back) so the ~12h gate actually works
        // across the two daily firings instead of just deduping by calendar date.
        var lastNagMs = row.lastNagDate instanceof Date
          ? row.lastNagDate.getTime()
          : (row.lastNagDate ? new Date(row.lastNagDate).getTime() : 0);
        var hoursSinceLastNag = (now.getTime() - lastNagMs) / (3600 * 1000);
        if (lastNagMs && hoursSinceLastNag < DAILY_PRACTICE_CONFIG.NAG_INTERVAL_HOURS) return; // nagged too recently
        var nagNum = (row.nagCount || 0) + 1;
        var nagBody = 'Still don\'t see a correctly-named file (starting with ' + row.dateStr + ') in the practice folder ' +
          '— this is follow-up #' + nagNum + '. This thread will keep getting a nag every ' +
          DAILY_PRACTICE_CONFIG.NAG_INTERVAL_HOURS + 'h until the file lands, or Kris or Tomás replies-all here with ' +
          '"cancel" or "stop".\n\nFolder: https://drive.google.com/drive/folders/' + DAILY_PRACTICE_CONFIG.FOLDERS[row.rep];
        if (dryRun) {
          log_('(preview) would ' + (thread ? 'reply-all' : 'send a standalone email (no tracked thread)') +
            ' nag #' + nagNum + ' for [' + row.rep + '/' + row.dateStr + ']\n' + nagBody);
          return;
        }
        var nagSent = thread
          ? guardedReplyAll_(thread, nagBody, { name: 'Daily Practice Follow-up Bot' }, 1)
          : guardedSend_(repCfg.email, row.rep + ' — daily practice follow-up #' + nagNum, nagBody,
              { name: 'Daily Practice Follow-up Bot', cc: CONFIG.TOMAS_EMAIL }, 2);
        if (!nagSent) {
          log_('[' + row.rep + '/' + row.dateStr + '] Nag #' + nagNum + ' SEND FAILED/SKIPPED (quota-short or invalid config) — will retry next check.');
          return;
        }
        sheet.getRange(row.rowIndex, 5, 1, 2).setValues([[now.toISOString(), nagNum]]);
        log_('[' + row.rep + '/' + row.dateStr + '] NON-COMPLIANT — reply-all nag #' + nagNum + ' sent on the tracked thread.');
        return;
      }
    }

    // row.status === 'file_received' here (either already was, or just transitioned above).
    if (!namedFile) {
      // Real gap found live (28/08/2026, Sean's 260825 row): once a row is
      // 'file_received' it's out of the nagging path entirely, so if its
      // file is gone now — renamed, moved, deleted, or (the actual case
      // here) its earlier match got legitimately reassigned to the row that
      // really owned it once double-claim resolution existed — it used to
      // sit here silently forever with no visible trace and no reminder.
      // Revert to 'open' so the normal nag path picks it back up on the
      // next compliance pass instead.
      if (!dryRun) sheet.getRange(row.rowIndex, 4).setValue('open');
      log_('[' + row.rep + '/' + row.dateStr + '] Was file_received but no matching file exists right now ' +
        '(renamed, moved, deleted, or reassigned to another day) — reverting to open so it gets nagged again.' +
        (dryRun ? ' (preview — not written)' : ''));
      return;
    }
    // NOT .replace(/\.[^.]+$/, '') first: transcribe_daily_practice.py names
    // the doc "<video name, EXTENSION INCLUDED> — Transcript" (real bug C-08
    // — stripping the extension here built a name that never matched the doc
    // that actually exists, so a graded file's transcript was never found and
    // the row sat "waiting on transcription" forever).
    var transcriptFile = findDailyPracticeFileByName_(folder, namedFile.getName() + ' — Transcript');
    if (!transcriptFile) {
      log_('[' + row.rep + '/' + row.dateStr + '] "' + namedFile.getName() +
        '" received, waiting on transcription before it can be graded.');
      return;
    }
    var transcriptName = transcriptFile.getName();
    if (!dryRun && dailyPracticeAlreadyGraded_(folder, transcriptName)) {
      sheet.getRange(row.rowIndex, 4).setValue('graded');
      return;
    }

    var text = getTranscriptText_(transcriptFile);
    var result = gradeDailyPracticeTranscript_(row.rep, text, transcriptName);
    var links = { transcriptUrl: transcriptFile.getUrl(), recordingUrl: namedFile.getUrl() };
    var email = buildDailyPracticeFeedbackEmail_(row.rep, transcriptName, result, links);
    var escalate = result.overall_score <= DAILY_PRACTICE_CONFIG.ESCALATE_AT_OR_BELOW;
    var delivered = deliverDailyPracticeGrading_(row.rep, repCfg, folder, transcriptName, result, email, escalate, dryRun, row.threadId);
    // Only mark 'graded' on an actual successful delivery — leaving the row
    // as 'file_received' on a failed/skipped send means the next pass retries
    // it instead of silently losing the grading forever.
    if (!dryRun && delivered) sheet.getRange(row.rowIndex, 4).setValue('graded');
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

/** Dropdown-visible wrapper — installDailySelfPracticeTriggers_() has a
 * trailing underscore so Apps Script hides it from "Select function to run". */
function installDailySelfPracticeTriggers() {
  installDailySelfPracticeTriggers_();
}

function installDailySelfPracticeTriggers_() {
  RUN_TAG = 'installDailySelfPracticeTriggers_';
  ['runDailyPracticeGrading', 'sendDailyPracticeReminders_', 'runDailyPracticeCompliance'].forEach(function (handler) {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
    });
  });

  // AM compliance-check firing, an hour before REMINDER_HOUR (see
  // COMPLIANCE_CHECK_HOUR's own comment). The PM pass, 12h later, used to be
  // a second dedicated trigger at COMPLIANCE_CHECK_HOUR_PM — that pushed the
  // project over Apps Script's 20-installable-trigger cap (real bug, live
  // 31/08/2026), so it's now folded into runDailyPracticeGrading (see that
  // function's own comment), which already fires at the same hour
  // (GRADING_HOUR === COMPLIANCE_CHECK_HOUR_PM === 20). Net effect on the
  // actual schedule: none. checkDailyPracticeCompliance_'s own
  // NAG_INTERVAL_HOURS gate is what actually enforces the ~12h nag spacing.
  ScriptApp.newTrigger('runDailyPracticeCompliance')
    .timeBased().everyDays(1).atHour(DAILY_PRACTICE_CONFIG.COMPLIANCE_CHECK_HOUR).inTimezone(CONFIG.BUSINESS_TIMEZONE).create();
  ScriptApp.newTrigger('sendDailyPracticeReminders_')
    .timeBased().everyDays(1).atHour(DAILY_PRACTICE_CONFIG.REMINDER_HOUR).inTimezone(CONFIG.BUSINESS_TIMEZONE).create();
  ScriptApp.newTrigger('runDailyPracticeGrading')
    .timeBased().everyDays(1).atHour(DAILY_PRACTICE_CONFIG.GRADING_HOUR).inTimezone(CONFIG.BUSINESS_TIMEZONE).create();

  log_('Daily self-practice triggers installed: compliance check at ' + DAILY_PRACTICE_CONFIG.COMPLIANCE_CHECK_HOUR +
    ':00, reminders at ' + DAILY_PRACTICE_CONFIG.REMINDER_HOUR + ':00, grading + 2nd compliance pass at ' +
    DAILY_PRACTICE_CONFIG.GRADING_HOUR + ':00 (nag every ' + DAILY_PRACTICE_CONFIG.NAG_INTERVAL_HOURS +
    'h, ' + CONFIG.BUSINESS_TIMEZONE + ') — one fewer trigger than before, same effective schedule.');
}
