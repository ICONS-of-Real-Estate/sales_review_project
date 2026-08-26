/**
 * Phase6_TrainingCallReview.gs
 *
 * Thao's ask (19/08/2026): Tomás runs a 1:1 training call with each rep,
 * built around that rep's own review from the week before, to drill
 * objection handling and asking for the money — joined 25/08/2026 by a third
 * skill, explaining the framework (see Phase2_CallGradingSOP.md §3D). This
 * phase reads the TRANSCRIPT OF THAT TRAINING CALL — not a sales call — and
 * turns it into a coaching plan for the coming week. Complements Phase 5
 * (grades the reps' real sales calls); this phase grades the coaching
 * session itself.
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
 * If there's no Zoom video/audio bundle — just a transcript on its own (a
 * Google Doc, .vtt, or .txt) — no subfolder is needed either: drop the file
 * straight into the rep's folder above, named starting with the call's
 * YYMMDD date (e.g. "260819" or "260819 Transcript"). The output doc for
 * that path is named "<date> Training Plan" (vs. plain "Training Plan"
 * inside a dated subfolder) so multiple flat transcripts in the same rep
 * folder don't collide on the same output/already-done marker name.
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

/**
 * Role differences by rep — mirrors Phase2_CallScoring.gs's
 * buildBensJudgeSystemPrompt_ (added 22/08/2026 per Kris: Bens is not a
 * closer, he runs ICONS 100 lead-gen interviews and QCs, never asks for
 * money himself, and books the next concrete step — a QC or Sales Call —
 * for someone else on the team). The training-call review never got that
 * same distinction until now (26/08/2026, per Kris): it graded EVERY rep,
 * Bens included, on a straight money-ask and framework explanation —
 * meaningless red "No" badges in his own training-plan email for skills
 * that were never his job. Default (no entry here) = the shared
 * closer/framework-explaining role Sean and Joana actually have.
 */
var TRAINING_REVIEW_ROLE_ = {
  Bens: {
    closeAskSkillLabel: 'asking for the appointment',
    closeAskSkillDescription: 'a direct, explicit ask to book the next concrete step (a QC or a Sales Call) with ' +
      'someone else on the team, at a specific date/time — not a vague "I\'ll be in touch" or "someone will ' +
      'reach out." Ideally asked more than once: ask it, and whatever comes back is either another objection ' +
      '(loop back into Agree/Isolate/Repeat, then ask again) or a yes (lock the date/time). A single ask with ' +
      'no repeat attempt, or a soft-question substitute, does not count as the drill having landed.',
    drillsFramework: false,
    roleNote: 'he runs ICONS 100 lead-gen interviews and QCs, books the next step for someone else on the team, ' +
      'and never asks for money or explains the framework himself'
  }
};

function trainingReviewRoleFor_(rep) {
  return TRAINING_REVIEW_ROLE_[rep] || {
    closeAskSkillLabel: 'asking for the money',
    closeAskSkillDescription: 'a direct line, e.g. "Ready to get started?" — not a soft/open question like ' +
      '"what would it take to get you started?". Ideally asked MORE THAN ONCE in the same call: ask it, and ' +
      'whatever comes back is either another objection (loop back into Agree/Isolate/Repeat, then ask again) ' +
      'or a yes (go straight to payment). A single ask with no repeat attempt, or a soft-question substitute ' +
      'for the direct line, does not count as the drill having landed.',
    drillsFramework: true,
    roleNote: ''
  };
}

function buildTrainingReviewSystemPrompt_(rep) {
  var role = trainingReviewRoleFor_(rep);

  var skillListLine = role.drillsFramework
    ? 'to drill three separate skills: objection handling, ' + role.closeAskSkillLabel + ', and explaining the framework.'
    : 'to drill two separate skills: objection handling and ' + role.closeAskSkillLabel + '. ' + role.roleNote;

  var closeAskDefinitionLines = [
    '  ' + role.closeAskSkillLabel.toUpperCase() + ' = ' + role.closeAskSkillDescription
  ];

  var frameworkDefinitionLines = role.drillsFramework ? [
    '  FRAMEWORK EXPLANATION = proactively and specifically walking through all three pieces of our value',
    '    proposition: how the podcast helps RECRUIT AGENTS, how it builds #1-PODCAST-IN-YOUR-CITY authority,',
    '    and how it helps SELL MORE HOUSES. Explaining this clearly up front heads off the objections that',
    '    come from a lead never understanding the offer in the first place — added 25/08/2026 per Kris, same',
    '    "prevention beats handling" logic as objection handling above, applied one step earlier in the call.'
  ] : [];

  var closeAskExtractionLines = [
    '  - Did ' + rep + ' actively practice ' + role.closeAskSkillLabel.toUpperCase() + ' (role-play the actual line,',
    '    not just listen to Tomás describe it) in this call? Quote the moment. Be strict: Tomás merely telling ' + rep,
    '    to do this is not the same as ' + rep + ' practicing saying it.'
  ];

  var frameworkExtractionLines = role.drillsFramework ? [
    '  - Did ' + rep + ' actively practice FRAMEWORK EXPLANATION (role-play walking through recruit-agents /',
    '    #1-podcast-in-your-city / sell-more-houses, not just listen to Tomás describe it) in this call?',
    '    Quote the moment. Same strictness as above — Tomás telling ' + rep + ' to explain it better is not',
    '    the same as ' + rep + ' practicing saying it.'
  ] : [
    '  - Framework explanation is NOT part of ' + rep + '\'s role (' + role.roleNote + ') — always return',
    '    "practiced_framework": false and an empty "framework_gaps_to_drill" array. Do not grade, coach, or',
    '    comment on framework explanation for ' + rep + ' anywhere in your answer.'
  ];

  var closeAskDrillExtractionLine = '  - If Tomás drilled ' + role.closeAskSkillLabel + ' specifically: a short label for the ' +
    'exact line practiced and a one-clause note on the branch logic he taught. Omit (null) if it wasn\'t drilled this call.';

  var frameworkDrillExtractionLine = role.drillsFramework
    ? '  - If Tomás drilled framework explanation: which of the three specific pieces (recruit_agents | ' +
      'number_one_podcast | sell_more_houses) he worked on with ' + rep + ', each with a short, concrete ' +
      'one-clause note on what to say differently. Empty array if it wasn\'t drilled this call — these feed ' +
      rep + '\'s daily practice assignment same as the objections above.'
    : null;

  return [
    'You are reviewing the TRANSCRIPT OF A LIVE 1:1 TRAINING CALL between Tomás (sales trainer) and ' +
      rep + ' (rep) — not a sales call.',
    'Tomás runs this call weekly, built around ' + rep + '\'s own performance review from the week before, ' +
      skillListLine,
    'A third person (e.g. "Admin"/Kris) may sit in on the call — treat their turns as context, not as',
    'something to coach.',
    '',
    'These are our named frameworks — grade against these, not a generic sales methodology:',
    '  OBJECTION HANDLING = Agree, Isolate, Repeat. Agree with the objection\'s premise (don\'t argue it',
    '    away), isolate it as the one thing standing in the way ("so if it weren\'t for X, you\'d be ready',
    '    to move forward?"), then repeat/confirm that back before answering it.'
  ].concat(closeAskDefinitionLines, frameworkDefinitionLines, [
    '',
    'Extract:',
    '  - Did Tomás reference a specific real call/objection pattern of ' + rep + '\'s, and what did he say about it?',
    '  - Did ' + rep + ' actively practice OBJECTION HANDLING (role-play the Agree/Isolate/Repeat sequence,',
    '    not just listen to Tomás describe it) in this call? Quote the moment.'
  ], closeAskExtractionLines, frameworkExtractionLines, [
    '  - What did Tomás explicitly tell ' + rep + ' to do differently before next week?',
    '  - The 2-3 SPECIFIC objections Tomás drilled ' + rep + ' on in this call (not a general theme —',
    '    the actual named objection, e.g. "I\'m too busy right now", "What does this cost?"), each with a',
    '    short, concrete one-clause note on how to handle it via Agree/Isolate/Repeat. These get sent to',
    '    ' + rep + ' as this week\'s daily practice assignment, so keep both the label and the note short',
    '    and usable as a checklist item.',
    closeAskDrillExtractionLine
  ], frameworkDrillExtractionLine ? [frameworkDrillExtractionLine] : [], [
    '',
    'Be skeptical: if ' + rep + ' was only listening, not practicing, mark the relevant practiced_* field',
    'false — don\'t invent practice that didn\'t happen. Each drilled skill is independent: a call can drill',
    'any combination of them, including none.',
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text, in this exact shape:',
    '',
    '{',
    '  "reasoning": "string",',
    '  "attended": true,',
    '  "practiced_objections": true,',
    '  "practiced_close_ask": true,',
    '  "practiced_framework": true,',
    '  "coaching_notes": "string — what Tomás said about their pattern/performance, with a quote",',
    '  "next_focus": "string — one concrete, specific self-practice focus for this coming week",',
    '  "objections_to_drill": [',
    '    { "label": "string — the specific objection, short, e.g. \\"I\'m too busy right now\\"",',
    '      "note": "string — one short clause on how to handle it, e.g. \\"agree, isolate as the one thing, repeat it back\\"" }',
    '  ],',
    '  "close_ask_drill": { "label": "string — the exact line practiced, e.g. \\"Ready to get started?\\"",',
    '    "note": "string — one short clause on the branch logic, e.g. \\"ask again after the objection, then payment on a yes\\"" } | null,',
    '  "framework_gaps_to_drill": [',
    '    { "topic": "recruit_agents | number_one_podcast | sell_more_houses",',
    '      "note": "string — one short clause on what to say differently" }',
    '  ],',
    '  "team_notes": "string — anything Tomás said that applies beyond ' + rep + ', else \\"none\\""',
    '}'
  ]).join('\n');
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
    typeof obj.practiced_objections === 'boolean' &&
    typeof obj.practiced_close_ask === 'boolean' &&
    typeof obj.practiced_framework === 'boolean' &&
    typeof obj.coaching_notes === 'string' &&
    typeof obj.next_focus === 'string' &&
    typeof obj.team_notes === 'string' &&
    Array.isArray(obj.objections_to_drill) &&
    obj.objections_to_drill.length > 0 &&
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
    practiced_objections: false,
    practiced_close_ask: false,
    practiced_framework: false,
    coaching_notes: 'Automated review failed to parse twice — read the transcript manually.',
    next_focus: 'n/a — read transcript manually: ' + rep + '/' + dateLabel,
    objections_to_drill: [],
    close_ask_drill: null,
    framework_gaps_to_drill: [],
    team_notes: 'none'
  };
}

/** Small colored pill for a yes/no stat — green when true, red when false. */
function trainingReviewStatBadge_(label, value) {
  var bg = value ? '#e6f4ea' : '#fce8e6';
  var fg = value ? '#137333' : '#c5221f';
  return '<span style="display:inline-block;background:' + bg + ';color:' + fg + ';' +
    'padding:4px 10px;border-radius:12px;font-size:12px;font-weight:bold;margin:0 6px 6px 0;">' +
    label + ': ' + (value ? 'Yes' : 'No') + '</span>';
}

/** A left-accented callout box — same shape used for Notes/close-ask/team-note so the email reads as distinct blocks, not one wall of text. */
function trainingReviewCallout_(accentColor, bgColor, label, text) {
  return '<div style="border-left:4px solid ' + accentColor + ';background:' + bgColor + ';' +
    'padding:10px 14px;margin:0 0 14px;border-radius:4px;">' +
    '<b style="color:' + accentColor + ';">' + label + '</b><br>' + text + '</div>';
}

var FRAMEWORK_TOPIC_LABELS_ = {
  recruit_agents: 'Recruit agents',
  number_one_podcast: '#1 podcast in your city',
  sell_more_houses: 'Sell more houses'
};

function buildTrainingReviewEmail_(rep, dateLabel, result) {
  var role = trainingReviewRoleFor_(rep);
  var closeAskLabelCap = role.closeAskSkillLabel.charAt(0).toUpperCase() + role.closeAskSkillLabel.slice(1);
  var subject = 'Training Call Plan — ' + rep + ' — ' + dateLabel;
  var objections = result.objections_to_drill || [];
  var closeAsk = result.close_ask_drill || null;
  var frameworkGaps = role.drillsFramework ? (result.framework_gaps_to_drill || []) : [];

  var objectionsPlain = objections.map(function (o) {
    return '- ' + o.label + ' — ' + o.note;
  }).join('\n');
  var objectionsHtml = objections.length
    ? '<ul style="margin:0 0 14px;padding-left:20px;">' + objections.map(function (o) {
        return '<li style="margin-bottom:6px;"><b>' + o.label + '</b> — ' + o.note + '</li>';
      }).join('') + '</ul>'
    : '';

  var closeAskPlain = closeAsk ? '\n' + closeAskLabelCap + ' — "' + closeAsk.label + '": ' + closeAsk.note + '\n' : '';
  var closeAskHtml = closeAsk
    ? trainingReviewCallout_('#f9ab00', '#fef7e0', closeAskLabelCap,
        '"' + closeAsk.label + '" — ' + closeAsk.note)
    : '';

  var frameworkLabelFor = function (f) { return FRAMEWORK_TOPIC_LABELS_[f.topic] || f.topic; };
  var frameworkPlain = frameworkGaps.length
    ? '\nFramework explanation to drill:\n' + frameworkGaps.map(function (f) {
        return '- ' + frameworkLabelFor(f) + ' — ' + f.note;
      }).join('\n') + '\n'
    : '';
  var frameworkHtml = frameworkGaps.length
    ? trainingReviewCallout_('#0b8043', '#e6f4ea', 'Framework explanation to drill',
        '<ul style="margin:6px 0 0;padding-left:20px;">' + frameworkGaps.map(function (f) {
          return '<li style="margin-bottom:4px;"><b>' + frameworkLabelFor(f) + '</b> — ' + f.note + '</li>';
        }).join('') + '</ul>')
    : '';

  var hasTeamNote = result.team_notes && result.team_notes.toLowerCase() !== 'none';

  // Framework explanation isn't shown at all for a rep whose role doesn't
  // cover it (e.g. Bens) — a red "No" badge for a skill that was never his
  // job to begin with is misleading, not useful coaching signal.
  var frameworkStatLinePlain = role.drillsFramework
    ? ' | Practiced framework explanation: ' + (result.practiced_framework ? 'Yes' : 'No')
    : '';
  var frameworkStatBadgeHtml = role.drillsFramework
    ? trainingReviewStatBadge_('Framework explanation practiced', result.practiced_framework)
    : '';

  var body = 'Training call with ' + rep + ' (' + dateLabel + '):\n\n' +
    'Attended: ' + (result.attended ? 'Yes' : 'No') +
    ' | Practiced objection handling: ' + (result.practiced_objections ? 'Yes' : 'No') +
    ' | Practiced ' + role.closeAskSkillLabel + ': ' + (result.practiced_close_ask ? 'Yes' : 'No') +
    frameworkStatLinePlain + '\n\n' +
    'Notes: ' + result.coaching_notes + '\n\n' +
    'This week\'s objections to drill (Agree, Isolate, Repeat):\n' + objectionsPlain + '\n' +
    closeAskPlain +
    frameworkPlain + '\n' +
    (hasTeamNote ? 'Team-wide note: ' + result.team_notes + '\n\n' : '') +
    '— Automated review of the training call itself, not a sales call. Reply to Kris or Tomás with corrections.';

  var htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;">' +
    '<h2 style="color:#1a73e8;font-size:18px;margin:0 0 10px;">Training call with ' + rep + ' (' + dateLabel + ')</h2>' +
    '<div style="margin-bottom:14px;">' +
    trainingReviewStatBadge_('Attended', result.attended) +
    trainingReviewStatBadge_('Objection handling practiced', result.practiced_objections) +
    trainingReviewStatBadge_(closeAskLabelCap + ' practiced', result.practiced_close_ask) +
    frameworkStatBadgeHtml +
    '</div>' +
    trainingReviewCallout_('#1a73e8', '#f1f6fe', 'Notes', result.coaching_notes) +
    '<h3 style="color:#0b8043;font-size:14px;margin:0 0 6px;">This week\'s objections to drill (Agree → Isolate → Repeat)</h3>' +
    objectionsHtml +
    closeAskHtml +
    frameworkHtml +
    (hasTeamNote ? trainingReviewCallout_('#9334e6', '#f5f0fc', 'Team-wide note', result.team_notes) : '') +
    '<p style="color:#888;font-size:12px;font-style:italic;margin-top:16px;">— Automated review of the training call itself, not a sales call. Reply to Kris or Tomás with corrections.</p>' +
    '</div>';

  return { subject: subject, body: body, htmlBody: htmlBody };
}

/** Finds the Zoom-generated transcript inside a dated subfolder (skips the video/audio siblings). */
/** True for a filename that looks like a transcript (.vtt, or contains "Transcript") — false for Zoom's video/audio siblings (.mp4/.m4a/etc), which share the same date-prefixed naming but are never the transcript itself. */
function looksLikeTranscriptFile_(name) {
  return /\.vtt$/i.test(name) || name.indexOf('Transcript') !== -1;
}

function findTrainingTranscriptFile_(dateFolder) {
  var files = dateFolder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if (looksLikeTranscriptFile_(file.getName())) return file;
  }
  return null;
}

/** True if a "Training Plan" Doc already sits in this dated subfolder. */
function trainingReviewAlreadyDone_(dateFolder) {
  return dateFolder.getFilesByName('Training Plan').hasNext();
}

/**
 * Finds transcript-looking files sitting directly in a rep's Training Calls
 * folder (no dated subfolder) — for when there's only a transcript to hand
 * over, no Zoom video/audio bundle to keep it company. Identified by a
 * leading YYMMDD date in the file name (e.g. "260819" or "260819 Transcript"),
 * same date-label convention as the subfolder path below.
 *
 * Real incident live (26/08/2026): Tomás started dropping the FULL Zoom
 * bundle (video + .vtt) flat into the rep's root folder instead of the
 * documented dated subfolder. For Bens/Joana the transcript happened to
 * iterate before the video and everything worked; for Sean the video
 * (also date-prefixed, e.g. "260825_Recording_1920x1020.mp4") got matched
 * as if IT were the transcript, and processTrainingTranscript_ choked on it
 * — silently losing that rep's entire training review for the week, with
 * no doc and no email, and no error visible anywhere but the Executions
 * log. Excluding known Zoom recording extensions here means this path only
 * ever matches an actual transcript, regardless of what else sits next to
 * it or in what order Drive happens to return files.
 */
var TRAINING_RECORDING_EXTENSIONS_ = /\.(mp4|m4a|mov|avi|wav|mp3|webm)$/i;

function findFlatTrainingTranscripts_(repFolder) {
  // NOT \b: regex word-boundary treats "_" as a word character, so
  // `\b` after the date fails on Zoom's own default naming
  // ("260825_Recording...") while happening to pass on "-" or a space —
  // exactly why this matched Bens' and Joana's flat files but silently
  // skipped Sean's real vtt outright (confirmed live 26/08/2026: it never
  // even appeared in the run's log, let alone got processed). A negative
  // lookahead for another digit gets the same "don't misread a longer
  // number as a 6-digit date" protection without depending on what
  // character happens to follow.
  var dateLabelPrefix = /^(\d{6})(?!\d)/;
  var files = repFolder.getFiles();
  var out = [];
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    var m = name.match(dateLabelPrefix);
    if (!m) continue;
    if (/Training Plan$/.test(name)) continue; // a previous run's output doc, not a transcript to review
    if (TRAINING_RECORDING_EXTENSIONS_.test(name)) continue; // Zoom's video/audio, not the transcript
    out.push({ file: file, dateLabel: m[1] });
  }
  return out;
}

var TRAINING_ASSIGNMENTS_SHEET_NAME = 'Training Assignments';
var TRAINING_ASSIGNMENTS_HEADERS = ['Rep', 'Training Objections (JSON)', 'Close Ask Drill (JSON)', 'Training Framework (JSON)', 'Last Updated'];

function getOrCreateTrainingAssignmentsSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(TRAINING_ASSIGNMENTS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TRAINING_ASSIGNMENTS_SHEET_NAME);
    sheet.getRange(1, 1, 1, TRAINING_ASSIGNMENTS_HEADERS.length).setValues([TRAINING_ASSIGNMENTS_HEADERS])
      .setFontWeight('bold').setBackground('#e8eef7');
    sheet.setFrozenRows(1);
    log_('Created "' + TRAINING_ASSIGNMENTS_SHEET_NAME + '" tab.');
    return sheet;
  }
  // mirrorTrainingAssignment_ writes by fixed column POSITION, not header
  // lookup — unlike the Sales Call Log there's no getValidatedColumnMap_
  // guard here, so a header array that grows (as it just did, 25/08/2026:
  // "Training Framework (JSON)" inserted before "Last Updated") would
  // otherwise silently mislabel the live sheet's header row against the new
  // column layout — new writes go to the right position, but "Last Updated"
  // would keep displaying under whatever header used to sit at position 4.
  // Self-heal on every call, cheap and idempotent, same "validate every run"
  // spirit as setupSalesCallLog()'s header check.
  var existing = sheet.getRange(1, 1, 1, TRAINING_ASSIGNMENTS_HEADERS.length).getValues()[0];
  var headersMatch = TRAINING_ASSIGNMENTS_HEADERS.every(function (h, i) { return existing[i] === h; });
  if (!headersMatch) {
    sheet.getRange(1, 1, 1, TRAINING_ASSIGNMENTS_HEADERS.length).setValues([TRAINING_ASSIGNMENTS_HEADERS])
      .setFontWeight('bold').setBackground('#e8eef7');
    log_('Updated "' + TRAINING_ASSIGNMENTS_SHEET_NAME + '" header row to match TRAINING_ASSIGNMENTS_HEADERS ' +
      '(' + TRAINING_ASSIGNMENTS_HEADERS.length + ' columns) — rows for reps not yet re-mirrored since this ' +
      'change will show stale data under the new labels until their next Phase 6 run rewrites them.');
  }
  return sheet;
}

/**
 * Mirrors this rep's current TRAINING_OBJECTIONS_<rep>/TRAINING_CLOSE_DRILL_<rep>
 * Script Properties into a sheet row — one row per rep, overwritten in place. Script
 * Properties are only readable from inside Apps Script (no Sheets/Drive API can see
 * them), so without this mirror a dashboard is structurally blind to the current
 * drill assignment. Read-only copy: Phase 7 still reads the properties directly, this
 * changes nothing about how the assignment is actually used, only how it's observed.
 */
function mirrorTrainingAssignment_(rep) {
  var props = PropertiesService.getScriptProperties();
  var objections = props.getProperty('TRAINING_OBJECTIONS_' + rep) || '';
  var closeDrill = props.getProperty('TRAINING_CLOSE_DRILL_' + rep) || '';
  var framework = props.getProperty('TRAINING_FRAMEWORK_' + rep) || '';

  var sheet = getOrCreateTrainingAssignmentsSheet_();
  var lastRow = sheet.getLastRow();
  var rowIndex = -1;
  if (lastRow >= 2) {
    // Column 1 is always "Rep" — this sheet's layout is owned entirely by
    // getOrCreateTrainingAssignmentsSheet_() above, so no header lookup needed.
    var reps = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < reps.length; i++) {
      if (reps[i][0] === rep) { rowIndex = i + 2; break; }
    }
  }

  var rowValues = [rep, objections, closeDrill, framework, new Date()];
  if (rowIndex === -1) {
    sheet.appendRow(rowValues);
  } else {
    sheet.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
  }
}

/**
 * Grades one training-call transcript, emails the rep (cc Tomás/Kris),
 * persists this week's drill objections for Phase 7, and writes the output
 * "<name> Training Plan" doc into outputParentFolder. Shared by both the
 * dated-subfolder path (Zoom's own bundle) and the flat-file path (a lone
 * transcript dropped straight in the rep's folder). Returns true if it did
 * real work (false in dryRun, since nothing is sent or written then).
 */
function processTrainingTranscript_(rep, repCfg, dateLabel, transcriptFile, outputDocName, outputParentFolder, dryRun) {
  var cleanText = stripVttMarkup_(getTranscriptText_(transcriptFile));
  var result = reviewTrainingCallTranscript_(rep, cleanText, dateLabel);
  var email = buildTrainingReviewEmail_(rep, dateLabel, result);

  if (dryRun) {
    log_('(preview) ' + repCfg.email + ' (cc ' + CONFIG.TOMAS_EMAIL + ', ' + CONFIG.KRIS_EMAIL +
      ') <- ' + email.subject + '\n' + email.body + '\n');
    return false;
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
  // Same non-destructive rule as above, for the money-ask drill: only overwrite when
  // this call actually drilled it, so a week that skips the close-ask keeps running
  // the last one that was actually taught.
  if (result.close_ask_drill) {
    PropertiesService.getScriptProperties().setProperty(
      'TRAINING_CLOSE_DRILL_' + rep, JSON.stringify(result.close_ask_drill));
  }
  // Same non-destructive rule again, for framework explanation.
  if (result.framework_gaps_to_drill && result.framework_gaps_to_drill.length) {
    PropertiesService.getScriptProperties().setProperty(
      'TRAINING_FRAMEWORK_' + rep, JSON.stringify(result.framework_gaps_to_drill));
  }
  // Script Properties (above) are invisible to anything outside Apps Script —
  // no Sheets/Drive API can read them. Mirror the current values into a sheet
  // tab so the dashboard sync job (and any human) can see the live assignment.
  // Phase 7 keeps reading the properties directly; this is a read-only copy.
  mirrorTrainingAssignment_(rep);

  var doc = DocumentApp.create(outputDocName);
  doc.getBody().setText(email.body);
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(outputParentFolder);

  log_('  Reviewed ' + rep + '/' + dateLabel + ' -> emailed training plan, wrote "' + outputDocName + '" doc.');
  return true;
}

/** Shared by preview and live paths. dryRun=true never sends and never marks anything processed. */
function buildAndMaybeSendTrainingReviews_(dryRun) {
  var found = 0, processed = 0;

  Object.keys(TRAINING_REVIEW_CONFIG.FOLDERS).forEach(function (rep) {
    var repFolder = DriveApp.getFolderById(TRAINING_REVIEW_CONFIG.FOLDERS[rep]);
    var repCfg = CONFIG.REPS.filter(function (r) { return r.name === rep; })[0];
    if (!repCfg) { log_('No CONFIG.REPS entry for "' + rep + '" — skipping.'); return; }

    // Path A: Zoom's own dated-subfolder bundle (video + audio + auto .vtt transcript).
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

      // One bad file (e.g. an unexpected format, or a transcript so long the
      // judge call fails) must not silently take down every OTHER rep/date
      // still left to process in this run — real incident live (26/08/2026):
      // an uncaught throw partway through one rep's folder meant later reps
      // never even got attempted, with nothing surfaced anywhere but the
      // Executions log. Same "one rep's failure must not kill the others"
      // rule runDailyComplianceCheck (Phase1) already follows.
      try {
        if (processTrainingTranscript_(rep, repCfg, dateLabel, transcriptFile, 'Training Plan', dateFolder, dryRun)) processed++;
      } catch (e) {
        log_('ERROR reviewing ' + rep + '/' + dateLabel + ': ' + e);
        sendOpsAlert_('Training call review error for ' + rep + '/' + dateLabel,
          rep + '\'s training call transcript for ' + dateLabel + ' could not be reviewed.\n\n' + e);
      }
    }

    // Path B: a single transcript file dropped directly in the rep's folder, named
    // with a leading YYMMDD date (e.g. "260819" or "260819 Transcript") — for when
    // there's no Zoom video/audio bundle to keep it company, just the transcript
    // itself. No subfolder needed.
    findFlatTrainingTranscripts_(repFolder).forEach(function (entry) {
      found++;
      var outputName = entry.dateLabel + ' Training Plan';
      if (!dryRun && repFolder.getFilesByName(outputName).hasNext()) {
        log_('  ' + rep + '/' + entry.dateLabel + ' already has a "' + outputName + '" doc — skipping.');
        return;
      }
      try {
        if (processTrainingTranscript_(rep, repCfg, entry.dateLabel, entry.file, outputName, repFolder, dryRun)) processed++;
      } catch (e) {
        log_('ERROR reviewing ' + rep + '/' + entry.dateLabel + ': ' + e);
        sendOpsAlert_('Training call review error for ' + rep + '/' + entry.dateLabel,
          rep + '\'s training call transcript for ' + entry.dateLabel + ' could not be reviewed.\n\n' + e);
      }
    });
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
  ENABLED: true, // Flipped true 20/08/2026 per Kris's go-ahead.
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
