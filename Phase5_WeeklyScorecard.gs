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
  both: 'Both the close ask and objection handling need work this week — start with directly asking for the money.',
  weak_discovery: 'Slow down before pitching — ask real discovery questions about production volume, marketing spend, and team structure.',
  no_goal_alignment: 'Get the lead to state their own numeric goal, then explicitly tie the offer back to that number.',
  no_second_call_booked: 'Lock a specific date/time for the next call before ending — don\'t leave follow-up as an open "I\'ll email you."',
  multiple: 'Several gaps showed up this week — see individual call feedback in the tracker for specifics.'
};

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
function getWeekBounds_(now, tz) {
  var end = mondayAtMidnight_(now, tz);
  var start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
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
function computeRepWeeklyStats_(rows, col, repName, weekStart, weekEnd) {
  var allScores = [];
  var priorScores = []; // all-time excluding this week — basis for the trend line
  var weekCalls = [];
  var weekFailureModes = [];
  var weekFlagMiss = { askedForClose: 0, objectionsHandled: 0 };
  var rolling4WeekScores = [];
  var rolling4WeekStart = new Date(weekEnd.getTime() - 4 * 7 * 24 * 3600 * 1000);

  rows.forEach(function (row) {
    if (String(row[col['Rep'] - 1] || '').trim() !== repName) return;
    var score = row[col['Call Quality Score'] - 1];
    if (typeof score !== 'number') return; // only rows Phase 2 has actually scored

    allScores.push(score);
    var callDate = row[col['Call Date'] - 1];
    var inWeek = callDate instanceof Date && callDate >= weekStart && callDate < weekEnd;
    var inRolling4Weeks = callDate instanceof Date && callDate >= rolling4WeekStart && callDate < weekEnd;

    if (inRolling4Weeks) rolling4WeekScores.push(score);

    if (inWeek) {
      weekCalls.push({
        name: row[col['Prospect Name'] - 1] || '(unnamed)',
        score: score,
        feedbackSummary: String(row[col['AI Feedback Summary'] - 1] || '').trim()
      });
      var pfm = String(row[col['Primary Failure Mode'] - 1] || '').trim();
      if (pfm && pfm !== 'none') weekFailureModes.push(pfm);
      if (row[col['Flag: Asked For Close'] - 1] === false) weekFlagMiss.askedForClose++;
      if (row[col['Flag: Objections Handled'] - 1] === false) weekFlagMiss.objectionsHandled++;
    } else {
      priorScores.push(score);
    }
  });

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
    weekFlagMiss: weekFlagMiss
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

  var taskLevelSection = stats.worstCall && stats.worstCall.feedbackSummary
    ? 'From ' + stats.worstCall.name + ' this week:\n' + stats.worstCall.feedbackSummary + '\n\n'
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
    '— This is an automated weekly report. This email was drafted by AI and sent automatically; ' +
    'reply to Kris or Tomás with any issues.';

  return { subject: subject, body: body };
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
    var stats = computeRepWeeklyStats_(rows, col, repCfg.name, week.start, week.end);
    var email = buildWeeklyScorecardEmail_(repCfg, stats, week.start, week.end, tz);

    if (forcePreview || !WEEKLY_SCORECARD_CONFIG.ENABLED) {
      log_('(preview) ' + repCfg.email + ' <- ' + email.subject + '\n' + email.body + '\n');
      return;
    }
    guardedSend_(repCfg.email, email.subject, email.body, {
      cc: CONFIG.KRIS_EMAIL + ',' + CONFIG.TOMAS_EMAIL,
      name: 'Weekly Call Scorecard Bot'
    }, 3); // rep + Kris + Tomás
    log_('Sent weekly scorecard to ' + repCfg.email + ' (' + stats.weekCalls.length + ' call(s) this week).');
  });
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
