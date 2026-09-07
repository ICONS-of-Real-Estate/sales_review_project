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
  DETECTION_ENABLED: false, // handoff detection/tracking only — flip after previewSeanHandoffDetection() looks right; does NOT need gmail.compose
  DEAD_LABEL: 'Dead',
  // Tomás's confirmed answer (07/09/2026) — see file header. Joana's own
  // mailbox, not Sean's: labels are per-mailbox in Gmail, so this only shows
  // up when reading HER inbox, not his (he just sees a normal thread he's
  // now a recipient on).
  HANDOFF_LABEL: 'SPAM - Sean',
  HANDOFF_IMPERSONATE_EMAIL: 'joana@iconsofrealestate.com',
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
  var headers = {};
  (last.payload && last.payload.headers || []).forEach(function (h) {
    headers[String(h.name).toLowerCase()] = h.value;
  });
  var internalDateMs = Number(last.internalDate);
  if (!isFinite(internalDateMs)) {
    log_('  fetchSeanHandoffThreadInfo_: thread ' + threadId + ' has a non-numeric internalDate — skipped.');
    return null;
  }
  var leadEmail = extractLeadEmailFromParticipants_(headers['from'], headers['to'], headers['cc']);
  if (!leadEmail) {
    log_('  fetchSeanHandoffThreadInfo_: thread ' + threadId + ' has no external participant — skipped.');
    return null;
  }
  return {
    threadId: threadId,
    leadEmail: leadEmail,
    subject: headers['subject'] || '',
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

function installSeanHandoffDetectionTrigger() {
  RUN_TAG = 'installSeanHandoffDetectionTrigger';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runSeanHandoffDetection') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runSeanHandoffDetection')
    .timeBased()
    .everyHours(2)
    .create();
  log_('Sean handoff detection trigger installed: every 2 hours.');
}
