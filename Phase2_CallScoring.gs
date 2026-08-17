/**
 * Phase2_CallScoring.gs
 *
 * Call Tracker Compliance — Phase 2: Kimi judgment pass (lead-quality verdict +
 * call-quality score + the two failure-mode flags), written into the same
 * "Sales Call Log" tab Phase 1 already reads/writes.
 *
 * Companion to Phase2_CallGradingSOP.md (rubric/decision rules/output contract
 * — read that first) and brief.txt Section 4 (prompt design) / Section 5
 * (prioritization). This file is the implementation; if it and the SOP ever
 * disagree, the SOP is source of truth for the rubric and this file should be
 * updated to match.
 *
 * Lives in the same Apps Script project as Phase1_ComplianceCheck.gs and
 * reuses its globals directly (CONFIG, log_, guardedSend_, SALES_CALL_LOG_*,
 * resolveSheet_, findColumn_, normalize_) — Apps Script concatenates all .gs
 * files in a project into one scope, so there is no import to wire up.
 *
 * IMPORTANT — model name mismatch to resolve before relying on this:
 * litellm-config.yaml routes "*" to moonshot/kimi-k3. brief.txt and the SOP
 * consistently call the model "kimi-k2.6" and document a hard-won bug against
 * IT specifically (temperature must be exactly 1, or every call fails
 * silently while reporting "complete" — see Build Status v4 doc). Confirm
 * which model is actually behind the LiteLLM proxy before trusting that
 * constraint carries over unchanged; if it's really kimi-k3, re-verify the
 * temperature behavior against Moonshot's current docs rather than assuming.
 *
 * Two entry points:
 *  - scoreNewlyLoggedCalls_()   Ongoing pipeline: scores "Sales Call Log" rows
 *                                that Phase 1 exact-matched to a calendar
 *                                event (Match Method = exact_key) and that
 *                                haven't been scored yet. Intended to run on
 *                                its own trigger (installPhase2Trigger()).
 *  - scoreLegacyTranscriptFolder(repName, folderId)
 *                                One-off backfill: scores a Drive folder of
 *                                already-recorded transcripts that predate the
 *                                Calendar-Event-ID-in-title convention (no
 *                                exact key available — matched by filename
 *                                date + prospect name instead, per brief.txt
 *                                §6's own "legacy recordings" residual-risk
 *                                case). scoreBensLegacyTranscripts() is the
 *                                zero-argument convenience wrapper for today's
 *                                43-transcript folder so it can be run
 *                                directly from the Apps Script editor.
 */

// ---------------------------------------------------------------------------
// CONFIG — edit before running. Secrets go in Script Properties, never here.
// ---------------------------------------------------------------------------

var PHASE2_CONFIG = {
  // Set via: Project Settings → Script Properties (never hardcode a key here).
  PROXY_URL_PROPERTY: 'LITELLM_PROXY_URL', // e.g. https://<your-proxy-host>/chat/completions
  API_KEY_PROPERTY: 'LITELLM_API_KEY',     // LiteLLM virtual key (Bearer token)

  MODEL_NAME: 'moonshot/kimi-k3', // per litellm-config.yaml — see file-header note above.

  // HARD CONSTRAINT. Per the team's Build Status (v4) doc, kimi-k2.6 rejects
  // any other value and fails EVERY call silently while the run still reports
  // "complete." Do not "improve" determinism by lowering this — stability
  // comes from rubric anchoring and booleans/1-5 scores, not temperature.
  TEMPERATURE: 1,

  MAX_PARSE_RETRIES: 1, // one retry with an explicit "raw JSON only" reminder, then manual review.

  // Shadow mode per SOP §7: score and log, but never email Kris. Flip to
  // false only after the ≥80%-agreement benchmark is hit by hand-checking
  // against Kris's own review decisions.
  SHADOW_MODE: true,

  // Drive folders of already-recorded transcripts that predate the Calendar-
  // Event-ID-in-title convention (Phase 0). Filled in as reps set these up —
  // see the "create a folder" email sent 17/08/2026.
  LEGACY_FOLDERS: {
    Bens: '1vA5F39fGZ3kUrXwMNV9TTQf3Iho_ipdg'
    // Joana: '<folder id once she replies>',
  },

  // Filename convention for legacy transcripts: YYYY-MM-DD_ProspectName_Transcript.txt
  LEGACY_FILENAME_RE: /^(\d{4})-(\d{2})-(\d{2})_(.+?)_Transcript\.txt$/i,

  // Best-effort default when a legacy filename gives no way to tell QC vs
  // Sales Call vs Discovery apart. Logged loudly per row so a human can
  // correct it in the sheet rather than trusting a silent guess.
  LEGACY_DEFAULT_CALL_TYPE: 'QC'
};

// ---------------------------------------------------------------------------
// Kimi judgment call — the model wrapper (brief §1: "model-agnostic ... only
// the endpoint/model id and the temperature rule change").
// ---------------------------------------------------------------------------

function getScriptSecret_(propName) {
  var v = PropertiesService.getScriptProperties().getProperty(propName);
  if (!v) throw new Error('Missing Script Property "' + propName + '" — set it under Project Settings before scoring.');
  return v;
}

/**
 * Strip markdown code fences (```json ... ``` or ``` ... ```) and any stray
 * leading/trailing text around the JSON object, then parse. Per SOP §5 /
 * brief §6: at forced temperature=1, expect this even though the prompt asks
 * for raw JSON. Throws on failure — caller decides retry vs manual review.
 */
function stripFencesAndParseJson_(raw) {
  var s = String(raw || '').trim();
  var fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) s = fenced[1].trim();
  var start = s.indexOf('{');
  var end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object found in model output.');
  }
  return JSON.parse(s.slice(start, end + 1));
}

/** Minimal shape check — never trust a parsed object blindly onto a sheet row. */
function isValidJudgeSchema_(obj) {
  return !!(obj &&
    obj.lead_quality && typeof obj.lead_quality.verdict === 'string' &&
    typeof obj.call_quality_score === 'number' &&
    obj.flags && typeof obj.flags.asked_for_close === 'boolean' &&
    typeof obj.flags.objections_uncovered === 'boolean' &&
    typeof obj.flags.objections_overcome === 'boolean' &&
    typeof obj.manual_review_recommended === 'boolean' &&
    typeof obj.severity === 'number');
}

/**
 * One raw call to the LiteLLM proxy. Returns the assistant message content
 * (a string, expected to be JSON — possibly fenced). Throws on transport/HTTP
 * failure; JSON validity is the caller's problem (stripFencesAndParseJson_).
 */
function callKimiJudge_(systemPrompt, userPrompt) {
  var url = getScriptSecret_(PHASE2_CONFIG.PROXY_URL_PROPERTY);
  var key = getScriptSecret_(PHASE2_CONFIG.API_KEY_PROPERTY);

  var payload = {
    model: PHASE2_CONFIG.MODEL_NAME,
    temperature: PHASE2_CONFIG.TEMPERATURE, // must stay 1 — see file header.
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };

  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('LiteLLM proxy HTTP ' + code + ': ' + resp.getContentText().slice(0, 500));
  }
  var body = JSON.parse(resp.getContentText());
  var content = body && body.choices && body.choices[0] && body.choices[0].message &&
    body.choices[0].message.content;
  if (!content) throw new Error('LiteLLM response had no choices[0].message.content.');
  return content;
}

/**
 * Rubric prose injected into the system prompt. Kept in sync with
 * Phase2_CallGradingSOP.md §3 — if you edit the rubric, edit both places.
 *
 * Few-shot anchors are intentionally empty. Per SOP §9 they must come from
 * real graded transcripts (a clear close-ask, a clear miss, a borderline
 * case), not invented examples — populate FEW_SHOT_ANCHORS once the first
 * batch of Kris-reviewed calls exists.
 */
var FEW_SHOT_ANCHORS = []; // TODO(Kris/Tomás): 2-3 labeled excerpts once real graded calls exist.

function buildJudgeSystemPrompt_() {
  var fewShot = FEW_SHOT_ANCHORS.length
    ? '\n\nLabeled examples:\n' + FEW_SHOT_ANCHORS.map(function (ex, i) {
      return '(' + (i + 1) + ') ' + ex;
    }).join('\n')
    : '';

  return [
    'You are a sales-call QA evaluator for a podcast-production offer sold to real estate agents.',
    '',
    'Make exactly two judgment calls, in order:',
    '',
    '1) Lead quality verdict — should this call have been booked at all?',
    '   good_to_book | should_screen_out.',
    '',
    '2) Call quality score (1-5) and two failure-mode flags — regardless of the lead',
    '   verdict, still score the call (a should_screen_out verdict is recorded separately',
    '   and downstream logic will decide how much weight the score carries; do not omit fields).',
    '',
    '   Failure mode 1 — never asked for the close. Decision rule: did the rep make an',
    '   explicit request for commitment (an Order or Advance in SPIN\'s taxonomy, e.g.',
    '   "Shall we move forward with this?"), not merely a trial close (asking for an',
    '   opinion, "How does that sound?")? A trial-close-only call fails this flag even if',
    '   the rest of the call went well.',
    '',
    '   Failure mode 2 — objections not uncovered or not overcome. Decision rule: did the',
    '   rep proactively surface objections (value: "too expensive" / capability: "not sure',
    '   it does X") rather than let them go unspoken, and when raised, were they addressed',
    '   with something concrete (case study, reference, quantified value) rather than',
    '   brushed past?',
    '',
    '   Score anchors:',
    '   5 = close asked AND objections surfaced+resolved with concrete proof.',
    '   4 = close asked, minor objection-handling gap (surfaced but weakly resolved).',
    '   3 = one of the two failure modes present; the other executed well.',
    '   2 = both failure modes present, but lead was otherwise good-to-book.',
    '   1 = both failure modes present AND lead quality was borderline.',
    '',
    'Exactly two scored failure modes — do not invent additional scored dimensions.',
    'SPIN/Challenger/MEDDIC concepts are reasoning scaffolding for the "reasoning" field',
    'only, not separate scored fields.',
    fewShot,
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text.',
    'Put "reasoning" first in the object (evidence quoted from the transcript, per',
    'criterion), then the structured fields, in this exact shape:',
    '',
    '{',
    '  "reasoning": "string",',
    '  "lead_quality": { "verdict": "good_to_book | should_screen_out", "justification": "string" },',
    '  "call_quality_score": 1,',
    '  "flags": { "asked_for_close": true, "objections_uncovered": true, "objections_overcome": true },',
    '  "primary_failure_mode": "none | no_close_ask | objections_missed | both",',
    '  "manual_review_recommended": true,',
    '  "severity": 1,',
    '  "feedback_summary": "string — 2-3 sentences, coaching-ready"',
    '}'
  ].join('\n');
}

function buildJudgeUserPrompt_(ctx) {
  return [
    'Rep: ' + ctx.rep,
    'Prospect: ' + ctx.prospectName,
    'Call type: ' + ctx.callType,
    'Source: ' + (ctx.source || 'unknown'),
    'Call date: ' + ctx.callDate,
    '',
    'Transcript:',
    ctx.transcriptText
  ].join('\n');
}

/**
 * Score one transcript. Always returns a full schema-shaped object — on a
 * second parse failure it returns a manual-review sentinel rather than
 * throwing, per SOP §5 ("never silently drop a row").
 */
function scoreTranscript_(ctx) {
  var systemPrompt = buildJudgeSystemPrompt_();
  var userPrompt = buildJudgeUserPrompt_(ctx);
  var lastRaw = null;

  for (var attempt = 0; attempt <= PHASE2_CONFIG.MAX_PARSE_RETRIES; attempt++) {
    var promptForThisAttempt = attempt === 0
      ? userPrompt
      : userPrompt + '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    try {
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt);
      var parsed = stripFencesAndParseJson_(lastRaw);
      if (!isValidJudgeSchema_(parsed)) throw new Error('Parsed JSON missing required fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ scoreTranscript_ attempt ' + (attempt + 1) + ' failed for ' + ctx.prospectName + ': ' + e);
    }
  }

  log_('    ↳ ROUTED TO MANUAL REVIEW (parse failed twice) — ' + ctx.prospectName +
    '. Raw model output: ' + String(lastRaw).slice(0, 1000));
  return {
    reasoning: 'JSON parse failed twice — see Apps Script log for raw model output.',
    lead_quality: { verdict: 'good_to_book', justification: 'Unscored — parse failure.' },
    call_quality_score: 1,
    flags: { asked_for_close: false, objections_uncovered: false, objections_overcome: false },
    primary_failure_mode: 'none',
    manual_review_recommended: true,
    severity: 5,
    feedback_summary: 'Automated scoring failed twice to return parseable JSON; needs manual review.',
    _parseFailed: true
  };
}

// ---------------------------------------------------------------------------
// Ongoing pipeline: score newly-logged, exact-matched calls.
// ---------------------------------------------------------------------------

/**
 * Scores "Sales Call Log" rows where Phase 1 already wrote Match Method =
 * exact_key (a real Calendar Event ID join) and Outcome Logged is TRUE, but
 * Lead Quality Verdict is still blank (not yet scored). Intended to run on
 * its own trigger, after the daily compliance check.
 */
function scoreNewlyLoggedCalls_() {
  RUN_TAG = 'scoreNewlyLoggedCalls_';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { log_('No data rows.'); return; }

  var header = sheet.getRange(1, 1, 1, SALES_CALL_LOG_HEADERS.length).getValues()[0];
  var col = {};
  SALES_CALL_LOG_HEADERS.forEach(function (h, i) { col[h] = i + 1; });

  var values = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();
  var scored = 0, skipped = 0;

  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var rowIndex = r + 2;
    var outcomeLogged = row[col['Outcome Logged'] - 1];
    var matchMethod = row[col['Match Method'] - 1];
    var leadVerdict = row[col['Lead Quality Verdict'] - 1];
    var prospectName = row[col['Prospect Name'] - 1];

    if (!outcomeLogged || matchMethod !== 'exact_key' || String(leadVerdict || '').trim() !== '') {
      skipped++;
      continue;
    }
    if (!prospectName) { skipped++; continue; }

    var transcriptUrl = row[col['Transcript URL'] - 1];
    if (!transcriptUrl) {
      log_('  Row ' + rowIndex + ' (' + prospectName + '): exact_key match but no Transcript URL yet — skipping.');
      skipped++;
      continue;
    }

    try {
      var fileId = extractDriveFileId_(transcriptUrl);
      var text = DriveApp.getFileById(fileId).getBlob().getDataAsString();
      var ctx = {
        rep: row[col['Rep'] - 1],
        prospectName: prospectName,
        callType: row[col['Call Type'] - 1] || 'QC',
        source: row[col['Source'] - 1],
        callDate: row[col['Call Date'] - 1],
        transcriptText: text
      };
      var result = scoreTranscript_(ctx);
      writeScoreToRow_(sheet, rowIndex, col, result, /*forceManualReview=*/false);
      scored++;
      Utilities.sleep(300);
    } catch (e) {
      log_('  Row ' + rowIndex + ' (' + prospectName + ') FAILED: ' + e);
      skipped++;
    }
  }

  log_('scoreNewlyLoggedCalls_ done — scored ' + scored + ', skipped ' + skipped + '.');
  if (!PHASE2_CONFIG.SHADOW_MODE && scored > 0) {
    log_('SHADOW_MODE is false — go-live queue email is a separate function (not yet built here); see brief.txt §5.');
  }
}

function extractDriveFileId_(url) {
  var m = String(url).match(/[-\w]{25,}/);
  if (!m) throw new Error('Could not extract a Drive file ID from "' + url + '"');
  return m[0];
}

/** Write scored fields onto an existing "Sales Call Log" row. */
function writeScoreToRow_(sheet, rowIndex, col, result, forceManualReview) {
  var objectionsHandled = result.flags.objections_uncovered && result.flags.objections_overcome;
  var manualReview = forceManualReview || result.manual_review_recommended;

  sheet.getRange(rowIndex, col['Lead Quality Verdict']).setValue(result.lead_quality.verdict);
  sheet.getRange(rowIndex, col['Call Quality Score']).setValue(result.call_quality_score);
  sheet.getRange(rowIndex, col['Flag: Asked For Close']).setValue(result.flags.asked_for_close);
  sheet.getRange(rowIndex, col['Flag: Objections Handled']).setValue(objectionsHandled);
  sheet.getRange(rowIndex, col['Manual Review Recommended']).setValue(manualReview);
  sheet.getRange(rowIndex, col['Severity']).setValue(result.severity);
  sheet.getRange(rowIndex, col['AI Feedback Summary']).setValue(result.feedback_summary);
  sheet.getRange(rowIndex, col['Queue Age']).setValue(0);
}

// ---------------------------------------------------------------------------
// One-off backfill: legacy transcript folders (no Calendar Event ID).
// ---------------------------------------------------------------------------

/** Zero-arg convenience wrapper so this can be run directly from the editor. */
function scoreBensLegacyTranscripts() {
  scoreLegacyTranscriptFolder('Bens', PHASE2_CONFIG.LEGACY_FOLDERS.Bens);
}

/**
 * Dry-run helper — logs filename→(prospect, date) parsing and whether a
 * matching "Sales Call Log" row already exists, WITHOUT calling the model or
 * writing anything. Run this first to sanity-check name/date parsing before
 * spending any API calls (mirrors Phase 1's dryRunComplianceCheck pattern).
 */
function previewLegacyTranscriptFolder(repName, folderId) {
  RUN_TAG = 'previewLegacyTranscriptFolder';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  var existing = loadExistingLegacyKeys_(sheet);

  var folder = DriveApp.getFolderById(folderId);
  var files = folder.getFiles();
  var n = 0;
  while (files.hasNext()) {
    var file = files.next();
    var parsed = parseLegacyFilename_(file.getName());
    n++;
    if (!parsed) {
      log_('  SKIP (name did not match convention): "' + file.getName() + '"');
      continue;
    }
    var key = normalize_(parsed.prospectName) + '|' + parsed.dateStr;
    log_('  "' + file.getName() + '" → ' + parsed.prospectName + ' / ' + parsed.dateStr +
      (existing[key] ? '  [already has a Sales Call Log row]' : '  [new]'));
  }
  log_('previewLegacyTranscriptFolder(' + repName + ') — ' + n + ' file(s) in folder.');
}

function previewBensLegacyTranscripts() {
  previewLegacyTranscriptFolder('Bens', PHASE2_CONFIG.LEGACY_FOLDERS.Bens);
}

function parseLegacyFilename_(name) {
  var m = name.match(PHASE2_CONFIG.LEGACY_FILENAME_RE);
  if (!m) return null;
  var dateStr = m[1] + '-' + m[2] + '-' + m[3];
  // CamelCase slug → "Camel Case" — best-effort; log the raw slug alongside it
  // so a human can fix any mis-split name (e.g. "McDonald" → "Mc Donald").
  var prospectName = m[4].replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return { dateStr: dateStr, date: new Date(m[1], m[2] - 1, m[3]), prospectName: prospectName, rawSlug: m[4] };
}

/** Map of "normalized name|YYYY-MM-DD" → true for every existing Sales Call Log row. */
function loadExistingLegacyKeys_(sheet) {
  var keys = {};
  if (!sheet) return keys;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return keys;
  var values = sheet.getRange(2, 1, lastRow - 1, 4).getValues(); // A:Name, D:Call Date
  values.forEach(function (row) {
    var name = row[0], date = row[3];
    if (!name || !date) return;
    var d = (date instanceof Date) ? Utilities.formatDate(date, CONFIG.BUSINESS_TIMEZONE, 'yyyy-MM-dd') : String(date);
    keys[normalize_(name) + '|' + d] = true;
  });
  return keys;
}

/**
 * Scores every unscored transcript in a legacy Drive folder and appends one
 * "Sales Call Log" row per call. Match Method is written as
 * 'fallback_heuristic' (never 'exact_key') because these recordings predate
 * the Calendar-Event-ID-in-title convention — per brief.txt §6 that residual-
 * risk case gets date+name matching and a mandatory manual-review flag, which
 * this function forces regardless of what the model itself recommends.
 *
 * Deterministic fields we can't recover from a filename alone (Prospect
 * Email, Source, Outcome Disposition) are left blank for a human to fill in
 * from the rep's own tracker — do not guess at business outcomes.
 */
function scoreLegacyTranscriptFolder(repName, folderId) {
  RUN_TAG = 'scoreLegacyTranscriptFolder';
  if (!folderId) { log_('No folder ID configured for ' + repName + ' — nothing to do.'); return; }

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found — run setupSalesCallLog() first.'); return; }

  var existing = loadExistingLegacyKeys_(sheet);
  var folder = DriveApp.getFolderById(folderId);
  var files = folder.getFiles();

  var scored = 0, skippedExisting = 0, skippedUnparsed = 0, failed = 0;

  while (files.hasNext()) {
    var file = files.next();
    var parsed = parseLegacyFilename_(file.getName());
    if (!parsed) {
      log_('  SKIP (name did not match convention): "' + file.getName() + '"');
      skippedUnparsed++;
      continue;
    }
    var key = normalize_(parsed.prospectName) + '|' + parsed.dateStr;
    if (existing[key]) { skippedExisting++; continue; }

    try {
      var text = file.getBlob().getDataAsString();
      var ctx = {
        rep: repName,
        prospectName: parsed.prospectName,
        callType: PHASE2_CONFIG.LEGACY_DEFAULT_CALL_TYPE,
        source: '',
        callDate: parsed.dateStr,
        transcriptText: text
      };
      var result = scoreTranscript_(ctx);
      var objectionsHandled = result.flags.objections_uncovered && result.flags.objections_overcome;

      sheet.appendRow([
        parsed.prospectName,          // Prospect Name
        '',                            // Prospect Email — fill from rep's tracker
        '',                            // Source — fill from rep's tracker
        parsed.date,                   // Call Date
        repName,                       // Rep
        PHASE2_CONFIG.LEGACY_DEFAULT_CALL_TYPE, // Call Type (best-effort guess — confirm)
        true,                           // Outcome Logged (the call happened; disposition unknown)
        '',                             // Outcome Disposition — fill from rep's tracker
        '',                             // Calendar Event ID — none (legacy, predates convention)
        '',                             // Riverside Recording ID — unknown for these transcripts
        file.getUrl(),                  // Transcript URL
        'fallback_heuristic',           // Match Method — never exact_key for legacy backfill
        result.lead_quality.verdict,    // Lead Quality Verdict
        result.call_quality_score,      // Call Quality Score
        result.flags.asked_for_close,   // Flag: Asked For Close
        objectionsHandled,              // Flag: Objections Handled
        true,                           // Manual Review Recommended — forced true for fallback_heuristic
        result.severity,                // Severity
        result.feedback_summary,        // AI Feedback Summary
        false,                          // Reviewed By Kris
        0                                // Queue Age
      ]);

      log_('  Scored "' + parsed.prospectName + '" (' + parsed.dateStr + '): ' +
        result.lead_quality.verdict + ', score ' + result.call_quality_score +
        ', severity ' + result.severity + (result._parseFailed ? ' [PARSE FAILED]' : ''));
      scored++;
      Utilities.sleep(300); // be polite to the proxy — no documented rate limit here, but batch responsibly.
    } catch (e) {
      log_('  FAILED "' + file.getName() + '": ' + e);
      failed++;
    }
  }

  log_('scoreLegacyTranscriptFolder(' + repName + ') done — scored ' + scored +
    ', already-present ' + skippedExisting + ', unparsed ' + skippedUnparsed + ', failed ' + failed + '.');
  log_('Every row above was force-flagged Manual Review Recommended = TRUE (fallback_heuristic match) ' +
    'per brief.txt §6 — Kris/Tomás should confirm the fallback name/date match before trusting a score.');
}
