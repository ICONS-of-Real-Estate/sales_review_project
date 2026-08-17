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
 * Three entry points:
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
 *  - scoreSeanTranscripts()      Sean-specific backfill using a deliberately
 *                                stricter rubric than the shared two-failure-
 *                                mode one above (Kris/Thao's explicit ask,
 *                                17/08/2026 — see the rubric section below for
 *                                why this is a separate variant rather than a
 *                                change to the shared rubric). Reads the
 *                                "<video title> — Transcript" Docs that
 *                                tools/transcribe_sean_calls.py writes next to
 *                                each source video in PHASE2_CONFIG.SEAN_FOLDERS.
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
    Bens: '1vA5F39fGZ3kUrXwMNV9TTQf3Iho_ipdg',
    // Joana doesn't have existing transcripts yet (raw Zoom recordings, same
    // situation as Sean) — tools/transcribe_joana_calls.py is ready to run
    // once her Drive folder ID(s) are known; fill in JOANA_FOLDERS in that
    // script AND this ID once the transcripts it produces land somewhere.
    // scoreJoanaLegacyTranscripts() below already no-ops safely while this
    // stays blank.
    Joana: ''
  },

  // Sean's calls: raw Zoom recordings backfilled with Gemini transcripts by
  // tools/transcribe_sean_calls.py, which writes each transcript as a
  // "<video title> — Transcript" Doc directly next to its source video —
  // there is no separate transcripts-only folder like Bens' setup.
  SEAN_FOLDERS: {
    'Sales Calls': '1gFb7YnXbnGAowAJgnLE2KNp5iKOCfnYH',
    'Qualification Calls': '15YMEMseEvUQakgDF00BtQg3QK6fiTsjX'
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

  // Shares a lock with scoreSeanTranscripts (same underlying script lock) —
  // both now run on their own trigger and both touch "Sales Call Log", so this
  // keeps the two from ever reading/writing the sheet at the same moment.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('scoreNewlyLoggedCalls_: another scoring run holds the lock, skipping this firing.');
    return;
  }

  try {
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
  } finally {
    lock.releaseLock();
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
 * Same wrapper for Joana, against the shared rubric (she is not on the
 * stricter Sean variant — same funnel/objection shape as Bens). Safely a
 * no-op (scoreLegacyTranscriptFolder logs and returns) until
 * PHASE2_CONFIG.LEGACY_FOLDERS.Joana is filled in with a real folder ID once
 * tools/transcribe_joana_calls.py has somewhere to write transcripts to.
 */
function scoreJoanaLegacyTranscripts() {
  scoreLegacyTranscriptFolder('Joana', PHASE2_CONFIG.LEGACY_FOLDERS.Joana);
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

// ---------------------------------------------------------------------------
// Sean's rubric — deliberately stricter than the shared two-failure-mode one
// above. Per Kris/Thao (17/08/2026): Sean's process is a two-step funnel (this
// call closes the money directly, OR books a second call with Tomás to close)
// — a call that does neither, with no clear reason why, is a miss the shared
// rubric doesn't surface on its own. This is a separate variant on purpose;
// the shared rubric above stays untouched for Bens/Joana per the SOP's own
// "resist adding scored dimensions" guidance — that call was already made and
// reviewed. Don't fold these extra fields back into the shared rubric without
// the same sign-off.
// ---------------------------------------------------------------------------

function buildSeanJudgeSystemPrompt_() {
  return [
    'You are a highly critical sales-call QA evaluator for a podcast-production offer sold to real estate agents.',
    'This rep\'s calls end one of two acceptable ways: he closes the sale directly, or he books a second call',
    'with Tomás to close. Neither happening, with no clear evidenced reason why, is the failure to catch.',
    '',
    'Be skeptical by default — do not give credit for a step attempted weakly or generically. Every judgment',
    'must cite specific transcript evidence, not a general impression.',
    '',
    'Answer all of the following, in this order, in your reasoning:',
    '1. Did the rep uncover the lead\'s real objections, and were they overcome with something concrete',
    '   (a case study, a number, a mechanism) rather than brushed past?',
    '2. Did the rep explicitly ask for the money / commitment — not merely a soft trial-close question?',
    '3. If no sale closed on this call, was a second call with Tomás actually booked? If not, what did the',
    '   rep fail to do or say that would have gotten it booked?',
    '4. Did the rep conduct real discovery — do they demonstrably understand this lead\'s specific business',
    '   (production volume, market, current marketing spend, team structure), not a generic read of the room?',
    '5. Did the rep capture the lead\'s actual stated goals, and explicitly connect the podcast framework back',
    '   to achieving those specific goals — not a generic pitch that would fit any lead?',
    '6. Bottom line: if the call ended with no money and no second call booked, what is the single root cause?',
    '   Be specific and causal ("never asked what her production goal was, so had nothing to tie the offer',
    '   to"), not vague ("bad fit" / "bad vibes").',
    '',
    'Score anchors for call_quality_score (1-5):',
    '5 = money closed OR second call booked, with strong discovery, goal-alignment, and objection handling.',
    '4 = second call booked, but one of discovery / goal-alignment / objection-handling was weak.',
    '3 = second call booked mainly because the lead pushed for it, not because the rep earned it; or a close',
    '    was attempted but discovery/goal-alignment was clearly missing.',
    '2 = no sale and no second call booked, lead was a reasonable fit, and the miss is attributable to rep',
    '    execution (not lead quality).',
    '1 = no sale, no second call booked, AND no real attempt at discovery, goal-alignment, or a close ask.',
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text.',
    'Put "reasoning" first (walk through all 6 questions above with quoted evidence), then the structured',
    'fields, in this exact shape:',
    '',
    '{',
    '  "reasoning": "string",',
    '  "lead_quality": { "verdict": "good_to_book | should_screen_out", "justification": "string" },',
    '  "call_quality_score": 1,',
    '  "flags": {',
    '    "asked_for_close": true,',
    '    "objections_uncovered": true,',
    '    "objections_overcome": true,',
    '    "discovery_adequate": true,',
    '    "understood_leads_business": true,',
    '    "captured_leads_goals": true,',
    '    "tied_framework_to_goals": true,',
    '    "booked_second_call_with_tomas": true',
    '  },',
    '  "primary_failure_mode": "none | no_close_ask | objections_missed | weak_discovery | no_goal_alignment | no_second_call_booked | multiple",',
    '  "root_cause_if_no_sale": "string — the single specific reason money wasn\'t closed and no second call',
    '   was booked; \\"N/A\\" if a sale closed or a second call was booked",',
    '  "manual_review_recommended": true,',
    '  "severity": 1,',
    '  "feedback_summary": "string — 4-6 sentences, coaching-ready, must explicitly cover: objection',
    '   handling, whether he asked for the money, why a second call with Tomás was/wasn\'t booked, discovery',
    '   quality, goal-alignment, and the root cause if nothing closed"',
    '}'
  ].join('\n');
}

function isValidSeanJudgeSchema_(obj) {
  return !!(obj &&
    obj.lead_quality && typeof obj.lead_quality.verdict === 'string' &&
    typeof obj.call_quality_score === 'number' &&
    obj.flags &&
    typeof obj.flags.asked_for_close === 'boolean' &&
    typeof obj.flags.objections_uncovered === 'boolean' &&
    typeof obj.flags.objections_overcome === 'boolean' &&
    typeof obj.flags.discovery_adequate === 'boolean' &&
    typeof obj.flags.understood_leads_business === 'boolean' &&
    typeof obj.flags.captured_leads_goals === 'boolean' &&
    typeof obj.flags.tied_framework_to_goals === 'boolean' &&
    typeof obj.flags.booked_second_call_with_tomas === 'boolean' &&
    typeof obj.manual_review_recommended === 'boolean' &&
    typeof obj.severity === 'number' &&
    typeof obj.root_cause_if_no_sale === 'string');
}

/** Same retry/manual-review shape as scoreTranscript_, against the stricter Sean rubric. */
function scoreSeanTranscript_(ctx) {
  var systemPrompt = buildSeanJudgeSystemPrompt_();
  var userPrompt = buildJudgeUserPrompt_(ctx);
  var lastRaw = null;

  for (var attempt = 0; attempt <= PHASE2_CONFIG.MAX_PARSE_RETRIES; attempt++) {
    var promptForThisAttempt = attempt === 0
      ? userPrompt
      : userPrompt + '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    try {
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt);
      var parsed = stripFencesAndParseJson_(lastRaw);
      if (!isValidSeanJudgeSchema_(parsed)) throw new Error('Parsed JSON missing required Sean-rubric fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ scoreSeanTranscript_ attempt ' + (attempt + 1) + ' failed for ' + ctx.prospectName + ': ' + e);
    }
  }

  log_('    ↳ ROUTED TO MANUAL REVIEW (parse failed twice) — ' + ctx.prospectName +
    '. Raw model output: ' + String(lastRaw).slice(0, 1000));
  return {
    reasoning: 'JSON parse failed twice — see Apps Script log for raw model output.',
    lead_quality: { verdict: 'good_to_book', justification: 'Unscored — parse failure.' },
    call_quality_score: 1,
    flags: {
      asked_for_close: false, objections_uncovered: false, objections_overcome: false,
      discovery_adequate: false, understood_leads_business: false,
      captured_leads_goals: false, tied_framework_to_goals: false,
      booked_second_call_with_tomas: false
    },
    primary_failure_mode: 'none',
    root_cause_if_no_sale: 'Unscored — parse failure.',
    manual_review_recommended: true,
    severity: 5,
    feedback_summary: 'Automated scoring failed twice to return parseable JSON; needs manual review.',
    _parseFailed: true
  };
}

/** Packs the extra Sean-only dimensions into the one free-text column the sheet has (AI Feedback Summary) — no schema migration needed to see them. */
function buildSeanFeedbackSummary_(result) {
  return [
    result.feedback_summary,
    '',
    'Discovery adequate: ' + result.flags.discovery_adequate +
      ' | Understood lead\'s business: ' + result.flags.understood_leads_business,
    'Captured lead\'s goals: ' + result.flags.captured_leads_goals +
      ' | Tied framework to goals: ' + result.flags.tied_framework_to_goals,
    'Booked 2nd call w/ Tomás: ' + result.flags.booked_second_call_with_tomas,
    'Root cause if no sale: ' + result.root_cause_if_no_sale
  ].join('\n');
}

/**
 * Dry-run helper — mirrors previewLegacyTranscriptFolder but for Sean's
 * "<video title> — Transcript" Docs (no fixed filename convention to parse;
 * the video's own Drive creation date stands in for Call Date, which is far
 * more reliable than regexing a date out of titles like "8/14  Nicole
 * Beauchamp Part 2"). Logs what would be scored, calls no model, writes nothing.
 */
function previewSeanTranscripts() {
  RUN_TAG = 'previewSeanTranscripts';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  var existing = loadExistingLegacyKeys_(sheet);
  var n = 0;

  Object.keys(PHASE2_CONFIG.SEAN_FOLDERS).forEach(function (label) {
    var folder = DriveApp.getFolderById(PHASE2_CONFIG.SEAN_FOLDERS[label]);
    var files = folder.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      var name = file.getName();
      if (name.indexOf('Transcript') === -1) continue; // skip source videos, only match transcript docs
      var prospectName = name.replace(/[—-]?\s*Transcript\s*$/i, '').trim();
      var dateStr = Utilities.formatDate(file.getDateCreated(), CONFIG.BUSINESS_TIMEZONE, 'yyyy-MM-dd');
      var key = normalize_(prospectName) + '|' + dateStr;
      n++;
      log_('  [' + label + '] "' + name + '" → ' + prospectName + ' / ' + dateStr +
        (existing[key] ? '  [already has a Sales Call Log row]' : '  [new]'));
    }
  });
  log_('previewSeanTranscripts — ' + n + ' transcript doc(s) found across both folders.');
}

/**
 * Scores every unscored "<video title> — Transcript" Doc across
 * PHASE2_CONFIG.SEAN_FOLDERS against the stricter Sean rubric and appends one
 * "Sales Call Log" row per call — same appendRow shape and same
 * fallback_heuristic / forced-manual-review policy as scoreLegacyTranscriptFolder,
 * since these also predate the Calendar-Event-ID-in-title convention.
 */
function scoreSeanTranscripts() {
  RUN_TAG = 'scoreSeanTranscripts';

  // Now runs on a 4-hour trigger (installSeanScoringAutomation) as well as by
  // hand, and existing[] is a snapshot taken once at the top — two overlapping
  // runs would both see the same "not yet scored" state and could append the
  // same transcript twice. Script-wide lock (shared with scoreNewlyLoggedCalls_,
  // which writes to the same sheet) makes overlapping runs skip instead of race.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('scoreSeanTranscripts: another scoring run holds the lock, skipping this firing.');
    return;
  }

  try {
    var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
    var sheet = resolveSheet_(ss, 'Sales Call Log');
    if (!sheet) { log_('No Sales Call Log tab found — run setupSalesCallLog() first.'); return; }

    var existing = loadExistingLegacyKeys_(sheet);
    var scored = 0, skippedExisting = 0, failed = 0;

    Object.keys(PHASE2_CONFIG.SEAN_FOLDERS).forEach(function (label) {
      var folder = DriveApp.getFolderById(PHASE2_CONFIG.SEAN_FOLDERS[label]);
      var files = folder.getFiles();
      while (files.hasNext()) {
        var file = files.next();
        var name = file.getName();
        if (name.indexOf('Transcript') === -1) continue; // skip source videos

        var prospectName = name.replace(/[—-]?\s*Transcript\s*$/i, '').trim();
        var callDate = file.getDateCreated();
        var dateStr = Utilities.formatDate(callDate, CONFIG.BUSINESS_TIMEZONE, 'yyyy-MM-dd');
        var key = normalize_(prospectName) + '|' + dateStr;
        if (existing[key]) { skippedExisting++; continue; }

        try {
          var callType = label === 'Qualification Calls' ? 'QC' : 'Sales Call';
          var ctx = {
            rep: 'Sean',
            prospectName: prospectName,
            callType: callType,
            source: '',
            callDate: dateStr,
            transcriptText: file.getBlob().getDataAsString()
          };
          var result = scoreSeanTranscript_(ctx);
          var objectionsHandled = result.flags.objections_uncovered && result.flags.objections_overcome;

          sheet.appendRow([
            prospectName,                   // Prospect Name
            '',                              // Prospect Email — fill from Sean's tracker
            '',                              // Source — fill from Sean's tracker
            callDate,                        // Call Date
            'Sean',                          // Rep
            callType,                        // Call Type
            true,                            // Outcome Logged
            '',                              // Outcome Disposition — fill from Sean's tracker
            '',                              // Calendar Event ID — none (predates convention)
            '',                              // Riverside Recording ID — n/a, Sean uses Zoom
            file.getUrl(),                   // Transcript URL
            'fallback_heuristic',            // Match Method
            result.lead_quality.verdict,     // Lead Quality Verdict
            result.call_quality_score,       // Call Quality Score
            result.flags.asked_for_close,    // Flag: Asked For Close
            objectionsHandled,               // Flag: Objections Handled
            true,                            // Manual Review Recommended — forced true
            result.severity,                 // Severity
            buildSeanFeedbackSummary_(result), // AI Feedback Summary — includes the extra Sean dimensions
            false,                           // Reviewed By Kris
            0                                // Queue Age
          ]);

          // existing[] would go stale for the rest of THIS run's own folder
          // loop too (e.g. Part 1 / Part 2 of the same call landing in the
          // same pass) if we didn't mark it locally the moment it's scored.
          existing[key] = true;

          log_('  Scored "' + prospectName + '" (' + dateStr + '): ' + result.lead_quality.verdict +
            ', score ' + result.call_quality_score + ', severity ' + result.severity +
            ', 2nd call booked: ' + result.flags.booked_second_call_with_tomas +
            (result._parseFailed ? ' [PARSE FAILED]' : ''));
          scored++;
          Utilities.sleep(300);
        } catch (e) {
          log_('  FAILED "' + name + '": ' + e);
          failed++;
        }
      }
    });

    log_('scoreSeanTranscripts done — scored ' + scored + ', already-present ' + skippedExisting +
      ', failed ' + failed + '.');
    log_('Every row above was force-flagged Manual Review Recommended = TRUE (fallback_heuristic match) — ' +
      'Kris/Tomás should confirm before trusting a score, same policy as the Bens backfill.');
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Trigger installers — both scoreNewlyLoggedCalls_() and scoreSeanTranscripts()
// are idempotent (each has its own skip-if-already-scored check), so it's safe
// to run either on a recurring schedule instead of by hand. Same idempotent-
// install pattern as Phase1_ComplianceCheck.gs's installDailyTriggerCore_():
// delete any existing copy of the trigger first, then create a fresh one, so
// re-running the installer never doubles up firings.
// ---------------------------------------------------------------------------

/**
 * Shared by both installers below: delete any existing copy of a trigger for
 * the given handler, then create a fresh every-N-hours one. Centralizes the
 * pattern instead of copy-pasting it (a third copy already existed as
 * installDailyTriggerCore_'s daily/atHour variant in Phase1_ComplianceCheck.gs,
 * which has different cadence needs and is left as-is).
 */
function reinstallHourlyTrigger_(handlerFunctionName, everyNHours) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handlerFunctionName) {
      ScriptApp.deleteTrigger(t);
    }
  });
  return ScriptApp.newTrigger(handlerFunctionName)
    .timeBased()
    .everyHours(everyNHours)
    .create();
}

/**
 * Fills the gap this file's own header comment has documented since it was
 * written: scoreNewlyLoggedCalls_() was designed to "run on its own trigger
 * (installPhase2Trigger())," but that function was never actually built.
 * ONE-TIME setup — select installPhase2Trigger in the Apps Script editor's
 * function dropdown and click Run. Idempotent: safe to re-run.
 */
function installPhase2Trigger() {
  RUN_TAG = 'installPhase2Trigger';
  reinstallHourlyTrigger_('scoreNewlyLoggedCalls_', 4);
  log_('Phase 2 ongoing scoring installed: scoreNewlyLoggedCalls_() now runs every 4 hours.');
}

/**
 * Same idea for the Sean backfill: scoreSeanTranscripts() was written as a
 * one-off, manually-run backfill, but it's fully idempotent (skips any
 * transcript already scored via its existing-keys lookup), so it's safe to
 * schedule too — this lets newly-transcribed calls from
 * tools/transcribe_sean_calls.py / transcribe_sean_calls_qwen.py get scored
 * automatically as they land, instead of someone re-running it by hand.
 *
 * ONE-TIME setup — select installSeanScoringAutomation in the Apps Script
 * editor's function dropdown and click Run. Idempotent: safe to re-run.
 *
 * Once Sean's ~220-call backlog is fully transcribed and scored, consider
 * deleting this trigger (Apps Script editor → Triggers, left sidebar) rather
 * than leaving it running every 4 hours indefinitely for no new data.
 */
function installSeanScoringAutomation() {
  RUN_TAG = 'installSeanScoringAutomation';
  reinstallHourlyTrigger_('scoreSeanTranscripts', 4);
  log_('Sean auto-scoring installed: scoreSeanTranscripts() now runs every 4 hours. ' +
    'Remember to disable this trigger once the backlog is fully transcribed and scored.');
}
