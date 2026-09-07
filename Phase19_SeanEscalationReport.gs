/**
 * Phase19_SeanEscalationReport.gs
 *
 * Kris's ask, confirmed 07/09/2026 ("YES a report to Tomas and I is
 * useful"): surface which of Sean's Sales Calls should have escalated to a
 * Second Sales Call (Closing Call) with Tomás instead of an AM Discovery
 * call. Uses the existing "Flag: Booking Decision Appropriate"/"Booking
 * Decision Gap" scored dimension (deriveBookingDecisionFields_,
 * Phase2_CallScoring.gs): appropriate=false means the rep booked a
 * Discovery call even though the lead confirmed on that same call that
 * they were ready to move forward with money — that lead should have gone
 * straight to a Second Sales Call with Tomás instead of to the AM.
 *
 * Scope: Sean only — this is exactly what Kris asked for, and Sean's rubric
 * variant ('sean', alongside 'shared') is one of only two that score this
 * dimension at all (Phase2_CallScoring.gs's own comment on
 * deriveBookingDecisionFields_'s caller). A blank flag means "not scored on
 * this call" (no Discovery call was booked, or a variant that doesn't score
 * this at all) — never counted as a miss, same "no signal != false"
 * convention as every other tri-state flag in this project.
 *
 * Weekly, same Mon-Sun no-watermark window every other weekly digest in this
 * project already uses (getWeekBounds_) — a week already reported never
 * resurfaces just because a run got skipped. Sent Friday afternoon, ahead of
 * whatever gets booked into next week, so Tomás/Kris can react before
 * Monday rather than after another week has already gone by.
 *
 * ONE-TIME SETUP:
 *   1. Run previewSeanEscalationReport() from the editor — logs what it
 *      would send, sends nothing.
 *   2. Flip SEAN_ESCALATION_REPORT_CONFIG.ENABLED to true, run
 *      installSeanEscalationReportTrigger().
 */

var SEAN_ESCALATION_REPORT_CONFIG = {
  ENABLED: false, // flip true after previewSeanEscalationReport() looks right
  TRIGGER_HOUR: 16 // Friday afternoon, CONFIG.BUSINESS_TIMEZONE
};

/**
 * Pure — scans already-fetched Sales Call Log rows for Sean's calls last
 * week where Booking Decision Appropriate was explicitly scored false.
 * Takes `rows`/`col`/`sheet` the same way computeRepWeeklyStats_ does, so
 * it's testable without a fake Drive/Sheets service.
 */
function findSeanEscalationMisses_(rows, col, sheet, weekStart, weekEnd, tz) {
  var misses = [];
  rows.forEach(function (row, i) {
    if (String(row[col['Rep'] - 1] || '').trim().toLowerCase() !== 'sean') return;
    var callDate = row[col['Call Date'] - 1];
    if (!(callDate instanceof Date) || callDate < weekStart || callDate >= weekEnd) return;
    if (!isExplicitlyFalse_(row[col['Flag: Booking Decision Appropriate'] - 1])) return;
    misses.push({
      prospectName: row[col['Prospect Name'] - 1] || '(unnamed)',
      callDate: Utilities.formatDate(callDate, tz, 'dd/MM/yyyy'),
      score: row[col['Call Quality Score'] - 1],
      gap: String(row[col['Booking Decision Gap'] - 1] || '').trim(),
      transcriptUrl: String(row[col['Transcript URL'] - 1] || '').trim(),
      rowLink: salesCallLogRowLink_(sheet, i + 2)
    });
  });
  return misses;
}

/**
 * Kris/Tomás both get the full picture — no separate "for Kris" vs. "for
 * Tomás" version, unlike the weekly scorecard's own rep-facing email, since
 * this report was never meant to go to Sean himself.
 */
function buildSeanEscalationReportEmail_(misses, windowLabel) {
  var subject = 'Sean — ' + misses.length + ' booking-decision miss(es) this week (' +
    stripYearFromDateRangeLabel_(windowLabel) + ')';

  var body = misses.length
    ? 'Sean\'s Sales Calls last week (' + windowLabel + ') that should have escalated to a Second Sales ' +
      'Call with Tomás instead of an AM Discovery call:\n\n' +
      misses.map(function (m, i) {
        var links = [];
        if (m.transcriptUrl) links.push('Transcript: ' + m.transcriptUrl);
        if (m.rowLink) links.push('Sheet row: ' + m.rowLink);
        return (i + 1) + '. ' + m.prospectName + ' (' + m.callDate + '), score ' + m.score + '\n   ' +
          (m.gap || '(no gap detail on file)') +
          (links.length ? '\n   ' + links.join(' | ') : '');
      }).join('\n\n') +
      '\n\n— Sent automatically, end of week.'
    : 'No booking-decision misses for Sean this week (' + windowLabel + ') — every Discovery call he booked ' +
      'was the right call.\n\n— Sent automatically, end of week.';

  var htmlBody = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    (misses.length
      ? '<p>Sean\'s Sales Calls last week (' + escapeHtml_(windowLabel) + ') that should have escalated to a ' +
        '<strong>Second Sales Call with Tomás</strong> instead of an AM Discovery call:</p>' +
        misses.map(function (m) {
          var linksHtml = [];
          if (m.transcriptUrl) linksHtml.push('<a href="' + escapeHtml_(m.transcriptUrl) + '">Transcript</a>');
          if (m.rowLink) linksHtml.push('<a href="' + escapeHtml_(m.rowLink) + '">Sheet row</a>');
          return '<div style="border-left:4px solid #c0392b;background:#fdf1f0;padding:10px 14px;margin:0 0 14px;border-radius:4px;">' +
            '<p style="margin:0 0 6px;"><strong>' + escapeHtml_(String(m.prospectName)) + '</strong> (' +
            escapeHtml_(m.callDate) + '), score ' + escapeHtml_(String(m.score)) + '</p>' +
            '<p style="margin:0;">' + escapeHtml_(m.gap || '(no gap detail on file)') + '</p>' +
            (linksHtml.length ? '<p style="margin:6px 0 0;font-size:12px;">' + linksHtml.join(' &nbsp;|&nbsp; ') + '</p>' : '') +
            '</div>';
        }).join('')
      : '<p>No booking-decision misses for Sean this week (' + escapeHtml_(windowLabel) +
        ') — every Discovery call he booked was the right call.</p>') +
    '<p style="color:#666;font-size:12px;margin-top:16px;"><i>— Sent automatically, end of week.</i></p>' +
    '</div>';

  return { subject: subject, body: body, htmlBody: htmlBody };
}

function sendSeanEscalationReportEmail_(misses, windowLabel) {
  var email = buildSeanEscalationReportEmail_(misses, windowLabel);
  return guardedSend_(CONFIG.TOMAS_EMAIL, email.subject, email.body, {
    cc: CONFIG.KRIS_EMAIL,
    htmlBody: email.htmlBody,
    name: 'Sean Escalation Report Bot'
  }, 2); // Tomás + Kris
}

function buildAndMaybeSendSeanEscalationReport_(forcePreview) {
  RUN_TAG = 'buildAndMaybeSendSeanEscalationReport_';
  if (!forcePreview && !SEAN_ESCALATION_REPORT_CONFIG.ENABLED) {
    log_('buildAndMaybeSendSeanEscalationReport_: SEAN_ESCALATION_REPORT_CONFIG.ENABLED is false, skipping.');
    return;
  }

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('buildAndMaybeSendSeanEscalationReport_: no Sales Call Log tab found.'); return; }

  var col = getValidatedColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  var rows = lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var week = getWeekBounds_(new Date(), tz);
  var windowLabel = Utilities.formatDate(week.start, tz, 'dd/MM/yyyy') + ' - ' +
    Utilities.formatDate(shiftBusinessDate_(week.end, tz, -1), tz, 'dd/MM/yyyy');

  var misses = findSeanEscalationMisses_(rows, col, sheet, week.start, week.end, tz);

  if (forcePreview) {
    log_('previewSeanEscalationReport_: ' + misses.length + ' booking-decision miss(es) for Sean, week of ' +
      windowLabel + '.');
    misses.forEach(function (m, i) {
      log_('  [' + (i + 1) + '] ' + m.prospectName + ' (' + m.callDate + '), score ' + m.score + ' — ' +
        (m.gap || '(no gap detail on file)'));
    });
    return misses.length;
  }

  var sent = sendSeanEscalationReportEmail_(misses, windowLabel);
  if (!sent) {
    log_('buildAndMaybeSendSeanEscalationReport_: send failed/skipped for the week of ' + windowLabel + '.');
    return 0;
  }
  log_('buildAndMaybeSendSeanEscalationReport_: sent, ' + misses.length + ' miss(es) for the week of ' +
    windowLabel + '.');
  return misses.length;
}

/** Run this FIRST from the editor. Logs what it would send — nothing is sent. */
function previewSeanEscalationReport() {
  return previewSeanEscalationReport_();
}

function previewSeanEscalationReport_() {
  RUN_TAG = 'previewSeanEscalationReport_';
  log_('PREVIEW MODE — building this week\'s Sean escalation report, nothing will be sent.');
  return buildAndMaybeSendSeanEscalationReport_(/*forcePreview=*/true);
}

/** Trigger target. */
function runSeanEscalationReport() {
  RUN_TAG = 'runSeanEscalationReport';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runSeanEscalationReport: another run holds the lock, skipping this firing.');
    return;
  }
  try {
    return buildAndMaybeSendSeanEscalationReport_(/*forcePreview=*/false);
  } finally {
    lock.releaseLock();
  }
}

function installSeanEscalationReportTrigger() {
  RUN_TAG = 'installSeanEscalationReportTrigger';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runSeanEscalationReport') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runSeanEscalationReport')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.FRIDAY)
    .atHour(SEAN_ESCALATION_REPORT_CONFIG.TRIGGER_HOUR)
    .inTimezone(CONFIG.BUSINESS_TIMEZONE)
    .create();
  log_('Sean escalation report trigger installed: Fridays ' + SEAN_ESCALATION_REPORT_CONFIG.TRIGGER_HOUR +
    ':00 ' + CONFIG.BUSINESS_TIMEZONE + '.');
}
