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
var RUBRIC_VERSION = '2026-08-29-pitch-delivery';

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

function callKimiJudge_(systemPrompt, userPrompt) {
  var url, key;
  try {
    url = getScriptSecret_(PHASE2_CONFIG.PROXY_URL_PROPERTY);
    key = getScriptSecret_(PHASE2_CONFIG.API_KEY_PROPERTY);
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
  if (!content) throw new LlmTransportError_('LiteLLM response had no choices[0].message.content.');
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
    '  "flags": { "asked_for_close": true, "objections_uncovered": true, "objections_overcome": true },',
    '  "framework": { "recruit_agents_explained": true, "number_one_podcast_explained": true, "sell_more_houses_explained": true },',
    '  "delivery": { "paced_appropriately": true, "adapted_to_lead_engagement": true },',
    '  "primary_failure_mode": "none | no_close_ask | objections_missed | framework_not_explained | delivery_ineffective | multiple",',
    '  "manual_review_recommended": true,',
    '  "severity": 1,',
    '  "feedback_summary": "string — 2-3 sentences, coaching-ready. MUST open by quoting the rep\'s own',
    '    words from the transcript for the single most important moment (a real line they actually said,',
    '    in quotation marks) before saying anything else — a specific moment lands, a bare evaluation does',
    '    not. Name ONE behavior to change, not a list. Never compare this rep to any other rep by name."',
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
      handleJudgeRetryError_(e, attempt, PHASE2_CONFIG.MAX_PARSE_RETRIES);
    }
  }

  log_('    ↳ ROUTED TO MANUAL REVIEW (parse failed twice) — ' + ctx.prospectName +
    '. Raw model output: ' + String(lastRaw).slice(0, 1000));
  return {
    reasoning: 'JSON parse failed twice — see Apps Script log for raw model output.',
    lead_quality: { verdict: 'good_to_book', justification: 'Unscored — parse failure.' },
    call_quality_score: 1,
    flags: { asked_for_close: false, objections_uncovered: false, objections_overcome: false },
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
        var variant = resolveRubricVariantForRow_(ctx.rep, 'exact_key', ctx.callType);
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
  var framework = deriveFrameworkFields_(result);
  sheet.getRange(rowIndex, col['Flag: Framework Explained']).setValue(framework.explained);
  sheet.getRange(rowIndex, col['Framework Gaps']).setValue(framework.gapsText);
  var delivery = deriveDeliveryFields_(result);
  sheet.getRange(rowIndex, col['Flag: Delivery Effective']).setValue(delivery.effective);
  sheet.getRange(rowIndex, col['Delivery Gaps']).setValue(delivery.gapsText);
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
    '   other rep by name."',
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
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt);
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
// QC / Discovery rubric — added 29/08/2026 per Kris: a Qualification Call or
// Discovery call is not a closing call, for ANY rep, the same reason Bens'
// variant exists — his QC-mode logic (SOP §3C) already modeled this
// correctly but was gated to only apply when rep === 'Bens'. This is that
// same logic generalized to apply by CALL TYPE instead, minus the
// icons_100_interview-only fields (call_role/interview_content_quality_good/
// next_step_type), which are specific to Bens' own guest-interview format
// and don't describe a QC run by any other rep. The rep's job on a QC/
// Discovery call is to qualify the lead and book a Sales Call for someone
// else on the team (usually Tomás) to close — never to ask for money here.
// ---------------------------------------------------------------------------

function buildQcJudgeSystemPrompt_() {
  return [
    'You are a sales-call QA evaluator for a podcast-production offer sold to real estate agents, reviewing a',
    'Qualification Call (QC) or Discovery call. This is a pre-sales-call step, not a closing call — the rep\'s job',
    'is to qualify the lead and book a Sales Call for someone else on the team to run (usually Tomás or another',
    'closer), never to ask for money on this call. Applies the same way regardless of which rep ran it.',
    '',
    'This call\'s equivalent of "the close" is explicitly asking to book the Sales Call, at a specific date/time —',
    'not a vague "I\'ll be in touch" or "someone will reach out." Score that the same way a money-ask is scored',
    'on a real sales call: a real, explicit ask, not a soft trial-close question.',
    '',
    'Be skeptical by default. Every judgment must cite specific transcript evidence.',
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
    frameworkRubricPrompt_(),
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
    '  "framework": { "recruit_agents_explained": true, "number_one_podcast_explained": true, "sell_more_houses_explained": true },',
    '  "delivery": { "paced_appropriately": true, "adapted_to_lead_engagement": true },',
    '  "primary_failure_mode": "none | no_close_ask | objections_missed | weak_discovery | no_second_call_booked | framework_not_explained | delivery_ineffective | multiple",',
    '  "root_cause_if_no_booking": "string — the single specific reason the Sales Call wasn\'t booked; \\"N/A\\" if it was",',
    '  "manual_review_recommended": true,',
    '  "severity": 1,',
    '  "feedback_summary": "string — 2-3 sentences, coaching-ready. MUST open by quoting the rep\'s own words',
    '   from the transcript for the single most important moment before saying anything else. End with ONE',
    '   specific behavior to change, not a list. Never compare this rep to any other rep by name."',
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
    obj.framework && typeof obj.framework.recruit_agents_explained === 'boolean' &&
    typeof obj.framework.number_one_podcast_explained === 'boolean' &&
    typeof obj.framework.sell_more_houses_explained === 'boolean' &&
    obj.delivery && typeof obj.delivery.paced_appropriately === 'boolean' &&
    typeof obj.delivery.adapted_to_lead_engagement === 'boolean' &&
    typeof obj.manual_review_recommended === 'boolean' &&
    isValidScoreRange_(obj.severity) &&
    typeof obj.root_cause_if_no_booking === 'string');
}

/** Same retry/manual-review shape as scoreTranscript_/scoreBensTranscript_, against the QC/Discovery rubric. */
function scoreQcTranscript_(ctx) {
  var systemPrompt = buildQcJudgeSystemPrompt_();
  var userPrompt = buildJudgeUserPrompt_(ctx);
  var lastRaw = null;

  for (var attempt = 0; attempt <= PHASE2_CONFIG.MAX_PARSE_RETRIES; attempt++) {
    var promptForThisAttempt = attempt === 0
      ? userPrompt
      : userPrompt + '\n\nYour previous reply did not parse as JSON. Return ONLY the raw JSON object — no markdown fences, no commentary.';
    try {
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt);
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
    framework: { recruit_agents_explained: false, number_one_podcast_explained: false, sell_more_houses_explained: false },
    delivery: { paced_appropriately: false, adapted_to_lead_engagement: false },
    primary_failure_mode: 'none',
    root_cause_if_no_booking: 'Unscored — parse failure.',
    manual_review_recommended: true,
    severity: 5,
    feedback_summary: 'Automated scoring failed twice to return parseable JSON; needs manual review.',
    _parseFailed: true
  };
}

/** Packs the extra QC-only dimensions into the one free-text column the sheet has (AI Feedback Summary). */
function buildQcFeedbackSummary_(result) {
  var frameworkFields = deriveFrameworkFields_(result);
  var deliveryFields = deriveDeliveryFields_(result);
  return [
    result.feedback_summary,
    '',
    'Booked Sales Call: ' + result.flags.booked_next_step,
    'Discovery adequate: ' + result.flags.discovery_adequate +
      ' | Understood their business: ' + result.flags.understood_leads_business,
    'Framework explained: ' + frameworkFields.explained +
      (frameworkFields.gapsText ? ' (missing: ' + frameworkFields.gapsText + ')' : ''),
    'Delivery effective: ' + deliveryFields.effective +
      (deliveryFields.gapsText ? ' (missing: ' + deliveryFields.gapsText + ')' : ''),
    'Root cause if no booking: ' + result.root_cause_if_no_booking
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
          deliveryFields.gapsText         // Delivery Gaps
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
    '   specific behavior to change, not a list. Never compare him to any other rep by name."',
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
    typeof obj.flags.captured_leads_goals === 'boolean' &&
    typeof obj.flags.tied_framework_to_goals === 'boolean' &&
    typeof obj.flags.booked_second_call_with_tomas === 'boolean' &&
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
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt);
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
      discovery_adequate: false, understood_leads_business: false,
      captured_leads_goals: false, tied_framework_to_goals: false,
      booked_second_call_with_tomas: false
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
            deliveryFields.gapsText          // Delivery Gaps
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
            deliveryFields.gapsText           // Delivery Gaps
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
    '    "stalling_converted_to_date": true',
    '  },',
    '  "framework": { "recruit_agents_explained": true, "number_one_podcast_explained": true, "sell_more_houses_explained": true },',
    '  "delivery": { "paced_appropriately": true, "adapted_to_lead_engagement": true },',
    '  "primary_failure_mode": "none | no_close_ask | objections_missed | framework_not_explained | delivery_ineffective | multiple",',
    '  "teachable_strength": "string",',
    '  "coach_this": "string",',
    '  "manual_review_recommended": true,',
    '  "severity": 1,',
    '  "feedback_summary": "string — 2-3 sentences, coaching-ready. MUST open by quoting the rep\'s own',
    '    words from the transcript for the single most important moment (a real line they actually said,',
    '    in quotation marks) before saying anything else — a specific moment lands, a bare evaluation does',
    '    not. Name ONE behavior to change, not a list. Never compare this rep to any other rep by name."',
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
      lastRaw = callKimiJudge_(systemPrompt, promptForThisAttempt);
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
      followed_goal_mirror_map_proof_process: false, stalling_converted_to_date: false
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
            deliveryFields.gapsText             // Delivery Gaps
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
 * Which rubric variant actually scored a given "Sales Call Log" row — needed
 * so checkRegressionDrift_ re-scores under the SAME prompt the baseline was
 * frozen against, not just whatever the rep's name might suggest. The
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

/** QC/Discovery (buildQcJudgeSystemPrompt_/scoreQcTranscript_) — same shape as Bens' variant minus the icons_100_interview-only deduction, since this variant has no interview content to grade. */
function computeQcAnalyticScore_(result) {
  var flags = (result && result.flags) || {};
  var deduction = 0;
  if (!flags.asked_for_close) deduction += 2;
  if (flags.asked_for_close && !flags.booked_next_step) deduction += 1;
  if (!(flags.objections_uncovered && flags.objections_overcome)) deduction += 1;
  if (!deriveFrameworkFields_(result).explained) deduction += 1;
  if (!deriveDeliveryFields_(result).effective) deduction += 1;
  if (!(flags.discovery_adequate && flags.understood_leads_business)) deduction += 1;
  return clampAnalyticScore_(5 - deduction);
}

/** Dispatches to the right analytic-score function for a rubric variant string (same vocabulary as scoreTranscriptByVariant_). */
function computeAnalyticScore_(variant, result) {
  switch (variant) {
    case 'sean': return computeSeanAnalyticScore_(result);
    case 'bens': return computeBensAnalyticScore_(result);
    case 'tomas': return computeTomasAnalyticScore_(result);
    case 'qc': return computeQcAnalyticScore_(result);
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
