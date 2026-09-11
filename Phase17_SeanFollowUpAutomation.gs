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
 *     are made through GHL and everything's tracked"). Built 07/09/2026
 *     against the Sales Call Log directly instead — it already carries
 *     exactly the "which call stage, and when" signal the original plan doc
 *     (see TOMÁS'S GUIDELINES below) said was missing (Rep/Call Type/Call
 *     Date/Outcome Disposition, all already scored by Phase 2), so no GHL
 *     round-trip is actually needed for detection. Per Kris's explicit ask
 *     (07/09/2026): generalized to EVERY rep's stalled leads (Bens/Joana/
 *     Sean/Tomás — CADENCE2_REPS below), not just Sean's — the plan doc's
 *     cadence itself was never Sean-specific, only Cadence 1 (the Joana->
 *     Sean handoff) is.
 *
 * TOMÁS'S GUIDELINES (comments on the "Automating Follow-Ups for Sean —
 * Plan (v2)" doc, confirmed 04/09/2026 — read in full 07/09/2026):
 *   - "When Joana brings Sean in, it's because the lead needs calling, so
 *     it's Call Attempt first, then email." Corrects the plan's own listed
 *     order (outreach email drafted before the call attempt) — the call
 *     comes first; the email side exists so the email channel never goes
 *     stale while Sean's making calls, not as step 1. Applies once drafting
 *     itself is built (still blocked on gmail.compose) — noted here so it
 *     isn't lost before that step exists.
 *   - "2 business days later after Sean outreach" — clarifies the Cadence 1
 *     follow-up's anchor: 2 business days after SEAN'S OWN outreach send
 *     time, not the lead's original (pre-handoff) reply time. The detection
 *     built below still records the handoff moment as Anchor Date (that's
 *     genuinely when the lead became Sean's), but once drafting exists, the
 *     follow-up/breakup schedule must be recomputed off Sean's actual send
 *     timestamp for that lead's outreach email, not off Anchor Date.
 *   - "just need to teach Sean how to schedule, easy" — on how Sean should
 *     actually book the call once he reaches someone; a training note, not
 *     something this automation builds.
 * Marking a lead dead: a Gmail label (per Kris's confirmation 06/09/2026)
 * checked before any draft is generated — same STOPPED-state-machine spirit
 * as lead_followup_sequences.gs's other queues, just label-based since that
 * doesn't depend on Sean remembering to update a separate sheet.
 *
 * STATUS (07/09/2026) — Cadence 1's detection blocker is RESOLVED. Tomás's
 * answer, confirmed 07/09/2026: "Joana adds Sean to the thread and updates
 * SPAM - Sean. The subject is the same of the ongoing email exchange and
 * Sean can see the thread." This means the handoff signal is a Gmail LABEL
 * ("SPAM - Sean") Joana applies in HER OWN mailbox, not a subject-line or
 * body-text pattern in an email — so detection doesn't need to parse
 * forwarded-email text at all: watch Joana's mailbox (already-granted
 * gmail.readonly domain-wide delegation, same as Phase4_InboxSLA.gs/
 * Phase8_ReplyTracker.gs, both already live against her mailbox — no new
 * Admin Console setup needed for THIS part) for threads carrying that
 * label, and treat each one not already in the tracker as a fresh handoff.
 * See collectNewSeanHandoffThreads_ below.
 *
 * ONE REAL BLOCKER REMAINS: gmail.compose scope requested on the shared
 * domain-wide-delegation service account (same Client ID Phase 4/Phase 8
 * already use for gmail.readonly) — granted in Admin Console 06/09/2026,
 * propagation not yet independently confirmed. This only blocks actually
 * DRAFTING Sean's outreach/follow-up emails, not detection — so
 * SEAN_FOLLOWUP_CONFIG.DETECTION_ENABLED is its own separate flag from
 * SEAN_FOLLOWUP_CONFIG.ENABLED, letting handoff detection/tracking go live
 * (real visibility into pending handoffs for Tomás/Kris) independently of
 * whether drafting is ready yet. Flip ENABLED (and build the actual draft-
 * composing calls) only once a real compose call against Sean's mailbox has
 * been confirmed working.
 *
 * This file ships: the business-day/time-of-day scheduling math (the plan's
 * own "real, specific requirement," not just N-days-later-whenever-the-
 * trigger-runs), the dead-lead label check, the tracking sheet Cadence 1's
 * state machine lives in, and now the handoff detection itself.
 */

var SEAN_FOLLOWUP_CONFIG = {
  ENABLED: false, // full pipeline (drafting) — still blocked on gmail.compose, see file header
  DETECTION_ENABLED: false, // Cadence 1 handoff detection/tracking only — flip after previewSeanHandoffDetection() looks right; does NOT need gmail.compose
  CADENCE2_ENABLED: false, // Cadence 2 re-engagement digest — flip after previewReengagementDigest() looks right; does NOT need gmail.compose either (detection + email only, no drafting)
  DEAD_LABEL: 'Dead',
  // Tomás's confirmed answer (07/09/2026) — see file header. Joana's own
  // mailbox, not Sean's: labels are per-mailbox in Gmail, so this only shows
  // up when reading HER inbox, not his (he just sees a normal thread he's
  // now a recipient on).
  HANDOFF_LABEL: 'SPAM - Sean',
  HANDOFF_IMPERSONATE_EMAIL: 'joana@iconsofrealestate.com',
  CADENCE1_FOLLOWUP_BUSINESS_DAYS: 2,
  CADENCE1_BREAKUP_BUSINESS_DAYS: 4,
  // Was a standalone daily trigger's own atHour(9) — now the hour
  // runPhase17To19StandingChecks_ (below) gates on, since Cadence 2 shares
  // a trigger with Cadence 1/Phase 18/Phase 19 (trigger-cap consolidation,
  // 07/09/2026 — see that function's own header).
  CADENCE2_TRIGGER_HOUR: 9,
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
  ],
  // Kris's explicit ask (07/09/2026): "build it with his guidelines but also
  // Bens and Joana old leads, and Tomas too" — every rep's stalled leads, not
  // just Sean's. The plan doc's Cadence 2 was never Sean-specific; only
  // Cadence 1 (the handoff itself) is.
  CADENCE2_REPS: ['Bens', 'Joana', 'Sean', 'Tomás'],
  // "A real call" for Cadence 2 purposes, per the plan doc: "QC, Sales Call,
  // or Closing/2nd Sales Call." This codebase has no separate call_type for
  // a closing call — it's Call Type = 'Sales Call' with Rep = Tomás (see
  // _display_call_type, tools/dashboard/app.py) — so both plain 'Sales Call'
  // and Tomás's own closing calls are already covered by including
  // 'Sales Call' once. Discovery is deliberately excluded — the plan doc
  // never names it, and it's the account manager's own call, not a stage in
  // this rep's sales sequence.
  CADENCE2_CALL_TYPES: ['QC', 'Sales Call']
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

// ---------------------------------------------------------------------------
// Cadence 2 detection — Kris's ask (07/09/2026): "build it with his
// guidelines but also Bens and Joana old leads, and Tomas too." Reads the
// Sales Call Log directly (Rep/Call Type/Call Date/Outcome Disposition,
// already scored by Phase 2) rather than GHL — it already has exactly the
// "which stage, when" signal the original plan doc said was missing.
// Detection-only, same shape as Cadence 1: finds who's due, records it, and
// emails a digest — never auto-drafts (drafting is a distinct future step,
// same gmail.compose blocker as Cadence 1).
// ---------------------------------------------------------------------------

/** A stable key for "this lead" across rows — email when present (more reliable across a name typo/nickname), else the normalized prospect name. */
function reengagementLeadKey_(prospectEmail, prospectName) {
  var email = String(prospectEmail || '').trim().toLowerCase();
  if (email) return 'email:' + email;
  return 'name:' + normalize_(prospectName);
}

/**
 * Pure. For every (rep, lead) pair with at least one Cadence-2-eligible call
 * (SEAN_FOLLOWUP_CONFIG.CADENCE2_CALL_TYPES) in `rows`, finds their single
 * MOST RECENT such call — that's the stage they're currently stalled at; an
 * earlier call for the same lead is superseded, not a separate stage to
 * re-engage on its own schedule. Excludes any lead whose most recent call
 * already resulted in "Sold" — a closed deal needs no re-engagement.
 * Rep matching is case-insensitive (same convention as computeRepWeeklyStats_,
 * Phase5_WeeklyScorecard.gs) but returns SEAN_FOLLOWUP_CONFIG.CADENCE2_REPS'
 * own canonical spelling, so "Tomas"/"Tomás" typed variants group together.
 */
function findLastRealCallPerLead_(rows, col) {
  var byKey = {};
  rows.forEach(function (row) {
    var rawRep = String(row[col['Rep'] - 1] || '').trim();
    var rep = SEAN_FOLLOWUP_CONFIG.CADENCE2_REPS.filter(function (r) {
      return r.toLowerCase() === rawRep.toLowerCase();
    })[0];
    if (!rep) return;
    var callType = String(row[col['Call Type'] - 1] || '').trim();
    if (SEAN_FOLLOWUP_CONFIG.CADENCE2_CALL_TYPES.indexOf(callType) === -1) return;
    var callDate = row[col['Call Date'] - 1];
    if (!(callDate instanceof Date)) return;

    var leadKey = reengagementLeadKey_(row[col['Prospect Email'] - 1], row[col['Prospect Name'] - 1]);
    var key = rep + '|' + leadKey;
    var existing = byKey[key];
    if (!existing || callDate > existing.callDate) {
      byKey[key] = {
        rep: rep,
        leadKey: leadKey,
        prospectName: row[col['Prospect Name'] - 1] || '(unnamed)',
        prospectEmail: String(row[col['Prospect Email'] - 1] || '').trim(),
        callType: callType,
        callDate: callDate,
        outcomeDisposition: String(row[col['Outcome Disposition'] - 1] || '').trim()
      };
    }
  });
  return Object.keys(byKey).map(function (k) { return byKey[k]; }).filter(function (c) {
    return c.outcomeDisposition.toLowerCase() !== 'sold';
  });
}

/**
 * Pure. Which (if any) Cadence 2 step is due for one lead's last-call record,
 * as of `today`, that isn't already in `notifiedKeys` (strings shaped
 * "rep|leadKey|stepLabel" — see getNotifiedReengagementKeys_). Returns the
 * LATEST due-and-unnotified step, not every one that's technically overdue —
 * a lead stalled 4 months (e.g. because this phase was off) gets caught up
 * once on the 3-month step, not backfilled with 1-week AND 1-month AND
 * 3-month all at once.
 */
function dueReengagementStepFor_(lastCall, today, notifiedKeys) {
  var schedule = cadence2ReengagementSchedule_(lastCall.callDate);
  var due = schedule.filter(function (s) { return s.dueAt <= today; });
  for (var i = due.length - 1; i >= 0; i--) {
    var key = lastCall.rep + '|' + lastCall.leadKey + '|' + due[i].label;
    if (notifiedKeys.indexOf(key) === -1) {
      return { label: due[i].label, dueAt: due[i].dueAt, notifiedKey: key };
    }
  }
  return null;
}

/**
 * Combines findLastRealCallPerLead_ + dueReengagementStepFor_ into the final
 * due list. Pure. `overrideActions` is the map returned by
 * getReengagementOverrideActions_ (keys "rep|leadKey" -> last action a rep
 * set from the dashboard, e.g. 'cancelled') — a cancelled lead is skipped
 * entirely, same as if it had been marked Sold. Optional (defaults to {})
 * so existing single-rep callers/tests don't all need updating.
 */
function findDueReengagements_(rows, col, today, notifiedKeys, overrideActions) {
  overrideActions = overrideActions || {};
  var due = [];
  findLastRealCallPerLead_(rows, col).forEach(function (c) {
    if (overrideActions[c.rep + '|' + c.leadKey] === 'cancelled') return;
    var step = dueReengagementStepFor_(c, today, notifiedKeys);
    if (step) {
      due.push({
        rep: c.rep, prospectName: c.prospectName, prospectEmail: c.prospectEmail,
        callType: c.callType, callDate: c.callDate,
        stepLabel: step.label, dueAt: step.dueAt, notifiedKey: step.notifiedKey
      });
    }
  });
  return due;
}

// ---------------------------------------------------------------------------
// Re-engagement Overrides — Kris's ask (07/09/2026): "would be nice for each
// rep to be able to see a list of all their old leads, in order of priority
// and the rep can then lower the priority or cancel the follow up." The
// dashboard (tools/dashboard/) is where a rep actually does this — this tab
// is the one thing it writes back to the Sheet (sheets_write.py, same
// append-only "last row wins" convention as Training Priority Overrides).
// 'cancelled' actually changes automation behavior (findDueReengagements_
// above skips that lead permanently until reactivated); 'deprioritized' is
// display-only ranking for the dashboard's own leads list and has no effect
// here. 'active' reverses either one.
// ---------------------------------------------------------------------------

var REENGAGEMENT_OVERRIDES_SHEET_NAME = 'Re-engagement Overrides';
var REENGAGEMENT_OVERRIDES_HEADERS = ['Rep', 'Lead Email', 'Lead Name', 'Action', 'Set By', 'Set At'];

/** Same getOrCreate-plus-frozen-header pattern as every other phase's own tab. Created here too (not just by the dashboard's sheets_write.py) so a preview/live run on a brand-new sheet never crashes reading a tab that doesn't exist yet. */
function getOrCreateReengagementOverridesSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(REENGAGEMENT_OVERRIDES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(REENGAGEMENT_OVERRIDES_SHEET_NAME);
    sheet.getRange(1, 1, 1, REENGAGEMENT_OVERRIDES_HEADERS.length).setValues([REENGAGEMENT_OVERRIDES_HEADERS])
      .setFontWeight('bold').setBackground('#e8eef7');
    sheet.setFrozenRows(1);
    log_('Created "' + REENGAGEMENT_OVERRIDES_SHEET_NAME + '" tab.');
  }
  return sheet;
}

/**
 * Pure (given the raw values). Reduces every override row to a map of
 * "rep|leadKey" -> LAST action set for that lead — append-only sheet, so the
 * most recent row for a given rep+lead always wins, same convention as
 * getNotifiedReengagementKeys_/findTrainingPriorityOverride_ (Phase1_
 * ComplianceCheck.gs).
 */
function reengagementOverrideActionsFromRows_(rows) {
  var byKey = {};
  rows.forEach(function (row) {
    var rep = String(row[0] || '').trim();
    var leadEmail = row[1];
    var leadName = row[2];
    var action = String(row[3] || '').trim().toLowerCase();
    if (!rep || !action) return;
    byKey[rep + '|' + reengagementLeadKey_(leadEmail, leadName)] = action;
  });
  return byKey;
}

function getReengagementOverrideActions_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  var values = sheet.getRange(2, 1, lastRow - 1, REENGAGEMENT_OVERRIDES_HEADERS.length).getValues();
  return reengagementOverrideActionsFromRows_(values);
}

var REENGAGEMENT_TRACKER_SHEET_NAME = 'Re-engagement Tracker';
var REENGAGEMENT_TRACKER_HEADERS = [
  'Rep', 'Lead Name', 'Lead Email', 'Last Call Type', 'Last Call Date',
  'Step', 'Due Date', 'Notified At'
];

/** Same getOrCreate-plus-frozen-header pattern as every other phase's own tab. */
function getOrCreateReengagementTrackerSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(REENGAGEMENT_TRACKER_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(REENGAGEMENT_TRACKER_SHEET_NAME);
    sheet.getRange(1, 1, 1, REENGAGEMENT_TRACKER_HEADERS.length).setValues([REENGAGEMENT_TRACKER_HEADERS])
      .setFontWeight('bold').setBackground('#e8eef7');
    sheet.setFrozenRows(1);
    log_('Created "' + REENGAGEMENT_TRACKER_SHEET_NAME + '" tab.');
  }
  return sheet;
}

/** Every "rep|leadKey|step" already recorded — checked before treating a due step as NEW, so a re-run never double-notifies the same lead/step. Reconstructs leadKey from the tracker's own Lead Email/Lead Name columns via reengagementLeadKey_, rather than storing a redundant column. */
function getNotifiedReengagementKeys_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, REENGAGEMENT_TRACKER_HEADERS.length).getValues();
  var repCol = REENGAGEMENT_TRACKER_HEADERS.indexOf('Rep');
  var nameCol = REENGAGEMENT_TRACKER_HEADERS.indexOf('Lead Name');
  var emailCol = REENGAGEMENT_TRACKER_HEADERS.indexOf('Lead Email');
  var stepCol = REENGAGEMENT_TRACKER_HEADERS.indexOf('Step');
  return values.map(function (row) {
    var leadKey = reengagementLeadKey_(row[emailCol], row[nameCol]);
    return row[repCol] + '|' + leadKey + '|' + row[stepCol];
  });
}

function appendReengagementTrackerRow_(sheet, item, tz) {
  sheet.appendRow([
    item.rep,
    item.prospectName,
    item.prospectEmail,
    item.callType,
    Utilities.formatDate(item.callDate, tz, 'dd/MM/yyyy'),
    item.stepLabel,
    Utilities.formatDate(item.dueAt, tz, 'dd/MM/yyyy'),
    new Date()
  ]);
}

/** Grouped by rep so Kris/Tomás can scan one rep's leads at a time — same "org by the thing a human will act on" pattern as buildSeanEscalationReportEmail_. */
function buildReengagementDigestEmail_(dueItems, tz) {
  var subject = dueItems.length + ' lead(s) due for re-engagement (Cadence 2)';
  var byRep = {};
  dueItems.forEach(function (item) {
    byRep[item.rep] = byRep[item.rep] || [];
    byRep[item.rep].push(item);
  });
  var repNames = Object.keys(byRep).sort();

  var itemLine = function (item) {
    return item.prospectName + (item.prospectEmail ? ' (' + item.prospectEmail + ')' : '') + ' — last ' +
      item.callType + ' on ' + Utilities.formatDate(item.callDate, tz, 'dd/MM/yyyy') +
      ', due for the "' + item.stepLabel + '" re-engagement.';
  };

  var body = dueItems.length
    ? repNames.map(function (rep) {
        return rep + ':\n' + byRep[rep].map(function (item) { return '  - ' + itemLine(item); }).join('\n');
      }).join('\n\n') + '\n\n— Sent automatically.'
    : 'No leads due for re-engagement right now.\n\n— Sent automatically.';

  var htmlBody = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    (dueItems.length
      ? repNames.map(function (rep) {
          return '<p style="margin:0 0 4px;"><strong>' + escapeHtml_(rep) + '</strong></p>' +
            '<ul style="margin:0 0 14px;padding-left:20px;">' +
            byRep[rep].map(function (item) { return '<li>' + escapeHtml_(itemLine(item)) + '</li>'; }).join('') +
            '</ul>';
        }).join('')
      : '<p>No leads due for re-engagement right now.</p>') +
    '<p style="color:#666;font-size:12px;margin-top:16px;"><i>— Sent automatically.</i></p>' +
    '</div>';

  return { subject: subject, body: body, htmlBody: htmlBody };
}

function sendReengagementDigestEmail_(dueItems, tz) {
  var email = buildReengagementDigestEmail_(dueItems, tz);
  return guardedSend_(CONFIG.TOMAS_EMAIL, email.subject, email.body, {
    cc: CONFIG.KRIS_EMAIL,
    htmlBody: email.htmlBody,
    name: 'Re-engagement Bot'
  }, 2); // Tomás + Kris
}

/** Shared by preview and live paths. dryRun=true never writes or sends. */
function buildAndMaybeSendReengagementDigest_(dryRun) {
  RUN_TAG = 'buildAndMaybeSendReengagementDigest_';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('buildAndMaybeSendReengagementDigest_: no Sales Call Log tab found.'); return 0; }

  var col = getValidatedColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  var rows = lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var trackerSheet = getOrCreateReengagementTrackerSheet_();
  var notifiedKeys = getNotifiedReengagementKeys_(trackerSheet);
  var overrideActions = getReengagementOverrideActions_(getOrCreateReengagementOverridesSheet_());
  var dueItems = findDueReengagements_(rows, col, new Date(), notifiedKeys, overrideActions);

  if (dryRun) {
    log_('(preview) ' + dueItems.length + ' lead(s) due for re-engagement — nothing written or sent.');
    dueItems.forEach(function (item) {
      log_('  ' + item.rep + ' — ' + item.prospectName + ' (' + item.prospectEmail + '), last ' + item.callType +
        ' on ' + Utilities.formatDate(item.callDate, tz, 'dd/MM/yyyy') + ', step "' + item.stepLabel + '"');
    });
    return dueItems.length;
  }

  if (!dueItems.length) {
    log_('buildAndMaybeSendReengagementDigest_: nothing due — no email sent this run.');
    return 0;
  }

  var sent = sendReengagementDigestEmail_(dueItems, tz);
  if (!sent) {
    log_('buildAndMaybeSendReengagementDigest_: send failed/skipped — tracker not updated, will retry next run.');
    return 0;
  }
  dueItems.forEach(function (item) { appendReengagementTrackerRow_(trackerSheet, item, tz); });
  log_('buildAndMaybeSendReengagementDigest_: sent and recorded ' + dueItems.length + ' due re-engagement(s).');
  return dueItems.length;
}

/** Run this FIRST from the editor. Logs what it would send/record — nothing is written or sent. */
function previewReengagementDigest() {
  return previewReengagementDigest_();
}

function previewReengagementDigest_() {
  RUN_TAG = 'previewReengagementDigest_';
  log_('PREVIEW MODE — checking for due re-engagements, nothing will be written or sent.');
  return buildAndMaybeSendReengagementDigest_(/*dryRun=*/true);
}

/** Trigger target — gated by its own flag, independent of Cadence 1's ENABLED/DETECTION_ENABLED (neither cadence's drafting is ready, but this one's detection has no gmail.compose dependency at all — it's pure Sales Call Log + email). */
function runReengagementDigest() {
  RUN_TAG = 'runReengagementDigest';
  if (!SEAN_FOLLOWUP_CONFIG.CADENCE2_ENABLED) {
    log_('runReengagementDigest: SEAN_FOLLOWUP_CONFIG.CADENCE2_ENABLED is false, skipping.');
    return 0;
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runReengagementDigest: another run holds the lock, skipping this firing.');
    return 0;
  }
  try {
    return buildAndMaybeSendReengagementDigest_(/*dryRun=*/false);
  } finally {
    lock.releaseLock();
  }
}

// installReengagementDigestTrigger (its own standalone daily-9am trigger) was
// removed 07/09/2026 — Cadence 2 now shares one every-2-hour trigger with
// Cadence 1/Phase 18/Phase 19 via runPhase17To19StandingChecks_ below (see
// its header for why: the project hit Apps Script's 20-trigger cap with only
// 1 slot free and 4 pending automations).

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

// ---------------------------------------------------------------------------
// Cadence 1 handoff detection — Tomás's confirmed answer (07/09/2026): Joana
// adds Sean to the ongoing thread and applies the "SPAM - Sean" label in her
// OWN mailbox (Gmail labels are per-mailbox — Sean never sees it, he just
// becomes a normal recipient on the thread). Reuses the exact Gmail service-
// account plumbing Phase4_InboxSLA.gs/Phase8_ReplyTracker.gs already have
// live against Joana's mailbox (getGmailAccessTokenForUser_/gmailApiGet_ —
// same file, same project, no import) — no new domain-wide-delegation setup
// needed for this part; only the eventual DRAFTING step needs gmail.compose.
// ---------------------------------------------------------------------------

/** GET the label ID matching labelName exactly (Gmail's own display-name string) in the impersonated mailbox. Null if not found — e.g. a typo in SEAN_FOLLOWUP_CONFIG.HANDOFF_LABEL, or Joana genuinely hasn't created it yet. */
function findGmailLabelId_(accessToken, labelName) {
  var resp = gmailApiGet_(accessToken, '/labels');
  var match = (resp.labels || []).filter(function (l) { return l.name === labelName; })[0];
  return match ? match.id : null;
}

/** Every thread ID currently carrying labelId, paginated the same way listInboxThreadIds_ (Phase4_InboxSLA.gs) does. */
function listThreadIdsByLabelId_(accessToken, labelId) {
  var ids = [];
  var pageToken = null;
  do {
    var path = '/threads?labelIds=' + encodeURIComponent(labelId) + '&maxResults=100' +
      (pageToken ? '&pageToken=' + pageToken : '');
    var page = gmailApiGet_(accessToken, path);
    (page.threads || []).forEach(function (t) { ids.push(t.id); });
    pageToken = page.nextPageToken || null;
  } while (pageToken);
  return ids;
}

/**
 * The lead's own address out of a thread's combined From/To/Cc headers —
 * whichever participant ISN'T an @iconsofrealestate.com address. Pure, so
 * testable without a fake Gmail response. Returns null if every participant
 * is internal (shouldn't happen for a real lead thread, but never guess).
 */
function extractLeadEmailFromParticipants_(fromHeader, toHeader, ccHeader) {
  var addrs = []
    .concat(extractEmailAddresses_(fromHeader))
    .concat(extractEmailAddresses_(toHeader))
    .concat(extractEmailAddresses_(ccHeader));
  var external = addrs.filter(function (a) { return a && a.indexOf('@iconsofrealestate.com') === -1; });
  return external.length ? external[0] : null;
}

/**
 * Metadata for one handoff thread — subject, lead email, and the anchor
 * instant Cadence 1's own schedule (addBusinessDaysPreservingTimeOfDay_)
 * counts from. Anchor = the thread's most recent message at detection time
 * (whichever of Joana/the lead sent it) — the plan doc's "same time of day
 * the lead's original reply came in" requirement is about PRESERVING a real
 * wall-clock time going forward, not about which specific message is
 * "the" reply; the moment the label appears (thread's latest activity) is
 * the practical, available proxy for "when the handoff happened."
 * format=metadata only (never full/raw) — no message body is ever read.
 *
 * The lead's own address is NOT assumed to be on the thread's chronologically
 * LAST message — Tomás's own description of the handoff ("Joana adds Sean to
 * the thread and updates SPAM - Sean") is consistent with an internal-only
 * note From Joana To Sean (no lead address at all) landing as the newest
 * message. This exact "the last message isn't necessarily the right one"
 * mistake was already made and fixed once in this codebase, for this same
 * mailbox (getThreadLastMessageFull_, Phase8_ReplyTracker.gs — "Gmail thread
 * order is purely chronological, not directional"). Trusting only the last
 * message here would silently drop the handoff entirely the moment Joana's
 * handoff note is the newest message — exactly the "looks done, is actually
 * invisible" failure this file's own header warns about — so this scans
 * every message's participants, walking backward from the newest, and stops
 * at the first one with an external address.
 */
function fetchSeanHandoffThreadInfo_(accessToken, threadId) {
  var thread = gmailApiGet_(accessToken,
    '/threads/' + threadId + '?format=metadata&metadataHeaders=From&metadataHeaders=To' +
    '&metadataHeaders=Cc&metadataHeaders=Subject');
  var messages = thread.messages || [];
  if (!messages.length) {
    log_('  fetchSeanHandoffThreadInfo_: thread ' + threadId + ' returned no messages — skipped.');
    return null;
  }
  var last = messages[messages.length - 1];
  var lastHeaders = {};
  (last.payload && last.payload.headers || []).forEach(function (h) {
    lastHeaders[String(h.name).toLowerCase()] = h.value;
  });
  var internalDateMs = Number(last.internalDate);
  if (!isFinite(internalDateMs)) {
    log_('  fetchSeanHandoffThreadInfo_: thread ' + threadId + ' has a non-numeric internalDate — skipped.');
    return null;
  }

  var leadEmail = null;
  for (var i = messages.length - 1; i >= 0 && !leadEmail; i--) {
    var msgHeaders = {};
    (messages[i].payload && messages[i].payload.headers || []).forEach(function (h) {
      msgHeaders[String(h.name).toLowerCase()] = h.value;
    });
    leadEmail = extractLeadEmailFromParticipants_(msgHeaders['from'], msgHeaders['to'], msgHeaders['cc']);
  }
  if (!leadEmail) {
    log_('  fetchSeanHandoffThreadInfo_: thread ' + threadId + ' has no external participant on any message — skipped.');
    return null;
  }
  return {
    threadId: threadId,
    leadEmail: leadEmail,
    subject: lastHeaders['subject'] || '',
    anchorDate: new Date(internalDateMs)
  };
}

/** Every Thread ID already in the tracker — checked before treating a labeled thread as a NEW handoff, so a re-run never double-tracks the same lead. */
function getTrackedThreadIds_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var col = SEAN_FOLLOWUP_TRACKER_HEADERS.indexOf('Thread ID') + 1;
  return sheet.getRange(2, col, lastRow - 1, 1).getValues().map(function (r) { return String(r[0] || ''); });
}

/**
 * Finds every thread carrying the handoff label that isn't already tracked.
 * Returns [] (never throws) if the label doesn't exist yet in Joana's
 * mailbox — logs loudly instead, since that's either a real setup gap
 * (label not created yet) or a typo in SEAN_FOLLOWUP_CONFIG.HANDOFF_LABEL,
 * either of which needs a human, not a crashed trigger.
 */
function collectNewSeanHandoffThreads_() {
  var token = getGmailAccessTokenForUser_(SEAN_FOLLOWUP_CONFIG.HANDOFF_IMPERSONATE_EMAIL);
  var labelId = findGmailLabelId_(token, SEAN_FOLLOWUP_CONFIG.HANDOFF_LABEL);
  if (!labelId) {
    log_('collectNewSeanHandoffThreads_: label "' + SEAN_FOLLOWUP_CONFIG.HANDOFF_LABEL + '" not found in ' +
      SEAN_FOLLOWUP_CONFIG.HANDOFF_IMPERSONATE_EMAIL + '\'s mailbox — nothing to detect this run.');
    return [];
  }
  var threadIds = listThreadIdsByLabelId_(token, labelId);
  var tracked = getTrackedThreadIds_(getOrCreateSeanFollowUpTrackerSheet_());
  var newThreadIds = threadIds.filter(function (id) { return tracked.indexOf(id) === -1; });
  return newThreadIds.map(function (id) {
    return fetchSeanHandoffThreadInfo_(token, id);
  }).filter(Boolean);
}

/** One row per newly-detected handoff — Stage 'handed_off' is Cadence 1's starting state; the outreach-draft step (blocked on gmail.compose) is what would advance it. */
function appendSeanHandoffTrackerRow_(sheet, info) {
  sheet.appendRow([
    info.threadId,
    info.leadEmail,
    '', // Lead Name — not reliably in headers alone; filled by hand or a later enrichment pass
    'new_lead',
    'handed_off',
    info.anchorDate,
    '',
    '',
    'Detected via "' + SEAN_FOLLOWUP_CONFIG.HANDOFF_LABEL + '" label, subject: ' + info.subject
  ]);
}

/** Shared by preview and live paths. dryRun=true never writes anything. */
function buildAndMaybeRecordSeanHandoffs_(dryRun) {
  RUN_TAG = 'buildAndMaybeRecordSeanHandoffs_';
  var newHandoffs = collectNewSeanHandoffThreads_();

  if (dryRun) {
    log_('(preview) ' + newHandoffs.length + ' new handoff(s) detected via "' + SEAN_FOLLOWUP_CONFIG.HANDOFF_LABEL +
      '" — nothing written.');
    newHandoffs.forEach(function (h) {
      log_('  ' + h.leadEmail + ' — thread ' + h.threadId + ', anchor ' + h.anchorDate + ', subject: ' + h.subject);
    });
    return newHandoffs.length;
  }

  var sheet = getOrCreateSeanFollowUpTrackerSheet_();
  newHandoffs.forEach(function (h) { appendSeanHandoffTrackerRow_(sheet, h); });
  log_('buildAndMaybeRecordSeanHandoffs_: recorded ' + newHandoffs.length + ' new handoff(s).');
  return newHandoffs.length;
}

/** Run this FIRST from the editor. Logs what it would record — nothing is written. */
function previewSeanHandoffDetection() {
  return previewSeanHandoffDetection_();
}

function previewSeanHandoffDetection_() {
  RUN_TAG = 'previewSeanHandoffDetection_';
  log_('PREVIEW MODE — checking for new Sean handoffs, nothing will be written.');
  return buildAndMaybeRecordSeanHandoffs_(/*dryRun=*/true);
}

/** Trigger target — gated by DETECTION_ENABLED specifically, NOT the full ENABLED flag (drafting stays blocked separately). */
function runSeanHandoffDetection() {
  RUN_TAG = 'runSeanHandoffDetection';
  if (!SEAN_FOLLOWUP_CONFIG.DETECTION_ENABLED) {
    log_('runSeanHandoffDetection: SEAN_FOLLOWUP_CONFIG.DETECTION_ENABLED is false, skipping.');
    return 0;
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runSeanHandoffDetection: another run holds the lock, skipping this firing.');
    return 0;
  }
  try {
    return buildAndMaybeRecordSeanHandoffs_(/*dryRun=*/false);
  } finally {
    lock.releaseLock();
  }
}

// installSeanHandoffDetectionTrigger (its own standalone every-2-hour
// trigger) was removed 07/09/2026 — see runPhase17To19StandingChecks_ below,
// which now covers this handler's cadence exactly (every 2 hours,
// ungated — this is the one of the four actually meant to run that often).

// ---------------------------------------------------------------------------
// Trigger-cap consolidation (07/09/2026) — Kris hit Apps Script's 20-trigger
// project cap with only 1 slot free and 4 pending automations of different
// cadences (Cadence 1 detection: every 2h: Cadence 2 digest: daily; Phase 19
// escalation report: weekly; Phase 18 Pitch Guide review: monthly). Fix:
// ONE every-2-hour trigger (runPhase17To19StandingChecks_) instead of 4
// separate ones — same "consolidate onto one trigger, gate internally"
// pattern already used for Phase 2's 5 scoring passes
// (runAllOngoingScoringPasses_, Phase2_CallScoring.gs), just with explicit
// day/hour-window gates added here since these four don't all want to run
// on every firing the way the 5 scoring passes do.
//
// Cadence 1 handoff detection has NO extra gate — every 2 hours IS its real
// cadence. The other three get a day/hour-window check before running:
//   - Cadence 2 digest: any firing in the [CADENCE2_TRIGGER_HOUR,
//     CADENCE2_TRIGGER_HOUR+2) window, any day. Safe to call more than once
//     in that window even so — findDueReengagements_'s own notifiedKeys
//     dedup means a lead already notified this cycle is silently skipped,
//     so at worst this does a harmless extra Sales Call Log scan.
//   - Phase 19 escalation report: Fridays only, in its own TRIGGER_HOUR
//     window. This one is NOT safe to leave ungated — unlike the other two,
//     buildAndMaybeSendSeanEscalationReport_ has no dedup of its own at all;
//     calling it every firing would re-email Tomás/Kris the same weekly
//     report every 2 hours, all week.
//   - Phase 18 Pitch Guide review: day-of-month === TRIGGER_DAY_OF_MONTH
//     only, in its own TRIGGER_HOUR window. Safe either way (each training
//     video's own "reviewed" marker makes an extra call a no-op), gated
//     anyway to avoid needless Drive folder scans every 2 hours.
// A 2-hour-wide window (not an exact-hour match) tolerates Apps Script's own
// documented trigger-time jitter without risking a job silently never firing
// because its exact target hour was skipped.
// ---------------------------------------------------------------------------

/** True if `now` (in tz) falls in [targetHour, targetHour + windowHours) — see header comment above for why a window, not an exact-hour match. */
function isWithinHourWindow_(now, tz, targetHour, windowHours) {
  var hour = Number(Utilities.formatDate(now, tz, 'HH'));
  return hour >= targetHour && hour < targetHour + windowHours;
}

/**
 * Which of the four consolidated passes are due right now — pure (given
 * `now`), so testable without faking triggers/config globals for every
 * combination. Returns an array of {name, fn} for exactly the passes
 * runPhase17To19StandingChecks_ should call this firing.
 */
function duePhase17To19Passes_(now, tz) {
  var passes = [
    { name: 'runSeanHandoffDetection', fn: runSeanHandoffDetection, due: true },
    {
      name: 'runReengagementDigest', fn: runReengagementDigest,
      due: isWithinHourWindow_(now, tz, SEAN_FOLLOWUP_CONFIG.CADENCE2_TRIGGER_HOUR, 2)
    },
    {
      name: 'runSeanEscalationReport', fn: runSeanEscalationReport,
      due: Utilities.formatDate(now, tz, 'EEEE') === 'Friday' &&
        isWithinHourWindow_(now, tz, SEAN_ESCALATION_REPORT_CONFIG.TRIGGER_HOUR, 2)
    },
    {
      name: 'runPitchGuideReview', fn: runPitchGuideReview,
      due: Number(Utilities.formatDate(now, tz, 'dd')) === PITCH_GUIDE_REVIEW_CONFIG.TRIGGER_DAY_OF_MONTH &&
        isWithinHourWindow_(now, tz, PITCH_GUIDE_REVIEW_CONFIG.TRIGGER_HOUR, 2)
    },
    // Added 11/09/2026 (Phase20_BensLeadStatusReport.gs) as a fifth pass on
    // this same shared trigger rather than a standalone one — same
    // trigger-cap reason as the other three. Not safe to leave ungated:
    // buildAndMaybeSendBensLeadStatusReport_ has no dedup of its own,
    // same as runSeanEscalationReport below.
    {
      name: 'runBensLeadStatusReport', fn: runBensLeadStatusReport,
      due: Utilities.formatDate(now, tz, 'EEEE') === 'Friday' &&
        isWithinHourWindow_(now, tz, BENS_LEAD_STATUS_REPORT_CONFIG.TRIGGER_HOUR, 2)
    },
    // Added 11/09/2026 (Phase21_DailyLeadApprovalDigest.gs) as a sixth pass —
    // same trigger-cap reason as the other four. "Every work day" = not a
    // weekend, same isWeekendInBusinessTz_ this file already uses for
    // business-day math elsewhere. Not safe to leave ungated:
    // buildAndMaybeSendLeadDigests_ has its own per-rep same-day dedup, but
    // that dedup only prevents a SECOND email in one day, not firing outside
    // the intended morning window.
    {
      name: 'runDailyLeadApprovalDigest', fn: runDailyLeadApprovalDigest,
      due: !isWeekendInBusinessTz_(now) &&
        isWithinHourWindow_(now, tz, DAILY_LEAD_APPROVAL_CONFIG.TRIGGER_HOUR, 2)
    }
  ];
  return passes.filter(function (p) { return p.due; });
}

/** Trigger target for all six consolidated standing checks (a fifth, Phase 20's Bens lead status report, joined 11/09/2026; a sixth, Phase 21's daily lead approval digest, joined the same day — see duePhase17To19Passes_ above). Each pass still has its own ENABLED/DETECTION_ENABLED/CADENCE2_ENABLED gate inside its own run*() function — duePhase17To19Passes_ only adds the day/hour-window gates the non-Cadence-1 passes need now that they share a trigger. Failures in one pass never block the others (same isolate-and-continue pattern as runAllOngoingScoringPasses_). */
function runPhase17To19StandingChecks_() {
  RUN_TAG = 'runPhase17To19StandingChecks_';
  duePhase17To19Passes_(new Date(), CONFIG.BUSINESS_TIMEZONE).forEach(function (pass) {
    try {
      pass.fn();
    } catch (e) {
      log_('runPhase17To19StandingChecks_: ' + pass.name + ' threw: ' + e + ' -- continuing to the next pass.');
      sendOpsAlert_('Standing check error: ' + pass.name, String(e));
    }
  });
}

function installPhase17To19StandingChecksTrigger() {
  RUN_TAG = 'installPhase17To19StandingChecksTrigger';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runPhase17To19StandingChecks_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runPhase17To19StandingChecks_')
    .timeBased()
    .everyHours(2)
    .create();
  log_('Phase 17-19 standing checks trigger installed: every 2 hours (Cadence 1 detection every firing; ' +
    'Cadence 2 digest/Phase 19 report/Phase 18 review/Phase 20 Bens lead status report each internally gated to their own day/hour window).');
}
