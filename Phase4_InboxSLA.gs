/**
 * Phase4_InboxSLA.gs
 *
 * Kris's ask (18/08/2026): Sean and Bens often don't get to inbox zero. Every
 * weekday at 18:00 PST, check that no email in either rep's own inbox has
 * gone more than 24 hours without a reply, and nudge whoever's behind.
 *
 * Why this needed a new access pattern (unlike Calendar elsewhere in this
 * project): GmailApp only ever operates on the "current effective user" — the
 * account actually running the script. It has no equivalent of
 * CalendarApp.getCalendarById() for someone else's mailbox, and Gmail has no
 * lightweight "share with this account" feature the way Calendar does. Kris
 * chose the centralized option (18/08/2026): one Google Workspace service
 * account, granted domain-wide delegation by a Super Admin, impersonates Sean
 * and Bens in turn to read their inbox metadata. GmailApp can't do
 * impersonation at all, so this hand-rolls the Gmail REST API call directly:
 * sign a service-account JWT (Utilities.computeRsaSha256Signature — no
 * external library needed), exchange it for an access token scoped to one
 * rep's mailbox (the JWT's "sub" claim), then call the Gmail API with that
 * token via UrlFetchApp. Same UrlFetchApp-plus-Bearer-token shape as
 * Phase0_RiversideSync.gs's Riverside calls, just with a Google-signed
 * assertion instead of a static API key.
 *
 * Scope used is gmail.readonly — metadata only (From/Subject/date), never
 * message bodies. This can only ever read; it has no path to send, delete, or
 * modify anything in either rep's mailbox.
 *
 * ===========================================================================
 * ONE-TIME SETUP (Kris/Tomás, as Workspace Super Admin) — roughly 25 minutes
 * of clicking, plus however long domain-wide delegation takes to propagate
 * (usually minutes, Google's own docs say allow up to a few hours in rare
 * cases).
 * ===========================================================================
 *
 * 1. Google Cloud Console (console.cloud.google.com) — reuse the same project
 *    as the Gemini/transcribe key if you like, any project works:
 *      a. APIs & Services > Library > enable "Gmail API".
 *      b. APIs & Services > Credentials > Create Credentials > Service account.
 *         Any name (e.g. "inbox-sla-check"). No roles needed on the project
 *         itself — the access this needs comes entirely from step 2 below.
 *      c. Open the new service account > Keys > Add Key > Create new key >
 *         JSON. This downloads a .json file — keep it, you need two fields
 *         from it in step 3.
 *      d. Still on the service account's page, copy its "Unique ID" (a long
 *         numeric string, NOT the email address) — needed for step 2.
 *
 * 2. Google Admin Console (admin.google.com), as Super Admin:
 *      a. Security > Access and data control > API controls > Domain-wide
 *         delegation > Add new.
 *      b. Client ID: paste the numeric Unique ID from step 1d.
 *      c. OAuth scopes: https://www.googleapis.com/auth/gmail.readonly
 *      d. Authorize. This is the grant that lets the service account
 *         impersonate ANY mailbox in the domain for this one scope — it's why
 *         this step needs Super Admin and the per-rep script route doesn't.
 *
 * 3. Back in this Apps Script project — Project Settings > Script Properties
 *    — add two properties, both values coming out of the JSON file from 1c:
 *      GMAIL_SLA_SERVICE_ACCOUNT_EMAIL     = the "client_email" field
 *      GMAIL_SLA_SERVICE_ACCOUNT_PRIVATE_KEY = the "private_key" field, pasted
 *        exactly as it appears in the JSON (including the literal \n
 *        sequences and the BEGIN/END PRIVATE KEY lines) — the code below
 *        un-escapes those \n's back into real line breaks itself, so don't
 *        hand-edit the key before pasting it in.
 *
 * 4. Run previewInboxSlaCheck() from the Apps Script editor FIRST (not the
 *    trailing-underscore version — Apps Script's "Select function" dropdown
 *    hides those). It signs
 *    in as Sean, then Bens, reads their inbox metadata, and logs what it
 *    found — no email sent, nothing written anywhere. If this errors with
 *    "unauthorized_client", either the delegation grant in step 2 hasn't
 *    propagated yet (wait a bit and retry) or the Client ID/scope typed there
 *    doesn't exactly match what's requested here.
 *
 * 5. Once previewInboxSlaCheck() output looks right, flip
 *    INBOX_SLA_CONFIG.ENABLED to true and run installInboxSlaTrigger() once.
 *    That's the whole go-live — no per-rep involvement needed, matching how
 *    Kris said they'd rather run this (Super Admin + direct account access,
 *    no dependency on Sean/Bens doing their own OAuth setup).
 */

var INBOX_SLA_CONFIG = {
  // Same confirm-before-trusting-new-integration pattern as
  // HANDOFF_CONFIG.ENABLED (Phase3_HandoffBrief.gs) and RIVERSIDE_CONFIG's
  // preview-first flow (Phase0_RiversideSync.gs). False = log what would be
  // sent instead of sending it.
  ENABLED: true, // Flipped true 20/08/2026 after previewInboxSlaCheck_() ran clean on Sean/Bens post noise-filtering.

  // Joana deliberately excluded (20/08/2026, Kris's call) — she has hundreds
  // of leads to work through and this SLA nudge would just be noise on top
  // of that backlog. Add her back once that's under control.
  REPS: [
    { name: 'Sean', email: 'sean@iconsofrealestate.com' },
    { name: 'Bens', email: 'bens@iconsofrealestate.com' }
  ],

  SLA_HOURS: 24,

  // Bounds the Gmail search so a years-old dead thread doesn't get re-fetched
  // every single day forever. 30 days is generous for "email from yesterday
  // still unanswered" — anything genuinely un-replied past that is a bigger
  // problem than this daily nudge is meant to catch.
  SEARCH_WINDOW_DAYS: 30,

  // previewInboxSlaCheck_() run on Sean's real inbox (20/08/2026) surfaced
  // 108 "unanswered" threads that were almost entirely calendar RSVP mechanics
  // (Accepted:/Declined:/Invitation:/Updated invitation:/Canceled event:),
  // Google Chat/Docs/Calendar system notifications, delivery-failure bounces,
  // and marketing email (Grammarly, Alignable) — none of which are things a
  // rep actually needs to reply to. Excluded here, baked directly into the
  // Gmail search query (listInboxThreadIds_) so noisy threads never even get
  // fetched, rather than filtering them out after the fact. Re-run
  // previewInboxSlaCheck() after editing this list — if it still surfaces
  // system/marketing noise, add the sender here rather than the subject list,
  // since senders are a tighter match than subject substrings.
  // Round 2 (20/08/2026): live runs on Bens (182) and especially Joana (1,276)
  // surfaced a second wave of noise round 1 didn't catch — Joana's inbox gets
  // CC'd on the entire cold-outreach "Network" alias (both her own forwarded
  // reply threads AND every newsletter riding that same alias), plus generic
  // marketing/social/tool notifications neither rep needs to personally
  // reply to. Deliberately NOT excluding "Podcast Recording: X x Y" threads
  // (still a large share of Bens' volume) — can't tell from sender/subject
  // alone whether a given one needs his reply, so left as real signal rather
  // than risk hiding something that matters.
  EXCLUDE_FROM: [
    'chat-noreply@google.com',
    'calendar-notification@google.com',
    'drive-shares-dm-noreply@google.com',
    'mailer-daemon@googlemail.com',
    'gemini-notes@google.com',
    'hello@mail.grammarly.com',
    'invitations@alignable.com',
    'support@alignable.com',
    'network@ardorseo.com',
    'claude.mgt@ardorseo.com',
    'no-reply@zoom.us',
    'billing@zoom.us',
    'no-reply@accounts.google.com',
    '@linkedin.com',
    '@facebookmail.com',
    '@mail.instagram.com',
    '@zmail.zillow.com',
    '@email.homes.com',
    '@hello.bitdefender.com',
    '@update.justeat.it',
    '@mail.apollo.io',
    'support@apollo.io',
    'notifications@turboscribe.ai',
    '@otter.ai',
    '@updates.otter.ai',
    '@email.openai.com',
    '@email.microsoft.com',
    'msa@communication.microsoft.com',
    '@e.atlassian.com',
    '@id.atlassian.com',
    'hello@kixie.com',
    'cs@kixie.com',
    '@marketing.descript.com',
    'wordpress@iconsrealestate.com',
    'newsletter@screendollars.com',
    'hello@emailmeter.com'
  ],
  // Real bug found live (26/08/2026 silent-failure audit): these used to be
  // compiled into Gmail's `-subject:"..."` search operator, which is a
  // word/phrase match, NOT a substring match — so 'Accepted:' silently
  // excluded any thread whose subject contained the word "Accepted" anywhere
  // (e.g. a real prospect reply "Re: Accepted — when can we record?" was
  // dropped before it was ever fetched, with nothing logged either
  // direction). It also meant these entries had to be truncated mid-word to
  // dodge Gmail's own phrase tokenizing around the accented characters,
  // which then couldn't match the real subject at all. These are now
  // applied as real, case-insensitive JS substring checks AFTER fetching
  // each thread's subject (see subjectLooksExcluded_ / findUnansweredThreadsForRep_)
  // — the full, untruncated phrases are safe to use again.
  EXCLUDE_SUBJECT_CONTAINS: [
    'Accepted:',
    'Declined:',
    'Invitation:',
    'Updated invitation:',
    'Canceled event:',
    'Icons 100 Booking of',
    'Appointment Confirmation of',
    'Sales Call Confirmation of',
    'New Qualification Zoom Boooked',
    'ingressou na sua Sala Pessoal de Reunião',
    'has joined your Personal Meeting Room',
    'Zoom sign-in',
    'Novo início de sessão'
  ],

  // Business time, reusing CONFIG.BUSINESS_TIMEZONE (Phase1_ComplianceCheck.gs)
  // — same "the calls/work happen in America/New_York, not wherever the
  // script project's own timezone happens to be set" reasoning.
  DAILY_TRIGGER_HOUR: 18,

  SERVICE_ACCOUNT_EMAIL_PROPERTY: 'GMAIL_SLA_SERVICE_ACCOUNT_EMAIL',
  SERVICE_ACCOUNT_PRIVATE_KEY_PROPERTY: 'GMAIL_SLA_SERVICE_ACCOUNT_PRIVATE_KEY',
  GMAIL_SCOPE: 'https://www.googleapis.com/auth/gmail.readonly',
  TOKEN_URL: 'https://oauth2.googleapis.com/token',
  GMAIL_API_BASE: 'https://gmail.googleapis.com/gmail/v1/users/me'
};

// ---------------------------------------------------------------------------
// Service-account auth — hand-rolled because GmailApp has no impersonation
// path. Same getScriptSecret_ helper as Phase2_CallScoring.gs/Phase0_RiversideSync.gs.
// ---------------------------------------------------------------------------

function getGmailServiceAccountCreds_() {
  return {
    email: getScriptSecret_(INBOX_SLA_CONFIG.SERVICE_ACCOUNT_EMAIL_PROPERTY),
    // The JSON keyfile's private_key field escapes real line breaks as
    // literal "\n" text; Script Properties store whatever string is pasted in
    // verbatim, so those stay literal backslash-n characters rather than
    // becoming actual newlines. computeRsaSha256Signature needs a real PEM
    // (actual line breaks), so un-escape here instead of asking whoever pastes
    // the key in to hand-edit it first.
    privateKey: getScriptSecret_(INBOX_SLA_CONFIG.SERVICE_ACCOUNT_PRIVATE_KEY_PROPERTY).replace(/\\n/g, '\n')
  };
}

function base64UrlEncodeString_(str) {
  return Utilities.base64EncodeWebSafe(str).replace(/=+$/, '');
}

function base64UrlEncodeBytes_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

/**
 * Builds a signed service-account JWT impersonating impersonateEmail via the
 * "sub" claim — this is the actual domain-wide-delegation mechanism; the
 * Admin Console grant (see file header, step 2) is what makes Google's token
 * endpoint honor a "sub" other than the service account's own identity.
 */
function buildServiceAccountJwt_(impersonateEmail) {
  var creds = getGmailServiceAccountCreds_();
  var nowSec = Math.floor(new Date().getTime() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var claims = {
    iss: creds.email,
    scope: INBOX_SLA_CONFIG.GMAIL_SCOPE,
    aud: INBOX_SLA_CONFIG.TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
    sub: impersonateEmail
  };
  var toSign = base64UrlEncodeString_(JSON.stringify(header)) + '.' + base64UrlEncodeString_(JSON.stringify(claims));
  var signatureBytes = Utilities.computeRsaSha256Signature(toSign, creds.privateKey);
  return toSign + '.' + base64UrlEncodeBytes_(signatureBytes);
}

/** Exchanges the signed JWT for a short-lived Gmail access token scoped to impersonateEmail's mailbox. */
function getGmailAccessTokenForUser_(impersonateEmail) {
  var jwt = buildServiceAccountJwt_(impersonateEmail);
  var resp = UrlFetchApp.fetch(INBOX_SLA_CONFIG.TOKEN_URL, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Gmail token exchange failed for ' + impersonateEmail + ' (HTTP ' + code + '): ' +
      resp.getContentText().slice(0, 500) +
      ' -- "unauthorized_client" usually means the domain-wide delegation grant in Admin Console ' +
      '(Security > API Controls > Domain-wide Delegation) hasn\'t propagated yet, or the Client ID/scope ' +
      'entered there doesn\'t exactly match this script\'s service account and INBOX_SLA_CONFIG.GMAIL_SCOPE.');
  }
  var body = JSON.parse(resp.getContentText());
  if (!body.access_token) {
    throw new Error('Gmail token exchange for ' + impersonateEmail + ' returned no access_token: ' +
      resp.getContentText().slice(0, 300));
  }
  return body.access_token;
}

// ---------------------------------------------------------------------------
// Gmail REST calls — read-only (gmail.readonly), metadata only.
// ---------------------------------------------------------------------------

function gmailApiGet_(accessToken, path) {
  var resp = UrlFetchApp.fetch(INBOX_SLA_CONFIG.GMAIL_API_BASE + path, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + accessToken },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Gmail API GET ' + path + ' failed (HTTP ' + code + '): ' + resp.getContentText().slice(0, 500));
  }
  return JSON.parse(resp.getContentText());
}

/**
 * Builds the Gmail search string — EXCLUDE_FROM only. EXCLUDE_SUBJECT_CONTAINS
 * is deliberately NOT compiled in here; see its config comment for why a
 * real substring check has to happen client-side instead of via Gmail's
 * `-subject:` operator.
 */
function buildInboxSlaSearchQuery_() {
  var parts = ['in:inbox', 'newer_than:' + INBOX_SLA_CONFIG.SEARCH_WINDOW_DAYS + 'd'];
  INBOX_SLA_CONFIG.EXCLUDE_FROM.forEach(function (addr) { parts.push('-from:' + addr); });
  return parts.join(' ');
}

/** Real (case-insensitive) substring check against EXCLUDE_SUBJECT_CONTAINS — see that config's comment. */
function subjectLooksExcluded_(subject) {
  var lower = String(subject || '').toLowerCase();
  return INBOX_SLA_CONFIG.EXCLUDE_SUBJECT_CONTAINS.some(function (s) { return lower.indexOf(s.toLowerCase()) !== -1; });
}

/**
 * Real bug found live (26/08/2026 silent-failure audit): fromRaw/subject
 * used to be interpolated into htmlBody unescaped. A raw From header is
 * "Name <addr@domain>" — the bracketed part parses as an unknown HTML tag
 * and is simply not rendered, so the rep's nudge email showed "from Margaret
 * Chen" with no address at all, and a subject containing "<" mangled
 * everything after it. The plain-text body was always correct; MailApp
 * renders htmlBody when present, so that's what the rep actually saw.
 */
function escapeHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function listInboxThreadIds_(accessToken) {
  var ids = [];
  var pageToken = null;
  var q = encodeURIComponent(buildInboxSlaSearchQuery_());
  do {
    var path = '/threads?q=' + q + '&maxResults=100' + (pageToken ? '&pageToken=' + pageToken : '');
    var page = gmailApiGet_(accessToken, path);
    (page.threads || []).forEach(function (t) { ids.push(t.id); });
    pageToken = page.nextPageToken || null;
  } while (pageToken);
  return ids;
}

/** Pulls the email address out of a "Name <email>" header value; falls back to the raw value if there's no angle-bracket form. */
function extractEmailAddress_(headerValue) {
  var m = String(headerValue || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(headerValue || '')).trim().toLowerCase();
}

/**
 * format=metadata (never the full message body) keeps this to header data
 * only. Returns the LAST message in the thread — whether it's from the rep
 * (answered) or an external sender (potentially overdue) is exactly what
 * findUnansweredThreadsForRep_ needs to decide.
 */
function getThreadLastMessageInfo_(accessToken, threadId) {
  var thread = gmailApiGet_(accessToken,
    '/threads/' + threadId + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject');
  var messages = thread.messages || [];
  if (!messages.length) {
    log_('  thread ' + threadId + ' returned no messages — skipped.');
    return null;
  }
  var last = messages[messages.length - 1];
  // Real bug found live (26/08/2026 silent-failure audit): header names were
  // keyed by their exact original casing ('From'/'Subject'), so a message
  // whose raw header happened to be 'FROM:'/'from:' (Gmail preserves
  // whatever casing the sender's system used) silently read as no header at
  // all. Normalize the key, not just the values.
  var headers = {};
  (last.payload && last.payload.headers || []).forEach(function (h) { headers[String(h.name).toLowerCase()] = h.value; });
  var internalDateMs = Number(last.internalDate);
  if (!isFinite(internalDateMs)) {
    log_('  thread ' + threadId + ' has a non-numeric internalDate ("' + last.internalDate + '") — skipped.');
    return null;
  }
  return {
    threadId: threadId,
    fromEmail: extractEmailAddress_(headers['from']),
    fromRaw: headers['from'] || '(unknown sender)',
    subject: headers['subject'] || '(no subject)',
    internalDateMs: internalDateMs
  };
}

/**
 * A thread counts as "unanswered" when the LAST message in it is not from the
 * rep themselves, and that message is older than SLA_HOURS. A thread where
 * the rep replied last (even if the other side hasn't come back) is not
 * flagged — that's not on the rep to chase.
 */
// Apps Script's hard execution ceiling is 6 minutes. One sequential Gmail
// API round trip per thread (no batching) means an inbox in the hundreds-to-
// low-thousands of threads (Joana's was recorded at 1,276 — see
// INBOX_SLA_CONFIG's own comment on why she isn't in CONFIG.REPS yet) can
// exceed it, and a hard timeout can't be caught, so nothing downstream gets
// a chance to log or alert. Stop and report a partial result instead of
// letting it die silently mid-run.
var INBOX_SLA_TIME_BUDGET_MS_ = 5 * 60 * 1000; // leaves a margin under the 6-minute ceiling

function findUnansweredThreadsForRep_(repCfg) {
  var accessToken = getGmailAccessTokenForUser_(repCfg.email);
  var threadIds = listInboxThreadIds_(accessToken);
  var now = new Date().getTime();
  var slaMs = INBOX_SLA_CONFIG.SLA_HOURS * 3600000;
  var unanswered = [];
  var runStart = Date.now();
  var truncated = false;

  for (var i = 0; i < threadIds.length; i++) {
    if (Date.now() - runStart > INBOX_SLA_TIME_BUDGET_MS_) {
      truncated = true;
      log_('  findUnansweredThreadsForRep_(' + repCfg.name + '): time budget hit after ' + i + '/' +
        threadIds.length + ' thread(s) — reporting a partial result rather than risking a hard timeout.');
      break;
    }
    var threadId = threadIds[i];
    // Real bug found live (26/08/2026 silent-failure audit): a single failed
    // thread fetch (a 404 from a thread the rep deleted between the list
    // call and this GET, or a transient 429/5xx) used to throw straight out
    // of this loop, discarding every thread already collected and leaving
    // the rep with NO nudge at all that evening, even when other threads
    // were genuinely over SLA.
    try {
      var info = getThreadLastMessageInfo_(accessToken, threadId);
      if (!info) continue;
      if (info.fromEmail === repCfg.email.toLowerCase()) continue; // rep sent the last message -- answered
      if (subjectLooksExcluded_(info.subject)) continue; // real substring check — see EXCLUDE_SUBJECT_CONTAINS's comment
      var ageMs = now - info.internalDateMs;
      if (ageMs > slaMs) {
        unanswered.push({
          fromRaw: info.fromRaw,
          subject: info.subject,
          hoursOld: Math.floor(ageMs / 3600000),
          threadId: info.threadId
        });
      }
    } catch (e) {
      log_('  ' + repCfg.name + ' thread ' + threadId + ' failed, skipping it: ' + e);
    }
  }

  unanswered.sort(function (a, b) { return b.hoursOld - a.hoursOld; });
  unanswered._truncated = truncated;
  return unanswered;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function isWeekendInBusinessTz_(date) {
  var day = Utilities.formatDate(date, CONFIG.BUSINESS_TIMEZONE, 'EEEE');
  return day === 'Saturday' || day === 'Sunday';
}

/** Read-only dry run: logs what each rep's overdue inbox looks like right now. Sends nothing. Run this first, per the setup steps above. */
/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function previewInboxSlaCheck() {
  return previewInboxSlaCheck_();
}

function previewInboxSlaCheck_() {
  RUN_TAG = 'previewInboxSlaCheck_';
  INBOX_SLA_CONFIG.REPS.forEach(function (repCfg) {
    try {
      var unanswered = findUnansweredThreadsForRep_(repCfg);
      log_(repCfg.name + ': ' + unanswered.length + ' inbox thread(s) over ' +
        INBOX_SLA_CONFIG.SLA_HOURS + 'h unanswered');
      unanswered.forEach(function (u) {
        log_('  ' + u.hoursOld + 'h old — from ' + u.fromRaw + ' — "' + u.subject + '"');
      });
    } catch (e) {
      log_('ERROR checking ' + repCfg.name + ': ' + e);
    }
  });
}

/**
 * Live weekday check (trigger: 18:00 business time). Skips itself on
 * Saturday/Sunday rather than needing five separate weekday triggers — same
 * simpler-single-trigger choice already used for the daily compliance check.
 */
function runInboxSlaCheck() {
  RUN_TAG = 'runInboxSlaCheck';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runInboxSlaCheck: another run holds the lock, skipping this firing.');
    return;
  }

  try {
    var now = new Date();
    if (isWeekendInBusinessTz_(now)) {
      log_('Weekend in ' + CONFIG.BUSINESS_TIMEZONE + ' -- skipping (weekday-only check).');
      return;
    }

    INBOX_SLA_CONFIG.REPS.forEach(function (repCfg) {
      try {
        var unanswered = findUnansweredThreadsForRep_(repCfg);
        if (!unanswered.length) {
          log_(repCfg.name + ': inbox clean -- nothing over ' + INBOX_SLA_CONFIG.SLA_HOURS + 'h.');
          return;
        }

        var subject = repCfg.name + ' — [Action needed] ' + unanswered.length + ' email(s) in your inbox over ' +
          INBOX_SLA_CONFIG.SLA_HOURS + 'h old';
        var lines = unanswered.map(function (u) {
          return '• ' + u.hoursOld + 'h old — from ' + u.fromRaw + ' — "' + u.subject + '"';
        });
        var htmlLines = unanswered.map(function (u) {
          return '<li>' + u.hoursOld + 'h old — from ' + escapeHtml_(u.fromRaw) + ' — &quot;' + escapeHtml_(u.subject) + '&quot;</li>';
        });
        var body =
          'Hi ' + repCfg.name + ',\n\n' +
          'These emails in your inbox have gone unanswered for more than ' + INBOX_SLA_CONFIG.SLA_HOURS +
          ' hours:\n\n' + lines.join('\n\n') + '\n\n' +
          'Please reply, or archive/label them so nothing sits past a day.\n\n' +
          '— This is an automated check reading your inbox metadata only (sender/subject/date, never ' +
          'message bodies). This email was drafted by AI and sent automatically; reply to Kris or Tomás ' +
          'with any issues.';
        var htmlBody =
          '<p>Hi ' + repCfg.name + ',</p>' +
          '<p>These emails in your inbox have gone unanswered for more than ' + INBOX_SLA_CONFIG.SLA_HOURS +
          ' hours:</p>' +
          '<ul>' + htmlLines.join('') + '</ul>' +
          '<p>Please reply, or archive/label them so nothing sits past a day.</p>' +
          '<p><i>— This is an automated check reading your inbox metadata only (sender/subject/date, never ' +
          'message bodies). This email was drafted by AI and sent automatically; reply to Kris or Tomás ' +
          'with any issues.</i></p>';

        if (!INBOX_SLA_CONFIG.ENABLED) {
          log_('  (INBOX_SLA_CONFIG.ENABLED is false -- logging instead of sending)');
          log_('  Would send to ' + repCfg.email + ': ' + subject);
          log_(body);
        } else {
          var sent = guardedSend_(repCfg.email, subject, body, {
            htmlBody: htmlBody,
            cc: CONFIG.KRIS_EMAIL + ',' + CONFIG.TOMAS_EMAIL,
            name: 'Inbox SLA Bot'
          }, 3);
          if (!sent) log_('  SEND FAILED/SKIPPED for ' + repCfg.name + ' -- no state was advanced, next run retries fresh.');
        }
        log_(repCfg.name + ': ' + unanswered.length + ' unanswered thread(s) over SLA.' +
          (unanswered._truncated ? ' (partial scan -- hit the execution time budget, see earlier log line)' : ''));
      } catch (e) {
        log_('ERROR checking ' + repCfg.name + ': ' + e);
        sendOpsAlert_('Inbox SLA check error for ' + repCfg.name,
          'Could not check ' + repCfg.name + '\'s inbox: ' + e);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * ONE-TIME setup, run manually — ONLY after previewInboxSlaCheck() has been
 * checked against real data (see file header, step 4). Installs a single
 * daily trigger; runInboxSlaCheck() itself skips weekends, so no separate
 * Mon-Fri triggers are needed.
 */
function installInboxSlaTrigger() {
  RUN_TAG = 'installInboxSlaTrigger';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runInboxSlaCheck') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runInboxSlaCheck')
    .timeBased()
    .everyDays(1)
    .atHour(INBOX_SLA_CONFIG.DAILY_TRIGGER_HOUR)
    .inTimezone(CONFIG.BUSINESS_TIMEZONE)
    .create();
  log_('Inbox SLA check installed: runInboxSlaCheck() now runs daily at ' +
    INBOX_SLA_CONFIG.DAILY_TRIGGER_HOUR + ':00 ' + CONFIG.BUSINESS_TIMEZONE +
    ' and skips itself on Saturday/Sunday. INBOX_SLA_CONFIG.ENABLED is currently ' +
    INBOX_SLA_CONFIG.ENABLED + ' — while false this only logs instead of sending.');
}
