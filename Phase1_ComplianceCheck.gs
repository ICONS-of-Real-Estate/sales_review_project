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
      // Header names as they appear in THIS rep's sheet. Brief §2 target
      // names are listed first; current real headers as fallbacks.
      columns: {
        prospectName: ['Prospect Name', 'Name'],
        prospectEmail: ['Prospect Email', 'Email'],
        callDate: ['Call Date', 'First Call Date', 'Recording Date', 'Booking Date'],
        outcomeLogged: ['Outcome Logged', 'Call Taken', 'Recording Done'],
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
  [CONFIG.KRIS_EMAIL, CONFIG.TOMAS_EMAIL, CONFIG.OPS_ALERT_EMAIL].forEach(function (e) {
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
      log_('  [' + repName + '] match? event="' + ev.title + '" → NOT LOGGED');
      missing.push(ev);
      // Still try to enrich an UNLOGGED row with the event ID: it makes
      // tomorrow's match exact-key and builds the Phase 0 join data.
      var availableAll = allRows.filter(function (r) { return !claimedRowIndexes[r.rowIndex]; });
      var anyHit = findMatch_(ev, availableAll);
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
  if (events.length === 0) return;

  var allRows = getAllTrackerRows_(repCfg, priorDay, tz);
  var loggedRows = allRows.filter(function (r) { return r.logged; });
  log_(repCfg.name + ': ' + loggedRows.length + ' logged tracker row(s) for ' + priorDay +
    ' (' + allRows.length + ' total row(s) for the day)');

  var missing = matchEventsForRep_(repCfg.name, events, allRows, loggedRows, /*writeBack=*/true);

  if (missing.length === 0) {
    log_(repCfg.name + ': fully compliant for ' + priorDay);
    return;
  }
  sendComplianceEmail_(repCfg, missing, priorDay, tz);
}

/**
 * Pull the rep's calendar events for [dayStart, dayEnd) and keep only those
 * that look like sales/QC calls (title keyword match).
 */
function getRepCallEvents_(repCfg, dayStart, dayEnd) {
  var cal = repCfg.calendarId === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(repCfg.calendarId);
  if (!cal) throw new Error('No calendar found for id ' + repCfg.calendarId);

  var mapped = cal.getEvents(dayStart, dayEnd)
    .filter(function (ev) {
      var t = (ev.getTitle() || '').toLowerCase();
      var excluded = CONFIG.CALL_TITLE_EXCLUDE.some(function (k) { return t.indexOf(k) !== -1; });
      if (excluded) return false;
      return CONFIG.CALL_TITLE_INCLUDE.some(function (k) { return t.indexOf(k) !== -1; });
    })
    .map(function (ev) {
      return {
        id: ev.getId(),
        title: ev.getTitle() || '(untitled)',
        start: ev.getStartTime(),
        prospectGuess: guessProspectFromTitle_(ev.getTitle() || ''),
        // Prospect emails only: strip the rep's own address and other internal
        // guests so an internal placeholder block can never match a tracker row.
        attendeeEmails: ev.getGuestList()
          .map(function (g) { return (g.getEmail() || '').toLowerCase().trim(); })
          .filter(function (e) {
            return e && INTERNAL_EMAILS.indexOf(e) === -1;
          })
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
  if (col.outcomeLogged === -1) throw new Error('No outcome-logged column found in ' + sheet.getName());
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

    if (col.callDate !== -1 && row[col.callDate] !== '' && row[col.callDate] != null) {
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
      logged: col.outcomeLogged !== -1 && isTruthyOutcome_(row[col.outcomeLogged]),
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

function sendComplianceEmail_(repCfg, missingEvents, priorDay, tz) {
  var n = missingEvents.length;
  var trackerUrl = 'https://docs.google.com/spreadsheets/d/' + repCfg.spreadsheetId + '/edit';

  // Names in the subject (not just the body) so which prospect(s) this is
  // about is visible from the inbox list without opening the email. Caps at
  // 3 named + "+N more" so a rare heavy day doesn't produce an unreadably
  // long subject line.
  var names = missingEvents.map(function (ev) { return ev.prospectGuess; });
  var namesForSubject = names.length <= 3
    ? names.join(', ')
    : names.slice(0, 3).join(', ') + ', +' + (names.length - 3) + ' more';

  var subject = repCfg.name + ' — [Action needed] Update your sales tracker — ' + namesForSubject +
    ' (' + n + ' call(s) from ' + priorDay + ') not logged';

  // guessProspectFromTitle_ falls back to echoing the raw title verbatim when
  // it can't parse a name out of it (e.g. a bare "QC" event) -- show that
  // honestly instead of printing the same string twice on one line
  // ("QC — 07:45 — QC"), which reads as a meaningless duplicate.
  var entries = missingEvents.map(function (ev) {
    var nameParsed = ev.prospectGuess.trim().toLowerCase() !== ev.title.trim().toLowerCase();
    return {
      time: Utilities.formatDate(ev.start, tz, 'HH:mm'),
      who: nameParsed ? ev.prospectGuess : '(name not parsed from calendar title)',
      callType: callTypeFromTitle_(ev.title)
    };
  });

  var plainLines = entries.map(function (e) {
    return '  • ' + e.time + ' — ' + e.who + ' — ' + e.callType;
  });
  var htmlLines = entries.map(function (e) {
    return '<li>' + e.time + ' — <b>' + e.who + '</b> — ' + e.callType + '</li>';
  });

  var body =
    'Hi ' + repCfg.name + ',\n\n' +
    'Your calendar shows ' + n + ' sales/QC call(s) on ' + priorDay +
    ' with no matching outcome in your tracker:\n\n' +
    plainLines.join('\n') + '\n\n' +
    'Please add the outcome (Sold / Not Sold / Follow-up / No-show) and any notes today ' +
    'so it can be scored.\n\n' +
    'Tracker: ' + trackerUrl + '\n\n' +
    'Reply to this email once you\'ve updated the tracker, so Kris/Tomás know it\'s done.\n\n' +
    '— This is an automated check. This email was drafted by AI and sent automatically; ' +
    'reply to Kris or Tomás with any issues.';

  var htmlBody =
    '<p>Hi ' + repCfg.name + ',</p>' +
    '<p>Your calendar shows ' + n + ' sales/QC call(s) on ' + priorDay +
    ' with no matching outcome in your tracker:</p>' +
    '<ul>' + htmlLines.join('') + '</ul>' +
    '<p>Please add the outcome (Sold / Not Sold / Follow-up / No-show) and any notes today ' +
    'so it can be scored.</p>' +
    '<p><b>Tracker:</b> <a href="' + trackerUrl + '">' + trackerUrl + '</a></p>' +
    '<p><b>Reply to this email once you\'ve updated the tracker</b>, so Kris/Tomás know it\'s done.</p>' +
    '<p><i>— This is an automated check. This email was drafted by AI and sent automatically; ' +
    'reply to Kris or Tomás with any issues.</i></p>';

  var recipientsNeeded = 3; // rep + Kris + Tomás (CC counts against recipient quota)
  guardedSend_(repCfg.email, subject, body, {
    cc: CONFIG.KRIS_EMAIL + ',' + CONFIG.TOMAS_EMAIL,
    htmlBody: htmlBody,
    name: 'Call Tracker Compliance Bot'
  }, recipientsNeeded);
  log_('Sent compliance email to ' + repCfg.email + ' for ' + n + ' unlogged call(s).');
}

function sendOpsAlert_(subject, body) {
  try {
    guardedSend_(CONFIG.OPS_ALERT_EMAIL, '[Compliance bot] ' + subject, body, {}, 1);
  } catch (e) {
    log_('FAILED to send ops alert: ' + e);
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
function alertHeaderDriftOnce_(mismatches) {
  var props = PropertiesService.getScriptProperties();
  var key = 'LAST_HEADER_DRIFT_ALERT_AT';
  var last = props.getProperty(key);
  var now = Date.now();
  if (last && (now - Number(last)) < HEADER_DRIFT_ALERT_COOLDOWN_MS) return;
  props.setProperty(key, String(now));
  sendOpsAlert_('Sales Call Log header drift — every scoring/compliance function is failing',
    'getValidatedColumnMap_ found the "Sales Call Log" header row (row 1) does not match what the code ' +
    'expects:\n\n  ' + mismatches.join('\n  ') +
    '\n\nEvery function that reads this sheet by column name is failing right now until this is fixed.\n\n' +
    'If this is just a stray edit to a header cell\'s text (e.g. someone typed into the wrong box), fix it ' +
    'by hand to match exactly, or run setupSalesCallLog() to rewrite row 1 back to the expected headers.\n\n' +
    'If a column was actually supposed to be added and the migration for it just hasn\'t been run yet, run ' +
    'that migration instead — do NOT blindly retype headers in that case, the underlying data columns won\'t ' +
    'actually be there yet.\n\n' +
    '(Throttled to at most one alert per hour while this stays broken.)');
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
var TRAINING_CYCLE_EPOCH_ = new Date(2026, 7, 19); // Wed 19 Aug 2026 = Week 1, Day 1

function computeTrainingCycleLabel_(date, tz) {
  var weekdayName = Utilities.formatDate(date, tz, 'EEEE');
  var day = TRAINING_CYCLE_DAY_BY_WEEKDAY_[weekdayName];
  if (!day) return null; // Saturday/Sunday — no assignment

  var daysSinceEpoch = Math.round(
    (businessDayStart_(date, tz) - businessDayStart_(TRAINING_CYCLE_EPOCH_, tz)) / 86400000
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
  'Call Type',              // F  (dropdown: QC/Sales Call/Discovery)
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
  'Rubric Version'          // Z  (e.g. "2026-08-25-framework" — blank on rows
                            //    scored before this column existed, same
                            //    backward-compatible "no signal" pattern as
                            //    every prior column addition here)
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
  var headersPresent = existing[0] === SALES_CALL_LOG_HEADERS[0];
  if (!headersPresent) {
    headerRange.setValues([SALES_CALL_LOG_HEADERS]);
    log_('Wrote ' + SALES_CALL_LOG_HEADERS.length + ' headers.');
  }
  headerRange.setFontWeight('bold').setBackground('#e8eef7');
  sheet.setFrozenRows(1);

  // Data validation: Rep (E), Call Type (F), Outcome Disposition (H), Match Method (L)
  setDropdown_(sheet, 5, ['Bens', 'Joana', 'Sean']);
  setDropdown_(sheet, 6, ['QC', 'Sales Call', 'Discovery']);
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
    [3, 'That\'s too expensive', 2,
      'Tennitia Wilson ("the costs were prohibitive... more than my car note and insurance put together... in ' +
      'sales you don\'t have a pension or 401k, to commit to that dollar amount I\'d be real brazen"), Dana ' +
      'Hindman-Allen (wanted pricing before committing more time — same underlying concern).',
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
 *   - Phase 3 (handoff briefs), Phase 4 (inbox SLA), Phase 5 (weekly
 *     scorecard) — installed ONLY if that phase's own CONFIG.ENABLED is
 *     already true, i.e. a human ran its preview*() function and flipped the
 *     flag themselves. Otherwise this logs why it skipped that one and
 *     leaves it alone — flipping ENABLED to true and re-running this
 *     picks it up.
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

  installPhase2Trigger();
  installSeanScoringAutomation();
  installTomasScoringAutomation();
  installJoanaScoringAutomation();
  installBensScoringAutomation();
  installed.push('Phase 2: ongoing call scoring (every 4h) + Sean/Tomás/Joana/Bens auto-scoring (every 4h each)');

  if (typeof HANDOFF_CONFIG !== 'undefined' && HANDOFF_CONFIG.ENABLED) {
    installHandoffBriefTrigger();
    installed.push('Phase 3: warm-handoff briefs');
  } else {
    skipped.push('Phase 3 (handoff briefs) — HANDOFF_CONFIG.ENABLED is false. Run ' +
      'previewUpcomingHandoffBriefs(), confirm it looks right, then flip ENABLED and re-run this.');
  }

  if (typeof INBOX_SLA_CONFIG !== 'undefined' && INBOX_SLA_CONFIG.ENABLED) {
    installInboxSlaTrigger();
    installed.push('Phase 4: inbox SLA check');
  } else {
    skipped.push('Phase 4 (inbox SLA) — INBOX_SLA_CONFIG.ENABLED is false. Needs the domain-wide-' +
      'delegation setup (see that file\'s header) + previewInboxSlaCheck() first, then flip ENABLED and re-run this.');
  }

  if (typeof WEEKLY_SCORECARD_CONFIG !== 'undefined' && WEEKLY_SCORECARD_CONFIG.ENABLED) {
    installWeeklyScorecardTrigger();
    installed.push('Phase 5: weekly scorecard');
  } else {
    skipped.push('Phase 5 (weekly scorecard) — WEEKLY_SCORECARD_CONFIG.ENABLED is false. Run ' +
      'migrateAddPrimaryFailureModeColumn() + previewWeeklyScorecards() first, then flip ENABLED and re-run this.');
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
    handler: 'scoreNewlyLoggedCalls_',
    install: function () { reinstallHourlyTrigger_('scoreNewlyLoggedCalls_', 4); },
    label: 'Phase 2 ongoing-scoring trigger',
    pauseProperty: 'PAUSE_PHASE2_TRIGGER'
  },
  {
    handler: 'scoreSeanTranscripts',
    install: function () { reinstallHourlyTrigger_('scoreSeanTranscripts', 4); },
    label: 'Sean auto-scoring trigger',
    pauseProperty: 'PAUSE_SEAN_TRIGGER'
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
  return cal.getEvents(dayStart, dayEnd).filter(function (ev) {
    var t = (ev.getTitle() || '').toLowerCase();
    var excluded = CONFIG.CALL_TITLE_EXCLUDE.some(function (k) { return t.indexOf(k) !== -1; });
    if (excluded) return false;
    return CONFIG.CALL_TITLE_INCLUDE.some(function (k) { return t.indexOf(k) !== -1; });
  });
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
