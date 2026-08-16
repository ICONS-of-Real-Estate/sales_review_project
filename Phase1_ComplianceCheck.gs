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
      sheetName: null, // null → try shared tab, else first sheet
      // Header names as they appear in THIS rep's sheet. Brief §2 target
      // names are listed first; current real headers as fallbacks.
      columns: {
        prospectName: ['Prospect Name', 'Name'],
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
      // Joana has no tracker of her own yet per the brief; point her at the
      // shared log spreadsheet once it exists. Until then her rows can live
      // as Rep=Joana rows in the shared tab of this spreadsheet.
      spreadsheetId: '1bK0VbgP3xdK5LhfYqO0fps9ivJzPDn3fsDcsl1dEBM4', // TODO: replace with shared-log spreadsheet id
      sheetName: null,
      columns: {
        prospectName: ['Prospect Name', 'Name'],
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
      spreadsheetId: '1bK0VbgP3xdK5LhfYqO0fps9ivJzPDn3fsDcsl1dEBM4', // TODO: replace with shared-log spreadsheet id
      sheetName: null,
      columns: {
        prospectName: ['Prospect Name', 'Name'],
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

  var loggedRows = getLoggedRows_(repCfg, priorDay, tz);
  Logger.log(repCfg.name + ': ' + loggedRows.length + ' logged tracker row(s) for ' + priorDay);

  var missing = events.filter(function (ev) {
    var hit = findMatch_(ev, loggedRows);
    Logger.log('  match? event="' + ev.title + '" id=' + ev.id +
      ' → ' + (hit ? 'LOGGED (row ' + hit.rowIndex + ', via ' + hit.via + ')' : 'NOT LOGGED'));
    return !hit;
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
        prospectGuess: guessProspectFromTitle_(ev.getTitle() || '')
      };
    });
}

/**
 * Read the rep's tracker rows and return those for the prior day with
 * Outcome Logged = TRUE (or truthy ✓/timestamp). Each entry carries the row
 * index and the fields we match on.
 */
function getLoggedRows_(repCfg, priorDay, tz) {
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
  // callDate may be -1: some sheets only get a Call Date column in Phase 0;
  // without it we can't date-filter rows, so treat all logged rows as candidates.

  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var loggedRaw = col.outcomeLogged !== -1 ? row[col.outcomeLogged] : '';
    if (!isTruthyOutcome_(loggedRaw)) continue;

    var rowDateStr = '';
    if (col.callDate !== -1 && row[col.callDate] !== '' && row[col.callDate] != null) {
      rowDateStr = formatDateCell_(row[col.callDate], tz);
    }
    if (col.callDate !== -1 && rowDateStr !== priorDay) continue; // wrong day

    var repName = col.rep !== -1 && row[col.rep]
      ? String(row[col.rep]).trim()
      : repCfg.defaultRepName;
    if (repName.toLowerCase() !== repCfg.name.toLowerCase()) continue; // shared tab: only this rep's rows

    rows.push({
      rowIndex: r + 1, // 1-based, for logging
      prospect: normalize_(String(row[col.prospectName] || '')),
      eventId: col.calendarEventId !== -1 ? String(row[col.calendarEventId] || '').trim() : '',
      callType: col.callType !== -1 ? String(row[col.callType] || '').trim() : ''
    });
  }
  return rows;
}

/**
 * Deterministic match: exact Calendar Event ID first; fall back to normalized
 * prospect name (substring-tolerant, since calendar titles rarely equal the
 * tracker's prospect cell exactly).
 */
function findMatch_(ev, loggedRows) {
  for (var i = 0; i < loggedRows.length; i++) {
    if (loggedRows[i].eventId && idsEqual_(loggedRows[i].eventId, ev.id)) {
      return { rowIndex: loggedRows[i].rowIndex, via: 'calendar_event_id' };
    }
  }
  var evProspect = normalize_(ev.prospectGuess);
  var evTitle = normalize_(ev.title);
  for (var j = 0; j < loggedRows.length; j++) {
    var p = loggedRows[j].prospect;
    if (!p) continue;
    if (evTitle.indexOf(p) !== -1 || (evProspect && p.indexOf(evProspect) !== -1) ||
        (evProspect && evProspect.indexOf(p) !== -1)) {
      return { rowIndex: loggedRows[j].rowIndex, via: 'prospect_name_fallback' };
    }
  }
  return null;
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
      var loggedRows = getLoggedRows_(repCfg, priorDay, tz);
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
