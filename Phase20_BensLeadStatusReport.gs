/**
 * Phase20_BensLeadStatusReport.gs
 *
 * Kris's ask, 11/09/2026, from a Slack screenshot: Bens asked Tomás "could
 * I also get the status of my booked SCs from ICONS 100 so I can sort them
 * in the CRM and check whether they showed up or not" — Tomás pointed him
 * at two manual "Sales Tracker" spreadsheets (Joana's and Tomás's own) as
 * an interim workaround. Those trackers don't cover Bens's own leads by
 * name/email lookup, so he'd have to search both by hand.
 *
 * We already have this. Once a lead comes off Bens's "Icons Podcast
 * Recordings" tab (Phase11_BensPodcastSync.gs), whichever closer eventually
 * runs their real Sales Call logs it into the shared "Sales Call Log" —
 * Call Type 'Sales Call' (isSalesCallTypeForFunnel_,
 * Phase10_ConversionFunnel.gs — deliberately excludes 'Discovery', the AM's
 * post-sale onboarding call, and 'QC', which is Bens's own step), any Rep.
 * That row's Call Date/Outcome Disposition IS the show-up/outcome answer
 * Bens asked for. This phase just matches his tracker rows to those Sales
 * Call Log rows by email and reports it back to him — no new data source,
 * no change to how closers log calls.
 *
 * Deliberately NOT built here: writing the result back into the tracker's
 * own "SC Booked"/"SC Date"/"SC Show Up" columns. Those are open manual
 * cells Bens or Tomás might already be editing by hand; overwriting them
 * from a script risks clobbering something a human just typed. An email
 * report is read-only on both source sheets and can't do that.
 *
 * ONE-TIME SETUP:
 *   1. Run previewBensLeadStatusReport() from the editor — logs what would
 *      be sent, sends nothing.
 *   2. Flip BENS_LEAD_STATUS_REPORT_CONFIG.ENABLED to true, run
 *      installAllReadyTriggers() (Phase1_ComplianceCheck.gs). This phase
 *      does NOT get its own trigger — it's added as a fifth pass inside
 *      the existing runPhase17To19StandingChecks_ consolidated trigger
 *      (Phase17_SeanFollowUpAutomation.gs; see that function's own header
 *      for why — the project already hit Apps Script's 20-trigger cap
 *      once, 07/09/2026). That function's name still says "17To19" — left
 *      alone rather than renamed everywhere it's referenced in comments
 *      and tests, since it's just a label at this point, not a claim about
 *      which phases currently share it.
 */

var BENS_LEAD_STATUS_REPORT_CONFIG = {
  ENABLED: true, // flipped 11/09/2026 — previewBensLeadStatusReport() reviewed, output looked right (15/126 matched, sensible dispositions)
  TRIGGER_HOUR: 17 // Friday afternoon, CONFIG.BUSINESS_TIMEZONE — after Phase 19's own Friday send (hour 16), same day
};

/**
 * Pure. For each of Bens's tracker rows with an email, finds the most
 * recent real Sales Call (Call Type 'Sales Call', any rep) logged against
 * that same email anywhere in "Sales Call Log" and reports its date/show-up/
 * disposition. Takes already-fetched rows/column maps for both sheets —
 * same shape as computeBensPodcastSyncPlan_ (Phase11) — so it's testable
 * without a fake Sheets service.
 */
function findBensLeadSalesCallStatuses_(trackerRows, trackerCol, logRows, logCol) {
  var statuses = [];
  var stats = { scanned: trackerRows.length, noEmail: 0, matched: 0, noSalesCallYet: 0 };

  trackerRows.forEach(function (row) {
    var name = String(row[trackerCol['Name'] - 1] || '').trim();
    var email = String(row[trackerCol['Email'] - 1] || '').trim();
    if (!email) {
      stats.noEmail++;
      return;
    }

    var normEmail = normalize_(email);
    var best = null;
    logRows.forEach(function (logRow) {
      if (normalize_(logRow[logCol['Prospect Email'] - 1]) !== normEmail) return;
      if (!isSalesCallTypeForFunnel_(logRow[logCol['Call Type'] - 1])) return;
      var callDate = logRow[logCol['Call Date'] - 1];
      var isNewerOrFirst = !best || (best.callDate instanceof Date && callDate instanceof Date && callDate > best.callDate);
      if (isNewerOrFirst) {
        best = {
          callDate: callDate,
          outcomeLogged: logRow[logCol['Outcome Logged'] - 1],
          outcomeDisposition: String(logRow[logCol['Outcome Disposition'] - 1] || '').trim()
        };
      }
    });

    if (!best) {
      stats.noSalesCallYet++;
      return;
    }
    stats.matched++;
    statuses.push({
      name: name || '(unnamed)',
      email: email,
      callDate: best.callDate,
      showedUp: attendedForFunnel_(best.outcomeDisposition),
      outcomeDisposition: best.outcomeDisposition ||
        (isTruthyOutcome_(best.outcomeLogged) ? '(logged, no disposition set yet)' : '(not logged yet)')
    });
  });

  return { statuses: statuses, stats: stats };
}

function formatBensLeadStatusDateForLog_(v) {
  if (v instanceof Date && !isNaN(v)) {
    return Utilities.formatDate(v, CONFIG.BUSINESS_TIMEZONE, 'dd/MM/yyyy');
  }
  return '(no date on file)';
}

/**
 * Same "table of leads" shape every other rep-facing report in this
 * codebase uses (see buildSeanEscalationReportEmail_, Phase19) — plain-text
 * body plus an HTML body with real `<p>`/`<div>` tags (guardedSend_ needs
 * raw HTML here, not escaped text, per this project's own htmlBody
 * convention — CLAUDE.md).
 */
function buildBensLeadStatusReportEmail_(statuses, stats) {
  var subject = 'Your ICONS 100 leads — Sales Call status (' + statuses.length + ' with a Sales Call on file)';

  var lines = statuses.map(function (s, i) {
    return (i + 1) + '. ' + s.name + ' (' + s.email + ') — Sales Call ' +
      formatBensLeadStatusDateForLog_(s.callDate) + ', showed up: ' + (s.showedUp ? 'Yes' : 'No') +
      ', outcome: ' + s.outcomeDisposition;
  });

  var body = (statuses.length
    ? 'Status of your ICONS 100 leads\' Sales Calls, pulled from "Sales Call Log" (whichever closer ' +
      'ran the call):\n\n' + lines.join('\n')
    : 'None of your ICONS 100 leads have a Sales Call logged yet.') +
    '\n\n' + stats.noSalesCallYet + ' of your leads have an email on file but no Sales Call logged yet ' +
    '(booked-but-not-happened, or not booked at all — we can\'t tell those apart from here).' +
    (stats.noEmail ? ' ' + stats.noEmail + ' more have no email on file, so we can\'t match them at all.' : '') +
    '\n\n— Sent automatically, weekly.';

  var htmlBody = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    (statuses.length
      ? '<p>Status of your ICONS 100 leads\' Sales Calls, pulled from "Sales Call Log" (whichever closer ' +
        'ran the call):</p><table style="border-collapse:collapse;width:100%;">' +
        '<tr style="text-align:left;border-bottom:1px solid #ccc;">' +
        '<th style="padding:4px 8px;">Lead</th><th style="padding:4px 8px;">Sales Call date</th>' +
        '<th style="padding:4px 8px;">Showed up</th><th style="padding:4px 8px;">Outcome</th></tr>' +
        statuses.map(function (s) {
          return '<tr style="border-bottom:1px solid #eee;">' +
            '<td style="padding:4px 8px;">' + escapeHtml_(s.name) + '<br><span style="color:#888;font-size:12px;">' +
            escapeHtml_(s.email) + '</span></td>' +
            '<td style="padding:4px 8px;">' + escapeHtml_(formatBensLeadStatusDateForLog_(s.callDate)) + '</td>' +
            '<td style="padding:4px 8px;">' + (s.showedUp ? 'Yes' : 'No') + '</td>' +
            '<td style="padding:4px 8px;">' + escapeHtml_(s.outcomeDisposition) + '</td></tr>';
        }).join('') + '</table>'
      : '<p>None of your ICONS 100 leads have a Sales Call logged yet.</p>') +
    '<p style="margin-top:14px;">' + stats.noSalesCallYet + ' of your leads have an email on file but no Sales ' +
    'Call logged yet (booked-but-not-happened, or not booked at all — we can\'t tell those apart from here).' +
    (stats.noEmail ? ' ' + stats.noEmail + ' more have no email on file, so we can\'t match them at all.' : '') +
    '</p>' +
    '<p style="color:#666;font-size:12px;margin-top:16px;"><i>— Sent automatically, weekly.</i></p>' +
    '</div>';

  return { subject: subject, body: body, htmlBody: htmlBody };
}

function sendBensLeadStatusReportEmail_(statuses, stats) {
  var email = buildBensLeadStatusReportEmail_(statuses, stats);
  var bensCfg = CONFIG.REPS.filter(function (r) { return r.name === 'Bens'; })[0];
  var bensEmail = bensCfg ? bensCfg.email : 'bens@iconsofrealestate.com';
  return guardedSend_(bensEmail, email.subject, email.body, {
    cc: CONFIG.TOMAS_EMAIL + ',' + CONFIG.KRIS_EMAIL,
    htmlBody: email.htmlBody,
    name: 'Bens Lead Status Report Bot'
  }, 3); // Bens + Tomás + Kris
}

function buildAndMaybeSendBensLeadStatusReport_(forcePreview) {
  RUN_TAG = 'buildAndMaybeSendBensLeadStatusReport_';
  if (!forcePreview && !BENS_LEAD_STATUS_REPORT_CONFIG.ENABLED) {
    log_('buildAndMaybeSendBensLeadStatusReport_: BENS_LEAD_STATUS_REPORT_CONFIG.ENABLED is false, skipping.');
    return;
  }

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var trackerSheet = ss.getSheetByName(BENS_PODCAST_SYNC_CONFIG.TRACKER_SHEET_NAME);
  if (!trackerSheet) {
    log_('buildAndMaybeSendBensLeadStatusReport_: no "' + BENS_PODCAST_SYNC_CONFIG.TRACKER_SHEET_NAME + '" tab found.');
    return;
  }
  var logSheet = resolveSheet_(ss, 'Sales Call Log');
  if (!logSheet) {
    log_('buildAndMaybeSendBensLeadStatusReport_: no "Sales Call Log" tab found.');
    return;
  }

  var trackerCol = getValidatedBensTrackerColumnMap_(trackerSheet);
  var trackerLastRow = trackerSheet.getLastRow();
  var trackerRows = trackerLastRow < 2 ? [] :
    trackerSheet.getRange(2, 1, trackerLastRow - 1, BENS_PODCAST_TRACKER_HEADERS.length).getValues();

  var logCol = getValidatedColumnMap_(logSheet);
  var logLastRow = logSheet.getLastRow();
  var logRows = logLastRow < 2 ? [] : logSheet.getRange(2, 1, logLastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  var result = findBensLeadSalesCallStatuses_(trackerRows, trackerCol, logRows, logCol);

  result.statuses.forEach(function (s) {
    log_(s.name + ' (' + s.email + ') — Sales Call ' + formatBensLeadStatusDateForLog_(s.callDate) +
      ', showed up: ' + (s.showedUp ? 'Yes' : 'No') + ', outcome: ' + s.outcomeDisposition);
  });
  log_('');
  log_('Scanned ' + result.stats.scanned + ' tracker row(s): ' + result.stats.matched + ' matched to a Sales Call, ' +
    result.stats.noSalesCallYet + ' have an email but no Sales Call logged yet, ' +
    result.stats.noEmail + ' have no email on file.');

  if (forcePreview) {
    log_('PREVIEW MODE — nothing sent. Paste this whole log back to Claude before flipping BENS_LEAD_STATUS_REPORT_CONFIG.ENABLED to true.');
    return;
  }

  var sent = sendBensLeadStatusReportEmail_(result.statuses, result.stats);
  log_(sent ? 'Sent to Bens (cc Tomás, Kris).' : 'Send skipped — see guardedSend_ log line above for why.');
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewBensLeadStatusReport() {
  RUN_TAG = 'previewBensLeadStatusReport';
  log_('PREVIEW MODE — read-only Bens lead status report probe. Nothing will be sent.');
  return buildAndMaybeSendBensLeadStatusReport_(true);
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function runBensLeadStatusReport() {
  return buildAndMaybeSendBensLeadStatusReport_(false);
}
