/**
 * Phase1_ComplianceCheck.gs
 *
 * Call Tracker Compliance — Phase 1: deterministic prior-day Calendar-vs-tracker
 * compare + quota-guarded escalation email.
 *
 * Per the design brief:
 *  - Runs on a daily time-driven trigger at 18:00 BUSINESS time
 *    (America/New_York — most clients are Eastern; changed from
 *    America/Los_Angeles 23/08/2026, see CONFIG.BUSINESS_TIMEZONE), evaluating
 *    that same business day at close of business. Reps get nudged while
 *    still at their desks, not the next morning about yesterday.
 *  - For each rep, collects sales/QC calendar events for the business day, then
 *    finds tracker rows for that rep/call-date with Outcome Logged = TRUE.
 *  - Any calendar event with no matching logged row is non-compliant and goes
 *    into one batched "please update your tracker" email to the rep, CC Kris
 *    and Tomás.
 *  - All matching is deterministic (Calendar Event ID first, prospect-name
 *    fallback). No LLM anywhere in this phase.
 *
 * Safety rules honored from the brief:
 *  - Quota guard: MailApp.getRemainingDailyQuota() checked before every send,
 *    with a reserve kept for ops alerts; never loop-send unguarded.
 *  - Timezone: all business-day math runs in CONFIG.BUSINESS_TIMEZONE
 *    (America/New_York), never the script project's zone (confirmed live
 *    23/08/2026 to be GMT+7 — see the Call Date bug that caught this); dates
 *    displayed DD/MM/YYYY.
 *  - Every compliance decision is logged per row, and every log line is
 *    tagged with the entry point that produced it (RUN_TAG / log_ below).
 *
 * Zero-manual-steps design: installAutomation() (run once) installs the
 * daily close-of-business trigger AND a weekly Sunday self-heal trigger that audits the daily
 * one (dead/drifted triggers get deleted, recreated, and ops is emailed).
 * Email routing config is validated on every run — a placeholder address
 * blocks sends and alerts ops instead of silently mailing a bogus mailbox.
 */

// ---------------------------------------------------------------------------
// CONFIG — edit these before installing the trigger.
// ---------------------------------------------------------------------------

/** Internal addresses excluded from attendee matching (rep/team inboxes). */
var INTERNAL_EMAILS = [
  'bens@iconsofrealestate.com',
  'joana@iconsofrealestate.com',
  'sean@iconsofrealestate.com',
  'tomas@iconsofrealestate.com',
  'kris@iconsofrealestate.com'
];

var CONFIG = {
  // Email routing
  KRIS_EMAIL: 'kris@iconsofrealestate.com',
  TOMAS_EMAIL: 'tomas@iconsofrealestate.com',
  JOANA_EMAIL: 'joana@iconsofrealestate.com',
  OPS_ALERT_EMAIL: 'kris@iconsofrealestate.com', // quota/ops alerts go here

  // Keep this many recipients of quota in reserve for ops alerts; if remaining
  // quota minus recipients-needed drops below this, skip rep emails and send
  // one ops alert instead.
  QUOTA_RESERVE: 5,

  // Filled by installAutomation() with ScriptApp.getScriptId() of the deployed
  // project. Weekly self-heal verifies the daily trigger belongs to THIS
  // script (a trigger cloned from an old project copy gets replaced).
  EXPECTED_PROJECT_ID: '',

  // The team's business timezone — where the CALLS happen, not where the
  // script project happens to be set (confirmed live 23/08/2026: this
  // project's own default is GMT+7/Indochina Time — the plain multi-arg
  // `new Date(y,m,d)` constructor silently uses THAT, not this, which is
  // exactly the Call Date bug found live the same day). "Prior day", event
  // windows, and sheet date cells are all interpreted in this zone. The
  // daily trigger fires at 18:00 in THIS zone (close of business), evaluating
  // that same business day — so reps get nudged while they're still at
  // their desks, not the next morning about yesterday.
  //
  // Changed 23/08/2026 per Kris: most clients are Eastern — the original
  // choice of Pacific was only ever "6pm PST = everyone's done for the day,"
  // not a deliberate anchor to the Pacific zone itself. Every TRIGGER_HOUR/
  // *_HOUR constant across every phase (18, 20, 8, 9, etc.) is unchanged and
  // now means that hour in America/New_York instead — i.e. every trigger
  // now fires 3 hours earlier in absolute time than it used to. If any of
  // those hours were meant to track a specific real-world moment (e.g. "6pm
  // Pacific, when the day actually wraps") rather than just "6pm local,"
  // they'll need their own adjustment — nobody has asked for that yet.
  BUSINESS_TIMEZONE: 'America/New_York',
  DAILY_TRIGGER_HOUR: 18, // 18:00 business time = end of the US workday

  // Calendar event classification: an event counts as a sales/QC call if its
  // title contains an INCLUDE keyword and does NOT contain an EXCLUDE keyword
  // (both case-insensitive). Excludes run first — they kill internal meetings
  // that would otherwise match includes (e.g. "Bens & Joana | 1-1" contains
  // "joana"; "Cold Email Outreach Weekly Call" contains "call").
  // Tune these against dryRunComplianceCheck / debugListRecentEvents output —
  // the Phase 1 benchmark is "<1 false 'you didn't log' email per week".
  CALL_TITLE_INCLUDE: [
    'qc',                              // Bens's QC sessions
    'podcast qualification call',      // Joana's QC calls
    // Real bug found live (03/09/2026, Kris's ask): Sean's QC calendar
    // events are titled plain "Qualification Call / <name>", not "QC" —
    // "qualification" does not contain the substring "qc", so every one of
    // his QCs was silently invisible to getRepCallEvents_/getRepCallEventsRaw_,
    // which meant no handoff brief before them AND no way to ever notice a
    // QC that never produced a recording (both looked like "no QC happened"
    // rather than "QC happened, everything downstream missed it").
    'qualification call',
    'starting a podcast',              // Joana/Sean discovery calls
    'icons 100 podcast recording',     // Bens's recordings
    'real estate podcast:',            // Joana recordings
    'discovery',
    'sales call'
  ],
  CALL_TITLE_EXCLUDE: [
    'update tracker',
    '1-1',
    'daily |',
    'weekly',
    'spam',
    'cold email outreach',
    'setup bcc',
    'briefing',
    'co-founder strategy'
  ],

  // Sheet names tried in order when resolving a rep's log tab. The first is
  // the Phase 0 target (normalized shared tab); the rest are today's real
  // per-rep sheets so the check works before Phase 0 lands.
  SHARED_LOG_TAB_CANDIDATES: ['Sales Call Log'],

  REPS: [
    {
      name: 'Bens',
      email: 'bens@iconsofrealestate.com',
      calendarId: 'bens@iconsofrealestate.com', // calendar must be shared with the account running this script
      spreadsheetId: '1bK0VbgP3xdK5LhfYqO0fps9ivJzPDn3fsDcsl1dEBM4',
      sheetName: 'Sales Call Log',
      // Fixed 04/09/2026 (Phase11_BensPodcastSync.gs) — this used to list
      // fallback headers from HIS OWN "Icons Podcast Recordings" tab
      // ('Recording Done', 'Recording Date', 'Booking Date', 'Name') even
      // though sheetName points at "Sales Call Log", which doesn't have any
      // of those columns at all (see CLAUDE.md "Who does what — never guess
      // this again" for the history). Now that Phase 11 actually syncs his
      // tracker rows INTO "Sales Call Log", this rep entry can just use the
      // real "Sales Call Log" headers like Joana/Sean below.
      columns: {
        prospectName: ['Prospect Name'],
        prospectEmail: ['Prospect Email'],
        callDate: ['Call Date'],
        outcomeLogged: ['Outcome Logged'],
        outcomeDisposition: ['Outcome Disposition'],
        callType: ['Call Type'],
        calendarEventId: ['Calendar Event ID'],
        rep: ['Rep']
      },
      defaultRepName: 'Bens' // used when the sheet has no Rep column yet
    },
    {
      name: 'Joana',
      email: 'joana@iconsofrealestate.com',
      calendarId: 'joana@iconsofrealestate.com',
      // Joana logs her calls as Rep=Joana rows in the shared Sales Call Log tab.
      spreadsheetId: '1bK0VbgP3xdK5LhfYqO0fps9ivJzPDn3fsDcsl1dEBM4',
      sheetName: 'Sales Call Log',
      columns: {
        prospectName: ['Prospect Name', 'Name'],
        prospectEmail: ['Prospect Email', 'Email'],
        callDate: ['Call Date', 'First Call Date'],
        outcomeLogged: ['Outcome Logged'],
        outcomeDisposition: ['Outcome Disposition'],
        callType: ['Call Type'],
        calendarEventId: ['Calendar Event ID'],
        rep: ['Rep']
      },
      defaultRepName: 'Joana'
    },
    {
      name: 'Sean',
      email: 'sean@iconsofrealestate.com',
      calendarId: 'sean@iconsofrealestate.com',
      spreadsheetId: '1bK0VbgP3xdK5LhfYqO0fps9ivJzPDn3fsDcsl1dEBM4',
      sheetName: 'Sales Call Log',
      columns: {
        prospectName: ['Prospect Name', 'Name'],
        prospectEmail: ['Prospect Email', 'Email'],
        callDate: ['Call Date', 'First Call Date'],
        outcomeLogged: ['Outcome Logged'],
        outcomeDisposition: ['Outcome Disposition'],
        callType: ['Call Type'],
        calendarEventId: ['Calendar Event ID'],
        rep: ['Rep']
      },
      defaultRepName: 'Sean'
    }
    // Tomás is CC'd on escalation emails and owns the trackers, but the brief
    // scopes the compliance check to Bens, Joana, Sean. To also check Tomás's
    // own calls, add him here with spreadsheetId
    // '14VS-se3Cc9jiPYlVex-5MX69ATmwSHhf0xPd6eAEiY0' and
    // outcomeLogged: ['Outcome Logged', 'Call Taken'].
  ]
};

// ---------------------------------------------------------------------------
// Entry point — install a daily time-driven trigger on this function.
// ---------------------------------------------------------------------------

/**
 * Validate email routing config. Returns {ok, problems[]}.
 * 'ok' = false blocks ALL sends (guardedSend_ refuses). A wrong placeholder
 * address is worse than no email at all — it mails a stranger or bounces
 * silently, so the system fails loud here instead.
 */
function auditConfig_() {
  var problems = [];
  CONFIG.REPS.forEach(function (repCfg) {
    if (INTERNAL_EMAILS.indexOf(repCfg.email) === -1) {
      problems.push(repCfg.name + ' email "' + repCfg.email + '" is not in INTERNAL_EMAILS');
    }
    if (repCfg.calendarId !== repCfg.email) {
      problems.push(repCfg.name + ' calendarId "' + repCfg.calendarId + '" != email');
    }
    if (!repCfg.spreadsheetId) {
      problems.push(repCfg.name + ' has no spreadsheetId');
    }
  });
  [CONFIG.KRIS_EMAIL, CONFIG.TOMAS_EMAIL, CONFIG.JOANA_EMAIL, CONFIG.OPS_ALERT_EMAIL].forEach(function (e) {
    if (!e || e.indexOf('@') === -1) problems.push('ops/manager address invalid: "' + e + '"');
  });
  return { ok: problems.length === 0, problems: problems };
}

/** Which entry point is running — every log line carries this tag. */
var RUN_TAG = 'unknown';

function log_(msg) {
  Logger.log('[' + RUN_TAG + '] ' + msg);
}

/**
 * Daily close-of-business check (trigger: 18:00 business time).
 * Evaluates the calls that happened TODAY in the business timezone — at
 * 18:00 the workday is over, so "today so far" IS the full business day.
 * Runs the same window math for any hour it happens to fire at, so a manual
 * run behaves identically to the trigger.
 */
function runDailyComplianceCheck() {
  RUN_TAG = 'runDailyComplianceCheck';

  // Kris's ask (30/08/2026): weekday-only — the trigger itself
  // (installDailyTriggerCore_) fires every single day via everyDays(1),
  // since Apps Script's ClockTriggerBuilder has no built-in "weekdays only"
  // option; a Saturday/Sunday nag about "missing" outcomes reps aren't
  // expected to log until Monday is just noise. Checked in BUSINESS
  // timezone, not the script's own, same convention businessDayStart_ uses.
  var todayName = Utilities.formatDate(new Date(), CONFIG.BUSINESS_TIMEZONE, 'EEE');
  if (todayName === 'Sat' || todayName === 'Sun') {
    log_('runDailyComplianceCheck: ' + todayName + ' — weekday-only check (Mon-Fri), skipping.');
    return;
  }

  // Every Phase 2 sheet-writing entry point (scoreNewlyLoggedCalls_,
  // scoreSeanTranscripts, syncRiversideTranscripts_) takes this same script
  // lock specifically so overlapping firings can't double-act — this one
  // had no such guard, so the daily trigger overlapping a manual editor run
  // (or two trigger copies briefly coexisting during a self-heal window)
  // would independently recompute the same "missing" events twice and send
  // every rep + Kris + Tomás two copies of the same non-compliance email.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runDailyComplianceCheck: another run holds the lock, skipping this firing.');
    return;
  }

  try {
    var tz = CONFIG.BUSINESS_TIMEZONE;
    var now = new Date();
    var targetDay = Utilities.formatDate(now, tz, 'dd/MM/yyyy');
    log_('=== Close-of-business compliance check for ' + targetDay +
      ' (business tz ' + tz + ', script tz ' + Session.getScriptTimeZone() + ') ===');

    var audit = auditConfig_();
    if (!audit.ok) {
      log_('CONFIG AUDIT FAILED: ' + audit.problems.join(' | '));
      sendOpsAlert_('[Compliance bot] Config invalid — compliance emails blocked',
        'The daily compliance check ran but ALL sends were blocked because the email routing config failed validation.\n\nProblems:\n  - ' +
        audit.problems.join('\n  - ') +
        '\n\nFix the CONFIG block in Phase1_ComplianceCheck.gs. The check itself ran normally; only emails were suppressed.');
    }

    var dayStart = businessDayStart_(now, tz);
    var dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    CONFIG.REPS.forEach(function (repCfg) {
      try {
        checkRep_(repCfg, dayStart, dayEnd, targetDay, tz);
      } catch (e) {
        // One rep's failure must not kill the others.
        log_('ERROR checking rep ' + repCfg.name + ': ' + e);
        sendOpsAlert_('Compliance check error for ' + repCfg.name,
          'Rep ' + repCfg.name + ' could not be checked for ' + targetDay + '.\n\n' + e);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Per-rep logic
// ---------------------------------------------------------------------------

/**
 * Matches each of a rep's day's events against loggedRows first (compliance),
 * falling back to allRows for an ID backfill when nothing logged matches.
 * Tracks which row indices this call has already matched and excludes them
 * from later events' candidate pool, so one row can satisfy at most one
 * event per call — without this, two same-day events for the same prospect
 * (e.g. a QC call followed by a Sales Call, a real and common pattern) could
 * both independently match the ONE logged row that exists, silently
 * reporting the second event as compliant when its own tracker row was
 * never actually logged. Shared by checkRep_ (the live path),
 * debugCheckSpecificDate (same live behavior against a fixed sample date),
 * and dryRunComplianceCheck (writeBack=false: preview only, matches the same
 * logic so the preview doesn't disagree with what the live run would do).
 * Returns the events with no logged match (repCfg name is for log lines only).
 */
function matchEventsForRep_(repName, events, allRows, loggedRows, writeBack) {
  var claimedRowIndexes = {};
  var missing = [];
  events.forEach(function (ev) {
    var availableLogged = loggedRows.filter(function (r) { return !claimedRowIndexes[r.rowIndex]; });
    var hit = findMatch_(ev, availableLogged);
    if (hit) {
      claimedRowIndexes[hit.rowIndex] = true;
      log_('  [' + repName + '] match? event="' + ev.title + '" → LOGGED (row ' + hit.rowIndex + ', via ' + hit.via + ')');
      if (writeBack) stampMatch_(hit);
    } else {
      // Still try to enrich an UNLOGGED row with the event ID: it makes
      // tomorrow's match exact-key and builds the Phase 0 join data.
      var availableAll = allRows.filter(function (r) { return !claimedRowIndexes[r.rowIndex]; });
      var anyHit = findMatch_(ev, availableAll);
      // Kris's ask (03/09/2026, Sean): "if there's QCs on his calendar, and
      // we don't get a recording, we need to know that" — a row only ever
      // exists once a transcript has been received and scored (Phase 2), so
      // NO row matching this event at all (not even an unlogged one) means
      // no recording ever arrived, not just "forgot to fill in the outcome."
      // Those are different problems needing different wording/action —
      // tag it here so buildComplianceEmail_ and the escalation alert can
      // tell them apart instead of both reading as a generic tracker nag.
      ev.recordingMissing = !anyHit;
      log_('  [' + repName + '] match? event="' + ev.title + '" → NOT LOGGED' +
        (anyHit ? '' : ' (no row at all — recording never received)'));
      missing.push(ev);
      if (anyHit) {
        claimedRowIndexes[anyHit.rowIndex] = true;
        if (!anyHit.logged) {
          var wrote = writeBack ? stampMatch_(anyHit) : false;
          log_('    ↳ unlogged row ' + anyHit.rowIndex + ' found via ' + anyHit.via +
            (wrote ? ' — backfilling Calendar Event ID' : writeBack ? ' — ID already stamped' : ' — dry-run, no write'));
        }
      }
    }
  });
  return missing;
}

function checkRep_(repCfg, dayStart, dayEnd, priorDay, tz) {
  var events = getRepCallEvents_(repCfg, dayStart, dayEnd);
  log_(repCfg.name + ': ' + events.length + ' sales/QC calendar event(s) on ' + priorDay);

  // Kris's ask (26/08/2026): a call flagged as unlogged one day used to never
  // get looked at again — if the rep ignored the email, nothing re-flagged
  // it and nothing recorded whether it was ever fixed. loadComplianceBacklog_
  // carries every unresolved item forward across days; check it even on a
  // day with zero calendar events, since there may still be older items
  // outstanding that need re-flagging.
  var backlog = loadComplianceBacklog_(repCfg.name);
  if (events.length === 0 && backlog.length === 0) {
    log_(repCfg.name + ': fully compliant for ' + priorDay + ' (no calls today, no outstanding backlog).');
    return;
  }

  var missingToday = [];
  if (events.length) {
    var allRows = getAllTrackerRows_(repCfg, priorDay, tz);
    var loggedRows = allRows.filter(function (r) { return r.logged; });
    log_(repCfg.name + ': ' + loggedRows.length + ' logged tracker row(s) for ' + priorDay +
      ' (' + allRows.length + ' total row(s) for the day)');
    missingToday = matchEventsForRep_(repCfg.name, events, allRows, loggedRows, /*writeBack=*/true);
  }

  // Append + save today's new misses FIRST, before the any-date reconcile
  // pass below — real incident found live (26/08/2026 silent-failure audit):
  // reconcile reads the WHOLE sheet and can throw on header drift, and that
  // used to happen AFTER missingToday was computed but BEFORE anything was
  // saved, silently losing that day's non-compliance for good (by the next
  // run, those events are outside the calendar window and never re-flagged).
  backlog = appendNewBacklogEntries_(backlog, missingToday, priorDay, tz, new Date().toISOString());
  saveComplianceBacklog_(repCfg.name, backlog);

  // Re-check every previously-flagged item (including what was just added)
  // against the WHOLE sheet (any date), not just today's rows — the rep may
  // have logged it late, on the right date, any day since it was first flagged.
  if (backlog.length) {
    var allRowsAnyDate = getAllTrackerRows_(repCfg, null, tz);
    var loggedRowsAnyDate = allRowsAnyDate.filter(function (r) { return r.logged; });
    backlog = reconcileComplianceBacklog_(repCfg.name, backlog, loggedRowsAnyDate);
    backlog = dropInternalOnlyBacklogEntries_(repCfg.name, backlog, function (eventId) {
      return calendarEventRawGuestEmails_(repCfg, eventId);
    });
    saveComplianceBacklog_(repCfg.name, backlog);
  }

  // Anything outstanding for COMPLIANCE_BACKLOG_MAX_AGE_DAYS_ has stopped
  // being "will probably get logged any day now" — re-flagging it forever is
  // just noise, and it's the reason the backlog can grow toward the Script
  // Property size limit. Pull those out into a one-time escalation instead
  // of another daily nag, and stop tracking them (a human needs to look, not
  // the daily check).
  var split = splitStaleBacklogEntries_(backlog, new Date(), tz);
  if (split.escalate.length) {
    var escalateLine = function (e) { return '- ' + e.prospectGuess + ' (' + e.callDateLabel + ' ' + e.time + ') — "' + e.title + '"'; };
    var escalateMissingRecording = split.escalate.filter(function (e) { return e.recordingMissing; });
    var escalateUnlogged = split.escalate.filter(function (e) { return !e.recordingMissing; });
    var escalateBody = '';
    // Kris's ask (03/09/2026, Sean): "where's the recording?" needs to reach
    // a human as its own distinct problem, not get buried in the generic
    // "could not be matched" explanation that used to cover both cases.
    if (escalateMissingRecording.length) {
      escalateBody += escalateMissingRecording.length + ' call(s) on ' + repCfg.name + '\'s calendar with NO ' +
        'recording ever received — nothing to log, the recording itself needs tracking down:\n' +
        escalateMissingRecording.map(escalateLine).join('\n') + '\n\n';
    }
    if (escalateUnlogged.length) {
      escalateBody += escalateUnlogged.length + ' call(s) matched to no logged row (often a bare-title ' +
        'calendar event with no attendee to match by):\n' +
        escalateUnlogged.map(escalateLine).join('\n') + '\n\n';
    }
    sendOpsAlert_(repCfg.name + ' — ' + split.escalate.length + ' call(s) unresolved for ' +
      COMPLIANCE_BACKLOG_MAX_AGE_DAYS_ + '+ days, needs a human',
      escalateBody +
      'These have been outstanding since first flagged. They\'ve been removed from ' + repCfg.name + '\'s ' +
      'daily nag — check by hand.');
    backlog = split.keep;
    saveComplianceBacklog_(repCfg.name, backlog);
  }

  if (backlog.length === 0) {
    log_(repCfg.name + ': fully compliant for ' + priorDay + ' (backlog cleared).');
    return;
  }
  sendComplianceEmail_(repCfg, backlog, tz);
}

/**
 * True when a calendar event's guest list proves it's an internal-only
 * meeting, not a real prospect call — i.e. it has at least one invited
 * guest and NONE of them are external (all in INTERNAL_EMAILS). Pure/
 * testable on its own; getRepCallEvents_ below is the only caller.
 *
 * Real bug found live (02/09/2026, Bens): a recurring internal 1-1 with
 * Joana, titled plain "QC", matched CALL_TITLE_INCLUDE's 'qc' keyword and
 * got treated as a real sales/QC call needing a logged Outcome Disposition
 * — Bens got nagged for it daily, and it showed up as "(name not parsed
 * from calendar title) — QC" since there was never a prospect name to
 * parse. A genuine sales/QC call always has at least one external guest;
 * an event whose guest list is non-empty but entirely internal isn't a
 * prospect call at all, whatever its title says.
 *
 * Deliberately NOT applied to an event with an EMPTY guest list — that's
 * the separate, already-known "prospect never added as a Calendar guest"
 * case (see getAllTrackerRows_ above), which still needs a human to
 * reconcile rather than being silently filtered out here.
 */
function eventLooksInternalOnly_(rawGuestEmails) {
  if (!rawGuestEmails.length) return false;
  return rawGuestEmails.every(function (e) { return INTERNAL_EMAILS.indexOf(e) !== -1; });
}

/**
 * Any OTHER company-domain guest on this event — e.g. the account manager
 * invited to a post-sale Discovery/onboarding call. Kris's ask (03/09/2026,
 * real case: Stacie Staub's Discovery call went to Joana's handoff-brief
 * email but not to her account manager, also invited to that same call):
 * "Joana will join to make sure the invoice gets paid but it needs to be
 * sent to the AM too."
 *
 * Deliberately checks the @iconsofrealestate.com DOMAIN, not membership in
 * INTERNAL_EMAILS — an account manager is a real, distinct role from the
 * fixed 5-person team list that constant models (see its own definition),
 * and a newly-hired AM's address wouldn't be in that list yet. Domain-only
 * risks nothing worse than CC'ing a teammate who was already going to see
 * the call anyway; excluding them via a stale roster risks the AM never
 * finding out about their own customer's call at all.
 *
 * Excludes repCfg.email (the rep this brief is already addressed to — no
 * point CC'ing someone their own email is already going to) and, since
 * getRepCallEvents_ already computes rawGuestEmails once, this only needs
 * to filter it, no separate Calendar read.
 */
function additionalTeamGuestEmails_(rawGuestEmails, repEmail) {
  var repEmailLower = String(repEmail || '').toLowerCase().trim();
  return rawGuestEmails.filter(function (e) {
    return e !== repEmailLower && e.indexOf('@iconsofrealestate.com') !== -1;
  });
}

/**
 * Retroactive companion to eventLooksInternalOnly_/getRepCallEvents_ above
 * (02/09/2026 follow-up, same Bens/Joana "QC" bug): that fix only stops a
 * NEW internal-only event from entering the backlog — it can't reach
 * backward. 3 of Bens' backlog entries were flagged before the fix shipped
 * and would be stuck forever, since reconcileComplianceBacklog_ only clears
 * an entry once a matching LOGGED tracker row shows up, and an internal 1-1
 * will never have one.
 *
 * Re-checks each entry's LIVE Calendar guest list via the injected
 * `lookupGuestEmails(eventId)` rather than the entry's own stored
 * attendeeEmails — those already had internal guests stripped out by
 * getRepCallEvents_ before storage, so a genuinely internal-only event's
 * stored attendeeEmails is an empty array, indistinguishable from the
 * separate "prospect never added as a guest" case. An entry with no eventId,
 * or whose lookup returns null (event deleted/inaccessible), is left alone
 * rather than guessed at. Pure given `lookupGuestEmails`; the real lookup
 * (calendarEventRawGuestEmails_ below) does the actual Calendar I/O.
 */
function dropInternalOnlyBacklogEntries_(repName, backlog, lookupGuestEmails) {
  return backlog.filter(function (entry) {
    if (!entry.eventId) return true;
    var rawGuestEmails = lookupGuestEmails(entry.eventId);
    if (!rawGuestEmails) return true;
    if (eventLooksInternalOnly_(rawGuestEmails)) {
      log_('  [' + repName + '] backlog item "' + entry.prospectGuess + '" (' + entry.callDateLabel +
        ') — now confirmed internal-only, dropping from backlog.');
      return false;
    }
    return true;
  });
}

/** Live Calendar lookup backing dropInternalOnlyBacklogEntries_ above. Returns null (not an empty array — that would mean "confirmed no guests") when the event can't be found or read, so callers can tell "not internal" apart from "couldn't check." */
function calendarEventRawGuestEmails_(repCfg, eventId) {
  var cal = repCfg.calendarId === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(repCfg.calendarId);
  if (!cal) return null;
  var ev;
  try {
    ev = cal.getEventById(eventId);
  } catch (e) {
    return null;
  }
  if (!ev) return null;
  return ev.getGuestList()
    .map(function (g) { return (g.getEmail() || '').toLowerCase().trim(); })
    .filter(Boolean);
}

/**
 * Pure title classifier shared by getRepCallEvents_/getRepCallEventsRaw_ —
 * extracted so the CALL_TITLE_INCLUDE/EXCLUDE matching itself is directly
 * testable without a live Calendar event object.
 */
function titleLooksLikeSalesOrQcCall_(title) {
  var t = (title || '').toLowerCase();
  var excluded = CONFIG.CALL_TITLE_EXCLUDE.some(function (k) { return t.indexOf(k) !== -1; });
  if (excluded) return false;
  return CONFIG.CALL_TITLE_INCLUDE.some(function (k) { return t.indexOf(k) !== -1; });
}

/**
 * Pull the rep's calendar events for [dayStart, dayEnd) and keep only those
 * that look like sales/QC calls (title keyword match, and not an
 * internal-only meeting that happens to match on title alone).
 */
function getRepCallEvents_(repCfg, dayStart, dayEnd) {
  var cal = repCfg.calendarId === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(repCfg.calendarId);
  if (!cal) throw new Error('No calendar found for id ' + repCfg.calendarId);

  var mapped = cal.getEvents(dayStart, dayEnd)
    .filter(function (ev) { return titleLooksLikeSalesOrQcCall_(ev.getTitle()); })
    .map(function (ev) {
      var rawGuestEmails = ev.getGuestList()
        .map(function (g) { return (g.getEmail() || '').toLowerCase().trim(); })
        .filter(Boolean);
      return {
        id: ev.getId(),
        title: ev.getTitle() || '(untitled)',
        start: ev.getStartTime(),
        prospectGuess: guessProspectFromTitle_(ev.getTitle() || ''),
        // Prospect emails only: strip the rep's own address and other internal
        // guests so an internal placeholder block can never match a tracker row.
        attendeeEmails: rawGuestEmails.filter(function (e) {
          return INTERNAL_EMAILS.indexOf(e) === -1;
        }),
        additionalTeamGuestEmails: additionalTeamGuestEmails_(rawGuestEmails, repCfg.email),
        internalOnly: eventLooksInternalOnly_(rawGuestEmails)
      };
    })
    .filter(function (e) {
      if (e.internalOnly) {
        log_('  ' + repCfg.name + ': skipping "' + e.title + '" — matched a call keyword but every ' +
          'guest is internal, so this is a team meeting, not a real prospect call.');
      }
      return !e.internalOnly;
    })
    .map(function (e) {
      // internalOnly only existed to drive the filter above -- drop it so
      // this function's return shape is unchanged for every other caller.
      return {
        id: e.id, title: e.title, start: e.start, prospectGuess: e.prospectGuess,
        attendeeEmails: e.attendeeEmails, additionalTeamGuestEmails: e.additionalTeamGuestEmails
      };
    });
  log_('  events+attendees ' + repCfg.name + ': ' + mapped.map(function (e) {
    return '"' + e.title + '"→[' + e.attendeeEmails.join(',') + ']';
  }).join(' | '));
  return mapped;
}

/**
 * Read ALL of the rep's tracker rows for the given day (logged or not), each
 * carrying sheet/column references so a match can write the Calendar Event ID
 * and Match Method back. Compliance filtering happens in the caller via .logged.
 * Pass priorDay as null/falsy to skip the date filter entirely and get rows
 * for every date — used to re-check the compliance backlog against the whole
 * sheet, since a backlogged item may get logged on any later day, not
 * necessarily re-checked on its original date again.
 */
function getAllTrackerRows_(repCfg, priorDay, tz) {
  var ss = SpreadsheetApp.openById(repCfg.spreadsheetId);
  var sheet = resolveSheet_(ss, repCfg.sheetName);
  if (!sheet) throw new Error('No suitable sheet found in spreadsheet ' + repCfg.spreadsheetId);

  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var header = values[0].map(function (h) { return String(h).trim(); });

  var col = {};
  for (var key in repCfg.columns) {
    col[key] = findColumn_(header, repCfg.columns[key]);
  }
  if (col.prospectName === -1) throw new Error('No prospect-name column found in ' + sheet.getName());
  // Real bug found live (28/08/2026, Bens): the compliance email tells reps
  // to fill in "Outcome Disposition" (Sold/Not Sold/Follow-up/No-show) —
  // that's literally the instruction in buildComplianceEmail_ below — but
  // this used to only ever check the separate "Outcome Logged" checkbox
  // column for compliance. A rep who did exactly what the email asked never
  // satisfied it: isTruthyOutcome_ doesn't even recognize "Follow-up" etc.
  // as truthy, and it was reading the wrong column besides. A row now counts
  // as logged if EITHER column says so. At least one of the two must exist.
  if (col.outcomeLogged === -1 && col.outcomeDisposition === -1) {
    throw new Error('No outcome-logged or outcome-disposition column found in ' + sheet.getName());
  }
  // callDate may be -1 on legacy sheets: without it we can't date-filter, so
  // treat all rows as candidates.

  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    // Skip fully-blank rows. NOTE: inserted checkboxes extend getDataRange()
    // far beyond real content, so check every cell, not just the name.
    var hasContent = row.some(function (cell) {
      return !(cell === '' || cell === null || cell === false);
    });
    if (!hasContent) continue;

    if (priorDay && col.callDate !== -1 && row[col.callDate] !== '' && row[col.callDate] != null) {
      if (formatDateCell_(row[col.callDate], tz) !== priorDay) continue; // wrong day
    }

    var repName;
    if (col.rep === -1) {
      // No Rep column at all — legacy per-rep sheet, safe to default: the
      // whole sheet belongs to this rep by construction.
      repName = repCfg.defaultRepName;
    } else if (row[col.rep]) {
      repName = String(row[col.rep]).trim();
    } else {
      // The Rep column EXISTS (this is the shared "Sales Call Log" tab all
      // three reps now point at) but this row's cell is blank. Falling back
      // to repCfg.defaultRepName here — as this used to do — silently
      // attributes an unowned row to whichever rep's pass happens to be
      // running: the SAME row would resolve to Bens on Bens' check, Joana on
      // Joana's, and Sean on Sean's. Skip it instead and say so loudly,
      // matching this file's "never silently guess" rule elsewhere (e.g.
      // LEGACY_DEFAULT_CALL_TYPE) — a human needs to set Rep, not have this
      // script guess it.
      log_('  Row ' + (r + 1) + ' in ' + sheet.getName() + ' has a blank Rep cell — skipping until it is set (never guessed).');
      continue;
    }
    if (repName.toLowerCase() !== repCfg.name.toLowerCase()) continue; // shared tab: only this rep's rows

    rows.push({
      rowIndex: r + 1, // 1-based sheet row, for logging and write-back
      sheet: sheet,
      eventIdCol: col.calendarEventId,   // -1 if the sheet has no such column
      matchMethodCol: findColumn_(header, ['Match Method']),
      logged: (col.outcomeLogged !== -1 && isTruthyOutcome_(row[col.outcomeLogged])) ||
        (col.outcomeDisposition !== -1 && String(row[col.outcomeDisposition] || '').trim() !== ''),
      prospect: normalize_(String(row[col.prospectName] || '')),
      email: col.prospectEmail !== -1 ? String(row[col.prospectEmail] || '').toLowerCase().trim() : '',
      eventId: col.calendarEventId !== -1 ? String(row[col.calendarEventId] || '').trim() : '',
      callType: col.callType !== -1 ? String(row[col.callType] || '').trim() : ''
    });
  }
  return rows;
}

/**
 * Deterministic match, in priority order:
 *   1. exact Calendar Event ID
 *   2. attendee email (structured guest data, no human typing involved)
 *   3. normalized prospect name (substring-tolerant fallback)
 */
function findMatch_(ev, rows) {
  // Only rows with a real prospect identity may match — guards against stale
  // write-backs on junk rows shadowing real ones via exact-ID.
  var candidates = rows.filter(function (r) { return r.prospect || r.email; });
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].eventId && idsEqual_(candidates[i].eventId, ev.id)) {
      candidates[i].matchedEvent = ev;
      return { rowIndex: candidates[i].rowIndex, via: 'calendar_event_id', row: candidates[i] };
    }
  }
  if (ev.attendeeEmails && ev.attendeeEmails.length) {
    for (var j = 0; j < candidates.length; j++) {
      if (candidates[j].email && ev.attendeeEmails.indexOf(candidates[j].email) !== -1) {
        candidates[j].matchedEvent = ev;
        return { rowIndex: candidates[j].rowIndex, via: 'attendee_email', row: candidates[j] };
      }
    }
  }
  var evProspect = normalize_(ev.prospectGuess);
  var evTitle = normalize_(ev.title);
  for (var k = 0; k < candidates.length; k++) {
    var p = candidates[k].prospect;
    if (!p) continue;
    if (evTitle.indexOf(p) !== -1 || (evProspect && p.indexOf(evProspect) !== -1) ||
        (evProspect && evProspect.indexOf(p) !== -1)) {
      candidates[k].matchedEvent = ev;
      return { rowIndex: candidates[k].rowIndex, via: 'prospect_name_fallback', row: candidates[k] };
    }
  }
  return null;
}

/**
 * Write the match results back to the sheet: the real Calendar Event ID (only
 * if the cell is empty — never overwrite a human-entered or previously written
 * ID) and the Match Method used. This is the Phase 0 join data being built
 * automatically: tomorrow's match on this row will be exact-key.
 * Returns true if a Calendar Event ID was actually written this call.
 */
function stampMatch_(hit) {
  var row = hit.row;
  if (!row || !row.sheet) return false;
  var wroteId = false;
  try {
    if (row.eventIdCol !== -1 && !row.eventId && row.matchedEvent) {
      row.sheet.getRange(row.rowIndex, row.eventIdCol + 1).setValue(row.matchedEvent.id);
      row.eventId = row.matchedEvent.id;
      wroteId = true;
    }
    if (row.matchMethodCol !== -1) {
      var method = hit.via === 'calendar_event_id' ? 'exact_key' : 'fallback_heuristic';
      row.sheet.getRange(row.rowIndex, row.matchMethodCol + 1).setValue(method);
    }
  } catch (e) {
    // A failed write-back must never break the compliance check itself.
    log_('    ↳ write-back failed for row ' + row.rowIndex + ': ' + e);
  }
  return wroteId;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * The bit of the raw Calendar title before the first "/" -- e.g.
 * "Podcast Qualification Call / Jess Provencher and ICONS of Real Estate"
 * -> "Podcast Qualification Call". Titles with no "/" (e.g. bare "QC") are
 * returned as-is. Used so the email shows a short call-type label instead of
 * repeating the whole raw title next to the already-parsed name.
 */
function callTypeFromTitle_(title) {
  var idx = title.indexOf('/');
  return (idx === -1 ? title : title.slice(0, idx)).trim();
}

// ---------------------------------------------------------------------------
// Compliance backlog — Kris's ask (26/08/2026): checkRep_ used to only ever
// compare TODAY's calendar events against TODAY's tracker rows. A call
// flagged as unlogged one day was never looked at again — if the rep ignored
// the email, nothing re-flagged it, nothing escalated, and there was no
// record anywhere of whether it ever got fixed. This persists an
// outstanding-items list per rep (Script Properties — this project has no
// database) that carries every unresolved item forward day to day until a
// matching LOGGED row shows up anywhere in the sheet (not just on that
// item's original date — a rep might log it late, correctly dated), and
// reports each item's own original date in the email, not just today's, so
// "how long has this actually been sitting" is visible without digging
// through old emails.
// ---------------------------------------------------------------------------

var COMPLIANCE_BACKLOG_PROP_PREFIX_ = 'COMPLIANCE_BACKLOG_';

function loadComplianceBacklog_(repName) {
  var props = PropertiesService.getScriptProperties();
  var key = COMPLIANCE_BACKLOG_PROP_PREFIX_ + repName;
  var raw = props.getProperty(key);
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // Real gap found live (26/08/2026 silent-failure audit): this used to
    // just log and return [] — and the caller then saves that empty array
    // right back over the property, so a corrupt value PERMANENTLY discarded
    // every outstanding item with nothing but one Logger line. Preserve the
    // raw corrupt value under a recovery key (so a human can hand-inspect
    // and restore it) and alert ops, instead of quietly committing the loss.
    props.setProperty(key + '_CORRUPT_' + Date.now(), raw);
    log_('loadComplianceBacklog_: corrupt backlog JSON for ' + repName + ', resetting. ' + e);
    sendOpsAlert_('Compliance backlog corrupted for ' + repName,
      'The compliance backlog Script Property for ' + repName + ' failed to parse as JSON and is being reset ' +
      'to empty — every outstanding unlogged call for this rep is about to be dropped unless you restore it.\n\n' +
      'The raw corrupt value has been saved under Script Property "' + key + '_CORRUPT_' + Date.now() +
      '" for recovery.\n\nParse error: ' + e);
    return [];
  }
}

/**
 * Defense in depth alongside the age cap in checkRep_: Script Properties
 * cap a value at 9KB, and at ~300-400 bytes/entry that's only ~25-30
 * backlog entries. If something still overflows it (the age cap has a bug,
 * or a burst of unlogged calls lands faster than the cap can clear them),
 * this drops the OLDEST entries (index 0 — appendNewBacklogEntries_ always
 * pushes onto the end) until it fits, rather than letting setProperty throw
 * and silently stop that rep's compliance emails entirely.
 */
function saveComplianceBacklog_(repName, backlog) {
  var props = PropertiesService.getScriptProperties();
  var key = COMPLIANCE_BACKLOG_PROP_PREFIX_ + repName;
  var toSave = backlog;
  while (true) {
    try {
      props.setProperty(key, JSON.stringify(toSave));
      if (toSave.length !== backlog.length) {
        sendOpsAlert_('Compliance backlog for ' + repName + ' hit the Script Property size limit',
          'Had to drop ' + (backlog.length - toSave.length) + ' of the oldest backlog entries for ' + repName +
          ' just to fit under the 9KB Script Property limit, even after the ' + COMPLIANCE_BACKLOG_MAX_AGE_DAYS_ +
          '-day age cap already ran. The backlog is growing faster than it should — look at why entries for ' +
          repName + ' aren\'t clearing.');
      }
      return;
    } catch (e) {
      if (toSave.length <= 1) {
        sendOpsAlert_('Compliance backlog for ' + repName + ' could not be saved at all',
          'saveComplianceBacklog_ failed even with a single entry: ' + e);
        return;
      }
      toSave = toSave.slice(1);
    }
  }
}

/** Rebuilds a findMatch_-compatible event object from a stored backlog entry. */
function backlogEntryToEvent_(entry) {
  return { id: entry.eventId, title: entry.title, prospectGuess: entry.prospectGuess, attendeeEmails: entry.attendeeEmails || [] };
}

/**
 * Drops any backlog entry that now has a matching LOGGED row anywhere in the
 * sheet. Pure given its inputs — no I/O of its own.
 *
 * Threads a claimedRowIndexes map through the matches — real bug found live
 * (26/08/2026 silent-failure audit): without this, one logged row with no
 * distinguishing event ID could satisfy findMatch_'s name-fallback for
 * SEVERAL backlog entries at once (e.g. two different unlogged calls for the
 * same prospect on different dates), clearing a still-genuinely-unlogged
 * entry as a side effect of a single real fix. matchEventsForRep_ already
 * guards against exactly this same-row-matches-twice shape; this mirrors it.
 */
function reconcileComplianceBacklog_(repName, backlog, loggedRowsAnyDate) {
  var claimedRowIndexes = {};
  return backlog.filter(function (entry) {
    var availableLogged = loggedRowsAnyDate.filter(function (r) { return !claimedRowIndexes[r.rowIndex]; });
    var hit = findMatch_(backlogEntryToEvent_(entry), availableLogged);
    if (hit) {
      claimedRowIndexes[hit.rowIndex] = true;
      log_('  [' + repName + '] backlog item "' + entry.prospectGuess + '" (' + entry.callDateLabel + ') is now logged — clearing.');
    }
    return !hit;
  });
}

// A backlog entry outstanding this long has stopped being "will probably get
// logged any day now" and started being a genuine data problem (a bare-title
// calendar event with no attendee that can never be name/email/ID-matched,
// or a call that will simply never be logged). Left uncapped, these
// accumulate forever — measured at ~300-400 bytes/entry against Script
// Properties' 9KB-per-value limit, i.e. only ~25-30 stuck entries before
// saveComplianceBacklog_ itself starts throwing (see its try/catch below).
var COMPLIANCE_BACKLOG_MAX_AGE_DAYS_ = 14;

/**
 * Splits out entries old enough to need a human rather than another daily
 * re-flag — returns { keep, escalate }. Pure given `now`/`tz`.
 */
function splitStaleBacklogEntries_(backlog, now, tz) {
  var keep = [], escalate = [];
  backlog.forEach(function (entry) {
    var label = daysAgoLabel_(entry.callDateLabel, now, tz);
    var days = label === 'today' ? 0 : Number(label.split(' ')[0]) || 0;
    (days >= COMPLIANCE_BACKLOG_MAX_AGE_DAYS_ ? escalate : keep).push(entry);
  });
  return { keep: keep, escalate: escalate };
}

/**
 * Appends today's newly-missing events to the backlog, each carrying the
 * date it actually happened. Dedupes by event ID when one exists; falls back
 * to a title+date+time composite key when it doesn't (a blank/missing event
 * ID used to skip the dedupe check entirely via the `existingIds[undefined]`
 * truthiness trap, silently duplicating the same bare-title event on every
 * run that saw it). Mutates and returns `backlog` in place, matching
 * Array.prototype.push's own convention.
 */
function backlogDedupeKey_(entry) {
  return entry.eventId || (entry.title + '|' + entry.callDateLabel + '|' + entry.time);
}

function appendNewBacklogEntries_(backlog, missingToday, priorDay, tz, nowIso) {
  var existingKeys = {};
  backlog.forEach(function (e) { existingKeys[backlogDedupeKey_(e)] = true; });
  missingToday.forEach(function (ev) {
    var time = Utilities.formatDate(ev.start, tz, 'HH:mm');
    var key = ev.id || (ev.title + '|' + priorDay + '|' + time);
    if (existingKeys[key]) return;
    backlog.push({
      eventId: ev.id,
      title: ev.title,
      prospectGuess: ev.prospectGuess,
      attendeeEmails: ev.attendeeEmails,
      callDateLabel: priorDay,
      time: time,
      firstFlaggedAt: nowIso,
      recordingMissing: !!ev.recordingMissing
    });
  });
  return backlog;
}

/**
 * "3 days ago" / "1 day ago" / "today", computed from a dd/MM/yyyy label
 * against `now` in business time. Reuses dateAtMidnightInBusinessTimezone_
 * (Phase2_CallScoring.gs) rather than a plain `new Date(y,m,d)` so this can't
 * reintroduce the exact script-timezone-vs-business-timezone bug that
 * function exists to avoid (see parseLegacyFilename_'s history).
 */
function daysAgoLabel_(dateLabelDdMmYyyy, now, tz) {
  var parts = dateLabelDdMmYyyy.split('/'); // ['dd', 'MM', 'yyyy']
  var callDay = dateAtMidnightInBusinessTimezone_(Number(parts[2]), Number(parts[1]), Number(parts[0]));
  var today = businessDayStart_(now, tz);
  var days = Math.round((today - callDay) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return days + ' days ago';
}

/**
 * Real bug found live (01/09/2026, Joana): every rep's spreadsheetId points
 * at the SAME shared multi-tab workbook (Sales Call Log lives alongside
 * unrelated tabs like Bens' own Icons 100 podcast tracker) — a bare
 * `/edit` URL with no tab specified opens whatever tab last happened to be
 * active for that spreadsheet, not necessarily "Sales Call Log". Joana's
 * compliance email landed her on Bens' tracker tab instead. Resolves the
 * REAL sheetId for repCfg.sheetName so the link can carry `#gid=<id>` and
 * deep-link to the right tab every time, same pattern salesCallLogRowLink_
 * (Phase2_CallScoring.gs) already uses for row-level links.
 */
function resolveRepTrackerGid_(repCfg) {
  var ss = SpreadsheetApp.openById(repCfg.spreadsheetId);
  var sheet = resolveSheet_(ss, repCfg.sheetName);
  return sheet ? sheet.getSheetId() : null;
}

/** Pure email-content builder — {subject, body, htmlBody} — kept separate from guardedSend_/resolveRepTrackerGid_
 * so it's testable without a real MailApp or SpreadsheetApp. sheetGid is optional — falls back to a bare
 * spreadsheet link (the pre-fix behavior) when not given, e.g. if resolveRepTrackerGid_ itself failed. */
function buildComplianceEmail_(repCfg, backlog, tz, sheetGid) {
  var n = backlog.length;
  var trackerUrl = 'https://docs.google.com/spreadsheets/d/' + repCfg.spreadsheetId + '/edit' +
    (sheetGid !== undefined && sheetGid !== null ? '#gid=' + sheetGid : '');
  var now = new Date();

  // Oldest-first BY THE CALL'S OWN DATE — not by firstFlaggedAt, which is
  // when the item entered the backlog, not when the call happened. A call
  // added to the backlog late (e.g. a calendar entry created retroactively)
  // would otherwise sort as if it were the newest item even when its own
  // date is the oldest in the list, and the subject's "oldest from" claim
  // would name the wrong call.
  var callDateSortKey = function (e) {
    var parts = e.callDateLabel.split('/'); // ['dd', 'MM', 'yyyy']
    return dateAtMidnightInBusinessTimezone_(Number(parts[2]), Number(parts[1]), Number(parts[0])).getTime();
  };
  var sorted = backlog.slice().sort(function (a, b) { return callDateSortKey(a) - callDateSortKey(b); });
  var oldest = sorted[0];

  // Names in the subject (not just the body) so which prospect(s) this is
  // about is visible from the inbox list without opening the email. Caps at
  // 3 named + "+N more" so a rare heavy backlog doesn't produce an
  // unreadably long subject line.
  var names = sorted.map(function (e) { return e.prospectGuess; });
  var namesForSubject = names.length <= 3
    ? names.join(', ')
    : names.slice(0, 3).join(', ') + ', +' + (names.length - 3) + ' more';

  var subject = repCfg.name + ' — [Action needed] Update your sales tracker — ' + namesForSubject +
    ' (' + n + ' call(s) still outstanding, oldest from ' + oldest.callDateLabel + ', ' +
    daysAgoLabel_(oldest.callDateLabel, now, tz) + ')';

  // guessProspectFromTitle_ falls back to echoing the raw title verbatim when
  // it can't parse a name out of it (e.g. a bare "QC" event) -- show that
  // honestly instead of printing the same string twice on one line
  // ("QC — 07:45 — QC"), which reads as a meaningless duplicate.
  var entries = sorted.map(function (e) {
    var nameParsed = e.prospectGuess.trim().toLowerCase() !== e.title.trim().toLowerCase();
    return {
      dateLabel: e.callDateLabel,
      daysAgo: daysAgoLabel_(e.callDateLabel, now, tz),
      time: e.time || '',
      who: nameParsed ? e.prospectGuess : '(name not parsed from calendar title)',
      callType: callTypeFromTitle_(e.title),
      recordingMissing: !!e.recordingMissing
    };
  });
  // Kris's ask (03/09/2026, Sean): a call with NO row at all (the recording
  // never arrived) needs different wording/action from a call whose row
  // exists but just has no Outcome Disposition yet — the rep can't "add the
  // outcome" for a call that was never transcribed in the first place.
  var unloggedEntries = entries.filter(function (e) { return !e.recordingMissing; });
  var missingRecordingEntries = entries.filter(function (e) { return e.recordingMissing; });

  var lineText = function (e) {
    return e.dateLabel + (e.time ? ' ' + e.time : '') + ' (' + e.daysAgo + ') — ' + e.who + ' — ' + e.callType;
  };
  var lineHtml = function (e) {
    return '<li>' + e.dateLabel + (e.time ? ' ' + e.time : '') + ' <i>(' + e.daysAgo + ')</i> — <b>' + e.who + '</b> — ' + e.callType + '</li>';
  };

  var plainSections = [];
  var htmlSections = [];
  if (unloggedEntries.length) {
    plainSections.push(
      unloggedEntries.length + ' call(s) with no outcome logged yet:\n\n' +
      unloggedEntries.map(function (e) { return '  • ' + lineText(e); }).join('\n') + '\n\n' +
      'Please add the outcome (Sold / Not Sold / Follow-up / No-show) and any notes for EACH of these.'
    );
    htmlSections.push(
      '<p>' + unloggedEntries.length + ' call(s) with no outcome logged yet:</p>' +
      '<ul>' + unloggedEntries.map(lineHtml).join('') + '</ul>' +
      '<p>Please add the outcome (Sold / Not Sold / Follow-up / No-show) and any notes for <b>each</b> of these.</p>'
    );
  }
  if (missingRecordingEntries.length) {
    plainSections.push(
      missingRecordingEntries.length + ' call(s) on your calendar with NO recording received at all — ' +
      'nothing to log yet, these need the actual recording tracked down:\n\n' +
      missingRecordingEntries.map(function (e) { return '  • ' + lineText(e); }).join('\n')
    );
    htmlSections.push(
      '<p><b>' + missingRecordingEntries.length + ' call(s) on your calendar with NO recording received at all</b> — ' +
      'nothing to log yet, these need the actual recording tracked down:</p>' +
      '<ul>' + missingRecordingEntries.map(lineHtml).join('') + '</ul>'
    );
  }

  // Real bug found live (04/09/2026, Tomás): even with the right #gid= (the
  // 01/09/2026 fix above), a bare "Tracker: <url>" gives no way to tell
  // whether the link is even pointing at the right tab without clicking it —
  // Tomás opened the shared multi-tab spreadsheet by hand (not via this
  // link) and landed on Bens' tab by default, and had no way from the email
  // alone to confirm this rep's actual link was correct. Naming the tab
  // right next to the link costs nothing and answers that on sight.
  var trackerLabel = 'Tracker (' + (repCfg.sheetName || 'Sales Call Log') + ' tab)';

  var body =
    'Hi ' + repCfg.name + ',\n\n' +
    'These ' + n + ' sales/QC call(s) still need attention in your tracker — each one shows the date it ' +
    'actually happened, so you can see how long it\'s been sitting:\n\n' +
    plainSections.join('\n\n') + '\n\n' +
    'This list carries over every day until each item is resolved, it does not reset.\n\n' +
    trackerLabel + ': ' + trackerUrl + '\n\n' +
    'Reply to this email once you\'ve updated the tracker, so Kris/Tomás know it\'s done.\n\n' +
    '— This is an automated check. This email was drafted by AI and sent automatically; ' +
    'reply to Kris or Tomás with any issues.';

  var htmlBody =
    '<p>Hi ' + repCfg.name + ',</p>' +
    '<p>These ' + n + ' sales/QC call(s) still need attention in your tracker — each one shows the date it ' +
    'actually happened, so you can see how long it\'s been sitting:</p>' +
    htmlSections.join('') +
    '<p>This list carries over every day until each item is resolved, it does not reset.</p>' +
    '<p><b>' + trackerLabel + ':</b> <a href="' + trackerUrl + '">' + trackerUrl + '</a></p>' +
    '<p><b>Reply to this email once you\'ve updated the tracker</b>, so Kris/Tomás know it\'s done.</p>' +
    '<p><i>— This is an automated check. This email was drafted by AI and sent automatically; ' +
    'reply to Kris or Tomás with any issues.</i></p>';

  return { subject: subject, body: body, htmlBody: htmlBody, oldestDateLabel: oldest.callDateLabel };
}

function sendComplianceEmail_(repCfg, backlog, tz) {
  var sheetGid = null;
  try {
    sheetGid = resolveRepTrackerGid_(repCfg);
  } catch (e) {
    // A failed gid lookup must not block the whole nag — buildComplianceEmail_
    // falls back to a bare (pre-fix) spreadsheet link when sheetGid is null.
    log_('  resolveRepTrackerGid_ failed for ' + repCfg.name + ', tracker link will open the last-active tab: ' + e);
  }
  var email = buildComplianceEmail_(repCfg, backlog, tz, sheetGid);
  var recipientsNeeded = 3; // rep + Kris + Tomás (CC counts against recipient quota)
  var sent = guardedSend_(repCfg.email, email.subject, email.body, {
    cc: CONFIG.KRIS_EMAIL + ',' + CONFIG.TOMAS_EMAIL,
    htmlBody: email.htmlBody,
    name: 'Call Tracker Compliance Bot'
  }, recipientsNeeded);
  log_((sent ? 'Sent' : 'SEND FAILED/SKIPPED for') + ' compliance email to ' + repCfg.email + ' for ' +
    backlog.length + ' outstanding unlogged call(s) (oldest: ' + email.oldestDateLabel + '). The backlog ' +
    'is already persisted regardless, so a skipped send is retried automatically on the next run.');
}

/**
 * Real incident found live (26/08/2026, silent-failure audit): this used to
 * route through guardedSend_, whose FIRST act is `if (!auditConfig_().ok)
 * return false` — so any config problem (even one scoped to a single rep's
 * email, nothing to do with OPS_ALERT_EMAIL) silently blocked the very alert
 * meant to report it. Bypasses guardedSend_ entirely and validates only the
 * one address this function actually needs.
 */
/**
 * htmlBody is optional (30/08/2026, Kris: "Terribly formatted email. Who
 * wants to read this?") — every existing caller passes only (subject, body)
 * and keeps working exactly as before (plain text, MailApp's default);
 * a caller that wants a styled version passes htmlBody as a third arg.
 */
function sendOpsAlert_(subject, body, htmlBody) {
  try {
    if (!CONFIG.OPS_ALERT_EMAIL || CONFIG.OPS_ALERT_EMAIL.indexOf('@') === -1) {
      log_('FAILED to send ops alert — CONFIG.OPS_ALERT_EMAIL is not a valid address: "' +
        CONFIG.OPS_ALERT_EMAIL + '". Alert was: [' + subject + '] ' + body);
      return false;
    }
    var options = htmlBody ? { htmlBody: htmlBody } : {};
    MailApp.sendEmail(CONFIG.OPS_ALERT_EMAIL, '[Compliance bot] ' + subject, body, options);
    return true;
  } catch (e) {
    log_('FAILED to send ops alert: ' + e);
    return false;
  }
}

var HEADER_DRIFT_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fires an ops alert the first time getValidatedColumnMap_ (Phase2_CallScoring.gs)
 * hits header drift on the "Sales Call Log" tab, then stays quiet for
 * HEADER_DRIFT_ALERT_COOLDOWN_MS — real incident live (25/08/2026): a stray
 * keystroke overwrote the "Prospect Name" header, and every scoring/
 * compliance trigger just failed silently in the Executions log with nobody
 * watching, until it was caught by accident while debugging something else.
 * Throttled (not one email per trigger firing) because the underlying
 * problem can easily stay broken for hours across a dozen different
 * triggers before a human fixes it — this only needs to say so once per
 * window, not spam. Uses Script Properties rather than an in-memory flag so
 * the cooldown survives across separate trigger executions.
 */
/** Styled version of alertHeaderDriftOnce_'s email — Kris, 30/08/2026: "Terribly formatted. Who wants to read this?" */
function buildHeaderDriftAlertHtml_(mismatches) {
  var mismatchRows = mismatches.map(function (m) {
    return '<li style="margin-bottom:4px;"><code style="background:#f3f3f3;padding:1px 4px;border-radius:3px;">' +
      escapeHtml_(m) + '</code></li>';
  }).join('');
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    '<p style="font-size:16px;margin:0 0 12px 0;"><strong style="color:#c0392b;">Sales Call Log header drift</strong> ' +
    '— every scoring/compliance function is failing</p>' +
    '<p style="margin:0 0 8px 0;"><code>getValidatedColumnMap_</code> found the "Sales Call Log" header row (row 1) ' +
    'does not match what the code expects:</p>' +
    '<ul style="margin:0 0 12px 0;padding-left:20px;">' + mismatchRows + '</ul>' +
    '<p style="margin:0 0 12px 0;"><strong>Every function that reads this sheet by column name is failing right ' +
    'now</strong> until this is fixed.</p>' +
    '<p style="margin:0 0 8px 0;">If this is just a stray edit to a header cell\'s text (e.g. someone typed into ' +
    'the wrong box), fix it by hand to match exactly, or run <strong>setupSalesCallLog()</strong> to rewrite row 1 ' +
    'back to the expected headers.</p>' +
    '<p style="margin:0 0 12px 0;">If a column was actually supposed to be added and the migration for it just ' +
    'hasn\'t been run yet, <strong>run that migration instead</strong> — do NOT blindly retype headers in that ' +
    'case, the underlying data columns won\'t actually be there yet.</p>' +
    '<p style="margin:0;color:#666;font-size:12px;">(Throttled to at most one alert per hour while this stays broken.)</p>' +
    '</div>'
  );
}

function alertHeaderDriftOnce_(mismatches) {
  var props = PropertiesService.getScriptProperties();
  var key = 'LAST_HEADER_DRIFT_ALERT_AT';
  var last = props.getProperty(key);
  var now = Date.now();
  if (last && (now - Number(last)) < HEADER_DRIFT_ALERT_COOLDOWN_MS) return;
  // Stamp the cooldown AFTER sendOpsAlert_ (not before) — sendOpsAlert_ now
  // bypasses guardedSend_'s config gate (see its own comment) so this can
  // really only fail on a genuine MailApp error, but there's no reason to
  // burn the hour-long cooldown on a failed send either way.
  var plainBody = 'getValidatedColumnMap_ found the "Sales Call Log" header row (row 1) does not match what the code ' +
    'expects:\n\n  ' + mismatches.join('\n  ') +
    '\n\nEvery function that reads this sheet by column name is failing right now until this is fixed.\n\n' +
    'If this is just a stray edit to a header cell\'s text (e.g. someone typed into the wrong box), fix it ' +
    'by hand to match exactly, or run setupSalesCallLog() to rewrite row 1 back to the expected headers.\n\n' +
    'If a column was actually supposed to be added and the migration for it just hasn\'t been run yet, run ' +
    'that migration instead — do NOT blindly retype headers in that case, the underlying data columns won\'t ' +
    'actually be there yet.\n\n' +
    '(Throttled to at most one alert per hour while this stays broken.)';
  var sent = sendOpsAlert_('Sales Call Log header drift — every scoring/compliance function is failing',
    plainBody, buildHeaderDriftAlertHtml_(mismatches));
  if (sent) props.setProperty(key, String(now));
}

/**
 * Quota guard per the brief: check MailApp.getRemainingDailyQuota() before
 * every send, keep QUOTA_RESERVE in reserve, and alert ops (never throw
 * mid-loop) when quota is short.
 */
function guardedSend_(to, subject, body, options, recipientsNeeded) {
  if (!auditConfig_().ok) {
    log_('CONFIG INVALID — send of "' + subject + '" to ' + to + ' blocked.');
    return false;
  }
  var remaining = MailApp.getRemainingDailyQuota();
  if (remaining - recipientsNeeded < CONFIG.QUOTA_RESERVE) {
    log_('QUOTA SHORT: remaining=' + remaining + ', needed=' + recipientsNeeded +
      ' — skipping send of "' + subject + '" to ' + to);
    if (to !== CONFIG.OPS_ALERT_EMAIL && remaining > 1) {
      MailApp.sendEmail(CONFIG.OPS_ALERT_EMAIL,
        '[Compliance bot] Quota short — email skipped',
        'Skipped sending "' + subject + '" to ' + to +
        ' because remaining daily quota is ' + remaining +
        ' (reserve ' + CONFIG.QUOTA_RESERVE + ').\n\nBody that was not sent:\n\n' + body);
    }
    return false;
  }
  MailApp.sendEmail(to, subject, body, options || {});
  return true;
}

/**
 * Same quota/config guard as guardedSend_, but for a caller that needs the
 * REAL thread it just created — MailApp.sendEmail() returns nothing, so the
 * only way to find "the email I just sent" afterward is a GmailApp.search(),
 * racing Gmail's own indexing. Real bug (confirmed live 28/08/2026):
 * sendDailyPracticeReminders_ used to do exactly that (sleep 3s, then
 * search by subject+recipient) to find the just-sent assignment thread to
 * track — under indexing lag, or when Bens/Sean/Joana's near-simultaneous
 * sends left ambiguous search state, it could come back with the WRONG
 * thread (confirmed: the tracked thread ID for one such row didn't match
 * any real thread with that subject). Every nag and cancel/stop check after
 * that then operated on the wrong data — a row could get marked 'cancelled'
 * from content that was never actually a cancel/stop reply on that
 * assignment. GmailApp.createDraft(...).send() returns the actual sent
 * GmailMessage — .getThread() is the real thread, no search, no race.
 */
function guardedSendAndGetThread_(to, subject, body, options, recipientsNeeded) {
  if (!auditConfig_().ok) {
    log_('CONFIG INVALID — send of "' + subject + '" to ' + to + ' blocked.');
    return null;
  }
  var remaining = MailApp.getRemainingDailyQuota();
  if (remaining - recipientsNeeded < CONFIG.QUOTA_RESERVE) {
    log_('QUOTA SHORT: remaining=' + remaining + ', needed=' + recipientsNeeded +
      ' — skipping send of "' + subject + '" to ' + to);
    if (to !== CONFIG.OPS_ALERT_EMAIL && remaining > 1) {
      MailApp.sendEmail(CONFIG.OPS_ALERT_EMAIL,
        '[Compliance bot] Quota short — email skipped',
        'Skipped sending "' + subject + '" to ' + to +
        ' because remaining daily quota is ' + remaining +
        ' (reserve ' + CONFIG.QUOTA_RESERVE + ').\n\nBody that was not sent:\n\n' + body);
    }
    return null;
  }
  var message = GmailApp.createDraft(to, subject, body, options || {}).send();
  return message.getThread();
}

/**
 * Same quota/config guard as guardedSend_, for GmailApp thread.replyAll()
 * instead of MailApp.sendEmail(). GmailApp sends draw from the same daily
 * email quota as MailApp — a bare thread.replyAll() call bypasses the
 * quota check/ops-alert/return-value contract every other send in this
 * codebase relies on. recipientsNeeded should count every address the
 * reply-all will actually reach (thread participants + any explicit cc).
 */
function guardedReplyAll_(thread, body, options, recipientsNeeded) {
  if (!auditConfig_().ok) {
    log_('CONFIG INVALID — reply-all on thread ' + thread.getId() + ' blocked.');
    return false;
  }
  var remaining = MailApp.getRemainingDailyQuota();
  if (remaining - recipientsNeeded < CONFIG.QUOTA_RESERVE) {
    log_('QUOTA SHORT: remaining=' + remaining + ', needed=' + recipientsNeeded +
      ' — skipping reply-all on thread ' + thread.getId());
    if (remaining > 1) {
      MailApp.sendEmail(CONFIG.OPS_ALERT_EMAIL,
        '[Compliance bot] Quota short — reply-all skipped',
        'Skipped a reply-all on thread ' + thread.getId() +
        ' because remaining daily quota is ' + remaining +
        ' (reserve ' + CONFIG.QUOTA_RESERVE + ').\n\nBody that was not sent:\n\n' + body);
    }
    return false;
  }
  thread.replyAll(body, options || {});
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSheet_(ss, preferredName) {
  if (preferredName) {
    var s = ss.getSheetByName(preferredName);
    if (s) return s;
  }
  for (var i = 0; i < CONFIG.SHARED_LOG_TAB_CANDIDATES.length; i++) {
    var cand = ss.getSheetByName(CONFIG.SHARED_LOG_TAB_CANDIDATES[i]);
    if (cand) return cand;
  }
  return ss.getSheets()[0] || null;
}

function findColumn_(header, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var idx = header.findIndex(function (h) {
      return h.toLowerCase() === candidates[i].toLowerCase();
    });
    if (idx !== -1) return idx;
  }
  return -1;
}

/** ✓, TRUE, "x", a timestamp/date, "yes" — all count as logged. Blank/FALSE do not. */
function isTruthyOutcome_(v) {
  if (v === true) return true;
  if (v instanceof Date) return true;
  var s = String(v || '').trim().toLowerCase();
  if (!s) return false;
  return ['true', 'yes', 'y', 'x', '✓', 'done', '1'].indexOf(s) !== -1;
}

/** Normalize a cell to DD/MM/YYYY in script tz; free-text like "May 20" is returned as-is (won't match, logged for visibility). */
function formatDateCell_(v, tz) {
  if (v instanceof Date && !isNaN(v)) {
    return Utilities.formatDate(v, tz, 'dd/MM/yyyy');
  }
  // Free-text legacy dates (brief.txt's own documented example: "May 20", no
  // year) have no explicit offset, so new Date(string) parses them using the
  // SCRIPT's own default timezone (Session.getScriptTimeZone()) — the exact
  // thing this file's header comment says business-day math must never rely
  // on. Reformatting that instant into `tz` (CONFIG.BUSINESS_TIMEZONE) would
  // re-interpret the same instant in a DIFFERENT zone and can shift the
  // calendar date by a day whenever the two zones disagree. Read it back out
  // in the SAME zone the implicit parse assumed, instead of business tz, so
  // the calendar date the free text was written to mean survives the round trip.
  var parsed = new Date(v);
  if (!isNaN(parsed)) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  }
  log_('  unparseable date cell: "' + v + '"');
  return String(v).trim();
}

/** Google event ids look like "abc123@google.com"; rows may store with or without the suffix. */
function idsEqual_(rowId, eventId) {
  // Trim BEFORE stripping the suffix: the regex is end-anchored ($), so
  // trailing whitespace after "@google.com" (a stray space pasted into a
  // sheet cell) would otherwise stop it from matching at all, leaving the
  // suffix un-stripped and silently failing to match a bare-ID row.
  var strip = function (s) { return String(s).trim().replace(/@google\.com$/i, ''); };
  return strip(rowId) === strip(eventId);
}

function normalize_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Best-effort prospect name from an event title. Handles the real patterns seen
 * on the team calendars:
 *   "Podcast Qualification Call / Tom Wood and ICONS of Real Estate" → "Tom Wood"
 *   "Starting A Podcast / Theresa Gomez and  Joana"                  → "Theresa Gomez"
 *   "Lance Nowak  and Bens - Icons 100 Podcast Recording"            → "Lance Nowak"
 *   "Real Estate Podcast: Andrea Brunson"                            → "Andrea Brunson"
 * Falls back to stripping keywords/separators; bare titles like "QC" return "QC"
 * (matching then relies on the Calendar Event ID or fails safe to not-logged).
 */
function guessProspectFromTitle_(title) {
  var t = String(title || '');

  // Pattern 1: "... / {Name} and ..." — Calendly-style qualification/discovery titles.
  var m = t.match(/\/\s*([^/]+?)\s+and\s+/i);
  if (m) return m[1].trim();

  // Pattern 2: "{Name} and {Rep} - ..." — recording titles.
  m = t.match(/^\s*(.+?)\s+and\s+\w+\s*[-–—]/i);
  if (m) return m[1].trim();

  // Pattern 3: "Real Estate Podcast: {Name}"
  m = t.match(/real estate podcast:\s*(.+)$/i);
  if (m) return m[1].trim();

  // Fallback: strip include keywords and separators, keep the remainder.
  CONFIG.CALL_TITLE_INCLUDE.forEach(function (k) {
    t = t.replace(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  });
  t = t.replace(/\b(call|with|icons|real estate|podcast|series|booking|session|and)\b/ig, ' ');
  t = t.replace(/[|\-–—:()\[\]/]/g, ' ').replace(/\s+/g, ' ').trim();
  return t || String(title || '').trim();
}

function startOfDay_(d, tz) {
  var s = Utilities.formatDate(d, tz, 'yyyy/MM/dd');
  return new Date(s + ' 00:00:00 GMT' + Utilities.formatDate(d, tz, 'Z'));
}

/**
 * Start (00:00:00) of the day that instant `d` belongs to in zone `tz`,
 * returned as an absolute instant. Does NOT interpret `d` in script time
 * first — 18:00 LA on a Friday still maps to Friday's 00:00 LA, never to
 * Saturday. DST-safe: the UTC offset is computed for the day itself.
 */
function businessDayStart_(d, tz) {
  var s = Utilities.formatDate(d, tz, 'yyyy/MM/dd');
  return new Date(s + ' 00:00:00 GMT' + Utilities.formatDate(d, tz, 'Z'));
}

/**
 * Kris's ask (19/08/2026): the daily self-practice cycle is anchored to
 * Tuesday's training call, not the calendar work-week — Wed/Thu/Fri/Mon/Tue
 * = Day 1-5, then it loops to Week+1 Day 1 the following Wednesday.
 * Saturday/Sunday get no assignment (returns null). Deliberately stateless —
 * derived purely from the date, using TRAINING_CYCLE_EPOCH (a real Wednesday,
 * Week 1 Day 1) as the anchor, so no counter needs to be stored anywhere.
 */
var TRAINING_CYCLE_DAY_BY_WEEKDAY_ = { Wednesday: 1, Thursday: 2, Friday: 3, Monday: 4, Tuesday: 5 };
var TRAINING_CYCLE_EPOCH_CACHE_ = null;

/**
 * Real bug found live (26/08/2026 silent-failure audit): this used to be a
 * top-level `var TRAINING_CYCLE_EPOCH_ = new Date(2026, 7, 19)` — the plain
 * constructor builds midnight in the SCRIPT's own default timezone (Asia/
 * Bangkok, appsscript.json), not CONFIG.BUSINESS_TIMEZONE — the exact
 * anti-pattern dateAtMidnightInBusinessTimezone_ (Phase2_CallScoring.gs)
 * exists to avoid. Reformatted into America/New_York, that instant
 * normalized to Tue 18 Aug, not Wed 19 Aug, which inflated daysSinceEpoch by
 * one and rolled the week number over a day early, every week (every
 * Tuesday reported the NEXT week's number instead of the current one).
 * Lazy + memoized rather than a top-level var, since dateAtMidnightInBusinessTimezone_
 * calls Utilities.formatDate, which must not run at script-load time.
 */
function trainingCycleEpoch_() {
  if (!TRAINING_CYCLE_EPOCH_CACHE_) {
    TRAINING_CYCLE_EPOCH_CACHE_ = dateAtMidnightInBusinessTimezone_(2026, 8, 19); // Wed 19 Aug 2026 = Week 1, Day 1
  }
  return TRAINING_CYCLE_EPOCH_CACHE_;
}

function computeTrainingCycleLabel_(date, tz) {
  var weekdayName = Utilities.formatDate(date, tz, 'EEEE');
  var day = TRAINING_CYCLE_DAY_BY_WEEKDAY_[weekdayName];
  if (!day) return null; // Saturday/Sunday — no assignment

  var daysSinceEpoch = Math.round(
    (businessDayStart_(date, tz) - businessDayStart_(trainingCycleEpoch_(), tz)) / 86400000
  );
  var week = Math.floor(daysSinceEpoch / 7) + 1;
  return { week: week, day: day, label: 'Week ' + week + ', Day ' + day };
}

// ---------------------------------------------------------------------------
// Phase 0 one-time setup — creates the shared "Sales Call Log" tab.
// Run setupSalesCallLog() ONCE from the editor, then delete or ignore.
// ---------------------------------------------------------------------------

var SALES_CALL_LOG_HEADERS = [
  // --- Phase 0: deterministic, filled by rep or script ---
  'Prospect Name',          // A
  'Prospect Email',         // B
  'Source',                 // C
  'Call Date',              // D  (DD/MM/YYYY)
  'Rep',                    // E  (dropdown: Bens/Joana/Sean)
  'Call Type',              // F  (dropdown: QC/Sales Call/Discovery/Icons 100 Recording)
  'Outcome Logged',         // G  (checkbox)
  'Outcome Disposition',    // H  (dropdown: Sold/Not Sold/Follow-up/No-show)
  'Calendar Event ID',      // I  (join key to Calendar + Riverside title)
  'Riverside Recording ID', // J  (Phase 2)
  'Transcript URL',         // K  (Phase 2)
  'Match Method',           // L  (dropdown: exact_key/fallback_heuristic/no_match — Phase 2)
  // --- Phase 2: written by the scoring pipeline ---
  'Lead Quality Verdict',   // M
  'Call Quality Score',     // N  (1-5)
  'Flag: Asked For Close',  // O  (bool)
  'Flag: Objections Handled', // P  (bool)
  'Manual Review Recommended', // Q (bool)
  'Severity',               // R  (1-5)
  'AI Feedback Summary',    // S
  'Reviewed By',            // T  (dropdown: Kris/Tomás — who reviewed this call, blank = not yet.
                            //    Renamed from "Reviewed By Kris" 25/08/2026 — Tomás reviews too now;
                            //    run migrateRenameReviewedByColumn() (Phase2_CallScoring.gs) once on
                            //    an existing live sheet, see that function's own comment.)
  'Queue Age',              // U  (days)
  'Kris Manual Review Verdict', // V (dropdown: Yes/No, blank = not yet judged —
                            //    Phase 2 weekly calibration input; see SOP §7)
  // --- Phase 5: written by the scoring pipeline, read by the weekly scorecard ---
  'Primary Failure Mode',   // W  (no_close_ask/objections_missed/weak_discovery/
                            //    no_goal_alignment/no_second_call_booked/both/
                            //    multiple/framework_not_explained/none —
                            //    appended at the end, same
                            //    backward-compatible pattern as column V. Existing
                            //    live sheets need migrateAddPrimaryFailureModeColumn()
                            //    (Phase2_CallScoring.gs) run once before this column
                            //    exists there; rows scored before that will read as
                            //    blank, which the weekly scorecard treats as "no
                            //    signal" rather than an error.
  // --- 25/08/2026: third scored dimension, per Kris — explaining the
  // podcast framework properly heads off objections before they're raised,
  // same "prevention beats handling" logic already grounding failure mode 2.
  // See Phase2_CallGradingSOP.md §3D. ---
  'Flag: Framework Explained', // X (bool — recruit-agents + #1-podcast-in-city
                            //    + sell-more-houses all covered proactively)
  'Framework Gaps',         // Y  (comma-joined: which of the 3 pieces were
                            //    missing/weak, blank if all 3 covered — the
                            //    coaching detail behind column X, same "pack
                            //    real content into a real column, not just a
                            //    bool" pattern as the flags before it)
  // --- 25/08/2026: records which rubric version scored this row, so a
  // future rubric change never leaves historical rows silently
  // non-comparable to new ones again — see Phase2_CallGradingSOP.md §3E and
  // RUBRIC_VERSION in Phase2_CallScoring.gs. ---
  'Rubric Version',         // Z  (e.g. "2026-08-25-framework" — blank on rows
                            //    scored before this column existed, same
                            //    backward-compatible "no signal" pattern as
                            //    every prior column addition here)
  // --- 29/08/2026: fourth scored dimension, per Kris — "I haven't seen
  // feedback on how they deliver the pitch." Grounded in the company's Sales
  // SOP ("How to Pitch & Close a Lead" §5.2-5.3) and a real audit of 20
  // Tomás transcripts, not invented — see Phase2_CallGradingSOP.md §3G. ---
  'Flag: Delivery Effective', // AA (bool — paced appropriately AND read/adapted
                            //    to the lead's engagement, both covered)
  'Delivery Gaps',          // AB (comma-joined: which of the 2 pieces were
                            //    missing/weak, blank if both covered — same
                            //    "pack real content into a real column" pattern
                            //    as Framework Gaps before it)
  // --- 03/09/2026: discovery, per Kris — "The 4 main elements are
  // 1. Discovery (QC does this too) 2. Framework (only sales call) 3. Ask for
  // the money (ask for the booking on QC) 4. Objection handling. All 4 need to
  // be graded and the highest priority trained each week." Three rubric
  // variants already JUDGED discovery (Bens'/QC's/Sean's discovery_adequate +
  // understood_leads_business flags) but only ever packed the answer into the
  // free-text AI Feedback Summary — no column meant no scorecard tally, no
  // dashboard signal, and no way to ever pick discovery as a week's training
  // focus. See DISCOVERY_GAP_LABELS_/deriveDiscoveryFields_ in
  // Phase2_CallScoring.gs. ---
  'Flag: Discovery Adequate', // AC (bool — real discovery questions asked AND
                            //    the lead's business actually understood; on a
                            //    Sales Call also: the earlier QC's findings
                            //    confirmed and deepened where they were thin.
                            //    Blank on rows scored before this column
                            //    existed, same "no signal" convention as every
                            //    column addition above.)
  'Discovery Gaps',         // AD (comma-joined: which discovery pieces were
                            //    missing/weak, blank if all covered — same
                            //    pattern as Framework Gaps/Delivery Gaps)
  // --- 03/09/2026: booking-decision quality, per Kris — "sales reps are
  // lazy, and they book through to a discovery call where it's not a hell
  // yes." A Sales Call that books a Discovery call (the account manager's
  // onboarding/payment call) is only the right choice when the lead
  // committed to paying on that call; otherwise it should have been a
  // Second Sales Call with Tomás. Only 'shared'/'sean' rubric variants score
  // this (the ones that actually make the decision) — blank everywhere
  // else, same "no signal" convention as every column above. See
  // deriveBookingDecisionFields_/bookingDecisionRubricPrompt_ in
  // Phase2_CallScoring.gs. ---
  'Flag: Booking Decision Appropriate', // AE (bool — blank when no Discovery
                            //    call was booked on this call at all, i.e.
                            //    this dimension doesn't apply)
  'Booking Decision Gap',  // AF (free text explaining the mismatch, blank
                            //    when appropriate or not applicable)
  // --- 03/09/2026: elevation, per Kris — "the sales rep needs to elevate
  // the other person... this is Thomas, he's amazing, you're gonna love
  // working with him... and let the other guys get to it." Scored on
  // Discovery calls (elevating the account manager) and Tomás's second/
  // closing calls (elevating Tomás) — blank when the original rep wasn't
  // even present on the call, same "no signal" convention as every column
  // above. See deriveElevationFields_/elevationRubricPrompt_. ---
  'Flag: Elevation Done',  // AG (bool — blank when the original rep wasn't
                            //    present on this call at all)
  'Elevation Gap',         // AH (free text, blank when done or not applicable)
  // --- 03/09/2026: Discovery-call-only dimensions, graded against the real
  // "SOP for Podcast Discovery Calls" (Kris: "Use the SOP when grading disco
  // calls"). Only the 'discovery' rubric variant writes these — every other
  // variant/row reads blank. See deriveDiscoveryContentFields_/
  // deriveRepPaymentFields_ in Phase2_CallScoring.gs. ---
  'Flag: Discovery Content Covered', // AI (bool — all 4 SOP call-agenda
                            //    items covered: goals/guest avatar/branding/
                            //    launch strategy. Blank on non-Discovery rows.)
  'Discovery Content Gaps', // AJ (comma-joined: which of the 4 were missing)
  // Not part of the SOP (which never asks the AM to collect payment) — kept
  // because Kris's real complaint (a rep not confirming payment before a
  // Discovery call happens) showed up in the first two real calls reviewed.
  // Graded on the ORIGINAL SALES REP, not the AM: "the sales rep still joins
  // the Discovery call and is responsible for picking up the payment, then
  // they introduce the AM." Blank whenever the rep wasn't present on the
  // call at all (money already collected earlier).
  'Flag: Payment Collected By Rep', // AK (bool — blank when rep wasn't
                            //    present on this call at all)
  'Payment Collected By Rep Gap',   // AL (free text, blank when collected or n/a)
  // --- 05/09/2026: Phase 12 (Phase12_GhlNoteSync.gs), per Kris ("automate
  // the fuck out of everything... reviews of calls, note on leads") —
  // confirmed live that GHL's Notes endpoint is real, writable, and already
  // in genuine use by the team. Tracks which rows already got their AI
  // review posted as a GHL Note, so the sync never posts the same review
  // twice. Blank on rows scored before this column existed, same
  // backward-compatible "no signal" pattern as every column above —
  // run migrateAddPrimaryFailureModeColumn() once to backfill the header. ---
  'GHL Review Synced'      // AM (checkbox)
];

/** The spreadsheet that will host the shared log — Ben's tracker per the brief. */
var SALES_CALL_LOG_SPREADSHEET_ID = '1bK0VbgP3xdK5LhfYqO0fps9ivJzPDn3fsDcsl1dEBM4';

/**
 * One-time Phase 0 setup. Creates (or validates) the "Sales Call Log" tab with
 * headers, dropdowns, checkbox column, frozen header row, and a few sample
 * rows for 14/08/2026 so the dry run can be validated end-to-end.
 * Safe to re-run: it will not duplicate the tab or the sample rows.
 */
function setupSalesCallLog() {
  RUN_TAG = 'setupSalesCallLog';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName('Sales Call Log');

  if (!sheet) {
    sheet = ss.insertSheet('Sales Call Log');
    log_('Created "Sales Call Log" tab.');
  } else {
    log_('"Sales Call Log" tab already exists — validating.');
  }

  // Headers
  var headerRange = sheet.getRange(1, 1, 1, SALES_CALL_LOG_HEADERS.length);
  var existing = headerRange.getValues()[0];
  // Real incident found live (26/08/2026, silent-failure audit): this used to
  // check only column A. The header-drift alert (alertHeaderDriftOnce_) tells
  // people to run this function to fix drift, but drift in any OTHER column
  // (e.g. a stray keystroke in N1) left column A untouched, so this reported
  // "already exists — validating" and rewrote nothing while every scoring/
  // compliance function stayed broken. Compare every header, not just the first.
  var headersPresent = SALES_CALL_LOG_HEADERS.every(function (h, i) { return existing[i] === h; });
  if (!headersPresent) {
    headerRange.setValues([SALES_CALL_LOG_HEADERS]);
    log_('Wrote ' + SALES_CALL_LOG_HEADERS.length + ' headers.');
  }
  headerRange.setFontWeight('bold').setBackground('#e8eef7');
  sheet.setFrozenRows(1);

  // Data validation: Rep (E), Call Type (F), Outcome Disposition (H), Match Method (L)
  setDropdown_(sheet, 5, ['Bens', 'Joana', 'Sean']);
  setDropdown_(sheet, 6, ['QC', 'Sales Call', 'Discovery', 'Icons 100 Recording']);
  setDropdown_(sheet, 8, ['Sold', 'Not Sold', 'Follow-up', 'No-show']);
  setDropdown_(sheet, 12, ['exact_key', 'fallback_heuristic', 'no_match']);
  setDropdown_(sheet, SALES_CALL_LOG_HEADERS.indexOf('Reviewed By') + 1, ['Kris', 'Tomás']);
  // Yes/No dropdown rather than a checkbox: a checkbox range forces every
  // empty cell to render as unchecked (false), which would make "not yet
  // judged" indistinguishable from "Kris disagreed" — calibration needs to
  // tell those two apart, so blank has to stay genuinely blank.
  setDropdown_(sheet, 22, ['Yes', 'No']);

  // Outcome Logged (G) as checkbox
  sheet.getRange('G2:G1000').insertCheckboxes();

  // Call Date (D) number format DD/MM/YYYY
  sheet.getRange('D2:D1000').setNumberFormat('dd/mm/yyyy');

  // Sample rows for 14/08/2026 — lets the dry run show both a match and misses.
  // Check column A for real content: inserted checkboxes make getLastRow() unreliable.
  var hasData = sheet.getRange('A2:A1000').getValues()
    .some(function (r) { return String(r[0]).trim() !== ''; });
  if (!hasData) {
    var sample = [
      // Prospect, Email, Source, Call Date, Rep, Call Type, Outcome Logged, Disposition, Calendar Event ID
      ['Andrea Brunson', '', 'Podcast', new Date(2026, 7, 14), 'Joana', 'QC', true, 'Follow-up', ''],
      ['Jacqueline Coleman', '', 'Podcast', new Date(2026, 7, 14), 'Joana', 'QC', false, '', ''],
      ['Julio Cardoso', '', 'Podcast', new Date(2026, 7, 14), 'Joana', 'QC', false, '', ''],
      ['Justine', '', 'Podcast', new Date(2026, 7, 14), 'Sean', 'Discovery', false, '', '']
    ];
    sheet.getRange(2, 1, sample.length, sample[0].length).setValues(sample);
    log_('Inserted ' + sample.length + ' sample rows for 14/08/2026 (Andrea Brunson is logged; the rest are intentionally not).');
  } else {
    log_('Rows already exist — no sample data inserted.');
  }

  sheet.autoResizeColumns(1, SALES_CALL_LOG_HEADERS.length);
  log_('Setup complete. Point all rep configs at sheetName "Sales Call Log" and run dryRunComplianceCheck with a -2 day offset to validate against 14/08.');
}

/**
 * Defense against exactly what happened live (25/08/2026): a stray keystroke
 * meant for the spreadsheet's Name Box landed directly in cell A1 instead
 * and silently renamed "Prospect Name", which made every scoring/compliance
 * function fail (see getValidatedColumnMap_, Phase2_CallScoring.gs) until it
 * was caught by hand. Warning-only, not a hard lock: Range.protect()'s edit
 * restriction only ever applies to human editors in the Sheets UI — it can
 * never block this script's own SpreadsheetApp calls, so it's safe to leave
 * on permanently without any risk of breaking the live pipeline. Idempotent:
 * removes any protection this function previously added on this exact range
 * before re-adding it, so re-running never stacks duplicates.
 *
 * ONE-TIME SETUP: run this once from the Apps Script editor after
 * setupSalesCallLog(). Not wired to any trigger — it only ever needs
 * running again if the protection itself gets manually removed.
 */
function protectSalesCallLogHeaderRow() {
  RUN_TAG = 'protectSalesCallLogHeaderRow';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('protectSalesCallLogHeaderRow: no "Sales Call Log" tab found.'); return; }

  var description = 'Sales Call Log header row — do not edit directly, see CLAUDE.md';
  sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
    if (p.getDescription() === description) p.remove();
  });

  sheet.getRange(1, 1, 1, SALES_CALL_LOG_HEADERS.length)
    .protect()
    .setDescription(description)
    .setWarningOnly(true);
  log_('protectSalesCallLogHeaderRow: warning-only protection applied to row 1, columns 1-' +
    SALES_CALL_LOG_HEADERS.length + '.');
}

// ---------------------------------------------------------------------------
// "Objection Playbook" tab — Kris's ask (25/08/2026): Tomás needs one place
// to see every known objection and its scripted response, and be able to
// update it himself, without touching GitHub or Apps Script. Objection_Handling_Playbook.md
// (repo root) is the original source — same content, but only editable by
// whoever has git access. This is a live, human-editable copy in the same
// spreadsheet Tomás already has open daily. The .md file's own header
// already says "Tomás approves changes here before they're used in
// training" — this just makes that literally true instead of aspirational.
// Not kept in automatic sync with the .md file or with FEW_SHOT_ANCHORS in
// Phase2_CallScoring.gs (which still needs a real code change + redeploy to
// actually reach the live prompt) — this tab is where the content lives and
// gets curated now; periodically pull real edits back into the .md/prompt
// by hand, same as any other rubric-affecting change in this project.
// ---------------------------------------------------------------------------

var OBJECTION_PLAYBOOK_SHEET_NAME = 'Objection Playbook';
var OBJECTION_PLAYBOOK_HEADERS = [
  '#', 'Objection', 'Times Seen (of 43, as of 17/08/2026)', 'Real Examples',
  'Why It Happens', 'Technique', 'Suggested Response', 'Coaching Note',
  'Status', 'Last Updated By', 'Last Updated'
];

/**
 * Seed content transcribed from Objection_Handling_Playbook.md v1 (built
 * from the first batch of 43 Bens recordings, May-July 2026, scored
 * 17/08/2026). Real prospect quotes and names — see that file for full
 * citations if a quote needs tracing back to its actual call.
 */
function objectionPlaybookSeedRows_() {
  return [
    [1, 'I\'m too busy / not right now', 6,
      'Whitney Lohr ("I don\'t have the capacity for it right now... towards the end of summer"), Jim Atkinson ' +
      '("I don\'t know if I got time for that"), Kade Phillips ("right now it\'s not really on my radar... ' +
      'working on this Zillow contract"), David Leventhal ("once I get everything off my plate... just not ' +
      'now"), Heather Gill ("I don\'t mind having the conversation... but it\'s not anything I can do right ' +
      'now"), Cory Boldroff ("I have no bandwidth").',
      'Usually genuine — these are high-volume producers with real calendar pressure. Sometimes it\'s a polite ' +
      'deflection because the value of a 15-minute call hasn\'t been made concrete yet.',
      'Isolate and minimize, never leave it open-ended. The mistake in most of these calls wasn\'t hearing "not ' +
      'now" — it\'s accepting it as a full stop. A "not now" should always convert into a specific placeholder ' +
      'date, not a vague future promise.',
      '"Totally get it — everyone I talk to on this show is busy for a reason. That\'s actually why this is a ' +
      '15-minute conversation, not a project. Rather than leave it open, let\'s just grab a placeholder for ' +
      '[specific date 2-3 weeks out] — if it\'s still not the right moment when we get there, we\'ll push it ' +
      'again, no pressure at all."',
      'If the prospect still declines a specific placeholder after this, that\'s a real "not now" — accept it, ' +
      'but never accept the first "not now" as final without one attempt to convert it into a date.',
      'Approved (v1)', '', ''],
    [2, 'What does this cost / how does monetization actually work?', 4,
      'Barinder Maan ("How do you guys monetize it on a money basis?... who controls it, what is the monetary ' +
      'fees attached to it?" — got no answer), Michelle Reifel ("would you be sending a marketing budget?"), ' +
      'Gary Lanham ("Is there a way to monetize that?"), Dana Hindman-Allen ("send me a price breakdown... ' +
      'before I take people\'s time").',
      'Legitimate diligence — experienced business owners want to know roughly what they\'re being asked to ' +
      'invest before booking a second call.',
      'Directional answer, not a full punt. Fully deferring every pricing question to Tomás reads as evasive ' +
      'to a sharp prospect. Give a ballpark and one concrete outcome, then bridge to the deeper conversation — ' +
      'this still leaves the real numbers to Tomás, it just doesn\'t stonewall.',
      '"Good question — I can\'t get into exact numbers since that\'s really Tomás\'s conversation, but ' +
      'directionally it\'s [ballpark], and most agents see [one concrete outcome, e.g. their first inbound ' +
      'lead from an episode within a few weeks]. Tomás will walk you through the real structure on the call — ' +
      'does that work as a starting point?"',
      '', 'Approved (v1)', '', ''],
    [3, 'That\'s too expensive', 1,
      // Tomás's correction (27/08/2026): Dana Hindman-Allen's call was pulled
      // out of this objection — "wanted pricing before committing more time"
      // is the SAME underlying concern as objection #2 ("what does this cost/
      // how does monetization work"), not a real cost objection ("too
      // expensive" implies a stated number was already reacted to as too
      // high, which never happened on her call). She stays under #2 only.
      'Tennitia Wilson ("the costs were prohibitive... more than my car note and insurance put together... in ' +
      'sales you don\'t have a pension or 401k, to commit to that dollar amount I\'d be real brazen").',
      'Real budget sensitivity, especially for 1099 commission-only agents without steady income or benefits.',
      'Acknowledge, then quantify. Never acknowledge-then-deflect. Tennitia\'s call is the textbook example of ' +
      'what NOT to do: "maybe we can offer you something that fits" with no actual number. This is exactly the ' +
      'rubric\'s "objections uncovered but not overcome" case.',
      '"That\'s fair, and I\'d rather you know the real number now than find out later. For context, [X] is ' +
      'roughly the cost of [one small piece of marketing spend / a fraction of a single commission check], and ' +
      'agents in your market have seen [concrete result]. If that math doesn\'t work for you, no hard feelings ' +
      '— but let\'s at least get you real numbers from Tomás before deciding either way."',
      '', 'Approved (v1)', '', ''],
    [4, 'I already have my own podcast / marketing company / platform', 4,
      'Jeff Goodman (hosted his own 130-episode podcast), Bill Gross ("I\'m pretty satisfied with what I\'m ' +
      'doing now, the system kind of works for me"), Thom Tillier ("I\'m looking to create an unedited podcast ' +
      'because I don\'t have time for editing, nor do I want to pay for editing"), Steve Hauck (already pays a ' +
      'marketing company for video/editing — never raised but a near-certain future objection).',
      'Successful producers often already run some content operation and don\'t immediately see the ' +
      'incremental value of a second one.',
      'Don\'t compete with what they have; position as removing a cost from it. Ask one question about what ' +
      'their current approach actually costs them in hours/month before pitching, then tie the offer to that ' +
      'specific gap rather than a generic "content and authority" pitch.',
      '"That\'s great that you\'re already doing [X] — a lot of the agents we work with are in the same spot. ' +
      'The difference usually isn\'t replacing what you\'re doing, it\'s taking [the specific pain point they ' +
      'mentioned — editing, consistency, distribution] off your plate so you can focus on [their actual ' +
      'business]. Worth 15 minutes to see if that gap applies to you?"',
      '', 'Approved (v1)', '', ''],
    [5, 'I wouldn\'t know where to start / what if I\'m not good at this', 1,
      'Katie Uei ("I would not have any idea where to start... what if I run out of topics? Maybe I\'m boring ' +
      'or something").',
      'Podcasting is unfamiliar territory; the prospect doubts they have enough "content" in them.',
      'Concrete process proof, not cheerleading. Bens\'s actual response here was pure reassurance, which ' +
      'doesn\'t resolve a capability doubt. The fix is explaining the actual mechanism: ICONS supplies the ' +
      'structure, so the guest never has to generate content cold.',
      '"That\'s the number one thing people worry about, which is exactly why we don\'t leave it to you — we ' +
      'supply the questions, the structure, even topic ideas based on what\'s working in your market. You just ' +
      'talk about your business the way you already do with clients every day."',
      '', 'Approved (v1)', '', ''],
    [6, 'I don\'t know this platform — is this legit?', 1,
      'Phuong Phan ("all the services I have heard of, but Riverside is something I have not heard... I was ' +
      'skeptical, I\'m like who are you... I don\'t want to trap in something I don\'t know").',
      'An unfamiliar brand or tool name (Riverside, ICONS) triggers real skepticism, especially on a ' +
      'cold-approached call.',
      'Never joke past a trust objection. Bens\'s actual response was humor, which reads as more evasive, not ' +
      'less, for a real legitimacy concern. The fix is concrete, checkable proof: a company site, a real guest ' +
      'list, or a reference willing to be contacted.',
      '"Totally fair to be cautious — here\'s [company website/LinkedIn], and here are a couple of agents in a ' +
      'similar market you\'re welcome to look up, or even reach out to directly, before you commit any more ' +
      'time."',
      '', 'Approved (v1)', '', ''],
    [7, 'This doesn\'t fit how I actually run my business', 2,
      'Rob Bonecutter (his stated near-term goal was "bringing more agents into the company... through social ' +
      'media," i.e. recruiting, not personal brand growth), Thom Tillier (specifically wants unedited content ' +
      'with no paid editing — a direct mismatch with what ICONS sells).',
      'The generic "content and authority" pitch doesn\'t map to what the prospect actually said their #1 ' +
      'priority is.',
      'Ask their current #1 growth lever before pitching, then tailor to it. Rob\'s call is the best partial ' +
      'example of this being done right — Bens tied the podcast back to Rob\'s stated recruiting goal on the ' +
      'fly. Use that as the model, not the exception.',
      '"You mentioned your focus right now is more on [recruiting / their stated priority] than personal brand ' +
      '— that makes sense. A lot of our partners actually use the podcast that way too: [a concrete example ' +
      'tied to their stated goal]. Want me to have Tomás speak specifically to that angle instead of the ' +
      'general pitch?"',
      '', 'Approved (v1)', '', ''],
    [8, 'I can tell this is a sales pitch', 1,
      'Dana Hindman-Allen — highest-severity call in the whole batch. "I knew you were selling me on a ' +
      'podcast. I knew you were the whole time... pretty sharp hooking right here."',
      'A savvy, high-profile prospect recognizes the interview-into-upsell structure and names it directly, ' +
      'testing whether Bens will be straight with her.',
      'Own it plainly, don\'t get defensive or laugh it off. Bens\'s actual response ("well, good for you") ' +
      'did neither — it just ended the exchange with nothing resolved and no meeting booked. Validate the ' +
      'observation directly and reframe with confidence instead of deflecting.',
      '"You got me — yeah, this interview is genuinely great content for you either way, and if it\'s a fit, ' +
      'there\'s a paid option on top of it. I\'d rather be upfront about that than pretend otherwise. Want the ' +
      'two-minute version of what that actually is? No pressure either way."',
      '', 'Approved (v1)', '', ''],
    [9, 'Flat "not interested," no reason given', 1,
      'Carolyn Triebold — Bens never actually made the real ask here (only a soft "haven\'t you thought about ' +
      'social media" trial-close question), and when she said "not something I\'m interested in," he accepted ' +
      'it and moved to wrap up.',
      'Sometimes a genuine no; sometimes a reflexive deflection to a soft, opinion-style question rather than ' +
      'a real, direct ask.',
      'Probe once, and always make the actual ask. A trial-close question isn\'t a real ask, so a "no" to it ' +
      'isn\'t a real answer. Always make the direct ask; if declined, probe once before accepting it.',
      '"No worries at all — can I ask, is it more that podcasting itself isn\'t your thing, or just not a ' +
      'priority right now? [listen for the real reason] Either way, would you be open to a quick, no-pressure ' +
      'look at what it actually involves, just so you have the full picture for later?"',
      '', 'Approved (v1)', '', '']
  ];
}

/**
 * ONE-TIME SETUP: run once from the Apps Script editor. Safe to re-run —
 * only writes the header row and seed rows if the tab doesn't already have
 * real content, so re-running after Tomás has started editing never
 * clobbers his changes (checked the same way setupSalesCallLog() checks for
 * existing sample data: real content in column A past the header).
 */
function setupObjectionPlaybook() {
  RUN_TAG = 'setupObjectionPlaybook';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(OBJECTION_PLAYBOOK_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(OBJECTION_PLAYBOOK_SHEET_NAME);
    log_('Created "' + OBJECTION_PLAYBOOK_SHEET_NAME + '" tab.');
  }

  var headerRange = sheet.getRange(1, 1, 1, OBJECTION_PLAYBOOK_HEADERS.length);
  if (headerRange.getValues()[0][0] !== OBJECTION_PLAYBOOK_HEADERS[0]) {
    headerRange.setValues([OBJECTION_PLAYBOOK_HEADERS]);
  }
  headerRange.setFontWeight('bold').setBackground('#e8eef7');
  sheet.setFrozenRows(1);

  var hasData = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues()
    .some(function (r) { return String(r[0]).trim() !== ''; });
  if (!hasData) {
    var seed = objectionPlaybookSeedRows_();
    sheet.getRange(2, 1, seed.length, OBJECTION_PLAYBOOK_HEADERS.length).setValues(seed);
    log_('Seeded ' + seed.length + ' objection(s) from Objection_Handling_Playbook.md v1.');
  } else {
    log_('Objection Playbook already has content — not overwriting.');
  }

  sheet.setColumnWidths(4, 3, 420); // Real Examples / Why It Happens / Technique — long prose, needs room
  sheet.getRange(2, 4, Math.max(sheet.getLastRow() - 1, 1), 4).setWrap(true);
  setDropdown_(sheet, 9, ['Draft', 'Approved (v1)', 'Needs Update']);
  sheet.autoResizeColumns(1, 3);
  log_('setupObjectionPlaybook complete. Tomás can edit any row directly — Status/Last Updated columns are ' +
    'there for him to track his own changes, nothing reads them automatically.');
}

/**
 * ONE-TIME PATCH (25/08/2026): applies Tomás's real edits to the Bens
 * playbook — objections #1/#2/#4 — from his own working copy (shared as a
 * PDF/Doc, not yet reconciled back into this codebase). #2's old quoted
 * script is REPLACED (Tomás crossed it out in his own copy) rather than
 * appended to; #1 and #4 keep the original quote alongside his new
 * step-by-step technique. Also fixes a name typo ("Steve Hauck" ->
 * "Steve Houck") in #4's real examples. Safe to re-run — always overwrites
 * to the same target text, never appends duplicate content. Run once from
 * the editor; does nothing to rows #3/#5-#9, which Tomás's copy left
 * unchanged.
 */
function patchObjectionPlaybookBensEdits_25aug_() {
  RUN_TAG = 'patchObjectionPlaybookBensEdits_25aug_';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(OBJECTION_PLAYBOOK_SHEET_NAME);
  if (!sheet) { log_('No "' + OBJECTION_PLAYBOOK_SHEET_NAME + '" tab — run setupObjectionPlaybook() first.'); return; }

  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, Math.max(lastRow - 1, 0), OBJECTION_PLAYBOOK_HEADERS.length).getValues();
  var byNumber = {};
  values.forEach(function (row, i) { byNumber[row[0]] = i + 2; });

  var patches = {
    1: {
      suggestedResponse:
        '1. Acknowledge and empathise — we only work with busy people.\n' +
        '2. Deconstruct what "busy" actually means for them.\n' +
        '3. Let them know the real commitment — average 1h/week (if still pushing back, use the Hormozi line).\n' +
        '4. Pitch the Podcast Strategy Call — understand their plan and see how a podcast fits (if still pushing, agree a follow-up date).\n\n' +
        '"Totally get it — everyone I talk to on this show is busy for a reason. That\'s actually why this is a ' +
        '15-minute conversation, not a project. Rather than leave it open, let\'s just grab a placeholder for ' +
        '[1-2 days out] — if it\'s still not the right moment when we get there, we\'ll push it again, no ' +
        'pressure at all."'
    },
    2: {
      // Tomás crossed out the old scripted quote in his own copy — replaced, not appended to.
      suggestedResponse:
        '- Accept and joke about the price question — "I\'m not taking your money today," or go straight into: ' +
        '"As much as I would like to tell you pricing right now, and you would probably want to pay me and get ' +
        'started…"\n' +
        '- Clarify we like to show the value first before the $, so they can see the impact.\n' +
        '- Our network manager will do that and show you the investment.\n' +
        '- I promise it\'s not something that is going to scare you.\n' +
        '- Book Strategy Call.'
    },
    4: {
      realExamplesFix: { from: 'Steve Hauck', to: 'Steve Houck' },
      suggestedResponse:
        'If the podcast is no longer active:\n' +
        '- Mention it before they do.\n' +
        '- Ask how the experience was.\n' +
        '- Why did it make you stop?\n' +
        '- We revive podcasts — book Strategy Call.\n\n' +
        'If the podcast is active:\n' +
        '- Awesome! How is it going?\n' +
        '- Have you gotten some results from it?\n' +
        '- Are you producing this in-house or working with another agency?\n' +
        '- Offer the Strategy Call as a free brainstorming session with the #1 Real Estate Podcast Network.\n\n' +
        '"That\'s great that you\'re already doing [X] — a lot of the agents we work with are in the same spot. ' +
        'The difference usually isn\'t replacing what you\'re doing, it\'s taking [the specific pain point they ' +
        'mentioned — editing, consistency, distribution] off your plate so you can focus on [their actual ' +
        'business]. Worth 15 minutes to see if that gap applies to you?"'
    }
  };

  var suggestedResponseCol = OBJECTION_PLAYBOOK_HEADERS.indexOf('Suggested Response') + 1;
  var realExamplesCol = OBJECTION_PLAYBOOK_HEADERS.indexOf('Real Examples') + 1;
  var lastUpdatedByCol = OBJECTION_PLAYBOOK_HEADERS.indexOf('Last Updated By') + 1;

  Object.keys(patches).forEach(function (num) {
    var rowIndex = byNumber[Number(num)];
    if (!rowIndex) { log_('  No row found for objection #' + num + ' — skipping.'); return; }
    var patch = patches[num];
    sheet.getRange(rowIndex, suggestedResponseCol).setValue(patch.suggestedResponse);
    if (patch.realExamplesFix) {
      var current = String(sheet.getRange(rowIndex, realExamplesCol).getValue());
      sheet.getRange(rowIndex, realExamplesCol).setValue(
        current.split(patch.realExamplesFix.from).join(patch.realExamplesFix.to));
    }
    sheet.getRange(rowIndex, lastUpdatedByCol).setValue('Tomás');
    log_('  Patched objection #' + num + ' (row ' + rowIndex + ').');
  });
  log_('patchObjectionPlaybookBensEdits_25aug_ complete.');
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function patchObjectionPlaybookBensEdits() {
  patchObjectionPlaybookBensEdits_25aug_();
}

/**
 * ONE-TIME PATCH (27/08/2026): Tomás's correction on Bens' objection #3
 * ("That's too expensive") — Dana Hindman-Allen's call never reacted to a
 * stated price as too high; "wanted pricing before committing more time" is
 * the same underlying concern as objection #2 (monetization/cost question),
 * not this one. Removes her from #3's Real Examples and drops Times Seen
 * from 2 to 1 (she still stays under #2, untouched here). Safe to re-run —
 * a no-op once already applied, since it matches on the exact old string.
 */
function patchObjectionPlaybookDanaMiscategorization_27aug_() {
  RUN_TAG = 'patchObjectionPlaybookDanaMiscategorization_27aug_';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(OBJECTION_PLAYBOOK_SHEET_NAME);
  if (!sheet) { log_('No "' + OBJECTION_PLAYBOOK_SHEET_NAME + '" tab — run setupObjectionPlaybook() first.'); return; }

  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, Math.max(lastRow - 1, 0), OBJECTION_PLAYBOOK_HEADERS.length).getValues();
  var rowIndex = null;
  for (var i = 0; i < values.length; i++) {
    if (Number(values[i][0]) === 3) { rowIndex = i + 2; break; }
  }
  if (!rowIndex) { log_('No row found for objection #3 — skipping.'); return; }

  var timesSeenCol = OBJECTION_PLAYBOOK_HEADERS.indexOf('Times Seen (of 43, as of 17/08/2026)') + 1;
  var realExamplesCol = OBJECTION_PLAYBOOK_HEADERS.indexOf('Real Examples') + 1;
  var lastUpdatedByCol = OBJECTION_PLAYBOOK_HEADERS.indexOf('Last Updated By') + 1;

  var current = String(sheet.getRange(rowIndex, realExamplesCol).getValue());
  var danaClause = ', Dana Hindman-Allen (wanted pricing before committing more time — same underlying concern)';
  if (current.indexOf(danaClause) === -1) {
    log_('Objection #3 (row ' + rowIndex + ') does not contain the Dana Hindman-Allen clause verbatim — ' +
      'already patched, or the cell was hand-edited since. Not touching it. Current value: ' + current);
    return;
  }
  sheet.getRange(rowIndex, realExamplesCol).setValue(current.split(danaClause).join(''));
  sheet.getRange(rowIndex, timesSeenCol).setValue(1);
  sheet.getRange(rowIndex, lastUpdatedByCol).setValue('Tomás');
  log_('Patched objection #3 (row ' + rowIndex + '): removed Dana Hindman-Allen, Times Seen 2 -> 1.');
}

/**
 * NOT a curated playbook like Bens' (that took a human reviewing 43 real
 * calls to build) — this is real starting MATERIAL for one: every Joana/
 * Sean call THIS WEEK (getWeekBounds_'s "most recently completed Mon-Sun
 * week," same window the scorecard emails use) where the scoring pipeline's
 * Primary Failure Mode shows an objection was actually raised and missed
 * (objections_missed / both / multiple), with the AI's own feedback summary
 * for that call. Someone still has to turn this into an actual technique —
 * that step isn't automated, same as it wasn't for Bens either. Appends new
 * rows to the Objection Playbook tab, never touches Bens' existing rows.
 * Safe to re-run — dedupes on prospect+date so re-running this week doesn't
 * stack duplicate rows for the same call.
 */
function seedJoanaSeanObjectionRawData() {
  RUN_TAG = 'seedJoanaSeanObjectionRawData';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var logSheet = resolveSheet_(ss, 'Sales Call Log');
  if (!logSheet) { log_('No Sales Call Log tab found.'); return; }
  var playbookSheet = ss.getSheetByName(OBJECTION_PLAYBOOK_SHEET_NAME);
  if (!playbookSheet) { log_('No "' + OBJECTION_PLAYBOOK_SHEET_NAME + '" tab — run setupObjectionPlaybook() first.'); return; }

  var col = getValidatedColumnMap_(logSheet);
  var lastRow = logSheet.getLastRow();
  if (lastRow < 2) { log_('No data rows in Sales Call Log.'); return; }
  var rows = logSheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  var tz = CONFIG.BUSINESS_TIMEZONE;
  var week = getWeekBounds_(new Date(), tz);
  var OBJECTION_FAILURE_MODES = ['objections_missed', 'both', 'multiple'];

  var candidates = [];
  rows.forEach(function (row) {
    var rep = row[col['Rep'] - 1];
    if (rep !== 'Joana' && rep !== 'Sean') return;
    var callDate = row[col['Call Date'] - 1];
    if (!(callDate instanceof Date) || callDate < week.start || callDate >= week.end) return;
    var mode = String(row[col['Primary Failure Mode'] - 1] || '');
    if (OBJECTION_FAILURE_MODES.indexOf(mode) === -1) return;
    candidates.push({
      rep: rep,
      prospectName: row[col['Prospect Name'] - 1],
      callDate: callDate,
      feedback: row[col['AI Feedback Summary'] - 1]
    });
  });

  if (!candidates.length) {
    log_('No Joana/Sean calls this week flagged for a missed objection — nothing to seed.');
    return;
  }

  var playbookLastRow = playbookSheet.getLastRow();
  var existing = playbookLastRow > 1
    ? playbookSheet.getRange(2, 1, playbookLastRow - 1, OBJECTION_PLAYBOOK_HEADERS.length).getValues()
    : [];
  var existingKeys = {};
  var maxNum = 0;
  existing.forEach(function (r) {
    maxNum = Math.max(maxNum, Number(r[0]) || 0);
    existingKeys[normalize_(String(r[1]))] = true; // dedupe on the Objection column's own text, built the same way below
  });

  var suggestedResponseCol = OBJECTION_PLAYBOOK_HEADERS.indexOf('Suggested Response') + 1;
  var nextNum = maxNum + 1;
  var newRows = [];
  candidates.forEach(function (c) {
    var label = '[' + c.rep + '] Objection missed — ' + c.prospectName + ' (' +
      Utilities.formatDate(c.callDate, tz, 'dd/MM') + ')';
    if (existingKeys[normalize_(label)]) return; // already seeded, don't duplicate
    newRows.push([
      nextNum++,
      label,
      '', // Times Seen — n/a, this is one real instance, not a tallied pattern yet
      c.prospectName + ', ' + Utilities.formatDate(c.callDate, tz, 'dd/MM/yyyy'),
      'Not yet analyzed — raw call flagged by the scoring pipeline this week.',
      'Not yet written — review the AI feedback below and the real transcript before drafting a technique.',
      'Not yet written.',
      'AI Feedback Summary from this call: ' + (c.feedback || '(none)'),
      'Draft',
      '',
      ''
    ]);
  });

  if (!newRows.length) {
    log_('All flagged Joana/Sean calls this week are already seeded — nothing new to add.');
    return;
  }
  playbookSheet.getRange(playbookLastRow + 1, 1, newRows.length, OBJECTION_PLAYBOOK_HEADERS.length).setValues(newRows);
  log_('Seeded ' + newRows.length + ' raw objection-miss row(s) for Joana/Sean this week (' +
    week.start + ' to ' + week.end + '). Tomás still needs to turn these into real techniques.');
}

// ---------------------------------------------------------------------------
// "Manual Review Guide" tab — companion to the above: Kris's ask (25/08/2026)
// for instructions Tomás can follow to review calls and grade them or log
// outcomes by hand. Pure reference content, not a script this project reads
// — this is entirely for a human to read in the same spreadsheet they
// already work in.
// ---------------------------------------------------------------------------

var MANUAL_REVIEW_GUIDE_SHEET_NAME = 'Manual Review Guide';

function manualReviewGuideRows_() {
  return [
    ['What "Lead Quality Verdict" (good_to_book) actually means',
      'This is NOT "the call resulted in a booking." It answers one question only: "should this call have ' +
      'been booked at all?" — i.e. was the prospect a worthwhile lead. good_to_book = yes, worth pursuing. ' +
      'should_screen_out = a bad lead, and the rep\'s call-quality score doesn\'t get judged at all for that ' +
      'row (a bad lead shouldn\'t penalize a rep\'s technique on a call that shouldn\'t have happened).'],
    ['What actually tracks whether a booking happened: "Outcome Disposition" (column H)',
      'This is the single most important column for you to fill in, and it is 100% manual — nothing in the ' +
      'automated pipeline ever writes it. Set it to Sold / Not Sold / Follow-up / No-show once you know how a ' +
      'call actually turned out (did the QC turn into a booked Sales Call, did the Sales Call turn into a ' +
      'booked close). As of 25/08/2026 the vast majority of scored calls have this blank — filling it in as ' +
      'you go is what makes the dashboard\'s funnel numbers mean anything at all.'],
    ['How to find calls worth reviewing',
      'Filter/sort the "Sales Call Log" tab: column Q ("Manual Review Recommended") = TRUE surfaces calls the ' +
      'AI itself flagged as uncertain — the model failed to parse cleanly, or the score genuinely warrants a ' +
      'second look. Column R ("Severity", 1-5) ranks how bad the AI thinks a call went. Kris also gets a ' +
      'prioritized 3-call daily review queue via buildReviewQueue() — ask him if you want to be added to ' +
      'that same digest instead of browsing the sheet directly.'],
    ['How to grade a call manually',
      'Open the "Transcript URL" (column K) for the call, read/listen to it, then edit these columns directly ' +
      '— they\'re just sheet cells, nothing stops a human edit: "Lead Quality Verdict" (M, good_to_book / ' +
      'should_screen_out), "Call Quality Score" (N, 1-5), "Flag: Asked For Close" (O, TRUE/FALSE — did the rep ' +
      'make an explicit ask, not just a trial-close question), "Flag: Objections Handled" (P, TRUE/FALSE — ' +
      'both surfaced AND resolved with something concrete, not just acknowledged), "Primary Failure Mode" (W, ' +
      'pick the closest match: no_close_ask / objections_missed / weak_discovery / no_goal_alignment / ' +
      'no_second_call_booked / both / multiple / framework_not_explained / none), "AI Feedback Summary" (S) — ' +
      'add your own note rather than erasing the AI\'s, so there\'s a record of what changed and why.'],
    ['Marking that you reviewed a call — "Reviewed By" (column T)',
      'Set this to "Kris" or "Tomás" (dropdown) once you\'ve actually looked at a call — either of you can ' +
      'review, and this records who. Blank means nobody has reviewed it yet; buildReviewQueue() and the ' +
      'dashboard\'s queue view both treat any non-blank value here as "already reviewed," regardless of ' +
      'which name is in it.'],
    ['"Kris Manual Review Verdict" (column V) — Kris-specific, leave alone',
      'This one Yes/No column is different from "Reviewed By": it\'s Kris\'s own calibration signal — does he ' +
      'agree with the AI\'s score on this call — and feeds the weekly ~80%-agreement benchmark that gates ' +
      'whether the AI judge is trusted to run with less oversight. Don\'t write into this one unless Kris ' +
      'specifically asks you to.'],
    ['Updating the objection playbook',
      'The "Objection Playbook" tab (same spreadsheet) is your living reference — every known objection, why ' +
      'it happens, and Bens\'s scripted response. Edit any row directly when you want to refine a response or ' +
      'add a new objection type you\'ve seen in real calls; update "Last Updated By" / "Last Updated" so ' +
      'there\'s a record. Nothing here auto-updates the live scoring prompt — flag real changes to Kris so ' +
      'they can be carried into the actual rubric/training material.']
  ];
}

/**
 * ONE-TIME SETUP: run once from the Apps Script editor. Safe to re-run —
 * only seeds rows if the tab has no real content yet, same guard as
 * setupObjectionPlaybook(), so it never clobbers edits Tomás has made to
 * the guide itself.
 */
function setupManualReviewGuide() {
  RUN_TAG = 'setupManualReviewGuide';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(MANUAL_REVIEW_GUIDE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MANUAL_REVIEW_GUIDE_SHEET_NAME);
    log_('Created "' + MANUAL_REVIEW_GUIDE_SHEET_NAME + '" tab.');
  }

  var headers = ['Topic', 'Instructions'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  if (headerRange.getValues()[0][0] !== headers[0]) {
    headerRange.setValues([headers]);
  }
  headerRange.setFontWeight('bold').setBackground('#e8eef7');
  sheet.setFrozenRows(1);

  var hasData = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues()
    .some(function (r) { return String(r[0]).trim() !== ''; });
  if (!hasData) {
    var seed = manualReviewGuideRows_();
    sheet.getRange(2, 1, seed.length, headers.length).setValues(seed);
    log_('Seeded ' + seed.length + ' guide row(s).');
  } else {
    log_('Manual Review Guide already has content — not overwriting.');
  }

  sheet.setColumnWidth(1, 260);
  sheet.setColumnWidth(2, 700);
  sheet.getRange(2, 2, Math.max(sheet.getLastRow() - 1, 1), 1).setWrap(true);
  sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).setFontWeight('bold');
  log_('setupManualReviewGuide complete.');
}

/**
 * URGENT, on-demand (25/08/2026): Tomás's training call reviews Joana
 * first and there is no curated playbook for her — building one properly
 * needs a human reviewing real transcripts, same as Bens'/Sean's took, and
 * that can't happen in the next few minutes. This sends the real, honest
 * substitute instead: every one of Joana's scored calls, all-time, where
 * an objection issue is indicated (Primary Failure Mode is objection-
 * related, OR blank/'none' — rows scored before that column existed —
 * combined with Flag: Objections Handled = FALSE, so older rows aren't
 * silently excluded), with the AI's own feedback summary for each. Raw
 * material, explicitly labeled as such in the email — NOT a finished
 * playbook with confirmed techniques. Sends once per run; re-running sends
 * again (no dedupe/cooldown — this is a deliberate one-off for today, not
 * a recurring automation).
 */
function sendJoanaRawMaterialToTomas() {
  RUN_TAG = 'sendJoanaRawMaterialToTomas';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var logSheet = resolveSheet_(ss, 'Sales Call Log');
  if (!logSheet) { log_('No Sales Call Log tab found.'); return; }

  var col = getValidatedColumnMap_(logSheet);
  var lastRow = logSheet.getLastRow();
  if (lastRow < 2) { log_('No data rows in Sales Call Log.'); return; }
  var rows = logSheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  var OBJECTION_FAILURE_MODES = ['objections_missed', 'both', 'multiple'];
  var candidates = [];
  rows.forEach(function (row) {
    if (row[col['Rep'] - 1] !== 'Joana') return;
    var mode = String(row[col['Primary Failure Mode'] - 1] || '').trim();
    var objectionsHandled = row[col['Flag: Objections Handled'] - 1];
    var flagged = OBJECTION_FAILURE_MODES.indexOf(mode) !== -1 ||
      ((mode === '' || mode === 'none') && objectionsHandled === false);
    if (!flagged) return;
    var callDate = row[col['Call Date'] - 1];
    candidates.push({
      prospectName: row[col['Prospect Name'] - 1],
      callDate: callDate instanceof Date ? Utilities.formatDate(callDate, CONFIG.BUSINESS_TIMEZONE, 'dd/MM/yyyy') : String(callDate || ''),
      score: row[col['Call Quality Score'] - 1],
      feedback: String(row[col['AI Feedback Summary'] - 1] || '').trim()
    });
  });

  if (!candidates.length) {
    log_('sendJoanaRawMaterialToTomas: no flagged Joana calls found — nothing to send.');
    return;
  }

  var body =
    'Tomás,\n\n' +
    'Ahead of today\'s session — Joana has no curated objection-handling playbook yet (Bens\' and Sean\'s ' +
    'both took a real review of a batch of their transcripts to build; that hasn\'t happened for her). This ' +
    'is the honest substitute for right now: every one of her scored calls, all-time, where an objection ' +
    'issue is flagged, with the AI\'s own feedback for each. RAW DATA, not a finished playbook — you\'ll need ' +
    'to read these live and pull the actual patterns/techniques yourself, the way the Bens/Sean playbooks were ' +
    'originally built.\n\n' +
    candidates.map(function (c, i) {
      return (i + 1) + '. ' + c.prospectName + ' (' + c.callDate + '), score ' + c.score + '\n   ' +
        (c.feedback || '(no AI feedback summary on file)');
    }).join('\n\n') +
    '\n\n— Sent automatically ahead of today\'s training call.';

  guardedSend_(CONFIG.TOMAS_EMAIL, 'Joana — flagged objection calls for today\'s session (raw data)', body, {
    cc: CONFIG.KRIS_EMAIL,
    name: 'Training Prep Bot'
  }, 2);
  log_('sendJoanaRawMaterialToTomas: sent ' + candidates.length + ' flagged call(s) to ' + CONFIG.TOMAS_EMAIL + '.');
}

/**
 * URGENT, on-demand (25/08/2026): a real Google Doc version of the Joana
 * objection playbook (Objection_Handling_Playbook_Joana.md), emailed to
 * Tomás and Kris — same create-a-real-Doc-and-email-it mechanism Phase 6's
 * processTrainingTranscript_ already uses for Training Plan docs
 * (Phase6_TrainingCallReview.gs), just with real headings/bold via
 * DocumentApp instead of that function's plain setText(). Content is
 * hand-transcribed from the .md file this same session wrote — every quote
 * real, drawn from the scoring pipeline's own AI Feedback Summary per call,
 * nothing invented. Re-running creates a new Doc each time (no dedupe —
 * this is a deliberate one-off send, not a recurring automation).
 */
function sendJoanaPlaybookAsGoogleDoc() {
  RUN_TAG = 'sendJoanaPlaybookAsGoogleDoc';
  var doc = DocumentApp.create('Objection Handling Playbook — Joana (v1, 25aug2026)');
  var body = doc.getBody();
  body.setMarginTop(50).setMarginBottom(50).setMarginLeft(60).setMarginRight(60);

  body.appendParagraph('Objection Handling Playbook — Joana').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph('v1 — built 25/08/2026 from every one of Joana\'s scored calls, all-time, flagged for ' +
    'an objection issue (16 real coaching cases). Tomás approves changes here before this is used in training.')
    .setItalic(true);

  var summary = body.appendTable([
    ['#', 'Pattern', 'Seen', 'Worst case'],
    ['1', 'Ends with an opinion question instead of a direct ask', '4 of 16',
      'Heather Gorney — no ask at all, lowest score in the batch'],
    ['2', 'Accepts a stall as final instead of converting it', '5 of 16',
      'Manny Chamizo III — "let\'s move forward" became a link to use "whenever"'],
    ['3', 'Objection surfaced, answered with nothing concrete', '3 of 16',
      'Shannon Driessen — had two tools ready, used neither'],
    ['4', 'No quantified proof point ready when challenged', '3 of 16',
      'Tim Saeland — deferred a client example to "ask my co-founder"']
  ]);
  summary.getRow(0).editAsText().setBold(true);

  body.appendParagraph('Biggest lever: replace every "what do you think?" with a specific, answerable ask. ' +
    'Patterns #1 and #2 together account for 9 of the 16 cases in this batch.').setBold(true);

  var patterns = [
    {
      title: '1. Ends the pitch with an opinion question instead of a direct ask',
      freq: 'seen in 4 of 16 cases',
      examples: [
        ['Will Salinas (05/08)', '"for you and your team, what do you feel that you wanted to go with?"'],
        ['Ryan Welch (05/08)', '"we only have a couple of minutes for you to tell me what do you think about it?"'],
        ['Milton Webster (12/08)', '"But yeah, what do you think?" — minutes after Milton raised launch timelines himself.'],
        ['Heather Gorney (12/08)', '"So tell me, what do you think?" — no direct ask anywhere else in the call.']
      ],
      why: 'An opinion question feels softer than a direct ask, but hands the prospect an easy, non-committal exit instead of a real decision point.',
      technique: 'Every one of these calls had already done the hard work — full pricing walkthrough, real discovery, rapport. The miss is entirely in the last sentence. An either/or or conditional close gives the prospect something concrete to say yes or no to.',
      say: 'Which package do you want to start with — the $897 weekly or the $597 biweekly?',
      note: 'A trial-close question ("does that sound good?") is not a real ask, even when everything before it went well — Failure Mode 1 from the shared rubric.'
    },
    {
      title: '2. Accepts a stall as final instead of converting it into a commitment',
      freq: 'seen in 5 of 16 cases',
      examples: [
        ['Peg Walsh (06/08)', 'Answered "Perfect. Perfect. That\'s great" to "I\'m going to think about it... down the road, I think."'],
        ['Kelli Eggen (11/08)', '"Of course. Of course." — to "not ready to commit yet," despite Kelli calling the $597 biweekly "not bad" minutes earlier.'],
        ['Christina Tokar (13/08)', 'Accepted "if we start this, we\'ll start it in September" and simply booked a September follow-up.'],
        ['Manny Chamizo III (11/08)', 'After "let\'s move forward," sent a booking link to use "whenever" instead of locking a time.'],
        ['Jacqueline Coleman (14/08)', '"It\'s not a no," per Joana\'s own read — but no explicit ask was ever made.']
      ],
      why: 'These are engaged, warm prospects. The miss isn\'t losing the lead — it\'s leaving real momentum open-ended instead of turning it into a dated or conditional commitment while interest is highest.',
      technique: 'In all five calls Joana had already earned a real signal — a timeline, a positive reaction to price, a verbal "let\'s move forward." The fix is one more question that turns the signal into a commitment.',
      say: 'Since September works, shall we get the launch kit done now so your first episode is ready the week you\'re back?',
      note: 'Booking a follow-up is not closing — a follow-up with nothing attached to it is exactly how a warm lead goes cold.'
    },
    {
      title: '3. A real objection gets surfaced but answered with nothing concrete',
      freq: 'seen in 3 of 16 cases',
      // Mark Vincent Fansler (07/08) removed per Tomás's correction
      // (27/08/2026) — Joana says she did not say the quoted line; this
      // example was misattributed and pulled without Joana confirming it,
      // unlike the others here which Tomás has not disputed.
      examples: [
        ['Shannon Driessen (06/08)', '"I really don\'t have the budget for it right now" met with "Perfect, I\'m going to send you these" — despite a sponsor cost-offset and a sub-$500 tier already being on the table earlier in the same call.'],
        ['Douglas Rill (13/08)', 'Raised "money\'s a little bit short" and floated pricing help — the call drifted back to small talk with no answer.'],
        ['Joseph Bradley (20/08)', 'Named the DIY alternative; got "You can, but" — the thought was never finished.']
      ],
      why: 'The objection gets acknowledged, but the concrete tool to resolve it — a number, a mechanism — either isn\'t used even when it\'s already on the table, or genuinely isn\'t ready.',
      technique: 'Never let an acknowledged objection go unanswered. If a resolution already exists, use it the moment the objection lands — not earlier in the call, not never.',
      say: 'Totally hear you on budget — remember the sponsor can offset part of the monthly fee, and there\'s also a lower tier if that\'s a better fit to start. Which of those works better for you?',
      note: 'Overlaps the shared rubric\'s Failure Mode 2 — surfacing the concern is only half the job.'
    },
    {
      title: '4. No quantified proof point ready when capability or results get challenged',
      freq: 'seen in 3 of 16 cases',
      examples: [
        ['Tim Saeland (20/08)', 'Asked for best/worst client examples right after saying it "sounds affordable"; got "I will ask that to my co-founder and I will send you in a bit."'],
        ['Jess Provencher (20/08)', 'Asked what results were realistic while holding low review counts — got a reframe, no quantified result.'],
        ['Jason Pietruszka (12/08)', 'Asked if cross-zip-code sourcing was feasible; got "that\'s totally something we can do, yeah, yeah, for sure" — no evidence, though he still correctly advanced to booking a four-person call with Tomás.']
      ],
      why: 'Legitimate diligence questions from engaged prospects — enthusiasm alone doesn\'t resolve a "prove it" moment, especially when the prospect is already leaning toward yes.',
      technique: 'Walk into every call with one named, quantified client result ready to deliver live. Deferring a proof request loses the moment when the prospect is most receptive.',
      say: 'Actually, [client name] was in a really similar spot — [specific quantified result]. That\'s the kind of outcome we\'re aiming for with you too.',
      note: 'Jason\'s call is the closest to a model answer here — he advanced anyway despite the missed proof point. Pairing that instinct with a real proof point turns a 4 into a 5.'
    }
  ];

  patterns.forEach(function (p) {
    body.appendParagraph(p.title).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    body.appendParagraph(p.freq).setItalic(true);
    body.appendParagraph('Real examples').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    p.examples.forEach(function (ex) {
      var para = body.appendParagraph(ex[0] + ' — ' + ex[1]);
      para.editAsText().setBold(0, ex[0].length - 1, true);
    });
    body.appendParagraph('Why it happens').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    body.appendParagraph(p.why);
    body.appendParagraph('Technique').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    body.appendParagraph(p.technique);
    var sayPara = body.appendParagraph('Say this instead: "' + p.say + '"');
    sayPara.editAsText().setBold(true).setItalic(true);
    body.appendParagraph('Coaching note: ' + p.note).setItalic(true);
  });

  body.appendParagraph('Data quality flag — not a coaching case').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('"Joana\'s Transcriptions" (17/08, score 1) — the transcript is completely empty, no ' +
    'real call to review. Confirm whether a real call happened and the recording was lost, or this was a ' +
    'test/placeholder file. Routed to manual review, not counted above.');

  doc.saveAndClose();
  shareDocWithTrainingTeam_(doc);
  var docUrl = 'https://docs.google.com/document/d/' + doc.getId() + '/edit';

  var emailBody = 'Tomás,\n\nJoana\'s objection-handling playbook, v1 — built from every one of her real ' +
    'flagged calls, all-time (16 cases). Same format as Bens\' and Sean\'s.\n\n' + docUrl +
    '\n\nAhead of today\'s session.';
  guardedSend_(CONFIG.TOMAS_EMAIL, 'Joana — Objection Handling Playbook (v1)', emailBody, {
    cc: CONFIG.KRIS_EMAIL,
    name: 'Training Prep Bot'
  }, 2);
  log_('sendJoanaPlaybookAsGoogleDoc: created ' + docUrl + ' and emailed ' + CONFIG.TOMAS_EMAIL + ' (cc ' +
    CONFIG.KRIS_EMAIL + ').');
}

/** Shared by the Bens/Sean send functions below (Joana's above predates this and isn't worth risking a refactor of already-sent code for). */
function appendObjectionPattern_(body, p) {
  body.appendParagraph(p.title).setHeading(DocumentApp.ParagraphHeading.HEADING2);
  if (p.freq) body.appendParagraph(p.freq).setItalic(true);
  if (p.examples && p.examples.length) {
    body.appendParagraph('Real examples').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    p.examples.forEach(function (ex) {
      var para = body.appendParagraph(ex[0] + ' — ' + ex[1]);
      para.editAsText().setBold(0, ex[0].length - 1, true);
    });
  }
  if (p.why) {
    body.appendParagraph('Why it happens').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    body.appendParagraph(p.why);
  }
  if (p.technique) {
    body.appendParagraph('Technique').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    body.appendParagraph(p.technique);
  }
  if (p.say) {
    body.appendParagraph('Suggested response').setHeading(DocumentApp.ParagraphHeading.HEADING3);
    var sayPara = body.appendParagraph(p.say);
    sayPara.editAsText().setBold(true).setItalic(true);
  }
  if (p.note) body.appendParagraph((p.noteLabel || 'Coaching note') + ': ' + p.note).setItalic(true);
}

/**
 * Real bug found live (25/08/2026, Tomás's own screenshot): DocumentApp.create()
 * makes a Doc owned by, and private to, whatever account ran the script —
 * emailing the link without this meant Tomás hit "Request access" instead
 * of opening it, exactly the "training can't go through" risk he flagged.
 * Grants edit access to Tomás and Kris explicitly before the doc ever gets
 * emailed. Shared by all three playbook-Doc send functions.
 */
function shareDocWithTrainingTeam_(doc) {
  var file = DriveApp.getFileById(doc.getId());
  file.addEditor(CONFIG.TOMAS_EMAIL);
  file.addEditor(CONFIG.KRIS_EMAIL);
}

/** Shared by the Bens/Sean send functions below. */
function sendPlaybookDocEmail_(repLabel, docUrl, caseSummary) {
  var emailBody = 'Tomás,\n\n' + repLabel + '\'s objection-handling playbook, v1 — built from ' + caseSummary +
    '.\n\n' + docUrl + '\n\nAhead of today\'s session.';
  guardedSend_(CONFIG.TOMAS_EMAIL, repLabel + ' — Objection Handling Playbook (v1)', emailBody, {
    cc: CONFIG.KRIS_EMAIL,
    name: 'Training Prep Bot'
  }, 2);
}

/**
 * URGENT, on-demand (25/08/2026): real Google Doc version of Bens' playbook,
 * emailed to Tomás and Kris, same mechanism as sendJoanaPlaybookAsGoogleDoc.
 * Objections #1/#2/#4 use Tomás's OWN edited versions (from his shared
 * PDF/Doc, already patched into the "Objection Playbook" sheet tab via
 * patchObjectionPlaybookBensEdits) rather than the stale original .md text
 * — #2's old scripted response is fully replaced, not appended to, matching
 * that he crossed it out in his own copy. Objections #3/#5-#9 and the "what
 * good already looks like" example are unchanged from Objection_Handling_Playbook.md.
 */
function sendBensPlaybookAsGoogleDoc() {
  RUN_TAG = 'sendBensPlaybookAsGoogleDoc';
  var doc = DocumentApp.create('Objection Handling Playbook — Bens (v1, 25aug2026)');
  var body = doc.getBody();
  body.setMarginTop(50).setMarginBottom(50).setMarginLeft(60).setMarginRight(60);

  body.appendParagraph('Objection Handling Playbook — Bens').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph('v1 — built from the first batch of 43 Bens recordings (May–July 2026), scored ' +
    '17/08/2026. Objections #1/#2/#4 reflect Tomás\'s own live edits. Tomás approves changes here before ' +
    'they\'re used in training.').setItalic(true);

  var summary = body.appendTable([
    ['#', 'Objection', 'Seen', 'Worst case'],
    ['1', '"I\'m too busy / not right now"', '6 of 43', 'David Leventhal, Kade Phillips — lead went cold, no placeholder date secured'],
    ['2', '"What does this cost / how does it work?"', '4 of 43', 'Barinder Maan — asked directly, got no answer at all'],
    ['3', '"That\'s too expensive"', '1 of 43', 'Tennitia Wilson — real cost concern, answered with a vague deflection'],
    ['4', '"I already have my own podcast/platform"', '4 of 43', 'Jeff Goodman, Thom Tillier — direct competing-solution objection, unaddressed'],
    ['5', '"I wouldn\'t know where to start"', '1 of 43', 'Katie Uei — reassured, not answered'],
    ['6', '"I don\'t know this platform — is it legit?"', '1 of 43', 'Phuong Phan — joked past, not addressed'],
    ['7', '"This doesn\'t fit how I run my business"', '2 of 43', 'Rob Bonecutter, Thom Tillier — generic pitch, not tailored'],
    ['8', '"I can tell this is a sales pitch"', '1 of 43', 'Dana Hindman-Allen — highest severity call in the batch'],
    ['9', 'Flat "not interested," no reason given', '1 of 43', 'Carolyn Triebold — no real ask was even made']
  ]);
  summary.getRow(0).editAsText().setBold(true);

  body.appendParagraph('Objection #1 is by far the most common — more than a third of calls had some form ' +
    'of "not now." The single biggest coaching lever: turning "not now" into a scheduled placeholder instead ' +
    'of an open-ended "I\'ll reach out."').setBold(true);

  var patterns = [
    {
      title: '1. "I\'m too busy / not right now"',
      examples: [
        ['Whitney Lohr', '"I don\'t have the capacity for it right now... towards the end of summer"'],
        ['Jim Atkinson', '"I don\'t know if I got time for that"'],
        ['Kade Phillips', '"right now it\'s not really on my radar... working on this Zillow contract"'],
        ['David Leventhal', '"once I get everything off my plate... just not now"'],
        ['Heather Gill', '"I don\'t mind having the conversation... but it\'s not anything I can do right now"'],
        ['Cory Boldroff', '"I have no bandwidth"']
      ],
      why: 'Usually genuine — high-volume producers with real calendar pressure. Sometimes a polite deflection because the value of a 15-minute call hasn\'t been made concrete yet.',
      technique: '1. Acknowledge and empathise — we only work with busy people. 2. Deconstruct what "busy" actually means for them. 3. Let them know the real commitment — average 1h/week (if still pushing back, use the Hormozi line). 4. Pitch the Podcast Strategy Call — understand their plan and see how a podcast fits (if still pushing, agree a follow-up date).',
      say: '"Totally get it — everyone I talk to on this show is busy for a reason. That\'s actually why this is a 15-minute conversation, not a project. Rather than leave it open, let\'s just grab a placeholder for [1-2 days out] — if it\'s still not the right moment when we get there, we\'ll push it again, no pressure at all."',
      note: 'If the prospect still declines a specific placeholder after this, that\'s a real "not now" — accept it, but never accept the first "not now" as final without one attempt to convert it into a date.'
    },
    {
      title: '2. "What does this cost / how does monetization actually work?"',
      examples: [
        ['Barinder Maan', '"How do you guys monetize it on a money basis?... who controls it, what is the monetary fees attached to it?" — got no answer'],
        ['Michelle Reifel', '"would you be sending a marketing budget?"'],
        ['Gary Lanham', '"Is there a way to monetize that?"'],
        ['Dana Hindman-Allen', '"send me a price breakdown... before I take people\'s time"']
      ],
      why: 'Legitimate diligence — experienced business owners want to know roughly what they\'re being asked to invest before booking a second call.',
      technique: 'Directional answer, not a full punt. Fully deferring every pricing question to Tomás reads as evasive to a sharp prospect.',
      say: '- Accept and joke about the price question — "I\'m not taking your money today," or go straight into: "As much as I would like to tell you pricing right now, and you would probably want to pay me and get started…" - Clarify we like to show the value first before the $, so they can see the impact. - Our network manager will do that and show you the investment. - I promise it\'s not something that is going to scare you. - Book Strategy Call.',
      noteLabel: 'Note', note: 'Tomás replaced the old scripted quote here entirely — this is the current, live version.'
    },
    {
      title: '3. "That\'s too expensive"',
      // Dana Hindman-Allen removed per Tomás's correction (27/08/2026) — her
      // call never reacted to a stated price as too high; "wanted pricing
      // before committing more time" is the monetization-question objection
      // (#2), not this one. See objectionPlaybookSeedRows_ for the same fix.
      examples: [
        ['Tennitia Wilson', '"the costs were prohibitive... more than my car note and insurance put together... in sales you don\'t have a pension or 401k, to commit to that dollar amount I\'d be real brazen"']
      ],
      why: 'Real budget sensitivity, especially for 1099 commission-only agents without steady income or benefits.',
      technique: 'Acknowledge, then quantify. Never acknowledge-then-deflect. Tennitia\'s call is the textbook example of what NOT to do: "maybe we can offer you something that fits" with no actual number.',
      say: '"That\'s fair, and I\'d rather you know the real number now than find out later. For context, [X] is roughly the cost of [one small piece of marketing spend / a fraction of a single commission check], and agents in your market have seen [concrete result]. If that math doesn\'t work for you, no hard feelings — but let\'s at least get you real numbers from Tomás before deciding either way."'
    },
    {
      title: '4. "I already have my own podcast / marketing company / platform"',
      examples: [
        ['Jeff Goodman', 'hosted his own 130-episode podcast'],
        ['Bill Gross', '"I\'m pretty satisfied with what I\'m doing now, the system kind of works for me"'],
        ['Thom Tillier', '"I\'m looking to create an unedited podcast because I don\'t have time for editing, nor do I want to pay for editing"'],
        ['Steve Houck', 'already pays a marketing company for video/editing — never raised but a near-certain future objection']
      ],
      why: 'Successful producers often already run some content operation and don\'t immediately see the incremental value of a second one.',
      technique: 'Don\'t compete with what they have; position as removing a cost from it.',
      say: 'If the podcast is no longer active: mention it before they do, ask how the experience was, ask why it stopped, offer to revive it and book a Strategy Call. If the podcast is active: "Awesome! How is it going? Have you gotten some results from it? Are you producing this in-house or working with another agency?" — offer the Strategy Call as a free brainstorming session with the #1 Real Estate Podcast Network. Then: "That\'s great that you\'re already doing [X] — a lot of the agents we work with are in the same spot. The difference usually isn\'t replacing what you\'re doing, it\'s taking [the specific pain point they mentioned] off your plate so you can focus on [their actual business]. Worth 15 minutes to see if that gap applies to you?"'
    },
    {
      title: '5. "I wouldn\'t know where to start / what if I\'m not good at this"',
      examples: [['Katie Uei', '"I would not have any idea where to start... what if I run out of topics? Maybe I\'m boring or something"']],
      why: 'Podcasting is unfamiliar territory; the prospect doubts they have enough "content" in them.',
      technique: 'Concrete process proof, not cheerleading. Bens\'s actual response here was pure reassurance, which doesn\'t resolve a capability doubt.',
      say: '"That\'s the number one thing people worry about, which is exactly why we don\'t leave it to you — we supply the questions, the structure, even topic ideas based on what\'s working in your market. You just talk about your business the way you already do with clients every day."'
    },
    {
      title: '6. "I don\'t know this platform — is this legit?"',
      examples: [['Phuong Phan', '"all the services I have heard of, but Riverside is something I have not heard... I was skeptical, I\'m like who are you... I don\'t want to trap in something I don\'t know"']],
      why: 'An unfamiliar brand or tool name triggers real skepticism, especially on a cold-approached call.',
      technique: 'Never joke past a trust objection. Bens\'s actual response was humor, which reads as more evasive, not less.',
      say: '"Totally fair to be cautious — here\'s [company website/LinkedIn], and here are a couple of agents in a similar market you\'re welcome to look up, or even reach out to directly, before you commit any more time."'
    },
    {
      title: '7. "This doesn\'t fit how I actually run my business"',
      examples: [
        ['Rob Bonecutter', 'stated near-term goal was "bringing more agents into the company... through social media," i.e. recruiting, not personal brand growth'],
        ['Thom Tillier', 'specifically wants unedited content with no paid editing — a direct mismatch with what ICONS sells']
      ],
      why: 'The generic "content and authority" pitch doesn\'t map to what the prospect actually said their #1 priority is.',
      technique: 'Ask their current #1 growth lever before pitching, then tailor to it. Rob\'s call is the best partial example of this being done right.',
      say: '"You mentioned your focus right now is more on [recruiting / their stated priority] than personal brand — that makes sense. A lot of our partners actually use the podcast that way too: [a concrete example tied to their stated goal]. Want me to have Tomás speak specifically to that angle instead of the general pitch?"'
    },
    {
      title: '8. "I can tell this is a sales pitch"',
      examples: [['Dana Hindman-Allen', 'highest-severity call in the whole batch — "I knew you were selling me on a podcast. I knew you were the whole time... pretty sharp hooking right here."']],
      why: 'A savvy, high-profile prospect recognizes the interview-into-upsell structure and names it directly, testing whether Bens will be straight with her.',
      technique: 'Own it plainly, don\'t get defensive or laugh it off. Bens\'s actual response ("well, good for you") did neither.',
      say: '"You got me — yeah, this interview is genuinely great content for you either way, and if it\'s a fit, there\'s a paid option on top of it. I\'d rather be upfront about that than pretend otherwise. Want the two-minute version of what that actually is? No pressure either way."'
    },
    {
      title: '9. Flat "not interested," no reason given',
      examples: [['Carolyn Triebold', 'Bens never actually made the real ask here (only a soft "haven\'t you thought about social media" trial-close question), and when she said "not something I\'m interested in," he accepted it and moved to wrap up.']],
      why: 'Sometimes a genuine no; sometimes a reflexive deflection to a soft, opinion-style question rather than a real, direct ask.',
      technique: 'Probe once, and always make the actual ask. A trial-close question isn\'t a real ask.',
      say: '"No worries at all — can I ask, is it more that podcasting itself isn\'t your thing, or just not a priority right now? [listen for the real reason] Either way, would you be open to a quick, no-pressure look at what it actually involves, just so you have the full picture for later?"'
    }
  ];
  patterns.forEach(function (p) { appendObjectionPattern_(body, p); });

  body.appendParagraph('What good already looks like').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('Ben Sweet, 2026-07-02 — the model answer in this entire batch. When Ben asked ' +
    'directly, "Do you have anyone on there that are your current customers that are just really blown up as ' +
    'a result of your podcasting?", Bens gave a specific, quantified case study: a client who was stuck at ' +
    '$10M in production for years, used her podcast episode to help land a 330-house land development deal. ' +
    'That\'s the standard every other objection response above should be trained toward.');

  doc.saveAndClose();
  shareDocWithTrainingTeam_(doc);
  var docUrl = 'https://docs.google.com/document/d/' + doc.getId() + '/edit';
  sendPlaybookDocEmail_('Bens', docUrl, 'the first batch of 43 real recordings, with Tomás\'s own latest edits on #1/#2/#4');
  log_('sendBensPlaybookAsGoogleDoc: created ' + docUrl + ' and emailed ' + CONFIG.TOMAS_EMAIL + ' (cc ' +
    CONFIG.KRIS_EMAIL + ').');
}

/**
 * URGENT, on-demand (25/08/2026): real Google Doc version of Sean's
 * playbook, emailed to Tomás and Kris, same mechanism as the Bens/Joana
 * versions above. Content unchanged from Objection_Handling_Playbook_Sean.md
 * (v1 + v2 batches, 27 real calls) — includes the cross-cutting patterns
 * and "what good looks like" sections, not just the 10 numbered objections.
 */
function sendSeanPlaybookAsGoogleDoc() {
  RUN_TAG = 'sendSeanPlaybookAsGoogleDoc';
  var doc = DocumentApp.create('Objection Handling Playbook — Sean (v1+v2, 25aug2026)');
  var body = doc.getBody();
  body.setMarginTop(50).setMarginBottom(50).setMarginLeft(60).setMarginRight(60);

  body.appendParagraph('Objection Handling Playbook — Sean').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph('v1 (12 calls) + v2 (15 more calls, 18/08/2026) — 27 real calls total. Tomás approves ' +
    'changes here before they\'re used in training.').setItalic(true);

  var summary = body.appendTable([
    ['#', 'Objection', 'Seen', 'Worst case'],
    ['1', 'Budget / needs money freed up first', '7 of 12', 'Roxy Miles — raised twice, never resolved, the one call where even the fallback (2nd call w/ Tomás) failed'],
    ['2', 'Needs a third party\'s approval', '5 of 12', 'Elijah Castelli Pt.1 — surfaced only at the very close, no plan'],
    ['3', 'Timing / wants to think it over', '5 of 12', 'Nicole Beauchamp Pt.2 — accepted the stall, pivoted to booking Tomás without finding out what she needed to think about'],
    ['4', 'ROI / proof / metrics skepticism', '2 of 12', 'Kodie Smiley — rep didn\'t know his own product\'s metrics, punted to the next call'],
    ['5', 'Content or personal-brand fit concern', '3 of 12', 'Marcus Jackson — "it\'ll be very smooth" with no example'],
    ['6', 'Compliance / regulatory concern', '1 of 12', 'Lei McDonald Pt.2 — mortgage-broker sponsorship question dropped entirely'],
    ['7', 'Minor pricing friction (a fee, not the core price)', '1 of 12', 'Elijah Castelli Pt.2 — deflected rather than answered plainly'],
    ['8', 'Scheduling / logistics request', '1 of 12', 'Steve Robe — the one objection in this batch Sean handled well'],
    ['9', 'Comparing against a competitor', 'v2', 'Deme Mekras — actively comparing to a competing service'],
    ['10', 'Trust / a prior bad experience with a similar vendor', 'v2', 'Bently Perry — a $25k horror story went unanswered']
  ]);
  summary.getRow(0).editAsText().setBold(true);

  body.appendParagraph('The single biggest coaching lever in this batch: objections_overcome and ' +
    'discovery_adequate were BOTH false in all 12 of 12 v1 calls, with no exceptions — including the one ' +
    'call that closed. Every objection got surfaced; none got answered with something concrete and ' +
    'lead-specific.').setBold(true);

  var patterns = [
    {
      title: '1. Budget / needs money freed up first',
      examples: [
        ['William Schlunaker', '"$300 a month for nothing" on one failed vendor'],
        ['Roxy Miles', '"it really depends on like the investment, like long-term" — raised twice'],
        ['Teresa Anderson (v2)', 'most severe case: "my husband\'s stage four... cancer... each treatment costs me $25,000"']
      ],
      why: 'Real estate agents are largely 1099 commission-only — cash flow is genuinely lumpy.',
      technique: 'Get the real number before discounting. In every one of these calls Sean\'s response was a discount or a generic anecdote — never the lead\'s own numbers.',
      say: '"What\'s the number one thing you\'re doing for marketing right now, and roughly what does that cost you a month? [...] So you\'re already spending $X on that — this replaces or stacks on top of it, and here\'s what it\'s produced for someone in a similar spot: [matching case study]. One closing pays for a year or more of this."'
    },
    {
      title: '2. Needs a third party\'s approval (partner, spouse, coach, investor)',
      examples: [
        ['Elijah Castelli Pt.1', '"I want to make sure that I got Lindsay\'s approval on it... there\'ll be a little bit of a fight on it"'],
        ['Teresa Anderson (v2)', '"I cannot make the decision on my own until I talk to him" — correctly routed to a locked-in Tomás call']
      ],
      why: 'Many of these leads run their business jointly — the purchase decision genuinely isn\'t theirs alone.',
      technique: 'Ask who else is involved before pitching, not after the close attempt. Steve Robe\'s call is the model: Sean proactively invited the coach onto the next call.',
      say: '"Who else needs to be comfortable with this before you move forward?" — asked during discovery. Once known: loop them into this call or a quick follow-up, and lock a specific date/time before ending the call.'
    },
    {
      title: '3. Timing / wants to think it over',
      examples: [
        ['Parisa Daily', '"I just want to take some time to mull it over" — Sean asked the right diagnostic question here: the model to copy'],
        ['Julio Lopez (v2, repeat offender)', 'same unresolved stall on a follow-up call weeks later, "I need to check on the... programs" — never asked what programs']
      ],
      why: 'Sometimes a genuine need for more information; sometimes a polite way of not naming the real objection.',
      technique: 'Isolate before accepting — don\'t take "let me think about it" at face value.',
      say: '"What specifically do you need to think through — is it the investment, the timing, or something about how this works?" Answer that thing concretely, then lock a specific day/time before hanging up.',
      note: 'When the same isolation question fails twice with the same lead, change the approach entirely on attempt three, not repeat it a third time.'
    },
    {
      title: '4. ROI / proof / metrics skepticism',
      examples: [['Kodie Smiley', '"any... averages of subscribers... metrics?" — answered "Tomas will be able to show you on our next Zoom"']],
      why: 'A reasonable, sophisticated question from a lead deciding whether the mechanism actually works.',
      technique: 'Know the real numbers cold; don\'t punt to Tomás. Deferring reads as not knowing your own product.',
      say: '"89% of clients see results in the very first month, and our renewal rate is 92% — here\'s a specific example close to your situation: [case study]."'
    },
    {
      title: '5. Content or personal-brand fit concern',
      examples: [
        ['Marcus Jackson', 'mixing existing home-tour content with new educational content — "it\'ll be very smooth," no example'],
        ['Lei McDonald Pt.2', 'this one Sean handled well, with a real number: ~$50 for a mic, lighting, and a camera']
      ],
      why: 'Established agents already have a content style and audience expectation.',
      technique: 'Get specific, not reassuring — use the Lei McDonald answer as the template.',
      say: 'For brand fit: "[Name] kept full script review and creative control the whole way through — here\'s exactly how that worked." For content mixing: describe the actual production workflow step.'
    },
    {
      title: '6. Compliance / regulatory concern',
      examples: [['Lei McDonald Pt.2', '"I think that mortgage brokers are not allowed to do that... They cannot pay" — Sean: "I\'m not particularly sure of the rules" and dropped it']],
      why: 'A legitimate regulatory concern, not a stall.',
      technique: 'Never leave a compliance question unanswered on the call. If you don\'t know, commit to a real deadline.',
      say: '"That\'s a fair question I want to get exactly right for you rather than guess — let me get our compliance answer and have it back to you by [specific day], and let\'s put 15 minutes on the calendar then to close the loop."'
    },
    {
      title: '7. Minor pricing friction (a fee, not the core price)',
      examples: [['Elijah Castelli Pt.2', 'Lindsay: "Friday, man. That hurts, that $76" — Sean: "we can\'t get around it... it\'s not that much"']],
      why: 'A small line-item that stands out because it appears right at the moment of payment.',
      technique: 'State it as a fact with a number, not an apology.',
      say: '"That\'s the standard card processing rate, not a markup we\'re adding — and once your first sponsor comes on, it\'s a rounding error against what they\'re covering."'
    },
    {
      title: '8. Scheduling / logistics request',
      examples: [['Steve Robe', 'wanted to batch-record several episodes around his travel schedule']],
      why: 'A practical planning need, not resistance.',
      technique: 'This is the one objection in the batch that needs no fix — it\'s the standard the rest of this playbook is aiming for: specific mechanism, not vague reassurance.',
      say: '"Tell our team \'I want to do four podcasts on Wednesday,\' and you do them back to back" — plus the Riverside remote-recording app.'
    },
    {
      title: '9. Comparing against a competitor / wants to shop around (v2)',
      examples: [['Deme Mekras (4/27)', '"I actually just heard the ad, frankly, on Friday" (a competing service) — still needs to compare before deciding']],
      why: 'A sophisticated, already-warm lead doing real due diligence, not a brush-off.',
      technique: 'Get the specific competitor and answer with real numbers, not superiority claims. Never claim to already know you\'re better than something you haven\'t looked at.',
      say: '"Which one — I want to actually look at what they offer so I\'m comparing apples to apples, not just telling you we\'re better." Then use real numbers already in hand against the specific thing they heard, and re-ask for the close.'
    },
    {
      title: '10. Trust / a prior bad experience with a similar vendor (v2)',
      examples: [['Bently Perry', '(lead\'s mother, who was paying) "My mom got billed $25,000. They did nothing." — Sean said nothing in response']],
      why: 'A rational fear from someone who\'s been burned before, not a stall.',
      technique: 'Never let a "we got burned before" story pass without a direct response. A contract\'s existence isn\'t the answer to a fear about accountability.',
      say: '"I hear why that\'s scary — here\'s exactly what makes this different: [specific guarantee/check-in mechanism], and here\'s someone who had that same worry before working with us: [case study]."'
    }
  ];
  patterns.forEach(function (p) { appendObjectionPattern_(body, p); });

  body.appendParagraph('Cross-cutting patterns (v2 — bigger than any single objection type)').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('A. Almost never asks the lead to state their own numeric goal.').setBold(true);
  body.appendParagraph('Seven v2 calls show the same gap: Sean pitches generic value without ever asking the ' +
    'lead to name a number. Add as a required discovery question, before the pitch: "What\'s your production ' +
    'goal for this year — a number, not a feeling?"');
  body.appendParagraph('B. Gets partial progress, then stops pushing instead of locking down the rest.').setBold(true);
  body.appendParagraph('Ward Frederick and Bently Perry both show this: Sean secures something, then folds — ' +
    'no smaller ask, no second call with Tomás for the remaining decision. Drill: once there\'s a partial ' +
    'yes, the next sentence should ask for a smaller concrete commitment or a specific Tomás booking — never ' +
    '"no worries, talk soon."');
  body.appendParagraph('C. A good score can hide zero live skill.').setBold(true);
  body.appendParagraph('Dertrez Pressley closed cleanly with no objection raised at all — the lead arrived ' +
    'already decided. Don\'t hold an easy, pre-sold win up as an example of good process — it teaches nothing ' +
    'about how Sean handles a harder lead.');

  body.appendParagraph('What good already looks like').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('Deme Mekras, 5/1 (v2) — a clean, model close, top score of the whole project so far. ' +
    'The one real objection (a pricing discrepancy) got a concrete, honest resolution, the close ask was ' +
    'direct and led to an actual $1,899 charge, and the pitch was tied to specifics of his own business ' +
    'rather than anything generic. Every "what good looks like" moment in this batch used a real number, a ' +
    'named example, or a specific mechanism — exactly what was missing everywhere else.');

  doc.saveAndClose();
  shareDocWithTrainingTeam_(doc);
  var docUrl = 'https://docs.google.com/document/d/' + doc.getId() + '/edit';
  sendPlaybookDocEmail_('Sean', docUrl, '27 real calls across two batches (v1 + v2)');
  log_('sendSeanPlaybookAsGoogleDoc: created ' + docUrl + ' and emailed ' + CONFIG.TOMAS_EMAIL + ' (cc ' +
    CONFIG.KRIS_EMAIL + ').');
}

/**
 * URGENT, on-demand (25/08/2026): dashboard access instructions + a plain
 * brief on what the dashboard is, emailed to every rep (CONFIG.REPS) plus
 * Tomás, Kris cc'd on each. Kris has just invited all four to the
 * Tailscale network; this is the follow-up telling them what to do once
 * they're connected. DASHBOARD_URL is hardcoded to the real Tailscale
 * MagicDNS hostname Kris confirmed live — update here if that ever
 * changes (e.g. Tailscale Funnel/Serve reconfigured, VPS rebuilt).
 */
var DASHBOARD_URL_ = 'https://vps-b3e68291.tail9f0adb.ts.net/';

function sendDashboardAccessEmail() {
  RUN_TAG = 'sendDashboardAccessEmail';
  var recipients = CONFIG.REPS.map(function (r) { return { name: r.name, email: r.email }; });
  recipients.push({ name: 'Tomás', email: CONFIG.TOMAS_EMAIL });

  var brief =
    'What the dashboard is: a read-only window into the Sales Call Log -- the same data Phase 2\'s AI ' +
    'scoring already writes to the spreadsheet, just easier to see trends in than scrolling a sheet. ' +
    'Nobody edits anything here; it\'s for looking, not logging.\n\n' +
    'What\'s on it:\n' +
    '- Overview -- team-wide call volume, average scores, and where outcomes/framework explanations are ' +
    'or aren\'t being logged.\n' +
    '- Each rep\'s own page (yours is ' + DASHBOARD_URL_ + 'reps/<your name>) -- your scored calls, score ' +
    'trend over time, week-by-week scorecard history, and your own objection-handling playbook.\n' +
    '- Training -- daily practice status, and search across every rep\'s playbook.\n' +
    '- Review queue -- calls flagged for a second look.\n' +
    '- Calls -- every scored call, filterable and searchable.';

  recipients.forEach(function (r) {
    var body =
      'Hi ' + r.name + ',\n\n' +
      'You\'re on the team\'s Tailscale network now. Two steps left to see the dashboard:\n\n' +
      '1. If you haven\'t already, install Tailscale and sign in (check your email for the invite) -- ' +
      'https://tailscale.com/download\n' +
      '2. Once connected, go to ' + DASHBOARD_URL_ + ' and sign in with your @iconsofrealestate.com ' +
      'Google account.\n\n' +
      'If the page won\'t load, make sure Tailscale shows "Connected" (not just installed) -- that\'s the ' +
      'most common snag. If you get an "access denied" page after signing in, let Kris know.\n\n' +
      brief +
      '\n\n-- Sent automatically.';
    guardedSend_(r.email, 'Dashboard access — what to do next', body, {
      cc: CONFIG.KRIS_EMAIL,
      name: 'Training Prep Bot'
    }, 2);
  });
  log_('sendDashboardAccessEmail: sent to ' + recipients.map(function (r) { return r.email; }).join(', ') +
    ' (cc ' + CONFIG.KRIS_EMAIL + ' on each).');
}

// ---------------------------------------------------------------------------
// Weekly Playbook Review — Kris's ask (25/08/2026): sendBensPlaybookAsGoogleDoc/
// sendSeanPlaybookAsGoogleDoc/sendJoanaPlaybookAsGoogleDoc above each did a
// one-off, all-time sweep of every flagged call in history — that's now done.
//
// Going forward, per Kris's explicit follow-up (27/08/2026): each week's
// training material must be scoped to ONLY the previous week's calls —
// never a running "since last review" window, and never a fallback to the
// old all-time playbook. Reps who've already been trained on an issue
// should not have it resurface in a later week's session just because
// nothing new happened to come up since whenever this last ran. So this
// uses the exact same "most recently completed Mon-Sun week" window
// (getWeekBounds_, Phase5_WeeklyScorecard.gs) the weekly scorecard already
// uses — stateless, no watermark, no history to accidentally re-surface. A
// week with nothing flagged is reported as exactly that (nothing to train
// on this week for objections), not redirected back to old material.
//
// ONE-TIME SETUP:
//   1. Run previewWeeklyPlaybookReview() from the Apps Script editor (NOT the
//      trailing-underscore version — the "Select function" dropdown hides
//      those). It logs, per rep, how many calls were flagged last week —
//      nothing is sent. Check the numbers look sane.
//   2. Flip PLAYBOOK_REVIEW_CONFIG.ENABLED to true and run
//      installPlaybookReviewTrigger().
// ---------------------------------------------------------------------------

var PLAYBOOK_REVIEW_CONFIG = {
  ENABLED: true, // Flipped true 27/08/2026 per Kris's ask — last-week-only training material, no all-time fallback. Still needs installPlaybookReviewTrigger() run once to actually schedule it.
  TRIGGER_HOUR: 8 // Tuesday morning, CONFIG.BUSINESS_TIMEZONE — ahead of that day's training session
};

/**
 * The four elements Kris named (03/09/2026) as the ones every rep is graded
 * on every week, with the weakest becoming that week's training focus:
 *
 *   "The 4 main elements are 1. Discovery (QC does this too) 2. Framework
 *    (only sales call) 3. Ask for the money (ask for the booking on QC)
 *    4. Objection handling. All 4 need to be graded and the highest priority
 *    trained each week."
 *
 * Each maps to the sheet column its judged flag already lands in. Two of the
 * four carry a companion "Gaps" column naming WHICH sub-piece failed (which
 * of the three framework legs, which part of discovery) — real coaching
 * detail worth putting in front of Tomás, not just a red flag.
 *
 * Note what each element MEANS is already role-aware upstream, so nothing
 * here needs a per-rep special case: "Asked For Close" is redefined by Bens'
 * and the QC rubric as asking for the BOOKING rather than the money (see
 * buildBensJudgeSystemPrompt_'s header in Phase2_CallScoring.gs), and
 * framework is deliberately never scored on a QC call — which is exactly why
 * a blank flag has to mean "no signal" rather than a failure below.
 */
var TRAINING_PRIORITY_ELEMENTS_ = [
  { key: 'discovery', label: 'Discovery', column: 'Flag: Discovery Adequate', gapsColumn: 'Discovery Gaps' },
  { key: 'framework', label: 'Framework explanation', column: 'Flag: Framework Explained', gapsColumn: 'Framework Gaps' },
  { key: 'ask', label: 'Asking for the money / the booking', column: 'Flag: Asked For Close', gapsColumn: null },
  { key: 'objections', label: 'Objection handling', column: 'Flag: Objections Handled', gapsColumn: null }
];

/**
 * Reads one Sales Call Log row into the four-element shape
 * rankTrainingPriorities_ works on. A cell that isn't an actual boolean is
 * "no signal" (null) — NOT a pass and NOT a failure. Three separate things
 * produce a blank here and none of them is a rep failing anything: a row
 * scored before that column existed, a dimension the rubric variant
 * legitimately doesn't score (framework on a QC call), and a parse failure
 * that never produced flags. Counting any of those as a failure would put a
 * whole week's training on an element nobody actually got graded on.
 */
function trainingElementFlagsForRow_(row, col) {
  var flags = {};
  var gaps = {};
  TRAINING_PRIORITY_ELEMENTS_.forEach(function (el) {
    var raw = row[col[el.column] - 1];
    flags[el.key] = (raw === true || raw === false) ? raw : null;
    gaps[el.key] = el.gapsColumn ? String(row[col[el.gapsColumn] - 1] || '').trim() : '';
  });
  return { flags: flags, gaps: gaps };
}

/**
 * Ranks the four elements worst-first for one rep's week. Pure — takes the
 * already-read calls, does no I/O of its own.
 *
 * Priority is the NUMBER OF CALLS that failed the element, per Kris's ask:
 * one bad call is noise, the same failure across several calls is the real
 * skill gap. Ties break toward the element whose failing calls scored worse,
 * so "failed 2 calls at score 1-2" outranks "failed 2 calls at score 4".
 *
 * `scored` is reported alongside `failed` because the two have different
 * denominators by design — framework isn't scored on QC calls at all — so
 * "2 of 3" and "2 of 8" must stay distinguishable rather than both reading
 * as a bare "2".
 */
function rankTrainingPriorities_(calls) {
  return TRAINING_PRIORITY_ELEMENTS_.map(function (el) {
    var scored = calls.filter(function (c) { return c.flags[el.key] === true || c.flags[el.key] === false; });
    var failedCalls = scored.filter(function (c) { return c.flags[el.key] === false; });
    var avgFailedScore = failedCalls.length
      ? failedCalls.reduce(function (sum, c) { return sum + (Number(c.score) || 0); }, 0) / failedCalls.length
      : null;
    return {
      key: el.key,
      label: el.label,
      scored: scored.length,
      failed: failedCalls.length,
      failedCalls: failedCalls,
      avgFailedScore: avgFailedScore
    };
  }).sort(function (a, b) {
    if (b.failed !== a.failed) return b.failed - a.failed;
    if (a.avgFailedScore === null && b.avgFailedScore === null) return 0;
    if (a.avgFailedScore === null) return 1;
    if (b.avgFailedScore === null) return -1;
    return a.avgFailedScore - b.avgFailedScore;
  });
}

/**
 * Strips every "/yyyy" year suffix out of a "dd/MM/yyyy - dd/MM/yyyy"-style
 * label, for a subject line where the year is redundant noise (per Kris,
 * 02/09/2026). Pure/testable; leaves anything that doesn't look like a
 * 4-digit year alone rather than mangling an unexpected label shape.
 */
function stripYearFromDateRangeLabel_(label) {
  return String(label).replace(/\/\d{4}\b/g, '');
}

/** Run this FIRST from the editor. Builds this week's review and only logs it — sends nothing. */
function previewWeeklyPlaybookReview() {
  return previewWeeklyPlaybookReview_();
}

function previewWeeklyPlaybookReview_() {
  RUN_TAG = 'previewWeeklyPlaybookReview_';
  log_('PREVIEW MODE — building this week\'s playbook review, nothing will be sent.');
  buildAndMaybeSendPlaybookReview_(/*forcePreview=*/true);
}

/** Trigger target. Gated by PLAYBOOK_REVIEW_CONFIG.ENABLED as a second safety net. */
function runWeeklyPlaybookReview() {
  RUN_TAG = 'runWeeklyPlaybookReview';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runWeeklyPlaybookReview: another run holds the lock, skipping this firing.');
    return;
  }
  try {
    buildAndMaybeSendPlaybookReview_(/*forcePreview=*/false);
  } finally {
    lock.releaseLock();
  }
}

function buildAndMaybeSendPlaybookReview_(forcePreview) {
  if (!forcePreview && !PLAYBOOK_REVIEW_CONFIG.ENABLED) {
    log_('buildAndMaybeSendPlaybookReview_: PLAYBOOK_REVIEW_CONFIG.ENABLED is false, skipping.');
    return;
  }

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var logSheet = resolveSheet_(ss, 'Sales Call Log');
  if (!logSheet) { log_('buildAndMaybeSendPlaybookReview_: no Sales Call Log tab found.'); return; }

  var col = getValidatedColumnMap_(logSheet);
  var lastRow = logSheet.getLastRow();
  var rows = lastRow < 2 ? [] : logSheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();
  var tz = CONFIG.BUSINESS_TIMEZONE;
  // Strictly the most recently completed Mon-Sun week (same window
  // getWeekBounds_ gives the weekly scorecard) — not a running watermark.
  // Per Kris's explicit ask (27/08/2026): a rep who's already been trained
  // on an issue should never see it resurface in a later week's session
  // just because a run got skipped or nothing new happened to come up since
  // then. Every week only ever looks at that one week, full stop.
  var week = getWeekBounds_(new Date(), tz);
  var windowLabel = Utilities.formatDate(week.start, tz, 'dd/MM/yyyy') + ' - ' +
    Utilities.formatDate(shiftBusinessDate_(week.end, tz, -1), tz, 'dd/MM/yyyy');

  CONFIG.REPS.forEach(function (repCfg) {
    // Every one of the rep's calls last week, not just the objection-flagged
    // ones this used to filter down to — all four elements get graded, then
    // the worst becomes the week's focus (Kris, 03/09/2026).
    var calls = [];
    rows.forEach(function (row, i) {
      if (String(row[col['Rep'] - 1] || '').trim().toLowerCase() !== repCfg.name.toLowerCase()) return;
      var callDate = row[col['Call Date'] - 1];
      if (!(callDate instanceof Date) || callDate < week.start || callDate >= week.end) return;
      var judged = trainingElementFlagsForRow_(row, col);
      // Kris's ask (02/09/2026), same as sendRandomCalibrationDigest_'s own
      // fix (29/08/2026): "if you want calls reviewed, add the links" —
      // straight to the call's Transcript URL (the thing being judged) and
      // its Sales Call Log row (where Tomás's session notes get typed in).
      calls.push({
        prospectName: row[col['Prospect Name'] - 1],
        callDate: Utilities.formatDate(callDate, tz, 'dd/MM/yyyy'),
        score: row[col['Call Quality Score'] - 1],
        feedback: String(row[col['AI Feedback Summary'] - 1] || '').trim(),
        transcriptUrl: String(row[col['Transcript URL'] - 1] || '').trim(),
        rowLink: salesCallLogRowLink_(logSheet, i + 2),
        flags: judged.flags,
        gaps: judged.gaps
      });
    });

    var ranking = rankTrainingPriorities_(calls);
    var focus = ranking[0];
    var flagged = (focus && focus.failed) ? focus.failedCalls : [];

    if (forcePreview) {
      log_('previewWeeklyPlaybookReview_: ' + repCfg.name + ' - ' + calls.length + ' call(s) last week (' +
        windowLabel + '). Priority: ' + ranking.map(function (r) {
          return r.label + ' ' + r.failed + '/' + r.scored;
        }).join(', ') + '.');
      return;
    }

    var sent = flagged.length
      ? sendPlaybookReviewNewMaterialEmail_(repCfg, flagged, windowLabel, ranking)
      : sendPlaybookReviewNoNewCallsEmail_(repCfg, windowLabel);
    if (!sent) {
      log_('buildAndMaybeSendPlaybookReview_: ' + repCfg.name + ' send failed/skipped for the week of ' +
        windowLabel + '.');
      return;
    }
    log_('buildAndMaybeSendPlaybookReview_: ' + repCfg.name + ' - focus "' + focus.label + '" (' +
      focus.failed + '/' + focus.scored + ' call(s)) for the week of ' + windowLabel + '.');
  });
}

/**
 * Pure content builder — testable without guardedSend_/GAS, same "build the
 * data, send it separately" split already used for the Daily Practice/
 * Weekly Scorecard/Training Review emails elsewhere in this project.
 *
 * Kris's ask (02/09/2026): "No colour, no bold, no italic, big blocks of
 * text" — same "for the record, styled" treatment already given to the
 * Handoff Brief, Weekly Scorecard, and Practice Drill Feedback emails.
 * escapeHtml_ (Phase4_InboxSLA.gs) guards every dynamic field since this is
 * raw HTML, not Jinja. dailyPracticeScoreColor_ (Phase7_DailySelfPractice.gs)
 * reused so a score is colored the same way everywhere in the system,
 * rather than inventing a second color rubric here.
 */
function buildPlaybookReviewNewMaterialEmail_(repCfg, flagged, windowLabel, ranking) {
  // Kris's ask (02/09/2026): "don't need the year in the subject — we know
  // what year it is." Only the subject drops it; the body keeps the full
  // dd/MM/yyyy dates, same as every other email in this system.
  var focus = (ranking && ranking.length) ? ranking[0] : null;
  var focusLabel = focus ? focus.label : 'Objection handling';
  var subject = repCfg.name + ' — ' + focusLabel.toLowerCase() + ' is this week\'s focus (' +
    stripYearFromDateRangeLabel_(windowLabel) + ')';

  // The full four-element standing, so the pick is visible rather than
  // asserted — Tomás can see that e.g. discovery failed 3 of 5 while the
  // money-ask failed 1 of 5, and why the session is going where it is.
  // An element nobody was graded on last week (scored 0) is shown as such
  // rather than as a clean pass it didn't earn.
  var rankingLines = (ranking || []).map(function (r) {
    if (!r.scored) return '  - ' + r.label + ': not graded on any call last week';
    return '  - ' + r.label + ': failed ' + r.failed + ' of ' + r.scored + ' graded call(s)';
  });
  var rankingHtml = (ranking || []).map(function (r, i) {
    var text = r.scored
      ? 'failed <strong>' + r.failed + ' of ' + r.scored + '</strong> graded call(s)'
      : '<span style="color:#888;">not graded on any call last week</span>';
    return '<li style="margin-bottom:3px;' + (i === 0 ? 'font-weight:bold;' : '') + '">' +
      escapeHtml_(r.label) + ' — ' + text + '</li>';
  }).join('');

  var body =
    'Tomás,\n\n' +
    'This week\'s training focus for ' + repCfg.name + ': ' + focusLabel.toUpperCase() +
    (focus ? ' — failed on ' + focus.failed + ' of ' + focus.scored + ' graded call(s)' : '') +
    ' last week (' + windowLabel + ').\n\n' +
    (rankingLines.length ? 'All four elements, worst first:\n' + rankingLines.join('\n') + '\n\n' : '') +
    'The ' + flagged.length + ' call(s) that failed on ' + focusLabel.toLowerCase() + ' — raw data, not a ' +
    'finished playbook. This week\'s session should focus on just these, not older material already ' +
    'covered.\n\n' +
    flagged.map(function (c, i) {
      // Kris's ask (02/09/2026): "if you want calls reviewed, add the
      // links" — straight to the transcript and to the Sales Call Log row.
      var links = [];
      if (c.transcriptUrl) links.push('Transcript: ' + c.transcriptUrl);
      if (c.rowLink) links.push('Sheet row: ' + c.rowLink);
      // Discovery and framework each carry a Gaps column naming which
      // sub-piece actually failed — the difference between "discovery was
      // weak" and "he never confirmed what the QC already surfaced".
      var gap = (focus && c.gaps) ? c.gaps[focus.key] : '';
      return (i + 1) + '. ' + c.prospectName + ' (' + c.callDate + '), score ' + c.score + '\n   ' +
        (gap ? 'Missing: ' + gap + '\n   ' : '') +
        (c.feedback || '(no AI feedback summary on file)') +
        (links.length ? '\n   ' + links.join(' | ') : '');
    }).join('\n\n') +
    '\n\n— Sent automatically ahead of this week\'s session.';

  var callsHtml = flagged.map(function (c, i) {
    var feedbackHtml = escapeHtml_(c.feedback || '(no AI feedback summary on file)')
      .replace(/\n/g, '<br>')
      .replace(/"([^"]+)"/g, '<i>&quot;$1&quot;</i>');
    var gapHtml = (focus && c.gaps && c.gaps[focus.key]) ? escapeHtml_(c.gaps[focus.key]) : '';
    var linksHtml = [];
    if (c.transcriptUrl) linksHtml.push('<a href="' + escapeHtml_(c.transcriptUrl) + '">Transcript</a>');
    if (c.rowLink) linksHtml.push('<a href="' + escapeHtml_(c.rowLink) + '">Sheet row</a>');
    return '<div style="border-left:4px solid #1a56db;background:#f4f7fb;padding:10px 14px;margin:0 0 14px;border-radius:4px;">' +
      '<p style="margin:0 0 6px;"><strong>' + (i + 1) + '. ' + escapeHtml_(String(c.prospectName)) +
      '</strong> (' + escapeHtml_(c.callDate) + '), score ' +
      '<strong style="color:' + dailyPracticeScoreColor_(c.score) + ';">' + escapeHtml_(String(c.score)) + '</strong></p>' +
      (gapHtml ? '<p style="margin:0 0 6px;font-size:13px;color:#c0392b;"><strong>Missing:</strong> ' +
        gapHtml + '</p>' : '') +
      '<p style="margin:0;">' + feedbackHtml + '</p>' +
      (linksHtml.length ? '<p style="margin:6px 0 0;font-size:12px;">' + linksHtml.join(' &nbsp;|&nbsp; ') + '</p>' : '') +
      '</div>';
  }).join('');
  var htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    '<p>Tomás,</p>' +
    '<div style="border-left:4px solid #b8860b;background:#fdf8e8;padding:10px 14px;margin:0 0 14px;border-radius:4px;">' +
    '<p style="margin:0 0 4px;font-size:15px;"><strong>This week\'s training focus for ' +
    escapeHtml_(repCfg.name) + ': ' + escapeHtml_(focusLabel) + '</strong></p>' +
    '<p style="margin:0;">' +
    (focus ? 'Failed on <strong>' + focus.failed + ' of ' + focus.scored + '</strong> graded call(s) ' : '') +
    'last week (' + escapeHtml_(windowLabel) + ').</p>' +
    '</div>' +
    (rankingHtml ? '<p style="margin:0 0 4px;">All four elements, worst first:</p>' +
      '<ul style="margin:0 0 14px;padding-left:20px;font-size:13px;">' + rankingHtml + '</ul>' : '') +
    '<p>The <strong>' + flagged.length + ' call(s)</strong> that failed on ' +
    escapeHtml_(focusLabel.toLowerCase()) + ' — raw data, not a finished playbook. This week\'s session ' +
    'should focus on just these, not older material already covered.</p>' +
    callsHtml +
    '<p style="color:#666;font-size:12px;margin-top:16px;"><i>— Sent automatically ahead of this week\'s ' +
    'session.</i></p>' +
    '</div>';

  return { subject: subject, body: body, htmlBody: htmlBody };
}

function sendPlaybookReviewNewMaterialEmail_(repCfg, flagged, windowLabel, ranking) {
  var email = buildPlaybookReviewNewMaterialEmail_(repCfg, flagged, windowLabel, ranking);
  return guardedSend_(CONFIG.TOMAS_EMAIL, email.subject, email.body, {
    cc: CONFIG.KRIS_EMAIL,
    htmlBody: email.htmlBody,
    name: 'Training Prep Bot'
  }, 2);
}

function sendPlaybookReviewNoNewCallsEmail_(repCfg, windowLabel) {
  var body =
    'Tomás,\n\n' +
    'Nothing flagged for ' + repCfg.name + ' last week (' + windowLabel + ') — none of the four elements ' +
    '(discovery, framework, asking for the money/booking, objection handling) failed on a graded call, so ' +
    'there\'s no new material to train on this session. Per Kris\'s ask, this is deliberately NOT a pointer ' +
    'back to older material — training should stay scoped to what actually happened last week.\n\n' +
    '— Sent automatically ahead of this week\'s session.';

  return guardedSend_(CONFIG.TOMAS_EMAIL, repCfg.name + ' — no flagged calls last week', body, {
    cc: CONFIG.KRIS_EMAIL,
    name: 'Training Prep Bot'
  }, 2);
}

function installPlaybookReviewTrigger() {
  RUN_TAG = 'installPlaybookReviewTrigger';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runWeeklyPlaybookReview') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runWeeklyPlaybookReview')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.TUESDAY)
    .atHour(PLAYBOOK_REVIEW_CONFIG.TRIGGER_HOUR)
    .inTimezone(CONFIG.BUSINESS_TIMEZONE)
    .create();
  log_('Playbook review trigger installed: Tuesdays ' + PLAYBOOK_REVIEW_CONFIG.TRIGGER_HOUR + ':00 ' +
    CONFIG.BUSINESS_TIMEZONE + '.');
}

function setDropdown_(sheet, colIndex, values) {
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, colIndex, 999, 1).setDataValidation(rule);
}

/**
 * One-time cleanup: an early build backfilled a Calendar Event ID onto a blank
 * row (row 6). Clear any Event ID / Match Method written to rows with no
 * prospect identity. Safe to re-run.
 */
function cleanupStrayWritebacks() {
  RUN_TAG = 'cleanupStrayWritebacks';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName('Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab.'); return; }
  var lastRow = Math.max(sheet.getLastRow(), 2);
  var cleared = 0;
  for (var r = 2; r <= lastRow; r++) {
    var name = String(sheet.getRange(r, 1).getValue() || '').trim();
    var email = String(sheet.getRange(r, 2).getValue() || '').trim();
    if (!name && !email) {
      var idCell = sheet.getRange(r, 9);   // I: Calendar Event ID
      var mmCell = sheet.getRange(r, 12);  // L: Match Method
      if (String(idCell.getValue()).trim() !== '' || String(mmCell.getValue()).trim() !== '') {
        idCell.clearContent();
        mmCell.clearContent();
        log_('Cleared stray write-back on row ' + r);
        cleared++;
      }
    }
  }
  log_(cleared ? 'Cleared ' + cleared + ' stray row(s).' : 'No stray write-backs found.');
}

/**
 * Go-live cleanup: delete the 4 sample rows inserted by setupSalesCallLog
 * (14/08/2026 test data: Andrea Brunson, Jacqueline Coleman, Julio Cardoso,
 * Justine). Matches on date + known sample names so any real logged call is
 * never touched. Deletes bottom-up; safe to re-run.
 */
function deleteSampleRows() {
  RUN_TAG = 'deleteSampleRows';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName('Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab.'); return; }

  var SAMPLE_NAMES = ['andrea brunson', 'jacqueline coleman', 'julio cardoso', 'justine'];
  var SAMPLE_DATE = '14/08/2026';
  var tz = CONFIG.BUSINESS_TIMEZONE;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { log_('Nothing to delete — sheet has no data rows.'); return; }

  var deleted = 0;
  for (var r = lastRow; r >= 2; r--) {
    var name = String(sheet.getRange(r, 1).getValue() || '').trim().toLowerCase();
    var dateVal = sheet.getRange(r, 4).getValue();  // D: Call Date
    var dateStr = (dateVal instanceof Date)
      ? Utilities.formatDate(dateVal, tz, 'dd/MM/yyyy')
      : String(dateVal || '').trim();
    if (dateStr === SAMPLE_DATE && SAMPLE_NAMES.indexOf(name) !== -1) {
      sheet.deleteRow(r);
      log_('Deleted sample row ' + r + ' (' + name + ')');
      deleted++;
    }
  }
  log_(deleted ? 'Deleted ' + deleted + ' sample row(s).' : 'No sample rows found.');
}

/**
 * One-time: fill Prospect Email on the sample rows so attendee-email matching
 * can be validated. Matches by prospect name — safe to re-run, only fills
 * empty email cells.
 */
function fillSampleEmails() {
  RUN_TAG = 'fillSampleEmails';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName('Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab — run setupSalesCallLog first.'); return; }

  var EMAILS = {
    'jacqueline coleman': 'jcoleb1975@gmail.com',
    'julio cardoso': 'elitecapitalrealtyinc@gmail.com'
  };

  var lastRow = sheet.getLastRow();
  var names = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var emails = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  var filled = 0;

  for (var i = 0; i < names.length; i++) {
    var key = String(names[i][0] || '').trim().toLowerCase();
    if (EMAILS[key] && String(emails[i][0]).trim() === '') {
      sheet.getRange(i + 2, 2).setValue(EMAILS[key]);
      log_('Row ' + (i + 2) + ': ' + names[i][0] + ' → ' + EMAILS[key]);
      filled++;
    }
  }
  log_(filled ? 'Filled ' + filled + ' email(s).' : 'Nothing to fill (already set or rows not found).');
}

// ---------------------------------------------------------------------------
// One-time setup helpers (run manually from the editor)
// ---------------------------------------------------------------------------

/** Install just the daily close-of-business trigger. Run once. */
function installDailyTrigger() {
  RUN_TAG = 'installDailyTrigger';
  installDailyTriggerCore_();
  log_('Daily trigger installed for runDailyComplianceCheck at ' +
    CONFIG.DAILY_TRIGGER_HOUR + ':00 business time (' + CONFIG.BUSINESS_TIMEZONE + ').');
}

/**
 * Create exactly one daily close-of-business trigger for
 * runDailyComplianceCheck, replacing any existing copies. Returns the
 * trigger. The hour is in BUSINESS time: the trigger carries the business
 * timezone, so 18:00 LA stays 18:00 LA across DST no matter what timezone
 * the script project itself is set to.
 */
function installDailyTriggerCore_() {
  // Remove any existing copies first so we don't double-fire.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDailyComplianceCheck') {
      ScriptApp.deleteTrigger(t);
    }
  });
  return ScriptApp.newTrigger('runDailyComplianceCheck')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.DAILY_TRIGGER_HOUR)
    .inTimezone(CONFIG.BUSINESS_TIMEZONE)
    .create();
}

/**
 * ONE-TIME full automation install — replaces the old "run installDailyTrigger"
 * go-live step. Idempotent: safe to re-run, it heals to the desired state.
 *
 * Installs two triggers:
 *   1. runDailyComplianceCheck — every day at DAILY_TRIGGER_HOUR business time
 *   2. selfHealTriggers_       — every Sunday 05:00 business time (audits #1 and
 *      repairs it if dead/drifted, emailing ops about what it did)
 *
 * Also stamps CONFIG.EXPECTED_PROJECT_ID with this deployed script's ID so the
 * weekly audit can spot a trigger cloned from an old project copy.
 */
function installAutomation() {
  RUN_TAG = 'installAutomation';
  CONFIG.EXPECTED_PROJECT_ID = ScriptApp.getScriptId();

  installDailyTriggerCore_();

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'selfHealTriggers_') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('selfHealTriggers_')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(5)
    .inTimezone(CONFIG.BUSINESS_TIMEZONE)
    .create();

  var audit = auditConfig_();
  log_('Automation installed: daily ' + CONFIG.DAILY_TRIGGER_HOUR +
    ':00 compliance check + weekly Sunday 05:00 self-heal (both ' +
    CONFIG.BUSINESS_TIMEZONE + '). Project ID stamped as ' + CONFIG.EXPECTED_PROJECT_ID + '.');
  log_('Config audit: ' + (audit.ok ? 'OK — all routing addresses valid.' :
    'PROBLEMS: ' + audit.problems.join(' | ')));
}

/**
 * Every handler function name this project's standing automation is allowed
 * to have a trigger for — the complete set installAllReadyTriggers_ below
 * can install (whether or not each one's phase is currently enabled). This
 * is what makes the sweep at the end of that function possible: any trigger
 * whose handler ISN'T in this list is by definition not standing automation
 * this file knows about, and gets removed.
 *
 * Real gap found live (03/09/2026): the project hit Apps Script's 20-trigger
 * cap. Investigating found TWO separate problems, not one:
 *   1. installAllReadyTriggers_ was missing three phases entirely —
 *      installPlaybookReviewTrigger (runWeeklyPlaybookReview),
 *      installWeeklyTrainingSummaryTrigger (runWeeklyTrainingSummaries), and
 *      installGhlSyncTrigger (syncGhlEmailAndDisposition_) — all three had
 *      been installed by hand per their own file's "ONE-TIME SETUP" comment,
 *      completely invisible to this "install everything" function. A fresh
 *      run of installAllReadyTriggers_ on a rebuilt project would have
 *      silently left them off.
 *   2. The only orphan-trigger cleanup here was one hardcoded carve-out for
 *      rescoreAllCalls's own backfill runner — anything else left behind by
 *      an ad-hoc job (runRescoreLastWeekViaTrigger_ added 03/09/2026,
 *      runAllLegacyBackfills_, or any future one-off) was invisible to this
 *      function and would sit there forever, silently eating a trigger slot.
 *      scoreBensLegacyTranscripts looked exactly like this kind of leftover
 *      at first glance — it isn't (see installBensScoringAutomation's own
 *      header, 25/08/2026: it's genuinely standing automation) — but telling
 *      "genuinely standing" apart from "an ad-hoc job someone forgot to
 *      clean up" by eye is exactly the mistake a canonical list prevents.
 *
 * Keep this list in sync whenever a new phase gets its own install*Trigger()
 * function — a handler installed above but missing here gets swept as an
 * orphan on the very next run.
 *
 * Updated 04/09/2026 (same project-cap incident as the header above, this
 * time triggered by adding Phase 11's Bens podcast sync): the five separate
 * Phase 2 ongoing-scoring handlers were consolidated into one,
 * runAllOngoingScoringPasses_ (see its own header, Phase2_CallScoring.gs) —
 * removed here so the sweep now correctly treats the old individual
 * handlers as orphans if anyone re-installs one by hand and forgets to clean
 * up. Also added runBensPodcastSync_ (Phase 11), which — like
 * syncGhlEmailAndDisposition_ before the 03/09/2026 fix above — had its own
 * install*Trigger() function but was never added here, so it would have been
 * swept as an orphan on the very next installAllReadyTriggers_ run.
 */
var STANDING_AUTOMATION_HANDLERS_ = [
  'runDailyComplianceCheck', 'selfHealTriggers_',                          // Phase 1
  'runWeeklyPlaybookReview',                                               // Phase 1 — Playbook Review
  'runAllOngoingScoringPasses_', 'runRandomCalibrationSample',             // Phase 2
  'sendUpcomingHandoffBriefs_', 'sendUpcomingLeadConfirmationReminders_',  // Phase 3
  'runInboxSlaCheck', 'runNoShowFollowUpCheck',                            // Phase 4
  'runWeeklyScorecard', 'runWeeklyTrainingSummaries',                      // Phase 5
  'runTrainingCallReview', 'sendTomasTranscriptReminder_',                 // Phase 6
  'runDailyPracticeCompliance', 'sendDailyPracticeReminders_', 'runDailyPracticeGrading', // Phase 7
  'classifyNewReplies', 'sendReplyMetricsReport_',                         // Phase 8
  'syncGhlEmailAndDisposition_',                                           // Phase 9
  'runBensPodcastSync_',                                                   // Phase 11
  'runGhlNoteSync_'                                                        // Phase 12
];

/**
 * Single entry point that installs every trigger this project knows about —
 * but only for whatever is ACTUALLY ready to run, never as a way to skip a
 * phase's own preview-before-live gate. Answers "do we have one thing to run
 * to schedule everything?" without silently turning on something nobody has
 * reviewed yet. Safe to re-run any time (idempotent); re-running after
 * flipping an ENABLED flag just picks up the newly-ready phase.
 *
 * What "ready" means, per phase:
 *   - Phase 1 (compliance check) & Phase 2 (call scoring) — always installed.
 *     Neither has a live-send gate that this could bypass: Phase 1 has no
 *     ENABLED flag at all, and Phase 2's SHADOW_MODE only gates the Kris
 *     review-queue EMAIL, not the scoring/logging itself — running the
 *     scoring pipeline on a schedule is exactly what shadow mode is for.
 *   - Every other phase — installed ONLY if that phase's own CONFIG.ENABLED
 *     is already true, i.e. a human ran its preview*() function and flipped
 *     the flag themselves. Otherwise this logs why it skipped that one and
 *     leaves it alone — flipping ENABLED to true and re-running this
 *     picks it up.
 *
 * Also SWEEPS: after installing/skipping every known phase, deletes any
 * trigger whose handler isn't in STANDING_AUTOMATION_HANDLERS_ above —
 * ad-hoc backfill runners included, whatever job left them behind. Re-run
 * this any time the trigger count looks wrong; it both fixes the count and
 * reports exactly what it removed.
 */
/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function installAllReadyTriggers() {
  return installAllReadyTriggers_();
}

function installAllReadyTriggers_() {
  RUN_TAG = 'installAllReadyTriggers_';
  var installed = [], skipped = [];

  installAutomation();
  installed.push('Phase 1: daily compliance check + weekly self-heal');

  installOngoingScoringTrigger();
  installed.push('Phase 2: ongoing call scoring + Sean/Tomás/Joana/Bens auto-scoring, ' +
    'consolidated onto one every-4h trigger (04/09/2026 — was 5 separate triggers)');

  // Real gap found live (03/09/2026): this was installed by hand per its own
  // file's "ONE-TIME SETUP" comment and was invisible to this function ever
  // since — a fresh run would have silently left it off.
  if (typeof PLAYBOOK_REVIEW_CONFIG !== 'undefined' && PLAYBOOK_REVIEW_CONFIG.ENABLED) {
    installPlaybookReviewTrigger();
    installed.push('Phase 1: weekly playbook review (Training Prep Bot)');
  } else {
    skipped.push('Phase 1 (playbook review) — PLAYBOOK_REVIEW_CONFIG.ENABLED is false. Run ' +
      'previewWeeklyPlaybookReview() first, confirm it looks right, then flip ENABLED and re-run this.');
  }

  if (typeof HANDOFF_CONFIG !== 'undefined' && HANDOFF_CONFIG.ENABLED) {
    installHandoffBriefTrigger();
    installed.push('Phase 3: warm-handoff briefs');
  } else {
    skipped.push('Phase 3 (handoff briefs) — HANDOFF_CONFIG.ENABLED is false. Run ' +
      'previewUpcomingHandoffBriefs(), confirm it looks right, then flip ENABLED and re-run this.');
  }

  if (typeof LEAD_CONFIRMATION_CONFIG !== 'undefined' && LEAD_CONFIRMATION_CONFIG.ENABLED) {
    installLeadConfirmationReminderTrigger();
    installed.push('Phase 3: Discovery-call lead confirmation reminders');
  } else {
    skipped.push('Phase 3 (lead confirmation reminders) — LEAD_CONFIRMATION_CONFIG.ENABLED is false. Run ' +
      'previewUpcomingLeadConfirmationReminders(), confirm it looks right, then flip ENABLED and re-run this.');
  }

  if (typeof INBOX_SLA_CONFIG !== 'undefined' && INBOX_SLA_CONFIG.ENABLED) {
    installInboxSlaTrigger();
    installed.push('Phase 4: inbox SLA check');
  } else {
    skipped.push('Phase 4 (inbox SLA) — INBOX_SLA_CONFIG.ENABLED is false. Needs the domain-wide-' +
      'delegation setup (see that file\'s header) + previewInboxSlaCheck() first, then flip ENABLED and re-run this.');
  }

  if (typeof NO_SHOW_FOLLOWUP_CONFIG !== 'undefined' && NO_SHOW_FOLLOWUP_CONFIG.ENABLED) {
    installNoShowFollowUpCheckTrigger();
    installed.push('Phase 4: no-show follow-up check');
  } else {
    skipped.push('Phase 4 (no-show follow-up check) — NO_SHOW_FOLLOWUP_CONFIG.ENABLED is false. Needs the ' +
      'same Gmail domain-wide-delegation setup as inbox SLA above + previewNoShowFollowUpCheck() first, ' +
      'then flip ENABLED and re-run this.');
  }

  if (typeof WEEKLY_SCORECARD_CONFIG !== 'undefined' && WEEKLY_SCORECARD_CONFIG.ENABLED) {
    installWeeklyScorecardTrigger();
    installed.push('Phase 5: weekly scorecard');
  } else {
    skipped.push('Phase 5 (weekly scorecard) — WEEKLY_SCORECARD_CONFIG.ENABLED is false. Run ' +
      'migrateAddPrimaryFailureModeColumn() + previewWeeklyScorecards() first, then flip ENABLED and re-run this.');
  }

  // Same gap as Phase 1's playbook review above — installed by hand, invisible here until now.
  if (typeof WEEKLY_TRAINING_SUMMARY_CONFIG !== 'undefined' && WEEKLY_TRAINING_SUMMARY_CONFIG.ENABLED) {
    installWeeklyTrainingSummaryTrigger();
    installed.push('Phase 5: weekly training summary docs for Tomás');
  } else {
    skipped.push('Phase 5 (weekly training summary) — WEEKLY_TRAINING_SUMMARY_CONFIG.ENABLED is false. ' +
      'Run previewWeeklyTrainingSummaries() first, confirm it looks right, then flip ENABLED and re-run this.');
  }

  if (typeof TRAINING_REVIEW_CONFIG !== 'undefined' && TRAINING_REVIEW_CONFIG.ENABLED) {
    installTrainingCallReviewTrigger();
    installed.push('Phase 6: training call review');
  } else {
    skipped.push('Phase 6 (training call review) — TRAINING_REVIEW_CONFIG.ENABLED is false. Run ' +
      'previewTrainingCallReview() first, confirm it looks right, then flip ENABLED and re-run this.');
  }

  if (typeof TOMAS_TRANSCRIPT_REMINDER_CONFIG !== 'undefined' && TOMAS_TRANSCRIPT_REMINDER_CONFIG.ENABLED) {
    installTomasTranscriptReminderTrigger();
    installed.push("Phase 6: Tomás's Tuesday transcript-upload reminder");
  } else {
    skipped.push("Phase 6 (Tomás's Tuesday reminder) — TOMAS_TRANSCRIPT_REMINDER_CONFIG.ENABLED is false. Run " +
      'sendTomasTranscriptReminder() once to see the preview, then flip ENABLED and re-run this.');
  }

  if (typeof DAILY_PRACTICE_CONFIG !== 'undefined' && DAILY_PRACTICE_CONFIG.ENABLED) {
    installDailySelfPracticeTriggers_();
    installed.push('Phase 7: daily self-practice grading + reminders');
  } else {
    skipped.push('Phase 7 (daily self-practice) — DAILY_PRACTICE_CONFIG.ENABLED is false. Run ' +
      'previewDailyPracticeGrading() first, confirm it looks right, then flip ENABLED and re-run this.');
  }

  if (typeof RANDOM_CALIBRATION_CONFIG !== 'undefined' && RANDOM_CALIBRATION_CONFIG.ENABLED) {
    installRandomCalibrationSampleTrigger();
    installed.push('Phase 2: weekly random calibration holdout sample');
  } else {
    skipped.push('Phase 2 (random calibration holdout) — RANDOM_CALIBRATION_CONFIG.ENABLED is false. Run ' +
      'previewRandomCalibrationSample() first, confirm it looks right, then flip ENABLED and re-run this. ' +
      'See QA_COACHING_RESEARCH_REPORT.md §1.1.');
  }

  if (typeof REPLY_TRACKER_CONFIG !== 'undefined' && REPLY_TRACKER_CONFIG.ENABLED) {
    installReplyTrackerTriggers();
    installed.push('Phase 8: reply tracker');
  } else {
    skipped.push('Phase 8 (reply tracker) — REPLY_TRACKER_CONFIG.ENABLED is false. Run ' +
      'previewReplyClassification() + previewReplyMetricsReport() first, then flip ENABLED and re-run this.');
  }

  // Same gap as Phase 1/5's manually-installed triggers above.
  if (typeof GHL_CONFIG !== 'undefined' && GHL_CONFIG.ENABLED) {
    installGhlSyncTrigger();
    installed.push('Phase 9: GHL CRM sync');
  } else {
    skipped.push('Phase 9 (GHL sync) — GHL_CONFIG.ENABLED is false. Run previewGhlSync() first, ' +
      'confirm it looks right, then flip ENABLED and re-run this.');
  }

  // Same gap as Phase 1/5/9's manually-installed triggers above — added
  // 04/09/2026, same incident that consolidated Phase 2's triggers.
  if (typeof BENS_PODCAST_SYNC_CONFIG !== 'undefined' && BENS_PODCAST_SYNC_CONFIG.ENABLED) {
    installBensPodcastSyncTrigger();
    installed.push('Phase 11: Bens podcast tracker sync');
  } else {
    skipped.push('Phase 11 (Bens podcast sync) — BENS_PODCAST_SYNC_CONFIG.ENABLED is false. Run ' +
      'previewBensPodcastSync() first, confirm it looks right, then flip ENABLED and re-run this.');
  }

  if (typeof GHL_NOTE_SYNC_CONFIG !== 'undefined' && GHL_NOTE_SYNC_CONFIG.ENABLED) {
    installGhlNoteSyncTrigger();
    installed.push('Phase 12: GHL review-note sync');
  } else {
    skipped.push('Phase 12 (GHL review-note sync) — GHL_NOTE_SYNC_CONFIG.ENABLED is false. Run ' +
      'previewGhlNoteSync() first, confirm it looks right, then flip ENABLED and re-run this.');
  }

  // RUN_TAG reset here on purpose: every install*() call above sets its own
  // RUN_TAG at its own top (that's how each log_() line above got its own
  // [installXxx] prefix), which leaves RUN_TAG stuck on whichever ran last
  // by the time we get here — confirmed live (31/08/2026): the sweep below
  // and the "done" summary both showed up as [installReplyTrackerTriggers]
  // without this reset.
  RUN_TAG = 'installAllReadyTriggers_';

  // General orphan sweep — replaces the old hardcoded single-purpose
  // rescoreAllCalls carve-out (31/08/2026). Real gap found live (03/09/2026):
  // that carve-out only ever knew about ONE ad-hoc backfill trigger by name.
  // A second one (runRescoreLastWeekViaTrigger_, added the same day) would
  // have been just as invisible to it as the three missing phases above
  // were — anything not in STANDING_AUTOMATION_HANDLERS_ is, by definition,
  // not standing automation this file knows about, so it gets removed
  // regardless of what it's called or when it was added. Start a backfill
  // on purpose with its own install*Trigger() function afterward — this
  // function will stop it again the next time it's re-run, same as before.
  var orphansRemoved = [];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var handler = t.getHandlerFunction();
    if (STANDING_AUTOMATION_HANDLERS_.indexOf(handler) === -1) {
      ScriptApp.deleteTrigger(t);
      orphansRemoved.push(handler);
    }
  });
  if (orphansRemoved.length) {
    installed.push('Swept ' + orphansRemoved.length + ' orphan trigger(s), not part of standing ' +
      'automation: ' + orphansRemoved.join(', '));
  } else {
    installed.push('Orphan sweep: none found — every existing trigger is recognized standing automation.');
  }

  log_('installAllReadyTriggers_ done.\nInstalled:\n  ' + installed.join('\n  ') +
    '\nSkipped:\n  ' + skipped.join('\n  '));
}

/**
 * Weekly self-heal (installed by installAutomation). Verifies the daily
 * compliance trigger exists exactly once and belongs to this deployed script;
 * deletes duplicates/stale copies and recreates the trigger if it's missing
 * or drifted. Emails ops only when it had to repair something — silence means
 * healthy. This removes the last manual check: nobody has to remember to
 * verify the trigger is still alive.
 */
/**
 * Every trigger this weekly audit is responsible for keeping alive. Each
 * entry's installer must be idempotent (delete-then-recreate), since heal
 * calls it directly when the trigger is missing entirely.
 */
var SELF_HEAL_TRIGGER_REGISTRY_ = [
  {
    handler: 'runDailyComplianceCheck',
    install: installDailyTriggerCore_,
    label: 'daily compliance trigger'
    // No pauseProperty: this one should always stay on.
  },
  {
    // 04/09/2026: was two entries here (scoreNewlyLoggedCalls_,
    // scoreSeanTranscripts) for two of the five triggers that got
    // consolidated into runAllOngoingScoringPasses_ (Phase2_CallScoring.gs) —
    // replaced with one entry so self-heal still recognizes and repairs the
    // (now single) ongoing-scoring trigger instead of recreating one of the
    // two old ones it used to know about by name.
    handler: 'runAllOngoingScoringPasses_',
    install: installOngoingScoringTrigger,
    label: 'consolidated ongoing-scoring trigger',
    pauseProperty: 'PAUSE_ONGOING_SCORING_TRIGGER'
  }
];

function selfHealTriggers_() {
  RUN_TAG = 'selfHealTriggers_';
  var problems = [];
  var props = PropertiesService.getScriptProperties();

  SELF_HEAL_TRIGGER_REGISTRY_.forEach(function (entry) {
    // A trigger missing because someone deliberately deleted it (e.g. "once
    // Sean's backlog is done, delete this trigger") looks identical to one
    // that's missing by accident — self-heal was recreating it either way,
    // silently undoing the deliberate choice. Set this Script Property to
    // 'true' (Project Settings → Script Properties) to opt a trigger out of
    // auto-recreation instead of just deleting it.
    if (entry.pauseProperty && props.getProperty(entry.pauseProperty) === 'true') {
      return;
    }

    var triggers = ScriptApp.getProjectTriggers().filter(function (t) {
      return t.getHandlerFunction() === entry.handler;
    });

    var healthy = null;
    triggers.forEach(function (t) {
      var src = String(t.getTriggerSourceId ? t.getTriggerSourceId() : '');
      if (!healthy && (!CONFIG.EXPECTED_PROJECT_ID || src === CONFIG.EXPECTED_PROJECT_ID)) {
        healthy = t;
      } else {
        ScriptApp.deleteTrigger(t);
        problems.push('deleted a duplicate/stale ' + entry.label + ' (source ' + (src || 'unknown') + ')');
      }
    });

    if (!healthy) {
      entry.install();
      problems.push(entry.label + ' was missing — recreated');
    }
  });

  if (problems.length) {
    sendOpsAlert_('[Compliance bot] Self-heal repaired a trigger',
      'Weekly trigger audit found and fixed:\n  - ' + problems.join('\n  - ') +
      '\n\nNo action needed; all scoring/compliance triggers are healthy now.');
  }
  log_(problems.length ? 'Repaired: ' + problems.join(' | ') : 'All triggers healthy — nothing to do.');
}

/**
 * Diagnostic: dump exactly what getAllTrackerRows_ sees for 14/08 — every
 * candidate row with its identity fields, and the full raw first 12 rows.
 * Run this when matching misbehaves.
 */
function debugDumpTrackerRows() {
  RUN_TAG = 'debugDumpTrackerRows';
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var repCfg = CONFIG.REPS[1]; // Joana — her sample rows are the test case
  var rows = getAllTrackerRows_(repCfg, '14/08/2026', tz);
  log_('Candidate rows for Joana on 14/08/2026: ' + rows.length);
  rows.forEach(function (r) {
    log_('  row ' + r.rowIndex + ': prospect="' + r.prospect + '" email="' + r.email +
      '" eventId="' + r.eventId + '" logged=' + r.logged);
  });

  // Raw dump of the first 12 rows x 12 cols so we can see anything unexpected.
  var ss = SpreadsheetApp.openById(repCfg.spreadsheetId);
  var sheet = ss.getSheetByName('Sales Call Log');
  var raw = sheet.getRange(1, 1, 12, 12).getValues();
  log_('--- raw A1:L12 ---');
  raw.forEach(function (row, i) {
    log_('  R' + (i + 1) + ': ' + JSON.stringify(row));
  });
}

/**
 * Diagnostic: dump guest lists for all call events on 14/08/2026.
 * Answers: do bare "QC" events carry the prospect's email as a guest?
 * Run once before enabling attendee-email matching.
 */
function debugListEventGuests() {
  RUN_TAG = 'debugListEventGuests';
  var tz = CONFIG.BUSINESS_TIMEZONE;
  // 14/08/2026 business day: noon UTC sits inside that day in any US zone.
  var dayStart = businessDayStart_(new Date(Date.UTC(2026, 7, 14, 12)), tz);
  var dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  CONFIG.REPS.forEach(function (repCfg) {
    var events = getRepCallEventsRaw_(repCfg, dayStart, dayEnd);
    log_('--- ' + repCfg.name + ' ---');
    events.forEach(function (ev) {
      var guests = ev.getGuestList().map(function (g) { return g.getEmail(); });
      log_('  "' + ev.getTitle() + '" @ ' +
        Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm') +
        ' → guests: ' + (guests.length ? guests.join(', ') : '(NONE)'));
    });
  });
}

/** Raw event fetch with the same include/exclude filter, keeping the event objects. */
function getRepCallEventsRaw_(repCfg, dayStart, dayEnd) {
  var cal = repCfg.calendarId === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(repCfg.calendarId);
  if (!cal) throw new Error('No calendar found for id ' + repCfg.calendarId);
  return cal.getEvents(dayStart, dayEnd).filter(function (ev) { return titleLooksLikeSalesOrQcCall_(ev.getTitle()); });
}

/** Debug: dry-run the compliance check against a specific date. Run from editor. */
function debugCheckSpecificDate() {
  RUN_TAG = 'debugCheckSpecificDate';
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var dayStr = '14/08/2026'; // the business day being inspected
  var dayStart = businessDayStart_(new Date(Date.UTC(2026, 7, 14, 12)), tz);
  var dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  CONFIG.REPS.forEach(function (repCfg) {
    try {
      var events = getRepCallEvents_(repCfg, dayStart, dayEnd);
      var allRows = getAllTrackerRows_(repCfg, dayStr, tz);
      var loggedRows = allRows.filter(function (r) { return r.logged; });
      var missing = matchEventsForRep_(repCfg.name, events, allRows, loggedRows, /*writeBack=*/true);
      log_(dayStr + ' | ' + repCfg.name + ': ' + events.length +
        ' event(s), ' + loggedRows.length + ' logged row(s), ' + missing.length + ' MISSING');
    } catch (e) {
      log_('ERROR for ' + repCfg.name + ': ' + e);
    }
  });
}

/** Dry run: logs what WOULD be emailed for today's business day, sends nothing. */
function dryRunComplianceCheck() {
  RUN_TAG = 'dryRunComplianceCheck';
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var now = new Date();
  var priorDay = Utilities.formatDate(now, tz, 'dd/MM/yyyy');
  var dayStart = businessDayStart_(now, tz);
  var dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  CONFIG.REPS.forEach(function (repCfg) {
    try {
      var events = getRepCallEvents_(repCfg, dayStart, dayEnd);
      var allRows = getAllTrackerRows_(repCfg, priorDay, tz);
      var loggedRows = allRows.filter(function (r) { return r.logged; });
      var missing = matchEventsForRep_(repCfg.name, events, allRows, loggedRows, /*writeBack=*/false);
      log_(repCfg.name + ' @ ' + priorDay + ': ' +
        events.length + ' event(s), ' + loggedRows.length + ' logged row(s), ' +
        missing.length + ' MISSING → ' +
        (missing.length ? missing.map(function (m) { return m.title; }).join(' | ') : '(none)'));
    } catch (e) {
      log_('ERROR for ' + repCfg.name + ': ' + e);
    }
  });
}
