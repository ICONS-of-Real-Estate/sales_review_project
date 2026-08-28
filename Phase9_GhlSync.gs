/**
 * Phase9_GhlSync.gs
 *
 * GoHighLevel (GHL) CRM integration. See GHL_PIPELINE_MAP.md for the full
 * survey of the six pipelines, their stages, and how they map onto Sales
 * Call Log concepts — read that first.
 *
 * WHY THIS EXISTS (GHL_PIPELINE_MAP.md §"What this implies"):
 *  1. Every scored row in the Sales Call Log has a BLANK Prospect Email —
 *     the legacy backfill writes '' — so there is no stable key to join
 *     our data to anything. GHL has a real email per contact.
 *  2. "Outcome Disposition" is the column the Manual Review Guide calls
 *     the single most important one to fill in. It is 100% manual and ~0%
 *     filled. GHL already tracks it automatically, as pipeline stage
 *     membership (Closed won / No Show / Reschedule / ...).
 *  3. No-shows are the largest failure mode in the business (373 in the
 *     ICONS Podcast pipeline alone) and are structurally invisible to this
 *     system, which only ever sees calls that happened AND got transcribed.
 *
 * CURRENT STATE: connectivity + matching are read-only probes.
 * previewGhlSync() is also read-only. The only function that writes to the
 * sheet is syncGhlEmailAndDisposition_(), and GHL_CONFIG.ENABLED (still
 * false) gates it — it refuses to run until that's flipped, which should
 * only happen after previewGhlSync()'s output has been reviewed and looks
 * right. Even then it only ever fills BLANK Prospect Email / Outcome
 * Disposition cells; it never overwrites an existing value.
 *
 * SETUP (one-time, in the Apps Script editor — NOT in this repo):
 *   Project Settings (gear icon) -> Script Properties -> Add:
 *     GHL_API_KEY      = the Private Integration token
 *     GHL_LOCATION_ID  = the sub-account Location ID
 *   Script Properties are runtime storage, not code — `clasp push` does
 *   not touch them, so setting them in the browser editor is correct and
 *   will not be reverted (unlike ENABLED flags or .gs edits — see
 *   CLAUDE.md). Same pattern as LITELLM_API_KEY for Moonshot.
 *
 * THEN, in order: previewGhlConnection() proves the credential works and
 * dumps every pipeline + stage ID. previewGhlMatching() samples ~16 rows to
 * judge whether name-matching finds real contacts at all. previewGhlSync()
 * is the real one — a full-sheet scan reporting every Prospect Email /
 * Outcome Disposition fix that would be applied. All three are entry
 * points (not the trailing-underscore versions — Apps Script's "Select
 * function" dropdown hides those), call no writes, and send nothing.
 *
 * Once previewGhlSync()'s output looks right, flip GHL_CONFIG.ENABLED to
 * true and run syncGhlEmailAndDisposition() once by hand to confirm a real
 * write looks correct, THEN run installGhlSyncTrigger() so it keeps running
 * on its own daily from then on — same "install after a clean preview"
 * pattern as every other phase in this codebase (see CLAUDE.md). Without
 * this trigger the sync only ever runs when someone remembers to trigger it
 * by hand, which is exactly the kind of thing that stops happening after a
 * week — Sean's real ask (28/08/2026) was for GHL No-Show status to keep
 * his tracker current WITHOUT him manually doing anything, which only holds
 * if this runs unattended.
 */

var GHL_CONFIG = {
  // Gates anything that writes. Read-only previews ignore it.
  ENABLED: false,

  API_KEY_PROPERTY: 'GHL_API_KEY',
  LOCATION_ID_PROPERTY: 'GHL_LOCATION_ID',

  // GHL API v2 (LeadConnector). NOT verified against live docs from the
  // dev sandbox — marketplace.gohighlevel.com is egress-blocked there — so
  // previewGhlConnection() below deliberately logs the full status + body
  // on any non-200, making the first real run the verification step. If
  // this base/version turns out wrong, the log says exactly how.
  API_BASE: 'https://services.leadconnectorhq.com',
  API_VERSION: '2021-07-28'
};

/**
 * GET against the GHL API. Returns { status, json, body } rather than
 * throwing on a non-2xx, so callers can report the real error instead of a
 * generic exception — the whole point of the first probe run.
 */
function ghlApiGet_(path) {
  var token = getScriptSecret_(GHL_CONFIG.API_KEY_PROPERTY);
  var url = GHL_CONFIG.API_BASE + path;
  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true, // we want to SEE a 401/404, not throw on it
    headers: {
      Authorization: 'Bearer ' + token,
      Version: GHL_CONFIG.API_VERSION,
      Accept: 'application/json'
    }
  });
  var status = resp.getResponseCode();
  var body = resp.getContentText();
  var json = null;
  try {
    json = JSON.parse(body);
  } catch (e) {
    // leave json null — caller logs the raw body, which is what we need
    // when the response is an HTML error page rather than JSON.
  }
  return { status: status, json: json, body: body, url: url };
}

/**
 * Confirms both Script Properties exist before any GHL call. Every entry
 * point below calls this first and bails with the same clear message
 * rather than each failing on a different obscure error.
 */
function ghlCheckSetup_() {
  var locationId = getScriptSecret_(GHL_CONFIG.LOCATION_ID_PROPERTY);
  getScriptSecret_(GHL_CONFIG.API_KEY_PROPERTY); // presence check; value used inside ghlApiGet_
  return locationId;
}

/**
 * Fetches every pipeline + stage from the live API. Returns null (not [])
 * on any failure, after logging the full diagnostic — same
 * distinguish-failure-from-empty policy as sync.py's fetch_tab, for the
 * same reason: a caller that can't tell "API failed" from "genuinely no
 * pipelines" would silently treat a transient outage as "nothing to sync."
 */
function fetchGhlPipelines_(locationId) {
  var path = '/opportunities/pipelines?locationId=' + encodeURIComponent(locationId);
  var res = ghlApiGet_(path);

  if (res.status !== 200) {
    log_('GHL API returned HTTP ' + res.status + ' for ' + res.url);
    log_('Response body (first 1000 chars): ' + String(res.body).slice(0, 1000));
    log_('Interpretation guide:');
    log_('  401/403 -> the token is wrong, expired, or lacks the Opportunities read scope.');
    log_('  404     -> the endpoint path or API_BASE in GHL_CONFIG is wrong for this account.');
    log_('  422     -> locationId is malformed or does not match the token\'s sub-account.');
    log_('Paste this log back to Claude and the config will be corrected.');
    return null;
  }

  var pipelines = (res.json && (res.json.pipelines || res.json.data)) || [];
  if (!pipelines.length) {
    log_('Connected OK (HTTP 200) but no pipelines came back. Raw body (first 1000 chars): ' +
      String(res.body).slice(0, 1000));
    return null;
  }
  return pipelines;
}

/** stageId -> {pipelineName, stageName, disposition}, built fresh from the live API every call — never hardcoded, so it can't drift from a renamed stage. */
function buildGhlStageLookup_(pipelines) {
  var lookup = {};
  pipelines.forEach(function (p) {
    (p.stages || []).forEach(function (s) {
      lookup[s.id] = {
        pipelineName: p.name,
        stageName: s.name,
        disposition: ghlStageToOutcomeDisposition_(s.name)
      };
    });
  });
  return lookup;
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewGhlConnection() {
  return previewGhlConnection_();
}

/**
 * Read-only probe. Proves the credential works and dumps every pipeline
 * and stage with its ID. Stage IDs (not names) are the durable keys any
 * mapping must be built against — names get renamed, IDs don't.
 *
 * Writes nothing, sends nothing, and is safe to re-run.
 */
function previewGhlConnection_() {
  RUN_TAG = 'previewGhlConnection_';
  log_('PREVIEW MODE — read-only GHL probe. Nothing will be written or sent.');

  var locationId;
  try {
    locationId = ghlCheckSetup_();
  } catch (e) {
    log_('SETUP INCOMPLETE: ' + e);
    log_('Set both ' + GHL_CONFIG.API_KEY_PROPERTY + ' and ' + GHL_CONFIG.LOCATION_ID_PROPERTY +
      ' under Project Settings -> Script Properties, then re-run. See this file\'s header.');
    return;
  }

  var pipelines = fetchGhlPipelines_(locationId);
  if (!pipelines) return; // fetchGhlPipelines_ already logged why

  log_('Connected OK — ' + pipelines.length + ' pipeline(s) found.');
  log_('(GHL_PIPELINE_MAP.md recorded 6 pipelines from a 27/08/2026 screenshot survey. ' +
    'If this count differs, the survey\'s "Advanced filters (1)" caveat is the likely reason — ' +
    'these API numbers are the authoritative ones.)');

  pipelines.forEach(function (p) {
    var stages = p.stages || [];
    log_('');
    log_('PIPELINE: "' + p.name + '"  id=' + p.id + '  (' + stages.length + ' stage(s))');
    stages.forEach(function (s, i) {
      var disposition = ghlStageToOutcomeDisposition_(s.name);
      log_('   ' + (i + 1) + '. "' + s.name + '"  id=' + s.id +
        '  -> Outcome Disposition: ' + (disposition || '(none inferred)'));
    });
  });

  log_('');
  log_('Next: paste this log back to Claude. The stage IDs above are what any ' +
    'stage -> Outcome Disposition sync gets built against.');
}

// ---------------------------------------------------------------------------
// Matching: does a Sales Call Log row's Prospect Name resolve to a real GHL
// contact, and if so, what pipeline/stage are they sitting in right now?
// GHL_PIPELINE_MAP.md §"What this implies for the integration" flags this
// as the real open question — every one of our 439 scored rows has a blank
// Prospect Email (the legacy backfill wrote ''), so there's no stable join
// key yet. This resolves a contact by NAME instead, which also recovers a
// real email/phone as a side effect — the exact backfill step that doc
// calls out as step 1, ahead of anything else.
// ---------------------------------------------------------------------------

/**
 * Searches GHL contacts by free-text name. Endpoint/param names here are a
 * best-effort guess (GHL's own docs are unreachable from this sandbox —
 * see the file header) — same self-diagnosing contract as ghlApiGet_: a
 * non-200 or an unrecognized response shape logs the raw body instead of
 * silently returning nothing, so a wrong param name is a one-line fix, not
 * a mystery.
 */
function ghlSearchContactByName_(locationId, name) {
  var path = '/contacts/?locationId=' + encodeURIComponent(locationId) +
    '&query=' + encodeURIComponent(name) + '&limit=5';
  var res = ghlApiGet_(path);
  if (res.status !== 200) {
    return { ok: false, status: res.status, body: res.body, url: res.url, contacts: [] };
  }
  var contacts = (res.json && (res.json.contacts || res.json.data)) || [];
  return { ok: true, contacts: contacts };
}

/**
 * Splits a name into lowercase alpha tokens of length >= 2 ("Danny
 * Rodriguez - 2nd" -> ['danny','rodriguez','nd']), for comparing a Sales
 * Call Log Prospect Name against a GHL contact's name field.
 */
function normalizeNameTokens_(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(function (t) { return t.length >= 2; });
}

/**
 * True only if the contact's name actually shares a real name token (>= 3
 * letters, so short filler like "nd" from "2nd" can't count) with the
 * queried name. GHL's /contacts query param is confirmed (28/08/2026,
 * "Desiree Doggett") to sometimes return contacts with NO relation to the
 * query at all — 5 completely unrelated people, not even a fuzzy spelling
 * match — rather than an empty list. Without this check, previewGhlMatching_
 * would either misreport that noise as "ambiguous" (as happened) or, worse,
 * accept a single unrelated result as a "confident" match.
 */
function contactNameLooksLikeQuery_(contact, queryName) {
  var queryTokens = normalizeNameTokens_(queryName);
  var contactName = contact.name || ((contact.firstName || '') + ' ' + (contact.lastName || ''));
  var contactTokens = normalizeNameTokens_(contactName);
  if (!queryTokens.length || !contactTokens.length) return false;
  return queryTokens.some(function (qt) {
    return qt.length >= 3 && contactTokens.indexOf(qt) !== -1;
  });
}

/**
 * Opportunities belonging to one already-resolved contact. Same
 * best-effort/self-diagnosing contract as ghlSearchContactByName_ —
 * confirmed live (28/08/2026) that /opportunities/search wants snake_case
 * location_id/contact_id, NOT the camelCase locationId/contactId that
 * /opportunities/pipelines (fetchGhlPipelines_ above) actually takes —
 * GHL's v2 API is genuinely inconsistent about this across endpoint
 * groups. First real run 422'd with "property locationId should not
 * exist... location_id must be a string" — spelling it out exactly.
 */
function ghlListOpportunitiesForContact_(locationId, contactId) {
  var path = '/opportunities/search?location_id=' + encodeURIComponent(locationId) +
    '&contact_id=' + encodeURIComponent(contactId);
  var res = ghlApiGet_(path);
  if (res.status !== 200) {
    return { ok: false, status: res.status, body: res.body, url: res.url, opportunities: [] };
  }
  var opps = (res.json && (res.json.opportunities || res.json.data)) || [];
  return { ok: true, opportunities: opps };
}

/**
 * Up to `perRep` of each CONFIG.REPS rep's most recent Sales Call Log
 * rows, oldest-name-collision risk spread across reps rather than just
 * taking the sheet's first N rows (which could all land on one rep
 * depending on sheet order and tell us nothing about the others).
 */
function sampleSalesCallLogRows_(perRep) {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return []; }
  var col = getValidatedColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var rows = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  var perRepCount = {};
  var sample = [];
  rows.forEach(function (row) {
    var rep = String(row[col['Rep'] - 1] || '').trim();
    if (!rep) return;
    perRepCount[rep] = perRepCount[rep] || 0;
    if (perRepCount[rep] >= perRep) return;
    perRepCount[rep]++;
    sample.push({
      prospectName: row[col['Prospect Name'] - 1],
      rep: rep,
      callDate: row[col['Call Date'] - 1],
      outcomeDisposition: row[col['Outcome Disposition'] - 1]
    });
  });
  return sample;
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewGhlMatching() {
  return previewGhlMatching_(4); // 4 per rep -- ~16 rows across Bens/Joana/Sean/Tomás, enough to judge match quality without a long run
}

/**
 * Read-only. For a sample of real Sales Call Log rows, searches GHL by
 * Prospect Name and reports: no match / one confident match / ambiguous
 * (multiple candidates — logged, not guessed at) — and for a resolved
 * contact, which pipeline+stage they're currently sitting in and what
 * Outcome Disposition that would imply. Writes nothing to the sheet.
 *
 * The tally at the end is the actual answer to "is name-matching viable at
 * all" — that's the open question this preview exists to answer before any
 * real sync gets built.
 */
function previewGhlMatching_(perRep) {
  RUN_TAG = 'previewGhlMatching_';
  log_('PREVIEW MODE — read-only GHL matching probe. Nothing will be written or sent.');

  var locationId;
  try {
    locationId = ghlCheckSetup_();
  } catch (e) {
    log_('SETUP INCOMPLETE: ' + e);
    return;
  }

  var pipelines = fetchGhlPipelines_(locationId);
  if (!pipelines) return; // fetchGhlPipelines_ already logged why
  var stageLookup = buildGhlStageLookup_(pipelines);

  var sample = sampleSalesCallLogRows_(perRep);
  if (!sample.length) { log_('No Sales Call Log rows found to sample.'); return; }
  log_('Sampling ' + sample.length + ' row(s) (' + perRep + ' per rep found).');

  var noMatch = 0, oneMatch = 0, ambiguous = 0, searchFailed = 0;

  sample.forEach(function (row, i) {
    log_('');
    log_((i + 1) + '/' + sample.length + '  "' + row.prospectName + '" (' + row.rep + ', ' +
      row.callDate + ') — Outcome Disposition on file: ' +
      (row.outcomeDisposition || '(blank)'));

    var search = ghlSearchContactByName_(locationId, row.prospectName);
    if (!search.ok) {
      log_('   SEARCH FAILED: HTTP ' + search.status + '. Body (first 500 chars): ' +
        String(search.body).slice(0, 500));
      searchFailed++;
      return;
    }
    if (!search.contacts.length) {
      log_('   No GHL contact found for this name.');
      noMatch++;
      return;
    }

    // GHL's query param can return contacts with no real relation to the
    // name searched (confirmed live, 28/08/2026 — see
    // contactNameLooksLikeQuery_'s header comment) — discard those before
    // deciding confident vs. ambiguous, so raw noise doesn't get reported
    // as a genuine multi-candidate match.
    var candidates = search.contacts.filter(function (c) {
      return contactNameLooksLikeQuery_(c, row.prospectName);
    });
    if (!candidates.length) {
      log_('   No GHL contact found for this name (' + search.contacts.length +
        ' raw result(s) returned but none resembled the queried name).');
      noMatch++;
      return;
    }
    if (candidates.length > 1) {
      log_('   AMBIGUOUS — ' + candidates.length + ' name-plausible contact(s) matched, not guessing:');
      candidates.forEach(function (c) {
        log_('     - ' + (c.name || (c.firstName + ' ' + c.lastName)) + '  id=' + c.id +
          '  email=' + (c.email || '(none)') + '  phone=' + (c.phone || '(none)'));
      });
      ambiguous++;
      return;
    }

    var contact = candidates[0];
    log_('   Matched contact id=' + contact.id + '  email=' + (contact.email || '(none)') +
      '  phone=' + (contact.phone || '(none)'));
    oneMatch++;

    var oppsRes = ghlListOpportunitiesForContact_(locationId, contact.id);
    if (!oppsRes.ok) {
      log_('   Opportunity lookup FAILED: HTTP ' + oppsRes.status + '. Body (first 500 chars): ' +
        String(oppsRes.body).slice(0, 500));
      return;
    }
    if (!oppsRes.opportunities.length) {
      log_('   Contact found, but no opportunities on file for them.');
      return;
    }
    oppsRes.opportunities.forEach(function (o) {
      var stageId = o.pipelineStageId || o.stageId;
      var info = stageLookup[stageId];
      log_('   Opportunity "' + (o.name || '(unnamed)') + '" — ' +
        (info ? ('"' + info.pipelineName + '" / "' + info.stageName + '" -> Outcome Disposition: ' +
          (info.disposition || '(none inferred)')) : 'unrecognized stage id ' + stageId + ' (raw: ' + JSON.stringify(o).slice(0, 300) + ')'));
    });

    Utilities.sleep(200); // polite pacing between rows, not a rate-limit workaround for a single call
  });

  log_('');
  log_('Tally: ' + oneMatch + ' confident match(es), ' + ambiguous + ' ambiguous, ' +
    noMatch + ' no match, ' + searchFailed + ' search failure(s), of ' + sample.length + ' sampled.');
  log_('Paste this whole log back to Claude — it decides whether name-matching is viable ' +
    'as the join key, or whether GHL_PIPELINE_MAP.md\'s email-backfill-first plan needs a different approach.');
}

/**
 * Maps a GHL stage name onto the Sales Call Log's "Outcome Disposition"
 * vocabulary (Sold / Not Sold / Follow-up / No-show), or null when the
 * stage implies no disposition yet.
 *
 * Derived from the stage names recorded in GHL_PIPELINE_MAP.md. Returns
 * null rather than guessing on anything unrecognized — same
 * conservative-on-uncertainty policy the scoring code uses for
 * manual_review_recommended, and the safe default here since a wrong
 * disposition is worse than a blank one (a blank reads as "not known
 * yet", a wrong one silently corrupts the funnel numbers).
 *
 * Deliberately NOT mapped, pending Kris's confirmation — each is a real
 * judgment call, not an oversight:
 *   "Failed Deal Form Filled"  — implies a lost deal, but "form filled" may
 *                                mean the paperwork step, not the outcome.
 *   "Pre-Interview Reject"     — a rejection, but of the guest, not a sale.
 *   "Not Qualified/Valid"      — that's lead quality, a different column.
 */
function ghlStageToOutcomeDisposition_(stageName) {
  var s = String(stageName || '').toLowerCase();
  if (!s) return null;

  if (s.indexOf('closed won') !== -1) return 'Sold';
  if (s.indexOf('closed lost') !== -1) return 'Not Sold';

  // "not taken" MUST be tested before the bare "taken" check below —
  // "Sales Call Not Taken" contains "taken" as a substring, so ordering is
  // what keeps a no-show from being read as a completed call.
  if (/not\s*taken/.test(s)) return 'No-show';
  if (/no[\s-]*show/.test(s)) return 'No-show';

  if (s.indexOf('reschedul') !== -1) return 'Follow-up';
  if (s.indexOf('callback') !== -1) return 'Follow-up';
  if (s.indexOf('moving forward later') !== -1) return 'Follow-up';

  // "Taken"/"Recorded" mean the call happened, but the sale's outcome is
  // decided by a LATER stage — so no disposition is inferable from these
  // alone. Same for any "...Booked" stage, which is simply pending.
  return null;
}

// ---------------------------------------------------------------------------
// Backfill: Prospect Email + Outcome Disposition from GHL. This is items 1
// and 2 of GHL_PIPELINE_MAP.md's "What this implies for the integration"
// ranked plan — the highest-value, lowest-risk sync, and both share the same
// per-row contact/opportunity lookup so they're done together. Never
// overwrites a value that's already there — this only fills blanks, exactly
// like every other one-time repair in this codebase
// (computeCallDateFixes_/computeProspectNameFixes_ in Phase2_CallScoring.gs).
// ---------------------------------------------------------------------------

// Leaves a margin under Apps Script's 6-minute ceiling — same policy as
// INBOX_SLA_TIME_BUDGET_MS_ (Phase4_InboxSLA.gs). A full-sheet scan here
// costs up to 2 GHL calls per row, so hitting this on the first run is
// expected, not a bug — because this only ever fills BLANK cells, a
// truncated run is always safe to just re-run: already-filled rows are
// skipped before any API call, so nothing is redone and nothing is lost.
var GHL_SYNC_TIME_BUDGET_MS_ = 5 * 60 * 1000;

// How often computeGhlSyncFixes_ prints a "still going" heartbeat while
// scanning — see that function's own comment for why this exists.
var GHL_SYNC_HEARTBEAT_INTERVAL_MS_ = 15 * 1000;

/**
 * Picks the single Outcome Disposition implied by a contact's opportunities,
 * or null if none is decided yet. Returns { disposition, conflict } rather
 * than guessing when two OPEN opportunities across different pipelines imply
 * different dispositions (e.g. "Closed Won" in one, "No-show" in another) —
 * same never-guess-on-a-real-conflict policy as ghlStageToOutcomeDisposition_
 * returning null on an unmapped stage. `conflict: true` means a human needs
 * to look at this contact's opportunities directly; nothing gets written.
 */
function resolveBestDispositionForOpportunities_(opportunities, stageLookup) {
  var dispositions = [];
  (opportunities || []).forEach(function (o) {
    var stageId = o.pipelineStageId || o.stageId;
    var info = stageLookup[stageId];
    if (info && info.disposition && dispositions.indexOf(info.disposition) === -1) {
      dispositions.push(info.disposition);
    }
  });
  if (dispositions.length === 1) return { disposition: dispositions[0], conflict: false };
  if (dispositions.length > 1) return { disposition: null, conflict: true };
  return { disposition: null, conflict: false };
}

/**
 * Scans the live Sales Call Log for rows missing Prospect Email and/or
 * Outcome Disposition, resolves each by GHL contact name (same
 * name-similarity filter as previewGhlMatching_ — see
 * contactNameLooksLikeQuery_'s header comment and GHL_PIPELINE_MAP.md
 * finding E), and returns what WOULD change. Never writes. Shared by both
 * previewGhlSync_ (logs it) and syncGhlEmailAndDisposition_ (applies it).
 */
function computeGhlSyncFixes_(locationId, stageLookup) {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  var stats = {
    scanned: 0, skippedAlreadyFilled: 0, confidentMatch: 0, ambiguous: 0,
    noMatch: 0, searchFailed: 0, emailFixes: 0, dispositionFixes: 0, dispositionConflicts: 0
  };
  if (!sheet) { log_('No Sales Call Log tab found.'); return { fixes: [], stats: stats, truncated: false }; }

  var col = getValidatedColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { fixes: [], stats: stats, truncated: false };
  var rows = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  var fixes = [];
  var runStart = Date.now();
  var truncated = false;

  // Real gap found live (29/08/2026, Kris): previewGhlSync_ prints one line
  // ("PREVIEW MODE...") and then goes completely silent — 2 blocking GHL
  // calls per row scanned, up to hundreds of blank rows in this sheet — so a
  // multi-minute normal run looks identical to a hang. Log the size of the
  // job up front, then a heartbeat every HEARTBEAT_INTERVAL_MS_ so there's
  // always a recent line proving it's still making progress.
  var needingScan = 0;
  for (var n = 0; n < rows.length; n++) {
    var nameCell = rows[n][col['Prospect Name'] - 1];
    var emailCell = String(rows[n][col['Prospect Email'] - 1] || '').trim();
    var dispositionCell = String(rows[n][col['Outcome Disposition'] - 1] || '').trim();
    if (nameCell && !(emailCell && dispositionCell)) needingScan++;
  }
  log_('computeGhlSyncFixes_: ' + needingScan + ' of ' + rows.length + ' row(s) need a Prospect Email/Outcome ' +
    'Disposition fix — scanning now (up to 2 GHL calls per row, so this can take a few minutes; a heartbeat ' +
    'line prints every ' + Math.round(GHL_SYNC_HEARTBEAT_INTERVAL_MS_ / 1000) + 's while it runs).');
  var lastHeartbeatAt = runStart;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var prospectName = row[col['Prospect Name'] - 1];
    var existingEmail = String(row[col['Prospect Email'] - 1] || '').trim();
    var existingDisposition = String(row[col['Outcome Disposition'] - 1] || '').trim();

    if (!prospectName || (existingEmail && existingDisposition)) {
      stats.skippedAlreadyFilled++;
      continue;
    }

    if (Date.now() - runStart > GHL_SYNC_TIME_BUDGET_MS_) {
      truncated = true;
      log_('computeGhlSyncFixes_: time budget hit after ' + i + '/' + rows.length +
        ' row(s) — re-run to continue (already-filled rows are skipped automatically, so this is always safe).');
      break;
    }

    if (Date.now() - lastHeartbeatAt > GHL_SYNC_HEARTBEAT_INTERVAL_MS_) {
      log_('computeGhlSyncFixes_: still going — ' + stats.scanned + '/' + needingScan + ' row(s) scanned so far, ' +
        fixes.length + ' fix(es) found.');
      lastHeartbeatAt = Date.now();
    }

    stats.scanned++;
    var search = ghlSearchContactByName_(locationId, prospectName);
    if (!search.ok) { stats.searchFailed++; continue; }

    var candidates = search.contacts.filter(function (c) {
      return contactNameLooksLikeQuery_(c, prospectName);
    });
    if (!candidates.length) { stats.noMatch++; continue; }
    if (candidates.length > 1) { stats.ambiguous++; continue; }

    var contact = candidates[0];
    stats.confidentMatch++;
    var fix = { row: i + 2, prospectName: prospectName, rep: row[col['Rep'] - 1] };

    if (!existingEmail && contact.email) {
      fix.newEmail = contact.email;
      stats.emailFixes++;
    }

    if (!existingDisposition) {
      var oppsRes = ghlListOpportunitiesForContact_(locationId, contact.id);
      if (oppsRes.ok && oppsRes.opportunities.length) {
        var resolved = resolveBestDispositionForOpportunities_(oppsRes.opportunities, stageLookup);
        if (resolved.conflict) {
          stats.dispositionConflicts++;
        } else if (resolved.disposition) {
          fix.newDisposition = resolved.disposition;
          stats.dispositionFixes++;
        }
      }
    }

    if (fix.newEmail || fix.newDisposition) fixes.push(fix);
    Utilities.sleep(250); // polite pacing — 2 GHL calls per matched row here, not 1
  }

  return { fixes: fixes, stats: stats, truncated: truncated };
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewGhlSync() {
  return previewGhlSync_();
}

/**
 * Read-only. Full-sheet scan (not a sample — this is the real backfill,
 * not an exploratory probe) reporting every Prospect Email / Outcome
 * Disposition fix computeGhlSyncFixes_ would apply. Writes nothing.
 */
function previewGhlSync_() {
  RUN_TAG = 'previewGhlSync_';
  log_('PREVIEW MODE — read-only GHL email/disposition backfill probe. Nothing will be written.');

  var locationId;
  try {
    locationId = ghlCheckSetup_();
  } catch (e) {
    log_('SETUP INCOMPLETE: ' + e);
    return;
  }

  var pipelines = fetchGhlPipelines_(locationId);
  if (!pipelines) return; // fetchGhlPipelines_ already logged why
  var stageLookup = buildGhlStageLookup_(pipelines);

  var result = computeGhlSyncFixes_(locationId, stageLookup);
  result.fixes.forEach(function (fix) {
    var parts = [];
    if (fix.newEmail) parts.push('Prospect Email -> "' + fix.newEmail + '"');
    if (fix.newDisposition) parts.push('Outcome Disposition -> "' + fix.newDisposition + '"');
    log_('Row ' + fix.row + ' (' + fix.rep + ') "' + fix.prospectName + '": ' + parts.join(', '));
  });

  log_('');
  log_('Scanned ' + result.stats.scanned + ' row(s) needing a fix (' + result.stats.skippedAlreadyFilled +
    ' already fully filled, skipped with no API call).');
  log_('Confident match: ' + result.stats.confidentMatch + ', ambiguous: ' + result.stats.ambiguous +
    ', no match: ' + result.stats.noMatch + ', search failed: ' + result.stats.searchFailed + '.');
  log_(result.fixes.length + ' row(s) would be updated — ' + result.stats.emailFixes + ' email backfill(s), ' +
    result.stats.dispositionFixes + ' disposition fill(s)' +
    (result.stats.dispositionConflicts ? (', ' + result.stats.dispositionConflicts +
      ' skipped for conflicting dispositions across pipelines (needs a human look)') : '') + '.');
  if (result.truncated) {
    log_('PARTIAL SCAN — time budget hit. Re-run previewGhlSync() to see the rest (safe: already-filled rows are skipped automatically).');
  }
  log_('Paste this whole log back to Claude before running the real sync.');
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function syncGhlEmailAndDisposition() {
  return syncGhlEmailAndDisposition_();
}

/**
 * LIVE WRITE. Gated by GHL_CONFIG.ENABLED — run previewGhlSync() first and
 * confirm the output looks right before flipping that to true. Applies
 * exactly what computeGhlSyncFixes_ computed: fills Prospect Email and/or
 * Outcome Disposition ONLY where they were blank. Never overwrites an
 * existing value in either column.
 */
function syncGhlEmailAndDisposition_() {
  RUN_TAG = 'syncGhlEmailAndDisposition_';
  if (!GHL_CONFIG.ENABLED) {
    log_('GHL_CONFIG.ENABLED is false — run previewGhlSync() first, confirm the output looks right, then flip GHL_CONFIG.ENABLED to true in Phase9_GhlSync.gs.');
    return;
  }

  var locationId;
  try {
    locationId = ghlCheckSetup_();
  } catch (e) {
    log_('SETUP INCOMPLETE: ' + e);
    return;
  }

  var pipelines = fetchGhlPipelines_(locationId);
  if (!pipelines) return; // fetchGhlPipelines_ already logged why
  var stageLookup = buildGhlStageLookup_(pipelines);

  var result = computeGhlSyncFixes_(locationId, stageLookup);
  if (!result.fixes.length) {
    log_('No Prospect Email / Outcome Disposition fixes found.' +
      (result.truncated ? ' (PARTIAL scan — time budget hit, re-run to continue.)' : ''));
    return;
  }

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  var col = getValidatedColumnMap_(sheet);

  result.fixes.forEach(function (fix) {
    if (fix.newEmail) sheet.getRange(fix.row, col['Prospect Email']).setValue(fix.newEmail);
    if (fix.newDisposition) sheet.getRange(fix.row, col['Outcome Disposition']).setValue(fix.newDisposition);
    log_('Row ' + fix.row + ' (' + fix.rep + ') "' + fix.prospectName + '" updated.');
  });

  log_('syncGhlEmailAndDisposition_() done — updated ' + result.fixes.length + ' row(s) (' +
    result.stats.emailFixes + ' email, ' + result.stats.dispositionFixes + ' disposition).' +
    (result.truncated ? ' PARTIAL scan — re-run to continue with the remaining rows.' : ' Full sheet scanned.'));
}

/**
 * ONE-TIME setup, run manually — ONLY after previewGhlSync() has been
 * reviewed and GHL_CONFIG.ENABLED has been flipped to true (see this file's
 * header). Installs a daily trigger for syncGhlEmailAndDisposition_ using
 * the same reinstallHourlyTrigger_ helper every other phase's trigger
 * installer uses (Phase2_CallScoring.gs) — safe to re-run, replaces any
 * existing trigger for this handler rather than stacking duplicates.
 *
 * Daily, not hourly: GHL pipeline stage changes (a call resolving to
 * Sold/Not Sold/No-show) don't need sub-day latency the way a live
 * compliance nag does, and a full-sheet scan costs up to 2 GHL API calls per
 * unresolved row — daily keeps that light. Re-run this (or just call
 * syncGhlEmailAndDisposition() by hand) sooner if a fresher sync is ever
 * needed.
 */
function installGhlSyncTrigger() {
  RUN_TAG = 'installGhlSyncTrigger';
  if (!GHL_CONFIG.ENABLED) {
    log_('GHL_CONFIG.ENABLED is still false — the trigger will install, but syncGhlEmailAndDisposition_ ' +
      'will no-op on every firing until you flip that (after reviewing previewGhlSync()\'s output).');
  }
  reinstallHourlyTrigger_('syncGhlEmailAndDisposition_', 24);
  log_('GHL sync installed: syncGhlEmailAndDisposition_() now runs once a day. ' +
    (GHL_CONFIG.ENABLED
      ? 'GHL_CONFIG.ENABLED is true — Prospect Email / Outcome Disposition will be backfilled from GHL automatically.'
      : 'GHL_CONFIG.ENABLED is still false — nothing will actually sync until you flip that.'));
}
