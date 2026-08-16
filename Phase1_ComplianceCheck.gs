/**
 * Phase1_ComplianceCheck.gs
 *
 * Call Tracker Compliance — Phase 1: deterministic prior-day Calendar-vs-tracker
 * compare + quota-guarded escalation email.
 *
 * Per the design brief:
 *  - Runs on a daily time-driven trigger (e.g. 06:00), evaluates the PRIOR day.
 *  - For each rep, collects sales/QC calendar events for the prior day, then
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
 *  - Timezone: all date math via Utilities.formatDate(...,
 *    Session.getScriptTimeZone(), ...); dates displayed DD/MM/YYYY.
 *  - Every compliance decision is logged (Logger.log) per row.
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
  KRIS_EMAIL: 'kris@iconsofrealestate.com',      // TODO: confirm exact address
  TOMAS_EMAIL: 'tomas@iconsofrealestate.com',
  OPS_ALERT_EMAIL: 'kris@iconsofrealestate.com', // quota/ops alerts go here

  // Keep this many recipients of quota in reserve for ops alerts; if remaining
  // quota minus recipients-needed drops below this, skip rep emails and send
  // one ops alert instead.
  QUOTA_RESERVE: 5,

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
      email: 'bens@iconsofrealestate.com', // TODO: confirm
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
      email: 'joana@iconsofrealestate.com', // TODO: confirm
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
      email: 'sean@iconsofrealestate.com', // TODO: confirm
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
 * Daily compliance check. Intended trigger: time-driven, day timer, 6am–7am,
 * so "prior day" is always a complete day.
 */
function runDailyComplianceCheck() {
  var tz = Session.getScriptTimeZone();
  var prior = new Date();
  prior.setDate(prior.getDate() - 1);
  var priorDay = Utilities.formatDate(prior, tz, 'dd/MM/yyyy');
  Logger.log('=== Compliance check for prior day ' + priorDay + ' (tz ' + tz + ') ===');

  var dayStart = startOfDay_(prior, tz);
  var dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  CONFIG.REPS.forEach(function (repCfg) {
    try {
      checkRep_(repCfg, dayStart, dayEnd, priorDay, tz);
    } catch (e) {
      // One rep's failure must not kill the others.
      Logger.log('ERROR checking rep ' + repCfg.name + ': ' + e);
      sendOpsAlert_('Compliance check error for ' + repCfg.name,
        'Rep ' + repCfg.name + ' could not be checked for ' + priorDay + '.\n\n' + e);
    }
  });
}

// ---------------------------------------------------------------------------
// Per-rep logic
// ---------------------------------------------------------------------------

function checkRep_(repCfg, dayStart, dayEnd, priorDay, tz) {
  var events = getRepCallEvents_(repCfg, dayStart, dayEnd);
  Logger.log(repCfg.name + ': ' + events.length + ' sales/QC calendar event(s) on ' + priorDay);
  if (events.length === 0) return;

  var allRows = getAllTrackerRows_(repCfg, priorDay, tz);
  var loggedRows = allRows.filter(function (r) { return r.logged; });
  Logger.log(repCfg.name + ': ' + loggedRows.length + ' logged tracker row(s) for ' + priorDay +
    ' (' + allRows.length + ' total row(s) for the day)');

  var missing = [];
  events.forEach(function (ev) {
    // Compliance = matched to a LOGGED row. Unlogged rows may get an ID
    // backfill below, but the call still counts as not-logged for the email.
    var hit = findMatch_(ev, loggedRows);
    if (hit) {
      Logger.log('  match? event="' + ev.title + '" → LOGGED (row ' + hit.rowIndex + ', via ' + hit.via + ')');
      stampMatch_(hit);
    } else {
      Logger.log('  match? event="' + ev.title + '" → NOT LOGGED');
      missing.push(ev);
      // Still try to enrich an UNLOGGED row with the event ID: it makes
      // tomorrow's match exact-key and builds the Phase 0 join data.
      var anyHit = findMatch_(ev, allRows);
      if (anyHit && !anyHit.logged) {
        Logger.log('    ↳ unlogged row ' + anyHit.rowIndex + ' found via ' + anyHit.via +
          ' — backfilling Calendar Event ID');
        stampMatch_(anyHit);
      }
    }
  });

  if (missing.length === 0) {
    Logger.log(repCfg.name + ': fully compliant for ' + priorDay);
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

  return cal.getEvents(dayStart, dayEnd)
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

    var repName = col.rep !== -1 && row[col.rep]
      ? String(row[col.rep]).trim()
      : repCfg.defaultRepName;
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
 */
function stampMatch_(hit) {
  var row = hit.row;
  if (!row || !row.sheet) return;
  try {
    if (row.eventIdCol !== -1 && !row.eventId && row.matchedEvent) {
      row.sheet.getRange(row.rowIndex, row.eventIdCol + 1).setValue(row.matchedEvent.id);
    }
    if (row.matchMethodCol !== -1) {
      var method = hit.via === 'calendar_event_id' ? 'exact_key' : 'fallback_heuristic';
      row.sheet.getRange(row.rowIndex, row.matchMethodCol + 1).setValue(method);
    }
  } catch (e) {
    // A failed write-back must never break the compliance check itself.
    Logger.log('    ↳ write-back failed for row ' + row.rowIndex + ': ' + e);
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function sendComplianceEmail_(repCfg, missingEvents, priorDay, tz) {
  var n = missingEvents.length;
  var trackerUrl = 'https://docs.google.com/spreadsheets/d/' + repCfg.spreadsheetId + '/edit';

  var subject = '[Action needed] Update your sales tracker — ' + n +
    ' call(s) from ' + priorDay + ' not logged';

  var lines = missingEvents.map(function (ev) {
    var time = Utilities.formatDate(ev.start, tz, 'HH:mm');
    return '• ' + ev.prospectGuess + ' — ' + time + ' — ' + ev.title;
  });

  var body =
    'Hi ' + repCfg.name + ',\n\n' +
    'Your calendar shows ' + n + ' sales/QC call(s) on ' + priorDay +
    ' with no matching outcome in your tracker:\n' +
    lines.join('\n') + '\n\n' +
    'Please add the outcome (Sold / Not Sold / Follow-up / No-show) and any notes today ' +
    'so it can be scored.\n\n' +
    'Tracker: ' + trackerUrl + '\n\n' +
    '— This is an automated check. This email was drafted by AI and sent automatically; ' +
    'reply to Kris or Tomás with any issues.';

  var recipientsNeeded = 3; // rep + Kris + Tomás (CC counts against recipient quota)
  guardedSend_(repCfg.email, subject, body, {
    cc: CONFIG.KRIS_EMAIL + ',' + CONFIG.TOMAS_EMAIL,
    name: 'Call Tracker Compliance Bot'
  }, recipientsNeeded);
  Logger.log('Sent compliance email to ' + repCfg.email + ' for ' + n + ' unlogged call(s).');
}

function sendOpsAlert_(subject, body) {
  try {
    guardedSend_(CONFIG.OPS_ALERT_EMAIL, '[Compliance bot] ' + subject, body, {}, 1);
  } catch (e) {
    Logger.log('FAILED to send ops alert: ' + e);
  }
}

/**
 * Quota guard per the brief: check MailApp.getRemainingDailyQuota() before
 * every send, keep QUOTA_RESERVE in reserve, and alert ops (never throw
 * mid-loop) when quota is short.
 */
function guardedSend_(to, subject, body, options, recipientsNeeded) {
  var remaining = MailApp.getRemainingDailyQuota();
  if (remaining - recipientsNeeded < CONFIG.QUOTA_RESERVE) {
    Logger.log('QUOTA SHORT: remaining=' + remaining + ', needed=' + recipientsNeeded +
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
  var parsed = new Date(v);
  if (!isNaN(parsed)) {
    return Utilities.formatDate(parsed, tz, 'dd/MM/yyyy');
  }
  Logger.log('  unparseable date cell: "' + v + '"');
  return String(v).trim();
}

/** Google event ids look like "abc123@google.com"; rows may store with or without the suffix. */
function idsEqual_(rowId, eventId) {
  var strip = function (s) { return String(s).replace(/@google\.com$/i, '').trim(); };
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
  return new Date(s + ' 00:00:00');
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
  'Reviewed By Kris',       // T
  'Queue Age'               // U  (days)
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
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName('Sales Call Log');

  if (!sheet) {
    sheet = ss.insertSheet('Sales Call Log');
    Logger.log('Created "Sales Call Log" tab.');
  } else {
    Logger.log('"Sales Call Log" tab already exists — validating.');
  }

  // Headers
  var headerRange = sheet.getRange(1, 1, 1, SALES_CALL_LOG_HEADERS.length);
  var existing = headerRange.getValues()[0];
  var headersPresent = existing[0] === SALES_CALL_LOG_HEADERS[0];
  if (!headersPresent) {
    headerRange.setValues([SALES_CALL_LOG_HEADERS]);
    Logger.log('Wrote ' + SALES_CALL_LOG_HEADERS.length + ' headers.');
  }
  headerRange.setFontWeight('bold').setBackground('#e8eef7');
  sheet.setFrozenRows(1);

  // Data validation: Rep (E), Call Type (F), Outcome Disposition (H), Match Method (L)
  setDropdown_(sheet, 5, ['Bens', 'Joana', 'Sean']);
  setDropdown_(sheet, 6, ['QC', 'Sales Call', 'Discovery']);
  setDropdown_(sheet, 8, ['Sold', 'Not Sold', 'Follow-up', 'No-show']);
  setDropdown_(sheet, 12, ['exact_key', 'fallback_heuristic', 'no_match']);

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
    Logger.log('Inserted ' + sample.length + ' sample rows for 14/08/2026 (Andrea Brunson is logged; the rest are intentionally not).');
  } else {
    Logger.log('Rows already exist — no sample data inserted.');
  }

  sheet.autoResizeColumns(1, SALES_CALL_LOG_HEADERS.length);
  Logger.log('Setup complete. Point all rep configs at sheetName "Sales Call Log" and run dryRunComplianceCheck with a -2 day offset to validate against 14/08.');
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
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName('Sales Call Log');
  if (!sheet) { Logger.log('No Sales Call Log tab.'); return; }
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
        Logger.log('Cleared stray write-back on row ' + r);
        cleared++;
      }
    }
  }
  Logger.log(cleared ? 'Cleared ' + cleared + ' stray row(s).' : 'No stray write-backs found.');
}

/**
 * One-time: fill Prospect Email on the sample rows so attendee-email matching
 * can be validated. Matches by prospect name — safe to re-run, only fills
 * empty email cells.
 */
function fillSampleEmails() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName('Sales Call Log');
  if (!sheet) { Logger.log('No Sales Call Log tab — run setupSalesCallLog first.'); return; }

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
      Logger.log('Row ' + (i + 2) + ': ' + names[i][0] + ' → ' + EMAILS[key]);
      filled++;
    }
  }
  Logger.log(filled ? 'Filled ' + filled + ' email(s).' : 'Nothing to fill (already set or rows not found).');
}

// ---------------------------------------------------------------------------
// One-time setup helpers (run manually from the editor)
// ---------------------------------------------------------------------------

/** Install the daily 06:00–07:00 trigger. Run once. */
function installDailyTrigger() {
  // Remove any existing copies first so we don't double-fire.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDailyComplianceCheck') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('runDailyComplianceCheck')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
  Logger.log('Daily trigger installed for runDailyComplianceCheck at 06:00 script time.');
}

/**
 * Diagnostic: dump exactly what getAllTrackerRows_ sees for 14/08 — every
 * candidate row with its identity fields, and the full raw first 12 rows.
 * Run this when matching misbehaves.
 */
function debugDumpTrackerRows() {
  var tz = Session.getScriptTimeZone();
  var repCfg = CONFIG.REPS[1]; // Joana — her sample rows are the test case
  var rows = getAllTrackerRows_(repCfg, '14/08/2026', tz);
  Logger.log('Candidate rows for Joana on 14/08/2026: ' + rows.length);
  rows.forEach(function (r) {
    Logger.log('  row ' + r.rowIndex + ': prospect="' + r.prospect + '" email="' + r.email +
      '" eventId="' + r.eventId + '" logged=' + r.logged);
  });

  // Raw dump of the first 12 rows x 12 cols so we can see anything unexpected.
  var ss = SpreadsheetApp.openById(repCfg.spreadsheetId);
  var sheet = ss.getSheetByName('Sales Call Log');
  var raw = sheet.getRange(1, 1, 12, 12).getValues();
  Logger.log('--- raw A1:L12 ---');
  raw.forEach(function (row, i) {
    Logger.log('  R' + (i + 1) + ': ' + JSON.stringify(row));
  });
}

/**
 * Diagnostic: dump guest lists for all call events on 14/08/2026.
 * Answers: do bare "QC" events carry the prospect's email as a guest?
 * Run once before enabling attendee-email matching.
 */
function debugListEventGuests() {
  var tz = Session.getScriptTimeZone();
  var target = new Date(2026, 7, 14); // 14/08/2026
  var dayStart = startOfDay_(target, tz);
  var dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  CONFIG.REPS.forEach(function (repCfg) {
    var events = getRepCallEventsRaw_(repCfg, dayStart, dayEnd);
    Logger.log('--- ' + repCfg.name + ' ---');
    events.forEach(function (ev) {
      var guests = ev.getGuestList().map(function (g) { return g.getEmail(); });
      Logger.log('  "' + ev.getTitle() + '" @ ' +
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
  var tz = Session.getScriptTimeZone();
  var target = new Date(2026, 7, 14); // 14/08/2026 — month is 0-based
  var dayStr = Utilities.formatDate(target, tz, 'dd/MM/yyyy');
  var dayStart = startOfDay_(target, tz);
  var dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  CONFIG.REPS.forEach(function (repCfg) {
    try {
      var events = getRepCallEvents_(repCfg, dayStart, dayEnd);
      var allRows = getAllTrackerRows_(repCfg, dayStr, tz);
      var loggedRows = allRows.filter(function (r) { return r.logged; });
      var missing = events.filter(function (ev) {
        var hit = findMatch_(ev, loggedRows);
        Logger.log('  [' + repCfg.name + '] "' + ev.title + '" → ' +
          (hit ? 'LOGGED (row ' + hit.rowIndex + ' via ' + hit.via + ')' : 'NOT LOGGED'));
        return !hit;
      });
      Logger.log('[DEBUG ' + dayStr + '] ' + repCfg.name + ': ' + events.length +
        ' event(s), ' + loggedRows.length + ' logged row(s), ' + missing.length + ' MISSING');
    } catch (e) {
      Logger.log('[DEBUG] ERROR for ' + repCfg.name + ': ' + e);
    }
  });
}

/** Dry run: logs what WOULD be emailed for the prior day, sends nothing. */
function dryRunComplianceCheck() {
  var tz = Session.getScriptTimeZone();
  var prior = new Date();
  prior.setDate(prior.getDate() - 1);
  var priorDay = Utilities.formatDate(prior, tz, 'dd/MM/yyyy');
  var dayStart = startOfDay_(prior, tz);
  var dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  CONFIG.REPS.forEach(function (repCfg) {
    try {
      var events = getRepCallEvents_(repCfg, dayStart, dayEnd);
      var allRows = getAllTrackerRows_(repCfg, priorDay, tz);
      var loggedRows = allRows.filter(function (r) { return r.logged; });
      var missing = events.filter(function (ev) { return !findMatch_(ev, loggedRows); });
      Logger.log('[DRY RUN] ' + repCfg.name + ' @ ' + priorDay + ': ' +
        events.length + ' event(s), ' + loggedRows.length + ' logged row(s), ' +
        missing.length + ' MISSING → ' +
        (missing.length ? missing.map(function (m) { return m.title; }).join(' | ') : '(none)'));
    } catch (e) {
      Logger.log('[DRY RUN] ERROR for ' + repCfg.name + ': ' + e);
    }
  });
}
