/**
 * Phase15_CrmOrganizationReview.gs
 *
 * Kris, 05/09/2026: "Can you not do an analysis and write a document for
 * [Tomás] to approve or reject to rapidly organise the CRM?" — ahead of
 * Tomás's Monday session with Joana to "organize the CRM first so we then
 * can clean it... so the setters and closers can use and organize with
 * their leads."
 *
 * READ-ONLY AGAINST GHL. Writes only to this file's own review sheet — same
 * approve/reject-checkbox pattern Tomás has already seen on "GHL Stage
 * Triage" (Phase14_GhlStageTriage.gs). Nothing here moves an opportunity,
 * edits a contact, or otherwise touches GHL — consistent with Tomás's own
 * "don't do any more updates on GHL until then."
 *
 * Two NEW findings, both using data this codebase doesn't have live
 * anywhere else yet:
 *   1. Which pipelines look effectively abandoned RIGHT NOW — the only
 *      existing writeup (GHL_PIPELINE_MAP.md) is a 27/08/2026 screenshot
 *      snapshot, explicitly caveated as stale.
 *   2. Which opportunity assignees aren't anyone this system recognizes —
 *      GHL_PIPELINE_MAP.md §C already flagged this as an open question
 *      (Bruno/Simon/Ty and several bare initials) and it was never
 *      resolved; Kris has since confirmed Bruno/Simon/Ty are old reps
 *      (historical, not live), but the initials are still unidentified.
 *
 * A third finding — LIKELY DUPLICATE CONTACTS — is deliberately NOT
 * recomputed here. previewLeadReconciliation_ (Phase13_LeadReconciliation.gs)
 * already found 29 of these for free as a side effect of matching leads to
 * GHL, and re-scanning the whole account for duplicates independently would
 * cost real API calls to rediscover data already sitting on the
 * "Lead Reconciliation - All" sheet. This file's summary just points Tomás
 * at that existing sheet instead.
 */

var CRM_ORGANIZATION_REVIEW_CONFIG = {
  // A pipeline where one stage holds this share (or more) of all its open
  // opportunities reads as "activity funnels in, nothing moves it forward" —
  // the exact pattern GHL_PIPELINE_MAP.md found in "Cold Calling 2" (97% in
  // one stage). Flagged for Tomás to confirm, never assumed dead outright —
  // a genuinely simple pipeline (few stages, most leads legitimately
  // waiting on one step) could trip this without actually being abandoned.
  STUCK_STAGE_SHARE_THRESHOLD: 0.7,
  // Ignore a pipeline with fewer opportunities than this — a lopsided
  // percentage off 3 total opportunities isn't a real signal.
  MIN_OPPORTUNITIES_TO_FLAG: 20,

  TIME_BUDGET_MS: 5 * 60 * 1000
};

/**
 * Every assignee name/ID this codebase already has an answer for. CONFIG.REPS
 * are the live scored reps; Bruno/Simon/Ty are old reps per Kris (05/09/2026:
 * "Bruno, Simon and Ty are old sales reps") — historical, not live, but a
 * KNOWN identity, not an open question. Anything else found on a live
 * opportunity is genuinely unidentified.
 */
function knownGhlAssigneeNames_() {
  var known = {};
  CONFIG.REPS.forEach(function (r) { known[normalize_(r.name)] = true; });
  ['Bruno', 'Simon', 'Ty'].forEach(function (n) { known[normalize_(n)] = true; });
  return known;
}

/**
 * Pure. Given one pipeline's stage-name -> count tally, decides whether it
 * looks abandoned. Returns null when there's nothing worth flagging (too
 * few opportunities, or no single stage dominates).
 */
function classifyPipelineStageConcentration_(pipelineName, stageCounts, config) {
  var total = 0;
  var stages = Object.keys(stageCounts);
  stages.forEach(function (s) { total += stageCounts[s]; });
  if (total < config.MIN_OPPORTUNITIES_TO_FLAG) return null;

  var topStage = null, topCount = -1;
  stages.forEach(function (s) {
    if (stageCounts[s] > topCount) { topCount = stageCounts[s]; topStage = s; }
  });
  var share = topCount / total;
  if (share < config.STUCK_STAGE_SHARE_THRESHOLD) return null;

  return {
    pipelineName: pipelineName,
    topStage: topStage,
    topCount: topCount,
    total: total,
    sharePct: Math.round(share * 100)
  };
}

/**
 * Pure. True when `candidateName`'s normalized text either exactly matches
 * a known name, or has it as one whitespace-separated token. Real bug found
 * live (06/09/2026): CONFIG.REPS stores first names only ('Sean', 'Joana',
 * 'Bens'), but a GHL opportunity's assignee resolves to a full display name
 * ('Sean Church') — an exact-string comparison meant a real rep with a GHL
 * last name could NEVER match, so "Unrecognized assignee" was flagging
 * actual team members (Sean, Joana) as unknown. Token matching fixes that;
 * the accepted tradeoff (documented, not accidental) is that a genuinely
 * different person who happens to share a first name with a known rep
 * (e.g. a different "Sean") would also be excluded — acceptable at this
 * team's size, and still just advisory (Tomás reviews the result either way).
 */
function ghlAssigneeNameMatchesKnownRep_(candidateName, knownNames) {
  var normalized = normalize_(candidateName);
  if (!normalized) return false;
  if (knownNames[normalized]) return true;
  var tokens = normalized.split(' ');
  for (var i = 0; i < tokens.length; i++) {
    if (knownNames[tokens[i]]) return true;
  }
  return false;
}

/**
 * Pure. Splits a list of raw assignee IDs into known vs. unrecognized, with
 * a count of how many open opportunities each unrecognized one carries —
 * so "who is this?" comes with "and they have 14 open deals," not just a
 * bare ID.
 *
 * Real bug found live (06/09/2026): `assigneeCounts` is keyed by the GHL
 * user ID (that's literally why this file's ID->name resolution exists at
 * all — GHL opportunities never carry a name), but this used to compare
 * the raw ID string directly against `knownNames` (real names) — which can
 * never match, so EVERY assignee on EVERY pipeline was flagged as
 * "unrecognized," including every real rep. `userNameLookup` (the same
 * id->name map fetchGhlLocationUsers_/buildGhlUserNameLookup_ already
 * build) is now required so the known-rep check happens against the
 * actual resolved name, not the ID it's stored under. An ID the lookup
 * can't resolve at all is conservatively treated as unrecognized (nothing
 * to compare against known names with) rather than silently excluded.
 */
function classifyUnknownAssignees_(assigneeCounts, knownNames, userNameLookup) {
  var unknown = [];
  Object.keys(assigneeCounts).forEach(function (id) {
    var trimmed = String(id || '').trim();
    if (!trimmed) return;
    var resolvedName = userNameLookup && userNameLookup[trimmed];
    if (resolvedName && ghlAssigneeNameMatchesKnownRep_(resolvedName, knownNames)) return;
    unknown.push({ name: trimmed, count: assigneeCounts[id] });
  });
  return unknown.sort(function (a, b) { return b.count - a.count; });
}

/**
 * Real bug found live (06/09/2026): "Unrecognized assignee" findings showed
 * raw GHL user IDs ("j3B1N9nwTDvgLyLgbcjI") instead of a name — GHL
 * opportunities carry `assignedTo` as a user ID, never a name, and this file
 * never resolved it. Useless for Tomás to act on: he can't tell who
 * "j3B1N9nwTDvgLyLgbcjI" is without going and looking it up himself, which
 * defeats the point of a quick-approve review. Fetches every user on the
 * location ONCE per run (GET /users/?locationId=..., read-only, same
 * self-diagnosing contract as fetchGhlPipelines_ in Phase9_GhlSync.gs) and
 * resolves IDs against that, instead of a per-ID call per finding.
 */
function fetchGhlLocationUsers_(locationId) {
  var path = '/users/?locationId=' + encodeURIComponent(locationId);
  var res = ghlApiGet_(path);

  if (res.status !== 200) {
    log_('Could not fetch GHL users (HTTP ' + res.status + ') — unrecognized-assignee findings will ' +
      'show raw IDs instead of names this run. Response body (first 500 chars): ' + String(res.body).slice(0, 500));
    log_('401/403 usually means the Private Integration token is missing the Users read scope ' +
      '("View Users" / users.readonly) — add it in GHL Settings -> Private Integrations, same place ' +
      'Custom Fields/Objects scopes were added 05/09/2026.');
    return null;
  }

  var users = (res.json && (res.json.users || res.json.data)) || [];
  return users;
}

/** Pure. userId -> display name, built fresh from the live user list every call. */
function buildGhlUserNameLookup_(users) {
  var lookup = {};
  (users || []).forEach(function (u) {
    if (!u || !u.id) return;
    var name = (u.name || ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || u.email || '');
    if (name) lookup[u.id] = name;
  });
  return lookup;
}

/**
 * Pure. Resolves one assignee ID to a human name, falling back to a
 * clearly-labeled ID when the lookup has nothing (missing scope, or a user
 * GHL itself doesn't return, e.g. a deactivated one). Kris, 06/09/2026,
 * looking at a resolved name still carrying its raw ID in parentheses:
 * "Don't need the big long number. No one knows what that is" — once a
 * real name is known, the ID is pure noise and is dropped entirely; it's
 * kept ONLY in the fallback case, where it's the one thing a human could
 * actually use to go look the user up themselves in GHL.
 */
function resolveGhlAssigneeLabel_(assigneeId, userNameLookup) {
  var name = userNameLookup && userNameLookup[assigneeId];
  return name || ('Unknown user (' + assigneeId + ')');
}

var CRM_ORGANIZATION_REVIEW_SHEET_NAME_ = 'CRM Organization Review';
var CRM_ORGANIZATION_REVIEW_HEADERS_ = [
  'Timestamp', 'Category', 'Finding', 'Evidence', 'Suggested Action', 'Approve', 'Reject'
];

function getOrCreateCrmOrganizationReviewSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CRM_ORGANIZATION_REVIEW_SHEET_NAME_);
  if (!sheet) {
    sheet = ss.insertSheet(CRM_ORGANIZATION_REVIEW_SHEET_NAME_);
    sheet.getRange(1, 1, 1, CRM_ORGANIZATION_REVIEW_HEADERS_.length)
      .setValues([CRM_ORGANIZATION_REVIEW_HEADERS_]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    // Deliberately NOT pre-formatting checkboxes over an empty range — that
    // exact mistake (Phase14_GhlStageTriage.gs, 05/09/2026) made
    // getLastRow() think blank rows held content and buried real data.
    // Checkboxes go on only the specific rows just written, below.
  }
  return sheet;
}

/** Same safe-append pattern as Phase14's nextGhlStageTriageWriteRow_: find the real next row from actual content in the Finding column, never trust getLastRow() alone. */
function nextCrmOrganizationReviewWriteRow_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 2;
  var findings = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
  for (var r = findings.length - 1; r >= 0; r--) {
    if (String(findings[r][0] || '').trim()) return r + 3;
  }
  return 2;
}

/** Apps Script's "Select function to run" dropdown hides trailing-underscore functions. */
function previewCrmOrganizationReview() {
  return previewCrmOrganizationReview_();
}

/**
 * READ-ONLY against GHL. Writes only to this file's own review sheet.
 */
function previewCrmOrganizationReview_() {
  RUN_TAG = 'previewCrmOrganizationReview_';
  var started = Date.now();
  var locationId = ghlCheckSetup_();

  log_('READ-ONLY CRM organization review. Nothing in GHL is changed.');

  var pipelines = fetchGhlPipelines_(locationId);
  if (!pipelines) { log_('Could not fetch pipelines — see the diagnostic above. Nothing written.'); return; }

  var knownNames = knownGhlAssigneeNames_();
  var pipelineFindings = [];
  var assigneeCounts = {};

  for (var p = 0; p < pipelines.length; p++) {
    if (Date.now() - started > CRM_ORGANIZATION_REVIEW_CONFIG.TIME_BUDGET_MS) {
      log_('Time budget reached mid-scan — reporting on the pipelines checked so far. Re-run to cover the rest.');
      break;
    }
    var pipeline = pipelines[p];
    var list = ghlListOpenOpportunitiesInPipeline_(locationId, pipeline.id, 100);
    if (!list.ok) {
      log_('Pipeline "' + pipeline.name + '": opportunity list FAILED, HTTP ' + list.status +
        ' — ' + String(list.body).slice(0, 300));
      continue;
    }
    if (list.possiblyTruncated) {
      log_('Pipeline "' + pipeline.name + '": ' + list.opportunities.length +
        ' open opportunity(s) returned, possibly truncated (single-page fetch, see Phase14_GhlStageTriage.gs).');
    }

    var stageCounts = {};
    list.opportunities.forEach(function (opp) {
      var stageInfo = pipeline.stages && pipeline.stages.filter(function (s) { return s.id === opp.pipelineStageId; })[0];
      var stageName = (stageInfo && stageInfo.name) || opp.pipelineStageId || '(unknown stage)';
      if (ghlStageIsTerminal_(stageName)) return; // closed deals aren't "stuck"
      stageCounts[stageName] = (stageCounts[stageName] || 0) + 1;

      var assignee = opp.assignedTo;
      if (assignee) assigneeCounts[assignee] = (assigneeCounts[assignee] || 0) + 1;
    });

    var concentration = classifyPipelineStageConcentration_(pipeline.name, stageCounts, CRM_ORGANIZATION_REVIEW_CONFIG);
    if (concentration) pipelineFindings.push(concentration);
  }

  // Must be fetched BEFORE classifying — see classifyUnknownAssignees_'s own
  // comment for the real bug this ordering fixes (comparing raw IDs against
  // known REP NAMES could never exclude anyone, real reps included).
  var userNameLookup = buildGhlUserNameLookup_(fetchGhlLocationUsers_(locationId));
  var unknownAssignees = classifyUnknownAssignees_(assigneeCounts, knownNames, userNameLookup);

  log_('Pipelines checked: ' + pipelines.length + '. ' + pipelineFindings.length +
    ' look potentially abandoned. ' + unknownAssignees.length + ' unrecognized assignee(s) found.');

  var sheet = getOrCreateCrmOrganizationReviewSheet_();
  var newRows = [];

  pipelineFindings.forEach(function (f) {
    newRows.push([
      new Date(), 'Pipeline health',
      '"' + f.pipelineName + '" — ' + f.sharePct + '% of open opportunities (' + f.topCount + ' of ' +
        f.total + ') sit in one stage: "' + f.topStage + '"',
      f.total + ' open opportunities scanned, none in a terminal stage.',
      'Confirm whether this pipeline is still actively worked, or should be archived/consolidated ' +
        '(GHL_PIPELINE_MAP.md flagged "Cold Calling 2" as this exact pattern on 27/08 — this re-checks live).',
      false, false
    ]);
  });

  unknownAssignees.forEach(function (a) {
    newRows.push([
      new Date(), 'Unrecognized assignee',
      resolveGhlAssigneeLabel_(a.name, userNameLookup) + ' is assigned ' + a.count +
        ' open opportunity(ies) but is not in CONFIG.REPS or the known-old-reps list (Bruno/Simon/Ty)',
      'Found on live, non-terminal opportunities across the pipelines scanned this run.',
      'Confirm who this is and whether their calls should be scored (GHL_PIPELINE_MAP.md §C, still open).',
      false, false
    ]);
  });

  if (newRows.length) {
    var writeRow = nextCrmOrganizationReviewWriteRow_(sheet);
    sheet.getRange(writeRow, 1, newRows.length, CRM_ORGANIZATION_REVIEW_HEADERS_.length).setValues(newRows);
    sheet.getRange(writeRow, 6, newRows.length, 2).insertCheckboxes();
    log_('Wrote ' + newRows.length + ' new finding(s) to "' + CRM_ORGANIZATION_REVIEW_SHEET_NAME_ + '".');
  } else {
    log_('Nothing new to report — no pipeline looked abandoned and no unrecognized assignee was found.');
  }

  log_('');
  log_('For likely DUPLICATE CONTACTS, see the "Ambiguous" rows already on "Lead Reconciliation - All" ' +
    '(Phase13_LeadReconciliation.gs) — found for free while matching leads to GHL, not recomputed here.');
  log_('Nothing in GHL was changed. Tomás ticks Approve or Reject per row — that decision is his.');
}

/**
 * Pure. Given one "Unrecognized assignee" Finding cell, returns the text it
 * SHOULD read given the current `userNameLookup` — or null if this cell
 * isn't that kind of finding at all (a different category, e.g. "Pipeline
 * health") or already reads exactly right.
 *
 * Three shapes, in order, each from a real state this data has actually
 * been in live (06/09/2026):
 *   1. LEGACY — before resolveGhlAssigneeLabel_ existed at all: the raw ID,
 *      quoted, as the whole subject — e.g. '"wEL0...CW" is assigned 48
 *      open opportunity(ies)...'. Needs a fresh lookup to resolve.
 *   2. UNKNOWN_FALLBACK — resolveGhlAssigneeLabel_'s own fallback from a
 *      run where the lookup had nothing for that ID (missing scope, as
 *      happened on the very first repair attempt) — e.g. 'Unknown user
 *      (wEL0...CW) is assigned...'. Also needs a fresh lookup — this is
 *      what makes it safe to run the repair BEFORE the scope is granted
 *      (falls back cleanly) and AGAIN after, and have the second run
 *      actually fix what the first one couldn't.
 *   3. RESOLVED_WITH_ID — a real name was already found, but (before
 *      resolveGhlAssigneeLabel_ dropped the ID entirely — Kris, 06/09/2026:
 *      "Don't need the big long number. No one knows what that is") still
 *      carried it in parentheses — e.g. 'Piero Bengoa (qd9X...IV) is
 *      assigned...'. This is a pure text edit: the name is already
 *      correct, so it's kept AS-IS and only the "(id)" suffix is dropped —
 *      deliberately never re-derived from userNameLookup, so an
 *      already-good name can never be downgraded to "Unknown user" by a
 *      later run whose user fetch happens to come back incomplete
 *      (missing scope again, a flaky call, pagination).
 */
function repairedUnrecognizedAssigneeFinding_(finding, userNameLookup) {
  var text = String(finding || '');

  var legacy = /^"([^"]+)"(\s+is assigned .*)$/.exec(text);
  if (legacy) {
    var resolvedLegacy = resolveGhlAssigneeLabel_(legacy[1], userNameLookup) + legacy[2];
    return resolvedLegacy === text ? null : resolvedLegacy;
  }

  var unknown = /^Unknown user \(([^)]+)\)(\s+is assigned .*)$/.exec(text);
  if (unknown) {
    var resolvedUnknown = resolveGhlAssigneeLabel_(unknown[1], userNameLookup) + unknown[2];
    return resolvedUnknown === text ? null : resolvedUnknown;
  }

  // Any other "<label> (id) is assigned ..." shape still carrying an ID —
  // by elimination (checked above) the label isn't "Unknown user", so this
  // is case 3: a real name that just needs the ID dropped, no lookup used.
  var resolvedWithId = /^(.+) \([^)]+\)(\s+is assigned .*)$/.exec(text);
  if (resolvedWithId) return resolvedWithId[1] + resolvedWithId[2];

  return null;
}

/** Apps Script's "Select function to run" dropdown hides trailing-underscore functions. */
function repairCrmOrganizationReviewAssigneeNames() {
  return repairCrmOrganizationReviewAssigneeNames_();
}

/**
 * One-time repair (06/09/2026, extended same day after Kris's "don't need
 * the big long number" follow-up). Rows already written to the sheet won't
 * pick up a resolveGhlAssigneeLabel_ format change on their own — re-running
 * previewCrmOrganizationReview_ wouldn't fix them either, since it has no
 * dedupe check against already-written findings (unlike Phase13's
 * dedupe-by-key) and would just add a SECOND row for the same finding.
 *
 * This instead rewrites ONLY the Finding cell of "Unrecognized assignee"
 * rows still needing a change (see repairedUnrecognizedAssigneeFinding_),
 * in place — no new rows, no re-scan of GHL opportunities, just one
 * GET /users/ call (same as fetchGhlLocationUsers_ uses elsewhere; a
 * dedicated GHL_PIPELINE_MAP name it's an established pattern for by now).
 * Safe to run more than once — a row that already reads correctly is left
 * untouched. Nothing in GHL is changed.
 */
function repairCrmOrganizationReviewAssigneeNames_() {
  RUN_TAG = 'repairCrmOrganizationReviewAssigneeNames_';
  var locationId = ghlCheckSetup_();
  var userNameLookup = buildGhlUserNameLookup_(fetchGhlLocationUsers_(locationId));

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CRM_ORGANIZATION_REVIEW_SHEET_NAME_);
  if (!sheet) { log_('"' + CRM_ORGANIZATION_REVIEW_SHEET_NAME_ + '" does not exist yet — nothing to repair.'); return; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { log_('No data rows — nothing to repair.'); return; }

  var findings = sheet.getRange(2, 3, lastRow - 1, 1).getValues(); // Finding column (C)
  var fixedCount = 0;
  for (var r = 0; r < findings.length; r++) {
    var newText = repairedUnrecognizedAssigneeFinding_(findings[r][0], userNameLookup);
    if (newText === null) continue;
    findings[r][0] = newText;
    fixedCount++;
  }
  if (fixedCount) {
    sheet.getRange(2, 3, findings.length, 1).setValues(findings);
  }
  log_('Fixed ' + fixedCount + ' row(s) — resolved a raw GHL user ID into a name where possible, and dropped ' +
    'the "(id)" suffix from names already resolved. Anything still unresolved reads "Unknown user (id)" so ' +
    'it can still be looked up by hand.');
  log_('Nothing else on the sheet was touched, and nothing in GHL was changed.');
}
