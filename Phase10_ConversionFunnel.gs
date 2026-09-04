/**
 * Phase10_ConversionFunnel.gs
 *
 * Weekly conversion-funnel report, per rep, across three time windows (this
 * week / last 30 days / last 90 days). Kris's ask (04/09/2026): "How many
 * calls did [Bens] have each week? What was his conversion rate through to
 * booking? How many of those actually attended those QCs? How many of them
 * actually qualified? How many turned into sales calls and then sales? Same
 * with Sean and Joana... how many got booked through the second/closing
 * calls with Tomás, and what was the conversion rate on those?" Every
 * Friday, sent close of business — "Friday at 6pm PST because everything's
 * closed by then."
 *
 * WHY A SEPARATE PHASE, NOT AN EXTENSION OF PHASE5_WEEKLYSCORECARD.GS: that
 * file's stats deliberately EXCLUDE QC/Discovery rows (isSalesCallTypeForScorecard_,
 * 03/09/2026 fix) — it's a sales-coaching report, QC calls don't belong in
 * it at all. This report is the opposite: it's built entirely FROM QC
 * volume and how it funnels into Sales Calls, so it needs every Call Type,
 * not a filtered subset.
 *
 * THE FUNNEL, AS BUILT FROM WHAT'S ALREADY ON EVERY SCORED ROW:
 *   QC booked (Call Type = 'QC', Call Date in window)
 *     -> QC attended    (Outcome Disposition != 'No-show')
 *     -> QC qualified   (Lead Quality Verdict = 'good_to_book', among attended)
 *       -> Sales Call booked  (a LATER row, any rep, Call Type = 'Sales Call',
 *          same prospect name -- see matchLaterSalesCallForFunnel_ for why
 *          this is rep-agnostic: Bens never takes the Sales Call himself,
 *          Sean/Joana's qualified leads can also be handed to Tomás)
 *         -> Sales Call attended (Outcome Disposition != 'No-show')
 *           -> Sold              (Outcome Disposition = 'Sold')
 *
 * SCOPE NOTE, stated plainly rather than silently narrowed: this reads the
 * "Sales Call Log" tab as it exists today. Bens's real QC/podcast volume
 * only shows up here for whatever's already been scored into that tab --
 * the gap already found live (03/09/2026, see CLAUDE.md "Who does what")
 * means a chunk of his recent podcast recordings have NO row here at all
 * yet, pending the podcast-tracker sync proposal Tomás/Bens still need to
 * answer. Until that sync exists, Bens's numbers below are a real but
 * incomplete slice, not the whole picture -- said explicitly in the report
 * itself, not just here.
 *
 * TOMÁS'S SECTION is separate from the per-rep funnel above: it's every
 * Sales Call Log row with Rep = 'Tomás' in the window (his own closing
 * calls, regardless of which rep's QC fed them), attended/sold tallied
 * directly -- "how many of those got booked through the second/closing
 * calls with Tomás, and what was the conversion rate on those."
 *
 * ONE-TIME SETUP: run previewConversionFunnel() from the Apps Script editor,
 * confirm the numbers look sane, flip CONVERSION_FUNNEL_CONFIG.ENABLED to
 * true, then run installConversionFunnelTrigger().
 */

var CONVERSION_FUNNEL_CONFIG = {
  ENABLED: false,
  // Kris's ask (04/09/2026): "Friday at 6pm PST because everything's closed
  // by then." This codebase's own trigger timezone is CONFIG.BUSINESS_TIMEZONE
  // (America/New_York) -- both US zones observe DST on the same schedule, so
  // the 3-hour Pacific/Eastern offset is stable year-round: 6pm Pacific is
  // always 9pm Eastern, no separate DST math needed.
  TRIGGER_HOUR: 21,
  MONTH_WINDOW_DAYS: 30,
  QUARTER_WINDOW_DAYS: 90
};

/** True for a Call Type that represents a Qualification Call for this funnel — case/whitespace-insensitive. */
function isQcCallTypeForFunnel_(callType) {
  return String(callType || '').trim().toLowerCase() === 'qc';
}

/** True for a Call Type that represents a real Sales Call for this funnel. Deliberately excludes 'Discovery' --
 * that's the AM's post-sale onboarding call (Phase2_CallScoring.gs's own Discovery-rubric header comment), not
 * a step in the QC-to-close funnel this report tracks. */
function isSalesCallTypeForFunnel_(callType) {
  return String(callType || '').trim().toLowerCase() === 'sales call';
}

/** True unless the Outcome Disposition is explicitly 'No-show' — a blank disposition (not yet logged) reads as
 * attended, same as everywhere else in this codebase treats "we don't know yet" as not a negative finding. */
function attendedForFunnel_(outcomeDisposition) {
  return String(outcomeDisposition || '').trim().toLowerCase() !== 'no-show';
}

/**
 * Finds the earliest Sales Call row (ANY rep — see this file's header
 * comment for why) for `prospectName` dated after `afterDate`. Rep-agnostic
 * and cross-Call-Type by design: a QC rep (Bens especially) frequently
 * never takes the resulting Sales Call themselves. Matches on
 * normalize_(prospectName) (Phase1_ComplianceCheck.gs) — same normalization
 * used for calendar/tracker name-matching elsewhere in this codebase, not a
 * fresh comparison rule. Returns null if none found. Picks the EARLIEST
 * qualifying row, not just any — the very next Sales Call after this QC is
 * the one this QC actually produced, not a later, unrelated one for the
 * same name.
 */
function matchLaterSalesCallForFunnel_(allSalesCallRows, prospectName, afterDate) {
  var target = normalize_(prospectName);
  if (!target) return null;
  var best = null;
  allSalesCallRows.forEach(function (r) {
    if (normalize_(r.prospectName) !== target) return;
    if (!(r.callDate instanceof Date) || !(afterDate instanceof Date)) return;
    if (r.callDate <= afterDate) return;
    if (!best || r.callDate < best.callDate) best = r;
  });
  return best;
}

/**
 * Core pure funnel computation for one window, across every rep at once —
 * the Sales-Call join (matchLaterSalesCallForFunnel_) needs the FULL row
 * set regardless of which rep's QC row it's being matched against, so this
 * builds each rep's funnel and Tomás's own closing-call section together
 * rather than requiring the caller to pass the same full sheet in once per
 * rep. `rows`/`col` are the full "Sales Call Log" sheet read; `repNames` is
 * the list of QC-side reps to build a funnel section for (CONFIG.REPS
 * names — Tomás is handled separately below, not as a QC-side rep, since he
 * doesn't run QCs himself).
 */
function computeConversionFunnelWindow_(rows, col, repNames, windowStart, windowEnd) {
  var allSalesCallRows = [];
  var qcRowsByRep = {};
  repNames.forEach(function (r) { qcRowsByRep[r] = []; });
  var tomasSalesCallRows = [];

  rows.forEach(function (row) {
    var callType = row[col['Call Type'] - 1];
    var callDate = parseSalesCallLogDate_(row[col['Call Date'] - 1]);
    var prospectName = row[col['Prospect Name'] - 1];
    var outcomeDisposition = row[col['Outcome Disposition'] - 1];
    var rep = String(row[col['Rep'] - 1] || '').trim();

    if (isSalesCallTypeForFunnel_(callType) && callDate) {
      allSalesCallRows.push({ prospectName: prospectName, callDate: callDate, outcomeDisposition: outcomeDisposition });
      if (rep.toLowerCase() === 'tomás' || rep.toLowerCase() === 'tomas') {
        if (callDate >= windowStart && callDate < windowEnd) tomasSalesCallRows.push({ outcomeDisposition: outcomeDisposition });
      }
    }

    if (isQcCallTypeForFunnel_(callType) && callDate && callDate >= windowStart && callDate < windowEnd) {
      var matchedRep = repNames.filter(function (r) { return r.toLowerCase() === rep.toLowerCase(); })[0];
      if (matchedRep) {
        qcRowsByRep[matchedRep].push({
          prospectName: prospectName, callDate: callDate,
          attended: attendedForFunnel_(outcomeDisposition),
          leadQualityVerdict: String(row[col['Lead Quality Verdict'] - 1] || '').trim()
        });
      }
    }
  });

  var byRep = {};
  repNames.forEach(function (repName) {
    var qcRows = qcRowsByRep[repName];
    var qcAttendedRows = qcRows.filter(function (r) { return r.attended; });
    var qcQualifiedRows = qcAttendedRows.filter(function (r) { return r.leadQualityVerdict === 'good_to_book'; });

    var scBookedRows = [];
    qcQualifiedRows.forEach(function (qc) {
      var sc = matchLaterSalesCallForFunnel_(allSalesCallRows, qc.prospectName, qc.callDate);
      if (sc) scBookedRows.push(sc);
    });
    var scAttendedRows = scBookedRows.filter(function (r) { return attendedForFunnel_(r.outcomeDisposition); });
    var scSoldRows = scAttendedRows.filter(function (r) { return String(r.outcomeDisposition || '').trim().toLowerCase() === 'sold'; });

    byRep[repName] = {
      qcBooked: qcRows.length,
      qcAttended: qcAttendedRows.length,
      qcQualified: qcQualifiedRows.length,
      scBooked: scBookedRows.length,
      scAttended: scAttendedRows.length,
      sold: scSoldRows.length
    };
  });

  var tomasAttended = tomasSalesCallRows.filter(function (r) { return attendedForFunnel_(r.outcomeDisposition); });
  var tomasSold = tomasAttended.filter(function (r) { return String(r.outcomeDisposition || '').trim().toLowerCase() === 'sold'; });

  return {
    byRep: byRep,
    tomas: {
      booked: tomasSalesCallRows.length,
      attended: tomasAttended.length,
      sold: tomasSold.length
    }
  };
}

/** Safe percentage; null (not 0) when the denominator is 0, so callers can tell "0%" from "no data" — same
 * convention as mean_ (Phase5_WeeklyScorecard.gs). */
function safeRateForFunnel_(numerator, denominator) {
  if (!denominator) return null;
  return numerator / denominator;
}

/** Formats a safeRateForFunnel_ result for display — "not enough data" when null, otherwise "n/d (xx%)". */
function formatFunnelRate_(numerator, denominator) {
  var rate = safeRateForFunnel_(numerator, denominator);
  if (rate === null) return numerator + '/' + denominator + ' (n/a)';
  return numerator + '/' + denominator + ' (' + Math.round(rate * 100) + '%)';
}

/**
 * Pure email-content builder — {subject, body} — kept separate from
 * SpreadsheetApp/MailApp so it's testable without either, same split as
 * every other *Email_ builder in this codebase. `windows` is
 * {week: {...}, month: {...}, quarter: {...}}, each a
 * computeConversionFunnelWindow_ result.
 */
function buildConversionFunnelEmail_(repNames, windows, weekLabel) {
  var subject = 'Weekly Conversion Funnel — week of ' + weekLabel;

  var repSection = function (repName) {
    var w = windows.week.byRep[repName], m = windows.month.byRep[repName], q = windows.quarter.byRep[repName];
    return repName + ':\n' +
      '  QCs booked          — this week: ' + w.qcBooked + '   last 30d: ' + m.qcBooked + '   last 90d: ' + q.qcBooked + '\n' +
      '  QC show-up rate     — this week: ' + formatFunnelRate_(w.qcAttended, w.qcBooked) +
      '   last 30d: ' + formatFunnelRate_(m.qcAttended, m.qcBooked) +
      '   last 90d: ' + formatFunnelRate_(q.qcAttended, q.qcBooked) + '\n' +
      '  QC qualified rate   — this week: ' + formatFunnelRate_(w.qcQualified, w.qcAttended) +
      '   last 30d: ' + formatFunnelRate_(m.qcQualified, m.qcAttended) +
      '   last 90d: ' + formatFunnelRate_(q.qcQualified, q.qcAttended) + '\n' +
      '  -> Sales Call booked — this week: ' + formatFunnelRate_(w.scBooked, w.qcQualified) +
      '   last 30d: ' + formatFunnelRate_(m.scBooked, m.qcQualified) +
      '   last 90d: ' + formatFunnelRate_(q.scBooked, q.qcQualified) + '\n' +
      '  Sales Call show-up  — this week: ' + formatFunnelRate_(w.scAttended, w.scBooked) +
      '   last 30d: ' + formatFunnelRate_(m.scAttended, m.scBooked) +
      '   last 90d: ' + formatFunnelRate_(q.scAttended, q.scBooked) + '\n' +
      '  Closed (Sold)       — this week: ' + formatFunnelRate_(w.sold, w.scAttended) +
      '   last 30d: ' + formatFunnelRate_(m.sold, m.scAttended) +
      '   last 90d: ' + formatFunnelRate_(q.sold, q.scAttended) + '\n' +
      '  End-to-end (QC booked -> Sold) — this week: ' + formatFunnelRate_(w.sold, w.qcBooked) +
      '   last 30d: ' + formatFunnelRate_(m.sold, m.qcBooked) +
      '   last 90d: ' + formatFunnelRate_(q.sold, q.qcBooked) + '\n\n';
  };

  var tomasSection = function () {
    var w = windows.week.tomas, m = windows.month.tomas, q = windows.quarter.tomas;
    return 'Tomás (second/closing calls, any originating rep):\n' +
      '  Closing calls booked — this week: ' + w.booked + '   last 30d: ' + m.booked + '   last 90d: ' + q.booked + '\n' +
      '  Show-up rate         — this week: ' + formatFunnelRate_(w.attended, w.booked) +
      '   last 30d: ' + formatFunnelRate_(m.attended, m.booked) +
      '   last 90d: ' + formatFunnelRate_(q.attended, q.booked) + '\n' +
      '  Close rate           — this week: ' + formatFunnelRate_(w.sold, w.attended) +
      '   last 30d: ' + formatFunnelRate_(m.sold, m.attended) +
      '   last 90d: ' + formatFunnelRate_(q.sold, q.attended) + '\n\n';
  };

  var body =
    'Weekly conversion funnel for ' + weekLabel + '.\n\n' +
    'Funnel: QC booked -> attended -> qualified -> Sales Call booked -> attended -> Sold. ' +
    'The Sales Call step is matched by prospect name across ALL reps, not just the QC rep — a QC rep\'s ' +
    'qualified lead is very often closed by someone else (Tomás especially).\n\n' +
    repNames.map(repSection).join('') +
    tomasSection() +
    'Note on Bens specifically: his real QC/podcast volume is only as complete here as what\'s already logged ' +
    'in the Sales Call Log — a known backlog of recent podcast recordings isn\'t in this sheet yet, pending a ' +
    'separate tracker-sync fix. His numbers above are real but incomplete until that lands.\n\n' +
    '— This is an automated weekly report. This email was drafted by AI and sent automatically; ' +
    'reply to Kris or Tomás with any issues.';

  return { subject: subject, body: body };
}

/** Shared by preview and live paths so they can never drift apart, same pattern as every other phase's runner. */
function buildConversionFunnelReport_() {
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var now = new Date();
  var week = getWeekBounds_(now, tz); // Phase5_WeeklyScorecard.gs

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return null; }
  var col = getValidatedColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { log_('No data rows in Sales Call Log.'); return null; }
  var rows = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  var repNames = CONFIG.REPS.map(function (r) { return r.name; }); // Bens, Joana, Sean -- Tomás handled separately

  var monthStart = new Date(week.end.getTime() - CONVERSION_FUNNEL_CONFIG.MONTH_WINDOW_DAYS * 24 * 3600 * 1000);
  var quarterStart = new Date(week.end.getTime() - CONVERSION_FUNNEL_CONFIG.QUARTER_WINDOW_DAYS * 24 * 3600 * 1000);

  var windows = {
    week: computeConversionFunnelWindow_(rows, col, repNames, week.start, week.end),
    month: computeConversionFunnelWindow_(rows, col, repNames, monthStart, week.end),
    quarter: computeConversionFunnelWindow_(rows, col, repNames, quarterStart, week.end)
  };

  var weekLabel = Utilities.formatDate(week.start, tz, 'dd/MM') + '–' +
    Utilities.formatDate(new Date(week.end.getTime() - 1), tz, 'dd/MM/yyyy');

  return buildConversionFunnelEmail_(repNames, windows, weekLabel);
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewConversionFunnel() {
  return previewConversionFunnel_();
}

/** Read-only. Builds this week/month/quarter's funnel report and only logs it — nothing is sent. */
function previewConversionFunnel_() {
  RUN_TAG = 'previewConversionFunnel_';
  log_('PREVIEW MODE — building the conversion funnel report, nothing will be sent.');
  var email = buildConversionFunnelReport_();
  if (!email) return;
  log_(email.subject + '\n\n' + email.body);
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function runConversionFunnel() {
  return runConversionFunnel_();
}

/**
 * LIVE SEND. Gated by CONVERSION_FUNNEL_CONFIG.ENABLED — run previewConversionFunnel()
 * first and confirm the output looks right before flipping that to true.
 * CCs Kris and Tomás, sent to Kris directly (this is a leadership/ops
 * report, not a per-rep coaching email like the Weekly Scorecard).
 */
function runConversionFunnel_() {
  RUN_TAG = 'runConversionFunnel_';
  if (!CONVERSION_FUNNEL_CONFIG.ENABLED) {
    log_('CONVERSION_FUNNEL_CONFIG.ENABLED is false — run previewConversionFunnel() first, confirm the output ' +
      'looks right, then flip CONVERSION_FUNNEL_CONFIG.ENABLED to true in Phase10_ConversionFunnel.gs.');
    return;
  }
  var email = buildConversionFunnelReport_();
  if (!email) return;
  guardedSend_(CONFIG.KRIS_EMAIL, email.subject, email.body, {
    cc: CONFIG.TOMAS_EMAIL,
    name: 'Conversion Funnel Report'
  }, 2);
}

/**
 * ONE-TIME setup, run manually — ideally only after previewConversionFunnel()
 * has been reviewed and CONVERSION_FUNNEL_CONFIG.ENABLED flipped to true.
 * Fridays only, per Kris's ask.
 */
function installConversionFunnelTrigger() {
  RUN_TAG = 'installConversionFunnelTrigger';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runConversionFunnel') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runConversionFunnel')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.FRIDAY)
    .atHour(CONVERSION_FUNNEL_CONFIG.TRIGGER_HOUR)
    .inTimezone(CONFIG.BUSINESS_TIMEZONE)
    .create();
  log_('Conversion funnel trigger installed: Fridays ' + CONVERSION_FUNNEL_CONFIG.TRIGGER_HOUR +
    ':00 (' + CONFIG.BUSINESS_TIMEZONE + ' — 6pm Pacific). ' +
    (CONVERSION_FUNNEL_CONFIG.ENABLED
      ? 'CONVERSION_FUNNEL_CONFIG.ENABLED is true — this will send automatically.'
      : 'CONVERSION_FUNNEL_CONFIG.ENABLED is still false — nothing will actually send until you flip that.'));
}
