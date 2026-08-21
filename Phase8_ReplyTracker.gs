/**
 * Phase8_ReplyTracker.gs
 *
 * Kris's ask (20/08/2026): every day, hundreds of cold-outreach replies (sent
 * from many different Maildoso warm-up domains/inboxes) get forwarded into
 * Joana's inbox, all funneled through the one consistent address
 * network@ardorseo.com regardless of which sending domain the lead actually
 * replied to — confirmed by reading real threads in Joana's inbox (20/08/2026):
 * sender AND recipient both show as network@ardorseo.com even though the
 * quoted original message underneath comes from a different domain each
 * time. That one address is what this file filters on.
 *
 * Reuses Phase 4's Gmail service-account plumbing (getGmailAccessTokenForUser_,
 * gmailApiGet_, buildServiceAccountJwt_ — same file, same Apps Script project,
 * no import needed) rather than duplicating it. Domain-wide delegation for
 * gmail.readonly was already granted at the domain level for Phase 4, so
 * impersonating Joana's mailbox here needs no new Admin Console setup.
 *
 * What this does NOT yet do — needs one more answer from Kris before it's
 * complete: the two booking-percentage metrics ("booked themselves for QC" vs
 * "booked to QC" by a rep after Joana hands the lead off) are meant to be
 * read off the existing "Booked" column already used elsewhere (values seen:
 * a rep name, or "By the Lead") — but I don't yet know the real tab name(s)
 * that column lives on. reconcileBookingOutcomes_() below is a stub that
 * logs this loudly rather than guessing at a tab name and silently computing
 * a wrong percentage. Fill in REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS once
 * confirmed.
 *
 * Positive/negative is judged per-message by an AI classifier (no existing
 * system records this today per Kris) — see buildReplyClassifierPrompt_().
 *
 * Entry points:
 *  - previewReplyClassification()   Dry run: lists what would be classified,
 *                                    calls no model, writes nothing.
 *  - classifyNewReplies()           Classifies + logs every not-yet-seen
 *                                    reply into the "Reply Tracker" tab.
 *  - previewReplyMetricsReport()    Logs the day/7d/30d rollup instead of
 *                                    emailing it — check this before flipping
 *                                    REPLY_TRACKER_CONFIG.ENABLED.
 *  - sendReplyMetricsReport_()      Emails the same rollup. Only called by
 *                                    the daily trigger once ENABLED is true.
 */

var REPLY_TRACKER_CONFIG = {
  ENABLED: true, // Flipped true 20/08/2026 after real classifications (Sabrina/Marilyn/CARY/Stop/Michelle/Ray) checked out.

  FORWARD_ADDRESS: 'network@ardorseo.com', // confirmed 20/08/2026 — see file header.
  IMPERSONATE_EMAIL: 'joana@iconsofrealestate.com', // whose inbox actually holds these forwards.

  // Reuses Phase 4's already-granted service account (same scope, same
  // domain-wide delegation) rather than provisioning a second one.
  SERVICE_ACCOUNT_EMAIL_PROPERTY: 'GMAIL_SLA_SERVICE_ACCOUNT_EMAIL',
  SERVICE_ACCOUNT_PRIVATE_KEY_PROPERTY: 'GMAIL_SLA_SERVICE_ACCOUNT_PRIVATE_KEY',

  SEARCH_WINDOW_DAYS: 3, // wider than 1 day so a missed run's stragglers still get picked up, dedup handles overlap.
  SHEET_NAME: 'Reply Tracker',
  DAILY_TRIGGER_HOUR: 21, // after the day's forwards have landed, before end of day.

  // TODO(Kris): confirm the real tab name(s) holding the "Booked" column
  // (values: a rep name, or "By the Lead") so reconcileBookingOutcomes_ can
  // compute the two booking percentages instead of stubbing them.
  BOOKING_TRACKER_TABS: []
};

// ---------------------------------------------------------------------------
// AI classifier — positive/negative judgment on one forwarded reply.
// ---------------------------------------------------------------------------

function buildReplyClassifierPrompt_() {
  return [
    'You are triaging a cold-outreach reply from a real estate agent, forwarded from a lead-generation mailbox.',
    'The outreach pitches hosting a real estate podcast/show. Classify this single reply as:',
    '  positive = any sign of interest, even soft (asks a question, says "tell me more", proposes a time,',
    '    asks to be called, does not explicitly decline).',
    '  negative = a clear decline (not interested, wrong contact, unsubscribe/stop, already doing something',
    '    similar, hostile, or a bounce/auto-reply).',
    '',
    'Return ONLY raw JSON, no markdown fences, no commentary, in this exact shape:',
    '{',
    '  "sentiment": "positive | negative",',
    '  "reasoning": "string — one sentence, quote the key phrase that decided it"',
    '}'
  ].join('\n');
}

function isValidReplyClassifierSchema_(obj) {
  return !!(obj && (obj.sentiment === 'positive' || obj.sentiment === 'negative') &&
    typeof obj.reasoning === 'string');
}

/** Same retry/manual-review shape as the Phase 2 judges, against the reply-classifier prompt. */
function classifyReply_(fromEmail, subject, bodyText) {
  var systemPrompt = buildReplyClassifierPrompt_();
  var userPrompt = 'From: ' + fromEmail + '\nSubject: ' + subject + '\n\nReply text:\n' + bodyText;
  var lastRaw = null;

  for (var attempt = 0; attempt <= PHASE2_CONFIG.MAX_PARSE_RETRIES; attempt++) {
    var promptForThisAttempt = attempt === 0
      ? userPrompt
      : userPrompt + '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object.';
    try {
      var raw = callKimiJudge_(systemPrompt, promptForThisAttempt);
      lastRaw = raw;
      var parsed = stripFencesAndParseJson_(raw);
      if (!isValidReplyClassifierSchema_(parsed)) throw new Error('Missing required fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ classifyReply_ attempt ' + (attempt + 1) + ' failed: ' + e);
    }
  }
  log_('    ↳ ROUTED TO MANUAL REVIEW (parse failed twice). Raw: ' + String(lastRaw).slice(0, 500));
  return { sentiment: 'negative', reasoning: 'Unscored — parse failed twice, defaulted to negative for manual review.', _parseFailed: true };
}

// ---------------------------------------------------------------------------
// Gmail read — reuses Phase 4's token/GET helpers, adds body extraction
// (Phase 4 only ever reads metadata=From/Subject; this needs the actual text).
// ---------------------------------------------------------------------------

function buildReplyForwardQuery_() {
  return 'in:inbox newer_than:' + REPLY_TRACKER_CONFIG.SEARCH_WINDOW_DAYS + 'd to:' + REPLY_TRACKER_CONFIG.FORWARD_ADDRESS;
}

function listReplyForwardThreadIds_(accessToken) {
  var ids = [];
  var pageToken = null;
  var q = encodeURIComponent(buildReplyForwardQuery_());
  do {
    var path = '/threads?q=' + q + '&maxResults=100' + (pageToken ? '&pageToken=' + pageToken : '');
    var page = gmailApiGet_(accessToken, path);
    (page.threads || []).forEach(function (t) { ids.push(t.id); });
    pageToken = page.nextPageToken || null;
  } while (pageToken);
  return ids;
}

/** Walks a Gmail API message payload for the first text/plain part and decodes it. */
function extractPlainTextBody_(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(payload.body.data)).getDataAsString();
  }
  var parts = payload.parts || [];
  for (var i = 0; i < parts.length; i++) {
    var found = extractPlainTextBody_(parts[i]);
    if (found) return found;
  }
  return '';
}

/** Full (not metadata-only) read of a thread's last message — this is the actual forwarded reply text. */
function getThreadLastMessageFull_(accessToken, threadId) {
  var thread = gmailApiGet_(accessToken, '/threads/' + threadId + '?format=full');
  var messages = thread.messages || [];
  if (!messages.length) return null;
  var last = messages[messages.length - 1];
  var headers = {};
  (last.payload && last.payload.headers || []).forEach(function (h) { headers[h.name] = h.value; });
  return {
    threadId: threadId,
    date: new Date(Number(last.internalDate)),
    fromRaw: headers['From'] || '(unknown sender)',
    subject: headers['Subject'] || '(no subject)',
    bodyText: extractPlainTextBody_(last.payload).slice(0, 4000) // plenty for a short reply; caps a pathological quote-chain.
  };
}

// ---------------------------------------------------------------------------
// Sheet setup + dedup.
// ---------------------------------------------------------------------------

var REPLY_TRACKER_HEADERS = [
  'Date', 'Thread ID', 'From', 'Subject', 'Sentiment', 'Reasoning', 'Lead Email'
];

function getOrCreateReplyTrackerSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(REPLY_TRACKER_CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(REPLY_TRACKER_CONFIG.SHEET_NAME);
    sheet.getRange(1, 1, 1, REPLY_TRACKER_HEADERS.length).setValues([REPLY_TRACKER_HEADERS])
      .setFontWeight('bold').setBackground('#e8eef7');
    sheet.setFrozenRows(1);
    log_('Created "' + REPLY_TRACKER_CONFIG.SHEET_NAME + '" tab.');
  }
  return sheet;
}

function loadLoggedThreadIds_(sheet) {
  var ids = {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return ids;
  sheet.getRange(2, 2, lastRow - 1, 1).getValues().forEach(function (row) {
    if (row[0]) ids[row[0]] = true;
  });
  return ids;
}

// ---------------------------------------------------------------------------
// Entry points.
// ---------------------------------------------------------------------------

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewReplyClassification() {
  RUN_TAG = 'previewReplyClassification';
  var token = getGmailAccessTokenForUser_(REPLY_TRACKER_CONFIG.IMPERSONATE_EMAIL);
  var sheet = getOrCreateReplyTrackerSheet_();
  var logged = loadLoggedThreadIds_(sheet);
  var threadIds = listReplyForwardThreadIds_(token);
  var newCount = 0;
  threadIds.forEach(function (id) {
    if (logged[id]) return;
    newCount++;
  });
  log_('previewReplyClassification — ' + threadIds.length + ' thread(s) found in the last ' +
    REPLY_TRACKER_CONFIG.SEARCH_WINDOW_DAYS + ' day(s), ' + newCount + ' not yet logged. ' +
    'No model called, nothing written.');
}

function classifyNewReplies() {
  RUN_TAG = 'classifyNewReplies';
  if (!REPLY_TRACKER_CONFIG.ENABLED) {
    log_('REPLY_TRACKER_CONFIG.ENABLED is false — classifying and logging anyway (this is read/log only, ' +
      'never sends anything); ENABLED only gates the daily report email.');
  }

  var token = getGmailAccessTokenForUser_(REPLY_TRACKER_CONFIG.IMPERSONATE_EMAIL);
  var sheet = getOrCreateReplyTrackerSheet_();
  var logged = loadLoggedThreadIds_(sheet);
  var threadIds = listReplyForwardThreadIds_(token);

  var classified = 0, skippedExisting = 0, failed = 0;
  threadIds.forEach(function (id) {
    if (logged[id]) { skippedExisting++; return; }
    try {
      var msg = getThreadLastMessageFull_(token, id);
      if (!msg) { failed++; return; }
      var leadEmail = extractEmailAddress_(msg.fromRaw);
      var result = classifyReply_(msg.fromRaw, msg.subject, msg.bodyText);
      sheet.appendRow([msg.date, id, msg.fromRaw, msg.subject, result.sentiment, result.reasoning, leadEmail]);
      log_('  Classified "' + msg.subject + '": ' + result.sentiment + (result._parseFailed ? ' [PARSE FAILED]' : ''));
      classified++;
      Utilities.sleep(300);
    } catch (e) {
      log_('  FAILED thread ' + id + ': ' + e);
      failed++;
    }
  });

  log_('classifyNewReplies done — classified ' + classified + ', already-logged ' + skippedExisting +
    ', failed ' + failed + '.');
}

/**
 * Reconciles logged replies against the existing "Booked" column (rep name =
 * booked-to-QC-by-rep, "By the Lead" = self-booked via link) by lead email.
 * STUB — needs REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS filled in (see file
 * header). Returns null (not 0 — a real 0% would be a misleading answer)
 * until then so callers can distinguish "not wired up yet" from "wired up,
 * genuinely zero."
 */
function reconcileBookingOutcomes_(leadEmails) {
  if (!REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS.length) {
    log_('reconcileBookingOutcomes_: BOOKING_TRACKER_TABS not configured — booking percentages will read as ' +
      'n/a until Kris confirms the tab name(s) holding the "Booked" column.');
    return null;
  }
  var outcomes = {}; // leadEmail -> 'self' | 'rep' | undefined (not found)
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS.forEach(function (tabName) {
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var values = sheet.getRange(2, 1, lastRow - 1, 4).getValues(); // Name, Email, Source, Booked
    values.forEach(function (row) {
      var email = String(row[1] || '').trim().toLowerCase();
      var booked = String(row[3] || '').trim();
      if (!email || !booked) return;
      outcomes[email] = (booked === 'By the Lead') ? 'self' : 'rep';
    });
  });
  return outcomes;
}

/**
 * Tallies logged replies in [start, end) into count/positive/negative, plus
 * the "negative turned positive" rate (per lead email, not per message — a
 * lead who first replied negative then later replied positive counts once).
 */
function computeReplyStats_(rows, start, end) {
  var inRange = rows.filter(function (r) { return r.date >= start && r.date < end; });
  var positive = inRange.filter(function (r) { return r.sentiment === 'positive'; }).length;
  var negative = inRange.filter(function (r) { return r.sentiment === 'negative'; }).length;

  // Flip rate uses full history (not just inRange) per lead, since the negative
  // reply and the later positive one may straddle the window boundary.
  var byLead = {};
  rows.forEach(function (r) {
    if (!r.leadEmail) return;
    byLead[r.leadEmail] = byLead[r.leadEmail] || [];
    byLead[r.leadEmail].push(r);
  });
  var negativeLeadsInRange = {};
  inRange.forEach(function (r) { if (r.sentiment === 'negative' && r.leadEmail) negativeLeadsInRange[r.leadEmail] = true; });
  var flipped = 0;
  Object.keys(negativeLeadsInRange).forEach(function (email) {
    var hasLaterPositive = byLead[email].some(function (r) { return r.sentiment === 'positive' && r.date > byLead[email][0].date; });
    if (hasLaterPositive) flipped++;
  });
  var negativeLeadCount = Object.keys(negativeLeadsInRange).length;

  return {
    count: inRange.length,
    positive: positive,
    negative: negative,
    pctNegativeTurnedPositive: negativeLeadCount ? (flipped / negativeLeadCount) : null
  };
}

function loadAllLoggedReplies_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, REPLY_TRACKER_HEADERS.length).getValues().map(function (row) {
    return { date: row[0], threadId: row[1], fromRaw: row[2], subject: row[3], sentiment: row[4], reasoning: row[5], leadEmail: row[6] };
  });
}

function buildReplyMetricsReportBody_(rows, now, tz) {
  var dayStart = businessDayStart_(now, tz);
  var dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
  var weekStart = new Date(dayEnd.getTime() - 7 * 24 * 3600 * 1000);
  var monthStart = new Date(dayEnd.getTime() - 30 * 24 * 3600 * 1000);

  var day = computeReplyStats_(rows, dayStart, dayEnd);
  var week = computeReplyStats_(rows, weekStart, dayEnd);
  var month = computeReplyStats_(rows, monthStart, dayEnd);

  var leadEmails = rows.map(function (r) { return r.leadEmail; }).filter(Boolean);
  var bookingOutcomes = reconcileBookingOutcomes_(leadEmails);
  var bookingLine = bookingOutcomes
    ? '  Booked themselves / booked to QC by a rep: not yet computed per-period — reconciliation is wired up ' +
      'but the per-period date-matching logic still needs to be designed once Kris confirms how a booking date ' +
      'should map back to a reply period.'
    : '  Booked themselves / booked to QC by a rep: n/a (booking tracker tab(s) not configured yet — see ' +
      'REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS)';

  function line(label, stats) {
    var pct = stats.pctNegativeTurnedPositive;
    return label + ': ' + stats.count + ' reply(ies), ' + stats.positive + ' positive, ' + stats.negative +
      ' negative' + (pct !== null ? ', ' + (pct * 100).toFixed(0) + '% of negative leads later turned positive' : '') + '\n' +
      bookingLine;
  }

  return [
    'Daily reply tracker — ' + Utilities.formatDate(now, tz, 'yyyy-MM-dd'),
    '',
    line('Today', day),
    '',
    line('Rolling 7-day average', week),
    '',
    line('Rolling 30-day average', month),
    '',
    bookingOutcomes ? '' : 'NOTE: booking percentages are not yet wired up — see REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS in Phase8_ReplyTracker.gs.'
  ].join('\n');
}

function previewReplyMetricsReport() {
  RUN_TAG = 'previewReplyMetricsReport';
  var sheet = getOrCreateReplyTrackerSheet_();
  var rows = loadAllLoggedReplies_(sheet);
  var body = buildReplyMetricsReportBody_(rows, new Date(), CONFIG.BUSINESS_TIMEZONE);
  log_(body);
}

function sendReplyMetricsReport_() {
  RUN_TAG = 'sendReplyMetricsReport_';
  if (!REPLY_TRACKER_CONFIG.ENABLED) { log_('REPLY_TRACKER_CONFIG.ENABLED is false — skipping send.'); return; }
  var sheet = getOrCreateReplyTrackerSheet_();
  var rows = loadAllLoggedReplies_(sheet);
  var body = buildReplyMetricsReportBody_(rows, new Date(), CONFIG.BUSINESS_TIMEZONE);
  guardedSend_(CONFIG.KRIS_EMAIL, 'Daily reply tracker', body, { cc: CONFIG.TOMAS_EMAIL, name: 'Reply Tracker Bot' }, 2);
  log_('Sent daily reply tracker report.');
}

/** ONE-TIME setup — run once from the Apps Script editor. */
function installReplyTrackerTriggers() {
  RUN_TAG = 'installReplyTrackerTriggers';
  reinstallHourlyTrigger_('classifyNewReplies', 4);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendReplyMetricsReport_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendReplyMetricsReport_')
    .timeBased().everyDays(1).atHour(REPLY_TRACKER_CONFIG.DAILY_TRIGGER_HOUR).inTimezone(CONFIG.BUSINESS_TIMEZONE).create();
  log_('Reply tracker installed: classifyNewReplies() every 4h, sendReplyMetricsReport_() daily at ' +
    REPLY_TRACKER_CONFIG.DAILY_TRIGGER_HOUR + ':00 ' + CONFIG.BUSINESS_TIMEZONE + '. ENABLED is currently ' +
    REPLY_TRACKER_CONFIG.ENABLED + ' — while false the report logs would be skipped (send only), but classification ' +
    'and logging run regardless.');
}
