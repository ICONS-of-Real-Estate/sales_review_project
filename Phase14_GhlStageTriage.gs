/**
 * Phase14_GhlStageTriage.gs
 *
 * Kris, 05/09/2026: pointing the GHL hygiene idea at GHL's own activity data
 * "would resolve most of the 88 without needing anyone's inbox" — and then:
 * "Can't you put that together as a suggestion so Tomas can just quickly
 * approve or reject?"
 *
 * This is that tool. For every GHL opportunity sitting in a non-terminal
 * stage that hasn't moved in a while, it looks at what GHL itself already
 * knows — last note, last conversation, whether a future appointment exists
 * — and writes ONE suggested resolution per opportunity to a review sheet,
 * with an Approved/Rejected checkbox pair. Tomás (or Joana) ticks a box;
 * nothing else happens automatically.
 *
 * DELIBERATELY NOT auto-applied. Approving here does not move a GHL stage —
 * that write is a real, hard-to-audit action on shared pipeline data (moving
 * a deal is not "fill a blank cell," it changes what every report about that
 * pipeline means), and Kris's own standing rule this session is "everything
 * logged, everything undoable" (GHL_MIGRATION_PLAN.md §8, the Phase 12
 * precedent). A suggestion Tomás can reject with one click, that writes
 * nothing until he's looked at it, is the version of "automate the fuck out
 * of everything" that can't make a stuck pipeline worse. A gated
 * apply-approved-suggestions writer is the natural next step once this has
 * been used for real and its suggestions have proven trustworthy — not
 * built here.
 *
 * Read-only against GHL. The only write is appending rows to this file's own
 * review sheet (a brand-new sheet, so there is nothing on it to overwrite —
 * re-running just adds newly-stale opportunities and never touches a row a
 * human has already decided on, see rowAlreadyTriaged_ below).
 */

var GHL_STAGE_TRIAGE_CONFIG = {
  // A stage is "stale" once it's sat untouched this many days. GHL's own
  // "Updated on" per-opportunity timestamp is what this measures against —
  // confirmed live to exist per-opportunity (distinct from the per-PIPELINE
  // "Updated on" GHL_PIPELINE_MAP.md already warned isn't a usage signal).
  STALE_AFTER_DAYS: 21,

  // Terminal stages are excluded outright — a closed deal isn't "stuck,"
  // it's finished. Matched by substring against the stage name returned by
  // fetchGhlPipelines_, same pattern as ghlStageLooksBooked_/
  // ghlStageToOutcomeDisposition_ above, so a stage rename doesn't silently
  // break this (a hardcoded ID list would).
  TERMINAL_STAGE_PATTERN: /closed/i,

  // Same reasoning as GHL_HYGIENE_CONFIG.LOOKAHEAD — how far into a rep's
  // calendar to look before concluding "no real future appointment."
  FUTURE_APPOINTMENT_LOOKAHEAD_DAYS: 21,

  // Same 5-minute margin as every other full-scan job in this codebase.
  TIME_BUDGET_MS: 5 * 60 * 1000,

  // Cap for a first real run. null/0 = no limit — same "prove it on a small
  // batch first, then raise" pattern as GHL_NOTE_SYNC_CONFIG.MAX_ROWS_PER_RUN.
  MAX_OPPORTUNITIES_PER_RUN: 25
};

var GHL_STAGE_TRIAGE_SHEET_NAME = 'GHL Stage Triage';
var GHL_STAGE_TRIAGE_HEADERS = [
  'Timestamp', 'Contact Name', 'Contact ID', 'Opportunity ID', 'Pipeline',
  'Current Stage', 'Days Since Update', 'Last GHL Activity', 'Suggested Action',
  'Reasoning', 'Approved', 'Rejected'
];

function getOrCreateGhlStageTriageSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(GHL_STAGE_TRIAGE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(GHL_STAGE_TRIAGE_SHEET_NAME);
    sheet.getRange(1, 1, 1, GHL_STAGE_TRIAGE_HEADERS.length).setValues([GHL_STAGE_TRIAGE_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    // Deliberately NOT pre-formatting checkboxes across a big empty range
    // here. Real bug hit live (05/09/2026): pre-inserting checkboxes over
    // 998 blank rows made getLastRow() report those rows as "having
    // content" even with every cell blank — the exact gotcha
    // Phase1_ComplianceCheck.gs:663-668 already documents for
    // insertCheckboxes(). That pushed the first real batch of suggestions
    // down to row 1000 instead of row 2. Checkboxes are now inserted only
    // on the specific rows just written (see previewGhlStageTriage_), so
    // there's never a blank-but-"occupied" row for getLastRow() to see.
  }
  return sheet;
}

/**
 * The next row to write real data to, computed from the Opportunity ID
 * column (D) actually containing something — NOT sheet.getLastRow(), which
 * checkbox formatting (or any other cell formatting with no value) can
 * inflate past the real last row of content. See the comment above.
 */
function nextGhlStageTriageWriteRow_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 2;
  var ids = sheet.getRange(2, 4, lastRow - 1, 1).getValues();
  for (var r = ids.length - 1; r >= 0; r--) {
    if (String(ids[r][0] || '').trim()) return r + 3; // +2 for 1-based/header, +1 for "next"
  }
  return 2; // every row so far is blank
}

/**
 * Pure. GHL's raw per-opportunity `updatedAt`/similar to "days since", plus
 * the terminal-stage exclusion. Kept separate from the API call so it's
 * testable with a fixed `nowMs` instead of the real clock.
 */
function ghlOpportunityStaleDays_(opportunity, nowMs) {
  var updated = opportunity.updatedAt || opportunity.lastStatusChangeAt || opportunity.dateAdded;
  if (!updated) return null;
  var updatedMs = new Date(updated).getTime();
  if (isNaN(updatedMs)) return null;
  return Math.floor((nowMs - updatedMs) / (24 * 3600000));
}

/** Pure. True when a stage name matches the terminal pattern (Closed Won/Lost). */
function ghlStageIsTerminal_(stageName) {
  return GHL_STAGE_TRIAGE_CONFIG.TERMINAL_STAGE_PATTERN.test(String(stageName || ''));
}

/**
 * Pure. The actual suggestion logic — turns "this opportunity is stale" plus
 * whatever GHL activity we found into ONE concrete, human-readable suggested
 * action and the reasoning behind it. Every branch names the evidence, never
 * just "looks stuck" — Tomás rejecting a suggestion he can't see the reason
 * for is worse than not suggesting anything.
 *
 * `activity` is {lastNoteDate, lastConversationDate, hasFutureAppointment} —
 * whichever of those came back null/false just isn't asserted about.
 */
function buildGhlStageTriageSuggestion_(context) {
  var stageLower = String(context.stageName || '').toLowerCase();
  var a = context.activity || {};
  var mostRecentTouch = [a.lastNoteDate, a.lastConversationDate].filter(Boolean).sort().pop();

  if (a.hasFutureAppointment) {
    return {
      action: 'Leave as-is — real future appointment exists',
      reasoning: 'A calendar event is booked ahead; the stage is stale but the lead is not.'
    };
  }

  if (/booked/.test(stageLower) && !mostRecentTouch) {
    return {
      action: 'Move to a "Not Taken"/No-Show stage, or re-engage',
      reasoning: '"' + context.stageName + '" implies a call is waiting to happen, but there is no future ' +
        'appointment AND no note or conversation logged since — ' + context.staleDays + ' day(s) untouched. ' +
        'Matches the pattern GHL_PIPELINE_MAP.md flagged as the largest blind spot: a stale "Booked" stage ' +
        'usually means the call already happened (and wasn\'t taken) or never will.'
    };
  }

  if (mostRecentTouch) {
    return {
      action: 'Needs a human look — has activity, but stalled',
      reasoning: 'Last touched ' + mostRecentTouch + ' (note or conversation), no future appointment, ' +
        context.staleDays + ' day(s) since the stage last changed. Something happened but the pipeline ' +
        'was never moved to reflect it.'
    };
  }

  return {
    action: 'Needs a human look — no activity found at all',
    reasoning: context.staleDays + ' day(s) untouched, no note, no conversation, no future appointment. ' +
      'Either dead or activity is logged somewhere this scan can\'t see (matches GHL_PIPELINE_MAP.md §E: ' +
      'not every real lead\'s history lives inside GHL).'
  };
}

/**
 * Pure. Has a human already decided on this exact opportunity? Checked
 * against the sheet's own OPPORTUNITY ID (col D) — never re-suggests, never
 * overwrites a decision. A re-run only ever ADDS newly-stale opportunities.
 */
function ghlStageTriageAlreadyDecided_(existingOpportunityIds, opportunityId) {
  return existingOpportunityIds.indexOf(opportunityId) !== -1;
}

/** Reads the review sheet's existing Opportunity ID column, so a re-run never duplicates a row. */
function readExistingGhlStageTriageOpportunityIds_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 4, lastRow - 1, 1).getValues()
    .map(function (r) { return String(r[0] || '').trim(); })
    .filter(function (id) { return !!id; }); // exclude blank/checkbox-formatted rows — see nextGhlStageTriageWriteRow_
}

/**
 * One GHL API call — lists opportunities in one pipeline that are NOT in a
 * terminal stage, newest activity last. Best-effort against an unconfirmed
 * shape (this endpoint's snake_case quirk is already documented at
 * ghlListOpportunitiesForContact_ above) — logs full status/body on
 * failure rather than assuming.
 *
 * Single page only (`limit`, no cursor) — GHL v2's pagination shape for this
 * endpoint hasn't been confirmed live yet. A pipeline with more open
 * opportunities than `limit` will only surface its first page; the log says
 * so explicitly rather than silently under-reporting.
 */
function ghlListOpenOpportunitiesInPipeline_(locationId, pipelineId, limit) {
  var path = '/opportunities/search?location_id=' + encodeURIComponent(locationId) +
    '&pipeline_id=' + encodeURIComponent(pipelineId) + '&limit=' + encodeURIComponent(limit || 100);
  var res = ghlApiGet_(path);
  if (res.status !== 200) {
    return { ok: false, status: res.status, body: res.body, url: res.url, opportunities: [] };
  }
  var opps = (res.json && (res.json.opportunities || res.json.data)) || [];
  return { ok: true, opportunities: opps, possiblyTruncated: opps.length >= (limit || 100) };
}

/** Best-effort: most recent note date on a contact, or null. Never throws — a lookup failure just means "no evidence found," not "definitely no activity." */
function ghlMostRecentNoteDate_(contactId) {
  var res = ghlApiGet_('/contacts/' + encodeURIComponent(contactId) + '/notes');
  if (res.status !== 200) return null;
  var notes = (res.json && (res.json.notes || res.json.data)) || [];
  var dates = notes.map(function (n) { return n.dateAdded || n.createdAt; }).filter(Boolean);
  return dates.length ? dates.sort().pop() : null;
}

/** Best-effort: most recent conversation activity date on a contact, or null. */
function ghlMostRecentConversationDate_(locationId, contactId) {
  var res = ghlApiGet_('/conversations/search?locationId=' + encodeURIComponent(locationId) +
    '&contactId=' + encodeURIComponent(contactId));
  if (res.status !== 200) return null;
  var convos = (res.json && (res.json.conversations || res.json.data)) || [];
  var dates = convos.map(function (c) { return c.lastMessageDate || c.dateUpdated; }).filter(Boolean);
  return dates.length ? dates.sort().pop() : null;
}

/** Apps Script's "Select function to run" dropdown hides trailing-underscore functions. */
function previewGhlStageTriage() {
  return previewGhlStageTriage_();
}

/**
 * ONE-TIME REPAIR, safe to run any number of times. Fixes the live fallout
 * of the checkbox/getLastRow() bug above: the first real run (05/09/2026)
 * wrote its 25 suggestions starting at row 1000 instead of row 2, because
 * 998 checkbox-formatted-but-blank rows made getLastRow() think they held
 * content. This deletes only rows whose Opportunity ID (col D) is blank AND
 * that sit ABOVE the first row that actually has one — i.e. exactly the
 * accidental padding, never a row with real data, never a row below the
 * real data (a genuinely blank row there would be a different problem this
 * function correctly leaves alone). Logs what it did either way.
 */
function repairGhlStageTriagePadding() {
  RUN_TAG = 'repairGhlStageTriagePadding';
  var sheet = getOrCreateGhlStageTriageSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { log_('Sheet has no data rows — nothing to repair.'); return; }

  var ids = sheet.getRange(2, 4, lastRow - 1, 1).getValues();
  var firstRealOffset = -1;
  for (var r = 0; r < ids.length; r++) {
    if (String(ids[r][0] || '').trim()) { firstRealOffset = r; break; }
  }
  if (firstRealOffset <= 0) {
    log_(firstRealOffset === 0
      ? 'No padding found — real data already starts at row 2. Nothing to do.'
      : 'No row has an Opportunity ID at all — nothing to repair (or nothing has been written yet).');
    return;
  }

  var padStartRow = 2;
  var padRowCount = firstRealOffset; // rows [2 .. 2+firstRealOffset-1] are blank padding
  sheet.deleteRows(padStartRow, padRowCount);
  log_('Deleted ' + padRowCount + ' blank padding row(s) (rows ' + padStartRow + '-' +
    (padStartRow + padRowCount - 1) + ') so real suggestions now start at row 2. ' +
    'Nothing with a real Opportunity ID was touched.');
}

/**
 * READ-ONLY against GHL. WRITES to the "GHL Stage Triage" sheet only (a
 * brand-new sheet — see the file header for why that's safe). No email, no
 * GHL write, no stage ever moved.
 */
function previewGhlStageTriage_() {
  RUN_TAG = 'previewGhlStageTriage_';
  var started = Date.now();
  var locationId = ghlCheckSetup_();

  var pipelines = fetchGhlPipelines_(locationId);
  if (!pipelines) { log_('Could not fetch pipelines — see the diagnostic above. Nothing written.'); return; }

  var sheet = getOrCreateGhlStageTriageSheet_();
  var existingIds = readExistingGhlStageTriageOpportunityIds_(sheet);
  log_(existingIds.length + ' opportunity(s) already have a Tomás/Joana decision on the "' +
    GHL_STAGE_TRIAGE_SHEET_NAME + '" sheet — those are never re-suggested or overwritten.');

  var now = new Date();
  var newRows = [];
  var scanned = 0, suggested = 0;
  var calendarEventsByRep = {};
  var cap = GHL_STAGE_TRIAGE_CONFIG.MAX_OPPORTUNITIES_PER_RUN;

  outer:
  for (var p = 0; p < pipelines.length; p++) {
    var pipeline = pipelines[p];
    var list = ghlListOpenOpportunitiesInPipeline_(locationId, pipeline.id, 100);
    if (!list.ok) {
      log_('Pipeline "' + pipeline.name + '": opportunity list FAILED, HTTP ' + list.status +
        ' — ' + String(list.body).slice(0, 300));
      continue;
    }
    if (list.possiblyTruncated) {
      log_('Pipeline "' + pipeline.name + '": ' + list.opportunities.length +
        ' open opportunity(s) returned, possibly truncated (single-page fetch) — see file header.');
    }

    for (var i = 0; i < list.opportunities.length; i++) {
      if (Date.now() - started > GHL_STAGE_TRIAGE_CONFIG.TIME_BUDGET_MS) {
        log_('Time budget reached — stopping mid-scan. Re-run to continue with the rest.');
        break outer;
      }
      if (cap && suggested >= cap) {
        log_('MAX_OPPORTUNITIES_PER_RUN (' + cap + ') reached — stopping here. Re-run to continue.');
        break outer;
      }

      var opp = list.opportunities[i];
      var stageInfo = pipeline.stages && pipeline.stages.filter(function (s) { return s.id === opp.pipelineStageId; })[0];
      var stageName = (stageInfo && stageInfo.name) || opp.pipelineStageId || '(unknown stage)';
      if (ghlStageIsTerminal_(stageName)) continue;

      var staleDays = ghlOpportunityStaleDays_(opp, now.getTime());
      if (staleDays === null || staleDays < GHL_STAGE_TRIAGE_CONFIG.STALE_AFTER_DAYS) continue;

      scanned++;
      var oppId = String(opp.id || '');
      if (ghlStageTriageAlreadyDecided_(existingIds, oppId)) continue;

      var contactId = opp.contactId || (opp.contact && opp.contact.id) || '';
      var contactName = (opp.contact && opp.contact.name) ||
        (opp.name || opp.contactId || '(unknown contact)');

      var activity = {
        lastNoteDate: contactId ? ghlMostRecentNoteDate_(contactId) : null,
        lastConversationDate: contactId ? ghlMostRecentConversationDate_(locationId, contactId) : null,
        hasFutureAppointment: contactId ?
          ghlHasFutureCalendarEvent_(opp.assignedTo || '', contactName, now, calendarEventsByRep) : false
      };

      var suggestion = buildGhlStageTriageSuggestion_({
        stageName: stageName, staleDays: staleDays, activity: activity
      });

      var lastActivityLabel = [activity.lastNoteDate, activity.lastConversationDate]
        .filter(Boolean).sort().pop() || '(none found)';

      newRows.push([
        new Date(), contactName, contactId, oppId, pipeline.name, stageName, staleDays,
        lastActivityLabel, suggestion.action, suggestion.reasoning, false, false
      ]);
      suggested++;
      Utilities.sleep(250); // polite pacing — up to 3 GHL calls per suggested opportunity
    }
  }

  if (newRows.length) {
    var writeRow = nextGhlStageTriageWriteRow_(sheet);
    sheet.getRange(writeRow, 1, newRows.length, GHL_STAGE_TRIAGE_HEADERS.length).setValues(newRows);
    // Checkboxes on just these rows' Approved/Rejected cells — never a big
    // empty range ahead of real data, see getOrCreateGhlStageTriageSheet_.
    sheet.getRange(writeRow, 11, newRows.length, 2).insertCheckboxes();
  }

  log_('Scanned ' + scanned + ' stale, non-terminal opportunity(s) (>' +
    GHL_STAGE_TRIAGE_CONFIG.STALE_AFTER_DAYS + ' days untouched) not already decided. ' +
    'Wrote ' + newRows.length + ' new suggestion(s) to "' + GHL_STAGE_TRIAGE_SHEET_NAME + '".');
  log_('Nothing in GHL was changed. Tomás/Joana tick Approved or Rejected per row on that sheet — ' +
    'ticking a box does not move anything in GHL yet; it is a decision log for now.');
}
