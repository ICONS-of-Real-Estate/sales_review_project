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
 * MODEL — resolved 20/08/2026: calling Moonshot's API directly (no LiteLLM
 * proxy was ever actually deployed; litellm-config.yaml describes a server
 * that was never stood up). Confirmed via platform.kimi.ai/playground that
 * the real model id is "kimi-k3" (the "kimi-k2.6" name in brief.txt/SOP was
 * stale). PROXY_URL_PROPERTY/API_KEY_PROPERTY point straight at Moonshot's
 * own endpoint and API key now — the "LiteLLM" naming is legacy, not a sign
 * a proxy is involved. The temperature=1 hard constraint below was
 * documented against kimi-k2.6; re-verify it still applies to kimi-k3 if you
 * see silent failures.
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
 *  - scoreTomasTranscripts()     Tomás's own calls — same shared rubric as
 *                                Bens/Joana (not Sean's stricter variant),
 *                                plus a call_role classifier (own_new_lead vs
 *                                second_call_closer, since his folder mixes
 *                                both) and explicit teachable_strength/
 *                                coach_this fields — the point is coaching
 *                                material both directions (Kris, 20/08/2026),
 *                                not just a score. Reads the same
 *                                "<video title> — Transcript" Doc convention
 *                                from PHASE2_CONFIG.TOMAS_FOLDERS.
 *  - scoreJoanaTranscripts()     Joana's calls — shared rubric (not Sean's
 *                                stricter variant), same "<video title> —
 *                                Transcript" Doc convention as Sean/Tomás,
 *                                from PHASE2_CONFIG.JOANA_FOLDERS. Added
 *                                22/08/2026 — the older
 *                                scoreJoanaLegacyTranscripts()/
 *                                LEGACY_FOLDERS.Joana pair assumed a
 *                                Bens-style flat-folder filename convention
 *                                her transcripts don't actually use, so it
 *                                silently scored nothing; left in place as a
 *                                harmless no-op, this is the real entry point.
 */

// ---------------------------------------------------------------------------
// CONFIG — edit before running. Secrets go in Script Properties, never here.
// ---------------------------------------------------------------------------

var PHASE2_CONFIG = {
  // Set via: Project Settings → Script Properties (never hardcode a key here).
  // Despite the property names, this now points straight at Moonshot's own
  // API (no proxy) — see file-header note above.
  PROXY_URL_PROPERTY: 'LITELLM_PROXY_URL', // set to https://api.moonshot.ai/v1/chat/completions
  API_KEY_PROPERTY: 'LITELLM_API_KEY',     // set to your real Moonshot API key (sk-...)

  MODEL_NAME: 'kimi-k3', // confirmed against platform.kimi.ai/playground 20/08/2026 — no "moonshot/" prefix, that was LiteLLM-only routing syntax.

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

  // Tomás's own calls: raw Zoom recordings backfilled with Gemini transcripts
  // by tools/transcribe_tomas_calls.py, same "<video title> — Transcript" Doc
  // convention as Sean's folder above. Mixes two different call shapes he
  // doesn't distinguish by folder — his own first-touch calls with a new
  // lead, AND second/closing calls for leads Sean/Bens already qualified —
  // so buildTomasJudgeSystemPrompt_() below classifies call_role itself from
  // the transcript rather than trusting the folder. Per Kris (20/08/2026):
  // goal is coaching material both directions — what Tomás does well to
  // teach the other reps, and what to coach him on — not just a score.
  TOMAS_FOLDERS: {
    'Sales Calls': '1QjmKqmTQpg6yePI55L_tqtoEvIf0Lbf_',
    'Second Calls': '1ohbJInhrWg_toyrGNr39ba7VzzAojmqE' // his closing calls as the second-call closer — added 20/08/2026
  },

  // Joana's calls: raw Zoom recordings backfilled with Gemini transcripts by
  // tools/transcribe_joana_calls.py, same "<video title> — Transcript" Doc
  // convention as Sean's/Tomás's folders above — NOT the Bens-style flat
  // "legacy transcripts" folder with a YYYY-MM-DD_Name_Transcript.txt
  // filename (PHASE2_CONFIG.LEGACY_FOLDERS.Joana/scoreJoanaLegacyTranscripts()
  // predate this and would silently match nothing against her real files —
  // left in place as a harmless no-op, but scoreJoanaTranscripts() below is
  // the real entry point). Her one folder mixes QC and Sales Calls with no
  // way to tell them apart by folder alone, unlike Sean's two-folder split —
  // added 22/08/2026, added because the dashboard showed zero scored rows for
  // her despite transcripts existing.
  JOANA_FOLDERS: {
    'QC & Sales Calls': '17YaE4fBjEBFissvR-l7_GOkoTnZjdQq5'
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
// Pulled from real, Kris-reviewed calls cataloged in Objection_Handling_Playbook.md
// (first batch of 43 Bens transcripts, scored 17/08/2026) per SOP §9's requirement
// that anchors come from real graded calls, not invented ones. DRAFT — Tomás has
// not signed off on these specific three yet; confirm before treating as final.
var FEW_SHOT_ANCHORS = [
  'Clear close-ask miss — Carolyn Triebold: the rep never made a direct ask, only the soft trial-close question ' +
    '"haven\'t you thought about social media?" — when she said "not something I\'m interested in," he accepted ' +
    'it and wrapped up. asked_for_close = false here: a trial-close question is not a real ask, even though a ' +
    'question was technically asked.',
  'Clear objection-handling miss — Tennitia Wilson: she raised a real cost concern ("the costs were prohibitive... ' +
    'more than my car note and insurance put together"), and the rep\'s only response was "maybe we can offer you ' +
    'something that fits," with no actual number. objections_uncovered = true, objections_overcome = false: ' +
    'acknowledging a concern without a concrete answer does not count as resolved.',
  'Model resolution — Ben Sweet (2026-07-02): asked directly whether other clients had grown from the podcast, the ' +
    'rep answered with a specific, quantified case study (a client stuck at $10M in production for years who used ' +
    'a podcast episode to help land a 330-house land development deal). objections_overcome = true only when the ' +
    'response is this concrete — a number, a name, a mechanism — not generic reassurance.'
]; // TODO(Tomás): confirm these three are representative before this becomes the literal prompt text (SOP §9).

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
    '   verdict, still score the call (a should_screen_out verdict is recorded separately;',
    '   buildReviewQueue() excludes should_screen_out rows from rep-coaching prioritization',
    '   so the score is captured for the record without penalizing the rep; do not omit fields).',
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

/**
 * DriveApp's File.getBlob() cannot read native Google Docs/Sheets/Slides —
 * it throws, since those aren't blob-representable formats. Every
 * transcript this project reads could be either kind depending on how it
 * was uploaded: tools/transcribe_sean_calls.py's save_transcript_doc()
 * explicitly requests mimeType 'application/vnd.google-apps.document'
 * (Drive converts the uploaded text to a real Doc), while an older/simpler
 * upload path (or any transcript created by hand in Drive) stays plain
 * text. Route to DocumentApp for the former, getBlob() for everything
 * else, so a mixed folder of both kinds doesn't silently fail every Doc.
 */
function getTranscriptText_(file) {
  if (file.getMimeType() === MimeType.GOOGLE_DOCS) {
    return DocumentApp.openById(file.getId()).getBody().getText();
  }
  return file.getBlob().getDataAsString();
}

/**
 * Builds the header-name -> column-index map every function below uses to
 * read/write "Sales Call Log" by name — but checks the sheet's real header
 * row actually matches SALES_CALL_LOG_HEADERS first. Without this, a
 * manually reordered/renamed/inserted column drifts silently out of sync
 * with the hardcoded array, and every col['...'] lookup then points at the
 * wrong cell with no error — e.g. writing a Call Quality Score into what's
 * now the Severity column. Throws loudly instead.
 */
function getValidatedColumnMap_(sheet) {
  var header = sheet.getRange(1, 1, 1, SALES_CALL_LOG_HEADERS.length).getValues()[0];
  var mismatches = [];
  SALES_CALL_LOG_HEADERS.forEach(function (expected, i) {
    if (header[i] !== expected) {
      mismatches.push('column ' + (i + 1) + ': expected "' + expected + '", found "' + header[i] + '"');
    }
  });
  if (mismatches.length) {
    throw new Error('Sales Call Log header drift detected — run setupSalesCallLog() or fix the ' +
      'sheet manually before trusting any column lookup:\n  ' + mismatches.join('\n  '));
  }
  var col = {};
  SALES_CALL_LOG_HEADERS.forEach(function (h, i) { col[h] = i + 1; });
  return col;
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

    var col = getValidatedColumnMap_(sheet);

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
        var text = getTranscriptText_(DriveApp.getFileById(fileId));
        var rawCallType = row[col['Call Type'] - 1];
        if (!rawCallType) {
          log_('  Row ' + rowIndex + ' (' + prospectName + '): blank Call Type — defaulting to QC. ' +
            'Confirm/correct in the sheet; this is a guess, not a read value.');
        }
        var ctx = {
          rep: row[col['Rep'] - 1],
          prospectName: prospectName,
          callType: rawCallType || 'QC',
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
      log_('SHADOW_MODE is false — run buildReviewQueue() to pick and email today\'s 3-call sitting to Kris (see brief.txt §D).');
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
  // Phase 5 (weekly scorecard) input — blank on rows scored before this column
  // existed; those just read as "no signal" rather than breaking anything.
  sheet.getRange(rowIndex, col['Primary Failure Mode']).setValue(result.primary_failure_mode || 'none');
}

/**
 * ONE-TIME migration: appends any header(s) from SALES_CALL_LOG_HEADERS that
 * are missing from the live "Sales Call Log" sheet's header row (e.g. "Kris
 * Manual Review Verdict", "Primary Failure Mode" — both added to the shared
 * array over the course of this project without ever being backfilled onto
 * the already-deployed sheet). Needed because getValidatedColumnMap_
 * requires the sheet's real header row to exactly match SALES_CALL_LOG_HEADERS.
 * Checks every column in order (not just the last one) and appends whichever
 * are actually missing — safe to re-run, no-ops once everything is present.
 * Run this before previewWeeklyScorecards() / the next scoring pass.
 *
 * NOTE: run migrateAddPrimaryFailureModeColumn() (below), not the
 * trailing-underscore version — Apps Script's "Select function" dropdown
 * hides functions ending in "_", so only the wrapper shows up to run.
 */
/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function migrateAddPrimaryFailureModeColumn() {
  return migrateAddPrimaryFailureModeColumn_();
}

function migrateAddPrimaryFailureModeColumn_() {
  RUN_TAG = 'migrateAddPrimaryFailureModeColumn_';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }

  var existing = sheet.getRange(1, 1, 1, SALES_CALL_LOG_HEADERS.length).getValues()[0];
  var added = [];
  for (var i = 0; i < SALES_CALL_LOG_HEADERS.length; i++) {
    var expected = SALES_CALL_LOG_HEADERS[i];
    var actual = existing[i];
    if (actual === expected) continue;
    if (actual !== '' && actual !== undefined) {
      throw new Error('Column ' + (i + 1) + ' expected "' + expected + '" or blank, found "' + actual +
        '" — resolve manually before migrating.');
    }
    sheet.getRange(1, i + 1).setValue(expected).setFontWeight('bold').setBackground('#e8eef7');
    added.push(expected + ' (column ' + (i + 1) + ')');
  }

  if (!added.length) {
    log_('All ' + SALES_CALL_LOG_HEADERS.length + ' headers already present — nothing to do.');
    return;
  }
  log_('Added missing header(s): ' + added.join(', ') + '. Existing rows read as blank ' +
    '("no signal") for these until re-scored; new scoring passes will populate them going forward.');
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
      var text = getTranscriptText_(file);
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
        0,                               // Queue Age
        '',                              // Kris Manual Review Verdict — not yet judged
        result.primary_failure_mode || 'none' // Primary Failure Mode
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
            transcriptText: getTranscriptText_(file)
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
            0,                               // Queue Age
            '',                              // Kris Manual Review Verdict — not yet judged
            result.primary_failure_mode || 'none' // Primary Failure Mode
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
// Joana's calls — "<video title> — Transcript" Docs across JOANA_FOLDERS,
// same shape as Sean's folder-scan above but against the SHARED rubric
// (scoreTranscript_/buildJudgeSystemPrompt_) since she is not on Sean's
// stricter variant — same funnel/objection shape as Bens. Added 22/08/2026:
// the pre-existing scoreJoanaLegacyTranscripts()/LEGACY_FOLDERS.Joana pair
// assumed her transcripts would land in a Bens-style flat folder with a
// YYYY-MM-DD_Name_Transcript.txt filename; they actually land as
// "<video title> — Transcript" Docs next to each source video, same as
// Sean's, so that pair would silently match nothing. This is the real
// entry point.
// ---------------------------------------------------------------------------

/** Dry-run — mirrors previewSeanTranscripts. Calls no model, writes nothing. */
function previewJoanaTranscripts() {
  RUN_TAG = 'previewJoanaTranscripts';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  var existing = loadExistingLegacyKeys_(sheet);
  var n = 0;

  Object.keys(PHASE2_CONFIG.JOANA_FOLDERS).forEach(function (label) {
    var folder = DriveApp.getFolderById(PHASE2_CONFIG.JOANA_FOLDERS[label]);
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
  log_('previewJoanaTranscripts — ' + n + ' transcript doc(s) found.');
}

/**
 * Scores every unscored "<video title> — Transcript" Doc across
 * PHASE2_CONFIG.JOANA_FOLDERS against the shared rubric and appends one
 * "Sales Call Log" row per call — same appendRow shape and same
 * fallback_heuristic / forced-manual-review policy as scoreLegacyTranscriptFolder,
 * since these too predate the Calendar-Event-ID-in-title convention. Her one
 * folder mixes QC and Sales Calls with no way to tell them apart by folder
 * alone (unlike Sean's two-folder split), so Call Type falls back to
 * PHASE2_CONFIG.LEGACY_DEFAULT_CALL_TYPE — same best-effort-guess-confirm
 * policy as the Bens backfill.
 */
function scoreJoanaTranscripts() {
  RUN_TAG = 'scoreJoanaTranscripts';

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('scoreJoanaTranscripts: another scoring run holds the lock, skipping this firing.');
    return;
  }

  try {
    var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
    var sheet = resolveSheet_(ss, 'Sales Call Log');
    if (!sheet) { log_('No Sales Call Log tab found — run setupSalesCallLog() first.'); return; }

    var existing = loadExistingLegacyKeys_(sheet);
    var scored = 0, skippedExisting = 0, failed = 0;

    Object.keys(PHASE2_CONFIG.JOANA_FOLDERS).forEach(function (label) {
      var folder = DriveApp.getFolderById(PHASE2_CONFIG.JOANA_FOLDERS[label]);
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
          var ctx = {
            rep: 'Joana',
            prospectName: prospectName,
            callType: PHASE2_CONFIG.LEGACY_DEFAULT_CALL_TYPE,
            source: '',
            callDate: dateStr,
            transcriptText: getTranscriptText_(file)
          };
          var result = scoreTranscript_(ctx);
          var objectionsHandled = result.flags.objections_uncovered && result.flags.objections_overcome;

          sheet.appendRow([
            prospectName,                    // Prospect Name
            '',                               // Prospect Email — fill from Joana's tracker
            '',                               // Source — fill from Joana's tracker
            callDate,                        // Call Date
            'Joana',                          // Rep
            PHASE2_CONFIG.LEGACY_DEFAULT_CALL_TYPE, // Call Type (best-effort guess — confirm)
            true,                             // Outcome Logged
            '',                               // Outcome Disposition — fill from Joana's tracker
            '',                               // Calendar Event ID — none (predates convention)
            '',                               // Riverside Recording ID — n/a, Joana uses Zoom
            file.getUrl(),                    // Transcript URL
            'fallback_heuristic',             // Match Method
            result.lead_quality.verdict,      // Lead Quality Verdict
            result.call_quality_score,        // Call Quality Score
            result.flags.asked_for_close,     // Flag: Asked For Close
            objectionsHandled,                // Flag: Objections Handled
            true,                             // Manual Review Recommended — forced true
            result.severity,                  // Severity
            result.feedback_summary,          // AI Feedback Summary
            false,                            // Reviewed By Kris
            0,                                // Queue Age
            '',                               // Kris Manual Review Verdict — not yet judged
            result.primary_failure_mode || 'none' // Primary Failure Mode
          ]);

          existing[key] = true;

          log_('  Scored "' + prospectName + '" (' + dateStr + '): ' + result.lead_quality.verdict +
            ', score ' + result.call_quality_score + ', severity ' + result.severity +
            (result._parseFailed ? ' [PARSE FAILED]' : ''));
          scored++;
          Utilities.sleep(300);
        } catch (e) {
          log_('  FAILED "' + name + '": ' + e);
          failed++;
        }
      }
    });

    log_('scoreJoanaTranscripts done — scored ' + scored + ', already-present ' + skippedExisting +
      ', failed ' + failed + '.');
    log_('Every row above was force-flagged Manual Review Recommended = TRUE (fallback_heuristic match) — ' +
      'Kris/Tomás should confirm before trusting a score, same policy as the Bens backfill.');
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Tomás's own calls — shared rubric (per Kris/tools/transcribe_tomas_calls.py
// header note: NOT the Sean stricter variant, that one's built around Tomás
// being the second-call closer someone else booked, which doesn't describe
// his own calls). Adds a call_role classification (he does both first-touch
// AND second/closing calls, undivided by folder) plus explicit teachable-
// strength / coach-this-weakness extraction on top of the normal score, per
// Kris (20/08/2026): the point of grading Tomás is producing coaching
// material in both directions, not just a number.
// ---------------------------------------------------------------------------

function buildTomasJudgeSystemPrompt_() {
  return [
    'You are a sales-call QA evaluator for a podcast-production offer sold to real estate agents, reviewing a call',
    'run by Tomás — the team\'s most experienced closer. He takes two different kinds of calls; decide which this',
    'one is from the transcript itself (do not assume from anything outside the transcript):',
    '  own_new_lead = this is his own first-touch call with a lead nobody else has spoken to yet.',
    '  second_call_closer = a lead who already had a QC/Sales Call with another rep (Sean or Bens), now on a',
    '    follow-up/closing call with Tomás. Listen for references to an earlier call, another rep\'s name, or the',
    '    conversation picking up mid-funnel rather than starting cold.',
    '  unclear = say so rather than guessing if the transcript genuinely doesn\'t make it obvious.',
    '',
    'Score the call the same way regardless of call_role — asked for the close, objections uncovered and',
    'overcome — but weigh a second_call_closer call primarily on whether it actually closed (money or a firm',
    'commitment), since by this stage discovery/rapport is mostly already done by the first rep.',
    '',
    'Because this call is being reviewed to build training material — both "what Tomás does well that other reps',
    'should copy" and "what to coach Tomás on himself" — go beyond the score and pull out BOTH of these,',
    'independent of whether the call closed:',
    '  teachable_strength: one specific technique he used well, with a direct quote and why it worked. If nothing',
    '    genuinely stands out as exemplary, say so plainly rather than manufacturing praise.',
    '  coach_this: one specific, concrete gap in THIS call — a missed objection, a weak close attempt, a discovery',
    '    question left unasked — with a quote or specific moment. If the call was clean, say so rather than',
    '    inventing a weakness.',
    '',
    'Be skeptical by default — do not credit a step attempted weakly or generically, and do not let his seniority',
    'lower the bar. Every judgment must cite specific transcript evidence.',
    '',
    'Score anchors for call_quality_score (1-5):',
    '5 = close asked (or already closed) AND objections surfaced+resolved with concrete proof.',
    '4 = close asked, minor objection-handling gap (surfaced but weakly resolved).',
    '3 = one of asked-for-close / objections-overcome missing; the other executed well.',
    '2 = both missing, but lead was otherwise good-to-book (or, for second_call_closer, a real attempt was made',
    '    but fell short).',
    '1 = both missing AND no real attempt at discovery or a close — a call that just went through the motions.',
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text, in this exact shape:',
    '',
    '{',
    '  "reasoning": "string",',
    '  "call_role": "own_new_lead | second_call_closer | unclear",',
    '  "lead_quality": { "verdict": "good_to_book | should_screen_out", "justification": "string" },',
    '  "call_quality_score": 1,',
    '  "flags": { "asked_for_close": true, "objections_uncovered": true, "objections_overcome": true, "closed_or_committed": true },',
    '  "primary_failure_mode": "none | no_close_ask | objections_missed | both",',
    '  "teachable_strength": "string",',
    '  "coach_this": "string",',
    '  "manual_review_recommended": true,',
    '  "severity": 1,',
    '  "feedback_summary": "string — 2-3 sentences, coaching-ready"',
    '}'
  ].join('\n');
}

function isValidTomasJudgeSchema_(obj) {
  return !!(obj &&
    typeof obj.call_role === 'string' &&
    obj.lead_quality && typeof obj.lead_quality.verdict === 'string' &&
    typeof obj.call_quality_score === 'number' &&
    obj.flags &&
    typeof obj.flags.asked_for_close === 'boolean' &&
    typeof obj.flags.objections_uncovered === 'boolean' &&
    typeof obj.flags.objections_overcome === 'boolean' &&
    typeof obj.flags.closed_or_committed === 'boolean' &&
    typeof obj.teachable_strength === 'string' &&
    typeof obj.coach_this === 'string' &&
    typeof obj.manual_review_recommended === 'boolean' &&
    typeof obj.severity === 'number');
}

/** Same retry/manual-review shape as scoreTranscript_/scoreSeanTranscript_, against the Tomás-specific prompt. */
function scoreTomasTranscript_(ctx) {
  var systemPrompt = buildTomasJudgeSystemPrompt_();
  var userPrompt = buildJudgeUserPrompt_(ctx);
  var lastRaw = null;

  for (var attempt = 0; attempt <= PHASE2_CONFIG.MAX_PARSE_RETRIES; attempt++) {
    var promptForThisAttempt = attempt === 0
      ? userPrompt
      : userPrompt + '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    try {
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt);
      var parsed = stripFencesAndParseJson_(lastRaw);
      if (!isValidTomasJudgeSchema_(parsed)) throw new Error('Parsed JSON missing required Tomás-rubric fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ scoreTomasTranscript_ attempt ' + (attempt + 1) + ' failed for ' + ctx.prospectName + ': ' + e);
    }
  }

  log_('    ↳ ROUTED TO MANUAL REVIEW (parse failed twice) — ' + ctx.prospectName +
    '. Raw model output: ' + String(lastRaw).slice(0, 1000));
  return {
    reasoning: 'JSON parse failed twice — see Apps Script log for raw model output.',
    call_role: 'unclear',
    lead_quality: { verdict: 'good_to_book', justification: 'Unscored — parse failure.' },
    call_quality_score: 1,
    flags: { asked_for_close: false, objections_uncovered: false, objections_overcome: false, closed_or_committed: false },
    primary_failure_mode: 'none',
    teachable_strength: 'Unscored — parse failure.',
    coach_this: 'Unscored — parse failure.',
    manual_review_recommended: true,
    severity: 5,
    feedback_summary: 'Automated scoring failed twice to return parseable JSON; needs manual review.',
    _parseFailed: true
  };
}

/** Packs the extra Tomás-only dimensions into the one free-text column the sheet has (AI Feedback Summary). */
function buildTomasFeedbackSummary_(result) {
  return [
    result.feedback_summary,
    '',
    'Call role: ' + result.call_role + ' | Closed or committed: ' + result.flags.closed_or_committed,
    'Teachable strength (pass to other reps): ' + result.teachable_strength,
    'Coach Tomás on: ' + result.coach_this
  ].join('\n');
}

/**
 * Dry-run helper — mirrors previewSeanTranscripts. Logs what would be scored,
 * calls no model, writes nothing.
 */
function previewTomasTranscripts() {
  RUN_TAG = 'previewTomasTranscripts';
  var n = 0;
  Object.keys(PHASE2_CONFIG.TOMAS_FOLDERS).forEach(function (label) {
    var folder = DriveApp.getFolderById(PHASE2_CONFIG.TOMAS_FOLDERS[label]);
    var files = folder.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      if (file.getName().indexOf('Transcript') === -1) continue;
      log_('  [' + label + '] ' + file.getName());
      n++;
    }
  });
  log_('previewTomasTranscripts — ' + n + ' transcript doc(s) found across ' +
    Object.keys(PHASE2_CONFIG.TOMAS_FOLDERS).length + ' folder(s).');
}

/**
 * Scores every unscored transcript in PHASE2_CONFIG.TOMAS_FOLDERS against the
 * Tomás-specific rubric and appends one "Sales Call Log" row per call. Same
 * lock/dedup/force-manual-review shape as scoreSeanTranscripts() — see that
 * function's header comment for why.
 */
function scoreTomasTranscripts() {
  RUN_TAG = 'scoreTomasTranscripts';

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('scoreTomasTranscripts: another scoring run holds the lock, skipping this firing.');
    return;
  }

  try {
    var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
    var sheet = resolveSheet_(ss, 'Sales Call Log');
    if (!sheet) { log_('No Sales Call Log tab found — run setupSalesCallLog() first.'); return; }

    var existing = loadExistingLegacyKeys_(sheet);
    var scored = 0, skippedExisting = 0, failed = 0;

    Object.keys(PHASE2_CONFIG.TOMAS_FOLDERS).forEach(function (label) {
      var folder = DriveApp.getFolderById(PHASE2_CONFIG.TOMAS_FOLDERS[label]);
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
          var ctx = {
            rep: 'Tomás',
            prospectName: prospectName,
            callType: 'Sales Call',
            source: '',
            callDate: dateStr,
            transcriptText: getTranscriptText_(file)
          };
          var result = scoreTomasTranscript_(ctx);
          var objectionsHandled = result.flags.objections_uncovered && result.flags.objections_overcome;

          sheet.appendRow([
            prospectName,                     // Prospect Name
            '',                                // Prospect Email — fill from tracker
            '',                                // Source — fill from tracker
            callDate,                          // Call Date
            'Tomás',                           // Rep
            'Sales Call',                      // Call Type
            true,                              // Outcome Logged
            '',                                // Outcome Disposition — fill from tracker
            '',                                // Calendar Event ID — none (predates convention)
            '',                                // Riverside Recording ID — n/a, Tomás uses Zoom
            file.getUrl(),                     // Transcript URL
            'fallback_heuristic',              // Match Method
            result.lead_quality.verdict,       // Lead Quality Verdict
            result.call_quality_score,         // Call Quality Score
            result.flags.asked_for_close,      // Flag: Asked For Close
            objectionsHandled,                 // Flag: Objections Handled
            true,                              // Manual Review Recommended — forced true
            result.severity,                   // Severity
            buildTomasFeedbackSummary_(result), // AI Feedback Summary — includes call_role + coaching extraction
            false,                             // Reviewed By Kris
            0,                                  // Queue Age
            '',                                 // Kris Manual Review Verdict — not yet judged
            result.primary_failure_mode || 'none' // Primary Failure Mode
          ]);

          existing[key] = true;

          log_('  Scored "' + prospectName + '" (' + dateStr + '): ' + result.call_role + ', ' +
            result.lead_quality.verdict + ', score ' + result.call_quality_score + ', severity ' + result.severity +
            (result._parseFailed ? ' [PARSE FAILED]' : ''));
          scored++;
          Utilities.sleep(300);
        } catch (e) {
          log_('  FAILED "' + name + '": ' + e);
          failed++;
        }
      }
    });

    log_('scoreTomasTranscripts done — scored ' + scored + ', already-present ' + skippedExisting +
      ', failed ' + failed + '.');
    log_('Every row above was force-flagged Manual Review Recommended = TRUE (fallback_heuristic match) — ' +
      'Kris should confirm before trusting a score, same policy as the Bens/Sean backfills.');
  } finally {
    lock.releaseLock();
  }
}

/**
 * ONE-TIME setup — select installTomasScoringAutomation in the Apps Script
 * editor's "Select function" dropdown and run it once. Puts Tomás's ongoing
 * scoring on the same 4-hour cadence as Sean's (installSeanScoringAutomation).
 */
function installTomasScoringAutomation() {
  RUN_TAG = 'installTomasScoringAutomation';
  reinstallHourlyTrigger_('scoreTomasTranscripts', 4);
  log_('Tomás auto-scoring installed: scoreTomasTranscripts() now runs every 4 hours.');
}

/**
 * Cleanup for a specific failure mode: if scoreSeanTranscripts() or
 * scoreNewlyLoggedCalls_() ever runs while LITELLM_PROXY_URL/LITELLM_API_KEY
 * are missing (or the proxy is otherwise unreachable), every transcript hits
 * the parse-failure fallback and still gets appended as a real row — fake
 * placeholder score (1/5), severity 5, every flag false — and gets marked
 * "already scored," so a later successful run silently skips it forever
 * instead of re-scoring for real. This finds/removes exactly those rows,
 * identified by the fixed feedback-summary text the fallback always writes.
 * Bottom-to-top delete so earlier deletions don't shift the row indices of
 * ones still queued. Run previewFailedParseRows() first to see the list.
 */
var PARSE_FAILURE_MARKER_ = 'Automated scoring failed twice to return parseable JSON';

function findFailedParseRows_(sheet) {
  var col = getValidatedColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var summaries = sheet.getRange(2, col['AI Feedback Summary'], lastRow - 1, 1).getValues();
  var names = sheet.getRange(2, col['Prospect Name'], lastRow - 1, 1).getValues();
  var rows = [];
  summaries.forEach(function (r, i) {
    if (String(r[0]).indexOf(PARSE_FAILURE_MARKER_) === 0) {
      rows.push({ rowIndex: i + 2, prospectName: names[i][0] });
    }
  });
  return rows;
}

function previewFailedParseRows() {
  RUN_TAG = 'previewFailedParseRows';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  var rows = findFailedParseRows_(sheet);
  if (!rows.length) { log_('No parse-failure placeholder rows found.'); return; }
  log_('Found ' + rows.length + ' parse-failure placeholder row(s) — deleteFailedParseRows() would remove:');
  rows.forEach(function (r) { log_('  Row ' + r.rowIndex + ': ' + r.prospectName); });
}

function deleteFailedParseRows() {
  RUN_TAG = 'deleteFailedParseRows';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  var rows = findFailedParseRows_(sheet);
  if (!rows.length) { log_('No parse-failure placeholder rows found — nothing to delete.'); return; }
  rows.sort(function (a, b) { return b.rowIndex - a.rowIndex; });
  rows.forEach(function (r) {
    sheet.deleteRow(r.rowIndex);
    log_('  Deleted row ' + r.rowIndex + ': ' + r.prospectName);
  });
  log_('Deleted ' + rows.length + ' parse-failure placeholder row(s). Re-run scoreSeanTranscripts() ' +
    'once LITELLM_PROXY_URL/LITELLM_API_KEY are set to re-score these for real.');
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
 * Once Sean's ~220-call backlog is fully transcribed and scored, set the
 * PAUSE_SEAN_TRIGGER Script Property to 'true' (Project Settings → Script
 * Properties) rather than just deleting the trigger — selfHealTriggers_'s
 * weekly audit will otherwise silently recreate a deleted-but-not-paused
 * trigger, since it can't tell "deleted by accident" from "deleted on
 * purpose."
 */
function installSeanScoringAutomation() {
  RUN_TAG = 'installSeanScoringAutomation';
  reinstallHourlyTrigger_('scoreSeanTranscripts', 4);
  log_('Sean auto-scoring installed: scoreSeanTranscripts() now runs every 4 hours. ' +
    'Remember to disable this trigger once the backlog is fully transcribed and scored.');
}

// ---------------------------------------------------------------------------
// Prioritization — SOP §6 ("who Kris actually reviews") fully specifies this
// algorithm but, like the trigger installers above, it was never actually
// implemented. First implementation below. The SOP's own wording leaves two
// things genuinely ambiguous — marked AMBIGUITY below — Kris/Tomás should
// confirm those interpretations before this drives real review assignments,
// same review gate as every other rubric/scoring decision in this file.
// ---------------------------------------------------------------------------

/**
 * Builds today's review queue: the single rep whose unreviewed, flagged
 * calls best fill a 3-call review sitting, plus those (up to) 3 calls in
 * priority order. Increments Queue Age on every other unreviewed flagged
 * call (rolled over, not picked today — SOP §6.5), and logs an escalation
 * watch for any rep whose oldest queued call crossed the starvation-
 * prevention age threshold but still wasn't picked today.
 *
 * Read-only on everything except Queue Age (rollover aging) — never
 * touches Reviewed By Kris or any scored field. Run manually for now; wire
 * to a daily trigger once Kris/Tomás confirm this matches how the 3-call
 * sitting should actually be picked.
 */
// brief.txt §D: "a hard cap (e.g., queue older than N days) triggers a
// digest to Kris" — distinct from (and stricter than) AGE_ESCALATION_THRESHOLD_DAYS
// below, which only drives a log line for today's run. This is the threshold
// that actually sends something (sendReviewQueueDigest_ below needs it too,
// hence file scope rather than a local inside buildReviewQueue()).
var QUEUE_AGE_HARD_CAP_DAYS = 7;

/**
 * Thin locked wrapper around buildReviewQueueImpl_(). The function's own
 * docstring invites repeat manual runs ("run manually for now"), but nothing
 * previously stopped two overlapping runs from double-incrementing Queue Age
 * on every unpicked candidate (compounding, not idempotent — distorts the
 * anti-starvation math in SOP §6.5) and, once SHADOW_MODE is false,
 * double-sending Kris's digest email. Shares the same script lock as
 * scoreNewlyLoggedCalls_/scoreSeanTranscripts/syncRiversideTranscripts_ —
 * a useful side effect is that queue-building is also correctly blocked
 * while a batch scoring run is mid-write to the same sheet.
 */
function buildReviewQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    RUN_TAG = 'buildReviewQueue';
    log_('buildReviewQueue: another scoring/queue run holds the lock, skipping this run.');
    return null;
  }
  try {
    return buildReviewQueueImpl_();
  } finally {
    lock.releaseLock();
  }
}

function buildReviewQueueImpl_() {
  RUN_TAG = 'buildReviewQueue';
  var AGE_ESCALATION_THRESHOLD_DAYS = 3; // SOP's own "(e.g. 3 days)" example value.

  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return null; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { log_('No data rows.'); return null; }

  var col = getValidatedColumnMap_(sheet);
  var values = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  // Step 1: unreviewed flagged calls only.
  var candidates = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    if (!row[col['Manual Review Recommended'] - 1]) continue;
    if (row[col['Reviewed By Kris'] - 1]) continue;
    // SOP §2: "a bad lead doesn't get penalized for a rep's close technique
    // on a call that shouldn't have happened" — this queue is specifically
    // about coaching rep EXECUTION, so a should_screen_out lead's severity
    // shouldn't compete for a review slot on that basis. The judge prompt
    // still generates a score for these rows (its own comment promises
    // "downstream logic will decide how much weight the score carries") —
    // this is that downstream logic; the row itself is untouched on the
    // sheet. NOTE: this exclusion did not exist before tonight, so the 43
    // already-scored Bens rows may include should_screen_out calls whose
    // severity was already weighed as if it counted — worth a manual spot
    // check before trusting historical review-queue picks retroactively.
    if (String(row[col['Lead Quality Verdict'] - 1] || '').trim() === 'should_screen_out') continue;
    candidates.push({
      rowIndex: r + 2,
      rep: row[col['Rep'] - 1],
      prospectName: row[col['Prospect Name'] - 1],
      severity: Number(row[col['Severity'] - 1]) || 0,
      askedForClose: !!row[col['Flag: Asked For Close'] - 1],
      objectionsHandled: !!row[col['Flag: Objections Handled'] - 1],
      queueAge: Number(row[col['Queue Age'] - 1]) || 0
    });
  }

  if (!candidates.length) {
    log_('buildReviewQueue: nothing unreviewed and flagged — queue is empty.');
    return null;
  }

  // "Both failure-mode flags true beats one" in the SOP's tie-break wording
  // means both flags FAILED (never asked for close AND objections not
  // handled) — the worst-quality calls, not literally both booleans true.
  candidates.forEach(function (c) {
    c.bothFailuresPresent = !c.askedForClose && !c.objectionsHandled;
  });

  // AMBIGUITY #1: the SOP doesn't specify per-call ordering within a rep's
  // own cluster before picking their top 3. Reusing the same signal
  // priority as the rep-level tie-breaks below (severity, then age, then
  // both-failures) is the most internally consistent reading available.
  function callPriorityCompare(a, b) {
    if (b.severity !== a.severity) return b.severity - a.severity;
    if (b.queueAge !== a.queueAge) return b.queueAge - a.queueAge;
    if (a.bothFailuresPresent !== b.bothFailuresPresent) return a.bothFailuresPresent ? -1 : 1;
    return 0;
  }

  // Step 2/3: group by rep, compute each rep's cluster score.
  var byRep = {};
  candidates.forEach(function (c) {
    (byRep[c.rep] = byRep[c.rep] || []).push(c);
  });

  var reps = Object.keys(byRep).map(function (repName) {
    var calls = byRep[repName].slice().sort(callPriorityCompare);
    var top3 = calls.slice(0, 3);
    var cappedCount = Math.min(calls.length, 3);
    var aggregateSeverity = top3.reduce(function (sum, c) { return sum + c.severity; }, 0);
    // AMBIGUITY #2: "cluster score = (flagged-call count, capped at 3)
    // blended with max/sum severity" doesn't give exact weights. Count
    // dominates here (whether the sitting can be filled to 3 matters more
    // than marginal severity), and aggregate severity of the top 3 breaks
    // ties within the same count band — the x1000 multiplier keeps that
    // ordering exact since a top-3 severity sum tops out at 15 (5 max each).
    var clusterScore = cappedCount * 1000 + aggregateSeverity;
    return {
      rep: repName,
      calls: calls,
      top3: top3,
      cappedCount: cappedCount,
      aggregateSeverity: aggregateSeverity,
      clusterScore: clusterScore,
      maxSeverity: calls.length ? calls[0].severity : 0,
      oldestAge: calls.reduce(function (m, c) { return Math.max(m, c.queueAge); }, 0),
      bothFailuresCount: calls.filter(function (c) { return c.bothFailuresPresent; }).length
    };
  });

  reps.sort(function (a, b) {
    if (b.clusterScore !== a.clusterScore) return b.clusterScore - a.clusterScore;
    // Tie-breaks per SOP §6.4, in order.
    if (b.maxSeverity !== a.maxSeverity) return b.maxSeverity - a.maxSeverity;
    if (b.oldestAge !== a.oldestAge) return b.oldestAge - a.oldestAge;
    if (b.bothFailuresCount !== a.bothFailuresCount) return b.bothFailuresCount - a.bothFailuresCount;
    return a.rep.localeCompare(b.rep);
  });

  var chosen = reps[0];

  // Anti-starvation escalation watch (SOP §6.5): a rep with a call at/over
  // the age threshold who still didn't win today's slot gets flagged loudly
  // instead of silently starving behind a chronically higher-severity rep.
  var escalations = reps.filter(function (r) {
    return r !== chosen && r.oldestAge >= AGE_ESCALATION_THRESHOLD_DAYS;
  });

  // Rollover: increment Queue Age on everything NOT picked today. Batched as
  // one column write instead of one setValue per row — with a large rolled-
  // over backlog, per-cell writes would mean dozens to hundreds of
  // individual Sheets API calls per run instead of one.
  var chosenRowIndexes = {};
  chosen.top3.forEach(function (c) { chosenRowIndexes[c.rowIndex] = true; });
  var queueAgeCol = values.map(function (row) { return [row[col['Queue Age'] - 1]]; });
  candidates.forEach(function (c) {
    if (chosenRowIndexes[c.rowIndex]) return;
    queueAgeCol[c.rowIndex - 2][0] = c.queueAge + 1; // rowIndex is 1-based incl. header; values[] isn't.
  });
  sheet.getRange(2, col['Queue Age'], queueAgeCol.length, 1).setValues(queueAgeCol);

  log_('buildReviewQueue: today\'s pick is ' + chosen.rep + ' (' + chosen.top3.length +
    ' calls, cluster score ' + chosen.clusterScore + ', aggregate severity ' +
    chosen.aggregateSeverity + ').');
  chosen.top3.forEach(function (c) {
    log_('  Row ' + c.rowIndex + ': ' + c.prospectName + ' — severity ' + c.severity +
      ', queue age ' + c.queueAge + (c.bothFailuresPresent ? ' [both failure modes]' : ''));
  });
  escalations.forEach(function (r) {
    log_('  ESCALATION WATCH: ' + r.rep + ' has a call at queue age ' + r.oldestAge +
      ' (>= ' + AGE_ESCALATION_THRESHOLD_DAYS + ' days) and was not picked today.');
  });

  var hardCapBreaches = reps.filter(function (r) {
    return r !== chosen && r.oldestAge >= QUEUE_AGE_HARD_CAP_DAYS;
  });
  sendReviewQueueDigest_(chosen, escalations, hardCapBreaches);

  return {
    rep: chosen.rep,
    calls: chosen.top3.map(function (c) {
      return { rowIndex: c.rowIndex, prospectName: c.prospectName, severity: c.severity, queueAge: c.queueAge };
    }),
    escalationWatch: escalations.map(function (r) { return r.rep; })
  };
}

/**
 * The actual "3-per-day clustered review email" from brief.txt §D, plus the
 * hard-cap staleness digest it also names. Neither existed before — up to
 * now buildReviewQueue() computed and logged the pick but never told Kris
 * anything outside the Apps Script execution log, which she has no reason
 * to check daily.
 *
 * Gated by PHASE2_CONFIG.SHADOW_MODE, same rule as every other Kris-facing
 * send in this file (SOP §7: "score and log, but never email Kris" during
 * shadow mode). Flipping SHADOW_MODE to false after the 80%-agreement gate
 * clears is what "turns on" this email — no separate feature flag needed.
 */
function sendReviewQueueDigest_(chosen, escalations, hardCapBreaches) {
  if (PHASE2_CONFIG.SHADOW_MODE) {
    log_('  (SHADOW_MODE — review queue digest logged only, not emailed. Flip ' +
      'PHASE2_CONFIG.SHADOW_MODE to false once weekly calibration clears the 80% gate.)');
    return;
  }

  var lines = ['Today\'s review sitting: ' + chosen.rep + ' (' + chosen.top3.length + ' call(s))', ''];
  chosen.top3.forEach(function (c, i) {
    lines.push((i + 1) + '. ' + c.prospectName + ' — severity ' + c.severity +
      ', queue age ' + c.queueAge + (c.bothFailuresPresent ? ' [both failure modes]' : '') +
      ' (row ' + c.rowIndex + ')');
  });
  if (escalations.length) {
    lines.push('', 'Escalation watch (backlog building up behind ' + chosen.rep + ' today):');
    escalations.forEach(function (r) {
      lines.push('- ' + r.rep + ': oldest queued call is ' + r.oldestAge + ' day(s) old');
    });
  }
  guardedSend_(CONFIG.KRIS_EMAIL, '[Call Review] Today\'s 3-call sitting: ' + chosen.rep,
    lines.join('\n'), {}, 1);

  hardCapBreaches.forEach(function (r) {
    guardedSend_(CONFIG.KRIS_EMAIL,
      '[Call Review] ' + r.rep + '\'s queue has gone stale (' + r.oldestAge + ' days)',
      r.rep + ' has a flagged, unreviewed call that has waited ' + r.oldestAge + ' day(s) — past the ' +
      QUEUE_AGE_HARD_CAP_DAYS + '-day hard cap named in brief.txt §D. It lost out on today\'s ' +
      '3-call sitting because ' + chosen.rep + '\'s cluster scored higher; consider reviewing it directly ' +
      'rather than waiting for it to win a future sitting. See Phase2_CallGradingSOP.md §6.',
      {}, 1);
  });
}

// ---------------------------------------------------------------------------
// Weekly calibration — SOP §7 names this ("diff model verdicts vs. Kris's
// actual review outcomes... track agreement / Cohen's kappa") but it was
// never implemented, same gap pattern as the trigger installers and the
// review queue above. This needed one real design decision the SOP itself
// doesn't make: computing genuine agreement/kappa requires Kris's own
// independent verdict in the SAME category as the AI's, not just an
// agree/disagree checkbox — a checkbox would only give percent-agreement,
// not the confusion matrix kappa needs. So this adds one new column,
// "Kris Manual Review Verdict" (Yes/No/blank, see SALES_CALL_LOG_HEADERS in
// Phase1_ComplianceCheck.gs), which Kris fills in per call she's reviewed:
// does she independently agree this call needed manual review? Additive
// and backward-compatible (appended at the end, existing appendRow calls
// that don't set it just leave it blank = "not yet judged").
// ---------------------------------------------------------------------------

/**
 * Cohen's kappa on a 2x2 confusion matrix: κ = (po - pe) / (1 - pe), where po
 * is observed agreement and pe is agreement expected by chance given each
 * rater's marginal totals. Pulled out of runWeeklyCalibration as its own pure
 * function so the math has a unit-testable seam (see tests/run_tests.js) —
 * assumes n = the sum of all four counts is > 0 (the caller guarantees this).
 */
function computeAgreementStats_(aiYes_krisYes, aiYes_krisNo, aiNo_krisYes, aiNo_krisNo) {
  var n = aiYes_krisYes + aiYes_krisNo + aiNo_krisYes + aiNo_krisNo;
  var percentAgreement = (aiYes_krisYes + aiNo_krisNo) / n;

  var aiYesTotal = aiYes_krisYes + aiYes_krisNo, aiNoTotal = aiNo_krisYes + aiNo_krisNo;
  var krisYesTotal = aiYes_krisYes + aiNo_krisYes, krisNoTotal = aiYes_krisNo + aiNo_krisNo;
  var pe = (aiYesTotal * krisYesTotal + aiNoTotal * krisNoTotal) / (n * n);
  var kappa = pe === 1 ? 1 : (percentAgreement - pe) / (1 - pe);

  return { n: n, percentAgreement: percentAgreement, kappa: kappa };
}

/**
 * Diffs the AI's Manual Review Recommended flag against Kris's own
 * independently-recorded verdict (Kris Manual Review Verdict column) for
 * every row where she's actually judged one, and reports percent agreement
 * plus Cohen's kappa (chance-corrected agreement — the SOP names this
 * specifically, not just raw percent agreement). Rows Kris hasn't judged
 * yet (blank verdict) are skipped, not counted as disagreement.
 *
 * Read-only. Not yet wired to a trigger — run manually (or weekly, once
 * Kris/Tomás confirm the Yes/No column is the right capture mechanism)
 * until there's a real week of judged rows to calibrate against.
 */
function runWeeklyCalibration() {
  RUN_TAG = 'runWeeklyCalibration';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return null; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { log_('No data rows.'); return null; }

  var col = getValidatedColumnMap_(sheet);
  var values = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  var aiYes_krisYes = 0, aiYes_krisNo = 0, aiNo_krisYes = 0, aiNo_krisNo = 0;

  values.forEach(function (row) {
    var krisVerdictRaw = String(row[col['Kris Manual Review Verdict'] - 1] || '').trim();
    if (krisVerdictRaw !== 'Yes' && krisVerdictRaw !== 'No') return; // blank/unjudged — skip

    var aiFlag = !!row[col['Manual Review Recommended'] - 1];
    var krisFlag = krisVerdictRaw === 'Yes';

    if (aiFlag && krisFlag) aiYes_krisYes++;
    else if (aiFlag && !krisFlag) aiYes_krisNo++;
    else if (!aiFlag && krisFlag) aiNo_krisYes++;
    else aiNo_krisNo++;
  });

  var n = aiYes_krisYes + aiYes_krisNo + aiNo_krisYes + aiNo_krisNo;
  if (n === 0) {
    log_('runWeeklyCalibration: no rows with a Kris Manual Review Verdict yet — nothing to calibrate.');
    return null;
  }

  var stats = computeAgreementStats_(aiYes_krisYes, aiYes_krisNo, aiNo_krisYes, aiNo_krisNo);
  var percentAgreement = stats.percentAgreement, kappa = stats.kappa;

  log_('runWeeklyCalibration: n=' + n + ', percent agreement=' +
    (percentAgreement * 100).toFixed(1) + '%, Cohen\'s kappa=' + kappa.toFixed(3));
  log_('  Confusion matrix — AI yes/Kris yes: ' + aiYes_krisYes + ', AI yes/Kris no: ' + aiYes_krisNo +
    ', AI no/Kris yes: ' + aiNo_krisYes + ', AI no/Kris no: ' + aiNo_krisNo);

  if (percentAgreement < 0.80) {
    sendOpsAlert_('[Compliance bot] Weekly calibration below the 80% go-live threshold',
      'Percent agreement with Kris on Manual Review Recommended is ' +
      (percentAgreement * 100).toFixed(1) + '% (n=' + n + '), below the SOP\'s 80% gate. ' +
      'Cohen\'s kappa: ' + kappa.toFixed(3) + '. Feed the disagreements back into rubric-prompt ' +
      'tweaks before treating scores as reliable — see Phase2_CallGradingSOP.md §7.');
  }

  return { n: n, percentAgreement: percentAgreement, kappa: kappa,
    confusionMatrix: { aiYes_krisYes: aiYes_krisYes, aiYes_krisNo: aiYes_krisNo,
      aiNo_krisYes: aiNo_krisYes, aiNo_krisNo: aiNo_krisNo } };
}
