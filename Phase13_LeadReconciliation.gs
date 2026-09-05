/**
 * Phase13_LeadReconciliation.gs
 *
 * "I want to build a tool to do an analysis of all spreadsheets you have, to
 * make sure all data and all leads are in GHL" — Kris, 05/09/2026, as part
 * of the everything-in-GHL migration (GHL_MIGRATION_PLAN.md).
 *
 * READ-ONLY AGAINST GHL — this never writes to GHL, only searches it. It
 * answers one question: for every lead named in any spreadsheet this project
 * knows about, is that lead in GHL? The output is a three-way classification
 * per lead:
 *
 *   found      — a confident GHL contact match exists
 *   not_found  — searched GHL, nothing plausible came back
 *   ambiguous  — GHL returned more than one plausible match. A human picks;
 *                guessing here is how the wrong lead gets someone else's
 *                call history.
 *
 * WHY THE SPLIT MATTERS. GHL_PIPELINE_MAP.md §E is the precedent: four Sales
 * Call Log rows had no GHL contact, and Tomás confirmed three of them were
 * real leads tracked elsewhere entirely (the podcast-guest route), not data
 * errors. So "not in GHL" is a finding to act on, never evidence that a
 * source spreadsheet is wrong.
 *
 * WHAT THIS WRITES, AND WHAT IT DELIBERATELY DOESN'T. Every not_found/
 * ambiguous lead is written to two review sheets (see
 * writeLeadReconciliationReviewRows_ below) — never to GHL. This is
 * deliberately advisory, not automation: Tomás, 05/09/2026 (relayed by
 * Kris), asked for no more GHL changes until he's organized the CRM himself
 * — "Tomás and Joana will decide if they are real leads or not," never this
 * script. Creating contacts, if it happens at all, is a separate gated step
 * for later, after that review.
 *
 * COST. One GHL search per distinct lead, so this is bounded by the same
 * 5-minute budget as every other full-scan job here, and reuses already-known
 * contact IDs from the GHL Note Sync Log for free before searching for
 * anything.
 */

var LEAD_RECONCILIATION_CONFIG = {
  // Same margin under Apps Script's 6-minute ceiling as
  // GHL_NOTE_SYNC_TIME_BUDGET_MS_ (Phase12_GhlNoteSync.gs). A partial run is
  // safe and expected — re-run to continue.
  TIME_BUDGET_MS: 5 * 60 * 1000,

  // Cap for a first look. null/0 = no limit. Same "prove it on a small batch
  // first" pattern as GHL_NOTE_SYNC_CONFIG.MAX_ROWS_PER_RUN.
  MAX_LEADS_PER_RUN: null
};

/**
 * Every spreadsheet/tab this project knows to contain leads.
 *
 * `spreadsheetId: null` means "the main Sales Call Log spreadsheet"
 * (SALES_CALL_LOG_SPREADSHEET_ID, Phase1_ComplianceCheck.gs) — kept as null
 * rather than repeating the ID so there is one place it's defined.
 *
 * Column names are candidate LISTS, matched case-insensitively via
 * findColumn_ (Phase1_ComplianceCheck.gs), because these tabs are maintained
 * by different people and their headers genuinely differ — Bens's tracker
 * calls it "Name", the Sales Call Log calls it "Prospect Name", the reply
 * tracker calls it "Lead Email". A source whose name column can't be found
 * is REPORTED, never silently skipped: a renamed header is exactly the kind
 * of drift that would otherwise make a whole tab's leads quietly vanish from
 * this audit while it still reported success.
 */
var LEAD_RECONCILIATION_SOURCES = [
  {
    label: 'Sales Call Log',
    spreadsheetId: null,
    tabName: 'Sales Call Log',
    nameColumns: ['Prospect Name'],
    emailColumns: ['Prospect Email']
  },
  {
    label: "Bens's podcast tracker",
    spreadsheetId: null,
    tabName: 'Icons Podcast Recordings',
    nameColumns: ['Name'],
    emailColumns: ['Email']
  },
  {
    // Real bug found live (05/09/2026): 'From' is NOT the prospect's name —
    // Phase8_ReplyTracker.gs:237 documents it as the raw From header of the
    // last message actually FROM the outreach relay/forward address (e.g.
    // "'Joana Peixe' via Network" <network@ardorseo.com>), the SAME text on
    // nearly every row regardless of who the real lead is. Treating it as a
    // name meant ~470 distinct real leads (correctly split apart by their
    // genuinely-distinct Lead Email) all searched GHL for that identical
    // garbage string instead of by their own email, and the review sheets
    // showed that same unreadable text as every one of their "Name" cells.
    // No column in this tab actually holds the prospect's real name — email
    // only.
    label: 'Reply Tracker',
    spreadsheetId: null,
    tabName: 'Reply Tracker',
    nameColumns: [],
    emailColumns: ['Lead Email']
  },
  {
    // The separate podcast-guest tracker named in GHL_PIPELINE_MAP.md §E —
    // where Lucy Quiñones was found after she came back as "no GHL match".
    // Tab name is unknown from here ("Luis's episodes" is one export of it,
    // and other reps likely have their own tabs), so tabName null means
    // "every tab in this spreadsheet", and the run reports what it found.
    label: 'Icons of Real Estate Podcast Tracker (separate file)',
    spreadsheetId: '1EkZ03TUMxWbTu6L7mu08tLHXofNqD79y3hqFdBzcWNE',
    tabName: null,
    nameColumns: ['Name', 'Prospect Name', 'Guest', 'Guest Name'],
    emailColumns: ['Email', 'Email Address', 'Prospect Email']
  }
];

/**
 * Pure. Turns one tab's raw values into lead records.
 *
 * Skips rows with neither a name nor an email — a trailing blank row, or one
 * of the checkbox-extended empty rows getDataRange() returns past real
 * content (the same effect Phase1_ComplianceCheck.gs:663-668 documents).
 */
function collectLeadsFromRows_(values, nameIdx, emailIdx, sourceLabel) {
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var name = nameIdx === -1 ? '' : String(row[nameIdx] || '').trim();
    var email = emailIdx === -1 ? '' : String(row[emailIdx] || '').trim().toLowerCase();
    if (!name && !email) continue;
    out.push({
      name: name,
      email: email,
      source: sourceLabel,
      sourceRow: r + 1
    });
  }
  return out;
}

/**
 * Pure. Collapses the same human appearing in several spreadsheets into one
 * lead to check.
 *
 * Keyed on email when there is one (the only genuinely stable key we have),
 * otherwise normalize_(name). This deliberately does NOT try to merge a
 * name-only record into an email-bearing one for the same person: that's the
 * fuzzy-matching problem this whole file exists to hand to GHL, and doing it
 * badly here would hide a lead rather than report it. Over-reporting a lead
 * twice is a wasted search; under-reporting one loses it.
 */
function dedupeReconciliationLeads_(leads) {
  var byKey = {};
  var order = [];
  leads.forEach(function (lead) {
    var key = lead.email ? ('email:' + lead.email) : ('name:' + normalize_(lead.name));
    if (!key || key === 'name:') return;
    if (!byKey[key]) {
      byKey[key] = {
        key: key,
        name: lead.name,
        email: lead.email,
        sources: [],
        occurrences: 0
      };
      order.push(key);
    }
    var entry = byKey[key];
    entry.occurrences++;
    // Keep the first non-empty name/email seen, so a record that only had an
    // email still reports a human-readable name if another source had one.
    if (!entry.name && lead.name) entry.name = lead.name;
    if (!entry.email && lead.email) entry.email = lead.email;
    var srcLabel = lead.source + ':' + lead.sourceRow;
    if (entry.sources.length < 5) entry.sources.push(srcLabel);
  });
  return order.map(function (k) { return byKey[k]; });
}

/**
 * Real noise found in the first live run (05/09/2026): of 448 "not in GHL"
 * results, the large majority were not leads at all —
 *   - Joana's cold-outreach tool's own sender address (network@ardorseo.com),
 *     appearing 300+ times as if it were 300+ distinct leads
 *   - actual email newsletters ("The Daily Skimm", "Entrepreneur Daily")
 *     that landed in her inbox and got scraped into the Reply Tracker
 *   - our own team's addresses (@iconsofrealestate.com) and internal/demo
 *     recordings whose filename leaked into the Prospect Name column
 *     (e.g. "GMT20260822-005817_Recording_640x360", "Sean Church demo")
 * Kris, 05/09/2026: filter this out before anyone decides what's a real
 * lead — but "Tomás and Joana will decide if they are real leads or not,"
 * never this script. So this is advisory only: every lead still gets
 * written to the review sheet, just tagged, and the "Candidates" sheet is a
 * filtered VIEW for convenience, not a decision.
 */
var LEAD_RECONCILIATION_NOISE_PATTERNS_ = {
  emailPatterns: [
    { pattern: /@ardorseo\.com$/i, reason: 'cold-outreach tool sender address, not a lead' },
    { pattern: /@iconsofrealestate\.com$/i, reason: 'internal team address, not a lead' }
  ],
  namePatterns: [
    { pattern: /^(the\s+)?daily\s+skimm$/i, reason: 'email newsletter, not a lead' },
    { pattern: /^entrepreneur(\s+daily)?$/i, reason: 'email newsletter, not a lead' },
    { pattern: /^gmt\d{8}-\d+_recording/i, reason: 'Zoom recording filename, not a lead' },
    { pattern: /\bdemo\b/i, reason: 'looks like an internal/demo recording, not a lead' },
    { pattern: /^joana'?s?\s+transcriptions?$/i, reason: 'internal bookkeeping label, not a lead' }
  ]
};

/**
 * Pure. Advisory-only classification of whether a lead looks like noise
 * rather than a real person — never used to filter or auto-decide anything,
 * only to tag rows on the review sheet so a human can sort/ignore faster.
 * Checks email first (a cleaner signal) then name.
 */
function classifyReconciliationNoise_(lead) {
  var email = String(lead.email || '');
  for (var i = 0; i < LEAD_RECONCILIATION_NOISE_PATTERNS_.emailPatterns.length; i++) {
    var ep = LEAD_RECONCILIATION_NOISE_PATTERNS_.emailPatterns[i];
    if (email && ep.pattern.test(email)) return { isNoise: true, reason: ep.reason };
  }
  var name = String(lead.name || '');
  for (var j = 0; j < LEAD_RECONCILIATION_NOISE_PATTERNS_.namePatterns.length; j++) {
    var np = LEAD_RECONCILIATION_NOISE_PATTERNS_.namePatterns[j];
    if (name && np.pattern.test(name)) return { isNoise: true, reason: np.reason };
  }
  return { isNoise: false, reason: '' };
}

/**
 * Pure. Given what GHL's contact search returned for one lead, decide which
 * of the three buckets it lands in.
 *
 * Uses contactNameLooksLikeQuery_ (Phase9_GhlSync.gs) rather than trusting
 * the search result set, because GHL's /contacts query is confirmed
 * (28/08/2026, "Desiree Doggett") to return five completely unrelated people
 * instead of an empty list. Without that filter every lead would classify as
 * found and this whole audit would report a clean bill of health while being
 * entirely wrong.
 */
function classifyLeadGhlPresence_(lead, contacts) {
  var plausible = (contacts || []).filter(function (c) {
    if (lead.email) {
      var contactEmail = String(c.email || '').trim().toLowerCase();
      if (contactEmail && contactEmail === lead.email) return true;
    }
    return lead.name ? contactNameLooksLikeQuery_(c, lead.name) : false;
  });
  if (!plausible.length) return { status: 'not_found', matches: [] };
  if (plausible.length > 1) return { status: 'ambiguous', matches: plausible };
  return { status: 'found', matches: plausible };
}

/** Pure. Human-readable summary of a completed (or partial) reconciliation run. */
function buildLeadReconciliationSummary_(results, scanned, total, partial) {
  var counts = { found: 0, not_found: 0, ambiguous: 0 };
  results.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
  var lines = [];
  lines.push('Checked ' + scanned + ' of ' + total + ' distinct lead(s) against GHL.');
  lines.push('  in GHL:      ' + counts.found);
  lines.push('  NOT in GHL:  ' + counts.not_found + (counts.not_found ? '  <-- these are the ones to add' : ''));
  lines.push('  ambiguous:   ' + counts.ambiguous + (counts.ambiguous ? '  <-- more than one plausible match, needs a human' : ''));
  if (partial) {
    lines.push('PARTIAL RUN (time budget or MAX_LEADS_PER_RUN cap) — re-run to continue.');
  }
  return lines.join('\n');
}

/**
 * Reads one configured source and returns its leads plus a status line, so a
 * source whose tab or header is missing reports itself instead of
 * contributing zero leads silently.
 *
 * Deliberately does NOT use resolveSheet_ (Phase1_ComplianceCheck.gs): that
 * helper falls back to CONFIG.SHARED_LOG_TAB_CANDIDATES and then to the
 * FIRST SHEET IN THE SPREADSHEET when the named tab is missing, which in an
 * audit would silently read the wrong tab and report its leads as if they
 * came from the requested one. Here a missing tab must be a reported miss.
 */
function readReconciliationSource_(source) {
  var ssId = source.spreadsheetId || SALES_CALL_LOG_SPREADSHEET_ID;
  var ss;
  try {
    ss = SpreadsheetApp.openById(ssId);
  } catch (e) {
    return { ok: false, leads: [], note: 'could not open spreadsheet ' + ssId + ' (' + e + ')' };
  }

  var sheets = source.tabName
    ? [ss.getSheetByName(source.tabName)].filter(function (s) { return !!s; })
    : ss.getSheets();
  if (!sheets.length) {
    return { ok: false, leads: [], note: 'tab "' + source.tabName + '" not found in ' + ssId };
  }

  var leads = [];
  var notes = [];
  sheets.forEach(function (sheet) {
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) { notes.push(sheet.getName() + ': empty'); return; }
    var values = sheet.getDataRange().getValues();
    var header = values[0].map(function (h) { return String(h || ''); });
    var nameIdx = findColumn_(header, source.nameColumns);
    var emailIdx = findColumn_(header, source.emailColumns);
    if (nameIdx === -1 && emailIdx === -1) {
      notes.push(sheet.getName() + ': no name/email column found (looked for ' +
        source.nameColumns.join('/') + ' and ' + source.emailColumns.join('/') + ') — SKIPPED');
      return;
    }
    var label = source.tabName ? source.label : (source.label + ' > ' + sheet.getName());
    var found = collectLeadsFromRows_(values, nameIdx, emailIdx, label);
    leads = leads.concat(found);
    notes.push(sheet.getName() + ': ' + found.length + ' lead row(s)');
  });

  return { ok: true, leads: leads, note: notes.join('; ') };
}

/**
 * Contact IDs this project has ALREADY resolved, read from the GHL Note Sync
 * Log (Phase12_GhlNoteSync.gs). Every one of these is a lead we know is in
 * GHL because we successfully posted a note to it — so they can be marked
 * found for free, before spending a single search call on them.
 */
function knownGhlContactNamesFromNoteLog_() {
  var known = {};
  try {
    var sheet = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID)
      .getSheetByName(GHL_NOTE_SYNC_LOG_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return known;
    var values = sheet.getDataRange().getValues();
    var header = values[0].map(function (h) { return String(h || ''); });
    var nameIdx = findColumn_(header, ['Prospect Name']);
    var idIdx = findColumn_(header, ['Contact ID']);
    if (nameIdx === -1 || idIdx === -1) return known;
    for (var r = 1; r < values.length; r++) {
      var n = normalize_(values[r][nameIdx]);
      var id = String(values[r][idIdx] || '').trim();
      if (n && id) known[n] = id;
    }
  } catch (e) {
    log_('knownGhlContactNamesFromNoteLog_: could not read the note sync log (' + e +
      ') — continuing without it, which just means more GHL searches.');
  }
  return known;
}

var LEAD_RECONCILIATION_REVIEW_HEADERS_ = [
  'Timestamp', 'Name', 'Email', 'Status', 'Sources', 'Likely Noise', 'Noise Reason',
  'Ambiguous GHL Matches', 'Real Lead — add to CRM', 'Not a real lead', 'Dedupe Key'
];

/**
 * Two tabs, same headers: "...- All" gets every not_found/ambiguous lead;
 * "...- Candidates" gets only the ones NOT flagged as noise (a filtered
 * VIEW, not a decision — see classifyReconciliationNoise_'s header comment).
 * Kris, 05/09/2026, after Tomás's "please don't do any more updates on GHL
 * until [Monday]": this tool writes to its OWN sheets only, never to GHL,
 * and the two decision checkboxes are for Tomás/Joana, not for this script
 * to act on.
 */
var LEAD_RECONCILIATION_REVIEW_SHEET_ALL_ = 'Lead Reconciliation - All';
var LEAD_RECONCILIATION_REVIEW_SHEET_CANDIDATES_ = 'Lead Reconciliation - Candidates';

function getOrCreateLeadReconciliationReviewSheet_(sheetName) {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, LEAD_RECONCILIATION_REVIEW_HEADERS_.length)
      .setValues([LEAD_RECONCILIATION_REVIEW_HEADERS_]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    // Deliberately NOT pre-formatting checkboxes over a big empty range —
    // that exact mistake (Phase14_GhlStageTriage.gs, 05/09/2026) made
    // getLastRow() think 998 blank rows held content and buried real data
    // at row 1000. Checkboxes go on only the specific rows just written,
    // see writeLeadReconciliationReviewRows_ below.
  }
  return sheet;
}

/**
 * The Dedupe Key column (K) is the same key dedupeReconciliationLeads_
 * builds — reading it back (rather than trusting getLastRow(), see the
 * comment above) is what lets a re-run skip a lead already listed instead
 * of appending a duplicate row for the same still-missing person.
 */
function readExistingReconciliationReviewKeys_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 11, lastRow - 1, 1).getValues()
    .map(function (r) { return String(r[0] || '').trim(); })
    .filter(function (k) { return !!k; });
}

/** Same safe-append pattern as Phase14's nextGhlStageTriageWriteRow_: find the real next row from actual content in the Dedupe Key column, never trust getLastRow() alone. */
function nextReconciliationReviewWriteRow_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 2;
  var keys = sheet.getRange(2, 11, lastRow - 1, 1).getValues();
  for (var r = keys.length - 1; r >= 0; r--) {
    if (String(keys[r][0] || '').trim()) return r + 3;
  }
  return 2;
}

/**
 * Appends rows to one review sheet, skipping any lead whose dedupe key is
 * already present. Returns how many were actually written. `rowBuilder`
 * turns one result into a row array ending in its dedupe key.
 */
function writeLeadReconciliationReviewRows_(sheetName, results, rowBuilder) {
  if (!results.length) return 0;
  var sheet = getOrCreateLeadReconciliationReviewSheet_(sheetName);
  var existingKeys = readExistingReconciliationReviewKeys_(sheet);
  var newRows = [];
  results.forEach(function (r) {
    var row = rowBuilder(r);
    var key = row[row.length - 1];
    if (existingKeys.indexOf(key) !== -1) return;
    newRows.push(row);
  });
  if (!newRows.length) return 0;
  var writeRow = nextReconciliationReviewWriteRow_(sheet);
  sheet.getRange(writeRow, 1, newRows.length, LEAD_RECONCILIATION_REVIEW_HEADERS_.length).setValues(newRows);
  sheet.getRange(writeRow, 9, newRows.length, 2).insertCheckboxes(); // Real Lead / Not a real lead, this batch only
  return newRows.length;
}

/** Builds one review-sheet row (ending in its dedupe key) from one classified result. */
function buildLeadReconciliationReviewRow_(result) {
  var lead = result.lead;
  var noise = classifyReconciliationNoise_(lead);
  var matchesLabel = (result.matches || []).map(function (c) {
    return (c.name || ((c.firstName || '') + ' ' + (c.lastName || ''))) + ' (' + c.id + ')';
  }).join(' | ');
  var key = lead.email ? ('email:' + lead.email) : ('name:' + normalize_(lead.name));
  return [
    new Date(), lead.name, lead.email, result.status, lead.sources.join(', '),
    noise.isNoise, noise.reason, matchesLabel, false, false, key
  ];
}

/** Apps Script's "Select function to run" dropdown hides trailing-underscore functions. */
function previewLeadReconciliation() {
  return previewLeadReconciliation_();
}

/**
 * READ-ONLY. Reads every configured source, dedupes, checks each distinct
 * lead against GHL, and logs the result. Writes nothing anywhere.
 */
function previewLeadReconciliation_() {
  RUN_TAG = 'previewLeadReconciliation_';
  var started = Date.now();
  var locationId = getScriptSecret_(GHL_CONFIG.LOCATION_ID_PROPERTY);

  log_('READ-ONLY lead reconciliation. Nothing is written to any sheet or to GHL.');

  var allLeads = [];
  LEAD_RECONCILIATION_SOURCES.forEach(function (source) {
    var res = readReconciliationSource_(source);
    log_('source "' + source.label + '": ' + (res.ok ? res.note : 'UNAVAILABLE — ' + res.note));
    allLeads = allLeads.concat(res.leads);
  });

  var distinct = dedupeReconciliationLeads_(allLeads);
  log_('Collected ' + allLeads.length + ' lead row(s) across all sources -> ' +
    distinct.length + ' distinct lead(s) to check.');

  var known = knownGhlContactNamesFromNoteLog_();
  var knownCount = Object.keys(known).length;
  if (knownCount) {
    log_(knownCount + ' contact ID(s) already known from the GHL Note Sync Log — ' +
      'those are marked found without spending a search.');
  }

  var cap = LEAD_RECONCILIATION_CONFIG.MAX_LEADS_PER_RUN;
  var results = [];
  var scanned = 0;
  var partial = false;
  var lastHeartbeat = Date.now();

  for (var i = 0; i < distinct.length; i++) {
    if (Date.now() - started > LEAD_RECONCILIATION_CONFIG.TIME_BUDGET_MS) {
      log_('Time budget reached after ' + scanned + ' lead(s) — stopping here.');
      partial = true;
      break;
    }
    if (cap && scanned >= cap) {
      log_('MAX_LEADS_PER_RUN (' + cap + ') reached — stopping here.');
      partial = true;
      break;
    }

    var lead = distinct[i];
    scanned++;

    if (Date.now() - lastHeartbeat > 15000) {
      log_('  still going — ' + scanned + '/' + distinct.length + ' checked...');
      lastHeartbeat = Date.now();
    }

    if (known[normalize_(lead.name)]) {
      results.push({ lead: lead, status: 'found', via: 'note sync log' });
      continue;
    }

    // Email first, not name: email is an exact key, name is fuzzy text
    // search — and the Reply Tracker bug above is exactly what happens when
    // a source's "name" isn't trustworthy. Falls back to name when there's
    // no email at all (most Sales Call Log rows, GHL_PIPELINE_MAP.md §D).
    var query = lead.email || lead.name;
    var search = ghlSearchContactByName_(locationId, query);
    if (!search.ok) {
      log_('  GHL search FAILED for "' + query + '": HTTP ' + search.status + ' — ' +
        String(search.body).slice(0, 200));
      results.push({ lead: lead, status: 'ambiguous', via: 'search error', matches: [] });
      continue;
    }
    var verdict = classifyLeadGhlPresence_(lead, search.contacts);
    results.push({ lead: lead, status: verdict.status, via: 'search', matches: verdict.matches });
  }

  log_('');
  log_(buildLeadReconciliationSummary_(results, scanned, distinct.length, partial));

  var notFound = results.filter(function (r) { return r.status === 'not_found'; });
  if (notFound.length) {
    log_('');
    log_('NOT IN GHL — for Tomás/Joana to review (also written to the review sheets below):');
    notFound.forEach(function (r) {
      log_('  "' + r.lead.name + '"' + (r.lead.email ? ' <' + r.lead.email + '>' : ' (no email)') +
        '  [' + r.lead.sources.join(', ') + ']');
    });
  }

  var ambiguous = results.filter(function (r) { return r.status === 'ambiguous'; });
  if (ambiguous.length) {
    log_('');
    log_('AMBIGUOUS — more than one plausible GHL contact, a human should pick:');
    ambiguous.forEach(function (r) {
      var names = (r.matches || []).map(function (c) {
        return (c.name || ((c.firstName || '') + ' ' + (c.lastName || ''))) + ' (' + c.id + ')';
      });
      log_('  "' + r.lead.name + '" -> ' + (names.join(' | ') || r.via));
    });
  }

  var reviewable = results.filter(function (r) { return r.status === 'not_found' || r.status === 'ambiguous'; });
  var allWritten = writeLeadReconciliationReviewRows_(
    LEAD_RECONCILIATION_REVIEW_SHEET_ALL_, reviewable, buildLeadReconciliationReviewRow_);
  var candidates = reviewable.filter(function (r) { return !classifyReconciliationNoise_(r.lead).isNoise; });
  var candidatesWritten = writeLeadReconciliationReviewRows_(
    LEAD_RECONCILIATION_REVIEW_SHEET_CANDIDATES_, candidates, buildLeadReconciliationReviewRow_);

  log_('');
  log_('Wrote ' + allWritten + ' new row(s) to "' + LEAD_RECONCILIATION_REVIEW_SHEET_ALL_ + '" (every not-in-GHL/ambiguous lead) ' +
    'and ' + candidatesWritten + ' to "' + LEAD_RECONCILIATION_REVIEW_SHEET_CANDIDATES_ + '" (the same list with obvious noise — ' +
    'outreach-tool sender addresses, newsletters, recording filenames — filtered out as a convenience VIEW only).');
  log_('NOTHING was written to GHL, and nothing was auto-decided. Tomás and Joana tick "Real Lead" or ' +
    '"Not a real lead" per row on either sheet — that decision is theirs, this script only surfaces the list.');
  return results;
}
