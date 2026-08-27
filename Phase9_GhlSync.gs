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
    locationId = getScriptSecret_(GHL_CONFIG.LOCATION_ID_PROPERTY);
    getScriptSecret_(GHL_CONFIG.API_KEY_PROPERTY); // presence check; value used inside ghlApiGet_
  } catch (e) {
    log_('SETUP INCOMPLETE: ' + e);
    log_('Set both ' + GHL_CONFIG.API_KEY_PROPERTY + ' and ' + GHL_CONFIG.LOCATION_ID_PROPERTY +
      ' under Project Settings -> Script Properties, then re-run. See this file\'s header.');
    return;
  }

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
    return;
  }

  var pipelines = (res.json && (res.json.pipelines || res.json.data)) || [];
  if (!pipelines.length) {
    log_('Connected OK (HTTP 200) but no pipelines came back. Raw body (first 1000 chars): ' +
      String(res.body).slice(0, 1000));
    return;
  }

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
