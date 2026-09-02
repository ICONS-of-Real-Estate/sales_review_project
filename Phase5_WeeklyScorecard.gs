/**
 * Phase5_WeeklyScorecard.gs
 *
 * Weekly rep scorecard. Kris/Thao's ask (18/08/2026): every Monday close of
 * business, each rep (Bens/Joana/Sean) gets their own email with this week's
 * grading, their all-time historic average, and the single biggest priority
 * to improve — CC'd to Kris & Tomás. Lands the day before the Tuesday review
 * call (objections + asking for the money), so everyone walks in already
 * knowing what to work on instead of re-deriving it live.
 *
 * Reads the same "Sales Call Log" tab Phase 1/2 already own — reuses CONFIG,
 * log_, guardedSend_, resolveSheet_, businessDayStart_, SALES_CALL_LOG_*,
 * getValidatedColumnMap_ directly (same-project global scope, no import).
 *
 * "Priority to improve" is deterministic, not another LLM call: it tallies
 * each scored call's Primary Failure Mode for the week (written by Phase 2's
 * judge — see PHASE2_CONFIG's shared and Sean rubrics) and reports whichever
 * one came up most. No calls scored yet, or every call this week came back
 * "none"? It falls back to the two flags every row has always had (Asked For
 * Close / Objections Handled).
 *
 * ONE-TIME SETUP:
 *   1. Run migrateAddPrimaryFailureModeColumn() (Phase2_CallScoring.gs) once —
 *      it adds the "Primary Failure Mode" column to the live Sales Call Log
 *      sheet. Without it, getValidatedColumnMap_ throws (header drift) the
 *      moment anything here runs.
 *   2. Run previewWeeklyScorecards() from the Apps Script editor (NOT the
 *      trailing-underscore version — the "Select function" dropdown hides
 *      those). It builds
 *      this week's three emails and only logs them — nothing is sent. Check
 *      the numbers look sane (especially if few calls have Primary Failure
 *      Mode populated yet, since that only backfills going forward).
 *   3. Flip WEEKLY_SCORECARD_CONFIG.ENABLED to true and run
 *      installWeeklyScorecardTrigger().
 */

var WEEKLY_SCORECARD_CONFIG = {
  ENABLED: true, // Flipped true 20/08/2026 after previewWeeklyScorecards_() ran clean.
  TRIGGER_HOUR: 18 // 6pm, CONFIG.BUSINESS_TIMEZONE (Monday close of business)
};

// Human-readable coaching line per Primary Failure Mode value. Covers both
// the shared rubric's 4-value enum (Bens/Joana) and Sean's richer 7-value one
// — see Phase2_CallScoring.gs's buildJudgeSystemPrompt_ / buildSeanJudgeSystemPrompt_.
var FAILURE_MODE_COACHING_TEXT_ = {
  no_close_ask: 'Ask directly for the money/commitment this week — don\'t stop at a soft trial-close question.',
  objections_missed: 'Uncover objections explicitly and answer them with a concrete number, case study, or mechanism — not a generic pitch line.',
  // Added 25/08/2026, per Kris: proactively explaining the framework is what
  // heads off objections before they're raised — same "prevention beats
  // handling" idea behind objections_missed above, applied one step earlier
  // in the call. See Phase2_CallGradingSOP.md §3D.
  framework_not_explained: 'Walk through the full framework proactively this week — how the podcast helps recruit agents, builds #1-podcast-in-your-city authority, and helps sell more houses. Covering it up front heads off objections before the lead even raises them.',
  // Added 29/08/2026, per Kris: pitch delivery (pacing, reading the lead's
  // reactions) is now a fourth scored dimension — see Phase2_CallGradingSOP.md
  // §3G. Without this entry a call whose sole gap is delivery would fall
  // through to the generic 'Focus area: delivery_ineffective' fallback below
  // instead of real coaching text.
  delivery_ineffective: 'Read the room and pace to it this week — check in on time rather than rushing, and match your depth to how the lead is actually reacting (lean into what they respond to, don\'t keep pitching at the same depth once they\'ve checked out or already said no).',
  both: 'Both the close ask and objection handling need work this week — start with directly asking for the money.',
  weak_discovery: 'Slow down before pitching — ask real discovery questions about production volume, marketing spend, and team structure.',
  no_goal_alignment: 'Get the lead to state their own numeric goal, then explicitly tie the offer back to that number.',
  no_second_call_booked: 'Lock a specific date/time for the next call before ending — don\'t leave follow-up as an open "I\'ll email you."',
  multiple: 'Several gaps showed up this week — see individual call feedback in the tracker for specifics.'
};

/**
 * True only when a cell is explicitly a "miss" — a real `false` boolean, or
 * one of the common hand-typed/pasted textual equivalents. Real bug found
 * live (26/08/2026 silent-failure audit): the old `=== false` check silently
 * dropped a hand-corrected cell holding "No"/"FALSE" text or a cleared
 * checkbox from the week's flag-miss tally, so a manually-fixed row could
 * read as "no major gaps flagged" instead of the miss it actually records.
 */
function isExplicitlyFalse_(v) {
  if (v === false) return true;
  var s = String(v || '').trim().toLowerCase();
  return s === 'false' || s === 'no';
}

/** Safe mean; null (not NaN/0) when the array is empty so callers can tell "no data" from "zero". */
function mean_(arr) {
  if (!arr.length) return null;
  return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
}

/** Most-frequent value in arr, alphabetical tie-break for determinism. Null if arr is empty. */
function mostFrequent_(arr) {
  if (!arr.length) return null;
  var counts = {};
  arr.forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
  var best = null;
  Object.keys(counts).sort().forEach(function (k) {
    if (!best || counts[k] > counts[best]) best = k;
  });
  return { value: best, count: counts[best] };
}

/** Most recent Monday at business-timezone midnight, on/before d. Reuses businessDayStart_ (Phase1). */
function mondayAtMidnight_(d, tz) {
  var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var dow = dayNames.indexOf(Utilities.formatDate(d, tz, 'EEE')); // 0=Sun..6=Sat
  var isoDow = dow === 0 ? 7 : dow; // 1=Mon..7=Sun
  var approx = new Date(d.getTime() - (isoDow - 1) * 24 * 3600 * 1000);
  return businessDayStart_(approx, tz);
}

/**
 * The just-completed week when run on a Monday: [last Monday 00:00, this
 * Monday 00:00) business time. If run on some other day (e.g. a manual
 * preview mid-week), still returns the most recent full Mon-through-today
 * window rather than assuming "today is Monday".
 */
/**
 * Steps a business-tz midnight instant by a whole number of CALENDAR days —
 * real bug found live (26/08/2026 silent-failure audit): getWeekBounds_ and
 * computeRepWeeklyStats_'s rolling4WeekStart used to subtract a fixed
 * `N * 24 * 3600 * 1000` from a midnight instant, which is wrong by exactly
 * one hour whenever the span crosses a DST transition — and since Call Date
 * cells land EXACTLY on business-tz midnight (dateAtMidnightInBusinessTimezone_),
 * an hour of error excludes or includes an entire day's calls rather than a
 * sliver. This does the subtraction in UTC calendar-day space (no DST there
 * at all) and only converts back to a real business-tz instant at the end.
 */
function shiftBusinessDate_(d, tz, days) {
  var y = Number(Utilities.formatDate(d, tz, 'yyyy'));
  var m = Number(Utilities.formatDate(d, tz, 'MM'));
  var day = Number(Utilities.formatDate(d, tz, 'dd'));
  var shifted = new Date(Date.UTC(y, m - 1, day, 12) + days * 86400000);
  return dateAtMidnightInBusinessTimezone_(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function getWeekBounds_(now, tz) {
  var end = mondayAtMidnight_(now, tz);
  var start = shiftBusinessDate_(end, tz, -7);
  return { start: start, end: end };
}

/**
 * Tallies one rep's rows into weekly + historic stats. rows/col are the full sheet read.
 *
 * Also computes a rolling 4-week average (QA_COACHING_RESEARCH_REPORT.md §2,
 * "Summary: if you only do five things" #3): a single week's average is too
 * noisy a sample to react to on its own, especially early on when a rep might
 * have 2-3 calls in a given week. The rolling window is [weekEnd - 28 days,
 * weekEnd) — i.e. the just-completed week plus the three before it — reported
 * alongside its own n so a rolling average built on 3 calls doesn't get
 * mistaken for one built on 30.
 */
function computeRepWeeklyStats_(rows, col, repName, weekStart, weekEnd, tz) {
  var allScores = [];
  var priorScores = []; // all-time excluding this week — basis for the trend line
  var weekCalls = [];
  var weekFailureModes = [];
  var weekFlagMiss = { askedForClose: 0, objectionsHandled: 0 };
  var weekMissingOutcomeDisposition = 0;
  var rolling4WeekScores = [];
  var rolling4WeekStart = shiftBusinessDate_(weekEnd, tz || CONFIG.BUSINESS_TIMEZONE, -28);
  var skippedUnusableCallDate = 0, skippedNonNumericScore = 0;

  rows.forEach(function (row) {
    // Real bug found live (26/08/2026 silent-failure audit): this was a
    // strict, case-sensitive `!== repName` — a hand-entered/pasted Rep cell
    // like "sean" (bypassing the dropdown) silently vanished from EVERY
    // rep's weekly scorecard, not just misfiled. Match the way Phase1's
    // checkRep_ already does.
    if (String(row[col['Rep'] - 1] || '').trim().toLowerCase() !== repName.toLowerCase()) return;
    var score = row[col['Call Quality Score'] - 1];
    if (typeof score !== 'number') { skippedNonNumericScore++; return; } // only rows Phase 2 has actually scored

    allScores.push(score);
    var callDate = row[col['Call Date'] - 1];
    // Real bug found live (26/08/2026 silent-failure audit): a Call Date
    // that isn't a real Date object (pasted/typed text — this codebase's
    // own formatDateCell_/instanceof-Date branches elsewhere prove this
    // happens) used to silently fall into the ELSE branch below and be
    // counted in priorScores — removing it from this week's average AND
    // corrupting the "vs. your average before this week" baseline with a
    // call that should have been excluded from both, not miscounted into one.
    if (!(callDate instanceof Date)) {
      skippedUnusableCallDate++;
      return;
    }
    var inWeek = callDate >= weekStart && callDate < weekEnd;
    var inRolling4Weeks = callDate >= rolling4WeekStart && callDate < weekEnd;

    if (inRolling4Weeks) rolling4WeekScores.push(score);

    if (inWeek) {
      weekCalls.push({
        name: row[col['Prospect Name'] - 1] || '(unnamed)',
        score: score,
        feedbackSummary: String(row[col['AI Feedback Summary'] - 1] || '').trim(),
        // Kris's ask (01/09/2026): the worst-call section had no link to the
        // actual transcript, and a manual-review-flagged call (e.g. a
        // [BLANK_AUDIO] recording failure) only ever surfaced as prose
        // buried inside the AI's own feedback paragraph — easy to miss and
        // confusing to read as if it were real coaching feedback.
        transcriptUrl: String(row[col['Transcript URL'] - 1] || '').trim(),
        manualReviewRecommended: row[col['Manual Review Recommended'] - 1] === true
      });
      // Real bug found live (26/08/2026 silent-failure audit): 'none' was
      // compared case-sensitively — a model-returned "None" (no enum
      // validation upstream on this free-text column) used to be pushed as
      // a real failure mode, and if it won mostFrequent_, the rep's headline
      // coaching line read "Focus area: None".
      var pfm = String(row[col['Primary Failure Mode'] - 1] || '').trim().toLowerCase();
      if (pfm && pfm !== 'none') weekFailureModes.push(pfm);
      // Real bug found live: `=== false` only matches a real boolean --
      // a hand-corrected cell holding "No"/"FALSE" (text) or a cleared
      // checkbox reads as neither true nor false and silently isn't counted
      // as a miss either way.
      if (isExplicitlyFalse_(row[col['Flag: Asked For Close'] - 1])) weekFlagMiss.askedForClose++;
      if (isExplicitlyFalse_(row[col['Flag: Objections Handled'] - 1])) weekFlagMiss.objectionsHandled++;
      // QA_COACHING_RESEARCH_REPORT.md: "start logging call outcome today,
      // even before you can analyze it — the clock only starts once you
      // begin." Outcome Disposition has had a column and a dropdown since
      // Phase 0, but Phase 2's automated append always leaves it blank
      // ("fill from rep's tracker" — which IS this same sheet, see that
      // file's comments) and nothing has ever nagged about it, so in
      // practice it's never been filled in. This just starts surfacing the
      // gap in the one email every rep already reads weekly.
      if (!String(row[col['Outcome Disposition'] - 1] || '').trim()) weekMissingOutcomeDisposition++;
    } else {
      priorScores.push(score);
    }
  });

  if (skippedUnusableCallDate || skippedNonNumericScore) {
    log_('  computeRepWeeklyStats_(' + repName + '): skipped ' + skippedUnusableCallDate +
      ' row(s) with an unusable Call Date and ' + skippedNonNumericScore + ' row(s) with a non-numeric score ' +
      '(excluded from all stats, not miscounted into any of them).');
  }

  // Lowest-scoring call of the week, if any — the task-level example the
  // email leads with (QA_COACHING_RESEARCH_REPORT.md §2.1). First-encountered
  // wins a tie, which is fine: this only needs to be A real concrete moment,
  // not THE single worst one by some exact tiebreak.
  var worstCall = null;
  weekCalls.forEach(function (c) {
    if (!worstCall || c.score < worstCall.score) worstCall = c;
  });

  return {
    weekCalls: weekCalls,
    weeklyAvg: mean_(weekCalls.map(function (c) { return c.score; })),
    historicAvg: mean_(allScores),
    historicAvgBeforeThisWeek: mean_(priorScores),
    historicCount: allScores.length,
    rolling4WeekAvg: mean_(rolling4WeekScores),
    rolling4WeekCount: rolling4WeekScores.length,
    worstCall: worstCall,
    weekFailureModes: weekFailureModes,
    weekFlagMiss: weekFlagMiss,
    weekMissingOutcomeDisposition: weekMissingOutcomeDisposition
  };
}

/** Deterministic "what to work on this week", from Primary Failure Mode, falling back to the two flags. */
function priorityToImprove_(stats) {
  if (!stats.weekCalls.length) return null;

  var top = mostFrequent_(stats.weekFailureModes);
  if (top) return FAILURE_MODE_COACHING_TEXT_[top.value] || ('Focus area: ' + top.value);

  // No Primary Failure Mode signal this week (rows scored before that column
  // existed, or every call genuinely came back "none") — fall back to the
  // two flags every row has always had.
  if (stats.weekFlagMiss.objectionsHandled >= stats.weekFlagMiss.askedForClose &&
    stats.weekFlagMiss.objectionsHandled > 0) {
    return FAILURE_MODE_COACHING_TEXT_.objections_missed;
  }
  if (stats.weekFlagMiss.askedForClose > 0) {
    return FAILURE_MODE_COACHING_TEXT_.no_close_ask;
  }
  return 'No major gaps flagged this week — keep it up, and use Tuesday\'s call to sharpen further.';
}

/**
 * QA_COACHING_RESEARCH_REPORT.md §2.1: task-level feedback tied to a real
 * moment helps; a bare number is close to a worst case for a machine-
 * delivered message — self-directed, evaluative, no task detail, no
 * relationship to soften it. Leads with the worst call's own (now
 * quote-first, per the updated judge prompts) AI Feedback Summary and the
 * week's single priority to improve; every score — this week's, the rolling
 * average, all-time — moves below the fold into a "For the record" section
 * instead of the headline.
 */
function buildWeeklyScorecardEmail_(repCfg, stats, weekStart, weekEnd, tz) {
  var weekLabel = Utilities.formatDate(weekStart, tz, 'dd/MM') + '–' +
    Utilities.formatDate(new Date(weekEnd.getTime() - 1), tz, 'dd/MM/yyyy');
  var subject = repCfg.name + ' — Your Weekly Call Scorecard — week of ' + weekLabel;

  var priority = priorityToImprove_(stats);
  var worstCall = stats.worstCall;
  // Kris's ask (01/09/2026): a manual-review-flagged call (e.g. a
  // [BLANK_AUDIO] recording failure) used to only ever surface as prose
  // buried inside the AI's own feedback paragraph — confusing to read as if
  // it were real coaching feedback about something the rep actually did.
  // Say it plainly, up front, instead.
  var reviewFlagLine = worstCall && worstCall.manualReviewRecommended
    ? '⚠️ Flagged for manual review — the AI could not reliably grade this call (see its own notes below for ' +
      'why, e.g. a blank/failed recording). This should NOT be read as real coaching feedback until a human ' +
      'has checked it.\n\n'
    : '';
  var transcriptLine = worstCall
    ? 'Transcript: ' + (worstCall.transcriptUrl || '(no transcript on file)') + '\n\n'
    : '';

  var taskLevelSection = worstCall && worstCall.feedbackSummary
    ? 'From ' + worstCall.name + ' this week:\n' + reviewFlagLine + worstCall.feedbackSummary + '\n\n' + transcriptLine
    : (stats.weekCalls.length
      ? ''
      : 'No calls were scored this week.\n\n');

  var prioritySection = 'One thing to work on this week: ' +
    (priority || 'Not enough scored calls this week to identify a pattern.') + '\n\n';

  var trendLine = '';
  if (stats.weeklyAvg !== null && stats.historicAvgBeforeThisWeek !== null) {
    var delta = stats.weeklyAvg - stats.historicAvgBeforeThisWeek;
    var arrow = delta > 0.05 ? '▲' : (delta < -0.05 ? '▼' : '–');
    trendLine = ' (' + arrow + ' ' + (delta >= 0 ? '+' : '') + delta.toFixed(1) + ' vs your average before this week)';
  }

  var thisWeekSection = stats.weekCalls.length
    ? stats.weekCalls.length + ' call(s) scored, average ' + stats.weeklyAvg.toFixed(1) + '/5' + trendLine + '\n' +
      stats.weekCalls.map(function (c) { return '• ' + c.name + ' — ' + c.score + '/5'; }).join('\n') + '\n\n'
    : '';

  // A single week is a noisy sample — 2-3 calls either way can swing "This
  // week" a full point. The rolling 4-week average is the more reliable read;
  // its own n is shown alongside it so a 3-call rolling average doesn't get
  // mistaken for a 30-call one.
  var rollingSection = 'Rolling 4-week average: ' + (stats.rolling4WeekAvg !== null
    ? stats.rolling4WeekAvg.toFixed(1) + '/5 across ' + stats.rolling4WeekCount + ' call(s)'
    : 'not enough data yet') + '\n\n';

  var historicSection = 'All-time average: ' + (stats.historicAvg !== null
    ? stats.historicAvg.toFixed(1) + '/5 across ' + stats.historicCount + ' scored call(s)'
    : 'not enough data yet') + '\n\n';

  // Data-hygiene ask, not a coaching point — kept separate from "One thing to
  // work on" above so that stays a single behavior, per the report.
  var outcomeSection = stats.weekMissingOutcomeDisposition
    ? stats.weekMissingOutcomeDisposition + ' of this week\'s call(s) still need an Outcome Disposition ' +
      '(Sold/Not Sold/Follow-up/No-show) logged on the Sales Call Log — when you get a chance.\n\n'
    : '';

  var body =
    'Hi ' + repCfg.name + ',\n\n' +
    'Weekly call scorecard for ' + weekLabel + ':\n\n' +
    taskLevelSection +
    prioritySection +
    'Bring this to Tuesday\'s review call — we\'ll practice objection handling and asking for the money together.\n\n' +
    '— For the record —\n' +
    thisWeekSection +
    rollingSection +
    historicSection +
    outcomeSection +
    '— This is an automated weekly report. This email was drafted by AI and sent automatically; ' +
    'reply to Kris or Tomás with any issues.';

  // Kris's ask (01/09/2026): this email had NO styled htmlBody at all —
  // every other automated email in this codebase (Handoff Brief, Daily
  // Practice Feedback, Compliance nudge, Random Calibration Digest) already
  // got the bold-labels/bullet-list/italic-quote treatment; this one was
  // still plain unstyled text, which is what made it read as "poorly
  // formatted and confusing." escapeHtml_ (Phase4_InboxSLA.gs) guards every
  // AI-generated/dynamic field since this is raw HTML, not Jinja.
  var quotedFeedback = worstCall && worstCall.feedbackSummary
    ? escapeHtml_(worstCall.feedbackSummary).replace(/\n/g, '<br>').replace(/"([^"]+)"/g, '<i>&quot;$1&quot;</i>')
    : '';
  var taskLevelHtml = worstCall && worstCall.feedbackSummary
    ? '<p><strong>From ' + escapeHtml_(worstCall.name) + ' this week:</strong></p>' +
      (worstCall.manualReviewRecommended
        ? '<p style="background:#fff4e5;border-left:4px solid #e0a200;padding:8px 12px;margin:0 0 8px 0;">' +
          '⚠️ <strong>Flagged for manual review</strong> — the AI could not reliably grade this call (see its ' +
          'own notes below for why, e.g. a blank/failed recording). This should NOT be read as real coaching ' +
          'feedback until a human has checked it.</p>'
        : '') +
      '<p>' + quotedFeedback + '</p>' +
      '<p>' + (worstCall.transcriptUrl
        ? '<strong>Transcript:</strong> <a href="' + escapeHtml_(worstCall.transcriptUrl) + '">' +
          escapeHtml_(worstCall.transcriptUrl) + '</a>'
        : '<strong>Transcript:</strong> <i>(no transcript on file)</i>') + '</p>'
    : (stats.weekCalls.length ? '' : '<p>No calls were scored this week.</p>');

  var thisWeekHtml = stats.weekCalls.length
    ? '<p>' + stats.weekCalls.length + ' call(s) scored, average <strong>' + stats.weeklyAvg.toFixed(1) + '/5</strong>' +
      escapeHtml_(trendLine) + '</p>' +
      '<ul style="margin:0 0 12px 0;padding-left:20px;">' +
      stats.weekCalls.map(function (c) { return '<li>' + escapeHtml_(c.name) + ' — ' + c.score + '/5</li>'; }).join('') +
      '</ul>'
    : '';

  var htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    '<p>Hi ' + escapeHtml_(repCfg.name) + ',</p>' +
    '<p>Weekly call scorecard for ' + escapeHtml_(weekLabel) + ':</p>' +
    taskLevelHtml +
    '<p><strong>One thing to work on this week:</strong> ' +
    escapeHtml_(priority || 'Not enough scored calls this week to identify a pattern.') + '</p>' +
    '<p>Bring this to Tuesday\'s review call — we\'ll practice objection handling and asking for the money together.</p>' +
    '<p style="margin:16px 0 4px 0;"><strong style="color:#1a56db;">FOR THE RECORD</strong></p>' +
    thisWeekHtml +
    '<ul style="margin:0 0 12px 0;padding-left:20px;">' +
    '<li><strong>Rolling 4-week average:</strong> ' + (stats.rolling4WeekAvg !== null
      ? stats.rolling4WeekAvg.toFixed(1) + '/5 across ' + stats.rolling4WeekCount + ' call(s)'
      : 'not enough data yet') + '</li>' +
    '<li><strong>All-time average:</strong> ' + (stats.historicAvg !== null
      ? stats.historicAvg.toFixed(1) + '/5 across ' + stats.historicCount + ' scored call(s)'
      : 'not enough data yet') + '</li>' +
    '</ul>' +
    (stats.weekMissingOutcomeDisposition
      ? '<p>' + stats.weekMissingOutcomeDisposition + ' of this week\'s call(s) still need an <strong>Outcome ' +
        'Disposition</strong> (Sold/Not Sold/Follow-up/No-show) logged on the Sales Call Log — when you get a ' +
        'chance.</p>'
      : '') +
    '<p style="color:#666;font-size:12px;margin-top:16px;"><i>— This is an automated weekly report. This email ' +
    'was drafted by AI and sent automatically; reply to Kris or Tomás with any issues.</i></p>' +
    '</div>';

  return { subject: subject, body: body, htmlBody: htmlBody };
}

/** Shared by preview and live paths so they can never drift apart. forcePreview=true never sends, regardless of ENABLED. */
function buildAndMaybeSendScorecards_(forcePreview) {
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var week = getWeekBounds_(new Date(), tz);

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }

  var col = getValidatedColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { log_('No data rows in Sales Call Log.'); return; }
  var rows = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  CONFIG.REPS.forEach(function (repCfg) {
    var stats = computeRepWeeklyStats_(rows, col, repCfg.name, week.start, week.end, tz);
    var email = buildWeeklyScorecardEmail_(repCfg, stats, week.start, week.end, tz);

    if (forcePreview || !WEEKLY_SCORECARD_CONFIG.ENABLED) {
      log_('(preview) ' + repCfg.email + ' <- ' + email.subject + '\n' + email.body + '\n');
      return;
    }
    // Real bug found live (26/08/2026 silent-failure audit): guardedSend_'s
    // return used to be discarded, and appendScorecardHistoryRow_ ran
    // unconditionally — so a config/quota refusal logged "Sent weekly
    // scorecard" and appended a real-looking history row for an email that
    // never went out. Scorecard History exists specifically so a silent
    // non-delivery would be visible (see its own header comment) — this was
    // the exact opposite: it CERTIFIED deliveries that didn't happen.
    var sent = guardedSend_(repCfg.email, email.subject, email.body, {
      cc: CONFIG.KRIS_EMAIL + ',' + CONFIG.TOMAS_EMAIL,
      name: 'Weekly Call Scorecard Bot',
      htmlBody: email.htmlBody
    }, 3); // rep + Kris + Tomás
    if (!sent) {
      log_('Weekly scorecard NOT sent to ' + repCfg.email + ' (guardedSend_ refused) -- no history row appended.');
      return;
    }
    appendScorecardHistoryRow_(repCfg.name, week, stats);
    log_('Sent weekly scorecard to ' + repCfg.email + ' (' + stats.weekCalls.length + ' call(s) this week).');
  });
}

// ---------------------------------------------------------------------------
// Scorecard History — real incident live (25/08/2026): the weekly scorecard
// only ever went out as an email, with nothing persisted anywhere queryable.
// When Monday's trigger silently didn't fire (installWeeklyScorecardTrigger()
// hadn't been run — ENABLED alone doesn't install the trigger, same gap
// RANDOM_CALIBRATION_CONFIG/REGRESSION_DRIFT_CONFIG hit before), there was no
// way to see what past weeks looked like except digging through old emails.
// This tab is purely additive — never read by any code, never changes what
// gets emailed — so it's safe to backfill by hand for any week that's
// missing (just re-run runWeeklyScorecard() for now; a real backfill-from-
// history tool is future work if old weeks matter enough to reconstruct).
// ---------------------------------------------------------------------------

var SCORECARD_HISTORY_SHEET_NAME = 'Scorecard History';
var SCORECARD_HISTORY_HEADERS = [
  'Rep', 'Week Start', 'Week End', 'Calls This Week', 'Weekly Avg Score',
  'Rolling 4-Week Avg', 'Historic Avg (before this week)', 'Priority To Improve',
  'Worst Call', 'Worst Call Score', 'Missing Outcome Disposition', 'Sent At'
];

function getOrCreateScorecardHistorySheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SCORECARD_HISTORY_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SCORECARD_HISTORY_SHEET_NAME);
    sheet.getRange(1, 1, 1, SCORECARD_HISTORY_HEADERS.length).setValues([SCORECARD_HISTORY_HEADERS])
      .setFontWeight('bold').setBackground('#e8eef7');
    sheet.setFrozenRows(1);
    log_('Created "' + SCORECARD_HISTORY_SHEET_NAME + '" tab.');
    return sheet;
  }
  var existing = sheet.getRange(1, 1, 1, SCORECARD_HISTORY_HEADERS.length).getValues()[0];
  var headersMatch = SCORECARD_HISTORY_HEADERS.every(function (h, i) { return existing[i] === h; });
  if (!headersMatch) {
    // Real bug found live (26/08/2026 silent-failure audit): this used to
    // rewrite the header row unconditionally on any mismatch, WITHOUT
    // touching the data rows beneath it. If a column was ever inserted by
    // hand in the middle of this tab, the next real send would silently
    // relabel row 1 so the headers no longer describe the columns below
    // them — every prior row permanently mislabeled, with one Logger line
    // as the only trace. Only auto-repair when the tab genuinely has no
    // data yet (nothing to mislabel); otherwise alert and leave it for a
    // human, matching the Sales Call Log's own no-auto-repair policy
    // (getValidatedColumnMap_, Phase2_CallScoring.gs).
    if (sheet.getLastRow() <= 1) {
      sheet.getRange(1, 1, 1, SCORECARD_HISTORY_HEADERS.length).setValues([SCORECARD_HISTORY_HEADERS])
        .setFontWeight('bold').setBackground('#e8eef7');
      log_('Updated "' + SCORECARD_HISTORY_SHEET_NAME + '" header row to match SCORECARD_HISTORY_HEADERS (no data rows yet).');
    } else {
      sendOpsAlert_('"' + SCORECARD_HISTORY_SHEET_NAME + '" header drift, NOT auto-repaired',
        'The header row no longer matches SCORECARD_HISTORY_HEADERS, but the tab has real data below it, so ' +
        'it was left alone rather than silently relabeled. Fix the header by hand to match the code\'s ' +
        'expected columns:\n\n  ' + SCORECARD_HISTORY_HEADERS.join(', '));
      log_('"' + SCORECARD_HISTORY_SHEET_NAME + '" header mismatch with existing data — NOT auto-repaired, ops alerted.');
    }
  }
  return sheet;
}

/** Appends one row per rep per real (non-preview) send — never called from the preview path, so this tab only ever reflects scorecards that actually went out. */
function appendScorecardHistoryRow_(repName, week, stats) {
  var sheet = getOrCreateScorecardHistorySheet_();
  sheet.appendRow([
    repName,
    week.start,
    new Date(week.end.getTime() - 1),
    stats.weekCalls.length,
    stats.weeklyAvg,
    stats.rolling4WeekAvg,
    stats.historicAvgBeforeThisWeek,
    priorityToImprove_(stats),
    stats.worstCall ? stats.worstCall.name : '',
    stats.worstCall ? stats.worstCall.score : '',
    stats.weekMissingOutcomeDisposition,
    new Date()
  ]);
}

/** Run this FIRST from the editor. Builds this week's three emails and only logs them — sends nothing. */
/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewWeeklyScorecards() {
  return previewWeeklyScorecards_();
}

function previewWeeklyScorecards_() {
  RUN_TAG = 'previewWeeklyScorecards_';
  log_('PREVIEW MODE — building this week\'s scorecards, nothing will be sent.');
  buildAndMaybeSendScorecards_(/*forcePreview=*/true);
}

/** Trigger target. Gated by WEEKLY_SCORECARD_CONFIG.ENABLED as a second safety net. */
function runWeeklyScorecard() {
  RUN_TAG = 'runWeeklyScorecard';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runWeeklyScorecard: another run holds the lock, skipping this firing.');
    return;
  }
  try {
    buildAndMaybeSendScorecards_(/*forcePreview=*/false);
  } finally {
    lock.releaseLock();
  }
}

function installWeeklyScorecardTrigger() {
  RUN_TAG = 'installWeeklyScorecardTrigger';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runWeeklyScorecard') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runWeeklyScorecard')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(WEEKLY_SCORECARD_CONFIG.TRIGGER_HOUR)
    .inTimezone(CONFIG.BUSINESS_TIMEZONE)
    .create();
  log_('Weekly scorecard trigger installed: Mondays ' + WEEKLY_SCORECARD_CONFIG.TRIGGER_HOUR +
    ':00 (' + CONFIG.BUSINESS_TIMEZONE + ').');
}

// ---------------------------------------------------------------------------
// Weekly Training Summary docs — Kris's ask (01/09/2026), after having to
// hand-build three formatted Google Docs at the last minute because Tomás
// had nothing but last week's (already one-cycle-behind) Training Call Plan
// docs to walk into a Tuesday session with. The Weekly Scorecard EMAIL above
// already reviews the week's real sales calls and rates them — this persists
// that same review as a properly formatted Doc (bold/color, same as the
// email's htmlBody, not a plain-text dump) and shares + emails it to Tomás
// automatically, every Tuesday morning, well before the session.
// ---------------------------------------------------------------------------

var WEEKLY_TRAINING_SUMMARY_CONFIG = {
  // Same confirm-before-trusting-new-automation pattern as every other phase
  // — run previewWeeklyTrainingSummaries() and check the log before flipping
  // this true. Nothing is created/shared/sent while false.
  // Flipped true 02/09/2026 after previewWeeklyTrainingSummaries_() ran
  // clean (per-rep sharing + Tomás coaching feedback + week-number subjects
  // all confirmed) and listAllTriggers() confirmed a free slot (19/20).
  ENABLED: true,
  TRIGGER_HOUR: 8, // 8am — Tomás's own time, so it's ready well before the Tuesday session.
  TIMEZONE: 'Europe/Lisbon' // Tomás is in Portugal.
};

/**
 * Every "..." quoted excerpt in text, as {start, end} character offsets —
 * end is inclusive, matching DocumentApp.Text.setItalic(start, end, true)'s
 * own inclusive-end convention. Pure and testable on its own, separate from
 * italicizeQuotesInDocParagraph_ below (which actually calls DocumentApp).
 */
function findQuoteRanges_(text) {
  var ranges = [];
  var re = /"([^"]+)"/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length - 1 });
  }
  return ranges;
}

/** Applies findQuoteRanges_'s ranges as italic runs on a real DocumentApp paragraph. */
function italicizeQuotesInDocParagraph_(paragraph, text) {
  if (!text) return;
  var textElem = paragraph.editAsText();
  findQuoteRanges_(text).forEach(function (r) {
    textElem.setItalic(r.start, r.end, true);
  });
}

/**
 * Kris's ask (02/09/2026): email subjects should carry the week number, same
 * as Phase 6's trainingCallPlanWeekLabel_ does for the Training Call Plan
 * emails. This runs the same Tuesday morning as that training call, so it
 * mirrors trainingCallPlanWeekLabel_'s own logic exactly: the Tuesday
 * session kicks off the FOLLOWING week's cycle, so read the cycle label one
 * day after `now` (landing on the Wednesday that starts that new week),
 * rather than off the just-completed Mon–Sun window this summary reviews —
 * which straddles two different cycle weeks and has no single right answer.
 * Returns null (falls back to the raw date-range weekLabel) if the cycle
 * can't be computed for that day (e.g. run manually on a weekend).
 */
function weeklyTrainingCycleWeekLabel_(now, tz) {
  var nextDay = new Date(now.getTime() + 24 * 3600 * 1000);
  var cycle = computeTrainingCycleLabel_(nextDay, tz);
  return cycle ? 'Week ' + cycle.week : null;
}

/**
 * Pure content builder — testable without DocumentApp, same "build the data,
 * render it separately" split already used for every *Email_ builder in this
 * file. Shaped for renderWeeklyTrainingSummaryDoc_ below; carries the exact
 * same underlying stats as buildWeeklyScorecardEmail_ so the doc and the
 * email can never quietly drift apart on the numbers.
 */
function buildWeeklyTrainingSummaryContent_(repName, stats, weekLabel) {
  var worstCall = stats.worstCall;
  var trendVsPrior = (stats.weeklyAvg !== null && stats.historicAvgBeforeThisWeek !== null)
    ? stats.weeklyAvg - stats.historicAvgBeforeThisWeek
    : null;
  return {
    repName: repName,
    weekLabel: weekLabel,
    hasCalls: stats.weekCalls.length > 0,
    worstCall: worstCall ? {
      name: worstCall.name,
      score: worstCall.score,
      feedbackSummary: worstCall.feedbackSummary || '',
      transcriptUrl: worstCall.transcriptUrl || '',
      manualReviewRecommended: !!worstCall.manualReviewRecommended
    } : null,
    priority: priorityToImprove_(stats),
    weekCalls: stats.weekCalls.map(function (c) { return { name: c.name, score: c.score }; }),
    weeklyAvg: stats.weeklyAvg,
    trendVsPrior: trendVsPrior,
    rolling4WeekAvg: stats.rolling4WeekAvg,
    rolling4WeekCount: stats.rolling4WeekCount,
    historicAvg: stats.historicAvg,
    historicCount: stats.historicCount,
    weekMissingOutcomeDisposition: stats.weekMissingOutcomeDisposition
  };
}

/**
 * Walks DocumentApp to actually build the doc from buildWeeklyTrainingSummaryContent_'s
 * output — same visual language as buildWeeklyScorecardEmail_'s htmlBody (bold section
 * labels, a colored callout for a manual-review-flagged worst call, a scored-calls table,
 * italicized quoted transcript excerpts) but via DocumentApp's rich-text API instead of
 * HTML, since this is a persisted Doc, not an email. Not unit tested (DocumentApp itself
 * isn't stubbed anywhere in this codebase — see the untested playbook-doc builders in
 * Phase1_ComplianceCheck.gs for the same convention); previewWeeklyTrainingSummaries()
 * is the real check before this goes live.
 */
function renderWeeklyTrainingSummaryDoc_(doc, content) {
  var body = doc.getBody();
  body.appendParagraph(content.repName + ' — Weekly Training Summary').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph('Week of ' + content.weekLabel + ' — for Tomás, Tuesday review call').setItalic(true);

  if (!content.hasCalls) {
    body.appendParagraph('No calls were scored this week.');
    return;
  }

  if (content.worstCall) {
    var wc = content.worstCall;
    body.appendParagraph('Worst call this week — ' + wc.name + ' (' + wc.score + '/5)')
      .setHeading(DocumentApp.ParagraphHeading.HEADING2);

    if (wc.manualReviewRecommended) {
      var flagPara = body.appendParagraph('⚠️ Flagged for manual review — do NOT hold this against ' +
        content.repName + '. The AI could not reliably grade this call (see the notes below for why, e.g. a ' +
        'blank/failed recording).');
      flagPara.setBackgroundColor('#fff4e5');
      flagPara.editAsText().setForegroundColor('#7a5b00').setBold(true);
    }

    var feedbackPara = body.appendParagraph(wc.feedbackSummary);
    italicizeQuotesInDocParagraph_(feedbackPara, wc.feedbackSummary);

    var transcriptText = 'Transcript: ' + (wc.transcriptUrl || '(no transcript on file)');
    var transcriptPara = body.appendParagraph(transcriptText);
    if (wc.transcriptUrl) {
      transcriptPara.editAsText().setLinkUrl('Transcript: '.length, transcriptText.length - 1, wc.transcriptUrl);
    }
  } else {
    body.appendParagraph('No individual call feedback available this week.');
  }

  body.appendParagraph('One thing to work on this week').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  var priorityText = content.priority || 'Not enough scored calls this week to identify a pattern.';
  var priorityPara = body.appendParagraph(priorityText);
  priorityPara.setBackgroundColor('#e6f4ea');
  priorityPara.editAsText().setForegroundColor('#0b8043').setBold(true);

  body.appendParagraph('For the record').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  var tableRows = [['Prospect', 'Score']].concat(
    content.weekCalls.map(function (c) { return [c.name, c.score + '/5']; }));
  var table = body.appendTable(tableRows);
  var headerRow = table.getRow(0);
  headerRow.editAsText().setBold(true).setForegroundColor('#ffffff');
  for (var col = 0; col < headerRow.getNumCells(); col++) headerRow.getCell(col).setBackgroundColor('#1a4d8f');
  content.weekCalls.forEach(function (c, i) {
    var scoreCell = table.getRow(i + 1).getCell(1);
    if (c.score <= 2) scoreCell.editAsText().setForegroundColor('#c0392b').setBold(true);
    else if (c.score >= 5) scoreCell.editAsText().setForegroundColor('#0b8043').setBold(true);
  });

  var trendText = content.trendVsPrior !== null
    ? ' (' + (content.trendVsPrior >= 0 ? '▲ +' : '▼ ') + content.trendVsPrior.toFixed(1) + ' vs prior average)'
    : '';
  body.appendParagraph(
    content.weekCalls.length + ' call(s) scored, average ' + content.weeklyAvg.toFixed(1) + '/5' + trendText + '   |   ' +
    'Rolling 4-week average: ' + (content.rolling4WeekAvg !== null
      ? content.rolling4WeekAvg.toFixed(1) + '/5 across ' + content.rolling4WeekCount + ' call(s)'
      : 'not enough data yet') + '   |   ' +
    'All-time average: ' + (content.historicAvg !== null
      ? content.historicAvg.toFixed(1) + '/5 across ' + content.historicCount + ' call(s)'
      : 'not enough data yet'));

  if (content.weekMissingOutcomeDisposition) {
    var outcomePara = body.appendParagraph(content.weekMissingOutcomeDisposition +
      ' of this week\'s call(s) still need an Outcome Disposition logged on the Sales Call Log.');
    outcomePara.setBackgroundColor('#fce8e6');
    outcomePara.editAsText().setForegroundColor('#c0392b');
  }
}

/** Shared by preview and live paths so they can never drift apart, same pattern as buildAndMaybeSendScorecards_. */
function buildAndSendWeeklyTrainingSummaries_(dryRun) {
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var now = new Date();
  var week = getWeekBounds_(now, tz);

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }
  var col = getValidatedColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { log_('No data rows in Sales Call Log.'); return; }
  var rows = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  var weekLabel = Utilities.formatDate(week.start, tz, 'dd/MM') + '–' +
    Utilities.formatDate(new Date(week.end.getTime() - 1), tz, 'dd/MM/yyyy');
  var cycleWeekLabel = weeklyTrainingCycleWeekLabel_(now, tz);
  var subjectWeekPart = cycleWeekLabel ? cycleWeekLabel + ' — ' + weekLabel : weekLabel;

  var links = [];
  CONFIG.REPS.forEach(function (repCfg) {
    var stats = computeRepWeeklyStats_(rows, col, repCfg.name, week.start, week.end, tz);
    var content = buildWeeklyTrainingSummaryContent_(repCfg.name, stats, weekLabel);
    var docTitle = repCfg.name + ' — Weekly Training Summary (' + weekLabel + ')';

    if (dryRun) {
      log_('(preview) Would create + share "' + docTitle + '" with Tomás and ' + repCfg.email + ' — ' +
        (content.hasCalls
          ? content.weekCalls.length + ' call(s), worst: ' + (content.worstCall ? content.worstCall.name +
            ' (' + content.worstCall.score + '/5)' : 'n/a')
          : 'no calls scored this week'));
      return;
    }

    var doc = DocumentApp.create(docTitle);
    renderWeeklyTrainingSummaryDoc_(doc, content);
    doc.saveAndClose();
    var docUrl = 'https://docs.google.com/document/d/' + doc.getId() + '/edit';
    // Kris's ask (01/09/2026): "make sure the documents are OPEN for Thomas"
    // — explicit share, not just relying on him being CC'd on the email below.
    // Kris's ask (02/09/2026): the rep themselves needs to see their own
    // training plan too, not just Tomás.
    var file = DriveApp.getFileById(doc.getId());
    file.addCommenter(CONFIG.TOMAS_EMAIL);
    file.addCommenter(repCfg.email);
    links.push({ rep: repCfg.name, email: repCfg.email, url: docUrl });

    var repSubject = repCfg.name + ' — Your Weekly Training Summary — ' + subjectWeekPart;
    var repBody = 'Hi ' + repCfg.name + ',\n\n' +
      "This week's training summary is ready ahead of today's session with Tomás:\n\n" + docUrl +
      '\n\n— Automated weekly report. Reply to Kris with any issues.';
    var repSent = guardedSend_(repCfg.email, repSubject, repBody,
      { cc: CONFIG.TOMAS_EMAIL + ',' + CONFIG.KRIS_EMAIL, name: 'Weekly Training Summary Bot' }, 3);
    log_((repSent ? 'Sent' : 'SEND FAILED/SKIPPED for') + ' weekly training summary to ' + repCfg.name + '.');
  });

  if (dryRun) return;
  if (!links.length) { log_('No weekly training summary docs created (no data rows for any rep this week).'); return; }

  var subject = "This week's Training Summaries — " + subjectWeekPart + ' — ready for today\'s session';
  var lines = links.map(function (l) { return l.rep + ': ' + l.url; }).join('\n');
  var body = 'Hi Tomás,\n\n' +
    "This week's training summaries are ready — reviews + priorities from every real sales call scored " +
    'this week, one doc per rep (each rep has also received their own):\n\n' + lines +
    '\n\n— Automated weekly report. Reply to Kris with any issues.';
  var sent = guardedSend_(CONFIG.TOMAS_EMAIL, subject, body, { cc: CONFIG.KRIS_EMAIL, name: 'Weekly Training Summary Bot' }, 2);
  log_((sent ? 'Sent' : 'SEND FAILED/SKIPPED for') + ' weekly training summary doc links to Tomás (' +
    links.length + ' rep doc(s) created' + (sent ? '' : ' but not emailed') + ').');
}

/** Run this FIRST from the editor. Logs what would be created/shared/sent — creates nothing, sends nothing. */
/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewWeeklyTrainingSummaries() {
  return previewWeeklyTrainingSummaries_();
}

function previewWeeklyTrainingSummaries_() {
  RUN_TAG = 'previewWeeklyTrainingSummaries_';
  log_('PREVIEW MODE — building this week\'s training summary docs, nothing will be created/shared/sent.');
  buildAndSendWeeklyTrainingSummaries_(/*dryRun=*/true);
}

/** Trigger target. Gated by WEEKLY_TRAINING_SUMMARY_CONFIG.ENABLED as a second safety net. */
function runWeeklyTrainingSummaries() {
  RUN_TAG = 'runWeeklyTrainingSummaries';
  if (!WEEKLY_TRAINING_SUMMARY_CONFIG.ENABLED) {
    log_('WEEKLY_TRAINING_SUMMARY_CONFIG.ENABLED is false — skipping (run previewWeeklyTrainingSummaries() instead).');
    return;
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runWeeklyTrainingSummaries: another run holds the lock, skipping this firing.');
    return;
  }
  try {
    buildAndSendWeeklyTrainingSummaries_(/*dryRun=*/false);
  } finally {
    lock.releaseLock();
  }
}

/**
 * NOTE (01/09/2026): Apps Script projects cap out at 20 installable triggers
 * total (see listAllTriggers() in Phase2_CallScoring.gs) — check that before
 * running this. Tuesday 8am Europe/Lisbon is deliberately BEFORE
 * TOMAS_TRANSCRIPT_REMINDER_CONFIG's own Tuesday-midday-Lisbon reminder
 * (Phase6_TrainingCallReview.gs), so the summary docs are already in his
 * inbox before that later nudge about uploading the recording.
 */
function installWeeklyTrainingSummaryTrigger() {
  RUN_TAG = 'installWeeklyTrainingSummaryTrigger';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runWeeklyTrainingSummaries') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runWeeklyTrainingSummaries')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.TUESDAY)
    .atHour(WEEKLY_TRAINING_SUMMARY_CONFIG.TRIGGER_HOUR)
    .inTimezone(WEEKLY_TRAINING_SUMMARY_CONFIG.TIMEZONE)
    .create();
  log_('Weekly training summary trigger installed: Tuesdays ' + WEEKLY_TRAINING_SUMMARY_CONFIG.TRIGGER_HOUR +
    ':00 (' + WEEKLY_TRAINING_SUMMARY_CONFIG.TIMEZONE + ').');
}
