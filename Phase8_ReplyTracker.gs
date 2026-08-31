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
 * Real bug found + fixed 28/08/2026 (Kris flagged "0% booked" + "6 leads"
 * for 131 replies): the relay address above is right for finding threads,
 * but two things downstream of that were wrong. (1) getThreadLastMessageFull_
 * took the thread's chronologically LAST message, which is often Joana's
 * own reply sent later in the same thread, not the lead's forward — fixed
 * to walk backwards for the last message actually FROM the relay address.
 * (2) Lead Email was extracted from that message's envelope From header,
 * which is always the relay address (or, per bug 1, sometimes Joana's own
 * address) — never the real lead. Fixed to pull the real lead address out
 * of the body's quoted-reply header instead (extractLeadEmailFromReplyBody_).
 * Together these two bugs collapsed ~131 distinct leads into a handful of
 * fromRaw values, which is exactly why "of 6 leads" showed up, and broke
 * the booking-tracker join (keyed on lead email) so it always read 0%.
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

  // Confirmed 27/08/2026: "Icons Podcast Recordings" (same spreadsheet as
  // Sales Call Log/Objection Playbook/etc.) has the "Booked" column this
  // needs — Name/Email/Source/Booked in columns A-D, Booked values "Bens" or
  // "By the Lead", matching reconcileBookingOutcomes_'s expected shape
  // exactly. This is Bens' Icons 100 tracker specifically — if Sean/Joana/
  // Tomás have an equivalent tracker tab of their own, add its name here too
  // so their leads aren't silently missing from the booking percentages.
  BOOKING_TRACKER_TABS: ['Icons Podcast Recordings']
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

/**
 * Same retry/manual-review shape as the Phase 2 judges, against the
 * reply-classifier prompt. handleJudgeRetryError_ re-throws once retries are
 * exhausted on a genuine TRANSPORT failure (API outage, bad key) instead of
 * letting this fall through to the sentinel below — the caller's own
 * try/catch (classifyNewReplies) then counts it as `failed` and skips
 * logging the thread entirely. Real bug (H-04) fixed here: previously every
 * failure, transport or parse, silently landed in the Reply Tracker sheet as
 * a real "negative" classification, quietly inflating the negative count
 * with pipeline outages rather than actual lead sentiment.
 */
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
      handleJudgeRetryError_(e, attempt, PHASE2_CONFIG.MAX_PARSE_RETRIES);
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

/** Walks a Gmail API message payload for the first text/html part and decodes it, stripping tags. */
function extractHtmlBodyAsText_(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    var html = Utilities.newBlob(Utilities.base64DecodeWebSafe(payload.body.data)).getDataAsString();
    return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  var parts = payload.parts || [];
  for (var i = 0; i < parts.length; i++) {
    var found = extractHtmlBodyAsText_(parts[i]);
    if (found) return found;
  }
  return '';
}

function getMessageHeader_(message, name) {
  var headers = (message.payload && message.payload.headers) || [];
  for (var i = 0; i < headers.length; i++) {
    if (headers[i].name === name) return headers[i].value;
  }
  return '';
}

/**
 * Full (not metadata-only) read of a thread's last FORWARDED-RELAY message —
 * NOT simply the thread's chronologically last message. Real bug (confirmed
 * live 28/08/2026, thread 1a042d0067c3adf7): Joana routinely replies to the
 * lead from within the same Gmail thread the forward landed in, and Gmail
 * thread order is purely chronological, not directional — messages[len-1]
 * was very often Joana's OWN outgoing reply (From: joana@iconsofrealestate.com),
 * not the lead's forwarded reply. The classifier then scored Joana's own
 * sent text as if it were the lead's sentiment, and every downstream field
 * (fromRaw, and therefore Lead Email) came from Joana's message instead of
 * the lead's. Walk backwards for the last message actually sent FROM
 * REPLY_TRACKER_CONFIG.FORWARD_ADDRESS instead.
 */
function getThreadLastMessageFull_(accessToken, threadId) {
  var thread = gmailApiGet_(accessToken, '/threads/' + threadId + '?format=full');
  var messages = thread.messages || [];
  var last = null;
  for (var i = messages.length - 1; i >= 0; i--) {
    if (getMessageHeader_(messages[i], 'From').indexOf(REPLY_TRACKER_CONFIG.FORWARD_ADDRESS) !== -1) {
      last = messages[i];
      break;
    }
  }
  if (!last) return null; // matched the search query but no message in the thread is actually from the relay — don't guess.
  // Real bug (L-13): extractPlainTextBody_ only walks text/plain parts — an
  // HTML-only reply (no text/plain alternative at all, common from webmail
  // clients) came back as '', so the classifier prompt got an empty reply
  // body and had nothing real to judge. Fall back to a tag-stripped
  // text/html part when no text/plain part exists.
  var bodyText = extractPlainTextBody_(last.payload) || extractHtmlBodyAsText_(last.payload);
  return {
    threadId: threadId,
    messageId: last.id, // dedupe key — see loadLoggedMessageIds_ for why this must not be the thread ID
    date: new Date(Number(last.internalDate)),
    fromRaw: getMessageHeader_(last, 'From') || '(unknown sender)',
    subject: getMessageHeader_(last, 'Subject') || '(no subject)',
    bodyText: bodyText.slice(0, 4000) // plenty for a short reply; caps a pathological quote-chain.
  };
}

/**
 * The forwarded message's own From header is always
 * REPLY_TRACKER_CONFIG.FORWARD_ADDRESS (see file header) — never the real
 * lead's address. The real lead's email survives only in the quoted-reply
 * header Gmail inserts at the top of the body text — confirmed live
 * 28/08/2026 against real forwards, e.g. "On Wednesday, Aug 26, 2026 at
 * 3:03 pm jborwick@chaseinternational.com wrote:" (no display name) and
 * "On Wed, Aug 26, 2026 at 8:07 AM Joana Peixe <joanap@iconsrealestateco.com>
 * wrote:" (display name + bracketed address, further down for a team
 * member's own quoted message) — so this takes the FIRST "wrote:" in the
 * body, which is always the lead's own reply, not a later quoted one.
 *
 * Real bug found 29/08/2026 (Kris flagged "0% booked" for 98 leads): this
 * used to isolate the header by splitting on '\n' and taking the last
 * non-empty line before "wrote:" — correct for a plain-text body, but
 * extractHtmlBodyAsText_'s tag-stripped output (used whenever a reply has
 * no text/plain part, common from webmail clients) has NO newlines at all,
 * collapsing the entire preceding body into one "line" and returning the
 * FIRST email address anywhere in it — usually the outreach signature's own
 * address, not the lead's.
 *
 * Fixed with a regex that requires the email to sit DIRECTLY adjacent to
 * "wrote:" (only an optional closing '>' and whitespace, which covers both
 * confirmed real formats, allowed in between) rather than searching a fixed
 * lookback window — a window is either too wide (a first pass at this fix
 * briefly re-introduced the same class of bug: a distractor address earlier
 * in an HTML-collapsed body, e.g. an outreach signature's own, could still
 * fall inside it and get returned instead of the lead's) or too narrow to
 * fit a long display name. Adjacency has no such tradeoff, since Gmail's own
 * quote header always puts the address immediately before "wrote:".
 */
function extractLeadEmailFromReplyBody_(bodyText) {
  if (!bodyText) return '';
  var match = bodyText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?\s*wrote:/i);
  return match ? match[1].toLowerCase() : '';
}

// ---------------------------------------------------------------------------
// Sheet setup + dedup.
// ---------------------------------------------------------------------------

var REPLY_TRACKER_HEADERS = [
  'Date', 'Thread ID', 'From', 'Subject', 'Sentiment', 'Reasoning', 'Lead Email', 'Message ID'
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

/**
 * Dedupes by MESSAGE id, not thread id (real bug H-05). Gmail threads
 * accumulate messages — dedupe-by-thread meant a lead's second, third, etc.
 * reply on the SAME thread was silently treated as "already logged" the
 * moment the first reply in that thread got classified, freezing that lead's
 * sentiment at whatever their very first reply was and never re-classifying
 * a later reply even if it flatly contradicted it (also breaking
 * computeReplyStats_'s flip-rate math, which depends on a lead's later
 * replies actually landing as their own rows).
 */
function loadLoggedMessageIds_(sheet) {
  var ids = {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return ids;
  var col = REPLY_TRACKER_HEADERS.indexOf('Message ID') + 1;
  sheet.getRange(2, col, lastRow - 1, 1).getValues().forEach(function (row) {
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
  var logged = loadLoggedMessageIds_(sheet);
  var threadIds = listReplyForwardThreadIds_(token);
  var newCount = 0, failed = 0;
  threadIds.forEach(function (id) {
    // Dedupe is by message id (see loadLoggedMessageIds_), so a full fetch
    // per thread is needed even in preview mode to get an accurate count —
    // still calls no model and writes nothing.
    try {
      var msg = getThreadLastMessageFull_(token, id);
      if (msg && !logged[msg.messageId]) newCount++;
    } catch (e) {
      failed++;
    }
  });
  log_('previewReplyClassification — ' + threadIds.length + ' thread(s) found in the last ' +
    REPLY_TRACKER_CONFIG.SEARCH_WINDOW_DAYS + ' day(s), ' + newCount + ' not yet logged' +
    (failed ? ' (' + failed + ' thread(s) failed to fetch)' : '') + '. No model called, nothing written.');
}

function classifyNewReplies() {
  RUN_TAG = 'classifyNewReplies';
  if (!REPLY_TRACKER_CONFIG.ENABLED) {
    log_('REPLY_TRACKER_CONFIG.ENABLED is false — classifying and logging anyway (this is read/log only, ' +
      'never sends anything); ENABLED only gates the daily report email.');
  }

  var token = getGmailAccessTokenForUser_(REPLY_TRACKER_CONFIG.IMPERSONATE_EMAIL);
  var sheet = getOrCreateReplyTrackerSheet_();
  var logged = loadLoggedMessageIds_(sheet);
  var threadIds = listReplyForwardThreadIds_(token);

  var classified = 0, skippedExisting = 0, failed = 0;
  threadIds.forEach(function (id) {
    try {
      var msg = getThreadLastMessageFull_(token, id);
      if (!msg) { failed++; return; }
      if (logged[msg.messageId]) { skippedExisting++; return; } // dedupe by message, not thread — see loadLoggedMessageIds_
      // Real bug (29/08/2026): falling back to extractEmailAddress_ (Phase4_InboxSLA.gs)
      // called on msg.fromRaw here put the RELAY address (msg.fromRaw is always REPLY_TRACKER_CONFIG.
      // FORWARD_ADDRESS) into Lead Email whenever extraction failed — every such
      // row then looked like the SAME "lead," silently corrupting both the
      // flip-rate calc and the booking join (which key off Lead Email) rather
      // than just being correctly excluded from them. Leaving it blank on a
      // failed extraction is what every downstream calc already expects
      // (they all skip rows with a falsy leadEmail) — the row itself still
      // gets logged either way, only the Lead Email column is affected.
      var leadEmail = extractLeadEmailFromReplyBody_(msg.bodyText);
      var result = classifyReply_(msg.fromRaw, msg.subject, msg.bodyText);
      sheet.appendRow([msg.date, id, msg.fromRaw, msg.subject, result.sentiment, result.reasoning, leadEmail, msg.messageId]);
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
 * Tallies logged replies in [start, end) into count/positive/negative, the
 * "negative turned positive" rate (per lead email, not per message — a lead
 * who first replied negative then later replied positive counts once), and
 * (when bookingOutcomes is available) what fraction of the leads who
 * replied in THIS period ultimately booked themselves vs. got booked to QC
 * by a rep — keyed off the reply date, not the booking date, since that's
 * the natural reading of "of the leads who replied this period, how many
 * converted" and needs no separate design decision about how a booking
 * date should map back to a reply window.
 */
function computeReplyStats_(rows, start, end, bookingOutcomes) {
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
  // Sort each lead's rows chronologically — appendRow order follows Gmail's
  // thread-list/classification order, not necessarily reply date order, so
  // byLead[email][0] was not reliably the lead's EARLIEST reply (real bug:
  // "flip rate" compared a negative-in-range reply against whichever row
  // happened to be first in the sheet for that lead, not against that
  // specific negative reply's own date).
  Object.keys(byLead).forEach(function (email) {
    byLead[email].sort(function (a, b) { return a.date - b.date; });
  });
  var negativeLeadsInRange = {};
  inRange.forEach(function (r) { if (r.sentiment === 'negative' && r.leadEmail) negativeLeadsInRange[r.leadEmail] = true; });
  var flipped = 0;
  Object.keys(negativeLeadsInRange).forEach(function (email) {
    // The negative reply actually in range for this lead, not just "the
    // first row ever on file" — a lead can have gone negative, positive,
    // negative again; only a positive AFTER the in-range negative counts.
    var negativeInRangeDate = inRange.filter(function (r) { return r.leadEmail === email && r.sentiment === 'negative'; })
      .reduce(function (earliest, r) { return (!earliest || r.date < earliest) ? r.date : earliest; }, null);
    var hasLaterPositive = byLead[email].some(function (r) { return r.sentiment === 'positive' && r.date > negativeInRangeDate; });
    if (hasLaterPositive) flipped++;
  });
  var negativeLeadCount = Object.keys(negativeLeadsInRange).length;

  var bookingStats = null;
  if (bookingOutcomes) {
    var leadsInRange = {};
    inRange.forEach(function (r) { if (r.leadEmail) leadsInRange[r.leadEmail] = true; });
    var repliedLeadCount = Object.keys(leadsInRange).length;
    var bookedSelf = 0, bookedByRep = 0;
    Object.keys(leadsInRange).forEach(function (email) {
      var outcome = bookingOutcomes[email];
      if (outcome === 'self') bookedSelf++;
      else if (outcome === 'rep') bookedByRep++;
    });
    bookingStats = {
      repliedLeadCount: repliedLeadCount,
      pctBookedThemselves: repliedLeadCount ? (bookedSelf / repliedLeadCount) : null,
      pctBookedToQCByRep: repliedLeadCount ? (bookedByRep / repliedLeadCount) : null
    };
  }

  return {
    count: inRange.length,
    positive: positive,
    negative: negative,
    pctNegativeTurnedPositive: negativeLeadCount ? (flipped / negativeLeadCount) : null,
    bookingStats: bookingStats,
    rows: inRange // exposed so callers can list individual replies (e.g. today's positive/negative) without recomputing the range boundaries themselves
  };
}

function loadAllLoggedReplies_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, REPLY_TRACKER_HEADERS.length).getValues().map(function (row) {
    return { date: row[0], threadId: row[1], fromRaw: row[2], subject: row[3], sentiment: row[4], reasoning: row[5], leadEmail: row[6], messageId: row[7] };
  });
}

/** Shared by both the plain-text and HTML renderers below, so the two can never drift apart on the actual numbers. */
function computeReplyMetricsPeriods_(rows, now, tz) {
  var dayStart = businessDayStart_(now, tz);
  var dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
  var weekStart = new Date(dayEnd.getTime() - 7 * 24 * 3600 * 1000);
  var monthStart = new Date(dayEnd.getTime() - 30 * 24 * 3600 * 1000);

  var leadEmails = rows.map(function (r) { return r.leadEmail; }).filter(Boolean);
  var bookingOutcomes = reconcileBookingOutcomes_(leadEmails);
  return {
    day: computeReplyStats_(rows, dayStart, dayEnd, bookingOutcomes),
    week: computeReplyStats_(rows, weekStart, dayEnd, bookingOutcomes),
    month: computeReplyStats_(rows, monthStart, dayEnd, bookingOutcomes),
    bookingOutcomes: bookingOutcomes
  };
}

function bookingLineText_(bookingStats) {
  if (!bookingStats) {
    return '  Booked themselves / booked to QC by a rep: n/a (booking tracker tab(s) not configured yet — see ' +
      'REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS)';
  }
  if (!bookingStats.repliedLeadCount) {
    return '  Booked themselves / booked to QC by a rep: n/a (no leads replied in this period)';
  }
  return '  Booked themselves: ' + (bookingStats.pctBookedThemselves * 100).toFixed(0) +
    '% / booked to QC by a rep: ' + (bookingStats.pctBookedToQCByRep * 100).toFixed(0) +
    '% (of ' + bookingStats.repliedLeadCount + ' lead(s) who replied this period)';
}

/** One "- Subject — lead — reasoning" line per reply of the given sentiment, sorted newest first. */
function replyListLinesText_(rows, sentiment) {
  var matches = rows.filter(function (r) { return r.sentiment === sentiment; })
    .sort(function (a, b) { return b.date - a.date; });
  if (!matches.length) return '  (none)';
  return matches.map(function (r) {
    return '  - ' + (r.subject || '(no subject)') + ' — ' + (r.leadEmail || '(lead email not extracted)') +
      ' — ' + (r.reasoning || '');
  }).join('\n');
}

function buildReplyMetricsReportBody_(rows, now, tz) {
  var periods = computeReplyMetricsPeriods_(rows, now, tz);

  function line(label, stats, avgOverDays) {
    var pct = stats.pctNegativeTurnedPositive;
    var counts = avgOverDays
      ? (stats.count / avgOverDays).toFixed(1) + ' reply(ies)/day avg, ' + (stats.positive / avgOverDays).toFixed(1) +
        ' positive/day avg, ' + (stats.negative / avgOverDays).toFixed(1) + ' negative/day avg'
      : stats.count + ' reply(ies), ' + stats.positive + ' positive, ' + stats.negative + ' negative';
    return label + ': ' + counts +
      (pct !== null ? ', ' + (pct * 100).toFixed(0) + '% of negative leads later turned positive' : '') + '\n' +
      bookingLineText_(stats.bookingStats);
  }

  return [
    'Daily reply tracker — ' + Utilities.formatDate(now, tz, 'dd/MM/yy'),
    '',
    line('Today', periods.day),
    '',
    'Today — positive:',
    replyListLinesText_(periods.day.rows, 'positive'),
    '',
    'Today — negative:',
    replyListLinesText_(periods.day.rows, 'negative'),
    '',
    // Real bug (29/08/2026): this used to label a raw rolling TOTAL as an
    // "average" — stats.count is a sum over the window, never divided by
    // days. Now actually averaged per day, as the label says.
    line('Rolling 7-day average', periods.week, 7),
    '',
    line('Rolling 30-day average', periods.month, 30),
    '',
    periods.bookingOutcomes ? '' : 'NOTE: booking percentages are not yet wired up — see REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS in Phase8_ReplyTracker.gs.'
  ].join('\n');
}

/** Same numbers as buildReplyMetricsReportBody_, styled — colored period
 * headings, bold counts, a green/red tint on positive/negative, per Kris's
 * ask (27/08/2026) that this read as more than a flat wall of text. */
function buildReplyMetricsReportHtml_(rows, now, tz) {
  var periods = computeReplyMetricsPeriods_(rows, now, tz);

  function bookingLineHtml_(bookingStats) {
    if (!bookingStats) {
      return 'Booked themselves / booked to QC by a rep: n/a (booking tracker tab(s) not configured yet)';
    }
    if (!bookingStats.repliedLeadCount) {
      return 'Booked themselves / booked to QC by a rep: n/a (no leads replied in this period)';
    }
    return 'Booked <strong>' + (bookingStats.pctBookedThemselves * 100).toFixed(0) + '%</strong> themselves / ' +
      '<strong>' + (bookingStats.pctBookedToQCByRep * 100).toFixed(0) + '%</strong> booked to QC by a rep ' +
      '(of ' + bookingStats.repliedLeadCount + ' lead(s) who replied this period)';
  }

  function block(label, stats, avgOverDays) {
    var pct = stats.pctNegativeTurnedPositive;
    var counts = avgOverDays
      ? '<strong>' + (stats.count / avgOverDays).toFixed(1) + '</strong> reply(ies)/day avg — ' +
        '<strong style="color:#0a7d2c;">' + (stats.positive / avgOverDays).toFixed(1) + ' positive/day avg</strong>, ' +
        '<strong style="color:#c0392b;">' + (stats.negative / avgOverDays).toFixed(1) + ' negative/day avg</strong>'
      : '<strong>' + stats.count + '</strong> reply(ies) — ' +
        '<strong style="color:#0a7d2c;">' + stats.positive + ' positive</strong>, ' +
        '<strong style="color:#c0392b;">' + stats.negative + ' negative</strong>';
    return (
      '<p style="margin:0 0 4px 0;"><strong style="color:#1a56db;font-size:15px;">' + escapeHtml_(label) + '</strong></p>' +
      '<p style="margin:0 0 4px 0;">' + counts +
      (pct !== null ? ', <strong>' + (pct * 100).toFixed(0) + '%</strong> of negative leads later turned positive' : '') +
      '</p>' +
      '<p style="margin:0 0 16px 0;color:#555;font-size:13px;">' + bookingLineHtml_(stats.bookingStats) + '</p>'
    );
  }

  /** <ul><li>Subject — lead — reasoning</li>...</ul> for one sentiment, sorted newest first. */
  function replyListHtml_(rows, sentiment) {
    var matches = rows.filter(function (r) { return r.sentiment === sentiment; })
      .sort(function (a, b) { return b.date - a.date; });
    if (!matches.length) {
      return '<p style="margin:0 0 12px 0;color:#777;font-size:13px;">(none)</p>';
    }
    return '<ul style="margin:0 0 12px 0;padding-left:18px;font-size:13px;">' +
      matches.map(function (r) {
        return '<li style="margin-bottom:4px;"><strong>' + escapeHtml_(r.subject || '(no subject)') + '</strong> — ' +
          escapeHtml_(r.leadEmail || '(lead email not extracted)') + '<br><span style="color:#555;">' +
          escapeHtml_(r.reasoning || '') + '</span></li>';
      }).join('') +
      '</ul>';
  }

  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    '<p style="font-size:16px;"><strong>Sales Review — Daily Tracker</strong> — ' +
    escapeHtml_(Utilities.formatDate(now, tz, 'dd/MM/yy')) + '</p>' +
    block('Today', periods.day) +
    '<p style="margin:0 0 2px 0;"><strong style="color:#0a7d2c;">Today — positive</strong></p>' +
    replyListHtml_(periods.day.rows, 'positive') +
    '<p style="margin:0 0 2px 0;"><strong style="color:#c0392b;">Today — negative</strong></p>' +
    replyListHtml_(periods.day.rows, 'negative') +
    // Real bug (29/08/2026): this used to label a raw rolling TOTAL as an
    // "average" — stats.count is a sum over the window, never divided by
    // days. Now actually averaged per day, as the label says.
    block('Rolling 7-day average', periods.week, 7) +
    block('Rolling 30-day average', periods.month, 30) +
    (periods.bookingOutcomes ? '' :
      '<p style="color:#666;font-size:12px;">NOTE: booking percentages are not yet wired up — see ' +
      'REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS in Phase8_ReplyTracker.gs.</p>') +
    '</div>'
  );
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

  // Kris's ask (30/08/2026), same as runDailyComplianceCheck_ (Phase1_ComplianceCheck.gs):
  // weekday-only. classifyNewReplies() (the 4-hourly classification pass) keeps
  // running every day so Monday's rolling stats stay accurate — only the digest
  // EMAIL is Mon-Fri. Checked in business timezone, same convention as every
  // other weekday/business-day check in this codebase.
  var todayName = Utilities.formatDate(new Date(), CONFIG.BUSINESS_TIMEZONE, 'EEE');
  if (todayName === 'Sat' || todayName === 'Sun') {
    log_('sendReplyMetricsReport_: ' + todayName + ' — weekday-only report (Mon-Fri), skipping.');
    return;
  }

  if (!REPLY_TRACKER_CONFIG.ENABLED) { log_('REPLY_TRACKER_CONFIG.ENABLED is false — skipping send.'); return; }
  var sheet = getOrCreateReplyTrackerSheet_();
  var rows = loadAllLoggedReplies_(sheet);
  var now = new Date();
  var body = buildReplyMetricsReportBody_(rows, now, CONFIG.BUSINESS_TIMEZONE);
  var htmlBody = buildReplyMetricsReportHtml_(rows, now, CONFIG.BUSINESS_TIMEZONE);
  // Joana cc'd (Kris's ask, 29/08/2026) so she can confirm today's positive/negative
  // classifications look right against her own read of the actual replies.
  var sent = guardedSend_(CONFIG.KRIS_EMAIL, 'Sales Review - Daily Tracker', body,
    { cc: CONFIG.TOMAS_EMAIL + ',' + CONFIG.JOANA_EMAIL, htmlBody: htmlBody, name: 'Reply Tracker Bot' }, 3);
  if (!sent) { log_('SEND FAILED/SKIPPED (quota-short or invalid config) — daily reply tracker report not delivered.'); return; }
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
