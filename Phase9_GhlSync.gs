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
 * CURRENT STATE: read-only connectivity probe only. Nothing writes to the
 * sheet yet, and GHL_CONFIG.ENABLED gates anything that ever will.
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
 * THEN: run previewGhlConnection() from the editor (not the
 * trailing-underscore version — Apps Script's "Select function" dropdown
 * hides those). It calls no writes and sends nothing; it just proves the
 * credential works and dumps every pipeline + stage ID we'd build against.
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

/** Opportunities belonging to one already-resolved contact. Same best-effort/self-diagnosing contract as ghlSearchContactByName_. */
function ghlListOpportunitiesForContact_(locationId, contactId) {
  var path = '/opportunities/search?locationId=' + encodeURIComponent(locationId) +
    '&contactId=' + encodeURIComponent(contactId);
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
    if (search.contacts.length > 1) {
      log_('   AMBIGUOUS — ' + search.contacts.length + ' contacts matched, not guessing:');
      search.contacts.forEach(function (c) {
        log_('     - ' + (c.name || (c.firstName + ' ' + c.lastName)) + '  id=' + c.id +
          '  email=' + (c.email || '(none)') + '  phone=' + (c.phone || '(none)'));
      });
      ambiguous++;
      return;
    }

    var contact = search.contacts[0];
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
