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

// ---------------------------------------------------------------------------
// CRM hygiene checks — CRM Hygiene Automation doc (Tomás's approval + inline
// comments, 01/09/2026). Only Rules 2 and 3 plus Tomás's own unprompted 5th
// rule (a comment on the doc, not one of the numbered proposals) are built
// here. Rule 1 (stage-based staleness) is explicitly on hold per his own
// comment — "wait for redesign, PLEASE" — it depends on today's 6 fragmented
// pipelines, which the one-pipeline redesign is going to replace, so building
// against them now risks a rebuild the moment that lands. Rules 2/3/5 don't
// have that problem — none of them depend on pipeline shape.
//
// SCOPE NOTE: every check below only ever looks at a GHL contact already
// reachable from a Sales Call Log row — same per-row name-match
// computeGhlSyncFixes_ above already does — not a scan of every GHL contact.
// A lead GHL knows about that never had a Sales Call Log row at all (e.g.
// one that fell through the cracks before any call was ever logged) is
// invisible to this. Rule 3's own description in the doc ("the exact
// failure mode behind the lost 2024/Hubspot-transfer leads") is really about
// that wider case — a true full-GHL-contacts scan is a separate, bigger job
// (no existing per-contact enumeration in this file, and no natural
// stopping point the way a bounded Sales Call Log scan has). Flagged here
// rather than silently narrowing the doc's own rule without saying so.
//
// Recipient, per Tomás's own comment on the doc ("rep only, can't have any
// more alarms"): the rep only, never CC'd to Tomás or Kris — different from
// every other nag bot in this codebase (see checkRep_ and
// runNoShowFollowUpCheck for the usual CC pattern).
// ---------------------------------------------------------------------------

var GHL_HYGIENE_CONFIG = {
  ENABLED: false,
  // Days after a call before its GHL contact/opportunity not having been
  // touched counts as a real gap rather than "just hasn't happened yet".
  // Tomás's own comment said N should vary by pipeline/stage once the
  // redesign lands — until then this one flat number applies everywhere.
  CALL_REFLECTION_GRACE_DAYS: 3,
  // Rule 5 (Tomás's own addition) looks this many days into a rep's calendar
  // for a future event matching the prospect before concluding "no real
  // future appointment" — long enough to cover a call booked a couple weeks
  // out, short enough that a placeholder months away doesn't count as cover.
  FUTURE_APPOINTMENT_LOOKAHEAD_DAYS: 21,
  // Bounds how far back this scans the Sales Call Log — same reasoning as
  // NO_SHOW_FOLLOWUP_CONFIG.LOOKBACK_DAYS (Phase4_InboxSLA.gs): a rep can
  // only actually act on recent rows, and it keeps GHL call volume (2+ calls
  // per matched row) bounded on a full run.
  LOOKBACK_DAYS: 30
};

/**
 * True for a GHL stage name that represents a booked-but-not-yet-happened
 * appointment (e.g. "Sales Call Booked", "Discovery Call Booked") — Tomás's
 * own rule (comment on the CRM Hygiene Automation doc): a lead sitting in
 * one of these should have a real future appointment, or it shouldn't be
 * there. Matches on the word "booked" rather than an exact stage list —
 * GHL_PIPELINE_MAP.md shows this naming pattern repeated across pipelines,
 * and a substring match survives a stage getting renamed slightly better
 * than a hardcoded list would.
 */
function ghlStageLooksBooked_(stageName) {
  return /\bbooked\b/i.test(String(stageName || ''));
}

/**
 * Rule 2 — "call not reflected in GHL". True when the call happened long
 * enough ago (graceDays) that someone should have touched the matching GHL
 * opportunity by now, but none of the contact's opportunities show any
 * activity on or after the call date. Returns null — not applicable, not a
 * real finding — rather than false when the call is too recent to judge, or
 * when no opportunity carries a usable timestamp at all (a GHL response-
 * shape gap, not evidence of neglect) — same never-guess-on-missing-signal
 * policy as ghlStageToOutcomeDisposition_ returning null on an unmapped
 * stage above.
 */
function ghlCallReflectionGap_(callDate, opportunities, nowMs, graceDays) {
  if (!callDate || isNaN(callDate.getTime())) return null;
  var graceMs = graceDays * 24 * 3600000;
  if (nowMs - callDate.getTime() < graceMs) return null;

  var latestUpdateMs = null;
  (opportunities || []).forEach(function (o) {
    // Best-effort field names — GHL v2's docs are unreachable from the dev
    // sandbox (see this file's header) — checks every plausible key rather
    // than picking one and silently missing real activity under another.
    var raw = o.updatedAt || o.dateUpdated || o.lastStatusChangeAt || o.lastStageChangeAt;
    if (!raw) return;
    var ms = new Date(raw).getTime();
    if (!isNaN(ms) && (latestUpdateMs === null || ms > latestUpdateMs)) latestUpdateMs = ms;
  });

  if (latestUpdateMs === null) return null; // no usable timestamp anywhere — can't judge, not a finding
  return latestUpdateMs < callDate.getTime();
}

/** Rule 3 (scoped — see this section's header comment). True when a matched
 * GHL contact has zero opportunities in any pipeline at all. */
function ghlContactIsUnpipelined_(opportunities) {
  return !opportunities || opportunities.length === 0;
}

/**
 * Rule 5 (Tomás's own addition). Returns null when nothing is in a Booked
 * stage — nothing to check, not a finding. Otherwise { flag, bookedStages },
 * where flag is true only when hasFutureEvent is definitively false —
 * hasFutureEvent === null (no way to check, e.g. Tomás's calls aren't
 * calendar-scanned) reports unverifiable: true rather than guessing a flag.
 */
function ghlBookedWithoutFutureAppointmentGap_(opportunities, stageLookup, hasFutureEvent) {
  var bookedStages = [];
  (opportunities || []).forEach(function (o) {
    var stageId = o.pipelineStageId || o.stageId;
    var info = stageLookup[stageId];
    var stageName = info ? info.stageName : null;
    if (stageName && ghlStageLooksBooked_(stageName)) bookedStages.push(stageName);
  });
  if (!bookedStages.length) return null;
  if (hasFutureEvent === null) return { flag: false, bookedStages: bookedStages, unverifiable: true };
  return { flag: !hasFutureEvent, bookedStages: bookedStages };
}

/**
 * One Sales Call Log row's hygiene findings, combining all three checks.
 * Pure given its inputs (`ctx.opportunities`/`ctx.hasFutureEvent` are
 * already-resolved data, not live calls) — computeGhlHygieneFindings_ below
 * is what actually talks to GHL/CalendarApp and hands this the results.
 * Returns null when nothing is wrong.
 */
function classifyGhlHygieneRow_(ctx) {
  var reflectionGap = ghlCallReflectionGap_(ctx.callDate, ctx.opportunities, ctx.nowMs,
    GHL_HYGIENE_CONFIG.CALL_REFLECTION_GRACE_DAYS);
  var unpipelined = ghlContactIsUnpipelined_(ctx.opportunities);
  var bookedGap = ghlBookedWithoutFutureAppointmentGap_(ctx.opportunities, ctx.stageLookup, ctx.hasFutureEvent);

  var issues = [];
  if (reflectionGap) issues.push('call_not_reflected_in_ghl');
  if (unpipelined) issues.push('unpipelined_lead');
  if (bookedGap && bookedGap.flag) issues.push('booked_without_future_appointment');
  if (!issues.length) return null;

  return {
    prospectName: ctx.prospectName, rep: ctx.rep, callDateLabel: ctx.callDateLabel,
    issues: issues, bookedStages: bookedGap ? bookedGap.bookedStages : []
  };
}

/** repEmailByName_ (Phase3_HandoffBrief.gs) only covers CONFIG.REPS, keyed by
 * email — this needs the full rep config (calendarId included) for
 * ghlHasFutureCalendarEvent_ below, so it's a separate lookup rather than a
 * reuse of that one. Case/whitespace-insensitive, same as repEmailByName_. */
function repConfigByName_(repName) {
  var normalized = String(repName || '').trim().toLowerCase();
  var found = null;
  CONFIG.REPS.forEach(function (r) {
    if (String(r.name || '').trim().toLowerCase() === normalized) found = r;
  });
  return found;
}

/**
 * True if `repName` has a real future calendar event that looks like it's
 * for `prospectName` within GHL_HYGIENE_CONFIG.FUTURE_APPOINTMENT_LOOKAHEAD_DAYS
 * days. Returns null (unverifiable) for a rep with no calendar-scan config
 * (Tomás isn't in CONFIG.REPS — see repEmailForFollowUpCheck_'s own comment,
 * Phase4_InboxSLA.gs) or on a calendar API failure — never guesses "no
 * appointment" from the absence of a way to check.
 */
function ghlHasFutureCalendarEvent_(repName, prospectName, nowDate) {
  var repCfg = repConfigByName_(repName);
  if (!repCfg) return null;
  var dayEnd = new Date(nowDate.getTime() + GHL_HYGIENE_CONFIG.FUTURE_APPOINTMENT_LOOKAHEAD_DAYS * 24 * 3600000);
  var events;
  try {
    events = getRepCallEvents_(repCfg, nowDate, dayEnd);
  } catch (e) {
    log_('ghlHasFutureCalendarEvent_: calendar lookup failed for ' + repName + ': ' + e);
    return null;
  }
  var queryTokens = normalizeNameTokens_(prospectName);
  return events.some(function (ev) {
    var evTokens = normalizeNameTokens_(ev.prospectGuess || '');
    return queryTokens.some(function (qt) { return qt.length >= 3 && evTokens.indexOf(qt) !== -1; });
  });
}

/**
 * Reads a Sales Call Log row's Call Date cell as a real Date at midnight in
 * the business timezone. getValues() hands this back as EITHER a real Date
 * object (a genuine Sheets date cell) or a "dd/MM/yyyy" text string —
 * Phase1_ComplianceCheck.gs's own header comment ("Call Date (D) number
 * format DD/MM/YYYY") and findLegacyBackfillDuplicates_'s `date instanceof
 * Date` check (Phase2_CallScoring.gs) both confirm this codebase has real
 * examples of both in the live sheet. Real bug found live (03/09/2026): the
 * first version of this function only handled the text-string case (split by
 * '/', same as findRecentNoShowRows_ in Phase4_InboxSLA.gs) — every row
 * whose cell was an actual Date object silently read as unparseable, since
 * String(aDateObject) has no '/' characters at all. That produced a
 * previewGhlHygieneCheck_ run reporting 471/471 rows outside the lookback
 * window — not one single row genuinely too old, every row unreadable.
 * Returns null (not a throw) for anything genuinely unparseable, same
 * never-guess policy as the rest of this file.
 */
function parseSalesCallLogDate_(cellValue) {
  if (cellValue instanceof Date) {
    if (isNaN(cellValue.getTime())) return null;
    var y = Number(Utilities.formatDate(cellValue, CONFIG.BUSINESS_TIMEZONE, 'yyyy'));
    var m = Number(Utilities.formatDate(cellValue, CONFIG.BUSINESS_TIMEZONE, 'MM'));
    var d = Number(Utilities.formatDate(cellValue, CONFIG.BUSINESS_TIMEZONE, 'dd'));
    return dateAtMidnightInBusinessTimezone_(y, m, d);
  }
  var parts = String(cellValue || '').trim().split('/'); // ['dd', 'MM', 'yyyy']
  if (parts.length !== 3) return null;
  var parsed = dateAtMidnightInBusinessTimezone_(Number(parts[2]), Number(parts[1]), Number(parts[0]));
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Shared scan — used by both previewGhlHygieneCheck_ and runGhlHygieneCheck_
 * so they can't disagree, same pattern as computeGhlSyncFixes_ and
 * computeNoShowFollowUpResults_ (Phase4_InboxSLA.gs) above/elsewhere. Costs
 * up to 3 GHL calls plus one calendar read per matched row, so it's bounded
 * to the last GHL_HYGIENE_CONFIG.LOOKBACK_DAYS rather than the whole sheet.
 *
 * Returns {findings, stats} rather than just the findings list — a run that
 * finds zero issues looks identical in the log to a run that scanned zero
 * rows (wrong sheet, everything outside the lookback window, nothing name-
 * matched in GHL) unless the funnel itself is visible. Real gap found live
 * (03/09/2026): the first previewGhlHygieneCheck_() run logged only "0
 * row(s) with a hygiene issue found" with nothing to tell a clean scan from
 * a scan that never actually checked anything.
 */
function computeGhlHygieneFindings_(locationId, stageLookup) {
  var stats = {
    totalRows: 0, inWindow: 0, noGhlContact: 0, ambiguousOrNoMatch: 0,
    opportunityLookupFailed: 0, checked: 0
  };
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return { findings: [], stats: stats }; }
  var col = getValidatedColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { findings: [], stats: stats };
  var rows = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();
  stats.totalRows = rows.length;

  var cutoff = new Date(Date.now() - GHL_HYGIENE_CONFIG.LOOKBACK_DAYS * 24 * 3600000);
  var now = new Date();
  var findings = [];

  rows.forEach(function (row) {
    var prospectName = String(row[col['Prospect Name'] - 1] || '').trim();
    var rep = String(row[col['Rep'] - 1] || '').trim();
    if (!prospectName || !rep) return;

    var callDate = parseSalesCallLogDate_(row[col['Call Date'] - 1]);
    if (!callDate || callDate < cutoff) return;
    stats.inWindow++;
    var callDateLabel = Utilities.formatDate(callDate, CONFIG.BUSINESS_TIMEZONE, 'dd/MM/yyyy');

    var search = ghlSearchContactByName_(locationId, prospectName);
    if (!search.ok || !search.contacts.length) { stats.noGhlContact++; return; } // no GHL contact at all — nothing to check yet
    var candidates = search.contacts.filter(function (c) { return contactNameLooksLikeQuery_(c, prospectName); });
    if (candidates.length !== 1) { stats.ambiguousOrNoMatch++; return; } // no confident match, or ambiguous — same conservative policy as the sync above

    var contact = candidates[0];
    var oppsRes = ghlListOpportunitiesForContact_(locationId, contact.id);
    if (!oppsRes.ok) { stats.opportunityLookupFailed++; return; }
    stats.checked++;

    var hasFutureEvent = ghlHasFutureCalendarEvent_(rep, prospectName, now);
    var issue = classifyGhlHygieneRow_({
      prospectName: prospectName, rep: rep, callDateLabel: callDateLabel, callDate: callDate,
      opportunities: oppsRes.opportunities, stageLookup: stageLookup,
      hasFutureEvent: hasFutureEvent, nowMs: now.getTime()
    });
    if (issue) findings.push(issue);

    Utilities.sleep(250); // polite pacing — up to 3 GHL calls per matched row here
  });

  return { findings: findings, stats: stats };
}

/** Groups computeGhlHygieneFindings_'s flat list by rep, since the send step
 * emails each rep only their own findings (Tomás's "rep only" instruction). */
function groupGhlHygieneFindingsByRep_(findings) {
  var byRep = {};
  findings.forEach(function (f) {
    byRep[f.rep] = byRep[f.rep] || [];
    byRep[f.rep].push(f);
  });
  return byRep;
}

/** Pure report builder for one rep's own findings — {subject, body, htmlBody}
 * — kept separate from MailApp so it's testable without it, same split as
 * buildNoShowFollowUpReport_ (Phase4_InboxSLA.gs). */
function buildGhlHygieneReportForRep_(findings) {
  var subject = 'GHL hygiene check — ' + findings.length + ' item(s) need a look';
  var labelFor = {
    call_not_reflected_in_ghl: 'GHL was never updated after this call',
    unpipelined_lead: 'GHL contact has no pipeline at all',
    booked_without_future_appointment: 'GHL shows a booked stage with no real future appointment on the calendar'
  };
  var lineText = function (f) {
    return '  • ' + f.prospectName + ' (' + f.callDateLabel + '): ' +
      f.issues.map(function (i) { return labelFor[i]; }).join('; ');
  };
  var lineHtml = function (f) {
    return '<li>' + escapeHtml_(f.prospectName) + ' (' + f.callDateLabel + '): ' +
      f.issues.map(function (i) { return escapeHtml_(labelFor[i]); }).join('; ') + '</li>';
  };

  var body = [
    'GHL hygiene check — ' + findings.length + ' contact(s)/opportunity(s) need a look:',
    '',
    findings.map(lineText).join('\n'),
    '',
    'Each item above is checked against your own real calendar and GHL pipeline data, not guessed. ' +
      'See the CRM Hygiene Automation doc for what each check means.'
  ].join('\n');

  var htmlBody =
    '<p>GHL hygiene check — ' + findings.length + ' contact(s)/opportunity(s) need a look:</p>' +
    '<ul>' + findings.map(lineHtml).join('') + '</ul>' +
    '<p><i>Each item above is checked against your own real calendar and GHL pipeline data, not guessed.</i></p>';

  return { subject: subject, body: body, htmlBody: htmlBody };
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewGhlHygieneCheck() {
  return previewGhlHygieneCheck_();
}

/**
 * Read-only. Full-sheet-within-lookback scan reporting every hygiene finding
 * and exactly what would be emailed to each rep, per-rep, if this were live.
 * Writes/sends nothing.
 */
function previewGhlHygieneCheck_() {
  RUN_TAG = 'previewGhlHygieneCheck_';
  log_('PREVIEW MODE — read-only GHL hygiene probe (CRM Hygiene Automation doc, Rules 2/3 + Tomás\'s ' +
    'booked-without-appointment rule). Nothing will be sent.');

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

  var result = computeGhlHygieneFindings_(locationId, stageLookup);
  var stats = result.stats;
  log_(stats.totalRows + ' row(s) in the Sales Call Log, ' + stats.inWindow + ' within the last ' +
    GHL_HYGIENE_CONFIG.LOOKBACK_DAYS + ' day(s). Of those: ' + stats.noGhlContact + ' no GHL contact found, ' +
    stats.ambiguousOrNoMatch + ' ambiguous/no confident name match, ' + stats.opportunityLookupFailed +
    ' opportunity lookup failed, ' + stats.checked + ' actually checked.');
  log_(result.findings.length + ' row(s) with a hygiene issue found.');
  if (stats.checked === 0) {
    log_('0 checked is why this shows 0 issues — that is NOT the same as "everything is clean". See the ' +
      'funnel above for where rows dropped out (most likely: nothing in the Sales Call Log falls inside the ' +
      GHL_HYGIENE_CONFIG.LOOKBACK_DAYS + '-day lookback window yet, or name-matching against GHL is coming up empty).');
  }

  var byRep = groupGhlHygieneFindingsByRep_(result.findings);
  Object.keys(byRep).forEach(function (rep) {
    var report = buildGhlHygieneReportForRep_(byRep[rep]);
    log_('');
    log_('Would send to ' + rep + ' ONLY (no CC, per Tomás\'s comment on the source doc): "' + report.subject + '"');
    log_(report.body);
  });

  log_('');
  log_('Paste this whole log back to Claude before running the real check.');
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function runGhlHygieneCheck() {
  return runGhlHygieneCheck_();
}

/**
 * LIVE SEND. Gated by GHL_HYGIENE_CONFIG.ENABLED — run previewGhlHygieneCheck()
 * first and confirm the output looks right before flipping that to true.
 * Emails each rep ONLY their own findings, no CC — Tomás's own instruction
 * on the source doc ("rep only, can't have any more alarms"), different from
 * every other nag bot in this codebase.
 */
function runGhlHygieneCheck_() {
  RUN_TAG = 'runGhlHygieneCheck_';
  if (!GHL_HYGIENE_CONFIG.ENABLED) {
    log_('GHL_HYGIENE_CONFIG.ENABLED is false — run previewGhlHygieneCheck() first, confirm the output ' +
      'looks right, then flip GHL_HYGIENE_CONFIG.ENABLED to true in Phase9_GhlSync.gs.');
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

  var result = computeGhlHygieneFindings_(locationId, stageLookup);
  if (!result.findings.length) {
    log_('No GHL hygiene issues found (' + result.stats.checked + ' row(s) actually checked).');
    return;
  }

  var byRep = groupGhlHygieneFindingsByRep_(result.findings);
  Object.keys(byRep).forEach(function (rep) {
    var repEmail = repEmailForFollowUpCheck_(rep);
    if (!repEmail) {
      log_('No email on file for ' + rep + ' — skipping ' + byRep[rep].length + ' finding(s).');
      return;
    }
    var report = buildGhlHygieneReportForRep_(byRep[rep]);
    var sent = guardedSend_(repEmail, report.subject, report.body,
      { htmlBody: report.htmlBody, name: 'GHL Hygiene Check' }, 1);
    log_((sent ? 'Sent' : 'SEND FAILED/SKIPPED for') + ' GHL hygiene email to ' + repEmail + ' (' +
      byRep[rep].length + ' finding(s)).');
  });
}

/**
 * ONE-TIME setup, run manually — ideally only after previewGhlHygieneCheck()
 * has been reviewed and GHL_HYGIENE_CONFIG.ENABLED flipped to true. Daily,
 * not hourly — same reasoning as installGhlSyncTrigger above (GHL/calendar
 * state doesn't need sub-day latency, and this costs 3+ GHL calls per row).
 */
function installGhlHygieneCheckTrigger() {
  RUN_TAG = 'installGhlHygieneCheckTrigger';
  reinstallHourlyTrigger_('runGhlHygieneCheck_', 24);
  log_('GHL hygiene check installed: runGhlHygieneCheck_() now runs once a day. ' +
    (GHL_HYGIENE_CONFIG.ENABLED
      ? 'GHL_HYGIENE_CONFIG.ENABLED is true — reps will be emailed their own findings automatically.'
      : 'GHL_HYGIENE_CONFIG.ENABLED is still false — nothing will actually send until you flip that.'));
}
