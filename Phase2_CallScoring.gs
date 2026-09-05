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
 *  - scoreLegacyTranscriptFolder(repName, folderId, judgeFn, feedbackSummaryFn)
 *                                One-off backfill: scores a Drive folder of
 *                                already-recorded transcripts that predate the
 *                                Calendar-Event-ID-in-title convention (no
 *                                exact key available — matched by filename
 *                                date + prospect name instead, per brief.txt
 *                                §6's own "legacy recordings" residual-risk
 *                                case). scoreBensLegacyTranscripts() is the
 *                                zero-argument convenience wrapper so it can be
 *                                run directly from the Apps Script editor —
 *                                it passes scoreBensTranscript_/
 *                                buildBensFeedbackSummary_ as the optional
 *                                judgeFn/feedbackSummaryFn overrides, since
 *                                Bens is NOT a closer (SOP §3C, added
 *                                22/08/2026) — he books a QC/Sales Call for
 *                                someone else rather than asking for money.
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
  // Real names as of 05/09/2026 — renamed from LITELLM_PROXY_URL/
  // LITELLM_API_KEY (external review: that naming "will burn someone
  // eventually... debugging why 'the proxy' is down" — no proxy has ever
  // been involved, see file header). getScriptSecretWithFallback_ below
  // still accepts the OLD property names too, so this rename is safe to
  // deploy before the Script Properties themselves are renamed in the Apps
  // Script UI (Script Properties are runtime storage, clasp push never
  // touches them — CLAUDE.md) — nothing breaks either order. Once you've
  // added MOONSHOT_API_URL/MOONSHOT_API_KEY under Project Settings with the
  // same real values, the old LITELLM_* properties can be deleted.
  PROXY_URL_PROPERTY: 'MOONSHOT_API_URL', // set to https://api.moonshot.ai/v1/chat/completions
  API_KEY_PROPERTY: 'MOONSHOT_API_KEY',   // set to your real Moonshot API key (sk-...)
  LEGACY_PROXY_URL_PROPERTY: 'LITELLM_PROXY_URL', // fallback only — see above
  LEGACY_API_KEY_PROPERTY: 'LITELLM_API_KEY',     // fallback only — see above

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

/**
 * RUBRIC_VERSION — added 25/08/2026 per Kris: the rubric has changed twice in
 * two days (Sean's stricter variant, then the framework-explanation third
 * dimension), and until now nothing recorded which rubric version produced a
 * given row's score — making old and new rows silently non-comparable with
 * no way to tell them apart. Written by every code path that writes a score
 * (writeScoreToRow_ and the four appendRow-based legacy/Sean/Joana/Tomás
 * backfill functions) into the "Rubric Version" trailing column
 * (SALES_CALL_LOG_HEADERS, Phase1_ComplianceCheck.gs).
 *
 * PROJECT CONVENTION — bump this string every time ANY rubric variant's
 * scoring logic changes (a new/changed failure mode, a new scored dimension,
 * a changed score anchor, a new or altered rubric variant for a specific
 * rep) — shared rubric or any of the Sean/Bens/Tomás variants, since they
 * all currently move together version-wise. Format: 'YYYY-MM-DD-shortlabel',
 * the date the change landed plus a few words naming it (this makes the
 * value self-explanatory in the sheet without needing to cross-reference a
 * changelog). Existing rows keep whatever value was current when they were
 * scored — this constant is never used to retroactively rewrite history, see
 * Phase2_CallGradingSOP.md §3E.
 */
var RUBRIC_VERSION = '2026-09-03-discovery-sop-rubric';

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
 * Same contract as getScriptSecret_, but tries preferredName first and
 * falls back to legacyName only if preferredName isn't set yet — lets the
 * 05/09/2026 LITELLM_*->MOONSHOT_* rename land in code without requiring the
 * live Script Properties to be renamed in lockstep. Logs a one-time-per-run
 * nudge when it actually had to fall back, so the migration doesn't stay
 * invisible forever.
 */
function getScriptSecretWithFallback_(preferredName, legacyName) {
  var v = PropertiesService.getScriptProperties().getProperty(preferredName);
  if (v) return v;
  v = PropertiesService.getScriptProperties().getProperty(legacyName);
  if (v) {
    log_('Using legacy Script Property "' + legacyName + '" — add "' + preferredName +
      '" with the same value under Project Settings, then delete "' + legacyName + '".');
    return v;
  }
  throw new Error('Missing Script Property "' + preferredName + '" (or legacy "' + legacyName +
    '") — set it under Project Settings before scoring.');
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

  // Real bug found live (26/08/2026 silent-failure audit): this used to just
  // slice between the FIRST '{' and the LAST '}' in the whole string — which
  // breaks the moment the model's own prose contains a brace anywhere
  // outside the real JSON object (e.g. "Here is the evaluation {as
  // requested}: {...}" slices "{as requested}: {...}", not valid JSON).
  // Scans every '{' as a candidate start, walks forward tracking brace depth
  // (aware of string literals, so a brace INSIDE a quoted value can't
  // confuse the count), and returns the first candidate that both balances
  // and actually parses.
  for (var i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    var depth = 0, inString = false, escaped = false;
    for (var j = i; j < s.length; j++) {
      var ch = s[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(s.slice(i, j + 1));
          } catch (e) {
            break; // this candidate didn't parse — try the next '{'
          }
        }
      }
    }
  }
  throw new Error('No JSON object found in model output.');
}

// Real bug found live (26/08/2026 silent-failure audit): every schema
// validator below only ever checked typeof, never the actual value — so at
// the mandated temperature:1, an out-of-vocabulary verdict ("should screen
// out" with a space instead of an underscore) or an out-of-range score
// (4.5, or a severity of 8) passed validation and reached the sheet intact.
// A verdict that isn't the exact string 'should_screen_out' silently fails
// every `=== 'should_screen_out'` comparison downstream (e.g. the review-
// queue builder), and an out-of-range severity flows straight into
// clusterScore's ×1000 multiplier, which assumes a 1-5 ceiling.
var VALID_LEAD_VERDICTS_ = { good_to_book: true, should_screen_out: true };

function isValidLeadVerdict_(v) {
  return typeof v === 'string' && !!VALID_LEAD_VERDICTS_[v];
}

/** Score/severity must be a real integer 1-5 — not a float, not out of range. */
function isValidScoreRange_(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5;
}

/** Minimal shape check — never trust a parsed object blindly onto a sheet row. */
function isValidJudgeSchema_(obj) {
  return !!(obj &&
    obj.lead_quality && isValidLeadVerdict_(obj.lead_quality.verdict) &&
    isValidScoreRange_(obj.call_quality_score) &&
    obj.flags && typeof obj.flags.asked_for_close === 'boolean' &&
    typeof obj.flags.objections_uncovered === 'boolean' &&
    typeof obj.flags.objections_overcome === 'boolean' &&
    typeof obj.flags.discovery_adequate === 'boolean' &&
    typeof obj.flags.understood_leads_business === 'boolean' &&
    typeof obj.flags.confirmed_prior_discovery === 'boolean' &&
    typeof obj.flags.booked_discovery_call === 'boolean' &&
    typeof obj.flags.lead_ready_with_money === 'boolean' &&
    obj.framework && typeof obj.framework.recruit_agents_explained === 'boolean' &&
    typeof obj.framework.number_one_podcast_explained === 'boolean' &&
    typeof obj.framework.sell_more_houses_explained === 'boolean' &&
    obj.delivery && typeof obj.delivery.paced_appropriately === 'boolean' &&
    typeof obj.delivery.adapted_to_lead_engagement === 'boolean' &&
    typeof obj.manual_review_recommended === 'boolean' &&
    isValidScoreRange_(obj.severity));
}

/**
 * One raw call to the LiteLLM proxy. Returns the assistant message content
 * (a string, expected to be JSON — possibly fenced). Throws on transport/HTTP
 * failure; JSON validity is the caller's problem (stripFencesAndParseJson_).
 */
/**
 * Real bug found live (26/08/2026 silent-failure audit): DriveApp.Folder.getFiles()
 * is top-level only, but tools/transcribe_sean_calls.py explicitly recurses
 * into subfolders when writing transcripts ("seen for real in Sean's and
 * Joana's folders", per its own docstring). A rep moving old calls into a
 * dated subfolder made every transcript inside it invisible to these
 * backfills — they'd report "scored 0" indistinguishable from a genuinely
 * quiet week. Returns an iterator with the same hasNext()/next() shape as
 * Folder.getFiles() (every existing call site works unchanged) plus a
 * currentFolder() accessor, since a file found in a subfolder needs THAT
 * folder — not the root — passed to anything doing a sibling-file lookup
 * (e.g. resolveRealCallDate_'s paired-video search).
 */
function getFilesRecursive_(rootFolder) {
  var folderQueue = [rootFolder];
  var currentFolder = rootFolder;
  var currentFileIterator = null;

  function advance() {
    while (true) {
      if (currentFileIterator && currentFileIterator.hasNext()) return true;
      if (!folderQueue.length) return false;
      currentFolder = folderQueue.shift();
      var subfolders = currentFolder.getFolders();
      while (subfolders.hasNext()) folderQueue.push(subfolders.next());
      currentFileIterator = currentFolder.getFiles();
    }
  }

  return {
    hasNext: function () { return advance(); },
    next: function () { advance(); return currentFileIterator.next(); },
    currentFolder: function () { return currentFolder; }
  };
}

/**
 * Thrown by callKimiJudge_ for a transport/API failure (missing secret,
 * non-2xx HTTP, malformed response envelope) — distinct from a JSON.parse or
 * schema-validation failure on the MODEL's own reply text. Real bug found
 * live (26/08/2026 silent-failure audit): every judge wrapper used to catch
 * both kinds of failure in the same block and, after exhausting retries,
 * fall through to a fabricated "manual review" score (call_quality_score: 1,
 * every flag false) that gets WRITTEN to the sheet and marked permanently
 * scored — turning an API outage (a rotated key, a rate limit) into what
 * looks like a real, terrible call. A transport error must instead propagate
 * to the per-file caller's own catch, which already does the right thing:
 * log it, count it as failed, write nothing, and let the next run retry.
 */
function LlmTransportError_(message) {
  this.name = 'LlmTransportError_';
  this.message = message;
  this.stack = (new Error(message)).stack;
}
LlmTransportError_.prototype = Object.create(Error.prototype);
LlmTransportError_.prototype.constructor = LlmTransportError_;

/**
 * Shared by every judge wrapper's retry loop. On a genuine JSON/schema parse
 * failure, this is a no-op — the loop retries normally and eventually falls
 * through to that wrapper's manual-review sentinel, unchanged behavior. On a
 * TRANSPORT failure (LlmTransportError_), it sleeps with exponential backoff
 * and lets the loop retry once more, or — once retries are exhausted —
 * re-throws instead of letting the loop fall through, so the caller's own
 * per-file try/catch handles it (log + count as failed + write nothing)
 * rather than a fabricated score reaching the sheet.
 */
function handleJudgeRetryError_(e, attempt, maxRetries) {
  if (!(e instanceof LlmTransportError_)) return;
  if (attempt >= maxRetries) throw e;
  Utilities.sleep(Math.min(30000, 1000 * Math.pow(2, attempt)));
}

var LLM_COST_LOG_SHEET_NAME = 'LLM Cost Log';
var LLM_COST_LOG_HEADERS = ['Timestamp', 'Caller', 'Outcome', 'Model', 'Prompt Tokens', 'Completion Tokens', 'Total Tokens', 'Cached Tokens'];

function getOrCreateLlmCostLogSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(LLM_COST_LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LLM_COST_LOG_SHEET_NAME);
    sheet.getRange(1, 1, 1, LLM_COST_LOG_HEADERS.length).setValues([LLM_COST_LOG_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Best-effort append-only log of every callKimiJudge_ invocation — added
 * 05/09/2026 per an external review flagging that this codebase had zero
 * cost/token visibility into Kimi calls (unlike a sibling project's "LLM
 * Cost Log"). Never throws and never blocks scoring even if the write
 * itself fails — a logging bug must not become a scoring outage, so this
 * is wrapped in its own try/catch rather than trusting every caller to do
 * that. `usage` is Moonshot's raw OpenAI-compatible usage object when one
 * came back (prompt_tokens/completion_tokens/total_tokens, sometimes
 * prompt_tokens_details.cached_tokens) — null on failures before any
 * response body was even parseable.
 */
function logLlmCallCost_(callerLabel, outcome, usage) {
  try {
    var sheet = getOrCreateLlmCostLogSheet_();
    var cached = usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens;
    sheet.appendRow([
      new Date(),
      callerLabel || 'unknown',
      outcome,
      PHASE2_CONFIG.MODEL_NAME,
      usage ? usage.prompt_tokens : '',
      usage ? usage.completion_tokens : '',
      usage ? usage.total_tokens : '',
      cached || ''
    ]);
  } catch (e) {
    log_('logLlmCallCost_: failed to write an LLM Cost Log row (' + e + ') — not fatal, continuing.');
  }
}

/**
 * callerLabel is optional (defaults to 'unknown') — a short string
 * identifying which rubric variant/phase is calling, purely for
 * logLlmCallCost_'s attribution. Never changes scoring behavior.
 */
function callKimiJudge_(systemPrompt, userPrompt, callerLabel) {
  var url, key;
  try {
    url = getScriptSecretWithFallback_(PHASE2_CONFIG.PROXY_URL_PROPERTY, PHASE2_CONFIG.LEGACY_PROXY_URL_PROPERTY);
    key = getScriptSecretWithFallback_(PHASE2_CONFIG.API_KEY_PROPERTY, PHASE2_CONFIG.LEGACY_API_KEY_PROPERTY);
  } catch (e) {
    throw new LlmTransportError_(String(e));
  }

  var payload = {
    model: PHASE2_CONFIG.MODEL_NAME,
    temperature: PHASE2_CONFIG.TEMPERATURE, // must stay 1 — see file header.
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };

  var resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + key },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    throw new LlmTransportError_('UrlFetchApp.fetch failed: ' + e);
  }

  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new LlmTransportError_('LiteLLM proxy HTTP ' + code + ': ' + resp.getContentText().slice(0, 500));
  }
  var body;
  try {
    body = JSON.parse(resp.getContentText());
  } catch (e) {
    throw new LlmTransportError_('LiteLLM proxy returned non-JSON envelope: ' + e);
  }
  var content = body && body.choices && body.choices[0] && body.choices[0].message &&
    body.choices[0].message.content;
  if (!content) {
    // Real Kimi failure mode (external review, 05/09/2026): "thinking" mode
    // can burn the whole completion-token budget and return HTTP 200 with a
    // parseable envelope but an EMPTY message.content. Logging usage here,
    // even though this is about to throw, is what actually diagnoses that
    // pattern — a high completion_tokens count paired with empty content is
    // the signature, distinguishable in the LLM Cost Log from a genuine
    // transport/API failure where no usage exists at all.
    logLlmCallCost_(callerLabel, 'empty_content', body && body.usage);
    throw new LlmTransportError_('LiteLLM response had no choices[0].message.content.');
  }
  logLlmCallCost_(callerLabel, 'success', body.usage);
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

/**
 * Third scored dimension, added 25/08/2026 per Kris: does the rep proactively
 * explain the actual value proposition (the "framework") — how the podcast
 * helps RECRUIT AGENTS, how it builds #1-REAL-ESTATE-PODCAST-IN-YOUR-CITY
 * authority, and how it helps SELL MORE HOUSES? Kris's own framing is the
 * grounding for this, and it's a direct extension of an idea already in the
 * shared rubric: SPIN's "objection prevention beats objection handling" is
 * cited for failure mode 2 below, and proactively explaining the framework
 * IS that prevention — a lead who never understood the offer in the first
 * place is the one who raises "so what does this actually do for me"-shaped
 * objections. Shared across every rubric variant (shared/Sean/Bens/Tomás)
 * rather than duplicated, per SOP §3D.
 */
var FRAMEWORK_GAP_LABELS_ = {
  recruit_agents_explained: 'recruit agents',
  number_one_podcast_explained: '#1 podcast in your city',
  sell_more_houses_explained: 'sell more houses'
};

function frameworkRubricPrompt_() {
  return [
    'A third, independently-tracked dimension — separate from the failure mode(s) above, and it must NOT',
    'change your call_quality_score anchors below (those stay anchored to close-ask/objection-handling only).',
    'Did the rep proactively and accurately explain our actual value proposition (the "framework")? Across the',
    'whole call, did they cover all three of:',
    '  (a) how the podcast helps them RECRUIT AGENTS to their team,',
    '  (b) how it can make them the #1 REAL ESTATE PODCAST IN THEIR CITY (an authority/branding angle),',
    '  (c) how it helps them SELL MORE HOUSES (a production/referral angle)?',
    'A rep who explains this clearly and proactively is pre-empting the objections that come from a lead not',
    'understanding the offer in the first place — that\'s the whole point of tracking it. Grade generously for',
    'substance (did they actually convey the idea, in their own words) over reciting exact marketing language.',
    'Score each of the three independently in the "framework" object below; do not let a strong explanation of',
    'one paper over silence on another.'
  ].join('\n');
}

/**
 * Derives the two "Framework Gaps"/"Flag: Framework Explained" sheet columns
 * from any rubric variant's `framework` object. Defensive against a missing
 * or malformed object (a parse-failure fallback never sets one) — treated as
 * "nothing explained" rather than throwing, same conservative-on-uncertainty
 * policy already used for manual_review_recommended elsewhere in this file.
 */
function deriveFrameworkFields_(result) {
  var f = (result && result.framework) || {};
  var gapKeys = Object.keys(FRAMEWORK_GAP_LABELS_).filter(function (k) { return !f[k]; });
  return {
    explained: gapKeys.length === 0,
    gapsText: gapKeys.map(function (k) { return FRAMEWORK_GAP_LABELS_[k]; }).join(', ')
  };
}

/**
 * Pitch delivery — a fourth, independently-tracked dimension (29/08/2026),
 * added the same way framework explanation was: universal across every
 * variant, does not touch call_quality_score's anchors. Kris's ask: "I
 * haven't seen feedback on how they deliver the pitch." Grounded in two real
 * sources rather than invented — the company's own Sales SOP ("How to Pitch
 * & Close a Lead" §5.2 "Adjust Presentation Speed" / §5.3 "Adapt to Client
 * Reactions to Your Presentation"), and a close read of 20 real Tomás
 * transcripts checking those two things specifically against his own calls
 * (per Kris: "not all his are perfect either" — this was a real audit, not a
 * highlight reel; see Phase2_CallGradingSOP.md §3G for the actual findings).
 * Two SOP sections turned into two scored flags — a third candidate
 * (confidence-of-language / hedging) was checked against the same 20
 * transcripts and dropped: it showed almost no signal (hedging language was
 * essentially absent regardless of call quality), so it would have been a
 * scored dimension with nothing real behind it.
 */
var DELIVERY_GAP_LABELS_ = {
  paced_appropriately: 'pacing/time-awareness',
  adapted_to_lead_engagement: 'reading and adapting to the lead\'s engagement'
};

function deliveryRubricPrompt_() {
  return [
    'A fourth, independently-tracked dimension — separate from the failure mode(s) and framework-explanation',
    'above, and it must NOT change your call_quality_score anchors. Grounded in the company\'s Sales SOP ("How',
    'to Pitch & Close a Lead" §5.2-5.3): score how the rep DELIVERED the call, not just what they said. Two',
    'things, each judged independently:',
    '  (a) paced_appropriately — did the rep show awareness of time/pacing? Checking in on time, not rushing',
    '      through material, or — when time was genuinely short — compressing to the highest-value points',
    '      rather than plowing through everything at the same depth. A real audit of company calls found even',
    '      strong reps rarely INITIATE a time check unprompted — score true if the rep handles a time',
    '      constraint well once it surfaces (their own or the lead\'s), not only if they raised it first.',
    '  (b) adapted_to_lead_engagement — did the rep visibly read the lead\'s engagement and adjust, rather than',
    '      delivering the same pitch regardless of reaction? Going deeper where the lead shows interest or asks',
    '      follow-up questions, moving on where they seem checked out or have already declined, matching a',
    '      data-oriented lead with numbers/specifics and a story-oriented lead with examples/analogies. A rep',
    '      who keeps walking through the full pitch at the same depth after a lead has clearly disengaged or',
    '      already said no fails this flag, even if the content itself was accurate.',
    'Grade generously for substance over a specific script — the SOP does not prescribe exact words, only that',
    'the rep is reading the room rather than running one fixed presentation regardless of who is listening.'
  ].join('\n');
}

/**
 * Derives the two "Delivery Gaps"/"Flag: Delivery Effective" sheet columns
 * from any rubric variant's `delivery` object. Same defensive/conservative
 * treatment of a missing object as deriveFrameworkFields_ above.
 */
function deriveDeliveryFields_(result) {
  var d = (result && result.delivery) || {};
  var gapKeys = Object.keys(DELIVERY_GAP_LABELS_).filter(function (k) { return !d[k]; });
  return {
    effective: gapKeys.length === 0,
    gapsText: gapKeys.map(function (k) { return DELIVERY_GAP_LABELS_[k]; }).join(', ')
  };
}

/**
 * Discovery — the first of the four elements Kris named (03/09/2026) as the
 * ones every rep must be graded on, every week, with the weakest one becoming
 * that week's training focus: discovery, framework, the ask (money on a Sales
 * Call, the booking on a QC), and objection handling.
 *
 * Three variants ALREADY judged discovery as two booleans under `flags`
 * (Bens', the QC/Discovery rubric, and Sean's) — but nothing ever wrote them
 * to a COLUMN. They were packed into the free-text AI Feedback Summary by
 * buildBensFeedbackSummary_ and friends, which is unreadable to the weekly
 * scorecard, the dashboard, or any "what is this rep weakest at" tally: the
 * reason discovery could never be trained on. The shared rubric (Joana) and
 * Tomás's own rubric didn't score it at all. This makes discovery a real,
 * queryable dimension across every variant, exactly the shape framework and
 * delivery already have above.
 *
 * `confirmed_prior_discovery` is deliberately NOT scored on the QC/first-touch
 * rubric — per Kris: on a Sales Call (or a second call) the rep should CONFIRM
 * what the QC already surfaced and go deeper where it was thin, which only
 * means something when there was an earlier call to build on. Grading a
 * first-touch QC against it would mark every QC down for the absence of a
 * conversation that never happened — the same mistake Bens' own rubric exists
 * to avoid (see buildBensJudgeSystemPrompt_'s header).
 */
var DISCOVERY_GAP_LABELS_ = {
  discovery_adequate: 'depth of discovery questioning',
  understood_leads_business: 'understanding the lead\'s business',
  confirmed_prior_discovery: 'confirming/deepening what the earlier call surfaced'
};

/**
 * Sales-call flavour of the discovery rubric — used by the variants that
 * score a call with an earlier QC behind it. The QC/first-touch rubric keeps
 * its own existing discovery wording and never sees the third flag.
 */
function discoveryRubricPrompt_() {
  return [
    'A separately-tracked dimension — it must NOT change your call_quality_score anchors. Judge DISCOVERY, in',
    'three parts, each scored independently in the "flags" object below:',
    '  (a) discovery_adequate — did the rep ask real questions to understand this lead\'s situation before',
    '      pitching, rather than launching into the offer? Open questions that made the lead talk about their',
    '      own business count; rhetorical set-ups for the pitch do not.',
    '  (b) understood_leads_business — by the end of the call, had the rep demonstrably grasped what this lead',
    '      actually does (their market, their role, how they currently get business)? Judge on evidence in the',
    '      transcript — referring back to specifics the lead gave — not on whether they asked the question.',
    '  (c) confirmed_prior_discovery — this call follows an earlier QC/qualification call, so the rep should',
    '      CONFIRM what that earlier call already surfaced ("you mentioned you\'re running about 30 transactions',
    '      a year — is that still right?") rather than either re-asking it cold as if it never happened, or',
    '      assuming it and never checking. AND they should go DEEPER where the earlier discovery was thin —',
    '      following up on anything that was left vague. Score true only if they did both: confirmed what was',
    '      known, and dug further where it was shallow. A rep who simply repeats the QC\'s questions from',
    '      scratch fails this, as does one who never references the earlier conversation at all.',
    '      If the transcript makes clear this was genuine first contact with no earlier call behind it, score',
    '      this TRUE — there was nothing to confirm, and a rep must never be marked down for the absence of a',
    '      conversation that never happened.'
  ].join('\n');
}

/**
 * Derives the "Flag: Discovery Adequate"/"Discovery Gaps" sheet columns from
 * any rubric variant's discovery booleans (which live under `flags`, not
 * their own nested object — that's where the three existing variants already
 * put them, and moving them would break live scoring for no gain).
 *
 * Unlike deriveFrameworkFields_/deriveDeliveryFields_ above, a MISSING key is
 * not treated as a gap: the QC rubric legitimately never scores
 * confirmed_prior_discovery, and counting its absence as a failure would show
 * every QC call with a permanent phantom discovery gap. Only keys the variant
 * actually returned are judged; a result with none of them (a variant that
 * doesn't score discovery, or a parse-failure sentinel that dropped them)
 * returns blank — the same "blank = no signal" convention every other
 * column addition in this file uses for rows that predate it.
 */
function deriveDiscoveryFields_(result) {
  var flags = (result && result.flags) || {};
  var scored = Object.keys(DISCOVERY_GAP_LABELS_).filter(function (k) {
    return typeof flags[k] === 'boolean';
  });
  if (!scored.length) return { adequate: '', gapsText: '' };
  var gapKeys = scored.filter(function (k) { return !flags[k]; });
  return {
    adequate: gapKeys.length === 0,
    gapsText: gapKeys.map(function (k) { return DISCOVERY_GAP_LABELS_[k]; }).join(', ')
  };
}

/**
 * Sales-call-only rubric block, per Kris (03/09/2026): "if you get money on
 * the phone you can book a disco call [Discovery — the AM's onboarding/
 * payment call] or you book closing call [Second Sales Call with Tomás]."
 * A Sales Call that ends in a booked Discovery call is only the right choice
 * when the lead actually committed to paying on THIS call — otherwise it
 * should have been a Second Sales Call with Tomás instead. Kris's own
 * framing: "sales reps are lazy, and they book through to a discovery call
 * where it's not a hell yes."
 */
function bookingDecisionRubricPrompt_() {
  return [
    'A separately-tracked dimension — it must NOT change your call_quality_score anchors. This company books TWO',
    'different kinds of next step after a Sales Call: a Discovery call (the account manager\'s onboarding/payment',
    'call — only correct when the lead is ready to pay NOW) or a Second Sales Call with Tomás (the right choice',
    'for anyone who is interested but not yet at "yes, let\'s do this, take my payment"). Score two flags:',
    '  (a) booked_discovery_call — did the rep book a Discovery call as this call\'s next step? False if a Second',
    '      Sales Call, a Follow-up, or nothing was booked.',
    '  (b) lead_ready_with_money — only meaningful when (a) is true: did the lead explicitly commit to paying/',
    '      moving forward NOW on this call (a real "yes, let\'s do it," not just polite interest or "sounds',
    '      good")? If (a) is false, score this true (nothing to fail — this dimension does not apply).'
  ].join('\n');
}

/**
 * Derives the "Flag: Booking Decision Appropriate"/"Booking Decision Gap"
 * sheet columns. Only meaningful when a Discovery call was actually booked
 * (booked_discovery_call true) — anything else (a Second Sales Call, a
 * Follow-up, nothing booked, or a variant/sentinel that never scored this
 * dimension) is "does not apply", not a failure, same "blank = no signal"
 * convention as deriveDiscoveryFields_ above.
 */
function deriveBookingDecisionFields_(result) {
  var flags = (result && result.flags) || {};
  if (typeof flags.booked_discovery_call !== 'boolean' || typeof flags.lead_ready_with_money !== 'boolean') {
    return { appropriate: '', gapText: '' };
  }
  if (!flags.booked_discovery_call) return { appropriate: '', gapText: '' };
  var appropriate = flags.lead_ready_with_money;
  return {
    appropriate: appropriate,
    gapText: appropriate ? '' :
      'Booked a Discovery call without the lead confirming payment on this call — should have booked a Second Sales Call with Tomás instead'
  };
}

/**
 * Elevation — per Kris (03/09/2026): "the sales rep needs to elevate the
 * other person... hey, this is Thomas, he's fucking amazing, you're gonna
 * absolutely love working with Thomas... and let the other guys get to it."
 * Applies wherever an original rep hands a lead off live to someone else on
 * the same call — the account manager on a Discovery call, or Tomás on a
 * second/closing call. Shared/parameterized rather than duplicated per
 * variant since the judgment itself (was there a genuine, warm handoff) is
 * identical regardless of who's being elevated.
 */
function elevationRubricPrompt_(handoffToLabel) {
  return [
    'A separately-tracked dimension — it must NOT change your call_quality_score anchors. If the original rep',
    '(the one who ran the earlier call, NOT ' + handoffToLabel + ') is present at the start of this call, judge',
    'whether they did a proper "elevation" handoff before dropping off: introducing ' + handoffToLabel + ' by name',
    'with genuine, specific enthusiasm (not a flat "this is X") AND restating the lead\'s own situation/problem so',
    handoffToLabel + ' doesn\'t have to re-ask it from scratch, before letting ' + handoffToLabel + ' take over.',
    'Score two flags:',
    '  (a) rep_present_on_call — was the original rep present on this call at all (even briefly, just for the',
    '      handoff), as opposed to ' + handoffToLabel + ' running the whole call solo with the lead?',
    '  (b) elevation_done — only meaningful when (a) is true: did they do the full handoff described above',
    '      (named introduction with real enthusiasm AND restating the lead\'s situation)? If (a) is false, score',
    '      this TRUE (nothing to fail — there was no rep present on the call to do it).'
  ].join('\n');
}

/**
 * Derives the "Flag: Elevation Done"/"Elevation Gap" sheet columns. Only
 * meaningful when the original rep was actually present on the call
 * (rep_present_on_call true) — a call the rep never joined at all (the AM or
 * Tomás running solo with the lead) is "does not apply", not a failure, same
 * "blank = no signal" convention as deriveBookingDecisionFields_ above.
 */
function deriveElevationFields_(result) {
  var flags = (result && result.flags) || {};
  if (typeof flags.rep_present_on_call !== 'boolean' || typeof flags.elevation_done !== 'boolean') {
    return { done: '', gapText: '' };
  }
  if (!flags.rep_present_on_call) return { done: '', gapText: '' };
  return {
    done: flags.elevation_done,
    gapText: flags.elevation_done ? '' :
      'Did not properly elevate/hand off to the next person (named introduction + restating the lead\'s situation) before dropping off the call'
  };
}

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
    frameworkRubricPrompt_(),
    '',
    deliveryRubricPrompt_(),
    '',
    discoveryRubricPrompt_(),
    '',
    bookingDecisionRubricPrompt_(),
    '',
    '   Score anchors:',
    '   5 = close asked AND objections surfaced+resolved with concrete proof.',
    '   4 = close asked, minor objection-handling gap (surfaced but weakly resolved).',
    '   3 = one of the two failure modes present; the other executed well.',
    '   2 = both failure modes present, but lead was otherwise good-to-book.',
    '   1 = both failure modes present AND lead quality was borderline.',
    '',
    'Exactly two SCORED FAILURE MODES for call_quality_score purposes (framework explanation above is',
    'tracked separately, not a third failure mode input to the score) — do not invent further scored dimensions.',
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
    '  "flags": { "asked_for_close": true, "objections_uncovered": true, "objections_overcome": true,',
    '    "discovery_adequate": true, "understood_leads_business": true, "confirmed_prior_discovery": true,',
    '    "booked_discovery_call": false, "lead_ready_with_money": true },',
    '  "framework": { "recruit_agents_explained": true, "number_one_podcast_explained": true, "sell_more_houses_explained": true },',
    '  "delivery": { "paced_appropriately": true, "adapted_to_lead_engagement": true },',
    '  "primary_failure_mode": "none | no_close_ask | objections_missed | weak_discovery | framework_not_explained | delivery_ineffective | multiple",',
    '  "manual_review_recommended": true,',
    '  "severity": 1,',
    '  "feedback_summary": "string — 2-3 sentences, coaching-ready. MUST open by quoting the rep\'s own',
    '    words from the transcript for the single most important moment (a real line they actually said,',
    '    in quotation marks) before saying anything else — a specific moment lands, a bare evaluation does',
    '    not. Name ONE behavior to change, not a list. Never compare this rep to any other rep by name. If',
    '    this covers more than one distinct idea (the quoted moment, then a separate observation, then what',
    '    to change), put each on its own line separated by a literal \\n — never chain them into one dense',
    '    run-on paragraph."',
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
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt, 'phase2:shared');
      var parsed = stripFencesAndParseJson_(lastRaw);
      if (!isValidJudgeSchema_(parsed)) throw new Error('Parsed JSON missing required fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ scoreTranscript_ attempt ' + (attempt + 1) + ' failed for ' + ctx.prospectName + ': ' + e);
      handleJudgeRetryError_(e, attempt, PHASE2_CONFIG.MAX_PARSE_RETRIES);
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
      discovery_adequate: false, understood_leads_business: false, confirmed_prior_discovery: false,
      booked_discovery_call: false, lead_ready_with_money: false
    },
    framework: { recruit_agents_explained: false, number_one_podcast_explained: false, sell_more_houses_explained: false },
    delivery: { paced_appropriately: false, adapted_to_lead_engagement: false },
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
 *
 * Real incident live (25/08/2026): a stray keystroke meant for the
 * spreadsheet's Name Box landed directly in cell A1 instead and silently
 * renamed "Prospect Name" — every scoring/compliance trigger then started
 * hitting this throw, and nobody found out until it was noticed by hand.
 * Deliberately does NOT auto-repair the header here — this throw is also
 * the safety net that stops the pipeline from running against a sheet
 * that's genuinely missing a column a migration hasn't been applied to yet
 * (see Phase5_WeeklyScorecard.gs's migration note); silently rewriting row 1
 * on every mismatch would paper over that far worse case along with the
 * harmless one. Instead this now also fires an ops alert (throttled, see
 * alertHeaderDriftOnce_ in Phase1_ComplianceCheck.gs) so a human finds out
 * same-day instead of by accident — a human still decides the actual fix.
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
    alertHeaderDriftOnce_(mismatches);
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
        // Call-Type/rep-aware dispatch (29/08/2026) — previously this always
        // scored through the shared rubric regardless of Call Type or rep,
        // so a QC/Discovery row was judged on close-ask/objection-handling
        // criteria that don't structurally apply to a pre-sales-call step,
        // and Tomás's own live-logged calls never got his own variant. See
        // resolveRubricVariantForRow_'s own comment for the dispatch order.
        var variant = rubricVariantForNewScore_(ctx.rep, ctx.callType);
        var result = scoreTranscriptByVariant_(variant, ctx);
        writeScoreToRow_(sheet, rowIndex, col, result, /*forceManualReview=*/false, prospectName, variant);
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

// ---------------------------------------------------------------------------
// Retroactive re-score — added 29/08/2026 per Kris: apply the Call-Type-aware
// dispatch (§3F) and pitch-delivery dimension (§3G) to every call already
// scored under an older rubric, for every rep including Tomás, so the
// dashboard shows this history too — not just calls scored going forward.
//
// Reuses writeScoreToRow_/resolveRubricVariantForRow_/scoreTranscriptByVariant_
// exactly as scoreNewlyLoggedCalls_ does above — a re-score is just "score
// this row again, under whichever variant its Rep/Call Type resolve to
// today," writing back to the SAME row rather than appending a new one.
//
// Two safety rules, neither of which scoreNewlyLoggedCalls_ needs (it only
// ever touches never-scored rows):
//   1. Never touches a row with a non-blank "Kris Manual Review Verdict" —
//      that's Kris's own calibration judgment made against the OLD score/
//      reasoning (SOP §7's ~80%-agreement benchmark). Silently overwriting
//      the score it was judged against would corrupt that history.
//   2. Skips any row already scored under the CURRENT RUBRIC_VERSION — this
//      is what makes the function resumable for free: Apps Script's 6-minute
//      execution ceiling means a few hundred real LLM calls can't run in one
//      invocation (same constraint documented on INBOX_SLA_TIME_BUDGET_MS_ in
//      Phase4_InboxSLA.gs), so this stops at a time budget and reports a
//      partial result — a simple re-run picks up exactly where it left off,
//      since every row it already touched this pass now carries the current
//      version and gets skipped on the next.
var RESCORE_ALL_TIME_BUDGET_MS_ = 5 * 60 * 1000; // same margin under the 6-minute ceiling as INBOX_SLA_TIME_BUDGET_MS_

function rescoreAllCalls_(dryRun, lastWeekOnly) {
  RUN_TAG = 'rescoreAllCalls_';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('rescoreAllCalls_: another scoring run holds the lock, skipping this firing.');
    return true; // unknown state — assume there's still work so a recurring trigger keeps retrying.
  }

  try {
    var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
    var sheet = resolveSheet_(ss, 'Sales Call Log');
    if (!sheet) { log_('No Sales Call Log tab found.'); return false; }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) { log_('No data rows.'); return false; }

    var col = getValidatedColumnMap_(sheet);
    var values = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

    // Real bug found live (29/08/2026, same UX complaint as computeGhlSyncFixes_'s
    // "needs better logging" fix in Phase9_GhlSync.gs): a live (non-dryRun) pass
    // used to log NOTHING for a successfully-scored row, only on failure — with
    // one real model call per row, a few minutes of total silence looked
    // indistinguishable from a hang. Log the real scope up front, then one line
    // per row as it's actually rescored.
    //
    // Real cost bug found live (30/08/2026, per Kris): Moonshot's Kimi API
    // auto-caches on a shared PROMPT PREFIX across consecutive requests (a
    // cache hit is ~10x cheaper on input tokens than a miss — see
    // callKimiJudge_'s own comment). Our system prompt (the rubric text,
    // identical across every row scored under the same variant) is already
    // first in callKimiJudge_'s messages array, which is exactly what the
    // cache needs — but this function used to walk rows in raw SHEET order,
    // which interleaves reps/Call Types essentially at random. Two
    // consecutive calls almost never shared the same variant, so almost
    // every single call was a full-price cache MISS regardless. Fixed by
    // collecting every row that actually needs a rescore first, then sorting
    // that list by variant before making any model call — consecutive calls
    // now share the same system-prompt prefix, letting the cache actually work.
    var eligible = [];
    // Kris's ask (03/09/2026), after seeing 470 rows go eligible at ~2.5
    // minutes of Moonshot latency each: the weekly training picker only ever
    // reads the most recently completed Mon-Sun week, so rescoring all of
    // history to fix THIS week's session is ~470 model calls to change 16
    // rows. Scoped mode rescores just that week — same window getWeekBounds_
    // (Phase5_WeeklyScorecard.gs) gives the scorecard and the playbook
    // review, so "what the picker reads" and "what this rescores" can't
    // drift apart. Everything else (resumability, the version skip, the time
    // budget) is unchanged; the rest of history can still be backfilled
    // later with the unscoped run.
    var scopeWeek = lastWeekOnly ? getWeekBounds_(new Date(), CONFIG.BUSINESS_TIMEZONE) : null;
    var skippedCurrent = 0, skippedManuallyReviewed = 0, skippedNoTranscript = 0, skippedNotYetScored = 0;
    var skippedOutsideWeek = 0;
    for (var i = 0; i < values.length; i++) {
      var scanRow = values[i];
      if (scopeWeek) {
        var scanCallDate = scanRow[col['Call Date'] - 1];
        if (!(scanCallDate instanceof Date) || scanCallDate < scopeWeek.start || scanCallDate >= scopeWeek.end) {
          skippedOutsideWeek++;
          continue;
        }
      }
      var scanExistingScore = scanRow[col['Call Quality Score'] - 1];
      if (typeof scanExistingScore !== 'number') { skippedNotYetScored++; continue; }
      var scanRubricVersion = scanRow[col['Rubric Version'] - 1];
      if (scanRubricVersion === RUBRIC_VERSION) { skippedCurrent++; continue; }
      if (String(scanRow[col['Kris Manual Review Verdict'] - 1] || '').trim() !== '') { skippedManuallyReviewed++; continue; }
      var scanTranscriptUrl = scanRow[col['Transcript URL'] - 1];
      if (!scanTranscriptUrl) { skippedNoTranscript++; continue; }

      var scanRep = scanRow[col['Rep'] - 1];
      var scanCallType = scanRow[col['Call Type'] - 1] || 'QC';
      eligible.push({
        rowIndex: i + 2,
        row: scanRow,
        rep: scanRep,
        callType: scanCallType,
        transcriptUrl: scanTranscriptUrl,
        existingScore: scanExistingScore,
        rubricVersion: scanRubricVersion,
        // A rescore produces a NEW score, so it uses the rubric that should
        // score this rep's call — not whichever one happened to score the row
        // originally (that's resolveRubricVariantForRow_'s job, and only
        // regression-drift attribution wants it).
        variant: rubricVariantForNewScore_(scanRep, scanCallType)
      });
    }
    eligible.sort(function (a, b) { return a.variant < b.variant ? -1 : (a.variant > b.variant ? 1 : 0); });

    var scopeLabel = scopeWeek
      ? ' [last week only: ' + Utilities.formatDate(scopeWeek.start, CONFIG.BUSINESS_TIMEZONE, 'dd/MM/yyyy') +
        ' - ' + Utilities.formatDate(shiftBusinessDate_(scopeWeek.end, CONFIG.BUSINESS_TIMEZONE, -1),
          CONFIG.BUSINESS_TIMEZONE, 'dd/MM/yyyy') + '; ' + skippedOutsideWeek + ' row(s) outside it untouched]'
      : '';
    log_((dryRun ? 'previewRescore' : 'rescore') + (scopeWeek ? 'LastWeekCalls' : 'AllCalls') + scopeLabel + ': ' +
      eligible.length +
      ' row(s) out of ' + values.length + ' need a rescore this pass, grouped by rubric variant for prompt-cache locality' +
      (dryRun ? ' — dry run, no model calls.' : ' — this can take a while, one real model call per row; logging each as it completes.'));

    var runStart = Date.now();
    var rescored = 0, failed = 0, truncated = false;

    for (var e = 0; e < eligible.length; e++) {
      if (Date.now() - runStart > RESCORE_ALL_TIME_BUDGET_MS_) {
        truncated = true;
        log_('  rescoreAllCalls_: time budget hit after ' + rescored + ' of ' + eligible.length +
          ' eligible row(s) — reporting a partial result. Re-run to continue; rows already brought current this pass are skipped automatically.');
        break;
      }

      var item = eligible[e];
      var prospectName = item.row[col['Prospect Name'] - 1];

      try {
        var fileId = extractDriveFileId_(item.transcriptUrl);
        var text = getTranscriptText_(DriveApp.getFileById(fileId));
        var ctx = {
          rep: item.rep,
          prospectName: prospectName,
          callType: item.callType,
          source: item.row[col['Source'] - 1],
          callDate: item.row[col['Call Date'] - 1],
          transcriptText: text
        };

        if (dryRun) {
          log_('  Would re-score row ' + item.rowIndex + ' (' + prospectName + ', ' + item.rep + ', ' + item.callType +
            ') under variant "' + item.variant + '" — old score=' + item.existingScore + ', old Rubric Version="' +
            (item.rubricVersion || '(none)') + '". No model called, nothing written.');
          rescored++;
          continue;
        }

        var result = scoreTranscriptByVariant_(item.variant, ctx);
        writeScoreToRow_(sheet, item.rowIndex, col, result, /*forceManualReview=*/false, prospectName, item.variant);
        rescored++;
        log_('  [' + rescored + '/' + eligible.length + '] Rescored row ' + item.rowIndex + ' (' + prospectName + ', ' +
          item.rep + ', ' + item.callType + ') under "' + item.variant + '" — score ' + item.existingScore + ' -> ' +
          result.call_quality_score + '.');
        Utilities.sleep(300);
      } catch (e2) {
        log_('  Row ' + item.rowIndex + ' (' + prospectName + ') FAILED: ' + e2);
        failed++;
      }
    }

    log_('rescoreAllCalls_ done — ' + (dryRun ? 'WOULD rescore ' : 'rescored ') + rescored +
      ', already current ' + skippedCurrent + ', skipped (Kris manually reviewed) ' + skippedManuallyReviewed +
      ', skipped (no transcript) ' + skippedNoTranscript + ', skipped (not yet scored) ' + skippedNotYetScored +
      ', failed ' + failed + (truncated ? '. TIME BUDGET HIT — re-run to continue.' : '. All rows checked.'));

    // Consumed by runRescoreAllCallsViaTrigger_ to know whether to keep the
    // recurring trigger alive. "More work" means this pass found eligible
    // rows at all — even a fully-completed pass (truncated=false) can still
    // leave permanently-failing rows eligible forever (see that function's
    // own comment), which is accepted, pre-existing behavior, not new here.
    return eligible.length > 0;
  } finally {
    lock.releaseLock();
  }
}

/** Dry run — logs what WOULD be re-scored and why, calls no model, writes nothing. Run this first. */
function previewRescoreAllCalls() {
  return rescoreAllCalls_(true);
}

/**
 * Live re-score — apply the current rubric (Call-Type dispatch + pitch
 * delivery, as of 29/08/2026) to every already-scored call whose Rubric
 * Version is out of date, across every rep. May need several runs if the
 * sheet is large enough to hit the time budget — each run picks up where
 * the last one stopped; see rescoreAllCalls_'s own comment.
 */
function rescoreAllCalls() {
  return rescoreAllCalls_(false);
}

/**
 * Dry run of the last-week-only rescore — logs which rows it would touch and
 * how many it's leaving alone, calls no model, writes nothing.
 */
function previewRescoreLastWeekCalls() {
  return rescoreAllCalls_(true, /*lastWeekOnly=*/true);
}

/**
 * Live re-score scoped to the most recently completed Mon-Sun week — the
 * exact window the weekly training picker (buildAndMaybeSendPlaybookReview_,
 * Phase1_ComplianceCheck.gs) and the weekly scorecard both read.
 *
 * Kris's ask (03/09/2026) on seeing the unscoped run go 470 rows deep at
 * ~2.5 minutes of Moonshot latency per call: getting THIS week's training
 * session right only needs the ~16 calls that week actually contains, not
 * all of history. Same resumability as the unscoped version — rows already
 * carrying the current RUBRIC_VERSION are skipped, so a re-run continues
 * where the time budget cut it off, and nothing is ever paid for twice.
 * Backfilling the rest of history with rescoreAllCalls() later is
 * unaffected: it simply finds fewer rows left to do.
 */
function rescoreLastWeekCalls() {
  return rescoreAllCalls_(false, /*lastWeekOnly=*/true);
}

/** Trigger target for the scoped rescore — same self-removing pattern as runRescoreAllCallsViaTrigger_ above, so it stops on its own once last week is fully rescored. */
function runRescoreLastWeekViaTrigger_() {
  var moreWork = rescoreAllCalls_(false, /*lastWeekOnly=*/true);
  if (!moreWork) removeRescoreLastWeekTrigger_();
}

/**
 * Runs the scoped rescore unattended every 10 minutes until last week is
 * done, then removes itself. At ~2 rows per 5-minute budget a 16-row week
 * takes roughly 8 firings, so this saves clicking Run eight times.
 *
 * Note the 20-trigger project cap that bit installRescoreAllCallsTrigger()
 * on 31/08/2026 — run listAllTriggers() first if this throws.
 */
function installRescoreLastWeekTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runRescoreLastWeekViaTrigger_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runRescoreLastWeekViaTrigger_').timeBased().everyMinutes(10).create();
  log_('Installed 10-minute rescoreLastWeekCalls trigger (any prior copy removed first) — it keeps firing ' +
    'until last week has no rows left eligible, then removes itself automatically.');
}

/** Stops the scoped rescore trigger early — it also removes itself automatically once done. */
function removeRescoreLastWeekTrigger_() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runRescoreLastWeekViaTrigger_') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  if (removed) {
    log_('runRescoreLastWeekViaTrigger_: removed ' + removed + ' recurring trigger(s) — ' +
      'either last week is fully rescored, or it was stopped early.');
  }
}

/**
 * Real cadence found live (31/08/2026): each Kimi call is taking ~2.5
 * minutes (Moonshot-side latency, not a bug here — no retries logged), so
 * the 5-minute time budget only clears ~2 of the 461 eligible rows per
 * manual run — hundreds of manual re-runs to finish. Same idempotent
 * install/remove-trigger pattern as installLegacyBackfillTrigger() above:
 * fires rescoreAllCalls_(false) every 10 minutes and removes its own
 * trigger once a pass finds nothing left eligible, so this can run
 * unattended overnight/over a few days instead of needing Kris to keep
 * clicking Run.
 */
function runRescoreAllCallsViaTrigger_() {
  var moreWork = rescoreAllCalls_(false);
  if (!moreWork) removeRescoreAllCallsTrigger_();
}

function installRescoreAllCallsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runRescoreAllCallsViaTrigger_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runRescoreAllCallsViaTrigger_').timeBased().everyMinutes(10).create();
  log_('Installed 10-minute rescoreAllCalls_ trigger (any prior copy removed first) — it keeps firing ' +
    'until a pass finds no rows left eligible, then removes itself automatically. Watch the execution ' +
    'log for progress; call removeRescoreAllCallsTrigger_() to stop it early if needed.');
}

/**
 * Real bug found live (31/08/2026): installRescoreAllCallsTrigger() threw
 * "This script has too many triggers" — Apps Script caps a project at 20
 * installable triggers total, and with ~15 phases each installing their own
 * (some more than one, e.g. installDailySelfPracticeTriggers's 3-4), the
 * project had quietly filled up. Every install*Trigger() function in this
 * codebase is individually idempotent (deletes its own handler's copy
 * before creating a new one), so duplicates aren't the usual cause — a
 * stale trigger left behind by a completed ONE-TIME job (see
 * installLegacyBackfillTrigger()'s own comment: "run
 * removeLegacyBackfillTrigger() once done" — easy to forget) is the likely
 * culprit. Run this from the editor to see exactly what's installed and
 * decide what's safe to remove with ScriptApp.deleteTrigger(), rather than
 * guessing.
 */
function listAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var byHandler = {};
  triggers.forEach(function (t) {
    var name = t.getHandlerFunction();
    byHandler[name] = (byHandler[name] || 0) + 1;
  });
  log_('listAllTriggers: ' + triggers.length + ' of the 20-trigger project limit in use.');
  Object.keys(byHandler).sort().forEach(function (name) {
    log_('  ' + byHandler[name] + 'x  ' + name +
      (byHandler[name] > 1 ? '  <-- more than one copy, likely safe to dedupe' : ''));
  });
}

/** Run this to stop the recurring rescore trigger early — it also removes itself automatically once done. */
function removeRescoreAllCallsTrigger_() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runRescoreAllCallsViaTrigger_') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  if (removed) {
    log_('runRescoreAllCallsViaTrigger_: removed ' + removed + ' recurring trigger(s) — ' +
      'either rescoreAllCalls is fully done, or it was stopped early.');
  }
}

function extractDriveFileId_(url) {
  var m = String(url).match(/[-\w]{25,}/);
  if (!m) throw new Error('Could not extract a Drive file ID from "' + url + '"');
  return m[0];
}

/**
 * Write scored fields onto an existing "Sales Call Log" row. prospectName is
 * optional (only used to label the analytic-score shadow-check log line
 * below) — omit it and the log line falls back to the row index. variant is
 * optional too (defaults to 'shared', the only variant this function's one
 * caller ever used to write before 29/08/2026's Call-Type-aware dispatch) —
 * selects both the analytic-score deduction table AND, via
 * buildFeedbackSummaryForVariant_, whether the AI Feedback Summary column
 * gets the model's bare feedback_summary or a variant's packed extra
 * dimensions (discovery/booking/framework for 'qc', etc.), same as the
 * Sean/Bens/Tomás backfill functions already do for their own append paths.
 */
function writeScoreToRow_(sheet, rowIndex, col, result, forceManualReview, prospectName, variant) {
  variant = variant || 'shared';
  var objectionsHandled = result.flags.objections_uncovered && result.flags.objections_overcome;
  var manualReview = forceManualReview || result.manual_review_recommended;

  // Analytic-score shadow check (QA_COACHING_RESEARCH_REPORT.md §1.4) — logs
  // a comparison only, never changes what's written below.
  logAnalyticScoreShadowCheck_(prospectName || ('row ' + rowIndex), variant, result);
  // FUTURE (not built — see ANALYTIC_SCORE_CONFIG): if ANALYTIC_SCORE_CONFIG.ENABLED
  // is ever flipped true, this is where the Call Quality Score write below
  // would use the analytic score instead of result.call_quality_score.

  sheet.getRange(rowIndex, col['Lead Quality Verdict']).setValue(result.lead_quality.verdict);
  sheet.getRange(rowIndex, col['Call Quality Score']).setValue(result.call_quality_score);
  sheet.getRange(rowIndex, col['Flag: Asked For Close']).setValue(result.flags.asked_for_close);
  sheet.getRange(rowIndex, col['Flag: Objections Handled']).setValue(objectionsHandled);
  sheet.getRange(rowIndex, col['Manual Review Recommended']).setValue(manualReview);
  sheet.getRange(rowIndex, col['Severity']).setValue(result.severity);
  sheet.getRange(rowIndex, col['AI Feedback Summary']).setValue(buildFeedbackSummaryForVariant_(variant, result));
  sheet.getRange(rowIndex, col['Queue Age']).setValue(0);
  // Phase 5 (weekly scorecard) input — blank on rows scored before this column
  // existed; those just read as "no signal" rather than breaking anything.
  sheet.getRange(rowIndex, col['Primary Failure Mode']).setValue(result.primary_failure_mode || 'none');
  // QC/Discovery calls are explicitly not scored on framework explanation (buildQcJudgeSystemPrompt_'s
  // header comment) — result.framework doesn't exist for that variant. Leaving these two columns blank
  // reads as "no signal" (the same convention already used for columns added after older rows were
  // scored), not as "explained: false" with three fabricated gaps deriveFrameworkFields_ would otherwise
  // produce from a missing object.
  if (variant !== 'qc' && variant !== 'discovery') {
    var framework = deriveFrameworkFields_(result);
    sheet.getRange(rowIndex, col['Flag: Framework Explained']).setValue(framework.explained);
    sheet.getRange(rowIndex, col['Framework Gaps']).setValue(framework.gapsText);
  }
  var delivery = deriveDeliveryFields_(result);
  sheet.getRange(rowIndex, col['Flag: Delivery Effective']).setValue(delivery.effective);
  sheet.getRange(rowIndex, col['Delivery Gaps']).setValue(delivery.gapsText);
  // Discovery applies to EVERY variant, QC included (unlike framework above) —
  // deriveDiscoveryFields_ handles the per-variant differences itself, writing
  // blank rather than a fabricated failure when a variant didn't score it.
  var discovery = deriveDiscoveryFields_(result);
  sheet.getRange(rowIndex, col['Flag: Discovery Adequate']).setValue(discovery.adequate);
  sheet.getRange(rowIndex, col['Discovery Gaps']).setValue(discovery.gapsText);
  // Booking-decision quality (Kris, 03/09/2026) — only 'shared'/'sean' score
  // this (the variants that actually make the Discovery-vs-Second-Sales-Call
  // decision); deriveBookingDecisionFields_ writes blank for every other
  // variant/row, same "blank = no signal" convention as discovery above.
  var booking = deriveBookingDecisionFields_(result);
  sheet.getRange(rowIndex, col['Flag: Booking Decision Appropriate']).setValue(booking.appropriate);
  sheet.getRange(rowIndex, col['Booking Decision Gap']).setValue(booking.gapText);
  // Elevation (Kris, 03/09/2026) — only 'discovery' and 'tomas' score this;
  // deriveElevationFields_ writes blank for every other variant/row, same
  // "blank = no signal" convention as booking/discovery above.
  var elevation = deriveElevationFields_(result);
  sheet.getRange(rowIndex, col['Flag: Elevation Done']).setValue(elevation.done);
  sheet.getRange(rowIndex, col['Elevation Gap']).setValue(elevation.gapText);
  // Discovery-call-only dimensions (Kris, 03/09/2026, graded against the real
  // "SOP for Podcast Discovery Calls"). Gated to 'discovery' specifically —
  // unlike elevation/booking above, deriveDiscoveryContentFields_ treats a
  // MISSING flag as a real gap (never legitimately not-applicable for an
  // actual Discovery call), so calling it for any other variant would write
  // a fabricated "nothing covered" failure instead of reading blank.
  if (variant === 'discovery') {
    var discoveryContent = deriveDiscoveryContentFields_(result);
    sheet.getRange(rowIndex, col['Flag: Discovery Content Covered']).setValue(discoveryContent.covered);
    sheet.getRange(rowIndex, col['Discovery Content Gaps']).setValue(discoveryContent.gapsText);
    var repPayment = deriveRepPaymentFields_(result);
    sheet.getRange(rowIndex, col['Flag: Payment Collected By Rep']).setValue(repPayment.collected);
    sheet.getRange(rowIndex, col['Payment Collected By Rep Gap']).setValue(repPayment.gapText);
  }
  // Records which rubric version produced this score — see RUBRIC_VERSION's
  // own comment above for the versioning convention. Blank on rows scored
  // before this column existed, same "no signal" pattern as every column
  // added before it.
  sheet.getRange(rowIndex, col['Rubric Version']).setValue(RUBRIC_VERSION);
}

/**
 * ONE-TIME migration: appends any header(s) from SALES_CALL_LOG_HEADERS that
 * are missing from the live "Sales Call Log" sheet's header row (e.g. "Kris
 * Manual Review Verdict", "Primary Failure Mode", "Flag: Framework
 * Explained"/"Framework Gaps", and — as of this same 25/08/2026 session —
 * "Rubric Version" — all added to the shared array over the course of this
 * project without ever being backfilled onto the already-deployed sheet).
 * Needed because getValidatedColumnMap_
 * requires the sheet's real header row to exactly match SALES_CALL_LOG_HEADERS.
 * Checks every column in order (not just the last one) and appends whichever
 * are actually missing — safe to re-run, no-ops once everything is present.
 * Despite the name, this is the general "catch the sheet's headers up to
 * SALES_CALL_LOG_HEADERS" migration, not specific to Primary Failure Mode —
 * re-run it any time a new trailing column is added, this one included.
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

/**
 * One-time rename: column T's header changes from "Reviewed By Kris" to
 * "Reviewed By" (25/08/2026, per Kris — Tomás reviews calls too now, and
 * the column needs to record who, not just whether Kris did).
 * migrateAddPrimaryFailureModeColumn_() above can't do this — it only ever
 * fills in a genuinely blank header and deliberately throws rather than
 * overwrite one that already has different non-blank text, so a rename
 * needs its own explicit migration. Only touches the header cell's text —
 * every row's existing data in column T is untouched, including legacy
 * TRUE/FALSE values written before this rename (still read correctly as
 * "reviewed by someone, attribution predates this change" by every truthy
 * check already in this codebase — buildReviewQueueImpl_, the dashboard
 * sync). Idempotent: no-ops if the header already reads "Reviewed By".
 *
 * ONE-TIME SETUP: run once from the Apps Script editor right after
 * deploying this change — getValidatedColumnMap_ throws (with an ops
 * alert, see alertHeaderDriftOnce_) for every scoring/compliance function
 * until this runs, since the live header still reads "Reviewed By Kris"
 * until then.
 */
function migrateRenameReviewedByColumn() {
  RUN_TAG = 'migrateRenameReviewedByColumn';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }

  var colIndex = SALES_CALL_LOG_HEADERS.indexOf('Reviewed By') + 1;
  var cell = sheet.getRange(1, colIndex);
  var current = cell.getValue();
  if (current === 'Reviewed By') {
    log_('migrateRenameReviewedByColumn: already renamed — nothing to do.');
    return;
  }
  if (current !== 'Reviewed By Kris') {
    throw new Error('migrateRenameReviewedByColumn: column ' + colIndex + ' expected "Reviewed By Kris" or ' +
      '"Reviewed By", found "' + current + '" — resolve manually before migrating.');
  }
  cell.setValue('Reviewed By').setFontWeight('bold').setBackground('#e8eef7');
  setDropdown_(sheet, colIndex, ['Kris', 'Tomás']);
  log_('migrateRenameReviewedByColumn: column ' + colIndex + ' header renamed to "Reviewed By", dropdown applied.');
}

// ---------------------------------------------------------------------------
// Bens-specific rubric — added 22/08/2026 per Kris: Bens is not a closer.
// He runs the ICONS 100 lead-gen podcast (interviews a guest, then books a
// QC or Sales Call for someone else to run) and also runs QCs himself,
// booking a Sales Call from those — but he never takes a sales call
// himself. Scoring him against the shared "asked for close" rubric was
// wrong: that flag was measuring a money-ask he was never supposed to make,
// which is why his "Asked for close"/"Objections handled" dashboard numbers
// looked high but weren't actually meaningful. Same field names as the
// shared rubric are kept (asked_for_close, objections_uncovered/overcome)
// so the dashboard and Phase 5's scorecard tally keep working unchanged —
// only what they MEAN is redefined: asked_for_close = did he explicitly ask
// to book the next concrete step (QC or Sales Call, with an actual date/time),
// not whether he asked for money.
// ---------------------------------------------------------------------------

function buildBensJudgeSystemPrompt_() {
  return [
    'You are a sales-call QA evaluator for a podcast-production offer sold to real estate agents, reviewing a call',
    'run by Bens. Bens is NOT a closer — he never asks for money or takes a sales call himself. He runs two kinds',
    'of calls; decide which this one is from the transcript itself:',
    '  icons_100_interview = a guest interview for the ICONS 100 lead-gen podcast. His job here is to run a genuinely',
    '    good interview (the content itself becomes marketing) AND, if the guest is a fit, book a QC or Sales Call',
    '    for someone else on the team to run.',
    '  qc = a qualification call with a lead already in the funnel. His job is to qualify them and book a Sales',
    '    Call for someone else to run.',
    '  unclear = say so rather than guessing if the transcript genuinely doesn\'t make it obvious.',
    '',
    'His equivalent of "the close" is NOT asking for money — it is explicitly asking to book the next concrete',
    'step (a QC or a Sales Call) with someone else on the team, at a specific date/time, not a vague "I\'ll be in',
    'touch" or "someone will reach out." Score that the same way the shared rubric scores a money-ask: a real,',
    'explicit ask, not a soft trial-close question.',
    '',
    'Be skeptical by default. Every judgment must cite specific transcript evidence.',
    '',
    'Answer all of the following, in order, in your reasoning:',
    '1. Did Bens uncover any objections/hesitations about booking the next step, and address them with something',
    '   concrete (a case study, a specific benefit, a direct answer) rather than brushing past them?',
    '2. Did Bens explicitly ask to book a QC or Sales Call, with a specific date/time — not just leave it open-ended?',
    '3. Did that next step actually get booked? If not, what specifically did Bens fail to do or say that would',
    '   have gotten it booked? For an icons_100_interview specifically: a directly-booked Sales Call is a',
    '   BETTER outcome than a QC — Bens\' explicit goal (per Kris, 25/08/2026) is to book sales calls, or from',
    '   an interview book a QC, but booking the Sales Call directly is even better. Note which one it was.',
    '4. Did Bens do real discovery — do they demonstrably understand this person\'s business and situation, not a',
    '   generic read of the room?',
    '5. If this is an icons_100_interview: was the interview itself genuinely good content — did Bens draw out a',
    '   specific, interesting story or piece of expertise, not just surface-level small talk? (For a qc call,',
    '   treat this question as not applicable and answer true.)',
    '6. Bottom line: if no next step was booked, what is the single root cause? Be specific and causal, not vague.',
    '',
    frameworkRubricPrompt_(),
    '',
    deliveryRubricPrompt_(),
    '',
    'Score anchors for call_quality_score (1-5):',
    '5 = next step booked with a specific date/time, objections handled well, and (for an interview) genuinely',
    '    good content. For an icons_100_interview specifically, a directly-booked SALES CALL is the strongest',
    '    version of this outcome — score it a clean 5 even where a QC booking at the same execution quality',
    '    would only reach a 4 (see below). This distinction does not apply to a qc call, whose only meaningful',
    '    next step is a Sales Call.',
    '4 = next step booked, but one of discovery/objection-handling/interview-quality was weak — OR, for an',
    '    icons_100_interview executed at genuine 5-level quality in every other respect, the next step booked',
    '    was only a QC rather than a Sales Call directly.',
    '3 = next step booked mainly because the person pushed for it, not because Bens earned it; or a real ask was',
    '    made but discovery was clearly missing.',
    '2 = no next step booked, the person was a reasonable fit, and the miss is attributable to Bens\' execution.',
    '1 = no next step booked AND no real attempt at discovery or an ask.',
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text. Put "reasoning" first (walk',
    'through all 6 questions with quoted evidence), then the structured fields, in this exact shape:',
    '',
    '{',
    '  "reasoning": "string",',
    '  "call_role": "icons_100_interview | qc | unclear",',
    '  "lead_quality": { "verdict": "good_to_book | should_screen_out", "justification": "string" },',
    '  "call_quality_score": 1,',
    '  "flags": {',
    '    "asked_for_close": true,',
    '    "objections_uncovered": true,',
    '    "objections_overcome": true,',
    '    "booked_next_step": true,',
    '    "discovery_adequate": true,',
    '    "understood_leads_business": true,',
    '    "interview_content_quality_good": true',
    '  },',
    '  "framework": { "recruit_agents_explained": true, "number_one_podcast_explained": true, "sell_more_houses_explained": true },',
    '  "delivery": { "paced_appropriately": true, "adapted_to_lead_engagement": true },',
    '  "next_step_type": "QC | Sales Call | none",',
    '  "primary_failure_mode": "none | no_close_ask | objections_missed | weak_discovery | no_second_call_booked | framework_not_explained | delivery_ineffective | multiple",',
    '  "root_cause_if_no_booking": "string — the single specific reason no next step was booked; \\"N/A\\" if one was",',
    '  "manual_review_recommended": true,',
    '  "severity": 1,',
    '  "feedback_summary": "string — 4-6 sentences, coaching-ready, must cover: objection handling, whether he',
    '   asked to book a next step, whether it got booked, discovery quality, and (for interviews) content quality.',
    '   MUST open by quoting his own words from the transcript for the single most important moment before',
    '   saying anything else. End with ONE specific behavior to change, not a list. Never compare him to any',
    '   other rep by name. Put each distinct idea on its own line separated by a literal \\n (the quoted moment,',
    '   then each separate observation, then the one behavior to change) — never chain them into one dense',
    '   run-on paragraph."',
    '}'
  ].join('\n');
}

function isValidBensJudgeSchema_(obj) {
  return !!(obj &&
    typeof obj.call_role === 'string' &&
    obj.lead_quality && isValidLeadVerdict_(obj.lead_quality.verdict) &&
    isValidScoreRange_(obj.call_quality_score) &&
    obj.flags &&
    typeof obj.flags.asked_for_close === 'boolean' &&
    typeof obj.flags.objections_uncovered === 'boolean' &&
    typeof obj.flags.objections_overcome === 'boolean' &&
    typeof obj.flags.booked_next_step === 'boolean' &&
    typeof obj.flags.discovery_adequate === 'boolean' &&
    typeof obj.flags.understood_leads_business === 'boolean' &&
    typeof obj.flags.interview_content_quality_good === 'boolean' &&
    obj.framework && typeof obj.framework.recruit_agents_explained === 'boolean' &&
    typeof obj.framework.number_one_podcast_explained === 'boolean' &&
    typeof obj.framework.sell_more_houses_explained === 'boolean' &&
    obj.delivery && typeof obj.delivery.paced_appropriately === 'boolean' &&
    typeof obj.delivery.adapted_to_lead_engagement === 'boolean' &&
    typeof obj.next_step_type === 'string' &&
    typeof obj.manual_review_recommended === 'boolean' &&
    isValidScoreRange_(obj.severity) &&
    typeof obj.root_cause_if_no_booking === 'string');
}

/** Same retry/manual-review shape as scoreTranscript_/scoreSeanTranscript_, against the Bens-specific rubric. */
function scoreBensTranscript_(ctx) {
  var systemPrompt = buildBensJudgeSystemPrompt_();
  var userPrompt = buildJudgeUserPrompt_(ctx);
  var lastRaw = null;

  for (var attempt = 0; attempt <= PHASE2_CONFIG.MAX_PARSE_RETRIES; attempt++) {
    var promptForThisAttempt = attempt === 0
      ? userPrompt
      : userPrompt + '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    try {
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt, 'phase2:bens');
      var parsed = stripFencesAndParseJson_(lastRaw);
      if (!isValidBensJudgeSchema_(parsed)) throw new Error('Parsed JSON missing required Bens-rubric fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ scoreBensTranscript_ attempt ' + (attempt + 1) + ' failed for ' + ctx.prospectName + ': ' + e);
      handleJudgeRetryError_(e, attempt, PHASE2_CONFIG.MAX_PARSE_RETRIES);
    }
  }

  log_('    ↳ ROUTED TO MANUAL REVIEW (parse failed twice) — ' + ctx.prospectName +
    '. Raw model output: ' + String(lastRaw).slice(0, 1000));
  return {
    reasoning: 'JSON parse failed twice — see Apps Script log for raw model output.',
    call_role: 'unclear',
    lead_quality: { verdict: 'good_to_book', justification: 'Unscored — parse failure.' },
    call_quality_score: 1,
    flags: {
      asked_for_close: false, objections_uncovered: false, objections_overcome: false,
      booked_next_step: false, discovery_adequate: false, understood_leads_business: false,
      interview_content_quality_good: false
    },
    framework: { recruit_agents_explained: false, number_one_podcast_explained: false, sell_more_houses_explained: false },
    delivery: { paced_appropriately: false, adapted_to_lead_engagement: false },
    next_step_type: 'none',
    primary_failure_mode: 'none',
    root_cause_if_no_booking: 'Unscored — parse failure.',
    manual_review_recommended: true,
    severity: 5,
    feedback_summary: 'Automated scoring failed twice to return parseable JSON; needs manual review.',
    _parseFailed: true
  };
}

/** Packs the extra Bens-only dimensions into the one free-text column the sheet has (AI Feedback Summary). */
function buildBensFeedbackSummary_(result) {
  var frameworkFields = deriveFrameworkFields_(result);
  var deliveryFields = deriveDeliveryFields_(result);
  return [
    result.feedback_summary,
    '',
    'Call type: ' + result.call_role,
    'Booked next step: ' + result.flags.booked_next_step + ' (' + result.next_step_type + ')',
    'Discovery adequate: ' + result.flags.discovery_adequate +
      ' | Understood their business: ' + result.flags.understood_leads_business,
    'Framework explained: ' + frameworkFields.explained +
      (frameworkFields.gapsText ? ' (missing: ' + frameworkFields.gapsText + ')' : ''),
    'Delivery effective: ' + deliveryFields.effective +
      (deliveryFields.gapsText ? ' (missing: ' + deliveryFields.gapsText + ')' : ''),
    (result.call_role === 'icons_100_interview'
      ? 'Interview content quality: ' + result.flags.interview_content_quality_good
      : ''),
    'Root cause if no booking: ' + result.root_cause_if_no_booking
  ].filter(function (line) { return line !== ''; }).join('\n');
}

// ---------------------------------------------------------------------------
// QC rubric — added 29/08/2026 per Kris: a Qualification Call is not a
// closing call, for ANY rep, the same reason Bens' variant exists — his
// QC-mode logic (SOP §3C) already modeled this correctly but was gated to
// only apply when rep === 'Bens'. This is that same logic generalized to
// apply by CALL TYPE instead, minus the icons_100_interview-only fields
// (call_role/interview_content_quality_good/next_step_type), which are
// specific to Bens' own guest-interview format and don't describe a QC run
// by any other rep. The rep's job on a QC call is to qualify the lead and
// book a Sales Call for someone else on the team (usually Tomás) to close —
// never to ask for money here.
//
// Real bug found live (03/09/2026, Kris): this used to also handle
// "Discovery" calls — a completely different call (the account manager's
// post-sale onboarding/payment call, not a pre-sales-call qualification
// step). Split into its own dedicated variant, see buildDiscoveryJudgeSystemPrompt_
// below — this prompt is QC-only now.
// ---------------------------------------------------------------------------

function buildQcJudgeSystemPrompt_() {
  return [
    'You are a sales-call QA evaluator for a podcast-production offer sold to real estate agents, reviewing a',
    'Qualification Call (QC). This is a pre-sales-call step, not a closing call — the rep\'s job',
    'is to qualify the lead and book a Sales Call for someone else on the team to run (usually Tomás or another',
    'closer), never to ask for money on this call. Applies the same way regardless of which rep ran it.',
    '',
    'This call\'s equivalent of "the close" is explicitly asking to book the Sales Call, at a specific date/time —',
    'not a vague "I\'ll be in touch" or "someone will reach out." Score that the same way a money-ask is scored',
    'on a real sales call: a real, explicit ask, not a soft trial-close question.',
    '',
    'Be skeptical by default. Every judgment must cite specific transcript evidence.',
    '',
    'This is a qualification step, not the sales pitch — it is NOT this rep\'s job to explain the framework (how',
    'the podcast helps recruit agents / builds #1-podcast-in-your-city authority / helps sell more houses). That',
    'is explained on the Sales Call this call is meant to book, by whoever runs it. Do NOT score or penalize this',
    'call for not covering the framework.',
    '',
    'Answer all of the following, in order, in your reasoning:',
    '1. Did the rep uncover any objections/hesitations about booking the Sales Call, and address them with',
    '   something concrete (a case study, a specific benefit, a direct answer) rather than brushing past them?',
    '2. Did the rep explicitly ask to book the Sales Call, with a specific date/time — not just leave it',
    '   open-ended?',
    '3. Did the Sales Call actually get booked? If not, what specifically did the rep fail to do or say that',
    '   would have gotten it booked?',
    '4. Did the rep do real discovery — do they demonstrably understand this lead\'s business and situation, not',
    '   a generic read of the room?',
    '5. Bottom line: if the Sales Call wasn\'t booked, what is the single root cause? Be specific and causal, not',
    '   vague.',
    '',
    deliveryRubricPrompt_(),
    '',
    'Score anchors for call_quality_score (1-5):',
    '5 = Sales Call booked with a specific date/time, objections handled well, and real discovery shown.',
    '4 = Sales Call booked, but one of discovery/objection-handling was weak.',
    '3 = Sales Call booked mainly because the lead pushed for it, not because the rep earned it; or a real ask',
    '    was made but discovery was clearly missing.',
    '2 = Sales Call not booked, the lead was a reasonable fit, and the miss is attributable to the rep\'s',
    '    execution.',
    '1 = Sales Call not booked AND no real attempt at discovery or an ask.',
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text. Put "reasoning" first (walk',
    'through all 5 questions with quoted evidence), then the structured fields, in this exact shape:',
    '',
    '{',
    '  "reasoning": "string",',
    '  "lead_quality": { "verdict": "good_to_book | should_screen_out", "justification": "string" },',
    '  "call_quality_score": 1,',
    '  "flags": {',
    '    "asked_for_close": true,',
    '    "objections_uncovered": true,',
    '    "objections_overcome": true,',
    '    "booked_next_step": true,',
    '    "discovery_adequate": true,',
    '    "understood_leads_business": true',
    '  },',
    '  "delivery": { "paced_appropriately": true, "adapted_to_lead_engagement": true },',
    '  "primary_failure_mode": "none | no_close_ask | objections_missed | weak_discovery | no_second_call_booked | delivery_ineffective | multiple",',
    '  "root_cause_if_no_booking": "string — the single specific reason the Sales Call wasn\'t booked; \\"N/A\\" if it was",',
    '  "manual_review_recommended": true,',
    '  "severity": 1,',
    '  "feedback_summary": "string — 2-3 sentences, coaching-ready. MUST open by quoting the rep\'s own words',
    '   from the transcript for the single most important moment before saying anything else. End with ONE',
    '   specific behavior to change, not a list. Never compare this rep to any other rep by name. Put each',
    '   distinct idea on its own line separated by a literal \\n — never chain them into one dense run-on',
    '   paragraph."',
    '}'
  ].join('\n');
}

function isValidQcJudgeSchema_(obj) {
  return !!(obj &&
    obj.lead_quality && isValidLeadVerdict_(obj.lead_quality.verdict) &&
    isValidScoreRange_(obj.call_quality_score) &&
    obj.flags &&
    typeof obj.flags.asked_for_close === 'boolean' &&
    typeof obj.flags.objections_uncovered === 'boolean' &&
    typeof obj.flags.objections_overcome === 'boolean' &&
    typeof obj.flags.booked_next_step === 'boolean' &&
    typeof obj.flags.discovery_adequate === 'boolean' &&
    typeof obj.flags.understood_leads_business === 'boolean' &&
    obj.delivery && typeof obj.delivery.paced_appropriately === 'boolean' &&
    typeof obj.delivery.adapted_to_lead_engagement === 'boolean' &&
    typeof obj.manual_review_recommended === 'boolean' &&
    isValidScoreRange_(obj.severity) &&
    typeof obj.root_cause_if_no_booking === 'string');
}

/** Same retry/manual-review shape as scoreTranscript_/scoreBensTranscript_, against the QC rubric. */
function scoreQcTranscript_(ctx) {
  var systemPrompt = buildQcJudgeSystemPrompt_();
  var userPrompt = buildJudgeUserPrompt_(ctx);
  var lastRaw = null;

  for (var attempt = 0; attempt <= PHASE2_CONFIG.MAX_PARSE_RETRIES; attempt++) {
    var promptForThisAttempt = attempt === 0
      ? userPrompt
      : userPrompt + '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    try {
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt, 'phase2:qc');
      var parsed = stripFencesAndParseJson_(lastRaw);
      if (!isValidQcJudgeSchema_(parsed)) throw new Error('Parsed JSON missing required QC-rubric fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ scoreQcTranscript_ attempt ' + (attempt + 1) + ' failed for ' + ctx.prospectName + ': ' + e);
      handleJudgeRetryError_(e, attempt, PHASE2_CONFIG.MAX_PARSE_RETRIES);
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
      booked_next_step: false, discovery_adequate: false, understood_leads_business: false
    },
    delivery: { paced_appropriately: false, adapted_to_lead_engagement: false },
    primary_failure_mode: 'none',
    root_cause_if_no_booking: 'Unscored — parse failure.',
    manual_review_recommended: true,
    severity: 5,
    feedback_summary: 'Automated scoring failed twice to return parseable JSON; needs manual review.',
    _parseFailed: true
  };
}

/** Packs the extra QC-only dimensions into the one free-text column the sheet has (AI Feedback Summary).
 * No framework line — QC calls are explicitly not scored on framework explanation, see
 * buildQcJudgeSystemPrompt_'s header comment: that's the Sales Call's job, not this one's. */
function buildQcFeedbackSummary_(result) {
  var deliveryFields = deriveDeliveryFields_(result);
  return [
    result.feedback_summary,
    '',
    'Booked Sales Call: ' + result.flags.booked_next_step,
    'Discovery adequate: ' + result.flags.discovery_adequate +
      ' | Understood their business: ' + result.flags.understood_leads_business,
    'Delivery effective: ' + deliveryFields.effective +
      (deliveryFields.gapsText ? ' (missing: ' + deliveryFields.gapsText + ')' : ''),
    'Root cause if no booking: ' + result.root_cause_if_no_booking
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Discovery-call rubric — added 03/09/2026 per Kris, split off from the QC
// rubric above: "Discovery calls are totally different!" Rewritten the same
// day against the real "SOP for Podcast Discovery Calls" (Google Doc
// 1Z1hGZOyaSThy3pt5rzKRGoh70cp3Immulalt-7cinCs) once Kris said "Use the SOP
// when grading disco calls" — the SOP's own Roles & Responsibilities section
// makes clear this is NOT a payment call: it's the account manager's
// vision-setting call (podcast goals, guest avatar, branding, launch
// strategy), with onboarding handled after. The SOP is silent on payment
// entirely — but Kris's real-world complaint (Sean not confirming payment
// before a Discovery call gets booked) showed up for real in the first two
// live calls reviewed (Jason Pietruszka: contract pending, no payment;
// Stacie Staub: lead says she paid, unconfirmed our side) — kept as its own
// checked dimension for that reason, scored as "did the AM appropriately
// confirm or flag payment status" rather than "did money change hands on
// this call", since the SOP never asks the AM to collect it here.
//
// NOT YET LIVE-VERIFIED END TO END — reviewed against the SOP's written
// requirements and the two real Jason/Stacie transcripts read manually, but
// this exact prompt has not yet been run against either through the live
// Kimi judge. Preview before trusting it, same discipline as every other
// phase in this codebase (see CLAUDE.md).
// ---------------------------------------------------------------------------

function buildDiscoveryJudgeSystemPrompt_() {
  return [
    'You are a QA evaluator for a podcast-production agency, reviewing a Discovery call. This call can have',
    'TWO distinct segments, graded separately, for two different people:',
    '',
    '  SEGMENT 1 — the ORIGINAL SALES REP\'s segment (only when they are present — see rep_present_on_call',
    '  below). Per Kris: "If the sales rep didn\'t get the money on the phone [the earlier Sales Call], but',
    '  got a very strong buying signal, they book a Discovery call. The sales rep still joins the Discovery',
    '  call and is responsible for picking up the payment, then they introduce the AM." This segment is',
    '  graded like a real close: did the rep properly ask for and collect payment, and did they elevate the',
    '  AM with a genuine, warm handoff before dropping off?',
    '',
    '  SEGMENT 2 — the ACCOUNT MANAGER\'s segment (the rest of the call, or all of it if the rep was never on',
    '  it at all). Per the company\'s own SOP for these calls, this is NOT a closing/payment call — the AM\'s',
    '  job is to understand the client\'s podcast vision: goals, ideal guest avatar, branding preferences, and',
    '  launch strategy, with technical onboarding handled afterward. Do NOT penalize the AM for not asking for',
    '  money — that is never their job, it is segment 1\'s job (if segment 1 happened at all).',
    '',
    'Be skeptical by default. Every judgment must cite specific transcript evidence.',
    '',
    'Answer all of the following, in order, in your reasoning:',
    '1. Was the original sales rep present on this call at all (even briefly, just to hand off)? If so, did',
    '   they properly ask for and collect the payment — a real ask, not a soft "we\'ll get you set up"? If they',
    '   were never present, say so plainly rather than guessing — there is nothing to grade for segment 1.',
    '2. (AM segment) Were the podcast\'s goals discussed and tied to the client\'s REAL business objectives',
    '   (e.g. a specific number of transactions, leads, or recruits) rather than vague enthusiasm ("just want',
    '   more visibility")?',
    '3. (AM segment) Was an ideal guest avatar identified (who they\'d want as guests, and why)?',
    '4. (AM segment) Were branding preferences captured (logos/colors/fonts, and comfort with video)?',
    '5. (AM segment) Was a launch strategy discussed (episode frequency, preferred release days, recording',
    '   approach)?',
    '6. (AM segment) Did the client raise any questions or hesitations, and were they addressed with',
    '   something concrete rather than brushed past?',
    '7. (AM segment) Were clear next steps locked in before ending the call — including booking the',
    '   onboarding call with the podcast coordinator, not left open-ended?',
    '',
'8. (Segment 1, only if the rep was present) ' + elevationRubricPrompt_('the account manager'),
    '',
    deliveryRubricPrompt_(),
    '',
    'call_quality_score grades the AM\'s segment (2-7 above) ONLY — the rep\'s payment-collection/elevation',
    'segment is tracked separately via money_collected_by_rep/elevation_done below and must NOT move this',
    'score up or down; a call with a flawless AM segment is a 5 even if the rep\'s handoff was weak, and vice',
    'versa. Score anchors for call_quality_score (1-5):',
    '5 = goals/guest-avatar/branding/launch-strategy all covered with real specifics, next steps locked in.',
    '4 = the above mostly covered, but one area was thin (e.g. goals stayed vague, or next steps were fuzzy).',
    '3 = roughly half the required ground was covered; real gaps remain in what the team now knows about this',
    '    client\'s podcast.',
    '2 = most of the required ground was NOT covered, attributable to the AM\'s execution (not a difficult/',
    '    unresponsive client).',
    '1 = the call barely covered any of the required ground at all.',
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text. Put "reasoning" first (walk',
    'through all the numbered items above with quoted evidence), then the structured fields, in this exact shape:',
    '',
    '{',
    '  "reasoning": "string",',
    '  "lead_quality": { "verdict": "good_to_book", "justification": "string — always good_to_book; this call',
    '   does not re-decide whether the lead was worth pursuing, that was already settled on the Sales Call" },',
    '  "call_quality_score": 1,',
    '  "flags": {',
    '    "asked_for_close": true,',
    '    "objections_uncovered": true,',
    '    "objections_overcome": true,',
    '    "smart_goals_defined": true,',
    '    "guest_avatar_identified": true,',
    '    "branding_preferences_captured": true,',
    '    "launch_strategy_discussed": true,',
    '    "money_collected_by_rep": true,',
    '    "rep_present_on_call": true,',
    '    "elevation_done": true',
    '  },',
    '  "delivery": { "paced_appropriately": true, "adapted_to_lead_engagement": true },',
    '  "primary_failure_mode": "none | vague_goals | no_guest_avatar | no_branding_discussion | no_launch_strategy | unclear_next_steps | money_not_collected_by_rep | delivery_ineffective | multiple",',
    '  "root_cause_if_thin_call": "string — the single specific reason coverage was thin, if call_quality_score is 3 or below; \\"N/A\\" otherwise",',
    '  "manual_review_recommended": true,',
    '  "severity": 1,',
    '  "feedback_summary": "string — 2-3 sentences, coaching-ready. MUST open by quoting the AM\'s own words',
    '   from the transcript for the single most important moment before saying anything else. End with ONE',
    '   specific behavior to change, not a list. Never compare this AM to any other AM by name. Put each',
    '   distinct idea on its own line separated by a literal \\n — never chain them into one dense run-on',
    '   paragraph."',
    '}'
  ].join('\n');
}

/**
 * SOP-content coverage — the four call-agenda items the SOP requires
 * ("SOP for Podcast Discovery Calls" §4). Same "blank = no signal, missing
 * object = every gap listed" convention as deriveFrameworkFields_ — a
 * parse-failure sentinel or any variant that never scores these reads as
 * fully uncovered, not blank, since (unlike discovery/framework on the
 * Sales Call side) this dimension is NEVER legitimately not-applicable for
 * a real Discovery call.
 */
var DISCOVERY_CONTENT_GAP_LABELS_ = {
  smart_goals_defined: 'SMART goals tied to the client\'s real business objectives',
  guest_avatar_identified: 'ideal guest avatar',
  branding_preferences_captured: 'branding preferences (logos/colors/fonts/video comfort)',
  launch_strategy_discussed: 'launch strategy (episode frequency, release days, recording approach)'
};

function deriveDiscoveryContentFields_(result) {
  var flags = (result && result.flags) || {};
  var gapKeys = Object.keys(DISCOVERY_CONTENT_GAP_LABELS_).filter(function (k) { return !flags[k]; });
  return {
    covered: gapKeys.length === 0,
    gapsText: gapKeys.map(function (k) { return DISCOVERY_CONTENT_GAP_LABELS_[k]; }).join(', ')
  };
}

/**
 * Rep's payment-collection check — NOT part of the SOP (which is silent on
 * payment entirely for this call, since the AM never owns it). Kris (real
 * business flow, 03/09/2026): "If the sales rep didn't get the money on the
 * phone, but got a very strong buying signal, they book a Discovery call.
 * The sales rep still joins the Discovery call and is responsible for
 * picking up the payment, then they introduce the AM." Gated on
 * rep_present_on_call exactly like deriveElevationFields_ — if the rep was
 * never on this call at all (money already collected on the earlier Sales
 * Call), there is nothing to grade here, blank not a fabricated failure.
 */
function deriveRepPaymentFields_(result) {
  var flags = (result && result.flags) || {};
  if (typeof flags.rep_present_on_call !== 'boolean' || typeof flags.money_collected_by_rep !== 'boolean') {
    return { collected: '', gapText: '' };
  }
  if (!flags.rep_present_on_call) return { collected: '', gapText: '' };
  return {
    collected: flags.money_collected_by_rep,
    gapText: flags.money_collected_by_rep ? '' :
      'Rep was present on this call but did not collect the payment before handing off to the AM'
  };
}

function isValidDiscoveryJudgeSchema_(obj) {
  return !!(obj &&
    obj.lead_quality && isValidLeadVerdict_(obj.lead_quality.verdict) &&
    isValidScoreRange_(obj.call_quality_score) &&
    obj.flags &&
    typeof obj.flags.asked_for_close === 'boolean' &&
    typeof obj.flags.objections_uncovered === 'boolean' &&
    typeof obj.flags.objections_overcome === 'boolean' &&
    typeof obj.flags.smart_goals_defined === 'boolean' &&
    typeof obj.flags.guest_avatar_identified === 'boolean' &&
    typeof obj.flags.branding_preferences_captured === 'boolean' &&
    typeof obj.flags.launch_strategy_discussed === 'boolean' &&
    typeof obj.flags.money_collected_by_rep === 'boolean' &&
    typeof obj.flags.rep_present_on_call === 'boolean' &&
    typeof obj.flags.elevation_done === 'boolean' &&
    obj.delivery && typeof obj.delivery.paced_appropriately === 'boolean' &&
    typeof obj.delivery.adapted_to_lead_engagement === 'boolean' &&
    typeof obj.manual_review_recommended === 'boolean' &&
    isValidScoreRange_(obj.severity) &&
    typeof obj.root_cause_if_thin_call === 'string');
}

/** Same retry/manual-review shape as scoreQcTranscript_, against the Discovery-call rubric. */
function scoreDiscoveryTranscript_(ctx) {
  var systemPrompt = buildDiscoveryJudgeSystemPrompt_();
  var userPrompt = buildJudgeUserPrompt_(ctx);
  var lastRaw = null;

  for (var attempt = 0; attempt <= PHASE2_CONFIG.MAX_PARSE_RETRIES; attempt++) {
    var promptForThisAttempt = attempt === 0
      ? userPrompt
      : userPrompt + '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    try {
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt, 'phase2:discovery');
      var parsed = stripFencesAndParseJson_(lastRaw);
      if (!isValidDiscoveryJudgeSchema_(parsed)) throw new Error('Parsed JSON missing required Discovery-rubric fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ scoreDiscoveryTranscript_ attempt ' + (attempt + 1) + ' failed for ' + ctx.prospectName + ': ' + e);
      handleJudgeRetryError_(e, attempt, PHASE2_CONFIG.MAX_PARSE_RETRIES);
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
      smart_goals_defined: false, guest_avatar_identified: false,
      branding_preferences_captured: false, launch_strategy_discussed: false,
      money_collected_by_rep: false, rep_present_on_call: false, elevation_done: false
    },
    delivery: { paced_appropriately: false, adapted_to_lead_engagement: false },
    primary_failure_mode: 'none',
    root_cause_if_thin_call: 'Unscored — parse failure.',
    manual_review_recommended: true,
    severity: 5,
    feedback_summary: 'Automated scoring failed twice to return parseable JSON; needs manual review.',
    _parseFailed: true
  };
}

/** Packs the extra Discovery-only dimensions into the one free-text column the sheet has (AI Feedback Summary). */
function buildDiscoveryFeedbackSummary_(result) {
  var deliveryFields = deriveDeliveryFields_(result);
  var elevationFields = deriveElevationFields_(result);
  var contentFields = deriveDiscoveryContentFields_(result);
  var paymentFields = deriveRepPaymentFields_(result);
  return [
    result.feedback_summary,
    '',
    'SOP content covered (AM segment): ' + contentFields.covered +
      (contentFields.gapsText ? ' (missing: ' + contentFields.gapsText + ')' : ''),
    'Money collected by rep (rep segment): ' + (paymentFields.collected === '' ? 'N/A — rep not present on this call' : paymentFields.collected),
    'Elevation (rep segment): ' + (elevationFields.done === '' ? 'N/A — rep not present on this call' : elevationFields.done),
    'Delivery effective: ' + deliveryFields.effective +
      (deliveryFields.gapsText ? ' (missing: ' + deliveryFields.gapsText + ')' : ''),
    'Root cause if thin call: ' + result.root_cause_if_thin_call
  ].join('\n');
}

// ---------------------------------------------------------------------------
// One-off backfill: legacy transcript folders (no Calendar Event ID).
// ---------------------------------------------------------------------------

/** Zero-arg convenience wrapper so this can be run directly from the editor. */
function scoreBensLegacyTranscripts() {
  scoreLegacyTranscriptFolder('Bens', PHASE2_CONFIG.LEGACY_FOLDERS.Bens, scoreBensTranscript_, buildBensFeedbackSummary_);
}

/**
 * ONE-TIME cleanup (22/08/2026): deletes every "Sales Call Log" row for Bens
 * that was scored under the old shared closer rubric (asked_for_close etc.
 * against a rep who never asks for money) before buildBensJudgeSystemPrompt_
 * existed. Every Bens row was written by scoreLegacyTranscriptFolder with
 * Match Method = 'fallback_heuristic', so that's the deletion filter — this
 * intentionally does not touch any other rep's rows.
 *
 * Run this once, confirm the logged count matches what you expect (~42),
 * then run scoreBensLegacyTranscripts() to re-score everything from Drive
 * under the corrected rubric — loadExistingLegacyKeys_ will no longer see
 * these prospect/date pairs as already scored, so they'll be re-judged
 * fresh rather than skipped.
 */
function deleteBensLegacyRows() {
  RUN_TAG = 'deleteBensLegacyRows';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { log_('Sheet is empty — nothing to delete.'); return; }

  var values = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();
  var repCol = SALES_CALL_LOG_HEADERS.indexOf('Rep');
  var matchCol = SALES_CALL_LOG_HEADERS.indexOf('Match Method');
  var nameCol = SALES_CALL_LOG_HEADERS.indexOf('Prospect Name');
  var dateCol = SALES_CALL_LOG_HEADERS.indexOf('Call Date');

  var deleted = 0;
  // Walk bottom-up so deleteRow() doesn't shift the indices of rows not yet visited.
  for (var i = values.length - 1; i >= 0; i--) {
    var row = values[i];
    if (row[repCol] === 'Bens' && row[matchCol] === 'fallback_heuristic') {
      var sheetRow = i + 2; // +2: 1-indexed, plus header row
      log_('  Deleting row ' + sheetRow + ': "' + row[nameCol] + '" (' + row[dateCol] + ')');
      sheet.deleteRow(sheetRow);
      deleted++;
    }
  }

  log_('deleteBensLegacyRows() done — deleted ' + deleted + ' row(s). ' +
    'Run scoreBensLegacyTranscripts() next to re-score them under the corrected rubric.');
}

/**
 * ONE-TIME cleanup (23/08/2026): the runAllLegacyBackfills_ mutex race (fixed
 * above the same day) let concurrent executions each re-score the same early
 * files in Bens' folder against a stale "what's already scored" snapshot —
 * confirmed live: 316 Bens rows for what should have been 14 distinct
 * transcripts, one duplicated up to 35 times. Pure grouping logic pulled out
 * as pickDuplicateRowsToDelete_ so it's unit-testable without a live sheet.
 *
 * Within each duplicate group, keeps the row most likely to carry real human
 * work rather than just the first one written: a row with a real Kris
 * Manual Review Verdict (Yes/No) wins first, then a row marked Reviewed By
 * Kris, then simply the lowest row number (oldest = least likely to be a
 * still-mid-flight duplicate write). Everything else in the group is
 * deleted. Scoped to Match Method = 'fallback_heuristic' rows only, same as
 * deleteBensLegacyRows() above — never touches a real exact_key-matched row.
 */
function pickDuplicateRowsToDelete_(rows) {
  var groups = {};
  rows.forEach(function (r) {
    if (r.matchMethod !== 'fallback_heuristic') return;
    var key = r.rep + '|' + normalize_(r.prospectName) + '|' + r.dateKey;
    (groups[key] = groups[key] || []).push(r);
  });

  function rowRank(r) {
    if (r.krisVerdict === 'Yes' || r.krisVerdict === 'No') return 0;
    if (r.reviewedByKris) return 1;
    return 2;
  }

  var toDelete = [];
  Object.keys(groups).forEach(function (key) {
    var group = groups[key];
    if (group.length < 2) return;
    var sorted = group.slice().sort(function (a, b) {
      var rankDiff = rowRank(a) - rowRank(b);
      if (rankDiff !== 0) return rankDiff;
      return a.rowIndex - b.rowIndex;
    });
    // sorted[0] is the keeper; everything else in this group is a duplicate.
    sorted.slice(1).forEach(function (r) { toDelete.push(r); });
  });
  return toDelete;
}

/** Run this FIRST — logs what dedupeLegacyBackfillDuplicates() would delete, deletes nothing. */
function previewLegacyBackfillDuplicates() {
  RUN_TAG = 'previewLegacyBackfillDuplicates';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }
  var toDelete = findLegacyBackfillDuplicates_(sheet);
  if (!toDelete.length) { log_('No duplicate legacy-backfill rows found.'); return; }
  log_('Found ' + toDelete.length + ' duplicate row(s) that dedupeLegacyBackfillDuplicates() would delete:');
  toDelete.forEach(function (r) {
    log_('  Row ' + r.rowIndex + ': "' + r.prospectName + '" (' + r.dateKey + ', ' + r.rep + ')');
  });
}

function findLegacyBackfillDuplicates_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var col = getValidatedColumnMap_(sheet);
  var values = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();
  var rows = values.map(function (row, i) {
    var date = row[col['Call Date'] - 1];
    var dateKey = date instanceof Date ? Utilities.formatDate(date, CONFIG.BUSINESS_TIMEZONE, 'yyyy-MM-dd') : String(date || '');
    return {
      rowIndex: i + 2,
      rep: row[col['Rep'] - 1],
      prospectName: row[col['Prospect Name'] - 1],
      dateKey: dateKey,
      matchMethod: row[col['Match Method'] - 1],
      reviewedByKris: !!row[col['Reviewed By'] - 1],
      krisVerdict: String(row[col['Kris Manual Review Verdict'] - 1] || '').trim()
    };
  });
  return pickDuplicateRowsToDelete_(rows);
}

/** Run previewLegacyBackfillDuplicates() first. Deletes every row it identified as a duplicate. */
function dedupeLegacyBackfillDuplicates() {
  RUN_TAG = 'dedupeLegacyBackfillDuplicates';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }
  var toDelete = findLegacyBackfillDuplicates_(sheet);
  if (!toDelete.length) { log_('No duplicate legacy-backfill rows found — nothing to delete.'); return; }

  // Bottom-to-top so deleteRow() doesn't shift the indices of rows not yet visited.
  toDelete.sort(function (a, b) { return b.rowIndex - a.rowIndex; });
  toDelete.forEach(function (r) {
    sheet.deleteRow(r.rowIndex);
    log_('  Deleted row ' + r.rowIndex + ': "' + r.prospectName + '" (' + r.dateKey + ', ' + r.rep + ')');
  });
  log_('dedupeLegacyBackfillDuplicates() done — deleted ' + toDelete.length + ' duplicate row(s).');
}

// ---------------------------------------------------------------------------
// ONE-TIME data repair (23/08/2026): fixes already-written Call Date values
// for every Sean/Joana/Tomás row scored before resolveRealCallDate_() above
// existed — every one of these was silently written as the TRANSCRIPT DOC's
// own creation date (whenever the pipeline happened to run), not the real
// call date. Confirmed live: rows whose own Prospect Name starts with the
// real date ("1/21 Anthony Camperi") were logged with a Call Date from a
// bulk backlog transcription run days or weeks later. Bens is unaffected
// (his date comes straight from the legacy filename, never from
// getDateCreated()) and is intentionally excluded here.
// ---------------------------------------------------------------------------

var CALL_DATE_REPAIR_FOLDERS_ = {
  Sean: PHASE2_CONFIG.SEAN_FOLDERS,
  'Tomás': PHASE2_CONFIG.TOMAS_FOLDERS,
  Joana: PHASE2_CONFIG.JOANA_FOLDERS
};

/** First matching sibling file's creation date across every folder configured for a rep — checks each in turn, stops at the first hit. */
function findVideoCreatedDateAcrossFolders_(folderIds, name) {
  for (var i = 0; i < folderIds.length; i++) {
    var date = findSiblingFileCreatedDate_(DriveApp.getFolderById(folderIds[i]), name);
    if (date) return date;
  }
  return null;
}

/**
 * Re-derives the correct Call Date for every in-scope row using the same
 * logic resolveRealCallDate_() applies going forward, and returns only the
 * ones that actually need correcting. Skipped (left alone) when neither a
 * title date nor a sibling video can be found — better to leave a wrong-but-
 * already-known date than silently guess with nothing to anchor it to.
 */
function computeCallDateFixes_(sheet) {
  var col = getValidatedColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();
  var fixes = [];

  values.forEach(function (row, i) {
    var rep = row[col['Rep'] - 1];
    var folders = CALL_DATE_REPAIR_FOLDERS_[rep];
    if (!folders) return; // Bens, or an unrecognized rep -- not in scope
    if (row[col['Match Method'] - 1] !== 'fallback_heuristic') return;

    var prospectName = row[col['Prospect Name'] - 1];
    var storedDate = row[col['Call Date'] - 1];
    var folderIds = Object.keys(folders).map(function (k) { return folders[k]; });

    var monthDay = parseDateFromTitlePrefix_(prospectName);
    var siblingDate = findVideoCreatedDateAcrossFolders_(folderIds, prospectName);
    if (!monthDay && !siblingDate) return; // nothing to anchor a correction to -- leave as-is

    var ceilingDate = siblingDate || (storedDate instanceof Date ? storedDate : new Date());
    var correctDate = monthDay ? resolveYearForMonthDay_(monthDay, ceilingDate) : ceilingDate;

    var storedStr = storedDate instanceof Date
      ? Utilities.formatDate(storedDate, CONFIG.BUSINESS_TIMEZONE, 'yyyy-MM-dd')
      : String(storedDate);
    var correctStr = Utilities.formatDate(correctDate, CONFIG.BUSINESS_TIMEZONE, 'yyyy-MM-dd');
    if (storedStr === correctStr) return; // already correct

    fixes.push({
      rowIndex: i + 2, rep: rep, prospectName: prospectName,
      oldDateStr: storedStr, newDate: correctDate, newDateStr: correctStr
    });
  });

  return fixes;
}

/** Run this FIRST. Logs every Call Date correction it would make — writes nothing. */
function previewCallDateRepair() {
  RUN_TAG = 'previewCallDateRepair';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }
  var fixes = computeCallDateFixes_(sheet);
  if (!fixes.length) { log_('No Call Date corrections found.'); return; }
  log_('Found ' + fixes.length + ' row(s) needing a Call Date correction:');
  fixes.forEach(function (f) {
    log_('  Row ' + f.rowIndex + ' (' + f.rep + ', "' + f.prospectName + '"): ' + f.oldDateStr + ' -> ' + f.newDateStr);
  });
}

/** Run previewCallDateRepair() first. Actually writes every correction it found. */
function repairCallDates() {
  RUN_TAG = 'repairCallDates';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }
  var col = getValidatedColumnMap_(sheet);
  var fixes = computeCallDateFixes_(sheet);
  if (!fixes.length) { log_('No Call Date corrections found — nothing to do.'); return; }
  fixes.forEach(function (f) {
    sheet.getRange(f.rowIndex, col['Call Date']).setValue(f.newDate);
    log_('  Row ' + f.rowIndex + ' (' + f.rep + ', "' + f.prospectName + '"): ' + f.oldDateStr + ' -> ' + f.newDateStr);
  });
  log_('repairCallDates() done — corrected ' + fixes.length + ' row(s).');
}

// ---------------------------------------------------------------------------
// ONE-TIME data repair (28/08/2026): same shape as the Call Date repair
// above, for the same root cause — every Sean/Joana/Tomás row already
// written has whatever filename cruft cleanProspectNameForSheet_ now
// strips going forward (a leading "1/21 " date token, a trailing ".mp4"
// extension, a trailing "Sales Call"/"QC & SC" descriptor), since the
// scorers only ever stripped the "— Transcript" suffix before this fix.
// Confirmed live via a GHL contact-matching preview (Phase9_GhlSync.gs):
// every one of 12 sampled rows with cruft like this failed to match a real
// GHL contact by name; every clean Bens name matched. Bens is unaffected
// and intentionally excluded (his name comes from parseLegacyFilename_,
// never touched here) — same scoping as CALL_DATE_REPAIR_FOLDERS_ above.
// ---------------------------------------------------------------------------

/**
 * Re-derives the correct Prospect Name for every in-scope row using
 * cleanProspectNameForSheet_, and returns only the ones that actually
 * change. Scoped to fallback_heuristic rows for Sean/Joana/Tomás — same
 * rep list as CALL_DATE_REPAIR_FOLDERS_, reused here as the "is this rep
 * in scope" check rather than duplicating the rep list a third time.
 */
function computeProspectNameFixes_(sheet) {
  var col = getValidatedColumnMap_(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();
  var fixes = [];

  values.forEach(function (row, i) {
    var rep = row[col['Rep'] - 1];
    if (!CALL_DATE_REPAIR_FOLDERS_[rep]) return; // Bens, or an unrecognized rep -- not in scope
    if (row[col['Match Method'] - 1] !== 'fallback_heuristic') return;

    var storedName = row[col['Prospect Name'] - 1];
    var cleanedName = cleanProspectNameForSheet_(storedName);
    if (cleanedName === storedName || !cleanedName) return; // already clean, or cleaning would empty it out -- leave alone either way

    fixes.push({ rowIndex: i + 2, rep: rep, oldName: storedName, newName: cleanedName });
  });

  return fixes;
}

/** Run this FIRST. Logs every Prospect Name correction it would make — writes nothing. */
function previewProspectNameRepair() {
  RUN_TAG = 'previewProspectNameRepair';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }
  var fixes = computeProspectNameFixes_(sheet);
  if (!fixes.length) { log_('No Prospect Name corrections found.'); return; }
  log_('Found ' + fixes.length + ' row(s) needing a Prospect Name correction:');
  fixes.forEach(function (f) {
    log_('  Row ' + f.rowIndex + ' (' + f.rep + '): "' + f.oldName + '" -> "' + f.newName + '"');
  });
}

/** Run previewProspectNameRepair() first. Actually writes every correction it found. */
function repairProspectNames() {
  RUN_TAG = 'repairProspectNames';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return; }
  var col = getValidatedColumnMap_(sheet);
  var fixes = computeProspectNameFixes_(sheet);
  if (!fixes.length) { log_('No Prospect Name corrections found — nothing to do.'); return; }
  fixes.forEach(function (f) {
    sheet.getRange(f.rowIndex, col['Prospect Name']).setValue(f.newName);
    log_('  Row ' + f.rowIndex + ' (' + f.rep + '): "' + f.oldName + '" -> "' + f.newName + '"');
  });
  log_('repairProspectNames() done — corrected ' + fixes.length + ' row(s).');
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
  var files = getFilesRecursive_(folder); // recurses into subfolders — see getFilesRecursive_'s comment
  var n = 0;
  while (files.hasNext()) {
    var file = files.next();
    var parsed = parseLegacyFilename_(file.getName());
    n++;
    if (!parsed) {
      log_('  SKIP (name did not match convention): "' + file.getName() + '"');
      continue;
    }
    var key = normalize_(parsed.prospectName) + '|' + parsed.dateStr + '|' + normalize_(repName);
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
  // Real bug found live (25/08/2026): this used the plain `new Date(y, m-1, d)`
  // constructor, which silently uses the Apps Script PROJECT's own default
  // timezone (appsscript.json — Asia/Bangkok, confirmed live), not
  // CONFIG.BUSINESS_TIMEZONE. loadExistingLegacyKeys_ later re-reads that same
  // Date and reformats it via CONFIG.BUSINESS_TIMEZONE ('America/New_York') —
  // an ~11-12 hour gap wide enough to roll every single legacy-backfilled
  // date back one calendar day on every re-read, so its dedup key never
  // matched this function's own key (built straight from dateStr, no
  // timezone involved) — every legacy transcript got rescored and
  // re-appended as a new row on every firing, forever, not just occasionally.
  // dateAtMidnightInBusinessTimezone_ (below) is this codebase's own
  // established fix for exactly this anti-pattern — resolveYearForMonthDay_
  // already uses it for the same reason; this just closes the one call site
  // that was missed.
  var date = dateAtMidnightInBusinessTimezone_(Number(m[1]), Number(m[2]), Number(m[3]));
  return { dateStr: dateStr, date: date, prospectName: prospectName, rawSlug: m[4] };
}

/** Map of "normalized name|YYYY-MM-DD" → true for every existing Sales Call Log row. */
function loadExistingLegacyKeys_(sheet) {
  var keys = {};
  if (!sheet) return keys;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return keys;
  var values = sheet.getRange(2, 1, lastRow - 1, 5).getValues(); // A:Name, D:Call Date, E:Rep
  values.forEach(function (row) {
    var name = row[0], date = row[3], rep = row[4];
    if (!name || !date) return;
    var d = (date instanceof Date) ? Utilities.formatDate(date, CONFIG.BUSINESS_TIMEZONE, 'yyyy-MM-dd') : String(date);
    // Real bug found live (26/08/2026 silent-failure audit): this key used
    // to omit Rep entirely, so a real second call for the same prospect on
    // the same day by a DIFFERENT rep (e.g. Bens runs a QC, Tomás closes the
    // same prospect that afternoon — exactly the documented funnel) computed
    // an identical key and silently skipped as "already exists", with no log
    // line distinguishing it from a genuine duplicate.
    keys[normalize_(name) + '|' + d + '|' + normalize_(rep)] = true;
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
 *
 * judgeFn/feedbackSummaryFn let a rep use a different rubric than the shared
 * one (e.g. scoreBensTranscript_/buildBensFeedbackSummary_ — Bens isn't a
 * closer, see the section above) without forking this whole function.
 */
function scoreLegacyTranscriptFolder(repName, folderId, judgeFn, feedbackSummaryFn) {
  RUN_TAG = 'scoreLegacyTranscriptFolder';
  judgeFn = judgeFn || scoreTranscript_;
  feedbackSummaryFn = feedbackSummaryFn || function (result) { return result.feedback_summary; };
  if (!folderId) { log_('No folder ID configured for ' + repName + ' — nothing to do.'); return; }

  // This was the ONLY scoring path in the file without a lock of its own,
  // and it is exactly the one that produced 306 duplicate Bens rows
  // (23-25/08/2026): two overlapping runs each read their own
  // loadExistingLegacyKeys_ snapshot, so each saw the same file as unscored
  // and appended its own row. runAllLegacyBackfills_'s mutex only guards
  // runs started through *it* — it can't stop a dedicated trigger, a manual
  // editor run, or a leftover stacked trigger from overlapping with one.
  // Guarding the function itself is what actually closes that hole.
  // Not nested inside any other lock: both callers
  // (scoreBensLegacyTranscripts / scoreJoanaLegacyTranscripts) are zero-arg
  // wrappers holding nothing, and runAllLegacyBackfills_ releases its gate
  // before any scoring starts.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('scoreLegacyTranscriptFolder(' + repName + '): another scoring run holds the lock, ' +
      'skipping this firing.');
    return;
  }

  try {
    var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
    var sheet = resolveSheet_(ss, 'Sales Call Log');
    if (!sheet) { log_('No Sales Call Log tab found — run setupSalesCallLog() first.'); return; }

    // Real bug found live (26/08/2026 silent-failure audit): this function
    // appends 18-20 positional values via appendRow with no header check at
    // all, unlike every OTHER sheet-writing function in this file. A drifted
    // header (a column inserted/renamed) means every value below lands one
    // column off with no error. getValidatedColumnMap_ throws (and alerts)
    // loudly on any mismatch before a single row gets written.
    getValidatedColumnMap_(sheet);

    var existing = loadExistingLegacyKeys_(sheet);
    var folder = DriveApp.getFolderById(folderId);
    var files = getFilesRecursive_(folder); // recurses into subfolders — see getFilesRecursive_'s comment

    var scored = 0, skippedExisting = 0, skippedUnparsed = 0, failed = 0;
    // Match Method is always 'fallback_heuristic' for this function (see the
    // appendRow below) — resolveRubricVariantForRow_ on that basis correctly
    // resolves 'bens' for the Bens caller and 'shared' for the Joana-legacy
    // caller (scoreJoanaLegacyTranscripts passes no judgeFn override).
    var analyticScoreVariant = resolveRubricVariantForRow_(repName, 'fallback_heuristic');

    while (files.hasNext()) {
      var file = files.next();
      var parsed = parseLegacyFilename_(file.getName());
      if (!parsed) {
        log_('  SKIP (name did not match convention): "' + file.getName() + '"');
        skippedUnparsed++;
        continue;
      }
      var key = normalize_(parsed.prospectName) + '|' + parsed.dateStr + '|' + normalize_(repName);
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
        var result = judgeFn(ctx);
        var objectionsHandled = result.flags.objections_uncovered && result.flags.objections_overcome;
        var frameworkFields = deriveFrameworkFields_(result);
        var deliveryFields = deriveDeliveryFields_(result);
        var discoveryFields = deriveDiscoveryFields_(result);
        var bookingFields = deriveBookingDecisionFields_(result);
        var elevationFields = deriveElevationFields_(result);

        // Analytic-score shadow check (QA_COACHING_RESEARCH_REPORT.md §1.4) —
        // logs a comparison only, never changes what's appended below.
        logAnalyticScoreShadowCheck_(parsed.prospectName, analyticScoreVariant, result);
        // FUTURE (not built — see ANALYTIC_SCORE_CONFIG): if ANALYTIC_SCORE_CONFIG.ENABLED
        // is ever flipped true, the "Call Quality Score" entry in the appendRow
        // below would use the analytic score instead of result.call_quality_score.

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
          feedbackSummaryFn(result),      // AI Feedback Summary
          '',                          // Reviewed By
          0,                               // Queue Age
          '',                              // Kris Manual Review Verdict — not yet judged
          result.primary_failure_mode || 'none', // Primary Failure Mode
          frameworkFields.explained,      // Flag: Framework Explained
          frameworkFields.gapsText,       // Framework Gaps
          RUBRIC_VERSION,                 // Rubric Version
          deliveryFields.effective,       // Flag: Delivery Effective
          deliveryFields.gapsText,        // Delivery Gaps
          discoveryFields.adequate,       // Flag: Discovery Adequate
          discoveryFields.gapsText,        // Discovery Gaps
          bookingFields.appropriate,      // Flag: Booking Decision Appropriate
          bookingFields.gapText,           // Booking Decision Gap
          elevationFields.done,           // Flag: Elevation Done
          elevationFields.gapText         // Elevation Gap
        ]);

        // Real bug found live (23/08/2026): this in-memory update was missing
        // here even though loadExistingLegacyKeys_'s whole purpose is
        // per-file dedup — Joana's separate copy of this loop (scoreJoanaTranscripts)
        // already did this correctly. Without it, two files in the same folder
        // pass that parse to the same (name, date) key would both get scored
        // and appended in a single run. The dominant cause of the ~300 duplicate
        // Bens rows found the same day was actually concurrent executions (see
        // the atomic-mutex fix on runAllLegacyBackfills_ below), but this was a
        // real, separate gap worth closing regardless.
        existing[key] = true;

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
  } finally {
    lock.releaseLock();
  }
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
    '4b. This call follows an earlier QC/qualification call, so did the rep CONFIRM what that call already',
    '   surfaced ("you mentioned you\'re at about 30 transactions a year — still right?") rather than re-asking',
    '   it cold as if it never happened, or silently assuming it? AND did they go DEEPER where that earlier',
    '   discovery was thin, following up on whatever was left vague? Score confirmed_prior_discovery true only',
    '   if both happened. If the transcript shows this was genuine first contact with no earlier call behind',
    '   it, score it TRUE — never mark a rep down for the absence of a conversation that never happened.',
    '5. Did the rep capture the lead\'s actual stated goals, and explicitly connect the podcast framework back',
    '   to achieving those specific goals — not a generic pitch that would fit any lead?',
    '6. Bottom line: if the call ended with no money and no second call booked, what is the single root cause?',
    '   Be specific and causal ("never asked what her production goal was, so had nothing to tie the offer',
    '   to"), not vague ("bad fit" / "bad vibes").',
    '',
    frameworkRubricPrompt_(),
    '',
    deliveryRubricPrompt_(),
    '',
    bookingDecisionRubricPrompt_(),
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
    '    "confirmed_prior_discovery": true,',
    '    "captured_leads_goals": true,',
    '    "tied_framework_to_goals": true,',
    '    "booked_second_call_with_tomas": true,',
    '    "booked_discovery_call": false,',
    '    "lead_ready_with_money": true',
    '  },',
    '  "framework": { "recruit_agents_explained": true, "number_one_podcast_explained": true, "sell_more_houses_explained": true },',
    '  "delivery": { "paced_appropriately": true, "adapted_to_lead_engagement": true },',
    '  "primary_failure_mode": "none | no_close_ask | objections_missed | weak_discovery | no_goal_alignment | no_second_call_booked | framework_not_explained | delivery_ineffective | multiple",',
    '  "root_cause_if_no_sale": "string — the single specific reason money wasn\'t closed and no second call',
    '   was booked; \\"N/A\\" if a sale closed or a second call was booked",',
    '  "manual_review_recommended": true,',
    '  "severity": 1,',
    '  "feedback_summary": "string — 4-6 sentences, coaching-ready, must explicitly cover: objection',
    '   handling, whether he asked for the money, why a second call with Tomás was/wasn\'t booked, discovery',
    '   quality, goal-alignment, and the root cause if nothing closed. MUST open by quoting his own words',
    '   from the transcript for the single most important moment before saying anything else. End with ONE',
    '   specific behavior to change, not a list. Never compare him to any other rep by name. Put each distinct',
    '   idea on its own line separated by a literal \\n (the quoted moment, then each separate observation,',
    '   then the root cause, then the one behavior to change) — never chain them into one dense run-on',
    '   paragraph."',
    '}'
  ].join('\n');
}

function isValidSeanJudgeSchema_(obj) {
  return !!(obj &&
    obj.lead_quality && isValidLeadVerdict_(obj.lead_quality.verdict) &&
    isValidScoreRange_(obj.call_quality_score) &&
    obj.flags &&
    typeof obj.flags.asked_for_close === 'boolean' &&
    typeof obj.flags.objections_uncovered === 'boolean' &&
    typeof obj.flags.objections_overcome === 'boolean' &&
    typeof obj.flags.discovery_adequate === 'boolean' &&
    typeof obj.flags.understood_leads_business === 'boolean' &&
    typeof obj.flags.confirmed_prior_discovery === 'boolean' &&
    typeof obj.flags.captured_leads_goals === 'boolean' &&
    typeof obj.flags.tied_framework_to_goals === 'boolean' &&
    typeof obj.flags.booked_second_call_with_tomas === 'boolean' &&
    typeof obj.flags.booked_discovery_call === 'boolean' &&
    typeof obj.flags.lead_ready_with_money === 'boolean' &&
    obj.framework && typeof obj.framework.recruit_agents_explained === 'boolean' &&
    typeof obj.framework.number_one_podcast_explained === 'boolean' &&
    typeof obj.framework.sell_more_houses_explained === 'boolean' &&
    obj.delivery && typeof obj.delivery.paced_appropriately === 'boolean' &&
    typeof obj.delivery.adapted_to_lead_engagement === 'boolean' &&
    typeof obj.manual_review_recommended === 'boolean' &&
    isValidScoreRange_(obj.severity) &&
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
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt, 'phase2:sean');
      var parsed = stripFencesAndParseJson_(lastRaw);
      if (!isValidSeanJudgeSchema_(parsed)) throw new Error('Parsed JSON missing required Sean-rubric fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ scoreSeanTranscript_ attempt ' + (attempt + 1) + ' failed for ' + ctx.prospectName + ': ' + e);
      handleJudgeRetryError_(e, attempt, PHASE2_CONFIG.MAX_PARSE_RETRIES);
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
      discovery_adequate: false, understood_leads_business: false, confirmed_prior_discovery: false,
      captured_leads_goals: false, tied_framework_to_goals: false,
      booked_second_call_with_tomas: false,
      booked_discovery_call: false, lead_ready_with_money: false
    },
    framework: { recruit_agents_explained: false, number_one_podcast_explained: false, sell_more_houses_explained: false },
    delivery: { paced_appropriately: false, adapted_to_lead_engagement: false },
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
  var frameworkFields = deriveFrameworkFields_(result);
  var deliveryFields = deriveDeliveryFields_(result);
  return [
    result.feedback_summary,
    '',
    'Discovery adequate: ' + result.flags.discovery_adequate +
      ' | Understood lead\'s business: ' + result.flags.understood_leads_business,
    'Captured lead\'s goals: ' + result.flags.captured_leads_goals +
      ' | Tied framework to goals: ' + result.flags.tied_framework_to_goals,
    'Framework explained: ' + frameworkFields.explained +
      (frameworkFields.gapsText ? ' (missing: ' + frameworkFields.gapsText + ')' : ''),
    'Delivery effective: ' + deliveryFields.effective +
      (deliveryFields.gapsText ? ' (missing: ' + deliveryFields.gapsText + ')' : ''),
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
    var files = getFilesRecursive_(folder);
    while (files.hasNext()) {
      var file = files.next();
      var name = file.getName();
      if (name.indexOf('Transcript') === -1) continue; // skip source videos, only match transcript docs
      var prospectName = name.replace(/[—-]?\s*Transcript\s*$/i, '').trim();
      // Real bug found live (26/08/2026 silent-failure audit): this preview
      // used file.getDateCreated() — the exact bug documented as fixed below
      // for the real scorer (see the comment on resolveRealCallDate_) — so
      // the preview and the scorer it's meant to gate could disagree on
      // whether a file is "new" or "already scored", in either direction.
      var callDate = resolveRealCallDate_(files.currentFolder(), prospectName, file);
      var dateStr = Utilities.formatDate(callDate, CONFIG.BUSINESS_TIMEZONE, 'yyyy-MM-dd');
      // normalize_(cleanProspectNameForSheet_(...)), not the raw prospectName:
      // the sheet's own Prospect Name column holds the cleaned value (see
      // cleanProspectNameForSheet_'s appendRow use below / the one-time
      // repairProspectNames() repair) — keying off the uncleaned name here
      // would silently stop matching existing[] after that repair runs,
      // re-scoring and duplicating every already-repaired row.
      var key = normalize_(cleanProspectNameForSheet_(prospectName)) + '|' + dateStr + '|' + normalize_('Sean');
      n++;
      log_('  [' + label + '] "' + name + '" → ' + prospectName + ' / ' + dateStr +
        (existing[key] ? '  [already has a Sales Call Log row]' : '  [new]'));
    }
  });
  log_('previewSeanTranscripts — ' + n + ' transcript doc(s) found across both folders.');
}

/**
 * Real bug found live (23/08/2026), affecting scoreSeanTranscripts(),
 * scoreJoanaTranscripts(), and scoreTomasTranscripts() identically: all
 * three wrote Call Date as file.getDateCreated() on the TRANSCRIPT DOC
 * itself — whenever the Whisper/Gemini pipeline happened to actually
 * transcribe it — not when the call happened. Confirmed live: Sean's rows
 * whose own prospect name STARTS WITH the real date ("1/21 Anthony
 * Camperi") were logged with Call Date = the day of a bulk backlog
 * transcription run instead. This silently corrupts every date-based
 * feature downstream — weekly scorecard week-bucketing, the rolling
 * 4-week average, the dashboard's score-over-time chart — a whole backlog
 * transcribed in one sitting reads as "all happened this week."
 *
 * Fix: parse a real "M/D " date prefix out of the title first (Sean's and
 * Tomás's convention); Joana's titles have no date in them at all, so fall
 * back to the paired ORIGINAL VIDEO's own creation date (found by name
 * match in the same folder) — not the transcript doc's, which only
 * reflects pipeline timing, not the real world.
 */
function parseDateFromTitlePrefix_(title) {
  var m = String(title || '').match(/^\s*(\d{1,2})\/(\d{1,2})\s+\S/);
  if (!m) return null;
  var month = parseInt(m[1], 10), day = parseInt(m[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month: month, day: day };
}

/**
 * Timezone-safe: builds a real Date instant representing midnight on
 * year/month/day IN CONFIG.BUSINESS_TIMEZONE. Real bug found live
 * (23/08/2026), caught in preview before it ever wrote anything: the plain
 * multi-arg `new Date(year, month, day)` constructor silently builds
 * midnight in the Apps Script PROJECT's own default script timezone —
 * confirmed live to be GMT+7 (Indochina Time) for this project, NOT
 * CONFIG.BUSINESS_TIMEZONE (America/Los_Angeles). That ~15-hour gap shifted
 * every one of resolveYearForMonthDay_'s dates a full day earlier once
 * reformatted for storage/display in America/Los_Angeles — every single
 * row in previewCallDateRepair_'s first run was off by exactly one day.
 * Same two-step trick as startOfDay_ (Phase1_ComplianceCheck.gs): build a
 * rough instant just to ask Utilities for the correct DST offset on
 * (approximately) that day, then construct the real instant explicitly
 * with that offset — noon, not midnight, for the rough instant, so even a
 * wildly different default timezone still lands it on the intended
 * calendar day before asking for the offset.
 */
function dateAtMidnightInBusinessTimezone_(year, month, day) {
  var pad = function (n) { return n < 10 ? '0' + n : String(n); };
  var dateStr = year + '/' + pad(month) + '/' + pad(day);
  var rough = new Date(dateStr + ' 12:00:00');
  var offset = Utilities.formatDate(rough, CONFIG.BUSINESS_TIMEZONE, 'Z');
  return new Date(dateStr + ' 00:00:00 GMT' + offset);
}

/**
 * Picks the year for a parsed month/day: the call can't have happened AFTER
 * ceilingDate (the video's own upload date, at the latest), so this prefers
 * ceilingDate's year (read in CONFIG.BUSINESS_TIMEZONE, not the script's
 * own default timezone — same reasoning as dateAtMidnightInBusinessTimezone_
 * above), falling back to the year before if the same-year candidate would
 * land clearly in the future relative to ceilingDate.
 *
 * "Clearly" means more than YEAR_ROLLBACK_SLACK_MS_ — a real year mismatch
 * is always ~365 days off, so a couple of days of slack can never mask one.
 * That slack is required because ceilingDate is frequently the sibling
 * video's own creation instant for the SAME call, and Drive's createdTime is
 * UTC: a video created a few minutes after UTC midnight (e.g. "4/2 ... ",
 * createdTime 2026-04-02T00:13Z) lands the evening before once read back in
 * CONFIG.BUSINESS_TIMEZONE (America/New_York, UTC-4/-5) — 2026-04-01 ~8pm
 * Eastern. Without slack, midnight-of-the-titled-day compares as "later"
 * than that instant and this function wrongly concludes the call must be
 * from the PREVIOUS year. Confirmed live (23/08/2026): Sean's "4/2 Margaret
 * Bruno prep call for DISCO" resolved to 2025-04-02 instead of 2026-04-02
 * for exactly this reason, caught in a preview before repairCallDates() ran.
 */
var YEAR_ROLLBACK_SLACK_MS_ = 2 * 24 * 60 * 60 * 1000; // 2 days

function resolveYearForMonthDay_(monthDay, ceilingDate) {
  var year = Number(Utilities.formatDate(ceilingDate, CONFIG.BUSINESS_TIMEZONE, 'yyyy'));
  var candidate = dateAtMidnightInBusinessTimezone_(year, monthDay.month, monthDay.day);
  if (candidate.getTime() - ceilingDate.getTime() > YEAR_ROLLBACK_SLACK_MS_) {
    candidate = dateAtMidnightInBusinessTimezone_(year - 1, monthDay.month, monthDay.day);
  }
  return candidate;
}

/** The paired original video's own creation date, found by exact name match in the same (non-recursive) folder. Null if no match. */
function findSiblingFileCreatedDate_(folder, name) {
  var candidates = folder.getFilesByName(name);
  if (candidates.hasNext()) return candidates.next().getDateCreated();
  return null;
}

/**
 * Best-effort real call date for a legacy transcript: a date parsed from the
 * title wins if present; otherwise falls back to the paired video's own
 * creation date; otherwise (no sibling video found — shouldn't normally
 * happen) the transcript doc's own creation date, same as the old behavior.
 */
function resolveRealCallDate_(folder, prospectName, transcriptFile) {
  var siblingDate = findSiblingFileCreatedDate_(folder, prospectName);
  var ceilingDate = siblingDate || transcriptFile.getDateCreated();
  var monthDay = parseDateFromTitlePrefix_(prospectName);
  return monthDay ? resolveYearForMonthDay_(monthDay, ceilingDate) : ceilingDate;
}

/**
 * Strips filename cruft that survives into the Prospect Name column for
 * Sean/Joana/Tomás's ongoing scorers (scoreSeanTranscripts/
 * scoreJoanaTranscripts/scoreTomasTranscripts below) — those only ever
 * strip the trailing "— Transcript"/"- Transcript" suffix from the raw
 * filename, so whatever the underlying video's own filename convention
 * embedded rides straight into the sheet untouched. Confirmed live
 * (28/08/2026, via a GHL contact-matching preview — Phase9_GhlSync.gs):
 * real values already in the Sales Call Log include "1/21 Anthony
 * Camperi", "Will Salinas SC.mp4", "LUCY QUINONES Sales Call". Beyond
 * being ugly, this silently broke exact-name matching against GHL — every
 * one of 12 sampled rows with cruft like this failed to match a real GHL
 * contact, while every clean name (Bens', whose legacy path already goes
 * through parseLegacyFilename_ above) matched.
 *
 * IMPORTANT: only ever apply this to the value actually WRITTEN into the
 * "Prospect Name" column — never to the `prospectName` used earlier for
 * resolveRealCallDate_/the dedup key in each scorer. A leading date token
 * there is load-bearing: parseDateFromTitlePrefix_ reads it to resolve the
 * real call date for Sean's older Qualification Calls naming convention,
 * so stripping it before that call would silently break date resolution.
 */
function cleanProspectNameForSheet_(rawName) {
  var name = String(rawName || '').trim();

  // Leading "M/D" or "M/D/YY" date token ("1/21 Anthony Camperi") — a
  // different convention than the "YYMMDD_" prefix parseLegacyFilename_
  // already handles elsewhere, so this doesn't overlap or conflict with it.
  name = name.replace(/^\d{1,2}\/\d{1,2}(\/\d{2,4})?\s+/, '');

  // Trailing file extension surviving from the original video filename —
  // the transcript doc is named "<video name, extension included> —
  // Transcript" (same root cause as the identical finding in Phase7/
  // Phase8 this session), and the bare "— Transcript" strip in each
  // scorer never accounted for an extension sitting in front of it.
  name = name.replace(/\.[a-z0-9]{2,5}$/i, '');

  // Trailing call-type descriptor from the same source filename — grounded
  // in this system's own Call Type vocabulary (QC / Sales Call / Discovery
  // / Second Call — see SALES_CALL_LOG_HEADERS and PHASE2_CONFIG.TOMAS_FOLDERS'
  // "Sales Calls"/"Second Calls" labels), not an arbitrary guess. Order
  // matters — longer, more specific phrases first, so e.g. "QC & SC"
  // doesn't get caught by a bare "SC" rule and leave "QC &" behind.
  [
    /\s+QC\s*&\s*SC$/i,
    /\s+Second\s+Sales\s+Call$/i,
    /\s+Second\s+Call$/i,
    /\s+Sales\s+Call$/i,
    /\s+Discovery\s+Call$/i,
    /\s+QC$/i,
    /\s+SC$/i
  ].forEach(function (re) { name = name.replace(re, ''); });

  return name.trim();
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

    // Real bug found live (26/08/2026 silent-failure audit): this function
    // appends 18-20 positional values via appendRow with no header check at
    // all, unlike every OTHER sheet-writing function in this file. A drifted
    // header (a column inserted/renamed) means every value below lands one
    // column off with no error. getValidatedColumnMap_ throws (and alerts)
    // loudly on any mismatch before a single row gets written.
    getValidatedColumnMap_(sheet);

    var existing = loadExistingLegacyKeys_(sheet);
    var scored = 0, skippedExisting = 0, failed = 0;

    Object.keys(PHASE2_CONFIG.SEAN_FOLDERS).forEach(function (label) {
      var folder = DriveApp.getFolderById(PHASE2_CONFIG.SEAN_FOLDERS[label]);
      var files = getFilesRecursive_(folder); // recurses into subfolders — see getFilesRecursive_'s comment
      while (files.hasNext()) {
        var file = files.next();
        var name = file.getName();
        if (name.indexOf('Transcript') === -1) continue; // skip source videos

        // Real bug found live (26/08/2026 silent-failure audit): the per-file
        // try used to start AFTER resolveRealCallDate_ (a Drive call) and the
        // dedup check — so a routine Drive hiccup on any one file threw OUT
        // OF THE LOOP entirely, silently abandoning every remaining file in
        // this and every other folder with no summary log and no ops alert.
        try {
          var prospectName = name.replace(/[—-]?\s*Transcript\s*$/i, '').trim();
          var callDate = resolveRealCallDate_(files.currentFolder(), prospectName, file);
          var dateStr = Utilities.formatDate(callDate, CONFIG.BUSINESS_TIMEZONE, 'yyyy-MM-dd');
          // normalize_(cleanProspectNameForSheet_(...)), not the raw prospectName:
      // the sheet's own Prospect Name column holds the cleaned value (see
      // cleanProspectNameForSheet_'s appendRow use below / the one-time
      // repairProspectNames() repair) — keying off the uncleaned name here
      // would silently stop matching existing[] after that repair runs,
      // re-scoring and duplicating every already-repaired row.
      var key = normalize_(cleanProspectNameForSheet_(prospectName)) + '|' + dateStr + '|' + normalize_('Sean');
          if (existing[key]) { skippedExisting++; continue; }

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
          var frameworkFields = deriveFrameworkFields_(result);
          var deliveryFields = deriveDeliveryFields_(result);
          var discoveryFields = deriveDiscoveryFields_(result);
          var bookingFields = deriveBookingDecisionFields_(result);
          var elevationFields = deriveElevationFields_(result);

          // Analytic-score shadow check (QA_COACHING_RESEARCH_REPORT.md §1.4) —
          // logs a comparison only, never changes what's appended below. This
          // function only ever scores Sean's own transcripts through Sean's
          // own variant.
          logAnalyticScoreShadowCheck_(prospectName, 'sean', result);
          // FUTURE (not built — see ANALYTIC_SCORE_CONFIG): if ANALYTIC_SCORE_CONFIG.ENABLED
          // is ever flipped true, the "Call Quality Score" entry in the appendRow
          // below would use the analytic score instead of result.call_quality_score.

          sheet.appendRow([
            cleanProspectNameForSheet_(prospectName), // Prospect Name — cruft-stripped, see cleanProspectNameForSheet_
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
            '',                           // Reviewed By
            0,                               // Queue Age
            '',                              // Kris Manual Review Verdict — not yet judged
            result.primary_failure_mode || 'none', // Primary Failure Mode
            frameworkFields.explained,       // Flag: Framework Explained
            frameworkFields.gapsText,        // Framework Gaps
            RUBRIC_VERSION,                  // Rubric Version
            deliveryFields.effective,        // Flag: Delivery Effective
            deliveryFields.gapsText,         // Delivery Gaps
            discoveryFields.adequate,        // Flag: Discovery Adequate
            discoveryFields.gapsText,         // Discovery Gaps
            bookingFields.appropriate,       // Flag: Booking Decision Appropriate
            bookingFields.gapText,            // Booking Decision Gap
            elevationFields.done,            // Flag: Elevation Done
            elevationFields.gapText          // Elevation Gap
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
    var files = getFilesRecursive_(folder);
    while (files.hasNext()) {
      var file = files.next();
      var name = file.getName();
      if (name.indexOf('Transcript') === -1) continue; // skip source videos, only match transcript docs
      var prospectName = name.replace(/[—-]?\s*Transcript\s*$/i, '').trim();
      // Real bug found live (26/08/2026 silent-failure audit): see the
      // identical comment in previewSeanTranscripts above.
      var callDate = resolveRealCallDate_(files.currentFolder(), prospectName, file);
      var dateStr = Utilities.formatDate(callDate, CONFIG.BUSINESS_TIMEZONE, 'yyyy-MM-dd');
      // See the identical comment on the Sean key above — cleaned name, not raw.
      var key = normalize_(cleanProspectNameForSheet_(prospectName)) + '|' + dateStr + '|' + normalize_('Joana');
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

    // Real bug found live (26/08/2026 silent-failure audit): this function
    // appends 18-20 positional values via appendRow with no header check at
    // all, unlike every OTHER sheet-writing function in this file. A drifted
    // header (a column inserted/renamed) means every value below lands one
    // column off with no error. getValidatedColumnMap_ throws (and alerts)
    // loudly on any mismatch before a single row gets written.
    getValidatedColumnMap_(sheet);

    var existing = loadExistingLegacyKeys_(sheet);
    var scored = 0, skippedExisting = 0, failed = 0;

    Object.keys(PHASE2_CONFIG.JOANA_FOLDERS).forEach(function (label) {
      var folder = DriveApp.getFolderById(PHASE2_CONFIG.JOANA_FOLDERS[label]);
      var files = getFilesRecursive_(folder); // recurses into subfolders — see getFilesRecursive_'s comment
      while (files.hasNext()) {
        var file = files.next();
        var name = file.getName();
        if (name.indexOf('Transcript') === -1) continue; // skip source videos

        // Real bug found live (26/08/2026 silent-failure audit): see the
        // identical comment in scoreSeanTranscripts above — the per-file try
        // must start before any Drive call, or one hiccup silently abandons
        // every remaining file with no summary log and no ops alert.
        try {
          var prospectName = name.replace(/[—-]?\s*Transcript\s*$/i, '').trim();
          var callDate = resolveRealCallDate_(files.currentFolder(), prospectName, file);
          var dateStr = Utilities.formatDate(callDate, CONFIG.BUSINESS_TIMEZONE, 'yyyy-MM-dd');
          // See the identical comment on the Sean key above — cleaned name, not raw.
      var key = normalize_(cleanProspectNameForSheet_(prospectName)) + '|' + dateStr + '|' + normalize_('Joana');
          if (existing[key]) { skippedExisting++; continue; }

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
          var frameworkFields = deriveFrameworkFields_(result);
          var deliveryFields = deriveDeliveryFields_(result);
          var discoveryFields = deriveDiscoveryFields_(result);
          var bookingFields = deriveBookingDecisionFields_(result);
          var elevationFields = deriveElevationFields_(result);

          // Analytic-score shadow check (QA_COACHING_RESEARCH_REPORT.md §1.4) —
          // logs a comparison only, never changes what's appended below. Joana
          // has no dedicated variant — always scored under the shared rubric.
          logAnalyticScoreShadowCheck_(prospectName, 'shared', result);
          // FUTURE (not built — see ANALYTIC_SCORE_CONFIG): if ANALYTIC_SCORE_CONFIG.ENABLED
          // is ever flipped true, the "Call Quality Score" entry in the appendRow
          // below would use the analytic score instead of result.call_quality_score.

          sheet.appendRow([
            cleanProspectNameForSheet_(prospectName), // Prospect Name — cruft-stripped, see cleanProspectNameForSheet_
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
            '',                            // Reviewed By
            0,                                // Queue Age
            '',                               // Kris Manual Review Verdict — not yet judged
            result.primary_failure_mode || 'none', // Primary Failure Mode
            frameworkFields.explained,        // Flag: Framework Explained
            frameworkFields.gapsText,         // Framework Gaps
            RUBRIC_VERSION,                   // Rubric Version
            deliveryFields.effective,         // Flag: Delivery Effective
            deliveryFields.gapsText,          // Delivery Gaps
            discoveryFields.adequate,         // Flag: Discovery Adequate
            discoveryFields.gapsText,          // Discovery Gaps
            bookingFields.appropriate,        // Flag: Booking Decision Appropriate
            bookingFields.gapText,             // Booking Decision Gap
            elevationFields.done,             // Flag: Elevation Done
            elevationFields.gapText           // Elevation Gap
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
// Temporary backfill helper (22/08/2026) — Bens/Joana/Sean all had real
// backlogs (61/61/223 files, most unscored) discovered the same day the
// dashboard went live. A single scoring pass through any one of them
// regularly exceeds Apps Script's 6-minute execution cap, so this wraps all
// three behind one repeating trigger instead of hand-clicking "Run" a dozen
// times. Each underlying function skips already-scored transcripts almost
// instantly (loadExistingLegacyKeys_ + skip, no model call), so once Bens is
// fully caught up the remaining time in each firing flows through to Joana,
// then Sean, rather than one backlog starving the others. NOT meant to run
// forever — installLegacyBackfillTrigger()/removeLegacyBackfillTrigger()
// below manage it; remove it once all three report 0 newly scored.
// ---------------------------------------------------------------------------

/**
 * Real bug found live (22/08/2026): Workspace accounts get up to 30-MINUTE
 * executions, not the 6-minute cap consumer accounts get — so a 10-minute
 * trigger interval let a second firing start while the first was still
 * running, and scoreBensLegacyTranscripts() has no lock of its own, so the
 * two overlapping runs could score (and double-append a row for) the same
 * call. Fixed with an explicit Script Properties mutex here rather than
 * nesting LockService calls inside the already-locked scoreJoanaTranscripts_/
 * scoreSeanTranscripts_ (whether a script can safely re-acquire its own
 * script lock from the same execution isn't something to bet a live sheet's
 * integrity on) — this checks/sets one property before either of those ever
 * runs, so it's a single, unambiguous gate. Self-heals if an execution ever
 * gets killed mid-run without reaching the `finally`: 30 minutes stale is
 * strictly longer than any real execution can last, so a flag older than
 * that is never a real in-progress run.
 *
 * Real bug found live (23/08/2026), and confirmed in the actual Sales Call
 * Log — this mutex's check-then-set was NOT atomic. installLegacyBackfillTrigger()
 * not deduping its own trigger (fixed separately, same day) meant several
 * copies of this trigger could exist, firing close enough together that
 * multiple executions could each call getProperty() and see the gate as
 * free before any of them called setProperty() — each then proceeded
 * concurrently with its own stale "what's already scored" snapshot. Bens'
 * legacy scorer has no lock of its own (see above), so it took the hit:
 * confirmed 316 rows for what should have been 14 distinct transcripts, the
 * earliest-iterated files duplicated up to 35 times. Sean/Joana were
 * protected from the same fate by their own internal LockService locks.
 * Fixed by making the check-and-set itself atomic with a short-lived
 * LockService hold, released immediately after — NOT held across the actual
 * scoring calls below, so it can never nest with scoreJoanaTranscripts_'s/
 * scoreSeanTranscripts_'s own internal lock.tryLock() on the same script lock.
 *
 * Real bug found live (23/08/2026): Joana has no dedicated scoring trigger
 * of her own the way Sean/Tomás do (installSeanScoringAutomation(),
 * installTomasScoringAutomation()) — this function is the ONLY path that
 * ever calls scoreJoanaTranscripts(), and it ran AFTER Bens. Bens' real
 * backlog alone (14 distinct transcripts, ~2-4 min each via the Kimi API)
 * already exceeds this account's 30-minute execution cap on a single clean
 * pass, so this almost certainly timed out inside Bens' loop on every
 * firing and never reached Joana at all — confirmed live: Joana has zero
 * rows in the Sales Call Log. Reordered so Joana (and Sean, who's
 * self-healing via his own separate trigger anyway) get a chance before
 * Bens can starve the rest of the execution budget.
 */
function runAllLegacyBackfills_() {
  var props = PropertiesService.getScriptProperties();
  var lockKey = 'LEGACY_BACKFILL_RUNNING_SINCE';
  var now = Date.now();

  // Brief real lock, held only long enough to make the check-and-set atomic —
  // released before any actual scoring runs, so it never overlaps with
  // scoreJoanaTranscripts_/scoreSeanTranscripts_'s own internal script lock.
  var gate = LockService.getScriptLock();
  if (!gate.tryLock(5 * 1000)) {
    log_('runAllLegacyBackfills_: could not acquire the gate lock within 5s — skipping this firing.');
    return;
  }
  var shouldRun = false;
  try {
    var runningSince = props.getProperty(lockKey);
    if (runningSince && (now - Number(runningSince)) < 30 * 60 * 1000) {
      log_('runAllLegacyBackfills_: a previous firing is still running (started ' +
        new Date(Number(runningSince)) + ') — skipping this firing to avoid double-scoring a call.');
    } else {
      props.setProperty(lockKey, String(now));
      shouldRun = true;
    }
  } finally {
    gate.releaseLock();
  }
  if (!shouldRun) return;

  try {
    scoreJoanaTranscripts();
    scoreSeanTranscripts();
    scoreBensLegacyTranscripts();
  } finally {
    props.deleteProperty(lockKey);
  }
}

/**
 * Run this once from the editor to start the temporary backfill. Fires every
 * 10 minutes — ScriptApp's clock trigger only accepts 1/5/10/15/30 for
 * everyMinutes(). This account gets 30-minute executions (not the 6-minute
 * consumer cap — confirmed 23/08/2026 by a real "Timed out" execution at
 * exactly 1800s in the Executions log), so a single firing can easily still
 * be running when the next one is due; overlap protection is the 30-minute
 * time-window mutex in runAllLegacyBackfills_ itself, not the trigger
 * interval — that matters since scoreBensLegacyTranscripts() has no lock of
 * its own the way scoreJoanaTranscripts()/scoreSeanTranscripts() do — an
 * overlapping run there really could double-score a file.
 *
 * Real bug found live (23/08/2026): unlike every other install*Trigger
 * function in this codebase (installWeeklyScorecardTrigger(),
 * installRandomCalibrationSampleTrigger(), etc.), this one never deleted its
 * own existing trigger before creating a new one — so a second accidental
 * run of this function stacks a second independent 10-minute trigger
 * instead of replacing the first. Three such triggers, each firing every 10
 * minutes but at different offsets, produces a combined ~2-4 minute firing
 * cadence that looks alarming in the Executions log even though the mutex
 * above prevents any actual double-scoring damage — confirmed this was
 * exactly what was happening (see HANDOFF.md). Now idempotent like the rest.
 */
function installLegacyBackfillTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runAllLegacyBackfills_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runAllLegacyBackfills_').timeBased().everyMinutes(10).create();
  log_('Installed temporary 10-minute backfill trigger on runAllLegacyBackfills_ (any prior copy ' +
    'removed first) — watch the execution log, then run removeLegacyBackfillTrigger() once Bens/' +
    'Joana/Sean all report 0 newly scored on a run.');
}

/** Run this once the backfill has fully caught up — this trigger should not run forever. */
function removeLegacyBackfillTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'runAllLegacyBackfills_') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  log_('Removed ' + removed + ' runAllLegacyBackfills_ trigger(s).');
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
    'Tomás Playbook.md (built from a close read of 22 of his real calls) identifies two things worth checking',
    'explicitly, since they are his own most consistent strengths and his own most consistent gap:',
    '- His strongest calls follow the same four-step shape BEFORE any objection comes up: (1) ask or re-verify',
    '  the lead\'s actual goal, not "are you interested" — (2) mirror the lead\'s own words back almost verbatim',
    '  when introducing the offer — (3) map a specific named mechanism to that exact goal, not a generic benefit',
    '  — (4) back it with something concrete (a named client, a real number, a live demo), not a general',
    '  reassurance. Note in your reasoning whether this call followed that shape.',
    '- His single most consistent weak spot across the reviewed batch is accepting an open-ended stall ("I need',
    '  to check with someone," "let me think about it") passively instead of converting it into a specific',
    '  date/time before the call ends. If the lead stalls in this call, check whether Tomás locked a firm next',
    '  step (a specific date/time) rather than leaving it open — if the lead never stalls at all, this is simply',
    '  not applicable and should be scored true.',
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
    'These anchors are unaffected by followed_goal_mirror_map_proof_process/stalling_converted_to_date below —',
    'those are tracked independently, same relationship the framework flags already have to this score.',
    '',
    frameworkRubricPrompt_(),
    '',
    deliveryRubricPrompt_(),
    '',
    discoveryRubricPrompt_(),
    '',
    'If call_role is second_call_closer, also apply this (skip entirely — score both flags true — if call_role',
    'is own_new_lead, since there is no earlier rep to have elevated you on THIS call):',
    elevationRubricPrompt_('Tomás'),
    '',
    'Return ONLY raw JSON. No markdown code fences, no leading or trailing text, in this exact shape:',
    '',
    '{',
    '  "reasoning": "string",',
    '  "call_role": "own_new_lead | second_call_closer | unclear",',
    '  "lead_quality": { "verdict": "good_to_book | should_screen_out", "justification": "string" },',
    '  "call_quality_score": 1,',
    '  "flags": {',
    '    "asked_for_close": true,',
    '    "objections_uncovered": true,',
    '    "objections_overcome": true,',
    '    "closed_or_committed": true,',
    '    "followed_goal_mirror_map_proof_process": true,',
    '    "stalling_converted_to_date": true,',
    '    "discovery_adequate": true,',
    '    "understood_leads_business": true,',
    '    "confirmed_prior_discovery": true,',
    '    "rep_present_on_call": true,',
    '    "elevation_done": true',
    '  },',
    '  "framework": { "recruit_agents_explained": true, "number_one_podcast_explained": true, "sell_more_houses_explained": true },',
    '  "delivery": { "paced_appropriately": true, "adapted_to_lead_engagement": true },',
    '  "primary_failure_mode": "none | no_close_ask | objections_missed | weak_discovery | framework_not_explained | delivery_ineffective | multiple",',
    '  "teachable_strength": "string",',
    '  "coach_this": "string",',
    '  "manual_review_recommended": true,',
    '  "severity": 1,',
    '  "feedback_summary": "string — 2-3 sentences, coaching-ready. MUST open by quoting the rep\'s own',
    '    words from the transcript for the single most important moment (a real line they actually said,',
    '    in quotation marks) before saying anything else — a specific moment lands, a bare evaluation does',
    '    not. Name ONE behavior to change, not a list. Never compare this rep to any other rep by name. If',
    '    this covers more than one distinct idea (the quoted moment, then a separate observation, then what',
    '    to change), put each on its own line separated by a literal \\n — never chain them into one dense',
    '    run-on paragraph."',
    '}'
  ].join('\n');
}

function isValidTomasJudgeSchema_(obj) {
  return !!(obj &&
    typeof obj.call_role === 'string' &&
    obj.lead_quality && isValidLeadVerdict_(obj.lead_quality.verdict) &&
    isValidScoreRange_(obj.call_quality_score) &&
    obj.flags &&
    typeof obj.flags.asked_for_close === 'boolean' &&
    typeof obj.flags.objections_uncovered === 'boolean' &&
    typeof obj.flags.objections_overcome === 'boolean' &&
    typeof obj.flags.closed_or_committed === 'boolean' &&
    typeof obj.flags.followed_goal_mirror_map_proof_process === 'boolean' &&
    typeof obj.flags.stalling_converted_to_date === 'boolean' &&
    typeof obj.flags.discovery_adequate === 'boolean' &&
    typeof obj.flags.understood_leads_business === 'boolean' &&
    typeof obj.flags.confirmed_prior_discovery === 'boolean' &&
    typeof obj.flags.rep_present_on_call === 'boolean' &&
    typeof obj.flags.elevation_done === 'boolean' &&
    obj.framework && typeof obj.framework.recruit_agents_explained === 'boolean' &&
    typeof obj.framework.number_one_podcast_explained === 'boolean' &&
    typeof obj.framework.sell_more_houses_explained === 'boolean' &&
    obj.delivery && typeof obj.delivery.paced_appropriately === 'boolean' &&
    typeof obj.delivery.adapted_to_lead_engagement === 'boolean' &&
    typeof obj.teachable_strength === 'string' &&
    typeof obj.coach_this === 'string' &&
    typeof obj.manual_review_recommended === 'boolean' &&
    isValidScoreRange_(obj.severity));
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
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt, 'phase2:tomas');
      var parsed = stripFencesAndParseJson_(lastRaw);
      if (!isValidTomasJudgeSchema_(parsed)) throw new Error('Parsed JSON missing required Tomás-rubric fields.');
      return parsed;
    } catch (e) {
      log_('    ↳ scoreTomasTranscript_ attempt ' + (attempt + 1) + ' failed for ' + ctx.prospectName + ': ' + e);
      handleJudgeRetryError_(e, attempt, PHASE2_CONFIG.MAX_PARSE_RETRIES);
    }
  }

  log_('    ↳ ROUTED TO MANUAL REVIEW (parse failed twice) — ' + ctx.prospectName +
    '. Raw model output: ' + String(lastRaw).slice(0, 1000));
  return {
    reasoning: 'JSON parse failed twice — see Apps Script log for raw model output.',
    call_role: 'unclear',
    lead_quality: { verdict: 'good_to_book', justification: 'Unscored — parse failure.' },
    call_quality_score: 1,
    flags: {
      asked_for_close: false, objections_uncovered: false, objections_overcome: false, closed_or_committed: false,
      followed_goal_mirror_map_proof_process: false, stalling_converted_to_date: false,
      discovery_adequate: false, understood_leads_business: false, confirmed_prior_discovery: false,
      rep_present_on_call: false, elevation_done: false
    },
    framework: { recruit_agents_explained: false, number_one_podcast_explained: false, sell_more_houses_explained: false },
    delivery: { paced_appropriately: false, adapted_to_lead_engagement: false },
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
  var frameworkFields = deriveFrameworkFields_(result);
  var deliveryFields = deriveDeliveryFields_(result);
  var elevationFields = deriveElevationFields_(result);
  return [
    result.feedback_summary,
    '',
    'Call role: ' + result.call_role + ' | Closed or committed: ' + result.flags.closed_or_committed,
    'Followed goal/mirror/map/proof process (Tomas_Playbook.md Part 1): ' + result.flags.followed_goal_mirror_map_proof_process,
    'Stalling converted to a specific date (Playbook Part 2 §6, his most consistent gap): ' + result.flags.stalling_converted_to_date,
    'Framework explained: ' + frameworkFields.explained +
      (frameworkFields.gapsText ? ' (missing: ' + frameworkFields.gapsText + ')' : ''),
    'Delivery effective: ' + deliveryFields.effective +
      (deliveryFields.gapsText ? ' (missing: ' + deliveryFields.gapsText + ')' : ''),
    'Elevated by the original rep: ' + (elevationFields.done === '' ? 'N/A — no original rep present on this call' : elevationFields.done),
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
    var files = getFilesRecursive_(folder); // recurses into subfolders — see getFilesRecursive_'s comment
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

    // Real bug found live (26/08/2026 silent-failure audit): this function
    // appends 18-20 positional values via appendRow with no header check at
    // all, unlike every OTHER sheet-writing function in this file. A drifted
    // header (a column inserted/renamed) means every value below lands one
    // column off with no error. getValidatedColumnMap_ throws (and alerts)
    // loudly on any mismatch before a single row gets written.
    getValidatedColumnMap_(sheet);

    var existing = loadExistingLegacyKeys_(sheet);
    var scored = 0, skippedExisting = 0, failed = 0;

    Object.keys(PHASE2_CONFIG.TOMAS_FOLDERS).forEach(function (label) {
      var folder = DriveApp.getFolderById(PHASE2_CONFIG.TOMAS_FOLDERS[label]);
      var files = getFilesRecursive_(folder); // recurses into subfolders — see getFilesRecursive_'s comment
      while (files.hasNext()) {
        var file = files.next();
        var name = file.getName();
        if (name.indexOf('Transcript') === -1) continue; // skip source videos

        // Real bug found live (26/08/2026 silent-failure audit): see the
        // identical comment in scoreSeanTranscripts above — the per-file try
        // must start before any Drive call, or one hiccup silently abandons
        // every remaining file with no summary log and no ops alert.
        try {
          var prospectName = name.replace(/[—-]?\s*Transcript\s*$/i, '').trim();
          var callDate = resolveRealCallDate_(files.currentFolder(), prospectName, file);
          var dateStr = Utilities.formatDate(callDate, CONFIG.BUSINESS_TIMEZONE, 'yyyy-MM-dd');
          // See the identical comment on the Sean key above — cleaned name, not raw.
          var key = normalize_(cleanProspectNameForSheet_(prospectName)) + '|' + dateStr + '|' + normalize_('Tomás');
          if (existing[key]) { skippedExisting++; continue; }

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
          var frameworkFields = deriveFrameworkFields_(result);
          var deliveryFields = deriveDeliveryFields_(result);
          var discoveryFields = deriveDiscoveryFields_(result);
          var bookingFields = deriveBookingDecisionFields_(result);
          var elevationFields = deriveElevationFields_(result);

          // Analytic-score shadow check (QA_COACHING_RESEARCH_REPORT.md §1.4) —
          // logs a comparison only, never changes what's appended below. This
          // function only ever scores Tomás's own transcripts through Tomás's
          // own variant.
          logAnalyticScoreShadowCheck_(prospectName, 'tomas', result);
          // FUTURE (not built — see ANALYTIC_SCORE_CONFIG): if ANALYTIC_SCORE_CONFIG.ENABLED
          // is ever flipped true, the "Call Quality Score" entry in the appendRow
          // below would use the analytic score instead of result.call_quality_score.

          sheet.appendRow([
            cleanProspectNameForSheet_(prospectName), // Prospect Name — cruft-stripped, see cleanProspectNameForSheet_
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
            '',                             // Reviewed By
            0,                                  // Queue Age
            '',                                 // Kris Manual Review Verdict — not yet judged
            result.primary_failure_mode || 'none', // Primary Failure Mode
            frameworkFields.explained,          // Flag: Framework Explained
            frameworkFields.gapsText,           // Framework Gaps
            RUBRIC_VERSION,                      // Rubric Version
            deliveryFields.effective,           // Flag: Delivery Effective
            deliveryFields.gapsText,            // Delivery Gaps
            discoveryFields.adequate,           // Flag: Discovery Adequate
            discoveryFields.gapsText,            // Discovery Gaps
            bookingFields.appropriate,          // Flag: Booking Decision Appropriate
            bookingFields.gapText,               // Booking Decision Gap
            elevationFields.done,                // Flag: Elevation Done
            elevationFields.gapText              // Elevation Gap
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
 * Real gap found live (23/08/2026): unlike Sean/Tomás, Joana never had a
 * dedicated scoring trigger of her own — scoreJoanaTranscripts() was ONLY
 * ever reachable through runAllLegacyBackfills_, sequentially after Bens'
 * legacy folder, which alone can exceed this account's 30-minute execution
 * cap. Confirmed live: zero Joana rows in the Sales Call Log. This gives her
 * the same standalone cadence Sean/Tomás already have, independent of
 * whatever state the temporary Bens/Sean/Joana backfill trigger is in.
 * ONE-TIME setup — select installJoanaScoringAutomation in the Apps Script
 * editor's "Select function" dropdown and run it once.
 */
function installJoanaScoringAutomation() {
  RUN_TAG = 'installJoanaScoringAutomation';
  reinstallHourlyTrigger_('scoreJoanaTranscripts', 4);
  log_('Joana auto-scoring installed: scoreJoanaTranscripts() now runs every 4 hours.');
}

/**
 * Real gap found live (25/08/2026): Bens was the only rep with no scoring
 * trigger of his own. scoreBensLegacyTranscripts() was reachable ONLY
 * through runAllLegacyBackfills_ — the temporary 10-minute backfill trigger
 * — so "retire the backfill once the backlog is drained" and "keep scoring
 * Bens' new calls" were in direct conflict: removing that trigger silently
 * stops scoring him altogether.
 *
 * It also explains why that trigger never reports a drained backlog. Its
 * retirement signal was supposed to be a firing that scores 0 across all
 * three reps, but Bens' Riverside folder keeps receiving NEW transcripts
 * (calls dated 2026-08-16/17 were still being scored on 25/08), so the
 * count never settles at 0 — it was quietly promoted from backfill to
 * production scheduler by the fact that nothing else does this job.
 *
 * With this installed, runAllLegacyBackfills_ is genuinely temporary again
 * and safe to remove: Joana, Sean, Tomás and Bens each have their own
 * independent 4-hour trigger.
 *
 * ONE-TIME setup — select installBensScoringAutomation in the Apps Script
 * editor's "Select function" dropdown and run it once (or just re-run
 * installAllReadyTriggers(), which now includes it).
 */
function installBensScoringAutomation() {
  RUN_TAG = 'installBensScoringAutomation';
  reinstallHourlyTrigger_('scoreBensLegacyTranscripts', 4);
  log_('Bens auto-scoring installed: scoreBensLegacyTranscripts() now runs every 4 hours.');
}

// ---------------------------------------------------------------------------
// Consolidated ongoing scoring (04/09/2026) — see runAllOngoingScoringPasses_
// below. installAllReadyTriggers_ (Phase1_ComplianceCheck.gs) now calls
// installOngoingScoringTrigger() instead of the five install*Trigger/
// install*ScoringAutomation functions above; those are left in place for
// manual/debug use (re-enabling just one rep's pass on its own trigger while
// investigating something), but note that doing so adds back a trigger the
// next installAllReadyTriggers_()/installOngoingScoringTrigger() run will
// remove again, same idempotent "one canonical installer wins" pattern this
// codebase already uses everywhere else.
// ---------------------------------------------------------------------------

/**
 * Real gap found live (04/09/2026): the project hit Apps Script's 20-trigger
 * project cap trying to add Phase 11's Bens podcast sync trigger
 * (installBensPodcastSyncTrigger, Phase11_BensPodcastSync.gs). listAllTriggers()
 * showed 5 of the 20 slots were five separate every-4-hours triggers
 * (scoreNewlyLoggedCalls_, scoreSeanTranscripts, scoreJoanaTranscripts,
 * scoreTomasTranscripts, scoreBensLegacyTranscripts) doing the exact same
 * class of job on the exact same cadence — no reason for 5 trigger objects
 * instead of 1 handler that calls all 5 passes in sequence. Frees 4 slots.
 *
 * Each pass is independently idempotent (skips whatever it already scored),
 * so calling them sequentially in a single execution is safe — this is the
 * same sequencing runAllLegacyBackfills_ above already used for exactly this
 * reason, on a 10-minute one-off backfill trigger rather than this ongoing
 * 4-hour one.
 *
 * Order matters: Bens is deliberately LAST. Real bug found live (23/08/2026,
 * documented on runAllLegacyBackfills_ above): his backlog alone can consume
 * a full execution budget and starve whoever runs after him — Joana was the
 * rep who actually got starved that day, which is exactly why this puts her
 * right after the (usually fast) scoreNewlyLoggedCalls_ pass instead.
 *
 * Bounded by ONGOING_SCORING_TIME_BUDGET_MS_ so an unusually large backlog on
 * one pass can't push the whole chain past this account's execution cap —
 * skips whatever hasn't started yet and logs it; the next 4-hour firing picks
 * up exactly where this one left off, since every pass here is independently
 * idempotent and needs no resume bookkeeping of its own.
 */
var ONGOING_SCORING_TIME_BUDGET_MS_ = 20 * 60 * 1000; // this Workspace account gets 30-minute executions (confirmed live 22/08/2026) -- 10-minute safety margin

/** Pure/testable — no Date.now() call of its own, so a test can pass fixed timestamps. */
function shouldSkipRemainingScoringPasses_(runStartMs, nowMs, budgetMs) {
  return (nowMs - runStartMs) > budgetMs;
}

function runAllOngoingScoringPasses_() {
  RUN_TAG = 'runAllOngoingScoringPasses_';
  var runStart = Date.now();
  var passes = [
    { name: 'scoreNewlyLoggedCalls_', fn: scoreNewlyLoggedCalls_ },
    { name: 'scoreJoanaTranscripts', fn: scoreJoanaTranscripts },
    { name: 'scoreSeanTranscripts', fn: scoreSeanTranscripts },
    { name: 'scoreTomasTranscripts', fn: scoreTomasTranscripts },
    { name: 'scoreBensLegacyTranscripts', fn: scoreBensLegacyTranscripts } // last -- see this function's own header comment
  ];

  for (var i = 0; i < passes.length; i++) {
    if (shouldSkipRemainingScoringPasses_(runStart, Date.now(), ONGOING_SCORING_TIME_BUDGET_MS_)) {
      log_('runAllOngoingScoringPasses_: time budget hit before ' + passes[i].name +
        ' (and ' + (passes.length - i - 1) + ' more) -- skipping for this firing, the next one picks it up.');
      break;
    }
    try {
      passes[i].fn();
    } catch (e) {
      log_('runAllOngoingScoringPasses_: ' + passes[i].name + ' threw: ' + e + ' -- continuing to the next pass.');
      sendOpsAlert_('Scoring pass error: ' + passes[i].name, String(e));
    }
  }
}

/**
 * ONE-TIME setup, replacing installPhase2Trigger/installSeanScoringAutomation/
 * installJoanaScoringAutomation/installTomasScoringAutomation/
 * installBensScoringAutomation as the normal way to enable ongoing scoring —
 * run this instead of those five. Deletes every one of their triggers (if
 * present) plus any existing copy of its own, then installs the single
 * combined trigger. Safe to re-run any time.
 */
function installOngoingScoringTrigger() {
  RUN_TAG = 'installOngoingScoringTrigger';
  ['scoreNewlyLoggedCalls_', 'scoreSeanTranscripts', 'scoreJoanaTranscripts',
    'scoreTomasTranscripts', 'scoreBensLegacyTranscripts', 'runAllOngoingScoringPasses_'].forEach(function (handler) {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
    });
  });
  ScriptApp.newTrigger('runAllOngoingScoringPasses_').timeBased().everyHours(4).create();
  log_('Installed: runAllOngoingScoringPasses_() now runs every 4 hours, replacing the 5 separate ' +
    'per-pass triggers this project used to install individually (frees 4 trigger slots).');
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
 * touches Reviewed By or any scored field. Run manually for now; wire
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
    if (row[col['Reviewed By'] - 1]) continue;
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

// ---------------------------------------------------------------------------
// Random calibration holdout — QA_COACHING_RESEARCH_REPORT.md §1.1/§1 headline
// finding: buildReviewQueueImpl_() above only ever surfaces calls the AI
// already flagged (Manual Review Recommended = true). runWeeklyCalibration()
// above can already compute kappa off ANY row carrying a "Kris Manual Review
// Verdict" — it was never restricted to flagged rows — but nothing ever
// pointed Kris at an UNflagged row to independently judge, so every
// calibration number to date is implicitly conditioned on "calls the model
// already thought were hard." A rep who's quietly mediocre on every call,
// none of which trip the severity threshold, is invisible to that loop by
// construction. This closes the gap: a small weekly random sample, blind of
// the AI's own flag, feeding the exact same Kris Manual Review Verdict
// column runWeeklyCalibration() already reads.
//
// ONE-TIME SETUP (same pattern as every other phase in this file):
//   1. Run previewRandomCalibrationSample() from the editor — logs the
//      sample it WOULD pick and email, sends nothing.
//   2. Flip RANDOM_CALIBRATION_CONFIG.ENABLED to true, run
//      installRandomCalibrationSampleTrigger() (or just re-run
//      installAllReadyTriggers_() in Phase1_ComplianceCheck.gs).
// ---------------------------------------------------------------------------

var RANDOM_CALIBRATION_CONFIG = {
  ENABLED: true, // flipped 25/08/2026 — previewRandomCalibrationSample() ran clean live (4 sensible calls, correct blind-review format)
  SAMPLE_SIZE: 4, // report's recommended range is 3-5/week
  TRIGGER_DAY: 'FRIDAY', // ScriptApp.WeekDay name — deliberately not Monday (Phase 5's scorecard day)
  TRIGGER_HOUR: 16
};

/**
 * Picks up to n items uniformly at random from items, without replacement.
 * randomFn is injectable (defaults to Math.random) so this is unit-testable
 * with a deterministic sequence — see tests/run_tests.js. Pure/no side
 * effects; does not mutate items.
 */
function pickRandomSample_(items, n, randomFn) {
  var pool = items.slice();
  var picked = [];
  var count = Math.min(n, pool.length);
  for (var i = 0; i < count; i++) {
    var idx = Math.floor(randomFn() * pool.length);
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

/** Run this FIRST from the editor. Logs the sample it would email — sends nothing. */
function previewRandomCalibrationSample() {
  return buildRandomCalibrationSampleImpl_(/*forcePreview=*/true);
}

/** Trigger target. Gated by RANDOM_CALIBRATION_CONFIG.ENABLED as a second safety net, same pattern as runWeeklyScorecard. */
function runRandomCalibrationSample() {
  RUN_TAG = 'runRandomCalibrationSample';
  if (!RANDOM_CALIBRATION_CONFIG.ENABLED) {
    log_('runRandomCalibrationSample: RANDOM_CALIBRATION_CONFIG.ENABLED is false, skipping.');
    return null;
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    log_('runRandomCalibrationSample: another scoring/queue run holds the lock, skipping this run.');
    return null;
  }
  try {
    return buildRandomCalibrationSampleImpl_(/*forcePreview=*/false);
  } finally {
    lock.releaseLock();
  }
}

function buildRandomCalibrationSampleImpl_(forcePreview) {
  RUN_TAG = 'buildRandomCalibrationSample';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = resolveSheet_(ss, 'Sales Call Log');
  if (!sheet) { log_('No Sales Call Log tab found.'); return null; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { log_('No data rows.'); return null; }

  var col = getValidatedColumnMap_(sheet);
  var values = sheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  // Eligible = already scored, not already independently judged by Kris.
  // Deliberately NOT filtered on Manual Review Recommended or Severity in
  // either direction — that's the whole point, this sample has to be blind
  // to what the AI already thinks about the call.
  var eligible = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    if (typeof row[col['Call Quality Score'] - 1] !== 'number') continue; // not yet scored
    var krisVerdict = String(row[col['Kris Manual Review Verdict'] - 1] || '').trim();
    if (krisVerdict === 'Yes' || krisVerdict === 'No') continue; // already independently judged
    eligible.push({
      rowIndex: r + 2,
      rep: row[col['Rep'] - 1],
      prospectName: row[col['Prospect Name'] - 1],
      aiFlag: !!row[col['Manual Review Recommended'] - 1],
      score: Number(row[col['Call Quality Score'] - 1]) || 0,
      transcriptUrl: String(row[col['Transcript URL'] - 1] || '').trim()
    });
  }

  if (!eligible.length) {
    log_('buildRandomCalibrationSample: nothing eligible — every scored row already has a Kris verdict.');
    return null;
  }

  var sample = pickRandomSample_(eligible, RANDOM_CALIBRATION_CONFIG.SAMPLE_SIZE, Math.random);

  log_('buildRandomCalibrationSample: picked ' + sample.length + ' random call(s) for blind calibration review.');
  sample.forEach(function (c) {
    log_('  Row ' + c.rowIndex + ': ' + c.prospectName + ' (' + c.rep + ') — AI flag ' + c.aiFlag + ', score ' + c.score);
  });

  sendRandomCalibrationDigest_(sample, forcePreview, sheet);

  return sample.map(function (c) { return { rowIndex: c.rowIndex, prospectName: c.prospectName, rep: c.rep }; });
}

/**
 * Deliberately does NOT include the AI's flag/score in Kris's copy of the
 * email — she's meant to judge each call independently and record her own
 * Yes/No in the "Kris Manual Review Verdict" column, same as any other row
 * runWeeklyCalibration() reads. Including the AI's own verdict here would
 * anchor her judgment and defeat the point of a blind sample.
 */
/** Deep-link straight to a Sales Call Log row — same spreadsheet, jumps to and selects that row's range. */
function salesCallLogRowLink_(sheet, rowIndex) {
  return 'https://docs.google.com/spreadsheets/d/' + SALES_CALL_LOG_SPREADSHEET_ID +
    '/edit#gid=' + sheet.getSheetId() + '&range=A' + rowIndex;
}

/**
 * Kris's ask (29/08/2026), looking at the real weekly digest: "Bad
 * formatting. Bad spacing. No bold. Add the links!" — this was plain text
 * with no clickable anything, so reviewing a call meant hunting it down by
 * hand in the sheet. Now links straight to each call's Transcript URL (the
 * actual thing being judged) and to its Sales Call Log row (where the
 * verdict gets typed in), with bold/spacing so it reads as a list, not a
 * paragraph.
 */
function sendRandomCalibrationDigest_(sample, forcePreview, sheet) {
  var intro = 'This week\'s ' + sample.length + ' random calibration call(s) — reviewed BLIND of the AI\'s ' +
    'own flag/score, per QA_COACHING_RESEARCH_REPORT.md §1.1. For each, fill in "Kris Manual Review ' +
    'Verdict" (Yes/No) in the Sales Call Log — same column the flagged review queue uses — so ' +
    'runWeeklyCalibration() picks it up automatically:';

  var plainLines = [intro, ''];
  sample.forEach(function (c, i) {
    plainLines.push((i + 1) + '. ' + c.prospectName + ' (' + c.rep + ') — row ' + c.rowIndex);
    if (c.transcriptUrl) plainLines.push('   Transcript: ' + c.transcriptUrl);
    plainLines.push('   Sheet row: ' + salesCallLogRowLink_(sheet, c.rowIndex));
    plainLines.push('');
  });
  var body = plainLines.join('\n');

  var htmlItems = sample.map(function (c, i) {
    return '<li style="margin-bottom:12px;"><strong>' + escapeHtml_(c.prospectName) + '</strong> (' +
      escapeHtml_(c.rep) + ') — row ' + c.rowIndex + '<br>' +
      (c.transcriptUrl
        ? '<a href="' + escapeHtml_(c.transcriptUrl) + '">Transcript</a> · '
        : '<span style="color:#999;">(no transcript on file)</span> · ') +
      '<a href="' + salesCallLogRowLink_(sheet, c.rowIndex) + '">Sheet row</a></li>';
  }).join('');
  var htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">' +
    '<p>' + escapeHtml_(intro) + '</p>' +
    '<ol style="padding-left:20px;">' + htmlItems + '</ol>' +
    '</div>';

  if (forcePreview || !RANDOM_CALIBRATION_CONFIG.ENABLED) {
    log_('  (preview — random calibration digest logged only, not emailed)\n' + body);
    return;
  }
  guardedSend_(CONFIG.KRIS_EMAIL, '[Call Review] This week\'s random calibration sample (' + sample.length + ' call(s))',
    body, { htmlBody: htmlBody }, 1);
}

function installRandomCalibrationSampleTrigger() {
  RUN_TAG = 'installRandomCalibrationSampleTrigger';
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runRandomCalibrationSample') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runRandomCalibrationSample')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay[RANDOM_CALIBRATION_CONFIG.TRIGGER_DAY])
    .atHour(RANDOM_CALIBRATION_CONFIG.TRIGGER_HOUR)
    .inTimezone(CONFIG.BUSINESS_TIMEZONE)
    .create();
  log_('Random calibration sample trigger installed: ' + RANDOM_CALIBRATION_CONFIG.TRIGGER_DAY + ' ' +
    RANDOM_CALIBRATION_CONFIG.TRIGGER_HOUR + ':00 ' + CONFIG.BUSINESS_TIMEZONE + '.');
}

// ---------------------------------------------------------------------------
// Frozen regression set — drift detection. QA_COACHING_RESEARCH_REPORT.md's
// concern: the judge model (Kimi k3, forced temperature=1) could silently
// drift in behavior over time (a Moonshot-side model update, a subtle
// prompt-sensitivity issue) with nothing here to catch it — every existing
// safeguard in this file (schema validation, parse retries, manual review
// routing) catches a badly-FORMED response, none of them catch a
// well-formed response that quietly started judging differently than it used
// to. This closes that gap: freeze a small fixed set of already-scored real
// calls as a "known-good" baseline, then periodically re-run the SAME
// transcripts through the SAME rubric and diff.
//
// ONE-TIME SETUP (same pattern as every other phase in this file):
//   1. Run freezeRegressionSet() from the editor — picks and stores the
//      baseline. Safe to run more than once: it REPLACES the stored
//      baseline outright, it doesn't grow it.
//   2. Run previewRegressionDrift() — re-scores every frozen call and logs
//      any drift found. Eyeball the output against real transcripts before
//      trusting it.
//   3. Flip REGRESSION_DRIFT_CONFIG.ENABLED to true once that looks right.
//      Not wired to a trigger yet on purpose — that's a separate go-live
//      decision for a human to make later, same as RANDOM_CALIBRATION_CONFIG
//      before it shipped this session. When that trigger does get installed,
//      point it at checkRegressionDrift() (not the impl function).
// ---------------------------------------------------------------------------

var REGRESSION_DRIFT_CONFIG = {
  // Flip only after freezeRegressionSet() has been run at least once and
  // previewRegressionDrift() has been eyeballed against real output — same
  // "built but not yet installed" gate RANDOM_CALIBRATION_CONFIG had before
  // 25/08/2026. While false, checkRegressionDrift() (the would-be trigger
  // target) refuses to run at all; previewRegressionDrift() always works
  // regardless, since it's read-only by construction.
  ENABLED: false,
  // QA_COACHING_RESEARCH_REPORT.md's suggested range is 10-15 frozen calls;
  // picked the middle. freezeRegressionSet_() spreads this across every rep
  // with at least one already-scored, still-fetchable-transcript call, so
  // the baseline can't accidentally land entirely on one rep's calls.
  SAMPLE_SIZE: 12
};

var REGRESSION_BASELINE_SHEET_NAME = 'Regression Baseline';
var REGRESSION_BASELINE_HEADERS = [
  'Prospect Name', 'Rep', 'Rubric Variant', 'Call Date', 'Transcript URL',
  'Frozen Call Quality Score', 'Frozen Flag: Asked For Close', 'Frozen Flag: Objections Handled',
  'Frozen Flag: Framework Explained', 'Frozen Primary Failure Mode', 'Frozen Rubric Version', 'Frozen At'
];

/**
 * HISTORICAL ATTRIBUTION ONLY — which rubric variant actually scored a given
 * "Sales Call Log" row. Use rubricVariantForNewScore_ above to decide which
 * rubric SHOULD score a call; conflating the two is what let Bens be graded
 * on a closer's rubric for weeks (see that function's header). The
 * matchMethod logic below stays exactly as it is precisely BECAUSE it
 * describes history: rows scored by the ongoing pipeline before 03/09/2026
 * genuinely were scored by the shared rubric whatever the rep's own variant
 * would have been, and checkRegressionDrift_ has to keep knowing that.
 *
 * Needed so checkRegressionDrift_ re-scores under the SAME prompt the
 * baseline was frozen against, not just whatever the rep's name suggests. The
 * ongoing pipeline (scoreNewlyLoggedCalls_) always scores every exact_key
 * row through the SHARED rubric regardless of rep; the per-rep variants
 * (Sean/Bens/Tomás) only ever run through their own folder-scan backfill
 * functions, which always write Match Method = 'fallback_heuristic' (see
 * each function's own header comment above). So Match Method, not Rep
 * alone, is what actually determines which prompt produced a given row's
 * score — Joana has no dedicated variant and always scores under the shared
 * rubric either way, exact_key or fallback_heuristic. Pure/no side effects.
 *
 * callType added 29/08/2026 per Kris ("there are different calls — QC, sales
 * call, 2nd sales call — score them!"). Checked FIRST, ahead of rep/
 * matchMethod: a QC or Discovery call is never a closing call regardless of
 * who ran it — same reasoning Bens' own variant was already built on (SOP
 * §3C), just generalized by call type instead of gated to one rep. Only once
 * a row is confirmed NOT a QC/Discovery does rep/matchMethod decide which
 * closing-call rubric applies, same as before this change.
 */
/**
 * Which rubric SHOULD score a call — as opposed to
 * resolveRubricVariantForRow_ below, which reports which rubric DID score an
 * existing row. Those are two different questions and answering both with one
 * function is what caused the bug this exists to fix.
 *
 * Real bug found live (03/09/2026, from the first four-element training
 * priority run): Bens' framework explanation failed on 4 of 4 calls and his
 * close-ask on 2 of 4 — for a rep Kris explicitly defined (26/08/2026) as one
 * who "runs ICONS 100 lead-gen interviews and QCs, books the next step for
 * someone else on the team, and never asks for money or explains the
 * framework himself" (TRAINING_REVIEW_ROLE_.Bens, Phase6_TrainingCallReview.gs,
 * where drillsFramework is already false for exactly this reason). He was
 * being graded on a rubric written for somebody else's job.
 *
 * The cause: scoreNewlyLoggedCalls_ calls the historical-attribution function
 * with a hardcoded 'exact_key', which trips its matchMethod guard and routes
 * EVERY non-QC, non-Tomás call to the shared closer rubric regardless of rep.
 * The per-rep variants only ever ran on folder-scan backfills. The 29/08/2026
 * dispatch fix closed that gap for Tomás but left Sean and Bens behind.
 *
 * Match method is deliberately absent here: how a row was matched to its
 * transcript says nothing about which rubric describes that rep's job.
 */
function rubricVariantForNewScore_(rep, callType) {
  // Real bug found live (03/09/2026, Kris): "Discovery calls are totally
  // different!" A Discovery call (the account manager's post-sale onboarding/
  // payment call) was being graded under the QC rubric — built entirely
  // around discovery-questioning quality, nothing about money collection or
  // elevating the AM — because it shared this branch with real QC calls.
  // Split off into its own variant; resolveRubricVariantForRow_ below is
  // deliberately left pointing 'Discovery' at 'qc' — that's what historical
  // rows were ACTUALLY scored under, and that function is history-only
  // attribution, not "what should score this."
  if (callType === 'Discovery') return 'discovery';
  if (callType === 'QC') return 'qc';
  if (rep === 'Tomás' || rep === 'Tomas') return 'tomas';
  if (rep === 'Sean') return 'sean';
  if (rep === 'Bens') return 'bens';
  return 'shared';
}

function resolveRubricVariantForRow_(rep, matchMethod, callType) {
  if (callType === 'QC' || callType === 'Discovery') return 'qc';
  if (rep === 'Tomás' || rep === 'Tomas') return 'tomas';
  if (matchMethod !== 'fallback_heuristic') return 'shared';
  if (rep === 'Sean') return 'sean';
  if (rep === 'Bens') return 'bens';
  return 'shared';
}

/**
 * True if the baseline row was frozen under a DIFFERENT RUBRIC_VERSION than
 * the one currently live. Real bug found live (25/08/2026, from an actual
 * checkRegressionDrift() run): the rubric changed twice the same day this
 * feature shipped (the framework-explanation dimension, then the
 * primary_failure_mode enum gaining "multiple"/"framework_not_explained"),
 * and diffRegressionResult_ had no idea — it just diffed the frozen score
 * against a fresh one computed under a materially different rubric and
 * called the (entirely expected) difference "drift." 8 of 9 rows in that
 * run "drifted"; none of it was the model behaving inconsistently, all of
 * it was comparing across rubric generations. The SOP's own description of
 * this mechanism ("re-run... through the exact same rubric") was the
 * intent all along — this just closes the gap between that intent and what
 * the code actually checked. A blank frozenVersion (a baseline frozen
 * before RUBRIC_VERSION existed) is treated as "different" — conservative,
 * since there's no way to know it actually matches.
 */
function rubricChangedSinceFreeze_(frozenVersion, currentVersion) {
  return String(frozenVersion || '') !== String(currentVersion || '');
}

/** Dispatches to the right judge function for a rubric variant string (resolveRubricVariantForRow_'s output). */
function scoreTranscriptByVariant_(variant, ctx) {
  switch (variant) {
    case 'sean': return scoreSeanTranscript_(ctx);
    case 'bens': return scoreBensTranscript_(ctx);
    case 'tomas': return scoreTomasTranscript_(ctx);
    case 'qc': return scoreQcTranscript_(ctx);
    case 'discovery': return scoreDiscoveryTranscript_(ctx);
    default: return scoreTranscript_(ctx);
  }
}

/** Dispatches to the right feedback-summary packer for a rubric variant string (same vocabulary as scoreTranscriptByVariant_). */
function buildFeedbackSummaryForVariant_(variant, result) {
  switch (variant) {
    case 'sean': return buildSeanFeedbackSummary_(result);
    case 'bens': return buildBensFeedbackSummary_(result);
    case 'tomas': return buildTomasFeedbackSummary_(result);
    case 'qc': return buildQcFeedbackSummary_(result);
    case 'discovery': return buildDiscoveryFeedbackSummary_(result);
    default: return result.feedback_summary;
  }
}

// ---------------------------------------------------------------------------
// Analytic (deterministic) score rollup — QA_COACHING_RESEARCH_REPORT.md §1.4.
// SHADOW MODE ONLY. Full writeup: Phase2_CallGradingSOP.md §7C.
//
// Today the model picks call_quality_score itself, in the same breath as the
// booleans (flags/framework) it also outputs — nothing enforces the two
// agree, so it's effectively an unvalidated, uncorrelated second judgment
// happening in the same pass. This computes a SECOND, deterministic score
// from those same booleans (a fixed weighted rollup, not another model call)
// purely so it can be logged alongside the model's own number for comparison
// — see ANALYTIC_SCORE_CONFIG below and logAnalyticScoreShadowCheck_. It
// never changes what gets written to the "Sales Call Log" sheet's Call
// Quality Score column while ANALYTIC_SCORE_CONFIG.ENABLED is false (the
// shipped default) — see each write site (writeScoreToRow_ and the four
// appendRow-based backfill functions) for the marked-but-not-built future
// branch.
//
// Kris's explicit instruction: a missed close-ask is the #1 mistake and
// must be weighted higher than any other single miss, in EVERY variant —
// hence -2 for a close-ask miss (or, for Sean, the OR'd close-or-second-call
// condition) vs. -1 for every other single deduction below.
// ---------------------------------------------------------------------------

var ANALYTIC_SCORE_CONFIG = {
  // Shadow-mode only — see the file-header comment above this block and
  // Phase2_CallGradingSOP.md §7C. Do NOT flip this true without a human
  // first reviewing a real batch of shadow-check log deltas (see the SOP
  // section for exactly what that review looks like) — and even once
  // flipped, note it doesn't itself change any write site; see the marked
  // "FUTURE" comment at each of the 5 write sites for the still-unbuilt step
  // that would actually need to ship alongside flipping this.
  ENABLED: false
};

/** Base-5-minus-deductions, clamped to the 1-5 scale every variant's call_quality_score already uses. */
function clampAnalyticScore_(rawScore) {
  return Math.max(1, Math.min(5, rawScore));
}

/**
 * Shared rubric (buildJudgeSystemPrompt_/scoreTranscript_) — also the
 * fallback for any variant string this dispatcher doesn't otherwise
 * recognize, same default resolveRubricVariantForRow_/scoreTranscriptByVariant_
 * already use for "shared or unrecognized."
 */
function computeSharedAnalyticScore_(result) {
  var flags = (result && result.flags) || {};
  var deduction = 0;
  if (!flags.asked_for_close) deduction += 2;
  if (!(flags.objections_uncovered && flags.objections_overcome)) deduction += 1;
  if (!deriveFrameworkFields_(result).explained) deduction += 1;
  if (!deriveDeliveryFields_(result).effective) deduction += 1;
  return clampAnalyticScore_(5 - deduction);
}

/**
 * Sean (buildSeanJudgeSystemPrompt_/scoreSeanTranscript_) — Sean's funnel
 * ends acceptably either by closing the money directly OR booking a second
 * call with Tomás, so the #1-miss weight applies to neither having happened
 * (an OR condition), not to asked_for_close alone. Also folds Sean's four
 * discovery/goal-alignment extras into a single combined bucket, per spec,
 * rather than four separate -1 deductions.
 */
function computeSeanAnalyticScore_(result) {
  var flags = (result && result.flags) || {};
  var deduction = 0;
  if (!(flags.asked_for_close || flags.booked_second_call_with_tomas)) deduction += 2;
  if (!(flags.objections_uncovered && flags.objections_overcome)) deduction += 1;
  if (!deriveFrameworkFields_(result).explained) deduction += 1;
  if (!deriveDeliveryFields_(result).effective) deduction += 1;
  if (!(flags.discovery_adequate && flags.understood_leads_business &&
        flags.captured_leads_goals && flags.tied_framework_to_goals)) deduction += 1;
  return clampAnalyticScore_(5 - deduction);
}

/**
 * Bens (buildBensJudgeSystemPrompt_/scoreBensTranscript_) — "asked_for_close"
 * here means asked to book the next concrete step (SOP §3C), not asked for
 * money. The booking-didn't-happen deduction only fires when he actually
 * asked (flags.asked_for_close && !booked_next_step) — when he never asked
 * at all, that's already the -2 above, and double-penalizing the same
 * underlying failure would over-weight it relative to every other variant.
 * The last deduction is the deterministic form of the "a directly-booked
 * Sales Call outranks a QC-only booking" rule added to the score-ANCHOR
 * prose in commit 675b632 (SOP §3C's 25/08/2026 clarification) — only
 * applies to icons_100_interview, never to a qc-role call, per that
 * clarification's own scoping.
 */
function computeBensAnalyticScore_(result) {
  var flags = (result && result.flags) || {};
  var deduction = 0;
  if (!flags.asked_for_close) deduction += 2;
  if (flags.asked_for_close && !flags.booked_next_step) deduction += 1;
  if (!(flags.objections_uncovered && flags.objections_overcome)) deduction += 1;
  if (!deriveFrameworkFields_(result).explained) deduction += 1;
  if (!deriveDeliveryFields_(result).effective) deduction += 1;
  var interviewContentOk = result.call_role !== 'icons_100_interview' || flags.interview_content_quality_good;
  if (!(flags.discovery_adequate && flags.understood_leads_business && interviewContentOk)) deduction += 1;
  if (result.call_role === 'icons_100_interview' && flags.booked_next_step && result.next_step_type === 'QC') {
    deduction += 1;
  }
  return clampAnalyticScore_(5 - deduction);
}

/**
 * Tomás (buildTomasJudgeSystemPrompt_/scoreTomasTranscript_) — same
 * three-deduction shape as the shared rubric, plus one more combined bucket
 * (29/08/2026) for the two Tomas_Playbook.md-grounded flags added the same
 * day: following the goal/mirror/map/proof process, and converting a stall
 * into a specific date rather than accepting it open-ended — his own most
 * consistent gap per the playbook. One combined -1, not two separate
 * deductions, same "one combined bucket" pattern Sean's discovery/goal-
 * alignment extras already use.
 */
function computeTomasAnalyticScore_(result) {
  var flags = (result && result.flags) || {};
  var deduction = 0;
  if (!flags.asked_for_close) deduction += 2;
  if (!(flags.objections_uncovered && flags.objections_overcome)) deduction += 1;
  if (!deriveFrameworkFields_(result).explained) deduction += 1;
  if (!deriveDeliveryFields_(result).effective) deduction += 1;
  if (!(flags.followed_goal_mirror_map_proof_process && flags.stalling_converted_to_date)) deduction += 1;
  return clampAnalyticScore_(5 - deduction);
}

/** QC/Discovery (buildQcJudgeSystemPrompt_/scoreQcTranscript_) — same shape as Bens' variant minus the
 * icons_100_interview-only deduction (no interview content to grade) AND minus the framework deduction:
 * this variant is explicitly not scored on framework explanation (buildQcJudgeSystemPrompt_'s header
 * comment — that's the Sales Call's job), so result.framework doesn't exist here and must not be
 * deducted for. */
function computeQcAnalyticScore_(result) {
  var flags = (result && result.flags) || {};
  var deduction = 0;
  if (!flags.asked_for_close) deduction += 2;
  if (flags.asked_for_close && !flags.booked_next_step) deduction += 1;
  if (!(flags.objections_uncovered && flags.objections_overcome)) deduction += 1;
  if (!deriveDeliveryFields_(result).effective) deduction += 1;
  if (!(flags.discovery_adequate && flags.understood_leads_business)) deduction += 1;
  return clampAnalyticScore_(5 - deduction);
}

/** Discovery-call equivalent of computeQcAnalyticScore_ — this variant's own flag vocabulary
 * (money_collected instead of booked_next_step, elevation instead of discovery/framework), so it
 * cannot reuse any existing deduction table without silently deducting for fields that don't exist. */
/**
 * call_quality_score grades the AM's segment ONLY (per the prompt's own
 * instruction) — the rep's elevation/payment-collection segment is tracked
 * separately and deliberately excluded here, same as it must not move the
 * model's own score.
 */
function computeDiscoveryAnalyticScore_(result) {
  var flags = (result && result.flags) || {};
  var deduction = 0;
  if (!flags.asked_for_close) deduction += 1; // next steps not locked in
  if (!(flags.objections_uncovered && flags.objections_overcome)) deduction += 1;
  if (!deriveDeliveryFields_(result).effective) deduction += 1;
  if (!deriveDiscoveryContentFields_(result).covered) deduction += 2; // the core of what this call is for
  return clampAnalyticScore_(5 - deduction);
}

/** Dispatches to the right analytic-score function for a rubric variant string (same vocabulary as scoreTranscriptByVariant_). */
function computeAnalyticScore_(variant, result) {
  switch (variant) {
    case 'sean': return computeSeanAnalyticScore_(result);
    case 'bens': return computeBensAnalyticScore_(result);
    case 'tomas': return computeTomasAnalyticScore_(result);
    case 'qc': return computeQcAnalyticScore_(result);
    case 'discovery': return computeDiscoveryAnalyticScore_(result);
    default: return computeSharedAnalyticScore_(result);
  }
}

/**
 * Shadow-mode comparison only — computes the analytic rollup alongside the
 * model's own call_quality_score and logs a comparison line whenever they
 * differ by more than 1 point (exactly-1 tolerance mirrors
 * diffRegressionResult_'s existing "normal judge noise" threshold), so
 * Kris/Tomás can review real before/after deltas in the Apps Script
 * execution log. Never writes anything — purely a log side effect. Called
 * from all 5 real scoring write sites; see each site's own "FUTURE" comment
 * for the not-yet-built branch this would feed if ANALYTIC_SCORE_CONFIG.ENABLED
 * is ever flipped true. Returns the analytic score so a caller that wants it
 * for other purposes doesn't have to recompute.
 */
function logAnalyticScoreShadowCheck_(prospectName, variant, result) {
  var analyticScore = computeAnalyticScore_(variant, result);
  var modelScore = result.call_quality_score;
  var delta = Math.abs(Number(modelScore) - Number(analyticScore));
  if (delta > 1) {
    log_('Analytic score shadow-check: "' + prospectName + '" model=' + modelScore +
      ' analytic=' + analyticScore + ' (diff ' + delta + ')');
  }
  return analyticScore;
}

/**
 * Stratified sample: spreads picks roughly evenly across each distinct `rep`
 * present in eligibleRows (so freezeRegressionSet_ can't accidentally land
 * its whole regression set on one rep's calls), then tops up from the
 * remaining pool at random if still under target (e.g. a rep with very few
 * eligible calls). Pure — reuses pickRandomSample_ for both stages, so it's
 * deterministic under an injected randomFn and unit-testable without a live
 * sheet. Does not mutate eligibleRows. Each row must carry a `rep` and a
 * `rowIndex` (used only as a dedup key here, not assumed to mean anything
 * else).
 */
function pickStratifiedRegressionSample_(eligibleRows, sampleSize, randomFn) {
  var byRep = {};
  eligibleRows.forEach(function (row) {
    (byRep[row.rep] = byRep[row.rep] || []).push(row);
  });
  var reps = Object.keys(byRep).sort(); // alphabetical — deterministic grouping order
  if (!reps.length || sampleSize <= 0) return [];

  var quota = Math.max(1, Math.floor(sampleSize / reps.length));
  var picked = [];
  var pickedKeys = {};
  reps.forEach(function (rep) {
    pickRandomSample_(byRep[rep], quota, randomFn).forEach(function (row) {
      picked.push(row);
      pickedKeys[row.rowIndex] = true;
    });
  });

  if (picked.length < sampleSize) {
    var remaining = eligibleRows.filter(function (row) { return !pickedKeys[row.rowIndex]; });
    picked = picked.concat(pickRandomSample_(remaining, sampleSize - picked.length, randomFn));
  }
  return picked.slice(0, sampleSize);
}

/**
 * Pure diff between a frozen regression baseline and a freshly-recomputed
 * result for the same call. Deliberately takes plain {callQualityScore,
 * askedForClose, objectionsHandled, frameworkExplained, primaryFailureMode}
 * shapes rather than raw judge-schema objects, so it's unit-testable with
 * plain literals and reusable regardless of which rubric variant produced
 * the fresh result (the caller is responsible for deriving objectionsHandled/
 * frameworkExplained from a raw judge result the same way writeScoreToRow_
 * does). Returns an array of human-readable diff descriptions — empty means
 * no drift. Per QA_COACHING_RESEARCH_REPORT.md: flag a score move of MORE
 * THAN 1 point (a move of exactly 1 is normal judge noise, not drift), any
 * flipped boolean flag, or any change in primary_failure_mode.
 */
function diffRegressionResult_(frozen, fresh) {
  var diffs = [];
  var scoreDelta = Math.abs(Number(fresh.callQualityScore) - Number(frozen.callQualityScore));
  if (scoreDelta > 1) {
    diffs.push('call_quality_score drifted ' + frozen.callQualityScore + ' -> ' + fresh.callQualityScore +
      ' (delta ' + scoreDelta + ')');
  }
  if (!!fresh.askedForClose !== !!frozen.askedForClose) {
    diffs.push('Flag: Asked For Close flipped ' + frozen.askedForClose + ' -> ' + fresh.askedForClose);
  }
  if (!!fresh.objectionsHandled !== !!frozen.objectionsHandled) {
    diffs.push('Flag: Objections Handled flipped ' + frozen.objectionsHandled + ' -> ' + fresh.objectionsHandled);
  }
  if (!!fresh.frameworkExplained !== !!frozen.frameworkExplained) {
    diffs.push('Flag: Framework Explained flipped ' + frozen.frameworkExplained + ' -> ' + fresh.frameworkExplained);
  }
  var frozenPfm = String(frozen.primaryFailureMode || 'none');
  var freshPfm = String(fresh.primaryFailureMode || 'none');
  if (frozenPfm !== freshPfm) {
    diffs.push('Primary Failure Mode changed ' + frozenPfm + ' -> ' + freshPfm);
  }
  return diffs;
}

/**
 * Self-healing header setup for the "Regression Baseline" tab — same pattern
 * as getOrCreateTrainingAssignmentsSheet_ (Phase6_TrainingCallReview.gs,
 * added 25/08/2026). Chosen as a sheet tab rather than a Script Property
 * (the TRAINING_OBJECTIONS_<rep> JSON-blob pattern also established in this
 * codebase) because the baseline is ~10-15 rows of genuinely tabular,
 * per-call data (a score, three flags, a failure mode, a transcript URL,
 * which rubric variant scored it) that Kris/Tomás need to be able to eyeball
 * directly without opening the Apps Script editor — a sheet tab is
 * inspectable by anyone who can open the spreadsheet, a Script Property is
 * not. Both options are equally "durable" (Script Properties and sheet tabs
 * both persist independent of any trigger/execution), so inspectability is
 * the deciding factor here, not durability.
 */
function getOrCreateRegressionBaselineSheet_() {
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var sheet = ss.getSheetByName(REGRESSION_BASELINE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(REGRESSION_BASELINE_SHEET_NAME);
    sheet.getRange(1, 1, 1, REGRESSION_BASELINE_HEADERS.length).setValues([REGRESSION_BASELINE_HEADERS])
      .setFontWeight('bold').setBackground('#e8eef7');
    sheet.setFrozenRows(1);
    log_('Created "' + REGRESSION_BASELINE_SHEET_NAME + '" tab.');
    return sheet;
  }
  // Self-heal on every call, same "validate every run" spirit as
  // setupSalesCallLog()'s header check and getOrCreateTrainingAssignmentsSheet_'s
  // 25/08/2026 self-healing fix — cheap and idempotent, and this sheet's
  // layout is entirely code-owned so nothing else should ever hand-edit it.
  var existing = sheet.getRange(1, 1, 1, REGRESSION_BASELINE_HEADERS.length).getValues()[0];
  var headersMatch = REGRESSION_BASELINE_HEADERS.every(function (h, i) { return existing[i] === h; });
  if (!headersMatch) {
    sheet.getRange(1, 1, 1, REGRESSION_BASELINE_HEADERS.length).setValues([REGRESSION_BASELINE_HEADERS])
      .setFontWeight('bold').setBackground('#e8eef7');
    log_('Updated "' + REGRESSION_BASELINE_SHEET_NAME + '" header row to match REGRESSION_BASELINE_HEADERS.');
  }
  return sheet;
}

/** Apps Script's "Select function" dropdown hides trailing-underscore functions — this is the runnable entry point. */
function freezeRegressionSet() {
  return freezeRegressionSet_();
}

/**
 * Picks up to REGRESSION_DRIFT_CONFIG.SAMPLE_SIZE already-scored real calls
 * (spread across reps/rubric variants via pickStratifiedRegressionSample_)
 * and stores their current scored values as the "known-good" baseline in the
 * "Regression Baseline" tab, REPLACING whatever baseline was there before —
 * this is a snapshot, not an append-only log, so re-running this is always
 * safe and just re-picks a fresh (possibly different) sample. Never touches
 * the live "Sales Call Log" — read-only against it.
 */
function freezeRegressionSet_() {
  RUN_TAG = 'freezeRegressionSet_';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var logSheet = resolveSheet_(ss, 'Sales Call Log');
  if (!logSheet) { log_('No Sales Call Log tab found.'); return null; }

  var lastRow = logSheet.getLastRow();
  if (lastRow < 2) { log_('No data rows.'); return null; }

  var col = getValidatedColumnMap_(logSheet);
  var values = logSheet.getRange(2, 1, lastRow - 1, SALES_CALL_LOG_HEADERS.length).getValues();

  var eligible = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    if (typeof row[col['Call Quality Score'] - 1] !== 'number') continue; // not yet scored
    var transcriptUrl = row[col['Transcript URL'] - 1];
    if (!transcriptUrl) continue; // nothing checkRegressionDrift_ could re-fetch and re-score later

    var rep = row[col['Rep'] - 1];
    var matchMethod = row[col['Match Method'] - 1];
    var callType = row[col['Call Type'] - 1];

    eligible.push({
      rowIndex: r + 2,
      prospectName: row[col['Prospect Name'] - 1],
      rep: rep,
      rubricVariant: resolveRubricVariantForRow_(rep, matchMethod, callType),
      callDate: row[col['Call Date'] - 1],
      transcriptUrl: transcriptUrl,
      callQualityScore: Number(row[col['Call Quality Score'] - 1]),
      askedForClose: !!row[col['Flag: Asked For Close'] - 1],
      objectionsHandled: !!row[col['Flag: Objections Handled'] - 1],
      frameworkExplained: !!row[col['Flag: Framework Explained'] - 1],
      primaryFailureMode: String(row[col['Primary Failure Mode'] - 1] || 'none'),
      rubricVersion: String(row[col['Rubric Version'] - 1] || '')
    });
  }

  if (!eligible.length) {
    log_('freezeRegressionSet_: no already-scored row with a Transcript URL found — nothing to freeze.');
    return null;
  }

  var sample = pickStratifiedRegressionSample_(eligible, REGRESSION_DRIFT_CONFIG.SAMPLE_SIZE, Math.random);

  var baselineSheet = getOrCreateRegressionBaselineSheet_();
  var existingLastRow = baselineSheet.getLastRow();
  if (existingLastRow > 1) {
    baselineSheet.getRange(2, 1, existingLastRow - 1, REGRESSION_BASELINE_HEADERS.length).clearContent();
  }

  var now = new Date();
  var rows = sample.map(function (c) {
    return [
      c.prospectName, c.rep, c.rubricVariant, c.callDate, c.transcriptUrl,
      c.callQualityScore, c.askedForClose, c.objectionsHandled, c.frameworkExplained,
      c.primaryFailureMode, c.rubricVersion, now
    ];
  });
  baselineSheet.getRange(2, 1, rows.length, REGRESSION_BASELINE_HEADERS.length).setValues(rows);

  var repCounts = {};
  sample.forEach(function (c) { repCounts[c.rep] = (repCounts[c.rep] || 0) + 1; });
  var repSpread = Object.keys(repCounts).sort().map(function (rep) { return rep + ':' + repCounts[rep]; }).join(', ');

  log_('freezeRegressionSet_: froze ' + rows.length + ' call(s) as the known-good baseline in "' +
    REGRESSION_BASELINE_SHEET_NAME + '" (' + repSpread + '). Run previewRegressionDrift() next.');
  return { frozen: rows.length, repSpread: repCounts };
}

/** Run this FIRST from the editor — logs any drift found, never writes anywhere (not the frozen baseline, not the live Sales Call Log). */
function previewRegressionDrift() {
  return checkRegressionDriftImpl_(/*forcePreview=*/true);
}

/** Trigger target (not yet installed — see the section header above). Gated by REGRESSION_DRIFT_CONFIG.ENABLED, same pattern as runRandomCalibrationSample. */
function checkRegressionDrift() {
  RUN_TAG = 'checkRegressionDrift';
  if (!REGRESSION_DRIFT_CONFIG.ENABLED) {
    log_('checkRegressionDrift: REGRESSION_DRIFT_CONFIG.ENABLED is false, skipping. Run previewRegressionDrift() instead.');
    return null;
  }
  return checkRegressionDriftImpl_(/*forcePreview=*/false);
}

/**
 * Re-scores every frozen baseline call (the "Regression Baseline" tab)
 * through the SAME rubric variant that produced its frozen score
 * (scoreTranscriptByVariant_, using each row's own stored Rubric Variant —
 * never re-derived from the row's current Rep, which could theoretically
 * drift if the sheet were hand-edited), and diffs the fresh result against
 * the frozen one via diffRegressionResult_. Purely a read/compare: never
 * rewrites the frozen baseline (only freezeRegressionSet_ does that) and
 * never touches the live "Sales Call Log" — no real scored row is ever
 * overwritten by this, by design (per the task: drift-checking must never
 * corrupt real scoring history). In preview mode (forcePreview=true, or
 * whenever REGRESSION_DRIFT_CONFIG.ENABLED is false) this only logs; once
 * enabled, a real (non-preview) run additionally sends a loud ops alert if
 * any drift is found, same escalation pattern runWeeklyCalibration() already
 * uses for the 80%-agreement gate.
 */
function checkRegressionDriftImpl_(forcePreview) {
  RUN_TAG = 'checkRegressionDriftImpl_';
  var ss = SpreadsheetApp.openById(SALES_CALL_LOG_SPREADSHEET_ID);
  var baselineSheet = ss.getSheetByName(REGRESSION_BASELINE_SHEET_NAME);
  if (!baselineSheet) {
    log_('checkRegressionDrift: no "' + REGRESSION_BASELINE_SHEET_NAME + '" tab found — run freezeRegressionSet() first.');
    return null;
  }
  var lastRow = baselineSheet.getLastRow();
  if (lastRow < 2) {
    log_('checkRegressionDrift: "' + REGRESSION_BASELINE_SHEET_NAME + '" has no frozen rows — run freezeRegressionSet() first.');
    return null;
  }

  var rows = baselineSheet.getRange(2, 1, lastRow - 1, REGRESSION_BASELINE_HEADERS.length).getValues();
  var results = [];
  var drifted = 0, failed = 0, rubricChanged = 0;

  rows.forEach(function (row) {
    var prospectName = row[0], rep = row[1], rubricVariant = row[2], callDate = row[3],
      transcriptUrl = row[4], frozenScore = row[5], frozenAskedForClose = !!row[6],
      frozenObjectionsHandled = !!row[7], frozenFrameworkExplained = !!row[8],
      frozenPrimaryFailureMode = row[9], frozenRubricVersion = row[10];

    if (rubricChangedSinceFreeze_(frozenRubricVersion, RUBRIC_VERSION)) {
      rubricChanged++;
      log_('  RUBRIC CHANGED SINCE BASELINE (not drift) — "' + prospectName + '" (' + rep + ', ' + rubricVariant +
        ' rubric): frozen under "' + (frozenRubricVersion || '(none — frozen before RUBRIC_VERSION existed)') +
        '", now "' + RUBRIC_VERSION + '". Re-run freezeRegressionSet() to refresh the baseline against the ' +
        'current rubric — a real comparison isn\'t possible until then.');
      return; // skip: comparing across rubric generations isn't a drift signal
    }

    try {
      var fileId = extractDriveFileId_(transcriptUrl);
      var text = getTranscriptText_(DriveApp.getFileById(fileId));
      var ctx = {
        rep: rep,
        prospectName: prospectName,
        callType: 'QC', // not stored on the baseline row; only affects Bens'/legacy call-role framing, not the comparison fields checked here
        source: 'regression-drift-check',
        callDate: callDate,
        transcriptText: text
      };
      var result = scoreTranscriptByVariant_(rubricVariant, ctx);
      var freshObjectionsHandled = result.flags.objections_uncovered && result.flags.objections_overcome;
      var freshFrameworkFields = deriveFrameworkFields_(result);

      var diffs = diffRegressionResult_(
        {
          callQualityScore: frozenScore, askedForClose: frozenAskedForClose,
          objectionsHandled: frozenObjectionsHandled, frameworkExplained: frozenFrameworkExplained,
          primaryFailureMode: frozenPrimaryFailureMode
        },
        {
          callQualityScore: result.call_quality_score, askedForClose: result.flags.asked_for_close,
          objectionsHandled: freshObjectionsHandled, frameworkExplained: freshFrameworkFields.explained,
          primaryFailureMode: result.primary_failure_mode || 'none'
        }
      );

      if (diffs.length) {
        drifted++;
        log_('  DRIFT DETECTED — "' + prospectName + '" (' + rep + ', ' + rubricVariant + ' rubric): ' + diffs.join('; '));
      } else {
        log_('  OK — "' + prospectName + '" (' + rep + ', ' + rubricVariant + ' rubric): no drift.');
      }
      results.push({ prospectName: prospectName, rep: rep, diffs: diffs });
    } catch (e) {
      failed++;
      log_('  FAILED to re-score "' + prospectName + '" for the drift check: ' + e);
    }
    Utilities.sleep(300); // be polite to the proxy, same courtesy every other batch judge loop in this file uses.
  });

  log_('checkRegressionDrift done — ' + rows.length + ' frozen call(s) checked, ' + drifted +
    ' drifted, ' + failed + ' failed to re-score, ' + rubricChanged + ' skipped (rubric changed since freeze). ' +
    (drifted > 0
      ? 'MODEL BEHAVIOR MAY HAVE CHANGED — review the drifted row(s) above before trusting new scores.'
      : rubricChanged > 0
        ? 'No real drift signal this run — every comparable row matched; re-run freezeRegressionSet() to get a ' +
          'usable baseline for the ' + rubricChanged + ' row(s) skipped for a rubric mismatch.'
        : 'No drift detected — model output on these calls still matches the frozen baseline.'));

  if (drifted > 0 && !forcePreview) {
    sendOpsAlert_('Regression drift detected in Kimi judge output',
      drifted + ' of ' + rows.length + ' frozen regression calls now score differently than their frozen ' +
      'baseline (call_quality_score moved by more than 1, a boolean flag flipped, or Primary Failure Mode ' +
      'changed). This can mean the Moonshot-side model changed, or a subtle prompt-sensitivity issue — see ' +
      'the Apps Script execution log for exactly which calls and fields drifted, and Phase2_CallGradingSOP.md ' +
      'for what to do next.');
  } else if (drifted > 0) {
    log_('  (preview run — an ops alert would be sent here once REGRESSION_DRIFT_CONFIG.ENABLED is true and this runs for real)');
  }

  return { checked: rows.length, drifted: drifted, failed: failed, rubricChanged: rubricChanged, results: results };
}
