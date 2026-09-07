/**
 * Phase17_SeanFollowUpAutomation.gs
 *
 * Automates Sean's lead follow-up drafting, per "Automating Follow-Ups for
 * Sean — Plan (v2)" (Google Doc, 03/09/2026, comments resolved by Tomás and
 * Kris 04-06/09/2026). Sean manually works 200+ warm leads Joana hands him;
 * his own contact tracker sheet has been stale for 3 months. Fix: draft his
 * outreach/follow-ups for him, based on his own Sent folder activity, not a
 * spreadsheet he has to remember to update.
 *
 * Two cadences:
 *   Cadence 1 (New Leads) — handoff -> initial outreach draft -> (Sean calls
 *     manually) -> follow-up draft 2 business days later -> breakup draft 4
 *     business days later, each at the SAME TIME OF DAY the lead's original
 *     reply came in (a real, specific requirement — see
 *     addBusinessDaysPreservingTimeOfDay_ below).
 *   Cadence 2 (Re-engagement) — a lead who had a real call (QC/Sales Call/
 *     Closing) but didn't convert gets re-engaged at 1 week / 1 month /
 *     3 months / 6 months / 12 months after that call, to rebook the NEXT
 *     call in the sequence. Confirmed unblocked 06/09/2026 (Kris: "All calls
 *     are made through GHL and everything's tracked") — reads stage/timing
 *     from GHL's existing read-only plumbing (ghlListOpportunitiesForContact_,
 *     Phase9_GhlSync.gs), no new tracking needed.
 * Marking a lead dead: a Gmail label (per Kris's confirmation 06/09/2026)
 * checked before any draft is generated — same STOPPED-state-machine spirit
 * as lead_followup_sequences.gs's other queues, just label-based since that
 * doesn't depend on Sean remembering to update a separate sheet.
 *
 * STATUS (06/09/2026) — NOT YET BUILDABLE END TO END. Two real blockers:
 *   1. gmail.compose scope requested on the shared domain-wide-delegation
 *      service account (same Client ID Phase 4/Phase 8 already use for
 *      gmail.readonly) — granted in Admin Console 06/09/2026, propagation
 *      pending. Drafting can't actually happen in Sean's mailbox until this
 *      is live.
 *   2. Cadence 1's trigger — detecting "Joana just handed Sean a lead" — has
 *      no real email example to build a reliable pattern from yet. Building
 *      this blind risks a detector that silently misses every handoff,
 *      exactly the "looks done, is actually invisible" failure this
 *      project's other silent-failure audits keep finding. Waiting on a real
 *      example/description from Kris before writing the detection logic.
 *
 * This file ships the parts that depend on NEITHER blocker — pure, tested,
 * ready to wire in once both land: the business-day/time-of-day scheduling
 * math (the plan's own "real, specific requirement," not just N-days-later-
 * whenever-the-trigger-runs), the dead-lead label check, and the tracking
 * sheet Cadence 1's state machine will live in.
 */

var SEAN_FOLLOWUP_CONFIG = {
  ENABLED: false, // blocked — see file header
  DEAD_LABEL: 'Dead',
  CADENCE1_FOLLOWUP_BUSINESS_DAYS: 2,
  CADENCE1_BREAKUP_BUSINESS_DAYS: 4,
  // Cadence 2's own steps — re-engage this long after the lead's last real
  // call (QC/Sales Call/Closing), aiming to rebook the next one in sequence.
  // Unlike Cadence 1's business-day math, this doesn't need time-of-day
  // precision (the plan's exact-time requirement is specific to Cadence 1) —
  // these are week/month-scale windows, so plain calendar month/day
  // arithmetic (addMonthsAndDays_) is precise enough.
  CADENCE2_STEPS: [
    { label: '1 week', months: 0, days: 7 },
    { label: '1 month', months: 1, days: 0 },
    { label: '3 months', months: 3, days: 0 },
    { label: '6 months', months: 6, days: 0 },
    { label: '12 months', months: 12, days: 0 }
  ]
};

var SEAN_FOLLOWUP_TRACKER_SHEET_NAME = 'Sean Follow-Up Tracker';
var SEAN_FOLLOWUP_TRACKER_HEADERS = [
  'Thread ID',      // Gmail thread id — join key back to the real conversation
  'Lead Email',
  'Lead Name',
  'Cadence',        // 'new_lead' | 're_engagement'
  'Stage',          // e.g. 'outreach_sent' | 'followup_sent' | 'breakup_sent' | 'awaiting_call' — cadence-1 specific values TBD once handoff detection is built
  'Anchor Date',    // the timestamp everything else is scheduled off of (lead's reply time for cadence 1, last call date for cadence 2)
  'Last Action At', // when this system last drafted/sent something for this lead
  'Status',         // '' (active) | 'STOPPED' (dead-labeled) | 'BOOKED' (converted, no more follow-up needed)
  'Notes'
];

/**
 * Builds a real Date instant for year/month/day at hour:minute:second, in
 * CONFIG.BUSINESS_TIMEZONE — same DST-safe two-step trick as
 * dateAtMidnightInBusinessTimezone_ (Phase2_CallScoring.gs: build a rough
 * instant to ask Utilities for the correct DST offset, then reconstruct the
 * real instant explicitly with that offset), generalized to an arbitrary
 * time of day instead of always midnight.
 */
function dateAtTimeInBusinessTimezone_(year, month, day, hour, minute, second) {
  var pad = function (n) { return n < 10 ? '0' + n : String(n); };
  var dateStr = year + '/' + pad(month) + '/' + pad(day);
  var timeStr = pad(hour) + ':' + pad(minute) + ':' + pad(second);
  var rough = new Date(dateStr + ' 12:00:00');
  var offset = Utilities.formatDate(rough, CONFIG.BUSINESS_TIMEZONE, 'Z');
  return new Date(dateStr + ' ' + timeStr + ' GMT' + offset);
}

/**
 * Adds N BUSINESS days (skips Saturday/Sunday — unlike shiftBusinessDate_,
 * Phase5_WeeklyScorecard.gs, which shifts by literal calendar days) to
 * startInstant, preserving its exact wall-clock time of day in
 * CONFIG.BUSINESS_TIMEZONE. This is the plan doc's own "real, specific
 * requirement" for Cadence 1: "at the same time of day the lead's original
 * reply came in... not just N business days later, whenever the trigger
 * happens to run." Walks calendar days in UTC-noon-anchored space (same
 * DST-safe technique shiftBusinessDate_ uses) so a DST transition mid-span
 * can't shift the result by an hour — confirmed real risk class in this
 * codebase (see shiftBusinessDate_'s own header comment).
 */
function addBusinessDaysPreservingTimeOfDay_(startInstant, businessDays) {
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var hour = Number(Utilities.formatDate(startInstant, tz, 'HH'));
  var minute = Number(Utilities.formatDate(startInstant, tz, 'mm'));
  var second = Number(Utilities.formatDate(startInstant, tz, 'ss'));

  var y = Number(Utilities.formatDate(startInstant, tz, 'yyyy'));
  var m = Number(Utilities.formatDate(startInstant, tz, 'MM'));
  var d = Number(Utilities.formatDate(startInstant, tz, 'dd'));
  var cursorNoonUtc = Date.UTC(y, m - 1, d, 12);

  var remaining = businessDays;
  while (remaining > 0) {
    cursorNoonUtc += 24 * 3600 * 1000;
    if (!isWeekendInBusinessTz_(new Date(cursorNoonUtc))) remaining--;
  }
  var landed = new Date(cursorNoonUtc);
  return dateAtTimeInBusinessTimezone_(
    landed.getUTCFullYear(), landed.getUTCMonth() + 1, landed.getUTCDate(),
    hour, minute, second
  );
}

/** Plain calendar month/day arithmetic — see CADENCE2_STEPS's own comment on why this doesn't need business-timezone precision the way Cadence 1's math does. */
function addMonthsAndDays_(date, months, days) {
  var d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Cadence 2's full re-engagement schedule for one lead, anchored to the date
 * of their last real call. Pure — callers cross-reference against the
 * tracker/GHL to decide which (if any) step is actually due and not yet
 * acted on.
 */
function cadence2ReengagementSchedule_(lastCallDate) {
  return SEAN_FOLLOWUP_CONFIG.CADENCE2_STEPS.map(function (step) {
    return { label: step.label, dueAt: addMonthsAndDays_(lastCallDate, step.months, step.days) };
  });
}

/** True if the Gmail thread's labels include the configured dead-lead label — checked before any draft is generated, for either cadence. */
function isThreadMarkedDead_(labelNames) {
  return (labelNames || []).indexOf(SEAN_FOLLOWUP_CONFIG.DEAD_LABEL) !== -1;
}

/**
 * Cadence 1's bookkeeping tab — the automation's own state machine (not
 * something Sean maintains by hand; his real activity signal is his Sent
 * folder, per the plan doc). Safe to re-run, no-ops once created. Same
 * getOrCreate-plus-frozen-header pattern as every other phase's own tab
 * (e.g. getOrCreateTrainingAssignmentsSheet_, Phase6_TrainingCallReview.gs).
 */
function getOrCreateSeanFollowUpTrackerSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SEAN_FOLLOWUP_TRACKER_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SEAN_FOLLOWUP_TRACKER_SHEET_NAME);
    sheet.getRange(1, 1, 1, SEAN_FOLLOWUP_TRACKER_HEADERS.length).setValues([SEAN_FOLLOWUP_TRACKER_HEADERS])
      .setFontWeight('bold').setBackground('#e8eef7');
    sheet.setFrozenRows(1);
    log_('Created "' + SEAN_FOLLOWUP_TRACKER_SHEET_NAME + '" tab.');
  }
  return sheet;
}
