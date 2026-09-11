/**
 * Phase21_DailyLeadApprovalDigest.gs
 *
 * Kris's ask (11/09/2026): every work-day morning, send Sean/Bens/Joana
 * (cc Kris + Tomás) their prioritized list of old leads that need
 * follow-up, with a link where each rep can:
 *   - set their own daily list size (10/25/50/100),
 *   - approve/reject the list individually or all at once, with an
 *     optional comment on each lead ("so the system can learn"),
 *   - and, once confirmed, have follow-up drafts appear in THEIR OWN
 *     Gmail inbox, ready for them to review and send — never auto-sent.
 *
 * WHY THIS SIDESTEPS THE gmail.compose BLOCKER (Phase17_
 * SeanFollowUpAutomation.gs's own header): that file's drafting step has
 * been stuck since 06/09/2026 on a domain-wide-delegation gmail.compose
 * scope for a SHARED automation identity to write into someone else's
 * mailbox. This workflow never needs that: the approval link is an Apps
 * Script web app deployed to run "as the user accessing it" (see
 * appsscript.json's webapp block) — when Sean opens the link and clicks
 * Approve, doPost_ runs AS SEAN, so GmailApp.createDraft() creates the
 * draft directly in Sean's own Drafts folder under his own Google login.
 * No shared credential, no Admin Console scope, no impersonation. The
 * tradeoff: each rep must open the link signed into their own
 * @iconsofrealestate.com account (enforced by appsscript.json's
 * `"access": "DOMAIN"`), not while logged out or as someone else.
 *
 * PRIORITY (Kris's own three tiers, 11/09/2026):
 *   1. Most recently gone stale first — an open opportunity qualifies once
 *      it's sat untouched >= STALE_MIN_DAYS (reuses ghlOpportunityStaleDays_,
 *      Phase14_GhlStageTriage.gs); the smallest staleness among qualifying
 *      leads sorts first ("just went cold" beats "went cold months ago").
 *   2. Furthest through the pipeline — stage position, normalized 0 (first
 *      stage) to 1 (last stage) so it's comparable ACROSS pipelines of
 *      different lengths (a rep can have leads in more than one pipeline).
 *   3. Most touches — count of real (non-AI-note) GHL contact notes,
 *      reusing ghlNoteIsOurOwn_'s own "our own note isn't evidence of human
 *      activity" filter (Phase14_GhlStageTriage.gs). Only computed for a
 *      bounded candidate pool (tiers 1-2 already narrow it), since each
 *      lookup is its own API call.
 *
 * NOT BUILT YET / DELIBERATELY SIMPLE for a v1: draft body text is one
 * generic template, not per-rep-voice (Sean/Bens/Joana's individual
 * playbooks, e.g. Discovery_Playbook_Sean.md, aren't wired in) — Kris/Tomás
 * should look at a real batch of drafts before that's worth building.
 * Rejection comments are recorded (Lead Digest Queue's own Comment column)
 * but nothing reads them back into the ranking yet ("so the system can
 * learn" is future work, flagged here rather than silently promised).
 *
 * GATED BEHIND DAILY_LEAD_APPROVAL_CONFIG.ENABLED — false until
 * previewDailyLeadApprovalDigest() has been run and reviewed, AND the web
 * app has been deployed (Deploy -> New deployment -> Web app, execute as
 * "User accessing the web app", access "Anyone within iconsofrealestate.com")
 * and DAILY_LEAD_APPROVAL_CONFIG.WEBAPP_URL_OVERRIDE confirmed against the
 * real deployment URL — same preview-before-live discipline as every other
 * phase in this project (CLAUDE.md).
 */

var DAILY_LEAD_APPROVAL_CONFIG = {
  ENABLED: false, // flip after previewDailyLeadApprovalDigest() looks right AND the web app is deployed
  REPS: ['Sean', 'Bens', 'Joana'], // Kris's own list, 11/09/2026 — Tomás is cc'd, not sent his own digest
  ALLOWED_DAILY_LEAD_COUNTS: [10, 25, 50, 100],
  DEFAULT_DAILY_LEAD_COUNT: 25,
  STALE_MIN_DAYS: 3, // an open opportunity counts as "needs follow-up" once it's sat this long untouched
  CANDIDATE_POOL_MULTIPLIER: 3, // how many tier-1/2-ranked candidates get a real touches lookup before the final cap
  TRIGGER_HOUR: 7, // morning, CONFIG.BUSINESS_TIMEZONE
  // Set this to the real deployed web app URL once known (Deploy -> Manage
  // deployments in the Apps Script editor) — ScriptApp.getService().getUrl()
  // already returns the right value from INSIDE a request the web app
  // itself is serving, but a trigger-fired email send has no such request
  // context, so it needs this explicit fallback instead. Left blank on
  // purpose until a real deployment exists — runDailyLeadApprovalDigest_
  // refuses to send without it rather than emailing a broken link.
  WEBAPP_URL_OVERRIDE: ''
};

var LEAD_DIGEST_SETTINGS_SHEET_NAME = 'Lead Digest Settings';
var LEAD_DIGEST_SETTINGS_HEADERS = ['Rep', 'Daily Lead Count', 'Updated At'];

var LEAD_DIGEST_QUEUE_SHEET_NAME = 'Lead Digest Queue';
var LEAD_DIGEST_QUEUE_HEADERS = [
  'Token', 'Digest Date', 'Rep', 'Contact ID', 'Opportunity ID', 'Lead Name', 'Lead Email',
  'Pipeline', 'Stage', 'Days Stale', 'Touches', 'Priority Rank', 'Status', 'Comment', 'Decided At'
];

function getOrCreateLeadDigestSettingsSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(LEAD_DIGEST_SETTINGS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LEAD_DIGEST_SETTINGS_SHEET_NAME);
    sheet.getRange(1, 1, 1, LEAD_DIGEST_SETTINGS_HEADERS.length).setValues([LEAD_DIGEST_SETTINGS_HEADERS])
      .setFontWeight('bold').setBackground('#e8eef7');
    sheet.setFrozenRows(1);
    log_('Created "' + LEAD_DIGEST_SETTINGS_SHEET_NAME + '" tab.');
  }
  return sheet;
}

function getOrCreateLeadDigestQueueSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(LEAD_DIGEST_QUEUE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LEAD_DIGEST_QUEUE_SHEET_NAME);
    sheet.getRange(1, 1, 1, LEAD_DIGEST_QUEUE_HEADERS.length).setValues([LEAD_DIGEST_QUEUE_HEADERS])
      .setFontWeight('bold').setBackground('#e8eef7');
    sheet.setFrozenRows(1);
    log_('Created "' + LEAD_DIGEST_QUEUE_SHEET_NAME + '" tab.');
  }
  return sheet;
}

// ---------------------------------------------------------------------------
// Pure logic — settings, priority ranking, email/HTML building. Covered by
// tests/run_tests.js (see GAS_FILES in tests/gas_env.js).
// ---------------------------------------------------------------------------

/** Pure. Any daily-count value not in ALLOWED_DAILY_LEAD_COUNTS (missing, malformed, a typed-in override) falls back to the default rather than silently sending 0 or an unbounded list. */
function clampDailyLeadCount_(n) {
  var num = Number(n);
  return DAILY_LEAD_APPROVAL_CONFIG.ALLOWED_DAILY_LEAD_COUNTS.indexOf(num) !== -1
    ? num
    : DAILY_LEAD_APPROVAL_CONFIG.DEFAULT_DAILY_LEAD_COUNT;
}

/** Pure. Rep -> daily lead count, from the settings sheet's raw rows, last row per rep wins (append-only convention, same as reengagementOverrideActionsFromRows_, Phase17_SeanFollowUpAutomation.gs). */
function leadDigestSettingsMapFromRows_(rows) {
  var byRep = {};
  (rows || []).forEach(function (row) {
    var rep = String(row[0] || '').trim();
    if (!rep) return;
    byRep[rep] = clampDailyLeadCount_(row[1]);
  });
  return byRep;
}

function getLeadDigestDailyCountForRep_(sheet, rep) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return DAILY_LEAD_APPROVAL_CONFIG.DEFAULT_DAILY_LEAD_COUNT;
  var rows = sheet.getRange(2, 1, lastRow - 1, LEAD_DIGEST_SETTINGS_HEADERS.length).getValues();
  var map = leadDigestSettingsMapFromRows_(rows);
  return map[rep] !== undefined ? map[rep] : DAILY_LEAD_APPROVAL_CONFIG.DEFAULT_DAILY_LEAD_COUNT;
}

function setLeadDigestDailyCountForRep_(sheet, rep, count) {
  sheet.appendRow([rep, clampDailyLeadCount_(count), new Date()]);
}

/**
 * Pure. stageId -> 0 (first stage in its own pipeline) .. 1 (last stage),
 * so "furthest through the pipeline" is comparable across pipelines of
 * different lengths — a rep's stale leads can span more than one pipeline.
 * A single-stage pipeline maps its only stage to 0 (nothing to be "further
 * through" than the start).
 */
function buildGhlStageOrderLookup_(pipelines) {
  var lookup = {};
  (pipelines || []).forEach(function (p) {
    var stages = p.stages || [];
    var denom = Math.max(stages.length - 1, 1);
    stages.forEach(function (s, idx) {
      lookup[s.id] = idx / denom;
    });
  });
  return lookup;
}

/**
 * Pure. Given a raw opportunity + the pipeline it belongs to, decides
 * whether it's a "needs follow-up" candidate at all and, if so, builds the
 * plain-object shape the rest of this file ranks/renders. Returns null for
 * a terminal-stage or not-yet-stale-enough opportunity, or one with no
 * contact/email to draft a follow-up against at all.
 */
function buildLeadDigestCandidate_(opportunity, pipeline, stageOrderLookup, nowMs) {
  var stageInfo = (pipeline.stages || []).filter(function (s) { return s.id === opportunity.pipelineStageId; })[0];
  var stageName = (stageInfo && stageInfo.name) || opportunity.pipelineStageId || '(unknown stage)';
  if (ghlStageIsTerminal_(stageName)) return null;

  var daysStale = ghlOpportunityStaleDays_(opportunity, nowMs);
  if (daysStale === null || daysStale < DAILY_LEAD_APPROVAL_CONFIG.STALE_MIN_DAYS) return null;

  var contact = opportunity.contact || {};
  var leadEmail = String(contact.email || '').trim();
  if (!leadEmail) return null; // nothing to draft a follow-up to

  return {
    contactId: opportunity.contactId,
    opportunityId: opportunity.id,
    leadName: contact.name || opportunity.name || '(unnamed)',
    leadEmail: leadEmail,
    pipelineName: pipeline.name || '',
    stageName: stageName,
    daysStale: daysStale,
    stageOrder: stageOrderLookup[opportunity.pipelineStageId] || 0,
    touches: 0 // filled in later for the bounded candidate pool only — see collectStaleLeadsForRep_
  };
}

/**
 * Pure. Kris's own three tiers (11/09/2026): freshest-gone-stale first,
 * then furthest through the pipeline, then most touches. Ties beyond all
 * three are stable (Array#sort in V8/Node is stable) and just keep
 * whatever order the candidates arrived in.
 */
function compareLeadDigestPriority_(a, b) {
  if (a.daysStale !== b.daysStale) return a.daysStale - b.daysStale;
  if (a.stageOrder !== b.stageOrder) return b.stageOrder - a.stageOrder;
  return (b.touches || 0) - (a.touches || 0);
}

/** Pure. Sorts by compareLeadDigestPriority_ and caps to `count`, stamping each surviving lead with its final 1-based Priority Rank. */
function rankAndCapLeadDigestCandidates_(candidates, count) {
  return candidates.slice().sort(compareLeadDigestPriority_).slice(0, count).map(function (lead, idx) {
    var withRank = {};
    Object.keys(lead).forEach(function (k) { withRank[k] = lead[k]; });
    withRank.priorityRank = idx + 1;
    return withRank;
  });
}

/** Pure. Plain-text + HTML for the morning digest email. `approvalUrl` already carries the rep's token. */
function buildLeadDigestEmail_(rep, leads, approvalUrl) {
  var subject = rep + '’s lead follow-ups for today (' + leads.length + ')';
  var lines = leads.map(function (l) {
    return l.priorityRank + '. ' + l.leadName + ' (' + l.leadEmail + ') — ' + l.pipelineName + ' / ' +
      l.stageName + ', stale ' + l.daysStale + ' day(s), ' + l.touches + ' touch(es).';
  });
  var body = (leads.length
    ? lines.join('\n') + '\n\nReview, adjust, and approve here:\n' + approvalUrl
    : 'No leads need follow-up today.') +
    '\n\n— Sent automatically.';

  var htmlBody = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    (leads.length
      ? '<ol style="padding-left:20px;">' +
        leads.map(function (l) {
          return '<li>' + escapeHtml_(l.leadName) + ' (' + escapeHtml_(l.leadEmail) + ') — ' +
            escapeHtml_(l.pipelineName) + ' / ' + escapeHtml_(l.stageName) + ', stale ' + l.daysStale +
            ' day(s), ' + l.touches + ' touch(es).</li>';
        }).join('') + '</ol>' +
        '<p><a href="' + approvalUrl + '" style="display:inline-block;padding:10px 18px;background:#1e7d46;' +
        'color:#fff;text-decoration:none;border-radius:6px;">Review &amp; approve today’s list</a></p>'
      : '<p>No leads need follow-up today.</p>') +
    '<p style="color:#666;font-size:12px;margin-top:16px;"><i>— Sent automatically.</i></p>' +
    '</div>';

  return { subject: subject, body: body, htmlBody: htmlBody };
}

/** Pure. The starting-point follow-up draft — deliberately generic for v1, see file header. */
function buildFollowUpDraftEmail_(lead) {
  var subject = 'Following up, ' + lead.leadName;
  var body = 'Hi ' + lead.leadName + ',\n\n' +
    'Wanted to check back in — last I had you at "' + lead.stageName + '" and didn’t want you to fall ' +
    'through the cracks. Do you have a few minutes this week to pick back up?\n\n' +
    'Let me know what works.\n\n' +
    'Best,';
  return { subject: subject, body: body };
}

// ---------------------------------------------------------------------------
// Orchestration — real GHL/Sheets/Gmail calls. Not covered by
// tests/run_tests.js (same "thin wrapper around tested pure logic" split as
// every other phase's own API-calling functions, e.g.
// buildAndMaybeSendReengagementDigest_, Phase17_SeanFollowUpAutomation.gs).
// ---------------------------------------------------------------------------

/** Every open, non-terminal opportunity assigned to `repName` across every pipeline, turned into ranked candidates capped at `count`. Touches are looked up for a bounded pool only (tier-1/2 order first, then the top CANDIDATE_POOL_MULTIPLIER * count get a real notes lookup) — a full-account touches lookup would be one API call per lead, most of which get thrown away by tiers 1-2 anyway. */
function collectStaleLeadsForRep_(locationId, pipelines, userNameLookup, repName, nowMs, count) {
  var stageOrderLookup = buildGhlStageOrderLookup_(pipelines);
  var candidates = [];

  pipelines.forEach(function (pipeline) {
    var list = ghlListOpenOpportunitiesInPipeline_(locationId, pipeline.id, 100);
    if (!list.ok) {
      log_('collectStaleLeadsForRep_: pipeline "' + pipeline.name + '" fetch failed (HTTP ' + list.status +
        ') — skipped for this run.');
      return;
    }
    list.opportunities.forEach(function (opp) {
      var assigneeName = userNameLookup[opp.assignedTo];
      if (!assigneeName || !ghlAssigneeNameMatchesKnownRep_(assigneeName, (function () {
        var known = {}; known[normalize_(repName)] = true; return known;
      })())) return;
      var candidate = buildLeadDigestCandidate_(opp, pipeline, stageOrderLookup, nowMs);
      if (candidate) candidates.push(candidate);
    });
  });

  // Tiers 1-2 first (cheap, no API calls), THEN spend real API calls on
  // touches only for the pool that could plausibly still make the cut.
  var poolSize = Math.min(candidates.length, count * DAILY_LEAD_APPROVAL_CONFIG.CANDIDATE_POOL_MULTIPLIER);
  var pool = candidates.slice().sort(compareLeadDigestPriority_).slice(0, poolSize);
  pool.forEach(function (c) { c.touches = ghlContactTouchCount_(c.contactId); });

  return rankAndCapLeadDigestCandidates_(pool, count);
}

/** Real, non-AI-authored note count on a contact — reuses ghlNoteIsOurOwn_'s own filter (Phase14_GhlStageTriage.gs). Never throws; a lookup failure just reads as 0 touches, same "no evidence found, not definitely zero, but never guess higher" honesty as ghlMostRecentNoteDate_. */
function ghlContactTouchCount_(contactId) {
  var res = ghlApiGet_('/contacts/' + encodeURIComponent(contactId) + '/notes');
  if (res.status !== 200) return 0;
  var notes = (res.json && (res.json.notes || res.json.data)) || [];
  return notes.filter(function (n) { return !ghlNoteIsOurOwn_(n); }).length;
}

function todayDigestDateString_() {
  return Utilities.formatDate(new Date(), CONFIG.BUSINESS_TIMEZONE, 'yyyy-MM-dd');
}

/** True if `rep` already has a digest recorded for today — checked before generating a new one, so a trigger firing twice in the same morning window never sends a rep two separate digests/tokens. */
function repAlreadyHasTodaysDigest_(queueSheet, rep, todayStr) {
  var lastRow = queueSheet.getLastRow();
  if (lastRow < 2) return false;
  var rows = queueSheet.getRange(2, 1, lastRow - 1, LEAD_DIGEST_QUEUE_HEADERS.length).getValues();
  var repCol = LEAD_DIGEST_QUEUE_HEADERS.indexOf('Rep');
  var dateCol = LEAD_DIGEST_QUEUE_HEADERS.indexOf('Digest Date');
  return rows.some(function (r) { return String(r[repCol]) === rep && String(r[dateCol]) === todayStr; });
}

function appendLeadDigestQueueRows_(sheet, token, todayStr, rep, leads) {
  var rows = leads.map(function (l) {
    return [
      token, todayStr, rep, l.contactId, l.opportunityId, l.leadName, l.leadEmail,
      l.pipelineName, l.stageName, l.daysStale, l.touches, l.priorityRank,
      'pending', '', ''
    ];
  });
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, LEAD_DIGEST_QUEUE_HEADERS.length).setValues(rows);
  }
}

function leadDigestApprovalUrl_(token) {
  var base = DAILY_LEAD_APPROVAL_CONFIG.WEBAPP_URL_OVERRIDE || ScriptApp.getService().getUrl();
  return base + '?token=' + encodeURIComponent(token);
}

/** Shared by preview and live paths. dryRun=true never writes or sends. */
function buildAndMaybeSendLeadDigests_(dryRun) {
  RUN_TAG = 'buildAndMaybeSendLeadDigests_';
  var locationId = ghlCheckSetup_();
  var pipelines = fetchGhlPipelines_(locationId);
  if (!pipelines) { log_('buildAndMaybeSendLeadDigests_: could not fetch pipelines, aborting this run.'); return 0; }
  var userNameLookup = buildGhlUserNameLookup_(fetchGhlLocationUsers_(locationId));
  var nowMs = new Date().getTime();
  var todayStr = todayDigestDateString_();

  var settingsSheet = getOrCreateLeadDigestSettingsSheet_();
  var queueSheet = getOrCreateLeadDigestQueueSheet_();
  var repByName = {};
  CONFIG.REPS.forEach(function (r) { repByName[r.name] = r; });

  var totalSent = 0;
  DAILY_LEAD_APPROVAL_CONFIG.REPS.forEach(function (repName) {
    var repConfig = repByName[repName];
    if (!repConfig) {
      log_('buildAndMaybeSendLeadDigests_: "' + repName + '" is not in CONFIG.REPS — skipped.');
      return;
    }
    if (!dryRun && repAlreadyHasTodaysDigest_(queueSheet, repName, todayStr)) {
      log_('buildAndMaybeSendLeadDigests_: ' + repName + ' already has a digest for ' + todayStr + ' — skipped.');
      return;
    }

    var count = getLeadDigestDailyCountForRep_(settingsSheet, repName);
    var leads = collectStaleLeadsForRep_(locationId, pipelines, userNameLookup, repName, nowMs, count);

    if (dryRun) {
      log_('(preview) ' + repName + ': ' + leads.length + ' lead(s) (of up to ' + count + ') would be sent.');
      leads.forEach(function (l) {
        log_('  #' + l.priorityRank + ' ' + l.leadName + ' (' + l.leadEmail + ') — ' + l.pipelineName + ' / ' +
          l.stageName + ', stale ' + l.daysStale + 'd, ' + l.touches + ' touch(es).');
      });
      return;
    }

    if (!leads.length) {
      log_('buildAndMaybeSendLeadDigests_: ' + repName + ' has no leads needing follow-up today — no email sent.');
      return;
    }
    if (!DAILY_LEAD_APPROVAL_CONFIG.WEBAPP_URL_OVERRIDE && !ScriptApp.getService()) {
      log_('buildAndMaybeSendLeadDigests_: no web app deployed and no WEBAPP_URL_OVERRIDE set — refusing to ' +
        'send ' + repName + ' a digest with a broken approval link.');
      return;
    }

    var token = Utilities.getUuid();
    var approvalUrl = leadDigestApprovalUrl_(token);
    var email = buildLeadDigestEmail_(repName, leads, approvalUrl);
    var sent = guardedSend_(repConfig.email, email.subject, email.body, {
      cc: CONFIG.KRIS_EMAIL + ',' + CONFIG.TOMAS_EMAIL,
      htmlBody: email.htmlBody,
      name: 'Lead Follow-Up Bot'
    }, 3); // rep + Kris + Tomás
    if (!sent) {
      log_('buildAndMaybeSendLeadDigests_: send failed/skipped for ' + repName + ' — queue not written, will retry next run.');
      return;
    }
    appendLeadDigestQueueRows_(queueSheet, token, todayStr, repName, leads);
    totalSent++;
    log_('buildAndMaybeSendLeadDigests_: sent ' + repName + ' ' + leads.length + ' lead(s), token ' + token + '.');
  });
  return totalSent;
}

/** Run this FIRST from the editor. Logs what it would send — nothing is written or sent. */
function previewDailyLeadApprovalDigest() {
  return previewDailyLeadApprovalDigest_();
}

function previewDailyLeadApprovalDigest_() {
  RUN_TAG = 'previewDailyLeadApprovalDigest_';
  log_('PREVIEW MODE — nothing will be written or sent.');
  return buildAndMaybeSendLeadDigests_(/*dryRun=*/true);
}

/** Trigger target — see runPhase17To19StandingChecks_ (Phase17_SeanFollowUpAutomation.gs), which this joins as a sixth consolidated pass rather than getting its own trigger (project trigger-cap history, same file's own header). */
function runDailyLeadApprovalDigest() {
  RUN_TAG = 'runDailyLeadApprovalDigest';
  if (!DAILY_LEAD_APPROVAL_CONFIG.ENABLED) {
    log_('runDailyLeadApprovalDigest: DAILY_LEAD_APPROVAL_CONFIG.ENABLED is false, skipping.');
    return 0;
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runDailyLeadApprovalDigest: another run holds the lock, skipping this firing.');
    return 0;
  }
  try {
    return buildAndMaybeSendLeadDigests_(/*dryRun=*/false);
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Web app — the approval link itself. Deployed with executeAs "User
// accessing the web app" (appsscript.json), so every doGet_/doPost_ call
// below runs AS the rep who clicked the link, not as whoever owns the
// script. That is exactly what lets GmailApp.createDraft() land a draft in
// THEIR OWN mailbox with zero domain-wide-delegation setup — see file
// header. `doGet`/`doPost` are Apps Script's own reserved global entry
// point names (no trailing underscore, unlike this project's usual
// convention) — kept here since this is the only file that needs them.
// ---------------------------------------------------------------------------

/** Every queue row for `token`, as plain objects, in Priority Rank order. */
function getLeadDigestQueueRowsForToken_(sheet, token) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, LEAD_DIGEST_QUEUE_HEADERS.length).getValues();
  var col = {};
  LEAD_DIGEST_QUEUE_HEADERS.forEach(function (h, i) { col[h] = i; });
  var rows = [];
  values.forEach(function (v, i) {
    if (String(v[col['Token']]) !== token) return;
    rows.push({
      sheetRow: i + 2,
      token: v[col['Token']], digestDate: v[col['Digest Date']], rep: v[col['Rep']],
      contactId: v[col['Contact ID']], opportunityId: v[col['Opportunity ID']],
      leadName: v[col['Lead Name']], leadEmail: v[col['Lead Email']],
      pipelineName: v[col['Pipeline']], stageName: v[col['Stage']],
      daysStale: v[col['Days Stale']], touches: v[col['Touches']], priorityRank: v[col['Priority Rank']],
      status: v[col['Status']], comment: v[col['Comment']], decidedAt: v[col['Decided At']]
    });
  });
  rows.sort(function (a, b) { return a.priorityRank - b.priorityRank; });
  return rows;
}

/** Pure. Escapes a value for safe use inside an HTML attribute (form field names/values built from opportunity IDs). */
function escapeHtmlAttr_(s) {
  return escapeHtml_(String(s == null ? '' : s));
}

/** Builds the approval page's full HTML. Pure given `rows`/`dailyCount`/`token` — no direct Sheets/GHL calls inside, so the layout itself is testable without a fake HtmlService. */
function renderLeadDigestApprovalPage_(token, rep, rows, dailyCount) {
  var allDecided = rows.length > 0 && rows.every(function (r) { return r.status !== 'pending'; });
  var counts = { approved: 0, rejected: 0, pending: 0 };
  rows.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });

  var style = 'body{font-family:Arial,Helvetica,sans-serif;max-width:760px;margin:2rem auto;color:#222;}' +
    'table{border-collapse:collapse;width:100%;} td,th{padding:8px 10px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top;}' +
    'textarea{width:100%;min-height:40px;} .bulk button{margin-right:8px;padding:6px 12px;} ' +
    '.approved{color:#1e7d46;font-weight:bold;} .rejected{color:#8f2323;font-weight:bold;}';

  if (!rows.length) {
    return '<html><head><style>' + style + '</style></head><body>' +
      '<h2>No leads found for this link.</h2><p>It may have expired or already been superseded by a newer digest.</p>' +
      '</body></html>';
  }

  if (allDecided) {
    return '<html><head><style>' + style + '</style></head><body>' +
      '<h2>' + escapeHtmlAttr_(rep) + '’s list — already submitted</h2>' +
      '<p>' + counts.approved + ' approved (draft' + (counts.approved === 1 ? '' : 's') + ' created in your inbox), ' +
      counts.rejected + ' rejected.</p>' +
      '</body></html>';
  }

  var settingsOptions = DAILY_LEAD_APPROVAL_CONFIG.ALLOWED_DAILY_LEAD_COUNTS.map(function (n) {
    return '<label style="margin-right:14px;"><input type="radio" name="dailyLeadCount" value="' + n + '"' +
      (n === dailyCount ? ' checked' : '') + '> ' + n + '</label>';
  }).join('');

  var rowsHtml = rows.map(function (r) {
    var id = escapeHtmlAttr_(r.opportunityId);
    if (r.status !== 'pending') {
      return '<tr><td>#' + r.priorityRank + '</td><td>' + escapeHtmlAttr_(r.leadName) + '<br><small>' +
        escapeHtmlAttr_(r.leadEmail) + '</small></td><td>' + escapeHtmlAttr_(r.pipelineName) + ' / ' +
        escapeHtmlAttr_(r.stageName) + '</td><td>' + r.daysStale + 'd, ' + r.touches + ' touch(es)</td>' +
        '<td class="' + r.status + '">' + r.status + '</td><td>' + escapeHtmlAttr_(r.comment) + '</td></tr>';
    }
    return '<tr><td>#' + r.priorityRank + '</td>' +
      '<td>' + escapeHtmlAttr_(r.leadName) + '<br><small>' + escapeHtmlAttr_(r.leadEmail) + '</small></td>' +
      '<td>' + escapeHtmlAttr_(r.pipelineName) + ' / ' + escapeHtmlAttr_(r.stageName) + '</td>' +
      '<td>' + r.daysStale + 'd, ' + r.touches + ' touch(es)</td>' +
      '<td>' +
      '<label><input type="radio" class="decision" name="status_' + id + '" value="approved" checked> Approve</label><br>' +
      '<label><input type="radio" class="decision" name="status_' + id + '" value="rejected"> Reject</label>' +
      '</td>' +
      '<td><textarea name="comment_' + id + '" placeholder="Optional comment"></textarea></td></tr>';
  }).join('');

  return '<html><head><style>' + style + '</style></head><body>' +
    '<h2>' + escapeHtmlAttr_(rep) + '’s lead follow-ups — review &amp; approve</h2>' +
    '<form method="post" action="?token=' + encodeURIComponent(token) + '">' +
    '<input type="hidden" name="token" value="' + escapeHtmlAttr_(token) + '">' +
    '<p><strong>Daily list size:</strong> ' + settingsOptions + '</p>' +
    '<div class="bulk">' +
    '<button type="button" onclick="setAll(\'approved\')">Approve all</button>' +
    '<button type="button" onclick="setAll(\'rejected\')">Reject all</button>' +
    '</div>' +
    '<table><thead><tr><th>#</th><th>Lead</th><th>Where</th><th>Stale</th><th>Decision</th><th>Comment</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table>' +
    '<p><button type="submit">Submit</button></p>' +
    '</form>' +
    '<script>function setAll(v){document.querySelectorAll("input.decision[value=\'"+v+"\']").forEach(' +
    'function(el){el.checked=true;});}</script>' +
    '</body></html>';
}

function doGet(e) {
  var token = e && e.parameter && e.parameter.token;
  if (!token) {
    return HtmlService.createHtmlOutput('<p>Missing token — use the link from your digest email.</p>');
  }
  var queueSheet = getOrCreateLeadDigestQueueSheet_();
  var rows = getLeadDigestQueueRowsForToken_(queueSheet, token);
  var rep = rows.length ? rows[0].rep : '';
  var settingsSheet = getOrCreateLeadDigestSettingsSheet_();
  var dailyCount = rep ? getLeadDigestDailyCountForRep_(settingsSheet, rep) : DAILY_LEAD_APPROVAL_CONFIG.DEFAULT_DAILY_LEAD_COUNT;
  return HtmlService.createHtmlOutput(renderLeadDigestApprovalPage_(token, rep, rows, dailyCount));
}

/** Draft creation runs as whoever is submitting the form — see this section's own header. Only rows still 'pending' in the sheet are acted on, so re-submitting an already-decided link never creates a second draft for the same lead. */
function doPost(e) {
  var token = e && e.parameter && e.parameter.token;
  if (!token) {
    return HtmlService.createHtmlOutput('<p>Missing token.</p>');
  }
  var queueSheet = getOrCreateLeadDigestQueueSheet_();
  var rows = getLeadDigestQueueRowsForToken_(queueSheet, token);
  if (!rows.length) {
    return HtmlService.createHtmlOutput('<p>No leads found for this link — it may have expired.</p>');
  }
  var rep = rows[0].rep;

  if (e.parameter.dailyLeadCount) {
    setLeadDigestDailyCountForRep_(getOrCreateLeadDigestSettingsSheet_(), rep, e.parameter.dailyLeadCount);
  }

  var now = new Date();
  var approvedCount = 0, rejectedCount = 0, draftFailures = 0;
  rows.forEach(function (r) {
    if (r.status !== 'pending') return; // already decided on a prior submit — leave as-is
    var status = e.parameter['status_' + r.opportunityId] === 'rejected' ? 'rejected' : 'approved';
    var comment = String(e.parameter['comment_' + r.opportunityId] || '').trim();

    if (status === 'approved') {
      try {
        var draft = buildFollowUpDraftEmail_(r);
        GmailApp.createDraft(r.leadEmail, draft.subject, draft.body);
        approvedCount++;
      } catch (err) {
        log_('doPost: GmailApp.createDraft failed for ' + r.leadEmail + ': ' + err);
        draftFailures++;
        status = 'approved'; // still record the decision; the draft can be retried by hand
      }
    } else {
      rejectedCount++;
    }
    queueSheet.getRange(r.sheetRow, LEAD_DIGEST_QUEUE_HEADERS.indexOf('Status') + 1).setValue(status);
    queueSheet.getRange(r.sheetRow, LEAD_DIGEST_QUEUE_HEADERS.indexOf('Comment') + 1).setValue(comment);
    queueSheet.getRange(r.sheetRow, LEAD_DIGEST_QUEUE_HEADERS.indexOf('Decided At') + 1).setValue(now);
  });

  var message = '<h2>Thanks!</h2><p>' + approvedCount + ' approved (draft' + (approvedCount === 1 ? '' : 's') +
    ' created in your Gmail Drafts), ' + rejectedCount + ' rejected.</p>' +
    (draftFailures ? '<p style="color:#8f2323;">' + draftFailures + ' draft(s) failed to create — ' +
      'check with Kris/Tomás.</p>' : '');
  return HtmlService.createHtmlOutput(message);
}
