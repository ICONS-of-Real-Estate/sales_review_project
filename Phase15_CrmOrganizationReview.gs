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
 * Pure. Splits a list of raw assignee values into known vs. unrecognized,
 * with a count of how many open opportunities each unrecognized one carries
 * — so "who is KD?" comes with "and they have 14 open deals," not just a
 * bare name.
 */
function classifyUnknownAssignees_(assigneeCounts, knownNames) {
  var unknown = [];
  Object.keys(assigneeCounts).forEach(function (raw) {
    var trimmed = String(raw || '').trim();
    if (!trimmed) return;
    if (knownNames[normalize_(trimmed)]) return;
    unknown.push({ name: trimmed, count: assigneeCounts[raw] });
  });
  return unknown.sort(function (a, b) { return b.count - a.count; });
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

  var unknownAssignees = classifyUnknownAssignees_(assigneeCounts, knownNames);

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
      '"' + a.name + '" is assigned ' + a.count + ' open opportunity(ies) but is not in CONFIG.REPS ' +
        'or the known-old-reps list (Bruno/Simon/Ty)',
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
