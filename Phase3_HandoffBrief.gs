/**
 * Phase3_HandoffBrief.gs
 *
 * Warm-handoff briefing between funnel stages. Kris's ask (17/08/2026):
 * ideally the rep who ran the PREVIOUS call introduces the lead to whoever
 * runs the NEXT one (e.g. Bens takes an ICONS 100 recording call, books a
 * QC, and joins that QC to hand the lead to Joana) — but the incoming rep
 * still needs real context before they join, not just an introduction.
 * This sends that context ~24 hours ahead of the next call: who the lead
 * is, their stated issues/goals, how podcasting was pitched (or should be)
 * to address them, which objections from the prior call are still
 * unresolved, and anything else worth knowing.
 *
 * Design:
 *  - "Next call" = any upcoming QC/Sales Call/Discovery calendar event for
 *    one of CONFIG.REPS (reuses Phase 1's getRepCallEvents_ and
 *    guessProspectFromTitle_ — same title-keyword filtering, same prospect-
 *    name guess).
 *  - "Prior call" = the most recent SCORED "Sales Call Log" row for that
 *    same prospect, dated before the upcoming event. No assumption about
 *    funnel stage ORDER (Recording -> QC -> Sales Call -> Tomás close isn't
 *    encoded anywhere in the schema) — just "the last thing we know about
 *    this lead," which in practice is the correct prior stage.
 *  - The brief itself is NOT built from the terse AI Feedback Summary
 *    column (2-3 coaching-oriented sentences) — it's synthesized fresh from
 *    the prior call's own TRANSCRIPT via a dedicated prompt below, because
 *    "what are their issues" / "how does podcasting solve it" need more
 *    than what the scoring rubric captures.
 *  - Dedup: a lightweight "Handoff Briefs Sent" tab (Calendar Event ID, Sent
 *    At) in the same spreadsheet — the upcoming call has no Sales Call Log
 *    row of its own yet (that only gets created once the call happens and
 *    is logged), so there's nowhere else to mark "already sent" against.
 *
 * NOT YET LIVE-VERIFIED end-to-end (no real upcoming QC/Sales Call event to
 * test against at the time this was written) — previewUpcomingHandoffBriefs()
 * (run that one, not the trailing-underscore version — Apps Script's
 * "Select function" dropdown hides those) —
 * below does the full match (calendar -> prospect -> prior row) and logs
 * what it WOULD send without calling the model or sending anything; run
 * that first. Gated by HANDOFF_CONFIG.ENABLED (see below), same
 * confirm-before-trusting-new-LLM-output pattern as PHASE2_CONFIG.SHADOW_MODE
 * — deliberately a SEPARATE flag, since this isn't about scoring-verdict
 * calibration, it's about a fresh kind of LLM output nobody has reviewed yet.
 */

var HANDOFF_CONFIG = {
  // Kris/Tomás should read a handful of generated briefs against the real
  // prior transcript before this emails anyone. False = previewUpcomingHandoffBriefs_
  // and sendUpcomingHandoffBriefs_ both log the brief instead of sending it.
  // Flipped true 19/08/2026 after a clean previewUpcomingHandoffBriefs_() run.
  ENABLED: true,

  // How far ahead to look for an upcoming call. Checked on an hourly
  // trigger (installHandoffBriefTrigger) with a wide window so more than one
  // missed/delayed firing still catches every event exactly once, combined
  // with the dedup tab below (safe to widen — sendUpcomingHandoffBriefs_ is
  // idempotent per event ID). Real bug found live (26/08/2026 silent-failure
  // audit): a 2-hour window only survives ONE skipped firing. LockService's
  // script lock is project-wide, and Phase2_CallScoring.gs's scoring runs
  // can hold it for several minutes to several firings in a row on a long
  // batch — two consecutive skipped firings could drop an event's window
  // below LOOKAHEAD_MIN_HOURS before it was ever checked, permanently.
  LOOKAHEAD_MIN_HOURS: 22,
  LOOKAHEAD_MAX_HOURS: 26,

  TRACKING_SHEET_NAME: 'Handoff Briefs Sent'
};

// ---------------------------------------------------------------------------
// LLM synthesis — a distinct prompt from the scoring rubrics in
// Phase2_CallScoring.gs. This is not a judgment about call QUALITY; it's a
// straight extraction/summary of what a rep would want to know walking in.
// ---------------------------------------------------------------------------

function buildHandoffBriefSystemPrompt_() {
  return [
    'You are preparing a warm-handoff briefing for a sales rep who is about to take over a lead from a',
    'colleague. Read the transcript of the colleague\'s call with this lead and extract exactly what the',
    'next rep needs to know before joining the call — nothing more, nothing invented.',
    '',
    'If the transcript does not clearly cover something, say so plainly ("Not discussed on this call") —',
    'never guess or pad with generic sales language.',
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text, in this exact shape:',
    '',
    '{',
    '  "lead_summary": "string — 1-2 sentences: who they are and their business context",',
    '  "issues_and_goals": "string — 2-3 sentences: the pain points / goals they actually stated",',
    '  "podcast_fit_angle": "string — 1-2 sentences: how the podcast offer was pitched, or should be,',
    '   to address what they said above",',
    '  "unresolved_objections": "string — objections raised on this call that were NOT fully put to',
    '   rest, so the next rep can pre-empt them; \\"None identified\\" if the prior call resolved everything",',
    '  "prospect_links": "string — any website, social media handle, or company page URL the LEAD actually',
    '   said or spelled out on this call, comma-separated; \\"Not mentioned on this call\\" if none were —',
    '   never guess, infer, or construct a URL that was not stated verbatim",',
    '  "other_notes": "string — anything else worth knowing before joining: rapport details, promises',
    '   made, scheduling quirks, tone/personality notes; \\"None\\" if nothing stands out"',
    '}'
  ].join('\n');
}

function isValidHandoffBriefSchema_(obj) {
  return !!(obj &&
    typeof obj.lead_summary === 'string' &&
    typeof obj.issues_and_goals === 'string' &&
    typeof obj.podcast_fit_angle === 'string' &&
    typeof obj.unresolved_objections === 'string' &&
    typeof obj.prospect_links === 'string' &&
    typeof obj.other_notes === 'string');
}

function buildHandoffBriefUserPrompt_(ctx) {
  return [
    'Prior rep: ' + ctx.priorRep,
    'Prospect: ' + ctx.prospectName,
    'Prior call type: ' + ctx.priorCallType,
    'Prior call date: ' + ctx.priorCallDate,
    '',
    'Transcript:',
    ctx.transcriptText
  ].join('\n');
}

/** Same retry-then-manual-review-sentinel shape as scoreTranscript_ in Phase2_CallScoring.gs. */
function generateHandoffBrief_(ctx) {
  var systemPrompt = buildHandoffBriefSystemPrompt_();
  var userPrompt = buildHandoffBriefUserPrompt_(ctx);
  var lastRaw = null;

  for (var attempt = 0; attempt <= PHASE2_CONFIG.MAX_PARSE_RETRIES; attempt++) {
    var promptForThisAttempt = attempt === 0
      ? userPrompt
      : userPrompt + '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    try {
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt);
      var parsed = stripFencesAndParseJson_(lastRaw);
      if (!isValidHandoffBriefSchema_(parsed)) throw new Error('Parsed JSON missing required handoff-brief fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ generateHandoffBrief_ attempt ' + (attempt + 1) + ' failed for ' + ctx.prospectName + ': ' + e);
    }
  }

  log_('    ↳ HANDOFF BRIEF PARSE FAILED twice for ' + ctx.prospectName + '. Raw model output: ' + String(lastRaw).slice(0, 1000));
  return {
    lead_summary: 'Automated brief generation failed twice to return parseable JSON.',
    issues_and_goals: 'See Apps Script log for the raw model output; read the prior transcript directly.',
    podcast_fit_angle: 'Not available — generation failed.',
    unresolved_objections: 'Not available — generation failed.',
    prospect_links: 'Not available — generation failed.',
    other_notes: 'Not available — generation failed.',
    _parseFailed: true
  };
}

// ---------------------------------------------------------------------------
// Matching: upcoming calendar event -> most recent prior scored call for the
// same prospect.
// ---------------------------------------------------------------------------

/**
 * Reads every "Sales Call Log" row for one normalized prospect key that has
 * both a Transcript URL and an AI Feedback Summary (i.e. actually scored),
 * dated before beforeDate, and returns the most recent one. Returns null if
 * none exist — normal for a lead's very first call in the funnel, not an error.
 */
function findMostRecentPriorScoredCall_(col, values, prospectKey, beforeDate) {
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var best = null;
  values.forEach(function (row, i) {
    var name = normalize_(row[col['Prospect Name'] - 1]);
    if (name !== prospectKey) return;
    var transcriptUrl = row[col['Transcript URL'] - 1];
    var feedback = row[col['AI Feedback Summary'] - 1];
    if (!transcriptUrl || !feedback) return; // not yet scored — nothing to synthesize from
    var callDateCell = row[col['Call Date'] - 1];
    if (!callDateCell) return;

    // Reuse formatDateCell_ (Phase1_ComplianceCheck.gs) rather than re-parsing
    // the cell here — it already handles the free-text-legacy-date timezone
    // bug fixed there tonight (new Date(string) parses in the SCRIPT's
    // timezone, not business tz; reformatting into a different zone can
    // shift the calendar date by a day). Then build a purely local,
    // unambiguous Date from the resulting dd/MM/yyyy components for ordering
    // — comparing calendar dates, not re-interpreting instants across zones.
    var dateStr = formatDateCell_(callDateCell, tz);
    var m = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return; // unparseable free text — already logged by formatDateCell_
    // Real bug found live (26/08/2026 silent-failure audit): this used to be
    // the plain `new Date(y, m-1, d)` constructor — the exact anti-pattern
    // the comment just above warns about, and the same class already fixed
    // in parseLegacyFilename_ (Phase2_CallScoring.gs). It builds midnight in
    // the SCRIPT's own timezone (Asia/Bangkok), not CONFIG.BUSINESS_TIMEZONE,
    // landing ~11h early — enough that a row dated the day AFTER an upcoming
    // event could still pass this "before the event" test and get selected
    // as the prior call.
    var comparable = dateAtMidnightInBusinessTimezone_(Number(m[3]), Number(m[2]), Number(m[1]));
    if (comparable >= beforeDate) return;

    if (!best || comparable > best.comparable) {
      best = {
        rowIndex: i + 2,
        rep: row[col['Rep'] - 1],
        callType: row[col['Call Type'] - 1],
        callDateStr: dateStr,
        comparable: comparable,
        transcriptUrl: transcriptUrl
      };
    }
  });
  return best;
}

/** Maps a Rep name (as stored in the sheet) to their CONFIG.REPS email, if known. */
function repEmailByName_(repName) {
  var match = CONFIG.REPS.filter(function (r) { return r.name.toLowerCase() === String(repName || '').trim().toLowerCase(); });
  return match.length ? match[0].email : null;
}

// ---------------------------------------------------------------------------
// Dedup tracking — a future calendar event has no Sales Call Log row of its
// own yet, so "have we already sent a brief for this event" is tracked in a
// small separate tab instead.
// ---------------------------------------------------------------------------

function getHandoffTrackingSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(HANDOFF_CONFIG.TRACKING_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(HANDOFF_CONFIG.TRACKING_SHEET_NAME);
    sheet.getRange(1, 1, 1, 2).setValues([['Calendar Event ID', 'Sent At']]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function hasHandoffBriefBeenSent_(eventId) {
  var sheet = getHandoffTrackingSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  return ids.some(function (row) { return String(row[0]) === String(eventId); });
}

function markHandoffBriefSent_(eventId) {
  getHandoffTrackingSheet_().appendRow([eventId, new Date()]);
}

// ---------------------------------------------------------------------------
// Email template — the actual deliverable Kris/Tomás asked for.
// ---------------------------------------------------------------------------

function buildHandoffBriefEmailBody_(brief, ctx) {
  return [
    'Hi ' + ctx.nextRepFirstName + ',',
    '',
    'You have a ' + ctx.nextCallType + ' call with ' + ctx.prospectName + ' on ' + ctx.nextCallDateStr +
      ' at ' + ctx.nextCallTimeStr + ' (' + CONFIG.BUSINESS_TIMEZONE + ').',
    ctx.priorRep + ' spoke with them on ' + ctx.priorCallDateStr + ' (' + ctx.priorCallType +
      ') — here\'s what to know before you join:',
    '',
    'WHO THEY ARE',
    brief.lead_summary,
    '',
    'THEIR ISSUES / GOALS',
    brief.issues_and_goals,
    '',
    'HOW PODCASTING FITS',
    brief.podcast_fit_angle,
    '',
    'OBJECTIONS NOT YET RESOLVED',
    brief.unresolved_objections,
    '',
    'WEBSITE / SOCIAL MEDIA',
    brief.prospect_links,
    '',
    'ANYTHING ELSE WORTH KNOWING',
    brief.other_notes,
    '',
    '— Automated handoff brief, generated from ' + ctx.priorRep + '\'s call transcript by AI.',
    'Reply to Kris or Tomás with any issues.'
  ].join('\n');
}

/** Same content as buildHandoffBriefEmailBody_, styled — colored section
 * labels + bold key facts, per Kris's ask (27/08/2026) that these read as
 * a wall of plain text otherwise. escapeHtml_ (Phase4_InboxSLA.gs) guards
 * every AI-generated/dynamic field since this is raw HTML, not Jinja. */
function buildHandoffBriefEmailHtml_(brief, ctx) {
  function section(label, text, linkify) {
    var escaped = escapeHtml_(text);
    // Joana's ask (28/08/2026): make website/social links Kris actually clicks,
    // not plain text he has to copy-paste. Only ever wraps a URL the model
    // already extracted verbatim from the transcript (isValidHandoffBriefSchema_
    // enforces that field is always a string) — this never invents a link.
    if (linkify) {
      escaped = escaped.replace(/((?:https?:\/\/|www\.)[^\s,<]+)/g, function (url) {
        var href = /^https?:\/\//i.test(url) ? url : 'https://' + url;
        return '<a href="' + href + '" style="color:#1a56db;">' + url + '</a>';
      });
    }
    return '<p style="margin:0 0 4px 0;"><strong style="color:#1a56db;">' + label + '</strong></p>' +
      '<p style="margin:0 0 16px 0;">' + escaped.replace(/\n/g, '<br>') + '</p>';
  }
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    '<p>Hi ' + escapeHtml_(ctx.nextRepFirstName) + ',</p>' +
    '<p>You have a <strong>' + escapeHtml_(ctx.nextCallType) + '</strong> call with ' +
    '<strong>' + escapeHtml_(ctx.prospectName) + '</strong> on <strong>' + escapeHtml_(ctx.nextCallDateStr) +
    ' at ' + escapeHtml_(ctx.nextCallTimeStr) + '</strong> (' + escapeHtml_(CONFIG.BUSINESS_TIMEZONE) + ').<br>' +
    escapeHtml_(ctx.priorRep) + ' spoke with them on ' + escapeHtml_(ctx.priorCallDateStr) + ' (' +
    escapeHtml_(ctx.priorCallType) + ') — here\'s what to know before you join:</p>' +
    section('WHO THEY ARE', brief.lead_summary) +
    section('THEIR ISSUES / GOALS', brief.issues_and_goals) +
    section('HOW PODCASTING FITS', brief.podcast_fit_angle) +
    section('OBJECTIONS NOT YET RESOLVED', brief.unresolved_objections) +
    section('WEBSITE / SOCIAL MEDIA', brief.prospect_links, true) +
    section('ANYTHING ELSE WORTH KNOWING', brief.other_notes) +
    '<p style="color:#666;font-size:12px;">— Automated handoff brief, generated from ' +
    escapeHtml_(ctx.priorRep) + '\'s call transcript by AI.<br>Reply to Kris or Tomás with any issues.</p>' +
    '</div>'
  );
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Read-only dry run: finds upcoming calls in the lookahead window, matches
 * each to a prior scored call for the same prospect, and logs what WOULD be
 * sent. Calls no model, sends no email, writes nothing (not even the dedup
 * tab). Run this first — before flipping HANDOFF_CONFIG.ENABLED — to confirm
 * the matching logic finds real rows against real upcoming events.
 */
/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewUpcomingHandoffBriefs() {
  return previewUpcomingHandoffBriefs_();
}

function previewUpcomingHandoffBriefs_() {
  RUN_TAG = 'previewUpcomingHandoffBriefs_';
  var tz = CONFIG.BUSINESS_TIMEZONE;
  var now = new Date();
  var windowStart = new Date(now.getTime() + HANDOFF_CONFIG.LOOKAHEAD_MIN_HOURS * 3600000);
  var windowEnd = new Date(now.getTime() + HANDOFF_CONFIG.LOOKAHEAD_MAX_HOURS * 3600000);

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  // Real bug found live (26/08/2026 silent-failure audit): resolveSheet_
  // NEVER actually returns null -- it falls back to ss.getSheets()[0] when
  // the preferred name isn't found, so the 'if (!sheet)' guard below was
  // dead code. If the shared tab is ever renamed, this used to silently
  // read/write whatever tab happened to be leftmost instead. Look up this
  // specific, critical tab by name directly so a rename is caught for real.
  var sheet = ss.getSheetByName('Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }
  var col = getValidatedColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  var values = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues() : [];

  var found = 0, noMatch = 0;
  CONFIG.REPS.forEach(function (repCfg) {
    var events = getRepCallEvents_(repCfg, windowStart, windowEnd);
    events.forEach(function (ev) {
      var prospectKey = normalize_(ev.prospectGuess);
      var prior = findMostRecentPriorScoredCall_(col, values, prospectKey, ev.start);
      var already = hasHandoffBriefBeenSent_(ev.id);
      if (prior) {
        log_('  [' + repCfg.name + '] "' + ev.title + '" @ ' +
          Utilities.formatDate(ev.start, tz, 'dd/MM HH:mm') + ' → prior call by ' + prior.rep +
          ' on ' + prior.callDateStr + (already ? '  [already sent]' : '  [would send]'));
        found++;
      } else {
        log_('  [' + repCfg.name + '] "' + ev.title + '" @ ' +
          Utilities.formatDate(ev.start, tz, 'dd/MM HH:mm') + ' → NO prior scored call found for "' +
          ev.prospectGuess + '" (first call in the funnel, or not yet scored).');
        noMatch++;
      }
    });
  });
  log_('previewUpcomingHandoffBriefs_ done — ' + found + ' matched, ' + noMatch + ' with no prior call found.');
}

/**
 * Live run: same matching as the preview, but generates the brief (LLM call
 * against the prior transcript) and sends it. Gated by HANDOFF_CONFIG.ENABLED
 * — logs the would-be brief instead of sending while false. Idempotent via
 * the "Handoff Briefs Sent" tracking tab; safe to run hourly.
 */
function sendUpcomingHandoffBriefs_() {
  RUN_TAG = 'sendUpcomingHandoffBriefs_';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('sendUpcomingHandoffBriefs_: another run holds the lock, skipping this firing.');
    return;
  }

  try {
    var tz = CONFIG.BUSINESS_TIMEZONE;
    var now = new Date();
    var windowStart = new Date(now.getTime() + HANDOFF_CONFIG.LOOKAHEAD_MIN_HOURS * 3600000);
    var windowEnd = new Date(now.getTime() + HANDOFF_CONFIG.LOOKAHEAD_MAX_HOURS * 3600000);

    var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
    // Real bug found live (26/08/2026 silent-failure audit): resolveSheet_
  // NEVER actually returns null -- it falls back to ss.getSheets()[0] when
  // the preferred name isn't found, so the 'if (!sheet)' guard below was
  // dead code. If the shared tab is ever renamed, this used to silently
  // read/write whatever tab happened to be leftmost instead. Look up this
  // specific, critical tab by name directly so a rename is caught for real.
  var sheet = ss.getSheetByName('Sales Call Log');
    if (!sheet) { log_('No Sales Call Log tab found.'); return; }
    var col = getValidatedColumnMap_(sheet);
    var lastRow = sheet.getLastRow();
    var values = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues() : [];

    var sent = 0, skippedAlready = 0, noMatch = 0, failed = 0;

    CONFIG.REPS.forEach(function (repCfg) {
      var events = getRepCallEvents_(repCfg, windowStart, windowEnd);
      events.forEach(function (ev) {
        if (hasHandoffBriefBeenSent_(ev.id)) { skippedAlready++; return; }

        var prospectKey = normalize_(ev.prospectGuess);
        var prior = findMostRecentPriorScoredCall_(col, values, prospectKey, ev.start);
        if (!prior) { noMatch++; return; }

        try {
          var fileId = extractDriveFileId_(prior.transcriptUrl);
          var transcriptText = getTranscriptText_(DriveApp.getFileById(fileId));
          var briefCtx = {
            priorRep: prior.rep,
            prospectName: ev.prospectGuess,
            priorCallType: prior.callType,
            priorCallDate: prior.callDateStr,
            transcriptText: transcriptText
          };
          var brief = generateHandoffBrief_(briefCtx);
          // Real bug found live (26/08/2026 silent-failure audit): a parse
          // failure sentinel from generateHandoffBrief_ used to be emailed
          // to the rep as if it were the real brief ("Not available —
          // generation failed" in every section), CC'd to Kris and Tomás,
          // and still marked sent — so the hourly retries never regenerated
          // it. Alert and skip instead of sending garbage.
          if (brief._parseFailed) {
            sendOpsAlert_('Handoff brief generation failed for ' + ev.prospectGuess,
              'generateHandoffBrief_ failed to parse twice for "' + ev.title + '" (row ' + prior.rowIndex +
              ') — nothing was sent to ' + repCfg.email + '. This event is NOT marked sent, so it will be ' +
              'retried on the next hourly firing.');
            failed++;
            return;
          }

          var emailCtx = {
            nextRepFirstName: String(repCfg.name).split(' ')[0],
            prospectName: ev.prospectGuess,
            nextCallType: guessCallTypeFromTitle_(ev.title),
            nextCallDateStr: Utilities.formatDate(ev.start, tz, 'dd/MM/yyyy'),
            nextCallTimeStr: Utilities.formatDate(ev.start, tz, 'HH:mm'),
            priorRep: prior.rep,
            priorCallDateStr: prior.callDateStr,
            priorCallType: prior.callType
          };
          var body = buildHandoffBriefEmailBody_(brief, emailCtx);
          var htmlBody = buildHandoffBriefEmailHtml_(brief, emailCtx);
          var subject = repCfg.name + ' — [Handoff Brief] ' + ev.prospectGuess + ' — your ' + emailCtx.nextCallType + ' call in ~24 hrs';

          // Real bug found live (26/08/2026 silent-failure audit):
          // markHandoffBriefSent_ used to sit OUTSIDE this if/else and run
          // unconditionally — so with ENABLED false (a deliberate review
          // period) every event in the lookahead window got permanently
          // marked sent while nothing was ever emailed, directly
          // contradicting installHandoffBriefTrigger_'s own promise that
          // disabling it "will only log, not send". And guardedSend_'s
          // return was discarded, so a quota/config refusal also marked the
          // event sent despite no email going out. Only mark sent when a
          // real send actually happened.
          if (!HANDOFF_CONFIG.ENABLED) {
            log_('  (HANDOFF_CONFIG.ENABLED is false — logging instead of sending, NOT marking sent)');
            log_('  Would send to ' + repCfg.email + ': ' + subject);
            log_(body);
            return;
          }
          var priorRepEmail = repEmailByName_(prior.rep);
          if (!priorRepEmail) {
            log_('  No CONFIG.REPS email found for prior rep "' + prior.rep + '" — not CC\'d on this brief.');
          }
          var cc = [priorRepEmail, CONFIG.KRIS_EMAIL, CONFIG.TOMAS_EMAIL].filter(Boolean).join(',');
          var didSend = guardedSend_(repCfg.email, subject, body, { cc: cc, htmlBody: htmlBody, name: 'Call Handoff Brief Bot' }, 4);
          if (!didSend) {
            log_('  Send blocked/skipped for "' + ev.title + '" — NOT marking sent, will retry next hourly firing.');
            failed++;
            return;
          }

          markHandoffBriefSent_(ev.id);
          log_('  Sent handoff brief for "' + ev.title + '" (row ' + prior.rowIndex + ' was the source call).');
          sent++;
          Utilities.sleep(300);
        } catch (e) {
          log_('  FAILED "' + ev.title + '": ' + e);
          failed++;
        }
      });
    });

    log_('sendUpcomingHandoffBriefs_ done — sent ' + sent + ', already sent ' + skippedAlready +
      ', no prior call found ' + noMatch + ', failed ' + failed + '.');
  } finally {
    lock.releaseLock();
  }
}

/** Best-effort call-type label for the subject line, reusing the same keyword list Phase 1 classifies events with. */
function guessCallTypeFromTitle_(title) {
  var t = String(title || '').toLowerCase();
  if (t.indexOf('qc') !== -1 || t.indexOf('qualification') !== -1) return 'QC';
  if (t.indexOf('discovery') !== -1) return 'Discovery';
  if (t.indexOf('sales call') !== -1) return 'Sales Call';
  return 'call';
}

/**
 * ONE-TIME setup, run manually — ideally only after previewUpcomingHandoffBriefs_
 * has been checked against real data. Same idempotent reinstallHourlyTrigger_
 * helper as the Phase 2 scoring triggers; safe to re-run.
 */
function installHandoffBriefTrigger() {
  RUN_TAG = 'installHandoffBriefTrigger';
  reinstallHourlyTrigger_('sendUpcomingHandoffBriefs_', 1);
  log_('Handoff brief check installed: sendUpcomingHandoffBriefs_() now runs every hour. ' +
    (HANDOFF_CONFIG.ENABLED
      ? 'HANDOFF_CONFIG.ENABLED is true — real briefs will be emailed to reps as upcoming calls are found.'
      : 'HANDOFF_CONFIG.ENABLED is still false — it will only log, not send, until you flip that.'));
}
